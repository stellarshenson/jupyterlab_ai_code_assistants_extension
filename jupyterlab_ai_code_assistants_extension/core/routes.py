"""Tornado API handlers for the AI code assistants extension.

Every provider route is ``providers/<id>/<verb>``: the handler resolves the id
through the registry and hands the work to that provider's store, so no route
names an assistant. Three gates run before any handler body, in this order -
unknown id (404 ``provider_unknown``), turned off in settings (404
``provider_disabled``), binary missing from PATH (503 ``cli_not_found``).
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import tornado
from jupyter_core.paths import jupyter_config_dir
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join

from . import colour_store, migrate, registry, state
from .store import load_jsonc


URL_PREFIX = "jupyterlab-ai-code-assistants-extension"

# The npm package name is what JupyterLab names the user-settings folder it
# writes this extension's saved settings into.
SETTINGS_PLUGIN_ID = "jupyterlab_ai_code_assistants_extension"


# bash one-liner that waits until the JL WebSocket client has resized the pty
# from its initial default before clearing and `exec`ing the real argv. A
# threshold-based version (rows>=20 && cols>=80) would be a no-op: terminado's
# default is 24x80, so `c=80 >= 80` passes on the first iteration and nothing
# ever waits.
#
# Strategy: capture the initial size, install a SIGWINCH trap, and loop until
# either SIGWINCH fires OR the size has visibly changed. 5 s timeout fallback so
# we still launch if no client ever connects. After exec, bash is replaced by
# the assistant on the same pid - auto-close on exit and the process-tree reuse
# filter still work.
_INIT_WAITER = (
    "trap 'CHANGED=1' WINCH; "
    "read R0 C0 < <(stty size 2>/dev/null || echo '0 0'); "
    "for i in $(seq 1 50); do "
    'if [ -n "$CHANGED" ]; then break; fi; '
    "read r c < <(stty size 2>/dev/null || echo '0 0'); "
    'if [ "$r" != "$R0" ] || [ "$c" != "$C0" ]; then break; fi; '
    "sleep 0.1; "
    "done; "
    "clear; "
    'exec "$@"'
)


def _wrap_with_init(argv: list[str]) -> list[str]:
    """Prepend the terminal-init waiter so the assistant only starts once the
    JL terminal widget has connected and sized the pty to a usable window."""
    return ["/bin/bash", "-c", _INIT_WAITER, "ai-assistant-terminal-init", *argv]


def _process_children(pid: int) -> list[int]:
    if sys.platform != "linux":
        return []
    try:
        with open(f"/proc/{pid}/task/{pid}/children", "r") as fh:
            return [int(x) for x in fh.read().split() if x.isdigit()]
    except OSError:
        return []


def _process_cwd_link(pid: int) -> str | None:
    try:
        return os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        return None


def _terminal_cwds(root_pid: int) -> list[str]:
    """Walk the pty's process tree and return ALL distinct live cwds found.

    Only ``/proc/<pid>/cwd`` (the kernel's authoritative current directory) is
    consulted - never the ``PWD`` in ``/proc/<pid>/environ``, which is the
    frozen exec-time environment and, for the pty's root process, is just
    whatever ``PWD`` the Jupyter server itself was launched with (so every
    terminal would otherwise report the server's startup directory). Walking the
    whole tree covers the case where bash (the pty root) sits in the project
    folder while the assistant or a sub-shell has cd'd elsewhere. The frontend
    matches a project path against ANY entry.
    """
    seen: set[str] = set()
    out: list[str] = []
    queue: list[int] = [root_pid]
    while queue:
        pid = queue.pop(0)
        source = _process_cwd_link(pid)
        if (
            source
            and source.startswith("/")
            and not source.startswith(("/proc/", "/sys/", "/dev/"))
        ):
            try:
                resolved = os.path.realpath(source)
            except OSError:
                resolved = source
            if resolved not in seen and os.path.isdir(resolved):
                seen.add(resolved)
                out.append(resolved)
        queue.extend(_process_children(pid))
    return out


def _tree_assistant(root_pid: int) -> tuple[registry.Provider | None, str | None]:
    """The provider running in a pty's process tree and its conversation.

    A terminal whose cwd matches a project folder but which has no assistant
    running in it - a plain bash opened at the project - must never be reused:
    the panel has to spawn a fresh terminal instead. Identity is resolved
    server-side, from the process itself, so a terminal the extension did not
    launch is still recognised.

    Each store answers for its own process (``owns_pid``), because what makes a
    pid this assistant differs per assistant: a native binary is its comm, an
    interpreted one needs its argv confirmed as well.
    """
    candidates = [
        provider
        for provider in _enabled_providers().values()
        if provider.store.comm_name
    ]
    if not candidates:
        return None, None
    queue: list[int] = [root_pid]
    while queue:
        pid = queue.pop(0)
        for provider in candidates:
            if provider.store.owns_pid(pid):
                return provider, provider.store.session_id_for_pid(pid)
        queue.extend(_process_children(pid))
    return None, None


def _user_settings() -> dict:
    """This extension's saved settings, or empty when never saved."""
    folder = Path(jupyter_config_dir()) / "lab" / "user-settings" / SETTINGS_PLUGIN_ID
    for path in sorted(folder.glob("*.jupyterlab-settings")) if folder.is_dir() else []:
        data = load_jsonc(path)
        if data is not None:
            return data
    return {}


def enabled_setting_key(provider_id: str) -> str:
    """The saved-settings key carrying a provider's enable toggle.

    JupyterLab settings are a FLAT map: ``schema/plugin.json`` declares - and
    ``src/index.ts`` reads - ``providers.<id>.enabled`` as one literal key with
    dots in its name, not a nested object. Reading it as a nested dict makes
    every lookup miss, so the gate silently answers "enabled" for every
    provider (docs/defects.md DEF-5).
    """
    return f"providers.{provider_id}.enabled"


def _provider_enabled(provider_id: str) -> bool:
    """Whether the user has left a provider on.

    An absent key reads as on - only an explicit ``false`` disables, so a fresh
    install with no saved settings runs every provider (acc-crit "Missing key
    reads as on").
    """
    return _user_settings().get(enabled_setting_key(provider_id)) is not False


def _enabled_providers() -> dict[str, registry.Provider]:
    return {
        pid: provider
        for pid, provider in registry.providers().items()
        if _provider_enabled(pid)
    }


def _effective_colour(
    provider: registry.Provider, session_id: str | None, default: str | None
) -> str | None:
    """The tint a conversation should carry now.

    ``default`` is the conversation's own colour as its source produced it -
    the value the store already read while building the row, so a listing never
    re-derives it once per row. The extension's own store overrides it for
    every provider except a ``native`` one, where the assistant owns its colour
    and a write-back would fight it.
    """
    if not session_id:
        return None
    if provider.descriptor.capabilities.colour_source == "native":
        return default
    return colour_store.get_colour(provider.id, session_id) or default


class _ProviderHandler(APIHandler):
    """Shared gating and body parsing for the ``providers/<id>/...`` routes."""

    def resolve(self, provider_id: str) -> registry.Provider | None:
        """The provider for ``provider_id``, or None with the response sent."""
        provider = registry.get(provider_id)
        if provider is None:
            self.set_status(404)
            self.finish(json.dumps({"error": "provider_unknown"}))
            return None
        if not _provider_enabled(provider_id):
            self.set_status(404)
            self.finish(json.dumps({"error": "provider_disabled"}))
            return None
        cli_path = provider.cli_path()
        if cli_path is None:
            self.set_status(503)
            self.finish(json.dumps({"error": "cli_not_found"}))
            return None
        self.cli_path = cli_path
        return provider

    def parse_body(self) -> dict | None:
        try:
            body = json.loads(self.request.body or b"{}")
        except json.JSONDecodeError:
            body = None
        if not isinstance(body, dict):
            self.set_status(400)
            self.finish(json.dumps({"error": "invalid_json"}))
            return None
        return body

    def bad_request(self, error: str = "invalid_body") -> None:
        self.set_status(400)
        self.finish(json.dumps({"error": error}))

    @property
    def to_trash(self) -> bool:
        """JupyterLab's move-to-trash preference for destructive operations."""
        return bool(getattr(self.contents_manager, "delete_to_trash", True))


class StatusHandler(APIHandler):
    """The provider roster and the directory Jupyter serves.

    Availability is two-dimensional - the user's setting and whether the binary
    is on PATH - and both are reported, so the panel can show a provider that is
    on but unusable rather than silently dropping it.

    JupyterLab's move-to-trash preference rides along, because the frontend has
    no handle on the contents manager: without it a delete dialog has to recite
    both outcomes rather than name the one the click will have.
    """

    @tornado.web.authenticated
    def get(self) -> None:
        # ``server_root_dir`` is the root path Jupyter serves from; fall back to
        # home when unset. Expand a leading ``~`` - some deployments leave the
        # setting as ``~/workspace``, and the frontend compares it against
        # absolute session paths, so an unexpanded ``~`` never matches.
        root_dir = os.path.expanduser(self.settings.get("server_root_dir") or "~")
        providers = []
        for pid, provider in registry.providers().items():
            cli_path = provider.cli_path()
            providers.append({
                "id": pid,
                "label": provider.descriptor.label,
                "enabled": _provider_enabled(pid),
                "cli_path": cli_path,
                "available": cli_path is not None,
            })
        self.finish(json.dumps({
            "root_dir": str(root_dir),
            "providers": providers,
            "delete_to_trash": bool(
                getattr(self.contents_manager, "delete_to_trash", True)
            ),
        }))


class SessionsHandler(_ProviderHandler):
    """List a provider's projects, or dispose of one project's history.

    Off the IOLoop for the listing: it walks the assistant's whole store and
    may spawn the CLI, and the panel polls it every 30s - run inline it would
    stall kernels, terminals and contents for the duration of each poll.

    ``DELETE`` covers the two destructive shapes, both honouring JupyterLab's
    move-to-trash setting: with ``session_ids`` the named conversations go,
    with none the project's whole history goes. Conversations that ACTUALLY
    went lose their stored colour too - no orphan keys are left behind, and a
    conversation whose deletion was refused keeps its tint.
    """

    @tornado.web.authenticated
    async def get(self, provider_id: str) -> None:
        provider = self.resolve(provider_id)
        if provider is None:
            return
        root_dir = os.path.expanduser(self.settings.get("server_root_dir") or "~")
        rows = await asyncio.get_running_loop().run_in_executor(
            None, provider.store.list_sessions, str(root_dir)
        )
        favourites = set(state.load_favourites(provider.id))
        for row in rows:
            row["favourite"] = row.get("project_path") in favourites
            # British spelling throughout - the store emits ``colour`` and the
            # frontend's `ISession.colour` reads it; the row's own value is the
            # conversation's default here, resolved against the user-set store.
            row["colour"] = _effective_colour(
                provider, row.get("session_id"), row.get("colour")
            )
        self.finish(json.dumps({"sessions": rows}))

    @tornado.web.authenticated
    def delete(self, provider_id: str) -> None:
        provider = self.resolve(provider_id)
        if provider is None:
            return
        body = self.parse_body()
        if body is None:
            return
        encoded_path = body.get("encoded_path")
        session_ids = body.get("session_ids")
        if not isinstance(encoded_path, str) or not encoded_path:
            self.bad_request()
            return

        if session_ids is not None:
            if not isinstance(session_ids, list):
                self.bad_request()
                return
            # The store answers with the ids that actually went, so a refused
            # deletion never costs the surviving conversation its colour.
            removed = provider.store.delete_branches(
                encoded_path, session_ids, to_trash=self.to_trash
            )
            count = len(removed) if removed is not None else 0
        else:
            # Again the store answers with the ids that actually went: a store
            # that disposes of conversations one by one can come back partly
            # refused, and a survivor whose colour was dropped anyway loses its
            # tint.
            removed = provider.store.remove(encoded_path, to_trash=self.to_trash)
            # One project removed, whatever it held - the count the panel
            # reports for this shape has always been the project, not its
            # conversations.
            count = 1
            if removed is not None:
                state.clear_pin(provider.id, encoded_path)
        if removed is None:
            self.bad_request("remove_failed")
            return
        colour_store.drop_colours(provider.id, removed)
        self.finish(json.dumps({"removed_count": count, "removed_ids": removed}))


class BranchesHandler(_ProviderHandler):
    """List a project's other conversations.

    Off the IOLoop on its own merits: the listing opens and stats every
    conversation to read its label, unbounded by conversation count, and the
    frontend's fork watcher polls it every 2s for up to three minutes.
    """

    @tornado.web.authenticated
    async def get(self, provider_id: str) -> None:
        provider = self.resolve(provider_id)
        if provider is None:
            return
        encoded_path = self.get_query_argument("encoded_path", default="")
        # The decorations only the user-facing fetches need; the fork watcher
        # asks without them so its 2s cadence never pays for a CLI spawn.
        include_extras = self.get_query_argument("include_extras", default="") == "1"
        result = await asyncio.get_running_loop().run_in_executor(
            None, provider.store.list_branches, encoded_path, include_extras
        )
        if result is None:
            self.bad_request("invalid_encoded_path")
            return
        self.finish(json.dumps(result))


class SwitchHandler(_ProviderHandler):
    """Make another conversation the project's current one."""

    @tornado.web.authenticated
    def post(self, provider_id: str) -> None:
        provider = self.resolve(provider_id)
        if provider is None:
            return
        body = self.parse_body()
        if body is None:
            return
        encoded_path = body.get("encoded_path")
        session_id = body.get("session_id")
        if not isinstance(encoded_path, str) or not isinstance(session_id, str):
            self.bad_request()
            return
        result = provider.store.switch(encoded_path, session_id)
        if result is None:
            self.bad_request()
            return
        if result.get("error") == "branch_not_found":
            self.set_status(404)
            self.finish(json.dumps(result))
            return
        # The pin outlives recency: without it, continuing to work in the
        # conversation the user switched away from drags the row back to it.
        state.write_pin(provider.id, encoded_path, session_id)
        self.finish(json.dumps(result))


class FavouriteHandler(_ProviderHandler):
    """Star or unstar a project, per provider."""

    @tornado.web.authenticated
    def post(self, provider_id: str) -> None:
        provider = self.resolve(provider_id)
        if provider is None:
            return
        body = self.parse_body()
        if body is None:
            return
        project_path = body.get("project_path")
        favourite = body.get("favourite")
        if not isinstance(project_path, str) or not isinstance(favourite, bool):
            self.bad_request()
            return
        favs = state.toggle_favourite(provider.id, project_path, favourite)
        self.finish(json.dumps({"favourites": favs}))


class ColoursHandler(_ProviderHandler):
    """One provider's user-set terminal tab colours, keyed by conversation id.

    The write-back that makes a tab colour settable on an assistant whose CLI
    has no colour concept, and durable across a reload. All three verbs answer
    the whole store (``{"colours": {...}}``), so the frontend's cache is
    reconciled by the same payload whichever call it made: ``GET`` reloads,
    ``POST`` records one conversation's colour (a null drops it), ``DELETE``
    forgets the conversations named in ``session_ids``.

    A ``native`` provider owns its own colour, so a write against one is
    refused rather than kept as a shadow value that would never win.
    """

    def _finish_store(self, provider: registry.Provider) -> None:
        self.finish(json.dumps({"colours": colour_store.load_colours(provider.id)}))

    @tornado.web.authenticated
    def get(self, provider_id: str) -> None:
        provider = self.resolve(provider_id)
        if provider is None:
            return
        self._finish_store(provider)

    @tornado.web.authenticated
    def post(self, provider_id: str) -> None:
        provider = self.resolve(provider_id)
        if provider is None:
            return
        body = self.parse_body()
        if body is None:
            return
        session_id = body.get("session_id")
        colour = body.get("colour")
        if not isinstance(session_id, str) or not session_id:
            self.bad_request()
            return
        if colour is not None and not isinstance(colour, str):
            self.bad_request()
            return
        if provider.descriptor.capabilities.colour_source == "native":
            self.bad_request("colour_owned_by_assistant")
            return
        colour_store.set_colour(provider.id, session_id, colour)
        self._finish_store(provider)

    @tornado.web.authenticated
    def delete(self, provider_id: str) -> None:
        provider = self.resolve(provider_id)
        if provider is None:
            return
        body = self.parse_body()
        if body is None:
            return
        session_ids = body.get("session_ids")
        if not isinstance(session_ids, list):
            self.bad_request()
            return
        colour_store.drop_colours(
            provider.id, [sid for sid in session_ids if isinstance(sid, str)]
        )
        self._finish_store(provider)


class BranchHandler(_ProviderHandler):
    """Fork a conversation into a new one.

    Serves only the strategies whose new id the SERVER knows
    (``registry.SERVER_MINTED_FORKS``). A ``native-command`` provider mints its
    fork id inside the launched terminal, so its branch is created by a
    ``fork_from`` launch instead and this route answers 400 ``fork_unsupported``
    rather than a 400 ``fork_failed`` from a store that never implemented it
    (docs/defects.md DEF-1).

    The new branch becomes the project's current conversation immediately - the
    fork is an explicit "go to this one" action, and it would otherwise stay
    shadowed by the parent, whose file keeps being appended and whose mtime
    overtakes it. It also inherits the parent's effective colour, written now
    rather than resolved later so it survives the parent being recoloured or
    deleted - except against a ``native`` provider, whose colour store refuses
    every write (``ColoursHandler``) and would otherwise be seeded here with an
    entry only this route can create.
    """

    @tornado.web.authenticated
    async def post(self, provider_id: str) -> None:
        provider = self.resolve(provider_id)
        if provider is None:
            return
        body = self.parse_body()
        if body is None:
            return
        encoded_path = body.get("encoded_path")
        session_id = body.get("session_id")
        name = body.get("name")
        if not isinstance(encoded_path, str) or not isinstance(session_id, str):
            self.bad_request()
            return
        if name is not None and (not isinstance(name, str) or not name.strip()):
            self.bad_request("invalid_name")
            return
        if (
            provider.descriptor.capabilities.fork_strategy
            not in registry.SERVER_MINTED_FORKS
        ):
            self.bad_request("fork_unsupported")
            return
        new_id = await asyncio.get_running_loop().run_in_executor(
            None, provider.store.fork, encoded_path, session_id, name
        )
        if not new_id:
            self.bad_request("fork_failed")
            return
        state.write_pin(provider.id, encoded_path, new_id)
        if provider.descriptor.capabilities.colour_source != "native":
            colour_store.inherit_colour(
                provider.id,
                session_id,
                new_id,
                provider.store.default_colour(session_id),
            )
        self.finish(json.dumps({"session_id": new_id}))


class LaunchHandler(_ProviderHandler):
    """Spawn a JL terminal whose pty's only process is the assistant.

    Bypasses ``terminal:create-new`` (which spawns the user's $SHELL) so the tab
    shows the assistant immediately without any visible bash, using terminado's
    per-call ``shell_command`` through ``TerminalManager.create``. The argv
    itself is the store's - including which verb opens the conversation, decided
    here at launch rather than by the caller, because the panel's view is only
    as fresh as its last poll.
    """

    @tornado.web.authenticated
    async def post(self, provider_id: str) -> None:
        provider = self.resolve(provider_id)
        if provider is None:
            return
        body = self.parse_body()
        if body is None:
            return
        project_path = body.get("project_path")
        encoded_path = body.get("encoded_path")
        session_id = body.get("session_id")
        new_session_id = body.get("new_session_id")
        fork_session_id = body.get("fork_session_id")
        fork_from = body.get("fork_from")
        mode = body.get("mode")
        name = body.get("name")

        if not isinstance(project_path, str) or not os.path.isdir(project_path):
            self.bad_request("invalid_project_path")
            return
        if encoded_path is not None and not isinstance(encoded_path, str):
            self.bad_request()
            return
        # ``session_id`` opens an existing conversation; absent means a new one.
        if session_id is not None and (
            not isinstance(session_id, str) or not session_id
        ):
            self.bad_request("invalid_session_id")
            return
        # ``new_session_id`` starts a fresh conversation under a caller-chosen
        # id, so the launched terminal is identifiable from its argv. Mutually
        # exclusive with the other two.
        if new_session_id is not None and (
            not isinstance(new_session_id, str)
            or not new_session_id
            or "/" in new_session_id
            or session_id is not None
            or fork_session_id is not None
        ):
            self.bad_request("invalid_new_session_id")
            return
        # ``fork_session_id`` is the id a native fork will run under - only
        # meaningful alongside the conversation being branched.
        if fork_session_id is not None and (
            not isinstance(fork_session_id, str)
            or not fork_session_id
            or "/" in fork_session_id
            or session_id is None
        ):
            self.bad_request("invalid_fork_session_id")
            return
        # ``fork_from`` names the conversation the CLI is to branch, for a
        # provider that owns both the fork verb and the new id
        # (``fork_strategy: native-command``). The launch carries the PARENT and
        # the terminal runs a conversation whose id only exists once the CLI has
        # minted it, which is why it excludes the other three ids rather than
        # riding alongside them.
        if fork_from is not None and (
            not isinstance(fork_from, str)
            or not fork_from
            or "/" in fork_from
            or session_id is not None
            or new_session_id is not None
            or fork_session_id is not None
        ):
            self.bad_request("invalid_fork_from")
            return
        if name is not None and (not isinstance(name, str) or not name.strip()):
            self.bad_request("invalid_name")
            return
        if mode is not None and mode not in provider.descriptor.capabilities.launch_modes:
            self.bad_request("mode_unsupported")
            return
        # Pre-flight the conversation while the caller can still be told about
        # it: past ``terminal_manager.create`` the pty is live and a failure
        # would orphan a terminal the frontend never attaches.
        if session_id and isinstance(encoded_path, str) and encoded_path:
            known = provider.store.project_session_ids(encoded_path)
            if known and session_id not in known:
                self.set_status(404)
                self.finish(json.dumps({"error": "session_not_found"}))
                return

        terminal_manager = self.settings.get("terminal_manager")
        if terminal_manager is None:
            self.set_status(503)
            self.finish(json.dumps({"error": "terminal_service_unavailable"}))
            return

        loop = asyncio.get_running_loop()
        argv = await loop.run_in_executor(
            None,
            lambda: provider.store.launch_argv(
                self.cli_path,
                session_id=session_id,
                new_session_id=new_session_id,
                fork_session_id=fork_session_id,
                fork_from=fork_from,
                mode=mode,
                name=name.strip() if isinstance(name, str) else None,
            ),
        )
        if not argv:
            self.bad_request("launch_unsupported")
            return
        model = terminal_manager.create(
            shell_command=_wrap_with_init(argv), cwd=project_path
        )
        # ``model`` from jupyter_server_terminals is dict-like with at least a
        # ``name`` field; some versions return an object with a ``.name``
        # attribute - handle both.
        terminal_name = (
            model.get("name")
            if isinstance(model, dict)
            else getattr(model, "name", None)
        )
        if not isinstance(terminal_name, str):
            self.set_status(500)
            self.finish(json.dumps({"error": "terminal_create_failed"}))
            return
        if isinstance(encoded_path, str) and encoded_path:
            # A new conversation supersedes a prior switch and becomes current
            # by recency on its own; a fork needs the pin to beat the parent.
            # ANY launch that opens no existing conversation is a new one -
            # keying this on ``new_session_id`` would never fire for an
            # assistant whose CLI mints its own id, leaving the row stuck on
            # the conversation the user last switched to.
            if session_id is None and fork_from is None:
                state.clear_pin(provider.id, encoded_path)
            elif fork_session_id:
                state.write_pin(provider.id, encoded_path, fork_session_id)
        self.finish(json.dumps({"terminal_name": terminal_name}))


class TerminalHandler(_ProviderHandler):
    """Identify what a JL terminal is running, for one provider's reuse ladder.

    Answers whether THIS provider's assistant is the process in the pty's tree
    (``running``), the conversation it is on, that conversation's colour and the
    terminal's live cwds - so the frontend can focus an already-open terminal
    instead of spawning a duplicate, without persisting any state in the
    browser.

    Provider-scoped rather than global: a terminal running another assistant
    answers ``running: false`` with no conversation, so one provider's panel can
    never read another's session ids out of a shared terminal.

    Deliberately synchronous, unlike the listing handlers: this reads ``/proc``
    and at most one store lookup - bounded filesystem work with no subprocess.
    """

    @tornado.web.authenticated
    def get(self, provider_id: str, terminal_name: str) -> None:
        provider = self.resolve(provider_id)
        if provider is None:
            return
        terminal_manager = self.settings.get("terminal_manager")
        if terminal_manager is None:
            self.set_status(503)
            self.finish(json.dumps({"error": "terminal_service_unavailable"}))
            return
        terminal = terminal_manager.get_terminal(terminal_name)
        if terminal is None:
            self.set_status(404)
            self.finish(json.dumps({"error": "terminal_not_found"}))
            return
        ptyproc = getattr(terminal, "ptyproc", None)
        if ptyproc is None or not hasattr(ptyproc, "pid"):
            self.set_status(500)
            self.finish(json.dumps({"error": "terminal_has_no_pty"}))
            return
        found, session_id = _tree_assistant(ptyproc.pid)
        running = found is not None and found.id == provider.id
        self.finish(json.dumps({
            "terminal_name": terminal_name,
            "running": running,
            "cwds": _terminal_cwds(ptyproc.pid),
            "session_id": session_id if running else None,
            # The conversation's own colour, not the row's: a row carries only
            # the project's current conversation, which flips to any newer one,
            # so the store is asked for THIS conversation's default - once per
            # probed terminal, never per row.
            "colour": (
                _effective_colour(
                    provider,
                    session_id,
                    provider.store.default_colour(session_id) if session_id else None,
                )
                if running
                else None
            ),
        }))


class MigrateHandler(APIHandler):
    """Carry state over from the retired standalone extensions, once."""

    @tornado.web.authenticated
    def post(self) -> None:
        migrated = migrate.migrate(registry.providers().values())
        self.finish(json.dumps({"migrated": migrated}))


def setup_route_handlers(web_app) -> None:
    host_pattern = ".*$"
    base_url = web_app.settings["base_url"]
    provider = r"([a-z0-9-]+)"

    # Discover here rather than on the first request, so a contract violation -
    # two providers claiming one id - surfaces at server start with a traceback
    # naming both modules, not as a 500 on some later poll.
    registry.providers()

    handlers = [
        (url_path_join(base_url, URL_PREFIX, "status"), StatusHandler),
        (url_path_join(base_url, URL_PREFIX, "migrate"), MigrateHandler),
        (
            url_path_join(base_url, URL_PREFIX, "providers", provider, "sessions"),
            SessionsHandler,
        ),
        (
            url_path_join(base_url, URL_PREFIX, "providers", provider, "branches"),
            BranchesHandler,
        ),
        (
            url_path_join(base_url, URL_PREFIX, "providers", provider, "switch"),
            SwitchHandler,
        ),
        (
            url_path_join(base_url, URL_PREFIX, "providers", provider, "favourite"),
            FavouriteHandler,
        ),
        (
            url_path_join(base_url, URL_PREFIX, "providers", provider, "colours"),
            ColoursHandler,
        ),
        (
            url_path_join(base_url, URL_PREFIX, "providers", provider, "branch"),
            BranchHandler,
        ),
        (
            url_path_join(base_url, URL_PREFIX, "providers", provider, "launch"),
            LaunchHandler,
        ),
        (
            url_path_join(
                base_url, URL_PREFIX, "providers", provider, "terminal", r"([^/]+)"
            ),
            TerminalHandler,
        ),
    ]

    web_app.add_handlers(host_pattern, handlers)
