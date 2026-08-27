"""Route gating, over a live jupyter_server.

The three gates run before any handler body and in a fixed order - unknown id,
turned off in settings, binary missing from PATH - so each is asserted through
the HTTP layer rather than against the helper, and the order is asserted too:
a provider that is both disabled and uninstalled must answer with the setting,
which is the one the user can act on.
"""
from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import pytest
import tornado

from jupyterlab_ai_code_assistants_extension.core import registry, routes, state
from jupyterlab_ai_code_assistants_extension.providers import claude as claude_provider


URL = "jupyterlab-ai-code-assistants-extension"


@pytest.fixture
def disable(monkeypatch):
    """Turn providers off the way saved settings do.

    Flat dotted keys, exactly as ``schema/plugin.json`` declares them and
    ``src/index.ts`` writes them - a nested ``{"providers": {...}}`` fixture is
    what let the gate pass while never firing (docs/defects.md DEF-5).
    """

    def _disable(*provider_ids: str) -> None:
        monkeypatch.setattr(
            routes,
            "_user_settings",
            lambda: {
                routes.enabled_setting_key(pid): False for pid in provider_ids
            },
        )

    return _disable


@pytest.fixture
def uninstall(monkeypatch):
    """Take providers' binaries off PATH."""

    def _uninstall(*provider_ids: str) -> None:
        original = registry.Provider.cli_path
        monkeypatch.setattr(
            registry.Provider,
            "cli_path",
            lambda self: None if self.id in provider_ids else original(self),
        )

    return _uninstall


@pytest.fixture
def present(monkeypatch):
    """Put every provider's binary on PATH, so a machine missing one still runs
    the tests that are about routing rather than about installation."""
    monkeypatch.setattr(
        registry.Provider, "cli_path", lambda self: f"/usr/bin/{self.id}"
    )


async def error_of(jp_fetch, *path, **kwargs) -> tuple[int, str]:
    """The status and ``error`` token of a refused request."""
    with pytest.raises(tornado.httpclient.HTTPClientError) as excinfo:
        await jp_fetch(*path, **kwargs)
    body = json.loads(excinfo.value.response.body)
    return excinfo.value.code, body.get("error")


async def test_status_lists_every_provider(jp_fetch):
    response = await jp_fetch(URL, "status")
    payload = json.loads(response.body)
    assert "root_dir" in payload
    listed = {entry["id"]: entry for entry in payload["providers"]}
    assert set(listed) == set(registry.providers())
    for entry in listed.values():
        # Availability is two-dimensional and both halves are reported, so the
        # panel can show a provider that is on but unusable.
        assert set(entry) >= {"id", "label", "enabled", "cli_path", "available"}
        assert entry["available"] is (entry["cli_path"] is not None)


async def test_unknown_provider_is_404(jp_fetch):
    assert await error_of(jp_fetch, URL, "providers", "nosuch", "sessions") == (
        404,
        "provider_unknown",
    )


async def test_disabled_provider_is_404(jp_fetch, disable, present):
    disable("claude")
    assert await error_of(jp_fetch, URL, "providers", "claude", "sessions") == (
        404,
        "provider_disabled",
    )


async def test_absent_cli_is_503(jp_fetch, uninstall):
    uninstall("claude")
    assert await error_of(jp_fetch, URL, "providers", "claude", "sessions") == (
        503,
        "cli_not_found",
    )


async def test_the_setting_is_reported_before_the_missing_binary(
    jp_fetch, disable, uninstall
):
    disable("claude")
    uninstall("claude")
    assert await error_of(jp_fetch, URL, "providers", "claude", "sessions") == (
        404,
        "provider_disabled",
    )


async def test_gating_is_per_provider(jp_fetch, disable, present):
    """Turning one assistant off never touches another's routes."""
    disable("claude")
    assert await error_of(jp_fetch, URL, "providers", "claude", "sessions") == (
        404,
        "provider_disabled",
    )
    response = await jp_fetch(URL, "providers", "kimi", "sessions")
    assert response.code == 200
    assert json.loads(response.body)["sessions"] == []


async def test_absent_key_reads_as_enabled(jp_fetch, monkeypatch, present):
    """Only an explicit ``false`` disables - a fresh install runs everything."""
    monkeypatch.setattr(routes, "_user_settings", lambda: {})
    response = await jp_fetch(URL, "providers", "claude", "sessions")
    assert response.code == 200


async def test_the_gate_reads_the_key_the_schema_declares(jp_fetch, present):
    """The settings key the server reads is the one the schema ships.

    The gate and the settings schema are written in two languages and were
    disagreeing silently: the schema declares ``providers.<id>.enabled`` as one
    flat key with dots in its name, and a server reading it as a nested dict
    answers "enabled" for everything (docs/defects.md DEF-5). Read the schema
    rather than restating it, so a rename of either side fails here.
    """
    schema = json.loads(
        (Path(__file__).resolve().parents[2] / "schema" / "plugin.json").read_text(
            encoding="utf-8"
        )
    )
    declared = set(schema["properties"])
    for provider_id in registry.providers():
        assert routes.enabled_setting_key(provider_id) in declared


async def test_a_flat_disable_key_gates_the_route(jp_fetch, monkeypatch, present):
    """A settings file in JupyterLab's own shape turns the provider off."""
    monkeypatch.setattr(
        routes,
        "_user_settings",
        lambda: {"providers.claude.enabled": False, "recentLimit": 10},
    )
    assert await error_of(jp_fetch, URL, "providers", "claude", "sessions") == (
        404,
        "provider_disabled",
    )
    assert (await jp_fetch(URL, "providers", "kimi", "sessions")).code == 200


@pytest.mark.parametrize(
    "verb,path,body",
    [
        ("GET", "branches", None),
        ("GET", "colours", None),
        ("POST", "switch", {"encoded_path": "x", "session_id": "y"}),
        ("POST", "favourite", {"project_path": "/tmp", "favourite": True}),
        ("POST", "branch", {"encoded_path": "x", "session_id": "y"}),
        ("POST", "launch", {"project_path": "/tmp"}),
        ("DELETE", "sessions", {"encoded_path": "x"}),
    ],
)
async def test_every_provider_route_is_gated(jp_fetch, disable, verb, path, body):
    """The gate lives on the shared handler, so no route can skip it."""
    disable("claude")
    kwargs = {"method": verb}
    if body is not None:
        kwargs["body"] = json.dumps(body)
    if verb == "DELETE":
        # tornado's client refuses a DELETE body unless told the verb takes one.
        kwargs["allow_nonstandard_methods"] = True
    assert await error_of(jp_fetch, URL, "providers", "claude", path, **kwargs) == (
        404,
        "provider_disabled",
    )


async def test_unsupported_launch_mode_is_refused(jp_fetch, tmp_path, present):
    """A mode the descriptor does not declare never reaches the store."""
    status, error = await error_of(
        jp_fetch,
        URL,
        "providers",
        "claude",
        "launch",
        method="POST",
        body=json.dumps({"project_path": str(tmp_path), "mode": "notAMode"}),
    )
    assert (status, error) == (400, "mode_unsupported")


async def test_branch_is_refused_when_the_provider_cannot_fork(
    jp_fetch, tmp_path, present, monkeypatch
):
    """``fork_strategy: none`` answers 400 ``fork_unsupported``, not a 500."""
    provider = registry.get("claude")
    capabilities = dataclasses.replace(
        provider.descriptor.capabilities, fork_strategy="none"
    )
    monkeypatch.setattr(
        provider,
        "descriptor",
        dataclasses.replace(provider.descriptor, capabilities=capabilities),
    )
    status, error = await error_of(
        jp_fetch,
        URL,
        "providers",
        "claude",
        "branch",
        method="POST",
        body=json.dumps({"encoded_path": "x", "session_id": "y"}),
    )
    assert (status, error) == (400, "fork_unsupported")


async def test_migrate_is_reachable_and_idempotent(jp_fetch, monkeypatch, tmp_path):
    """The endpoint answers a list, and a second call migrates nothing."""
    monkeypatch.setattr(
        routes.migrate, "jupyter_config_dir", lambda: str(tmp_path / "config")
    )
    first = json.loads((await jp_fetch(URL, "migrate", method="POST", body="")).body)
    second = json.loads((await jp_fetch(URL, "migrate", method="POST", body="")).body)
    assert isinstance(first["migrated"], list)
    assert second["migrated"] == []


async def test_status_reports_the_move_to_trash_preference(jp_fetch):
    """The panel has no handle on the contents manager, so the server sends it.

    Without it a delete dialog can only recite both outcomes instead of naming
    the one the click will actually have (docs/defects.md DEF-3).
    """
    payload = json.loads((await jp_fetch(URL, "status")).body)
    assert isinstance(payload["delete_to_trash"], bool)


async def test_the_colour_store_serves_all_three_verbs(jp_fetch, present):
    """``GET``/``POST``/``DELETE providers/<id>/colours``, each answering the store.

    The panel's ``ColourStore`` calls all three against this path and each of
    them reconciles its cache from the payload, so all three answer the whole
    store. The server used to register one POST ``colour`` instead, which made
    every user-set tab colour a 404 (docs/defects.md DEF-3).
    """
    session_id = "11111111-2222-3333-4444-555555555555"
    empty = json.loads((await jp_fetch(URL, "providers", "codex", "colours")).body)
    assert empty["colours"] == {}

    written = json.loads(
        (
            await jp_fetch(
                URL,
                "providers",
                "codex",
                "colours",
                method="POST",
                body=json.dumps({"session_id": session_id, "colour": "mint"}),
            )
        ).body
    )
    assert written["colours"] == {session_id: "mint"}
    reloaded = json.loads((await jp_fetch(URL, "providers", "codex", "colours")).body)
    assert reloaded["colours"] == {session_id: "mint"}

    dropped = json.loads(
        (
            await jp_fetch(
                URL,
                "providers",
                "codex",
                "colours",
                method="DELETE",
                body=json.dumps({"session_ids": [session_id]}),
                allow_nonstandard_methods=True,
            )
        ).body
    )
    assert dropped["colours"] == {}


async def test_a_native_colour_provider_accepts_a_write(jp_fetch, present):
    """The assistant supplies the default; the user's tab colour overrides it."""
    stored = json.loads(
        (
            await jp_fetch(
                URL,
                "providers",
                "claude",
                "colours",
                method="POST",
                body=json.dumps({"session_id": "abc", "colour": "mint"}),
            )
        ).body
    )
    assert stored["colours"]["abc"] == "mint"


async def test_colours_are_per_provider(jp_fetch, present):
    """A colour set against one assistant never surfaces on another's."""
    session_id = "99999999-8888-7777-6666-555555555555"
    await jp_fetch(
        URL,
        "providers",
        "codex",
        "colours",
        method="POST",
        body=json.dumps({"session_id": session_id, "colour": "sky"}),
    )
    other = json.loads((await jp_fetch(URL, "providers", "kimi", "colours")).body)
    assert other["colours"] == {}


class _FakeTerminalManager:
    """Records what a launch asked for instead of spawning a pty.

    ``get_terminal`` is get-OR-CREATE here because it is get-or-create in both
    real managers - a fake that answered None for an unknown name would hide
    DEF-32 rather than reproduce it, and ``terminals`` is the registry the
    route is required to read instead.
    """

    def __init__(self) -> None:
        self.created: list[dict] = []
        self.terminals: dict[str, "_FakePty"] = {}

    def create(self, shell_command=None, cwd=None):
        # Deliberately NO ``dimensions`` parameter: terminado accepts one and
        # drops it before the pty, so a fake that recorded it would certify a
        # resize that never happens.
        self.created.append({"shell_command": shell_command, "cwd": cwd})
        self.terminals["term-1"] = _FakePty()
        return {"name": "term-1"}

    def get_terminal(self, name):
        return self.terminals.setdefault(name, _FakePty())


class _FakePty:
    """Just enough terminal to stand in for one the manager holds.

    The pid is settable because the probe route walks ``/proc`` from it: a
    probe of a pid that is live on this machine would enumerate the real
    process tree of whatever is running as pid 1 in the container.
    """

    def __init__(self, pid: int = 1) -> None:
        self.ptyproc = self
        self.pid = pid


# Above ``/proc/sys/kernel/pid_max`` on every Linux this server runs on, so
# every ``/proc/<pid>`` read the probe makes answers "gone" rather than
# reaching a process the test does not own.
UNUSED_PID = 0x40000000


async def test_a_launch_sizes_the_pty_from_inside_the_child(
    jp_fetch, jp_serverapp, tmp_path, present, monkeypatch
):
    """The waiter marks its own pty; the route must not race it.

    A browser terminal that renders exactly terminado's 24x80 default resizes
    to the size it already has, which Linux answers without raising SIGWINCH -
    so nothing fires and the assistant appears five seconds later behind the
    launch modal. The 1x1 mark is what makes every attach a real change, and
    it belongs to the child: issued from the route it races the child's own
    baseline read and can exec the assistant into a 1x1 window (DEF-33).
    """
    manager = _FakeTerminalManager()
    monkeypatch.setitem(jp_serverapp.web_app.settings, "terminal_manager", manager)
    monkeypatch.setattr(registry.Provider, "cli_path", lambda self: "/usr/bin/x")
    await jp_fetch(
        URL,
        "providers",
        "claude",
        "launch",
        method="POST",
        body=json.dumps({"project_path": str(tmp_path)}),
    )
    script = manager.created[0]["shell_command"][2]
    assert "stty rows 1 cols 1" in script
    # No SIGWINCH trap and no captured baseline: the differential form is what
    # the server-side resize used to race.
    assert "WINCH" not in script


async def test_probing_an_unknown_terminal_creates_nothing(
    jp_fetch, jp_serverapp, present, monkeypatch
):
    """A probe must never spawn the terminal it fails to find (DEF-32).

    ``get_terminal`` creates on a miss, and a terminal born that way has no
    ``last_activity``, so ``TerminalManager.list()`` then raises for EVERY
    terminal and ``GET /api/terminals`` 500s for every client of the server.
    """
    manager = _FakeTerminalManager()
    monkeypatch.setitem(jp_serverapp.web_app.settings, "terminal_manager", manager)
    with pytest.raises(tornado.httpclient.HTTPClientError) as excinfo:
        await jp_fetch(URL, "providers", "claude", "terminal", "never-seen")
    assert excinfo.value.code == 404
    assert manager.terminals == {}


async def test_probing_a_known_terminal_answers_its_conversation_and_colour(
    jp_fetch, jp_serverapp, present, monkeypatch
):
    """The whole point of the route, which had no test at all.

    DEF-32 covered only the miss - the 404 - so every line past the registry
    lookup was unexercised: resolving the assistant out of the pty's process
    tree, reading the conversation off it, and resolving that conversation's
    tint through the colour store. The identity half is stubbed at the store,
    since a real answer needs a live assistant in a real pty; everything the
    ROUTE does with that answer is the assertion.
    """
    session_id = "77777777-6666-5555-4444-333333333333"
    manager = _FakeTerminalManager()
    # Registered directly, never through ``create``: this is the terminal a
    # browser tab already holds, which is the only case the route answers for.
    manager.terminals["term-known"] = _FakePty(pid=UNUSED_PID)
    monkeypatch.setitem(jp_serverapp.web_app.settings, "terminal_manager", manager)
    monkeypatch.setattr(
        claude_provider.ClaudeStore, "owns_pid", lambda self, pid: pid == UNUSED_PID
    )
    monkeypatch.setattr(
        claude_provider.ClaudeStore,
        "session_id_for_pid",
        lambda self, pid: session_id,
    )
    # A hand-set tab colour, so the answer's ``colour`` is a value the store
    # actually holds rather than the None a bare scratch tree would give.
    await jp_fetch(
        URL,
        "providers",
        "claude",
        "colours",
        method="POST",
        body=json.dumps({"session_id": session_id, "colour": "lemon"}),
    )

    answer = json.loads(
        (await jp_fetch(URL, "providers", "claude", "terminal", "term-known")).body
    )
    assert answer == {
        "terminal_name": "term-known",
        "running": True,
        "cwds": [],
        "session_id": session_id,
        "colour": "lemon",
    }
    # The probe read the registry and left it alone - a get-or-create lookup
    # here is DEF-32 in the shape that does not 404.
    assert list(manager.terminals) == ["term-known"]


async def test_probing_a_terminal_running_another_assistant_says_nothing(
    jp_fetch, jp_serverapp, present, monkeypatch
):
    """One provider's panel never reads another's conversation ids.

    Same terminal, same running assistant, asked through the codex routes:
    ``running`` false, and - the part that matters - no session id and no
    colour, so a shared terminal cannot leak one assistant's conversation into
    another's panel.
    """
    manager = _FakeTerminalManager()
    manager.terminals["term-known"] = _FakePty(pid=UNUSED_PID)
    monkeypatch.setitem(jp_serverapp.web_app.settings, "terminal_manager", manager)
    monkeypatch.setattr(
        claude_provider.ClaudeStore, "owns_pid", lambda self, pid: pid == UNUSED_PID
    )
    monkeypatch.setattr(
        claude_provider.ClaudeStore,
        "session_id_for_pid",
        lambda self, pid: "77777777-6666-5555-4444-333333333333",
    )
    answer = json.loads(
        (await jp_fetch(URL, "providers", "codex", "terminal", "term-known")).body
    )
    assert answer["running"] is False
    assert answer["session_id"] is None
    assert answer["colour"] is None


async def test_a_native_command_fork_launches_with_fork_from(
    jp_fetch, jp_serverapp, tmp_path, present, monkeypatch
):
    """The parent id reaches the store, which builds the CLI's own fork verb.

    A ``native-command`` provider mints the fork id itself, inside the launched
    terminal, so branching it is a launch carrying the PARENT - the core had no
    such path at all and the branch route answered 400 ``fork_failed``
    (docs/defects.md DEF-1).
    """
    manager = _FakeTerminalManager()
    monkeypatch.setitem(jp_serverapp.web_app.settings, "terminal_manager", manager)
    parent = "11111111-2222-3333-4444-555555555555"
    response = await jp_fetch(
        URL,
        "providers",
        "codex",
        "launch",
        method="POST",
        body=json.dumps({"project_path": str(tmp_path), "fork_from": parent}),
    )
    assert json.loads(response.body)["terminal_name"] == "term-1"
    assert manager.created[0]["shell_command"][-3:] == [
        "/usr/bin/codex",
        "fork",
        parent,
    ]


async def test_fork_from_excludes_the_other_launch_ids(jp_fetch, tmp_path, present):
    """The CLI mints the fork id, so no other id may ride alongside the parent."""
    status, error = await error_of(
        jp_fetch,
        URL,
        "providers",
        "codex",
        "launch",
        method="POST",
        body=json.dumps(
            {
                "project_path": str(tmp_path),
                "session_id": "11111111-2222-3333-4444-555555555555",
                "fork_from": "22222222-3333-4444-5555-666666666666",
            }
        ),
    )
    assert (status, error) == (400, "invalid_fork_from")


async def test_a_native_command_provider_has_no_server_side_branch(
    jp_fetch, present
):
    """Its fork id exists only inside the terminal, so the branch route refuses.

    400 ``fork_unsupported`` rather than the 400 ``fork_failed`` a store that
    never implemented ``fork`` used to answer.
    """
    status, error = await error_of(
        jp_fetch,
        URL,
        "providers",
        "codex",
        "branch",
        method="POST",
        body=json.dumps({"encoded_path": "/tmp", "session_id": "x"}),
    )
    assert (status, error) == (400, "fork_unsupported")


async def test_a_new_session_launch_clears_a_pin_without_minting_an_id(
    jp_fetch, jp_serverapp, tmp_path, present, monkeypatch
):
    """A new conversation supersedes the one the user switched to.

    Keying the clear on ``new_session_id`` never fired for an assistant whose
    CLI mints its own id (kimi, codex declare ``mintsNewSessionId: false``), so
    the row stayed pinned to the switch target: the freshly started
    conversation was shadowed, and clicking the row resumed the old one.
    """
    monkeypatch.setitem(
        jp_serverapp.web_app.settings, "terminal_manager", _FakeTerminalManager()
    )
    encoded = "wd-demo"
    pinned = "session_11111111-2222-3333-4444-555555555555"
    state.write_pin("kimi", encoded, pinned)
    assert state.read_pin("kimi", encoded) == pinned

    response = await jp_fetch(
        URL,
        "providers",
        "kimi",
        "launch",
        method="POST",
        body=json.dumps({"project_path": str(tmp_path), "encoded_path": encoded}),
    )
    assert response.code == 200
    assert state.read_pin("kimi", encoded) is None


async def test_resuming_a_conversation_leaves_the_pin_alone(
    jp_fetch, jp_serverapp, tmp_path, present, monkeypatch
):
    """Only a NEW conversation supersedes the switch - a resume is the switch."""
    monkeypatch.setitem(
        jp_serverapp.web_app.settings, "terminal_manager", _FakeTerminalManager()
    )
    encoded = "wd-demo"
    pinned = "session_11111111-2222-3333-4444-555555555555"
    state.write_pin("kimi", encoded, pinned)
    await jp_fetch(
        URL,
        "providers",
        "kimi",
        "launch",
        method="POST",
        body=json.dumps(
            {
                "project_path": str(tmp_path),
                "encoded_path": encoded,
                "session_id": pinned,
            }
        ),
    )
    assert state.read_pin("kimi", encoded) == pinned


async def test_the_argv_route_answers_the_store_argv_and_clears_the_pin(
    jp_fetch, tmp_path, present
):
    """The Launcher tile's launch is the panel's, minus the pty (ACC-LNCH-154).

    ``basic-terminal:launch`` in the sibling extension owns the spawn, so this
    route hands back the store's argv BARE - wrapping it in the terminal-init
    waiter here would run that waiter twice - and still does the pin
    bookkeeping, because a tile click starts a real conversation.
    """
    encoded = "wd-demo"
    pinned = "session_11111111-2222-3333-4444-555555555555"
    state.write_pin("kimi", encoded, pinned)

    response = await jp_fetch(
        URL,
        "providers",
        "kimi",
        "launch-argv",
        method="POST",
        body=json.dumps({"project_path": str(tmp_path), "encoded_path": encoded}),
    )
    assert response.code == 200
    argv = json.loads(response.body)["argv"]
    assert argv == registry.providers()["kimi"].store.launch_argv("/usr/bin/kimi")
    assert state.read_pin("kimi", encoded) is None


async def test_the_argv_route_resumes_without_touching_the_pin(
    jp_fetch, tmp_path, present
):
    """A resume carries the store's own resume verb and is not a new session."""
    encoded = "wd-demo"
    pinned = "session_11111111-2222-3333-4444-555555555555"
    state.write_pin("kimi", encoded, pinned)

    response = await jp_fetch(
        URL,
        "providers",
        "kimi",
        "launch-argv",
        method="POST",
        body=json.dumps(
            {
                "project_path": str(tmp_path),
                "encoded_path": encoded,
                "session_id": pinned,
            }
        ),
    )
    argv = json.loads(response.body)["argv"]
    assert argv == ["/usr/bin/kimi", "-S", pinned]
    assert state.read_pin("kimi", encoded) == pinned


async def test_the_argv_route_pins_a_fork_the_same_way_the_launch_route_does(
    jp_fetch, tmp_path, present
):
    """A fork pins the branch on this route as on the launch route.

    Parity for a route that runs the launch route's validator and accepts its
    full body; the pin bookkeeping is one shared method so the two routes
    cannot drift. On the native-flag provider the argv carries the fork too,
    which is what makes the pinned id the conversation that actually runs.
    No client sends a fork to this route today.
    """
    encoded = "wd-demo"
    parent = "11111111-2222-3333-4444-555555555555"
    fork = "99999999-8888-7777-6666-555555555555"

    response = await jp_fetch(
        URL,
        "providers",
        "claude",
        "launch-argv",
        method="POST",
        body=json.dumps(
            {
                "project_path": str(tmp_path),
                "encoded_path": encoded,
                "session_id": parent,
                "fork_session_id": fork,
            }
        ),
    )
    assert response.code == 200
    argv = json.loads(response.body)["argv"]
    assert argv[1:3] == ["--resume", parent]
    assert argv[argv.index("--fork-session") + 2] == fork
    assert state.read_pin("claude", encoded) == fork


async def test_the_argv_route_refuses_an_undeclared_mode(jp_fetch, tmp_path, present):
    """Same descriptor gate as the launch route - the store is never reached."""
    status, error = await error_of(
        jp_fetch,
        URL,
        "providers",
        "claude",
        "launch-argv",
        method="POST",
        body=json.dumps({"project_path": str(tmp_path), "mode": "notAMode"}),
    )
    assert (status, error) == (400, "mode_unsupported")


async def test_the_argv_route_refuses_a_project_path_that_is_not_a_directory(
    jp_fetch, tmp_path, present
):
    """A folder that does not exist yields no argv - the cwd has to be real."""
    status, error = await error_of(
        jp_fetch,
        URL,
        "providers",
        "claude",
        "launch-argv",
        method="POST",
        body=json.dumps({"project_path": str(tmp_path / "missing")}),
    )
    assert (status, error) == (400, "invalid_project_path")


async def test_the_argv_route_refuses_a_new_id_beside_a_resume(
    jp_fetch, tmp_path, present
):
    """The two ids name opposite intents, so one body may carry only one."""
    status, error = await error_of(
        jp_fetch,
        URL,
        "providers",
        "claude",
        "launch-argv",
        method="POST",
        body=json.dumps(
            {
                "project_path": str(tmp_path),
                "session_id": "11111111-2222-3333-4444-555555555555",
                "new_session_id": "22222222-3333-4444-5555-666666666666",
            }
        ),
    )
    assert (status, error) == (400, "invalid_new_session_id")


async def test_the_argv_route_answers_503_when_the_binary_is_gone(
    jp_fetch, tmp_path, uninstall
):
    """A tile can outlive the binary, and the click must say which one went."""
    uninstall("claude")
    status, error = await error_of(
        jp_fetch,
        URL,
        "providers",
        "claude",
        "launch-argv",
        method="POST",
        body=json.dumps({"project_path": str(tmp_path)}),
    )
    assert (status, error) == (503, "cli_not_found")


async def test_a_switch_writes_the_pin_on_the_route_side(
    jp_fetch, present, monkeypatch
):
    """The stores only touch mtimes on switch - the ROUTE owns the pin.

    Since DEF-101 no store writes a pin (state writes are loop-serialised,
    DEF-99), so the causal link "a switch pins its target" lives on exactly
    one route line - and this test is the only thing that reddens if that
    line is dropped, which would silently snap every switch back to recency
    on the rival's next append.
    """
    encoded = "wd-demo"
    target = "session_11111111-2222-3333-4444-555555555555"
    assert state.read_pin("kimi", encoded) is None
    store = registry.providers()["kimi"].store
    monkeypatch.setattr(
        store,
        "switch",
        # The store answers `current` from the pin as it stood BEFORE the
        # route pins - the steady state of an already-switched project - which
        # is exactly the answer the route must not repeat (DEF-102); and since
        # DEF-103 the stores return no `current` at all, so this deliberately
        # nonconforming key proves the route overwrites whatever it is handed.
        lambda encoded_path, session_id: {
            "requested": session_id,
            "current": "the-stale-pre-pin-answer",
        },
    )
    monkeypatch.setattr(
        store,
        "resolve_current",
        lambda encoded_path: state.read_pin("kimi", encoded_path),
    )
    response = await jp_fetch(
        URL,
        "providers",
        "kimi",
        "switch",
        method="POST",
        body=json.dumps({"encoded_path": encoded, "session_id": target}),
    )
    assert response.code == 200
    assert state.read_pin("kimi", encoded) == target
    # The response's `current` is re-resolved AFTER the pin lands, so a
    # pinned project's second switch no longer answers the old pin and the
    # panel no longer toasts a failure for a switch that succeeded (DEF-102).
    assert json.loads(response.body)["current"] == target


def test_the_shallowest_assistant_in_the_tree_wins(monkeypatch):
    """A terminal running one assistant that spawned another is the FIRST's.

    ``_tree_assistant`` asks every enabled provider about every pid, breadth
    first, and the shallowest match is the answer. That is the whole reason
    the candidate list is not narrowed to the provider that called: a claude
    terminal that spawned ``codex`` as a tool must answer "not yours" to the
    codex panel, or that panel reuses a terminal it does not own - which then
    resumes someone else's conversation on the next click.
    """
    tree = {10: [20], 20: []}
    monkeypatch.setattr(routes, "_process_children", lambda pid: tree.get(pid, []))

    claude = registry.get("claude")
    codex = registry.get("codex")
    monkeypatch.setattr(
        type(claude.store), "owns_pid", lambda self, pid: pid == 10
    )
    monkeypatch.setattr(type(codex.store), "owns_pid", lambda self, pid: pid == 20)
    monkeypatch.setattr(
        type(claude.store), "session_id_for_pid", lambda self, pid: "outer"
    )
    monkeypatch.setattr(registry.Provider, "cli_path", lambda self: "/usr/bin/x")

    found, session_id = routes._tree_assistant(10)
    assert found is not None and found.id == "claude"
    assert session_id == "outer"
