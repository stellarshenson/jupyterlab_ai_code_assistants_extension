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
async def test_codex_new_launch_carries_native_id(jp_fetch, present, tmp_path, monkeypatch, route):
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
    from jupyterlab_ai_code_assistants_extension.core.routes import LaunchHandler
    def create(**kwargs):
        spawned.append(kwargs)
        return type("Terminal", (), {"name": "native-id-terminal"})()
    monkeypatch.setattr(LaunchHandler, "terminal_manager", property(lambda _: type(
        "Manager", (), {"create": staticmethod(create)})()))
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
