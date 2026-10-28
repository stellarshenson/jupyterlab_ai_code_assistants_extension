"""The server side of the session command: the push, the pooled status
check, the refresh route, the live-session refusals and move.

Every test runs a live jupyter_server over scratch stores (``conftest``); a
running process is supplied by patching the ``/proc`` walk, never read from
the machine.
"""
from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import hashlib
import json
import os
import sqlite3
import subprocess
import threading
import time
from pathlib import Path

import pytest
import tornado
import zstandard

from jupyterlab_ai_code_assistants_extension.core import colour_store, registry, routes, state
from jupyterlab_ai_code_assistants_extension.providers import claude as claude_provider
from jupyterlab_ai_code_assistants_extension.providers import codex as codex_provider
from jupyterlab_ai_code_assistants_extension.providers import deepseek as deepseek_provider
from jupyterlab_ai_code_assistants_extension.providers import kimi as kimi_provider

from .conftest import (
    CLAUDE_ENCODED,
    DEEPSEEK_ENCODED,
    PROJECT_PATH,
    new_uuid,
    write_claude_tree,
    write_codex_db,
    write_deepseek_tree,
    write_gemini_tree,
    write_kimi_tree,
)
from .test_routes import URL, _FakeTerminalManager, error_of, present  # noqa: F401

LIVE_PID = 4242


class _Store:
    """A store that says yes to every change, for the push tests."""

    provider_id = "claude"

    def switch(self, encoded_path, session_id):
        return {"requested": session_id}

    def project_session_ids(self, encoded_path):
        return ["sid-a", "sid-b"]

    def resolve_current(self, encoded_path):
        return "sid-a"

    def rename(self, encoded_path, session_id, name):
        return name

    def delete_branches(self, encoded_path, session_ids, to_trash=False):
        return list(session_ids)

    def fork(self, encoded_path, session_id, name=None):
        return "sid-new"

    def release_switch(self, encoded_path):
        pass

    def list_sessions(self, root_dir=None):
        return [{"encoded_path": "enc", "project_path": "/nowhere/source", "session_id": "sid-a"}]

    def move(self, encoded_path, session_id, target_path, to_trash=False):
        return session_id, "enc-target"

    def default_colour(self, session_id):
        return None

    def colour_choice_ms(self, session_id):
        return None

    def launch_argv(self, cli_path, **_kwargs):
        return ["/bin/true"]

    def owns_pid(self, pid):
        return False

    def session_id_for_pid(self, pid):
        return None


@pytest.fixture
def fake_claude(monkeypatch, present):  # noqa: F811
    monkeypatch.setattr(registry.get("claude"), "store", _Store())


async def next_message(ws, timeout: float = 5.0) -> dict:
    return json.loads(await asyncio.wait_for(ws.read_message(), timeout))


async def fetch(jp_fetch, *path, method="GET", body=None):
    kwargs = {"method": method}
    if body is not None:
        kwargs["body"] = json.dumps(body)
    if method == "DELETE":
        kwargs["allow_nonstandard_methods"] = True
    return await jp_fetch(URL, *path, **kwargs)


# ------------------------------------------------------------------ the push

#: Every route that changes a provider's sessions, as ``(verb, path, body)``
#: under ``providers/claude/``.
CHANGING_ROUTES = [
    ("POST", "switch", {"encoded_path": "enc", "session_id": "sid-b"}),
    ("POST", "favourite", {"project_path": "/nowhere/source", "favourite": True}),
    ("POST", "branch", {"encoded_path": "enc", "session_id": "sid-a", "name": "n"}),
    ("POST", "rename", {"encoded_path": "enc", "session_id": "sid-a", "name": "n"}),
    ("DELETE", "sessions", {"encoded_path": "enc", "session_ids": ["sid-b"]}),
    ("POST", "move", {"encoded_path": "enc", "session_id": "sid-a", "target_path": "/tmp"}),
    ("POST", "launch", {"project_path": "/tmp"}),
    ("POST", "launch-argv", {"project_path": "/tmp"}),
]


@pytest.mark.parametrize("verb,path,body", CHANGING_ROUTES, ids=[r[1] + "-" + r[0] for r in CHANGING_ROUTES])
async def test_every_changing_route_pushes_sessions_changed(
    jp_fetch, jp_ws_fetch, jp_serverapp, fake_claude, monkeypatch, verb, path, body
):
    """A change made through REST - by a panel or by the command - reaches
    every open window as one ``sessions-changed`` naming the assistant
    (ACC-CLI-227)."""
    monkeypatch.setitem(
        jp_serverapp.web_app.settings, "terminal_manager", _FakeTerminalManager()
    )
    ws = await jp_ws_fetch(URL, "events")
    response = await fetch(jp_fetch, "providers", "claude", path, method=verb, body=body)
    assert response.code == 200
    assert await next_message(ws) == {"type": "sessions-changed", "provider": "claude"}
    ws.close()


async def test_a_push_names_the_window_that_made_the_change(jp_fetch, jp_ws_fetch, fake_claude):
    """A JupyterLab window names itself on every request, and the push of its
    change names it back, so that window skips the push its own write caused
    (DEF-PANE-370-OWN-PUSH). A request naming no window - the command line's -
    pushes no ``window``: the test above compares the whole message."""
    ws = await jp_ws_fetch(URL, "events")
    await jp_fetch(
        URL, "providers", "claude", "favourite", method="POST",
        body=json.dumps({"project_path": "/nowhere/source", "favourite": True}),
        headers={routes.WINDOW_HEADER: "window-a"},
    )
    assert await next_message(ws) == {
        "type": "sessions-changed", "provider": "claude", "window": "window-a"
    }
    ws.close()


SILENT_REQUESTS = [
    ("GET", "sessions", None, 200),
    ("POST", "colours", {"session_id": "sid-a", "colour": "sky"}, 200),
    ("POST", "rename", {"encoded_path": "enc", "session_id": "sid-a", "name": " "}, 400),
]


@pytest.mark.parametrize(
    "verb,path,body,code", SILENT_REQUESTS, ids=["read", "colour-write", "refused"]
)
async def test_reads_colour_writes_and_refusals_push_nothing(
    jp_fetch, jp_ws_fetch, fake_claude, verb, path, body, code
):
    """Only a change pushes. A colour write does not: every window writes tab
    colours back, and a push per write would make every other window re-read
    its sessions on each one. A Kimi favourite follows as the marker - the
    first message must be its push, so the request before it pushed nothing."""
    ws = await jp_ws_fetch(URL, "events")
    try:
        answered = (await fetch(jp_fetch, "providers", "claude", path, method=verb, body=body)).code
    except tornado.httpclient.HTTPClientError as err:
        answered = err.code
    assert answered == code
    await fetch(
        jp_fetch, "providers", "kimi", "favourite", method="POST",
        body={"project_path": "/nowhere", "favourite": True},
    )
    assert await next_message(ws) == {"type": "sessions-changed", "provider": "kimi"}
    ws.close()


# --------------------------------------------------------- the pooled check


@pytest.fixture
def probes(monkeypatch):
    """Count roster probes; each takes long enough for requests to overlap."""
    calls: list[float] = []

    def roster():
        calls.append(time.monotonic())
        time.sleep(0.2)
        return [{"id": "x", "label": "X", "enabled": True, "cli_path": None, "available": False}]

    monkeypatch.setattr(routes, "_roster", roster)
    return calls


async def test_concurrent_status_requests_share_one_probe(jp_fetch, probes):
    """Windows waking together ask together; one probe answers all of them
    (ACC-PROV-231)."""
    answers = await asyncio.gather(*(jp_fetch(URL, "status") for _ in range(5)))
    assert all(a.code == 200 for a in answers)
    assert len(probes) == 1


async def test_a_status_request_inside_the_window_reuses_the_roster(jp_fetch, probes):
    """Single-flight alone rarely overlaps: a probe takes milliseconds, so a
    request a moment after another reuses its roster."""
    await jp_fetch(URL, "status")
    await jp_fetch(URL, "status")
    assert len(probes) == 1


async def test_refresh_probes_again_inside_the_window(jp_fetch, probes):
    """The command's refresh runs after a CLI was installed: a roster from
    before it must not answer it."""
    await jp_fetch(URL, "status")
    await jp_fetch(URL, "refresh", method="POST", body=b"")
    assert len(probes) == 2


async def test_refresh_never_answers_with_a_probe_begun_before_it(jp_fetch, monkeypatch):
    """A probe already in flight when refresh arrives is waited out, not
    joined: it may have stat-ed PATH before the binary landed."""
    release = threading.Event()
    calls: list[int] = []

    def roster():
        calls.append(len(calls))
        if len(calls) == 1:
            release.wait(5)
        return [{"id": f"probe-{len(calls)}", "label": "X", "enabled": True,
                 "cli_path": None, "available": False}]

    monkeypatch.setattr(routes, "_roster", roster)
    status = asyncio.ensure_future(jp_fetch(URL, "status"))
    while not calls:
        await asyncio.sleep(0.01)
    refresh = asyncio.ensure_future(jp_fetch(URL, "refresh", method="POST", body=b""))
    await asyncio.sleep(0.2)
    release.set()
    assert json.loads((await status).body)["providers"][0]["id"] == "probe-1"
    assert json.loads((await refresh).body)["providers"][0]["id"] == "probe-2"


# ---------------------------------------------------------- the refresh route


async def test_refresh_pushes_the_status_to_every_window(jp_fetch, jp_ws_fetch):
    """Every open window gets the roster in the push itself, and the answer
    says how many windows it reached (ACC-CLI-228)."""
    first = await jp_ws_fetch(URL, "events")
    second = await jp_ws_fetch(URL, "events")
    response = await jp_fetch(URL, "refresh", method="POST", body=b"")
    answer = json.loads(response.body)
    assert answer["windows"] == 2
    assert {p["id"] for p in answer["providers"]} == set(registry.providers())
    for ws in (first, second):
        message = await next_message(ws)
        assert message["type"] == "refresh"
        assert message["status"]["providers"] == answer["providers"]
        assert set(message["status"]) == {"root_dir", "providers", "delete_to_trash"}
        ws.close()


# ------------------------------------------------- live sessions: delete

PROVIDERS = ["claude", "codex", "deepseek", "gemini", "kimi"]


@pytest.fixture
def running(monkeypatch):
    """Make one process look like the given provider's assistant on a
    conversation, in a folder."""

    def _running(provider_id: str, session_id: str | None, cwd: str = "/nowhere") -> None:
        store = registry.get(provider_id).store
        monkeypatch.setattr(routes, "_proc_pids", lambda: [LIVE_PID])
        monkeypatch.setattr(routes, "_process_cwd_link", lambda pid: cwd)
        monkeypatch.setattr(store, "owns_pid", lambda pid: pid == LIVE_PID)
        monkeypatch.setattr(store, "session_id_for_pid", lambda pid: session_id)

    return _running


@pytest.mark.parametrize("provider_id", PROVIDERS)
async def test_a_delete_keeps_a_conversation_a_running_process_is_on(
    jp_fetch, present, running, monkeypatch, provider_id  # noqa: F811
):
    """For every assistant and every caller, a live conversation is kept and
    named in ``live_ids``; the rest of the selection goes (ACC-SESS-57)."""
    asked: list[list] = []
    store = registry.get(provider_id).store
    monkeypatch.setattr(
        store, "delete_branches",
        lambda encoded_path, ids, to_trash=False: asked.append(ids) or list(ids),
    )
    running(provider_id, "sid-live")
    response = await fetch(
        jp_fetch, "providers", provider_id, "sessions", method="DELETE",
        body={"encoded_path": "enc", "session_ids": ["sid-live", "sid-idle"]},
    )
    answer = json.loads(response.body)
    assert asked == [["sid-idle"]]
    assert answer["removed_ids"] == ["sid-idle"]
    assert answer["live_ids"] == ["sid-live"]


async def test_a_delete_of_only_live_conversations_asks_no_store(
    jp_fetch, present, running, monkeypatch  # noqa: F811
):
    """Nothing to delete is a success that removed nothing: the stores refuse
    an empty list, which would read as a failed delete."""
    store = registry.get("kimi").store
    monkeypatch.setattr(
        store, "delete_branches",
        lambda *a, **k: pytest.fail("the store was asked to delete"),
    )
    running("kimi", "sid-live")
    response = await fetch(
        jp_fetch, "providers", "kimi", "sessions", method="DELETE",
        body={"encoded_path": "enc", "session_ids": ["sid-live"]},
    )
    assert json.loads(response.body) == {
        "removed_count": 0, "removed_ids": [], "live_ids": ["sid-live"],
    }


# --------------------------------------------------------------- move: route


def move_body(encoded_path, session_id, target) -> dict:
    return {"encoded_path": encoded_path, "session_id": session_id, "target_path": str(target)}


async def sessions_of(jp_fetch, provider_id) -> list[dict]:
    response = await jp_fetch(URL, "providers", provider_id, "sessions")
    return json.loads(response.body)["sessions"]


async def move(jp_fetch, provider_id, body) -> dict:
    response = await fetch(jp_fetch, "providers", provider_id, "move", method="POST", body=body)
    return json.loads(response.body)


def ids_under(rows, project_path) -> set[str]:
    return {r["session_id"] for r in rows if r["project_path"] == project_path}


async def test_claude_move_lists_under_the_target_only(
    jp_fetch, present, scratch_stores, tmp_path  # noqa: F811
):
    root = scratch_stores / "claude"
    moved, stays = new_uuid(), new_uuid()
    write_claude_tree(root, [{"id": stays, "turns": 1}, {"id": moved, "turns": 1}])
    os.utime(root / "projects" / CLAUDE_ENCODED / f"{stays}.jsonl", (1, 1))
    side = root / "projects" / CLAUDE_ENCODED / moved / "subagents"
    side.mkdir(parents=True)
    target = tmp_path / "my_target.dir"
    target.mkdir()

    answer = await move(jp_fetch, "claude", move_body(CLAUDE_ENCODED, moved, target))

    target_encoded = claude_provider._encode_path(str(target))
    assert answer == {"session_id": moved, "encoded_path": target_encoded, "project_path": str(target)}
    rows = await sessions_of(jp_fetch, "claude")
    assert ids_under(rows, str(target)) == {moved}
    assert ids_under(rows, PROJECT_PATH) == {stays}
    assert not (root / "projects" / CLAUDE_ENCODED / f"{moved}.jsonl").exists()
    assert not (root / "projects" / CLAUDE_ENCODED / moved).exists()
    assert (root / "projects" / target_encoded / moved / "subagents").is_dir()
    # The tail cwd is what `claude --resume` and the store's own row read.
    tail = (root / "projects" / target_encoded / f"{moved}.jsonl").read_text().splitlines()[-1]
    assert json.loads(tail) == {"cwd": str(target)}
    # The moved conversation is the target's current one, as a fork is.
    assert state.read_pin("claude", target_encoded) == moved


# Claude Code 2.1.312's project directory name SL and its hash $me (from
# chunk-r1z6gbpf.js), copied verbatim from the binary, so a test cannot pass
# by agreeing with the store.
CLAUDE_CODE_SL = (
    "function $me(t){let e=0;for(let n=0;n<t.length;n++)e=(e<<5)-e+t.charCodeAt(n)|0;return e}\n"
    'var tve=200;function Pe(e){return Math.abs($me(e)).toString(36)}function k(e){return e.replace(/[^a-zA-Z0-9]/g,"-")}function SL(e){let n=k(e);if(n.length<=tve)return n;return`${n.slice(0,tve)}-${Pe(e)}`}\n'
    "console.log(SL(process.argv[1]))"
)


def claude_code_key(path: str) -> str:
    """The project directory Claude Code itself reads for ``path``."""
    return subprocess.run(
        ["node", "-e", CLAUDE_CODE_SL, path], capture_output=True, text=True, check=True
    ).stdout.strip()


@pytest.mark.parametrize(
    "path",
    [
        "/home/lab/project",
        "/home/lab/my project",
        "/home/lab/@my utils",
        "/home/lab/zażółć gęślą jaźń",
        "/home/lab/项目 文件",
        "/home/lab/notes \U0001F4C1",
        "/" + "a" * 199,
        "/" + "a" * 200,
        "/home/lab/" + "x" * 189 + "\U0001F4C1",
    ],
    ids=["ascii", "space", "at", "accented", "cjk", "emoji", "200", "201", "201-units-200-points"],
)
def test_the_claude_project_key_is_claude_code_s_own(path):
    assert claude_provider._encode_path(path) == claude_code_key(path)


@pytest.mark.parametrize(
    "name", ["@my utils", "notes \U0001F4C1", "x" * 200], ids=["at-space", "emoji", "over-200"]
)
async def test_claude_move_files_the_transcript_where_claude_code_looks(
    jp_fetch, present, scratch_stores, tmp_path, name  # noqa: F811
):
    """A move lands in the directory Claude Code names for the target folder,
    beside that folder's own conversations: every UTF-16 code unit outside
    ``[a-zA-Z0-9]`` is ``-``, and a name over 200 characters is cut and hashed."""
    root = scratch_stores / "claude"
    moved, there = new_uuid(), new_uuid()
    write_claude_tree(root, [{"id": moved, "turns": 1}])
    target = tmp_path / name
    target.mkdir()
    key = claude_code_key(str(target))
    (root / "projects" / key).mkdir(parents=True)
    (root / "projects" / key / f"{there}.jsonl").write_text(
        json.dumps({"type": "user", "cwd": str(target)}) + "\n"
        + json.dumps({"type": "assistant", "cwd": str(target)}) + "\n"
    )

    await move(jp_fetch, "claude", move_body(CLAUDE_ENCODED, moved, target))

    assert (root / "projects" / key / f"{moved}.jsonl").is_file()
    assert set(registry.get("claude").store.project_session_ids(key)) == {moved, there}
    rows = await sessions_of(jp_fetch, "claude")
    assert [r["project_path"] for r in rows].count(str(target)) == 1


@pytest.mark.parametrize("name", ["notes \U0001F4C1", "x" * 200], ids=["emoji", "over-200"])
def test_a_claude_project_is_its_folder_when_the_last_turn_ran_in_a_subfolder(
    scratch_stores, tmp_path, name
):
    """The listing finds the project above a subfolder cwd by Claude Code's
    key, also where that key is longer or shorter than the path."""
    project = tmp_path / name
    (project / "sub").mkdir(parents=True)
    key = claude_code_key(str(project))
    folder = scratch_stores / "claude" / "projects" / key
    folder.mkdir(parents=True)
    (folder / f"{new_uuid()}.jsonl").write_text(
        json.dumps({"type": "user", "cwd": str(project)}) + "\n"
        + json.dumps({"type": "assistant", "cwd": str(project / "sub")}) + "\n"
    )

    rows = registry.get("claude").store.list_sessions()

    assert [r["project_path"] for r in rows if r["encoded_path"] == key] == [str(project)]


async def test_kimi_move_lists_under_the_target_only(
    jp_fetch, present, scratch_stores, tmp_path  # noqa: F811
):
    root = scratch_stores / "kimi"
    moved, stays = f"session_{new_uuid()}", f"session_{new_uuid()}"
    wd = write_kimi_tree(root, "wd_demo_000000000000", [{"id": stays}, {"id": moved}])
    old_dir = wd / moved
    state_file = old_dir / "state.json"
    data = json.loads(state_file.read_text())
    data["agents"] = {"main": {"homedir": str(old_dir / "agents" / "main")}}
    state_file.write_text(json.dumps(data))
    os.utime(state_file, (1000, 1000))
    target = tmp_path / "Kimi Target"
    target.mkdir()

    answer = await move(jp_fetch, "kimi", move_body("wd_demo_000000000000", moved, target))

    key = kimi_provider.work_dir_key(str(target))
    assert key.startswith("wd_kimi-target_")
    assert answer == {"session_id": moved, "encoded_path": key, "project_path": str(target)}
    rows = await sessions_of(jp_fetch, "kimi")
    assert ids_under(rows, str(target)) == {moved}
    assert ids_under(rows, PROJECT_PATH) == {stays}
    assert not old_dir.exists()
    new_dir = root / "sessions" / key / moved
    moved_state = json.loads((new_dir / "state.json").read_text())
    assert moved_state["workDir"] == str(target)
    assert moved_state["agents"]["main"]["homedir"] == str(new_dir / "agents" / "main")
    index = [json.loads(line) for line in (root / "session_index.jsonl").read_text().splitlines()]
    assert {"sessionId": moved, "sessionDir": str(new_dir), "workDir": str(target)} in index
    registry_file = json.loads((root / "workspaces.json").read_text())
    assert registry_file["workspaces"][key]["root"] == str(target)


def test_kimi_work_dir_key_is_the_cli_s_own():
    """Read off a real registry entry the CLI wrote."""
    assert kimi_provider.work_dir_key("/home/lab/workspace/test") == "wd_test_7a1e2234555b"


async def test_gemini_move_lists_under_the_target_only(
    jp_fetch, present, tmp_path  # noqa: F811
):
    # The server fixture points HOME at its own scratch home, after ours.
    root = Path.home() / ".gemini"
    assert "pytest" in str(root)
    moved, stays = new_uuid(), new_uuid()
    chats = write_gemini_tree(root, "demo", [{"id": stays}, {"id": moved}])
    (chats / moved).mkdir()  # the conversation's subagent transcripts
    target = tmp_path / "target"
    target.mkdir()
    # Another project owns the plain slug, so the move claims the next one.
    (root / "tmp" / "target").mkdir(parents=True)
    (root / "tmp" / "target" / ".project_root").write_text("/elsewhere/target")

    answer = await move(jp_fetch, "gemini", move_body("demo", moved, target))

    assert answer == {"session_id": moved, "encoded_path": "target-1", "project_path": str(target)}
    rows = await sessions_of(jp_fetch, "gemini")
    assert ids_under(rows, str(target)) == {moved}
    assert ids_under(rows, PROJECT_PATH) == {stays}
    assert not any(moved[:8] in p.name for p in chats.iterdir())
    new_chats = root / "tmp" / "target-1" / "chats"
    assert (new_chats / moved).is_dir()
    assert (root / "history" / "target-1" / ".project_root").read_text() == str(target)
    (chat,) = [p for p in new_chats.iterdir() if p.is_file()]
    head = json.loads(chat.read_text().splitlines()[0])
    assert head["projectHash"] == hashlib.sha256(str(target).encode()).hexdigest()


async def test_deepseek_move_lists_under_the_target_only(
    jp_fetch, present, scratch_stores, tmp_path  # noqa: F811
):
    root = scratch_stores / "dsh"
    moved = f"session-{new_uuid()}"
    stays = f"session-{new_uuid()}"
    write_deepseek_tree(root, [{"id": stays}, {"id": moved, "messages": 2}])
    target = tmp_path / "target"
    target.mkdir()

    answer = await move(jp_fetch, "deepseek", move_body(DEEPSEEK_ENCODED, moved, target))

    key = "--" + str(target).lstrip("/").replace("/", "-") + "--"
    assert answer == {"session_id": moved, "encoded_path": key, "project_path": str(target)}
    rows = await sessions_of(jp_fetch, "deepseek")
    assert ids_under(rows, str(target)) == {moved}
    assert ids_under(rows, PROJECT_PATH) == {stays}
    assert not (root / "sessions" / DEEPSEEK_ENCODED / moved).exists()
    log = deepseek_provider.log_file(root / "sessions" / key / moved)
    header = json.loads(deepseek_provider.read_log(log).split("\n")[0])
    assert header["cwd"] == str(target)
    # The harness's layout: the header alone in the first frame.
    first = zstandard.ZstdDecompressor().decompressobj().decompress(log.read_bytes())
    assert first.decode().count("\n") == 1


def test_deepseek_refuses_a_key_it_cannot_write(scratch_stores, tmp_path):
    """The harness escapes other characters as ``~XXXX``, which cannot be
    confirmed here; a guessed key would file the conversation where the
    harness never looks."""
    root = scratch_stores / "dsh"
    moved = f"session-{new_uuid()}"
    write_deepseek_tree(root, [{"id": moved}])
    target = tmp_path / "with space"
    target.mkdir()
    store = registry.get("deepseek").store
    with pytest.raises(routes.MoveRefused):
        store.move(DEEPSEEK_ENCODED, moved, str(target))
    assert (root / "sessions" / DEEPSEEK_ENCODED / moved).is_dir()


@pytest.mark.parametrize("trash", [True, False])
async def test_codex_move_forks_into_the_target_and_retires_the_source(
    jp_fetch, jp_serverapp, present, scratch_stores, tmp_path, monkeypatch, trash  # noqa: F811
):
    """Codex has no way to change a thread's folder, so the move forks it
    there through the app-server and archives the source; the id changes and
    the answer carries the new one (owner ruling 2026-10-27). The source is
    archived with the trash setting off too, because Codex refuses to delete
    a thread that has a fork."""
    root = scratch_stores / "codex"
    moved, stays, forked = new_uuid(), new_uuid(), new_uuid()
    db = write_codex_db(root, [
        {"id": stays, "preview": "a", "recency_ms": 1000},
        {"id": moved, "preview": "b", "name": "Plan", "recency_ms": 2000},
    ])
    conn = sqlite3.connect(db)
    conn.execute("ALTER TABLE threads ADD COLUMN rollout_path TEXT")
    conn.commit()
    conn.close()
    target = tmp_path / "target"
    target.mkdir()
    calls: list[tuple] = []

    @contextlib.contextmanager
    def app_server(cli):
        # What real Codex 0.163.0 does: the fork carries the name and the
        # target cwd, but no preview, no first message and no user event;
        # only its rollout's session_meta names the source.
        def request(method, params):
            calls.append((method, params))
            rollout = write_codex_rollout(
                root, forked, params["cwd"], forked_from=params["threadId"]
            )
            conn = sqlite3.connect(db)
            conn.execute(
                "INSERT INTO threads SELECT ?, ?, name, '', '', created_at_ms, "
                "updated_at_ms, recency_at_ms, git_branch, model, tokens_used, "
                "source, 0, 0, ? FROM threads WHERE id = ?",
                (forked, params["cwd"], str(rollout), params["threadId"]),
            )
            conn.commit()
            conn.close()
            return {"thread": {"id": forked, "name": "Plan"}}
        yield request

    def dispose(codex, thread_id, to_trash):
        calls.append(("dispose", thread_id, to_trash))
        if not to_trash and thread_id == moved:
            return False  # 0.163.0: 'failed to delete session' for a forked parent
        conn = sqlite3.connect(db)
        conn.execute("UPDATE threads SET archived = 1 WHERE id = ?", (thread_id,))
        conn.commit()
        conn.close()
        return True

    monkeypatch.setattr(codex_provider, "_app_server", app_server)
    monkeypatch.setattr(codex_provider.CodexStore, "_dispose_thread", staticmethod(dispose))
    monkeypatch.setattr(codex_provider.shutil, "which", lambda _: "/bin/codex")
    monkeypatch.setattr(codex_provider, "live_cwds", lambda: set())
    monkeypatch.setattr(jp_serverapp.contents_manager, "delete_to_trash", trash)
    colour_store.set_colour("codex", moved, "mint")

    answer = await move(jp_fetch, "codex", move_body(PROJECT_PATH, moved, target))

    assert answer == {"session_id": forked, "encoded_path": str(target), "project_path": str(target)}
    assert calls[0] == ("thread/fork", {
        "threadId": moved, "cwd": str(target), "excludeTurns": True,
        "deferGoalContinuation": True,
    })
    # Archived, which Codex can undo, with the trash setting on or off.
    assert calls[1] == ("dispose", moved, True)
    rows = await sessions_of(jp_fetch, "codex")
    assert ids_under(rows, str(target)) == {forked}
    assert ids_under(rows, PROJECT_PATH) == {stays}
    # The tint goes with the conversation to its new id.
    assert colour_store.load_colours("codex") == {forked: "mint"}


def write_codex_rollout(root, thread_id, cwd, forked_from=None, source="vscode") -> Path:
    """A rollout whose first line is the session_meta Codex 0.163.0 writes."""
    path = root / "sessions" / f"rollout-{thread_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    meta = {"id": thread_id, "cwd": str(cwd), "source": source}
    if forked_from:
        meta["forked_from_id"] = forked_from
    path.write_text(json.dumps({"type": "session_meta", "payload": meta}) + "\n")
    return path


def test_codex_lists_a_fork_only_as_the_sole_live_copy(scratch_stores):
    """A moved conversation's fork lists although Codex left it no preview;
    a branch of a live conversation and a sub-agent spawn stay hidden."""
    root = scratch_stores / "codex"
    live, retired = new_uuid(), new_uuid()
    branch, moved, spawn = new_uuid(), new_uuid(), new_uuid()
    db = write_codex_db(root, [
        {"id": live, "cwd": "/p/live", "preview": "a"},
        {"id": retired, "cwd": "/p/old", "preview": "b", "archived": True},
        {"id": branch, "cwd": "/p/branch", "has_user_event": False},
        {"id": moved, "cwd": "/p/moved", "has_user_event": False},
        {"id": spawn, "cwd": "/p/spawn", "has_user_event": False},
    ])
    conn = sqlite3.connect(db)
    conn.execute("ALTER TABLE threads ADD COLUMN rollout_path TEXT")
    for tid, cwd, parent, source in (
        (branch, "/p/branch", live, "vscode"),
        (moved, "/p/moved", retired, "vscode"),
        (spawn, "/p/spawn", retired, {"subagent": {"thread_spawn": {}}}),
    ):
        rollout = write_codex_rollout(root, tid, cwd, forked_from=parent, source=source)
        conn.execute("UPDATE threads SET rollout_path = ? WHERE id = ?", (str(rollout), tid))
    conn.commit()
    conn.close()
    rows = registry.get("codex").store.list_sessions()
    assert {r["project_path"]: r["session_id"] for r in rows} == {
        "/p/live": live, "/p/moved": moved,
    }


# ------------------------------------------------------------ move: refusals


@pytest.fixture
def claude_project(scratch_stores, tmp_path):
    """A Claude project in a real folder, with one conversation."""
    source = tmp_path / "source"
    source.mkdir()
    session = new_uuid()
    root = scratch_stores / "claude"
    project_dir = root / "projects" / claude_provider._encode_path(str(source))
    project_dir.mkdir(parents=True)
    (project_dir / f"{session}.jsonl").write_text(
        json.dumps({"type": "user", "cwd": str(source)}) + "\n"
    )
    target = tmp_path / "target"
    target.mkdir()
    return claude_provider._encode_path(str(source)), session, source, target


@pytest.mark.parametrize("provider_id", PROVIDERS)
async def test_a_move_of_a_live_conversation_is_refused(
    jp_fetch, present, running, monkeypatch, provider_id  # noqa: F811
):
    """The move would take the transcript from under the running process."""
    store = registry.get(provider_id).store
    monkeypatch.setattr(store, "list_sessions", lambda root_dir=None: [
        {"encoded_path": "enc", "project_path": "/nowhere/source", "session_id": "sid-current"}
    ])
    monkeypatch.setattr(store, "project_session_ids", lambda e: ["sid-current", "sid-live"])
    monkeypatch.setattr(store, "move", lambda *a, **k: pytest.fail("the store was asked to move"))
    running(provider_id, "sid-live")
    assert await error_of(
        jp_fetch, URL, "providers", provider_id, "move", method="POST",
        body=json.dumps(move_body("enc", "sid-live", "/tmp")),
    ) == (409, "session_live")


async def test_a_bare_assistant_in_the_source_runs_its_current_conversation(
    jp_fetch, present, running, monkeypatch  # noqa: F811
):
    """A process that names no conversation runs the project's newest one,
    which is the current one - so that one is live, and only that one."""
    store = registry.get("codex").store
    monkeypatch.setattr(store, "list_sessions", lambda root_dir=None: [
        {"encoded_path": "enc", "project_path": "/nowhere/source", "session_id": "sid-current"}
    ])
    monkeypatch.setattr(store, "project_session_ids", lambda e: ["sid-current", "sid-other"])
    monkeypatch.setattr(store, "move", lambda e, s, t, to_trash=False: (s, t))
    monkeypatch.setattr(store, "switch", lambda e, s: {"requested": s})
    monkeypatch.setattr(store, "resolve_current", lambda e: None)
    running("codex", None, cwd="/nowhere/source/sub")
    assert await error_of(
        jp_fetch, URL, "providers", "codex", "move", method="POST",
        body=json.dumps(move_body("enc", "sid-current", "/tmp")),
    ) == (409, "session_live")
    answer = await move(jp_fetch, "codex", move_body("enc", "sid-other", "/tmp"))
    assert answer["session_id"] == "sid-other"


# Above pid_max, so /proc never answers for them and the patched reads alone decide.
CODEX_DAEMON_PID, CODEX_TUI_PID = 99_999_998, 99_999_999


@pytest.fixture
def codex_processes(monkeypatch):
    """Codex's managed app-server daemon, and a Codex terminal on a conversation."""
    argv = {
        CODEX_DAEMON_PID: b"codex\0app-server\0--listen\0unix://\0"
        b"--analytics-default-enabled\0--managed-daemon\0",
        CODEX_TUI_PID: f"codex\0resume\0{new_uuid()}\0".encode(),
    }
    monkeypatch.setattr(codex_provider, "process_comm", lambda pid: "codex" if pid in argv else None)
    monkeypatch.setattr(codex_provider, "process_cmdline", argv.get)


def test_codex_s_app_server_daemon_is_not_a_codex_terminal(codex_processes):
    store = registry.get("codex").store
    assert store.owns_pid(CODEX_DAEMON_PID) is False
    assert store.owns_pid(CODEX_TUI_PID) is True


def test_codex_s_app_server_daemon_leaves_the_current_session_movable(
    codex_processes, monkeypatch, tmp_path
):
    """The daemon names no conversation and keeps the cwd of the terminal that
    started it; counted as Codex, it would hold that project's current session
    as live with no terminal open."""
    monkeypatch.setattr(routes, "_proc_pids", lambda: [CODEX_DAEMON_PID])
    monkeypatch.setattr(routes, "_process_cwd_link", lambda pid: str(tmp_path))
    codex = registry.get("codex")
    assert routes._move_is_live(codex, "sid-current", "sid-current", str(tmp_path)) is False


def test_codex_s_app_server_daemon_lights_no_project_row(codex_processes, monkeypatch):
    """After its terminal closes the daemon stays in that terminal's cwd;
    counted as Codex, it keeps the project's 'session is active' dot lit."""
    cwds = {f"/proc/{CODEX_DAEMON_PID}/cwd": "/srv/closed", f"/proc/{CODEX_TUI_PID}/cwd": "/srv/open"}
    listdir, readlink = os.listdir, os.readlink
    monkeypatch.setattr(
        os, "listdir",
        lambda p: [str(CODEX_DAEMON_PID), str(CODEX_TUI_PID)] if p == "/proc" else listdir(p),
    )
    monkeypatch.setattr(os, "readlink", lambda p: cwds.get(p) or readlink(p))
    assert codex_provider.live_cwds() == {"/srv/open"}


def test_only_a_codex_comm_has_its_argv_read(codex_processes, monkeypatch):
    """The comm decides first: a delete, a move and the activity dot walk every pid in /proc."""
    read, cmdline = [], codex_provider.process_cmdline
    monkeypatch.setattr(codex_provider, "process_cmdline", lambda pid: read.append(pid) or cmdline(pid))
    assert registry.get("codex").store.owns_pid(CODEX_DAEMON_PID - 1) is False
    assert read == []


async def test_a_move_to_a_folder_that_is_not_there_is_refused(
    jp_fetch, present, claude_project, tmp_path  # noqa: F811
):
    encoded, session, _source, _target = claude_project
    assert await error_of(
        jp_fetch, URL, "providers", "claude", "move", method="POST",
        body=json.dumps(move_body(encoded, session, tmp_path / "missing")),
    ) == (400, "invalid_target_path")


async def test_a_move_the_assistant_cannot_make_is_refused(
    jp_fetch, present, claude_project, monkeypatch  # noqa: F811
):
    encoded, session, _source, target = claude_project
    provider = registry.get("claude")
    descriptor = dataclasses.replace(
        provider.descriptor,
        capabilities=dataclasses.replace(provider.descriptor.capabilities, can_move=False),
    )
    monkeypatch.setattr(provider, "descriptor", descriptor)
    monkeypatch.setattr(provider.store, "move", lambda *a, **k: pytest.fail("store asked"))
    assert await error_of(
        jp_fetch, URL, "providers", "claude", "move", method="POST",
        body=json.dumps(move_body(encoded, session, target)),
    ) == (400, "move_unsupported")


async def test_a_move_of_a_conversation_the_project_does_not_hold_is_refused(
    jp_fetch, present, claude_project  # noqa: F811
):
    encoded, _session, _source, target = claude_project
    assert await error_of(
        jp_fetch, URL, "providers", "claude", "move", method="POST",
        body=json.dumps(move_body(encoded, new_uuid(), target)),
    ) == (404, "session_not_found")


async def test_a_move_into_its_own_project_is_refused(
    jp_fetch, present, claude_project  # noqa: F811
):
    encoded, session, source, _target = claude_project
    assert await error_of(
        jp_fetch, URL, "providers", "claude", "move", method="POST",
        body=json.dumps(move_body(encoded, session, source)),
    ) == (400, "move_same_project")


async def test_a_target_holding_the_conversation_is_refused_in_words(
    jp_fetch, present, claude_project, scratch_stores  # noqa: F811
):
    """The store's own refusal reaches the caller as a sentence, the
    ``LaunchRefused`` shape."""
    encoded, session, source, target = claude_project
    taken = scratch_stores / "claude" / "projects" / claude_provider._encode_path(str(target))
    taken.mkdir(parents=True)
    (taken / f"{session}.jsonl").write_text("{}\n")
    with pytest.raises(Exception) as excinfo:
        await fetch(jp_fetch, "providers", "claude", "move", method="POST",
                    body=move_body(encoded, session, target))
    assert excinfo.value.code == 409
    assert json.loads(excinfo.value.response.body) == {
        "message": "the target project already holds this conversation"
    }
    assert (scratch_stores / "claude" / "projects" / encoded / f"{session}.jsonl").is_file()


async def test_a_move_the_store_could_not_make_is_a_failure(
    jp_fetch, present, claude_project, monkeypatch  # noqa: F811
):
    encoded, session, _source, target = claude_project
    monkeypatch.setattr(registry.get("claude").store, "move", lambda *a, **k: None)
    assert await error_of(
        jp_fetch, URL, "providers", "claude", "move", method="POST",
        body=json.dumps(move_body(encoded, session, target)),
    ) == (400, "move_failed")
