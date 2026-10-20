"""Native branch metadata is finished before a terminal can resume the child."""
import json
import subprocess
import contextlib

import pytest

from jupyterlab_ai_code_assistants_extension.core import colour_store, registry, state
from jupyterlab_ai_code_assistants_extension.providers import claude, codex
from .test_routes import URL, present


def test_codex_fork_names_the_exact_child_without_starting_a_turn(monkeypatch):
    store = registry.get("codex").store
    parent = "44444444-4444-4444-8444-444444444444"
    child = "55555555-5555-4555-8555-555555555555"
    monkeypatch.setattr(store, "_project_threads", lambda _: [{"id": parent}])
    monkeypatch.setattr(codex.shutil, "which", lambda _: "/bin/codex")
    calls = []

    @contextlib.contextmanager
    def server(cli):
        assert cli == "/bin/codex"
        def request(method, params):
            calls.append((method, params))
            return {"thread": {"id": child}} if method == "thread/fork" else {}
        yield request

    monkeypatch.setattr(codex, "_app_server", server)
    assert store.fork("/project", parent, "analysis_1") == child
    assert calls == [
        ("thread/fork", {"threadId": parent, "excludeTurns": True,
                         "deferGoalContinuation": True}),
        ("thread/name/set", {"threadId": child, "name": "analysis_1"}),
    ]
    assert store.fork("/project", child, "unrelated") is None
    assert len(calls) == 2


@pytest.mark.parametrize("override,expected", [(None, "blue"), ("lavender", "purple")])
def test_claude_branch_uses_native_commands(scratch_stores, tmp_path, monkeypatch, override, expected):
    store = registry.get("claude").store
    parent = "44444444-4444-4444-8444-444444444444"
    child = "55555555-5555-4555-8555-555555555555"
    project = tmp_path / "project"
    project.mkdir()
    encoded = claude._encode_path(str(project))
    folder = scratch_stores / "claude" / "projects" / encoded
    folder.mkdir(parents=True)
    transcript = folder / f"{parent}.jsonl"
    original = json.dumps({"type": "user", "cwd": str(project)}) + "\n"
    original += json.dumps({"type": "agent-color", "agentColor": "blue"}) + "\n"
    transcript.write_text(original)
    if override:
        colour_store.set_colour("claude", parent, override)
    monkeypatch.setattr(claude.shutil, "which", lambda _: "/bin/claude")
    monkeypatch.setattr(claude.uuid, "uuid4", lambda: child)
    calls = []

    def run(argv, **kwargs):
        calls.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, 0)

    monkeypatch.setattr(claude.subprocess, "run", run)
    assert store.fork(encoded, parent, "analysis_1") == child
    assert [call[0] for call in calls] == [
        ["/bin/claude", "-p", "--resume", parent, "--fork-session",
         "--session-id", child, "/rename analysis_1"],
        ["/bin/claude", "-p", "--resume", child, f"/color {expected}"],
    ]
    assert all(call[1]["cwd"] == str(project) for call in calls)
    assert all(call[1]["stdin"] == subprocess.DEVNULL for call in calls)
    assert transcript.read_text() == original


def test_claude_branch_runs_in_the_project_when_the_last_turn_ran_in_a_subfolder(
    scratch_stores, tmp_path, monkeypatch
):
    """DEF-PROV-335: the CLI resolves the parent from its cwd's encoded store,
    so the fork runs in the project the directory encodes, not in the
    subfolder the parent's last record names."""
    store = registry.get("claude").store
    parent = "44444444-4444-4444-8444-444444444444"
    child = "55555555-5555-4555-8555-555555555555"
    project = tmp_path / "project"
    (project / "sub").mkdir(parents=True)
    encoded = claude._encode_path(str(project))
    folder = scratch_stores / "claude" / "projects" / encoded
    folder.mkdir(parents=True)
    (folder / f"{parent}.jsonl").write_text(
        json.dumps({"type": "user", "cwd": str(project)}) + "\n"
        + json.dumps({"type": "assistant", "cwd": str(project / "sub")}) + "\n"
    )
    monkeypatch.setattr(claude.shutil, "which", lambda _: "/bin/claude")
    monkeypatch.setattr(claude.uuid, "uuid4", lambda: child)
    calls = []

    def run(argv, **kwargs):
        calls.append(kwargs["cwd"])
        return subprocess.CompletedProcess(argv, 0)

    monkeypatch.setattr(claude.subprocess, "run", run)
    assert store.fork(encoded, parent, "analysis_1") == child
    assert calls == [str(project), str(project)]


async def test_branch_names_skip_used_suffixes(jp_fetch, present, monkeypatch):
    provider = registry.get("kimi")
    made = []
    monkeypatch.setattr(provider.store, "list_branches", lambda *_: {
        "current": "parent", "total": 3,
        "branches": [{"label": "analysis_1"}, {"label": "analysis_3"}] +
                    [{"label": name} for name in made],
    })
    monkeypatch.setattr(provider.store, "list_sessions", lambda *_: [
        {"encoded_path": "project", "name": "analysis"}
    ])

    def fork(encoded, parent, name):
        made.append(name)
        return f"child-{len(made)}"

    monkeypatch.setattr(provider.store, "fork", fork)
    for _ in range(2):
        response = await jp_fetch(URL, "providers", "kimi", "branch", method="POST",
                                  body=json.dumps({"encoded_path": "project",
                                                   "session_id": "parent",
                                                   "base_name": "analysis"}))
        assert response.code == 200
    assert made == ["analysis_2", "analysis_4"]
    assert state.read_pin("kimi", "project") == "child-2"


async def test_native_branch_does_not_mask_native_colour(jp_fetch, present, monkeypatch):
    provider = registry.get("claude")
    monkeypatch.setattr(provider.store, "fork", lambda *_: "child")
    released = []
    monkeypatch.setattr(provider.store, "release_switch", released.append)
    colour_store.set_colour("claude", "parent", "sky")
    response = await jp_fetch(URL, "providers", "claude", "branch", method="POST",
                              body=json.dumps({"encoded_path": "project",
                                               "session_id": "parent", "name": "analysis_1"}))
    assert json.loads(response.body)["session_id"] == "child"
    assert "child" not in colour_store.load_colours("claude")
    assert released == ["project"]
    assert state.read_pin("claude", "project") == "child"


@pytest.mark.parametrize("route", ["launch", "launch-argv"])
async def test_codex_new_launch_carries_native_id(
    jp_fetch, jp_serverapp, present, tmp_path, monkeypatch, route
):
    """Panel and Launcher new sessions retain identity in their running argv."""
    child = "55555555-5555-4555-8555-555555555555"
    calls = []

    @contextlib.contextmanager
    def server(cli):
        def request(method, params):
            calls.append((method, params))
            return {"thread": {"id": child}}
        yield request

    monkeypatch.setattr(codex, "_app_server", server)
    spawned = []

    def create(**kwargs):
        spawned.append(kwargs)
        return type("Terminal", (), {"name": "native-id-terminal"})()

    # The launch route resolves its manager through ``self.settings``; a fake
    # hung on the handler class is never read, so the spawn landed in the real
    # terminado manager. Patch the settings entry the route actually reads.
    monkeypatch.setitem(
        jp_serverapp.web_app.settings,
        "terminal_manager",
        type("Manager", (), {"create": staticmethod(create)})(),
    )
    response = await jp_fetch(URL, "providers", "codex", route, method="POST",
                              body=json.dumps({"project_path": str(tmp_path)}))
    assert response.code == 200
    assert calls == [("thread/start", {"cwd": str(tmp_path), "ephemeral": False})]
    if route == "launch-argv":
        argv = json.loads(response.body)["argv"]
        assert argv == ["/usr/bin/codex", "resume", child]
        assert registry.get("codex").store.parse_session_id(
            b"\x00".join(arg.encode() for arg in argv)) == child
    else:
        assert spawned and child in str(spawned[0])


def test_codex_new_launch_failure_never_opens_an_unidentifiable_session(monkeypatch):
    @contextlib.contextmanager
    def server(cli):
        def request(method, params):
            raise RuntimeError("native API unavailable")
        yield request
    monkeypatch.setattr(codex, "_app_server", server)
    assert registry.get("codex").store.launch_argv("/bin/codex", project_path="/project") == []


def test_claude_branch_does_not_copy_a_pick_the_parents_color_overtook(
    scratch_stores, tmp_path, monkeypatch
):
    """The branch is born with the colour its parent SHOWS. A pick older than
    the parent's own ``/color`` is stale; copying it would run it as the
    branch's ``/color`` and make it the branch's newest choice for good."""
    store = registry.get("claude").store
    parent = "44444444-4444-4444-8444-444444444444"
    child = "55555555-5555-4555-8555-555555555555"
    project = tmp_path / "project"
    project.mkdir()
    encoded = claude._encode_path(str(project))
    folder = scratch_stores / "claude" / "projects" / encoded
    folder.mkdir(parents=True)
    # An untimed pick - written before times were recorded - and a ``/color
    # blue`` the parent ran, which is newer than any untimed entry.
    (scratch_stores / "state").mkdir(parents=True, exist_ok=True)
    (scratch_stores / "state" / "claude-colours.json").write_text(
        json.dumps({"colours": {parent: "lavender"}, "overrides": [parent]})
    )
    (folder / f"{parent}.jsonl").write_text(
        json.dumps({"type": "user", "cwd": str(project)}) + "\n"
        + json.dumps({"type": "agent-color", "agentColor": "blue"}) + "\n"
        + json.dumps({
            "type": "system", "subtype": "local_command", "uuid": "cmd-1",
            "timestamp": "2026-10-01T10:00:00.000Z",
            "content": "<command-name>/color</command-name>\n"
                       "<command-args>blue</command-args>",
        }) + "\n"
        + json.dumps({
            "type": "system", "subtype": "local_command", "parentUuid": "cmd-1",
            "timestamp": "2026-10-01T10:00:00.000Z",
            "content": "<local-command-stdout>Session color set to: blue"
                       "</local-command-stdout>",
        }) + "\n"
    )
    monkeypatch.setattr(claude.shutil, "which", lambda _: "/bin/claude")
    monkeypatch.setattr(claude.uuid, "uuid4", lambda: child)
    calls = []
    monkeypatch.setattr(
        claude.subprocess, "run",
        lambda argv, **kwargs: calls.append(argv) or subprocess.CompletedProcess(argv, 0),
    )
    assert store.fork(encoded, parent, "analysis_1") == child
    assert calls[-1] == ["/bin/claude", "-p", "--resume", child, "/color blue"]
