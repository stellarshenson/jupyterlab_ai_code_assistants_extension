"""The Copilot store against a sample ``$COPILOT_HOME`` (ACC-COPIL-252..258, 265).

The tree below is the layout measured on copilot 1.0.112, written by hand.
``COPILOT_HOME`` and ``HOME`` both point into the scratch tree, so nothing
reads or writes the real ``~/.copilot``.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pytest

from jupyterlab_ai_code_assistants_extension.core.store import (
    SessionNotFound,
    SessionStore,
)
from jupyterlab_ai_code_assistants_extension.providers import (
    copilot as copilot_provider,
)
from jupyterlab_ai_code_assistants_extension.providers.copilot import (
    CopilotStore,
    copilot_home,
    parse_workspace,
)

from .conftest import PROJECT_PATH, new_uuid

OTHER_PROJECT = "/home/lab/projects/other"
CLI = "/usr/local/bin/copilot"


@pytest.fixture
def copilot(scratch_stores, monkeypatch):
    home = scratch_stores / "copilot"
    monkeypatch.setenv("COPILOT_HOME", str(home))
    store = CopilotStore()
    # What the registry binds at discovery.
    store.provider_id = "copilot"
    state_dir = home / "session-state"
    state_dir.mkdir(parents=True)
    return store, state_dir


def _line(kind: str, data: dict) -> str:
    """One event as Node's ``JSON.stringify`` writes it: compact, type first."""
    record = {"type": kind, "data": data, "id": new_uuid(), "parentId": None,
              "timestamp": "2026-11-01T10:00:00.000Z"}
    return json.dumps(record, separators=(",", ":"))


def _events(session_id: str, cwd: str | None, prompts: tuple[str, ...]) -> str:
    start = {"sessionId": session_id, "startTime": "2026-11-01T10:00:00.000Z"}
    if cwd:
        start["context"] = {"cwd": cwd, "gitRoot": cwd}
    lines = [_line("session.start", start)]
    for prompt in prompts:
        lines.append(_line("user.message", {"content": prompt}))
        # A tool event between the messages must not count as one.
        lines.append(_line("tool.execution_start", {"toolName": "bash"}))
        lines.append(_line("assistant.message", {"content": "done"}))
    return "\n".join(lines) + "\n"


def write_session(
    state_dir: Path,
    *,
    cwd: str | None = PROJECT_PATH,
    start_cwd: str | None = None,
    name: str | None = None,
    prompts: tuple[str, ...] | None = ("fix the build",),
    age: int = 0,
) -> str:
    """One session directory.

    ``prompts=None`` leaves out events.jsonl, as copilot does until the first
    persisted event. ``age`` seconds back from now is the session's last
    activity, so a test orders sessions without depending on the filesystem's
    timestamp grain. ``start_cwd`` is the cwd the session.start event records,
    ``cwd`` when unset.
    """
    session_id = new_uuid()
    session_dir = state_dir / session_id
    session_dir.mkdir()
    yaml = [f"id: {session_id}", f"cwd: {cwd}", f"git_root: {cwd}"]
    if name:
        yaml += [f"name: {name}", "user_named: false"]
    yaml += ["summary_count: 0", "created_at: 2026-11-01T10:00:00.000Z"]
    activity = session_dir / "workspace.yaml"
    activity.write_text("\n".join(yaml) + "\n", encoding="utf-8")
    if prompts is not None:
        activity = session_dir / "events.jsonl"
        activity.write_text(_events(session_id, start_cwd or cwd, prompts), encoding="utf-8")
    stamp = 1_700_000_000 - age
    os.utime(activity, (stamp, stamp))
    return session_id


def write_lock(state_dir: Path, session_id: str, pid: int, age: int = 0) -> None:
    """The ``inuse.<pid>.lock`` copilot writes into a session it opens: the
    pid as text, ``age`` seconds old."""
    lock = state_dir / session_id / f"inuse.{pid}.lock"
    lock.write_text(f"{pid}\n", encoding="utf-8")
    stamp = 1_700_000_000 - age
    os.utime(lock, (stamp, stamp))


def cmdline(*args: str) -> bytes:
    return b"\0".join(arg.encode() for arg in args) + b"\0"


def tree_digest(path: Path) -> dict[str, str]:
    return {
        str(p.relative_to(path)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(path.rglob("*"))
        if p.is_file()
    }


def test_copilot_home_is_the_env_override_else_dot_copilot(scratch_stores, monkeypatch):
    monkeypatch.setenv("COPILOT_HOME", str(scratch_stores / "elsewhere"))
    assert copilot_home() == scratch_stores / "elsewhere"
    monkeypatch.delenv("COPILOT_HOME")
    assert copilot_home() == scratch_stores / "home" / ".copilot"


def test_copilot_lists_named_and_unnamed_sessions_in_two_projects(copilot):
    """ACC-COPIL-252: the project is the workspace.yaml cwd, even where
    session.start recorded another; the title the name, else the first line
    of the first prompt, else the folder. An unnamed session with no user
    message is not listed, as copilot hides it, so a start closed before the
    first prompt never takes the project's row (DEF-PROV-399); a named one is."""
    store, state_dir = copilot
    named = write_session(state_dir, name="Release prep", age=10)
    older = write_session(state_dir, prompts=("first ask",), age=50)
    write_session(state_dir, prompts=None, age=0)
    unnamed = write_session(
        state_dir,
        cwd=OTHER_PROJECT,
        start_cwd="/home/lab/projects/launched-from",
        prompts=("\n  add tests\nthen more", "x"),
        age=20,
    )
    bare = write_session(state_dir, cwd="/home/lab/projects/third", prompts=("  ",), age=30)
    planned = write_session(
        state_dir, cwd="/home/lab/projects/fourth", name="Planned", prompts=None, age=40
    )
    write_session(state_dir, cwd="/home/lab/projects/fifth", prompts=(), age=5)

    rows = store.list_sessions()
    assert [row["session_id"] for row in rows] == [named, unnamed, bare, planned]
    by_project = {row["project_path"]: row for row in rows}

    row = by_project[PROJECT_PATH]
    assert row["encoded_path"] == PROJECT_PATH
    assert (row["name"], row["name_source"]) == ("Release prep", "session")
    assert row["message_count"] == 2
    assert row["extra_sessions"] == 1

    row = by_project[OTHER_PROJECT]
    assert (row["name"], row["name_source"]) == ("add tests", "session")
    assert row["message_count"] == 4

    row = by_project["/home/lab/projects/third"]
    assert (row["name"], row["name_source"]) == ("third", "basename")

    row = by_project["/home/lab/projects/fourth"]
    assert (row["name"], row["message_count"]) == ("Planned", 0)

    branches = store.list_branches(PROJECT_PATH)
    assert branches["current"] == named and branches["total"] == 2
    assert branches["branches"] == [
        {"session_id": older, "file_mtime": 1_699_999_950_000, "label": "first ask"}
    ]


def test_copilot_legacy_flat_file_produces_no_row(copilot):
    """ACC-COPIL-253: copilot 1.0.112 refuses a pre-1.0.11 flat
    ``<uuid>.jsonl``, so with or without a cwd it lists nothing and is never
    resumed or forked (DEF-PROV-401)."""
    store, state_dir = copilot
    for cwd in (PROJECT_PATH, None):
        flat = new_uuid()
        (state_dir / f"{flat}.jsonl").write_text(
            _events(flat, cwd, ("fix the build",)), encoding="utf-8"
        )
        with pytest.raises(SessionNotFound):
            store.launch_argv(CLI, session_id=flat)
        assert store.fork(PROJECT_PATH, flat) is None
    assert store.list_sessions() == []


def test_copilot_launch_by_session_id_with_and_without_yolo(copilot):
    """ACC-COPIL-254/255/258: resume and new both pass ``--session-id``, never
    ``--resume`` or ``--continue``; the yolo mode adds ``--yolo``."""
    store, state_dir = copilot
    session = write_session(state_dir)
    minted = new_uuid()

    assert store.launch_argv(CLI, session_id=session) == [CLI, "--session-id", session]
    assert store.launch_argv(CLI, session_id=session, mode="yoloMode") == [
        CLI, "--session-id", session, "--yolo"
    ]
    assert store.launch_argv(CLI, new_session_id=minted) == [CLI, "--session-id", minted]
    assert store.launch_argv(CLI, new_session_id=minted, mode="yoloMode") == [
        CLI, "--session-id", minted, "--yolo"
    ]
    # An unknown UUID would silently start a new session under it.
    with pytest.raises(SessionNotFound):
        store.launch_argv(CLI, session_id=new_uuid())

    argv = store.launch_argv(CLI, session_id=session)
    assert store.parse_session_id(cmdline(*argv)) == session
    assert store.parse_session_id(cmdline(CLI, "--resume", session)) is None


def test_copilot_fork_copies_the_session_under_a_fresh_id(copilot):
    """ACC-COPIL-256: new directory, new id in workspace.yaml and the
    session.start event, the given name, parent bytes unchanged; the lock
    files of the process running the parent stay behind (DEF-PROV-400)."""
    store, state_dir = copilot
    parent = write_session(state_dir, name="Base", prompts=("one", "two"))
    parent_dir = state_dir / parent
    (parent_dir / "checkpoints").mkdir()
    (parent_dir / "checkpoints" / "001.md").write_text("plan", encoding="utf-8")
    write_lock(state_dir, parent, 4242)
    (parent_dir / "inuse.4242.hold").touch()
    before = tree_digest(parent_dir)

    child = store.fork(PROJECT_PATH, parent, "Try B")
    assert child and child != parent
    child_dir = state_dir / child
    assert tree_digest(parent_dir) == before
    assert (child_dir / "checkpoints" / "001.md").read_text(encoding="utf-8") == "plan"
    assert list(child_dir.glob("inuse.*")) == []

    fields = parse_workspace((child_dir / "workspace.yaml").read_text(encoding="utf-8"))
    assert fields["id"] == child and fields["name"] == "Try B"
    assert fields["cwd"] == PROJECT_PATH and fields["user_named"] == "true"

    parent_lines = (parent_dir / "events.jsonl").read_text(encoding="utf-8").split("\n")
    child_lines = (child_dir / "events.jsonl").read_text(encoding="utf-8").split("\n")
    assert json.loads(child_lines[0])["data"]["sessionId"] == child
    assert child_lines[1:] == parent_lines[1:]

    listing = store.list_branches(PROJECT_PATH)
    assert {listing["current"], *(b["session_id"] for b in listing["branches"])} == {
        parent, child
    }
    assert store.launch_argv(CLI, session_id=child) == [CLI, "--session-id", child]


def test_copilot_rename_sets_name_in_workspace_yaml(copilot):
    """ACC-COPIL-257: the name lands in workspace.yaml, every other line kept,
    a folded old value replaced whole, and the rename is not activity."""
    store, state_dir = copilot
    session = write_session(state_dir)
    workspace = state_dir / session / "workspace.yaml"
    original = workspace.read_text(encoding="utf-8")
    workspace.write_text(
        original + "name: >-\n  a long name the writer\n  folded\nuser_named: false\n",
        encoding="utf-8",
    )
    stamp = 1_700_000_000
    os.utime(workspace, (stamp, stamp))
    assert store.list_sessions()[0]["name"] == "a long name the writer folded"

    assert store.rename(PROJECT_PATH, session, 'Ship "it"') == 'Ship "it"'
    text = workspace.read_text(encoding="utf-8")
    assert text == original + 'name: "Ship \\"it\\""\nuser_named: true\n'
    assert workspace.stat().st_mtime == stamp
    assert store.list_sessions()[0]["name"] == 'Ship "it"'


def test_parse_workspace_reads_the_scalar_forms():
    text = (
        "# written by copilot\n"
        "id: 'it''s'\n"
        'cwd: "/home/lab/caf\\u00e9"\n'
        "branch: main # trailing comment\n"
        "repository: ~\n"
        "name: |\n"
        "  line one\n"
        "  line two\n"
        "git_root:\n"
        "  /home/lab/x\n"
    )
    assert parse_workspace(text) == {
        "id": "it's",
        "cwd": "/home/lab/café",
        "branch": "main",
        "repository": None,
        "name": "line one\nline two",
        "git_root": "/home/lab/x",
    }


def test_copilot_switch_delete_and_remove(copilot):
    store, state_dir = copilot
    current = write_session(state_dir, age=10)
    older = write_session(state_dir, age=20)
    oldest = write_session(state_dir, age=30)

    assert store.switch(PROJECT_PATH, new_uuid()) == {"error": "branch_not_found"}
    assert store.switch(PROJECT_PATH, older) == {"requested": older}
    assert store.resolve_current(PROJECT_PATH) == older

    # The current session is never deleted from the branch list.
    assert store.delete_branches(PROJECT_PATH, [older, oldest]) == [oldest]
    assert not (state_dir / oldest).exists()
    assert store.delete_branches(PROJECT_PATH, [["not", "an", "id"]]) is None

    assert sorted(store.remove(PROJECT_PATH)) == sorted([current, older])
    assert list(state_dir.iterdir()) == []


@pytest.mark.parametrize(
    "comm,argv,owned",
    [
        ("copilot", None, True),
        ("node-MainThread", ("node", CLI, "--session-id", "x"), True),
        ("MainThread", ("node", "/usr/lib/node_modules/@github/copilot/index.js"), True),
        ("node", ("node", "/home/lab/copilot-app/node_modules/.bin/vite", "dev"), False),
        ("bash", ("bash",), False),
    ],
)
def test_copilot_owns_only_its_own_process(copilot, monkeypatch, comm, argv, owned):
    store, _state_dir = copilot
    monkeypatch.setattr(copilot_provider, "process_comm", lambda pid: comm)
    monkeypatch.setattr(
        copilot_provider, "process_cmdline", lambda pid: cmdline(*argv) if argv else None
    )
    assert store.owns_pid(4242) is owned


@pytest.fixture
def pid_tree(copilot, monkeypatch):
    """Child pids by parent, read by the store instead of ``/proc``; the argv
    fallback answers ``argv_session`` for every pid."""
    tree: dict[int, list[int]] = {}
    monkeypatch.setattr(copilot_provider, "process_children", lambda pid: tree.get(pid, []))
    monkeypatch.setattr(SessionStore, "session_id_for_pid", lambda self, pid: "argv-session")
    return tree


def test_copilot_running_session_is_the_newest_inuse_lock_of_the_process(copilot, pid_tree):
    """ACC-COPIL-265: the lock names the session, before the argv; the npm
    loader answers from its native child's lock; a switch inside the TUI adds
    a newer lock while the first stays (DEF-PROV-400)."""
    store, state_dir = copilot
    started = write_session(state_dir)
    switched = write_session(state_dir)
    other = write_session(state_dir)

    assert store.session_id_for_pid(500) == "argv-session"
    write_lock(state_dir, started, 500, age=60)
    assert store.session_id_for_pid(500) == started
    write_lock(state_dir, switched, 500, age=30)
    assert store.session_id_for_pid(500) == switched

    pid_tree[400] = [500]
    assert store.session_id_for_pid(400) == switched
    # Another process's lock is not this one's.
    write_lock(state_dir, other, 600)
    assert store.session_id_for_pid(400) == switched


def test_copilot_stale_inuse_lock_is_ignored(copilot, pid_tree):
    """ACC-COPIL-265: kill -9 leaves a lock behind. A dead pid's lock names no
    running session; one under a pid a live copilot later reused is older than
    that process's own lock."""
    store, state_dir = copilot
    stale = write_session(state_dir)
    live = write_session(state_dir)
    write_lock(state_dir, stale, 999, age=0)
    assert store.session_id_for_pid(700) == "argv-session"

    write_lock(state_dir, stale, 700, age=120)
    write_lock(state_dir, live, 700, age=60)
    assert store.session_id_for_pid(700) == live
