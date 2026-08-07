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


async def test_a_native_colour_provider_refuses_a_write(jp_fetch, present):
    """The assistant owns its colour, so a shadow value is refused, not kept."""
    status, error = await error_of(
        jp_fetch,
        URL,
        "providers",
        "claude",
        "colours",
        method="POST",
        body=json.dumps({"session_id": "abc", "colour": "mint"}),
    )
    assert (status, error) == (400, "colour_owned_by_assistant")


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
    """Records what a launch asked for instead of spawning a pty."""

    def __init__(self) -> None:
        self.created: list[dict] = []

    def create(self, shell_command=None, cwd=None):
        self.created.append({"shell_command": shell_command, "cwd": cwd})
        return {"name": "term-1"}


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
