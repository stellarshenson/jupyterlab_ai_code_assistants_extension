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
from .store import SessionNotFound, load_jsonc


URL_PREFIX = "jupyterlab-ai-code-assistants-extension"

# The npm package name is what JupyterLab names the user-settings folder it
# writes this extension's saved settings into.
SETTINGS_PLUGIN_ID = "jupyterlab_ai_code_assistants_extension"

# The Tornado application this extension's routes were added to, kept so the
# saved settings are read from the folder the RUNNING server writes them to.
# Captured rather than resolved at setup time: extension load order is not
# fixed, so JupyterLab's own app may not be in the settings dict yet when these
# handlers are registered - the lookup below happens per request instead.
_web_app = None


# bash one-liner that waits until the JL WebSocket client has resized the pty
# from its initial default before clearing and `exec`ing the real argv. A
# threshold-based version (rows>=20 && cols>=80) would be a no-op: terminado's
# default is 24x80, so `c=80 >= 80` passes on the first iteration and nothing
# ever waits.
#
# Strategy: the child marks its OWN pty 1x1, then polls until that is no longer
# the size. 5 s timeout fallback so we still launch if no client ever connects.
# After exec, bash is replaced by the assistant on the same pid - auto-close on
# exit and the process-tree reuse filter still work.
#
# The timeout path RESTORES the size it marked over, because otherwise the
# waiter produces the very outcome it exists to prevent: 50 idle iterations and
# then an assistant exec'd into a 1x1 window, unusable and unrecoverable without
# a resize the user has no reason to make (DEF-47). The same restore is what
# saves a REAL attached client whose resize landed BEFORE the marking - nothing
# will ever change the size again, so that client also runs out the 5 s - and
# because the baseline is captured before the marking, what it gets back is the
# browser's own size rather than a default. Worst case is now a stall into a
# working terminal instead of a fast path into a broken one.
#
# The marking has to happen HERE rather than server-side after ``create``. A
# SIGWINCH trap plus a captured baseline is the differential form of this test,
# and it has to be told the server's own resize apart from the browser's - two
# processes with no ordering between them, so whenever the resize lands after
# the child's baseline read, the trap fires on the server's resize, the loop
# breaks on its first iteration and the assistant execs into a 1x1 window with
# no client attached (DEF-33, measured 1 in 5). Marking and polling in one
# process, in that order, removes the interleaving rather than narrowing it,
# and no browser ever renders 1x1, so every real attach is a change.
_INIT_WAITER = (
    "read r0 c0 < <(stty size 2>/dev/null || echo '24 80'); "
    '[ "$r0" -gt 1 ] 2>/dev/null || r0=24; '
    '[ "$c0" -gt 1 ] 2>/dev/null || c0=80; '
    "stty rows 1 cols 1 2>/dev/null; "
    "for i in $(seq 1 50); do "
    "read r c < <(stty size 2>/dev/null || echo '0 0'); "
    'if [ "$r" != "1" ] || [ "$c" != "1" ]; then break; fi; '
    "sleep 0.1; "
    "done; "
    # Still the size we marked, so nothing ever resized this pty: put the
    # baseline back rather than exec into 1x1 (DEF-47).
    'if [ "$r" = "1" ] && [ "$c" = "1" ]; then '
    'stty rows "$r0" cols "$c0" 2>/dev/null; fi; '
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

    SHALLOWEST WINS, and that is the whole reason every enabled provider is
    asked rather than just the one that called: a claude terminal that spawned
    ``codex`` as a tool must answer "not yours" to the codex panel, or that
    panel reuses a terminal it does not own. Narrowing the candidate list to
    the caller looks free and quietly breaks exactly that.
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


def _user_settings_dir() -> Path:
    """The folder JupyterLab saves user settings into on THIS server.

    ``user_settings_dir`` is a configurable trait (``--LabApp.user_settings_dir``
    or ``JUPYTERLAB_SETTINGS_DIR``), and a server that moved it writes the
    provider toggles somewhere the hardcoded default never looks - so every
    provider would read as enabled whatever the user turned off. JupyterLab
    registers itself in the web application's settings under its extension name,
    which is how the configured value is reached from here.

    The default stays as the fallback, so a server with no JupyterLab app in it
    - the bare ``jupyter server`` the tests run against - behaves exactly as it
    did before.
    """
    settings = getattr(_web_app, "settings", None)
    lab = settings.get("lab") if isinstance(settings, dict) else None
    configured = getattr(lab, "user_settings_dir", None)
    if isinstance(configured, str) and configured:
        return Path(configured)
    return Path(jupyter_config_dir()) / "lab" / "user-settings"


def _user_settings() -> dict:
    """This extension's saved settings, or empty when never saved."""
    folder = _user_settings_dir() / SETTINGS_PLUGIN_ID
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


def _provider_enabled(provider_id: str, settings: dict | None = None) -> bool:
    """Whether the user has left a provider on.

    An absent key reads as on - only an explicit ``false`` disables, so a fresh
    install with no saved settings runs every provider (acc-crit "Missing key
    reads as on").

    ``settings`` lets a caller asking about SEVERAL providers hand in the saved
    settings it already read, so one request parses the file once instead of
    once per provider (docs/defects.md DEF-91). Omitted, it reads them itself,
    which is what a single-provider gate does.
    """
    if settings is None:
        settings = _user_settings()
    return settings.get(enabled_setting_key(provider_id)) is not False


def _enabled_providers() -> dict[str, registry.Provider]:
    settings = _user_settings()
    return {
        pid: provider
        for pid, provider in registry.providers().items()
        if _provider_enabled(pid, settings)
    }


def _effective_colour(
    session_id: str | None,
    default: str | None,
    stored: dict[str, str],
) -> str | None:
    """The tint a conversation should carry now.

    ``default`` is the conversation's own colour as its source produced it -
    the value the store already read while building the row, so a listing never
    re-derives it once per row. The extension's own store overrides it for
    EVERY provider, ``native`` included: a colour the user set by hand on the
    tab is a later expression of intent than the one the assistant's own
    ``/color`` produced, so it wins and is remembered.

    ``stored`` is the override map, passed in rather than read here: a listing
    resolves every row from one file read, and a required parameter means one
    lookup path rather than two for the same question.
    """
    if not session_id:
        return None
    return stored.get(session_id) or default


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
    async def get(self) -> None:
        # ``server_root_dir`` is the root path Jupyter serves from; fall back to
        # home when unset. Expand a leading ``~`` - some deployments leave the
        # setting as ``~/workspace``, and the frontend compares it against
        # absolute session paths, so an unexpanded ``~`` never matches.
        root_dir = os.path.expanduser(self.settings.get("server_root_dir") or "~")

        def roster() -> list[dict]:
            # The saved settings read ONCE for the whole roster rather than once
            # per provider (docs/defects.md DEF-91).
            settings = _user_settings()
            rows = []
            for pid, provider in registry.providers().items():
                cli_path = provider.cli_path()
                rows.append({
                    "id": pid,
                    "label": provider.descriptor.label,
                    "enabled": _provider_enabled(pid, settings),
                    "cli_path": cli_path,
                    "available": cli_path is not None,
                })
            return rows

        # Off the IOLoop: the roster globs and parses the settings file and
        # stats PATH for every provider's binary.
        providers = await asyncio.get_running_loop().run_in_executor(None, roster)
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
        # Read once for the whole listing, not once per row.
        stored = colour_store.load_colours(provider.id)
        for row in rows:
            row["favourite"] = row.get("project_path") in favourites
            # British spelling throughout - the store emits ``colour`` and the
            # frontend's `ISession.colour` reads it; the row's own value is the
            # conversation's default here, resolved against the user-set store.
            row["colour"] = _effective_colour(
                row.get("session_id"), row.get("colour"), stored
            )
        self.finish(json.dumps({"sessions": rows}))

    @tornado.web.authenticated
    async def delete(self, provider_id: str) -> None:
        """Off the IOLoop, like the listing above and for a harder reason.

        Disposal is per conversation for a store whose CLI owns the verb: one
        subprocess each, measured at ~0.7s, so a project holding twenty of them
        blocks every kernel, terminal and notebook save in the server for the
        length of the sweep. The other stores reach ``send2trash`` here, which
        copies across devices when the trash is on another filesystem.
        """
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
            removed = await asyncio.get_running_loop().run_in_executor(
                None,
                lambda: provider.store.delete_branches(
                    encoded_path, session_ids, to_trash=self.to_trash
                ),
            )
            count = len(removed) if removed is not None else 0
        else:
            # Again the store answers with the ids that actually went: a store
            # that disposes of conversations one by one can come back partly
            # refused, and a survivor whose colour was dropped anyway loses its
            # tint.
            removed = await asyncio.get_running_loop().run_in_executor(
                None,
                lambda: provider.store.remove(encoded_path, to_trash=self.to_trash),
            )
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
    async def post(self, provider_id: str) -> None:
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
        # Off the IOLoop for the same reason as the listing: a store whose
        # index is unreadable falls back to walking every conversation file of
        # every project to find the one asked for.
        result = await asyncio.get_running_loop().run_in_executor(
            None, provider.store.switch, encoded_path, session_id
        )
        if result is None:
            self.bad_request()
            return
        if result.get("error") == "branch_not_found":
            self.set_status(404)
            self.finish(json.dumps(result))
            return
        # The pin outlives recency: without it, continuing to work in the
        # conversation the user switched away from drags the row back to it.
        # Written HERE on the loop for every provider - the store's switch only
        # touches mtimes, never the state file, so no pin write can run on the
        # executor thread above (docs/defects.md DEF-99/DEF-101).
        state.write_pin(provider.id, encoded_path, session_id)
        # `current` is answered HERE, after the pin is on disk - the stores no
        # longer compute it at all (docs/defects.md DEF-103). Answering before
        # the pin landed served the OLD pin for a project that already carried
        # one - deterministically, on every switch after the first - and the
        # panel reads `current != requested` as a failed switch (DEF-102).
        # This is a READ, so it is pooled, and it applies the store's own pin
        # validation rather than assuming the answer.
        result["current"] = await asyncio.get_running_loop().run_in_executor(
            None, provider.store.resolve_current, encoded_path
        )
        self.finish(json.dumps(result))


class FavouriteHandler(_ProviderHandler):
    """Star or unstar a project, per provider."""

    @tornado.web.authenticated
    async def post(self, provider_id: str) -> None:
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
        # ON the loop DELIBERATELY: every WRITE to a state or colour file runs
        # on the IOLoop thread, so the loop itself serialises the unlocked
        # read-modify-rewrite - a pooled write races the loop-thread pin
        # writes and silently loses one (docs/defects.md DEF-99). Only READS
        # go to the executor (DEF-82).
        favs = state.toggle_favourite(provider.id, project_path, favourite)
        self.finish(json.dumps({"favourites": favs}))


class ColoursHandler(_ProviderHandler):
    """One provider's user-set terminal tab colours, keyed by conversation id.

    The write-back that makes a tab colour settable for EVERY provider, and
    durable across a reload. All three verbs answer the whole store
    (``{"colours": {...}, "overrides": [...]}``), so the frontend's cache is
    reconciled by the same payload whichever call it made: ``GET`` reloads,
    ``POST`` records one conversation's colour (a null drops it), ``DELETE``
    forgets the conversations named in ``session_ids``. ``overrides`` names the
    hand-set colours among them - the release affordance offers only those,
    since an inherited tint is a branch's identity rather than a preference to
    take back.

    Every provider is writable, ``native`` ones included. An assistant that
    owns conversation colours only supplies the DEFAULT tint; a colour the user
    then sets by hand on the tab diverges from it deliberately, and that later
    preference is what the store keeps.

    A write that cannot be persisted answers 500 rather than 200. Elsewhere a
    colour is decoration and a failed write costs only the tint, but here the
    colour IS the request - and the frontend releases the tab's own record of
    the choice once it believes the store holds it.
    """

    async def _finish_store(self, provider: registry.Provider) -> None:
        # Off the IOLoop: the store is a file read (docs/defects.md DEF-82).
        colours, overrides = await asyncio.get_running_loop().run_in_executor(
            None, colour_store.load_store, provider.id
        )
        self.finish(json.dumps({"colours": colours, "overrides": overrides}))

    def _store_unwritable(self) -> None:
        self.set_status(500)
        self.finish(json.dumps({"error": "colour_store_unwritable"}))

    @tornado.web.authenticated
    async def get(self, provider_id: str) -> None:
        provider = self.resolve(provider_id)
        if provider is None:
            return
        await self._finish_store(provider)

    @tornado.web.authenticated
    async def post(self, provider_id: str) -> None:
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
        if colour is not None and not colour_store.is_colour(colour):
            # A colour the store would refuse is a bad request, not a storage
            # failure - the 500 below means the state dir could not be written.
            self.bad_request("colour_invalid")
            return
        # A fork writes its inherited tint through this same route; only the
        # tab write-back is the user's own choice.
        hand_set = body.get("hand_set", True)
        if not isinstance(hand_set, bool):
            self.bad_request()
            return
        # ON the loop: state/colour WRITES are loop-serialised (docs/defects.md
        # DEF-99); only reads use the executor. Provider-store work (fork,
        # switch, delete) legitimately stays pooled - it never WRITES these
        # files, and its pooled reads are safe against the atomic rename.
        if not colour_store.set_colour(provider.id, session_id, colour, hand_set):
            self._store_unwritable()
            return
        await self._finish_store(provider)

    @tornado.web.authenticated
    async def delete(self, provider_id: str) -> None:
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
        # ON the loop, like the write above: state/colour WRITES are
        # loop-serialised (docs/defects.md DEF-99).
        if not colour_store.drop_colours(
            provider.id,
            [sid for sid in session_ids if isinstance(sid, str)],
        ):
            self._store_unwritable()
            return
        await self._finish_store(provider)


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
    deleted. A ``native`` provider inherits only what this extension's own
    store holds for the parent - never the assistant's own tint, which would
    pin the fork and shadow its own ``/color``. An inherited entry counts: a
    branch of a branch takes what its parent actually shows.
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
        # A native provider hands the fork its own colour, so only what this
        # store already holds is worth inheriting - passing no default makes
        # ``inherit_colour`` write exactly that, or nothing.
        parent_default = (
            None
            if provider.descriptor.capabilities.colour_source == "native"
            else provider.store.default_colour(session_id)
        )
        colour_store.inherit_colour(provider.id, session_id, new_id, parent_default)
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
        loop = asyncio.get_running_loop()
        if session_id and isinstance(encoded_path, str) and encoded_path:
            # In the executor for the same reason `launch_argv` below is: this
            # walks every conversation file in the project, so it is linear in
            # the project's bytes and was blocking the whole event loop on
            # every row click - measured at 191 ms against a 20-conversation
            # Gemini store, with a canary coroutine on the same loop.
            known = await loop.run_in_executor(
                None, provider.store.project_session_ids, encoded_path
            )
            if known and session_id not in known:
                self.set_status(404)
                self.finish(json.dumps({"error": "session_not_found"}))
                return

        terminal_manager = self.settings.get("terminal_manager")
        if terminal_manager is None:
            self.set_status(503)
            self.finish(json.dumps({"error": "terminal_service_unavailable"}))
            return

        try:
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
        except SessionNotFound:
            # The store re-checked at launch time and the conversation was not
            # there. Same answer as the pre-flight above, because it is the same
            # outcome - the pre-flight simply cannot see every store's version
            # of "gone" (a project whose whole history directory has been
            # removed enumerates as nothing rather than as a miss).
            self.set_status(404)
            self.finish(json.dumps({"error": "session_not_found"}))
            return
        if not argv:
            self.bad_request("launch_unsupported")
            return
        model = terminal_manager.create(
            shell_command=_wrap_with_init(argv), cwd=project_path
        )
        # The pty is sized by ``_INIT_WAITER`` inside the child, not from here:
        # a resize issued at this point is indistinguishable from the client
        # attach the child is waiting for, and would end its poll before any
        # client arrived.
        #
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

    Off the IOLoop like the listing handlers: the probe walks ``/proc`` for the
    whole process tree and reaches the store, bounded work but still filesystem
    work, and it runs once per probed terminal (docs/defects.md DEF-82).
    """

    @tornado.web.authenticated
    async def get(self, provider_id: str, terminal_name: str) -> None:
        provider = self.resolve(provider_id)
        if provider is None:
            return
        terminal_manager = self.settings.get("terminal_manager")
        if terminal_manager is None:
            self.set_status(503)
            self.finish(json.dumps({"error": "terminal_service_unavailable"}))
            return
        # Looked up in the registry rather than through ``get_terminal``, which
        # is get-OR-CREATE in both terminado's NamedTermManager and
        # jupyter_server_terminals' TerminalManager. A probe of a name the
        # manager has never seen - a widget outliving its pty, or the
        # enumerate-to-probe race the frontend already expects - would SPAWN a
        # terminal, and one born that way never gets the ``last_activity``
        # attribute ``TerminalManager.create`` patches on, so the very next
        # ``TerminalManager.list()`` raises for every terminal in the list and
        # ``GET /api/terminals`` 500s for every client of this server until it
        # restarts (DEF-32). Upstream guards the same call in its own websocket
        # handler for this reason. The 404 below is live only because of this.
        #
        # Read straight off the attribute, with no `getattr` default: every
        # terminal the manager legitimately creates is registered there by
        # terminado itself, so a manager without it is a shape this route
        # cannot answer for - and a default of `{}` would turn that into every
        # probe quietly answering 404, which reads as "no terminals" and takes
        # tab colours and session identification down without a word.
        terminal = terminal_manager.terminals.get(terminal_name)
        if terminal is None:
            self.set_status(404)
            self.finish(json.dumps({"error": "terminal_not_found"}))
            return
        ptyproc = getattr(terminal, "ptyproc", None)
        if ptyproc is None or not hasattr(ptyproc, "pid"):
            self.set_status(500)
            self.finish(json.dumps({"error": "terminal_has_no_pty"}))
            return
        pid = ptyproc.pid

        def probe() -> dict:
            found, session_id = _tree_assistant(pid)
            running = found is not None and found.id == provider.id
            return {
                "terminal_name": terminal_name,
                "running": running,
                "cwds": _terminal_cwds(pid),
                "session_id": session_id if running else None,
                # The conversation's own colour, not the row's: a row carries
                # only the project's current conversation, which flips to any
                # newer one, so the store is asked for THIS conversation's
                # default - once per probed terminal, never per row.
                "colour": (
                    _effective_colour(
                        session_id,
                        provider.store.default_colour(session_id)
                        if session_id
                        else None,
                        colour_store.load_colours(provider.id),
                    )
                    if running
                    else None
                ),
            }

        payload = await asyncio.get_running_loop().run_in_executor(None, probe)
        self.finish(json.dumps(payload))


class MigrateHandler(APIHandler):
    """Carry state over from the retired standalone extensions, once."""

    @tornado.web.authenticated
    def post(self) -> None:
        # The retired extensions' settings sit beside this one's, so migration
        # reads the folder THIS server writes to rather than the default.
        # Synchronous ON the loop DELIBERATELY: migrate WRITES provider state
        # (favourites merge into state files), and state/colour writes are
        # loop-serialised (docs/defects.md DEF-99).
        migrated = migrate.migrate(
            registry.providers().values(), _user_settings_dir()
        )
        self.finish(json.dumps({"migrated": migrated}))


def setup_route_handlers(web_app) -> None:
    global _web_app
    _web_app = web_app
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
