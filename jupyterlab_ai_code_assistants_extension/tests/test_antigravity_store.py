"""The Antigravity store against a sample ``~/.gemini/antigravity-cli`` tree.

The tables are agy 1.5.9's own: the CREATE statements below are copied from a
real store (tmp/workflows/agy-real/findings.md). A conversation carries its id
in the seven places measured there. ``HOME`` is the scratch home from
``conftest``, so nothing here reaches a real store.
"""
from __future__ import annotations

import hashlib
import os
import sqlite3
import subprocess
from contextlib import closing
from pathlib import Path

import pytest

from jupyterlab_ai_code_assistants_extension.core import state
from jupyterlab_ai_code_assistants_extension.core.store import SessionNotFound
from jupyterlab_ai_code_assistants_extension.providers import antigravity
from jupyterlab_ai_code_assistants_extension.providers.antigravity import (
    MODE_SKIP_PERMISSIONS,
    AntigravityStore,
)
from jupyterlab_ai_code_assistants_extension.providers.gemini import GeminiStore

from .conftest import new_uuid, write_gemini_tree

CLI = "/home/lab/.local/bin/agy"

SUMMARIES_SCHEMA = (
    "CREATE TABLE `conversation_summaries` (`conversation_id` text,"
    '`title` text NOT NULL DEFAULT "",`preview` text NOT NULL DEFAULT "",'
    "`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,"
    '`workspace_uris` text NOT NULL,`status` text NOT NULL DEFAULT "",'
    '`source` text NOT NULL DEFAULT "",`project_id` text NOT NULL DEFAULT "",'
    '`agent_name` text NOT NULL DEFAULT "",`parent_conversation_id` text NOT NULL DEFAULT "",'
    '`nesting_depth` integer NOT NULL DEFAULT 0,`battle_id` text NOT NULL DEFAULT "",'
    '`winning_conversation_id` text NOT NULL DEFAULT "",'
    "`not_fully_idle` numeric NOT NULL DEFAULT false,`killed` numeric NOT NULL DEFAULT false,"
    "`last_user_input_time` datetime NOT NULL,"
    "`last_user_input_step_index` integer NOT NULL DEFAULT -1,"
    '`app_data_dir` text NOT NULL DEFAULT "",`raw_summary` blob,'
    '`group_id` text NOT NULL DEFAULT "",PRIMARY KEY (`conversation_id`))'
)
CONVERSATION_SCHEMA = (
    "CREATE TABLE `trajectory_meta` (`trajectory_id` text,`cascade_id` text,"
    "`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`))",
    "CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,"
    "`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,"
    "`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,"
    "`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,"
    "PRIMARY KEY (`idx`))",
    "CREATE INDEX `idx_steps_status` ON `steps`(`status`)",
    "CREATE INDEX `idx_steps_step_type` ON `steps`(`step_type`)",
    "CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,"
    "`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))",
    "CREATE TABLE `executor_metadata` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))",
    "CREATE TABLE `parent_references` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))",
    'CREATE TABLE `trajectory_metadata_blob` (`id` text DEFAULT "main",`data` blob,'
    "PRIMARY KEY (`id`))",
    "CREATE TABLE `battle_mode_infos` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))",
)
# The places agy 1.5.9 wrote a conversation's id, gen_metadata twice over.
ID_PLACES = 8
DEFAULT_TIME = "2026-11-16 02:02:00.121729540+00:00"


def agy_root() -> Path:
    return Path.home() / ".gemini" / "antigravity-cli"


def pb_id(sid: str) -> bytes:
    """A protobuf string field holding the id, length-prefixed as agy writes it."""
    return b"\x0a\x24" + sid.encode() + b"\x12\x04done"


def step(sid: str, idx: int) -> tuple:
    return (idx, pb_id(sid), pb_id(sid))


def write_conversation_db(db: Path, sid: str) -> None:
    db.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(db)) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        for statement in CONVERSATION_SCHEMA:
            conn.execute(statement)
        conn.execute("INSERT INTO trajectory_meta VALUES (?, ?, 1, 1)", (new_uuid(), sid))
        conn.executemany(
            "INSERT INTO steps (idx, metadata, step_payload) VALUES (?, ?, ?)",
            [step(sid, 0), step(sid, 1)],
        )
        conn.execute("INSERT INTO gen_metadata (idx, data) VALUES (0, ?)", (pb_id(sid) * 2,))
        conn.execute("INSERT INTO trajectory_metadata_blob (data) VALUES (?)", (pb_id(sid),))
        conn.commit()
    os.chmod(db, 0o600)


def write_conversation(
    sid: str,
    workspace: Path | None,
    title: str = "",
    preview: str = "",
    steps: int = 2,
    modified: str = DEFAULT_TIME,
) -> None:
    """One conversation: agy's summaries row, its db and its brain transcript."""
    root = agy_root()
    root.mkdir(parents=True, exist_ok=True)
    uris = f'["{workspace.as_uri()}"]' if workspace else "[]"
    with closing(sqlite3.connect(root / "conversation_summaries.db")) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(SUMMARIES_SCHEMA.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS", 1))
        conn.execute(
            "INSERT INTO conversation_summaries (conversation_id, title, preview, step_count,"
            " last_modified_time, workspace_uris, last_user_input_time)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (sid, title, preview, steps, modified, uris, modified),
        )
        conn.commit()
    write_conversation_db(root / "conversations" / f"{sid}.db", sid)
    transcript = root / "brain" / sid / ".system_generated" / "logs" / "transcript.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text(
        '{"type": "USER_INPUT", "content": "<USER_REQUEST>\\n%s\\n</USER_REQUEST>"}\n' % preview,
        encoding="utf-8",
    )


def values_with(db: Path, needle: str) -> int:
    """How often ``needle`` occurs across every text and blob value of a db."""
    count = 0
    with closing(sqlite3.connect(f"{db.as_uri()}?mode=ro", uri=True)) as conn:
        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        for table in tables:
            for row in conn.execute(f"SELECT * FROM `{table}`"):
                for value in row:
                    if isinstance(value, str):
                        count += value.count(needle)
                    elif isinstance(value, bytes):
                        count += value.count(needle.encode())
    return count


def digest(paths) -> dict[Path, str]:
    return {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths if p.is_file()}


@pytest.fixture
def agy() -> AntigravityStore:
    store = AntigravityStore()
    store.provider_id = "antigravity"
    return store


@pytest.fixture
def sample(scratch_stores):
    """Two projects: a named and an unnamed conversation in alpha, one in beta."""
    alpha = scratch_stores / "work" / "alpha"
    beta = scratch_stores / "work" / "beta"
    ids = {key: new_uuid() for key in ("named", "unnamed", "chart")}
    write_conversation(
        ids["named"], alpha, "Release plan", "Plan the release\nwith details",
        steps=7, modified="2026-11-16 02:05:00.5+00:00",
    )
    write_conversation(ids["unnamed"], alpha, "", "Fix the parser\nthen test",
                       modified="2026-11-16 02:01:00+00:00")
    write_conversation(ids["chart"], beta, "", "Draw the chart",
                       modified="2026-11-16 02:03:00+00:00")
    return {"alpha": str(alpha), "beta": str(beta), **ids}


def test_acc_agy_244_rows_list_under_their_workspace_named_else_preview(agy, sample):
    rows = {row["project_path"]: row for row in agy.list_sessions()}
    assert set(rows) == {sample["alpha"], sample["beta"]}
    alpha = rows[sample["alpha"]]
    assert (alpha["session_id"], alpha["name"], alpha["name_source"]) == (
        sample["named"], "Release plan", "session"
    )
    assert alpha["encoded_path"] == sample["alpha"]
    assert (alpha["extra_sessions"], alpha["message_count"]) == (1, 7)
    assert alpha["file_mtime"] == 1794794700500
    assert rows[sample["beta"]]["name"] == "Draw the chart"
    branches = agy.list_branches(sample["alpha"])["branches"]
    assert [(b["session_id"], b["label"]) for b in branches] == [
        (sample["unnamed"], "Fix the parser")
    ]


def test_acc_agy_244_a_conversation_with_no_workspace_gives_no_row(agy, sample):
    nowhere = new_uuid()
    write_conversation(nowhere, None, "", "Lost conversation")
    listed = {row["session_id"] for row in agy.list_sessions()}
    for project in (sample["alpha"], sample["beta"]):
        listed.update(agy.project_session_ids(project))
    assert nowhere not in listed


@pytest.mark.parametrize("damage", ["missing", "not_sqlite", "locked"])
def test_acc_agy_244_an_unreadable_summaries_db_lists_nothing(agy, monkeypatch, damage):
    monkeypatch.setattr(antigravity, "SQLITE_TIMEOUT_S", 0.05)
    root = agy_root()
    root.mkdir(parents=True)
    db = root / "conversation_summaries.db"
    if damage == "not_sqlite":
        db.write_bytes(b"not a database at all" * 100)
    if damage != "locked":
        assert agy.list_sessions() == []
        return
    with closing(sqlite3.connect(db, isolation_level=None)) as holder:
        holder.execute(SUMMARIES_SCHEMA)
        holder.execute("BEGIN EXCLUSIVE")
        assert agy.list_sessions() == []


def test_acc_agy_263_a_row_whose_conversation_db_is_gone_lists_nothing(agy, sample):
    (agy_root() / "conversations" / f"{sample['chart']}.db").unlink()
    (agy_root() / "conversations" / f"{sample['unnamed']}.db").unlink()
    rows = {row["project_path"]: row["session_id"] for row in agy.list_sessions()}
    assert rows == {sample["alpha"]: sample["named"]}
    assert agy.project_session_ids(sample["alpha"]) == [sample["named"]]


def test_def_prov_392_the_label_is_the_preview_never_the_user_request_tag(agy, scratch_stores):
    gamma = scratch_stores / "work" / "gamma"
    sid = new_uuid()
    write_conversation(sid, gamma, "", "status")
    (row,) = agy.list_sessions()
    assert (row["name"], row["name_source"]) == ("status", "session")


def test_acc_agy_245_a_row_resumes_by_id_never_continue(agy, sample):
    argv = agy.launch_argv(CLI, session_id=sample["named"], project_path=sample["alpha"])
    assert argv == [CLI, "--conversation", sample["named"]]
    assert agy.parse_session_id(b"\0".join(arg.encode() for arg in argv)) == sample["named"]
    with pytest.raises(SessionNotFound):
        agy.launch_argv(CLI, session_id=new_uuid(), project_path=sample["alpha"])


def test_acc_agy_246_a_new_conversation_is_plain_agy_and_lists_from_agy_row(
    agy, sample, scratch_stores
):
    gamma = scratch_stores / "work" / "gamma"
    argv = agy.launch_argv(CLI, new_session_id=new_uuid(), project_path=str(gamma))
    assert argv == [CLI]
    started = new_uuid()
    write_conversation(started, gamma, "", "Started from the panel",
                       modified="2026-11-16 03:00:00+00:00")
    rows = {row["project_path"]: row["session_id"] for row in agy.list_sessions()}
    assert rows[str(gamma)] == started


def test_def_pane_394_a_plain_agy_is_on_the_conversation_whose_presence_lock_it_holds(
    agy, scratch_stores
):
    sid = new_uuid()
    lock = agy_root() / "presence" / f"{sid}.lock"
    lock.parent.mkdir(parents=True)
    with lock.open("a") as held:
        process = subprocess.Popen(["sleep", "60"], stdin=held)
    try:
        assert agy.session_id_for_pid(process.pid) == sid
    finally:
        process.kill()
        process.wait()


def test_acc_agy_247_branch_copies_with_every_id_replaced_and_the_parent_unchanged(
    agy, sample
):
    parent = sample["named"]
    root = agy_root()
    parent_db = root / "conversations" / f"{parent}.db"
    before = digest([parent_db, *(root / "brain" / parent).rglob("*")])
    child = agy.fork(sample["alpha"], parent, 'Release "branch"')
    assert child and child != parent
    assert digest(before) == before
    child_db = root / "conversations" / f"{child}.db"
    with closing(sqlite3.connect(child_db)) as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert conn.execute("PRAGMA journal_mode").fetchone() == ("wal",)
    assert values_with(child_db, parent) == 0
    assert values_with(child_db, child) == ID_PLACES
    assert (root / "brain" / child / ".system_generated" / "logs" / "transcript.jsonl").is_file()
    annotation = root / "annotations" / f"{child}.pbtxt"
    assert annotation.read_text(encoding="utf-8") == 'title:"Release \\"branch\\""'
    # agy has no row for the copy yet; it lists from the fork record as the
    # project's newest conversation, resumable at once.
    row = next(r for r in agy.list_sessions() if r["project_path"] == sample["alpha"])
    assert (row["session_id"], row["name"]) == (child, 'Release "branch"')
    assert parent in agy.project_session_ids(sample["alpha"])
    assert agy.launch_argv(CLI, session_id=child) == [CLI, "--conversation", child]


def test_acc_agy_247_branch_carries_the_turns_still_in_the_wal(agy, scratch_stores):
    alpha = scratch_stores / "work" / "alpha"
    parent = new_uuid()
    write_conversation(parent, alpha, "", "Seed")
    db = agy_root() / "conversations" / f"{parent}.db"
    # Held open with checkpoints off, as a running agy would: the new step
    # lives only in the -wal until the connection closes.
    live = sqlite3.connect(db)
    try:
        live.execute("PRAGMA wal_autocheckpoint=0")
        live.execute("INSERT INTO steps (idx, metadata, step_payload) VALUES (?, ?, ?)",
                     step(parent, 2))
        live.commit()
        child = agy.fork(str(alpha), parent)
        with closing(sqlite3.connect(db.with_name(f"{child}.db"))) as conn:
            latest = conn.execute("SELECT metadata FROM steps WHERE idx = 2").fetchone()
    finally:
        live.close()
    assert latest == (pb_id(child),)


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads a file whatever its mode")
def test_acc_agy_247_a_failed_branch_leaves_nothing_behind(agy, sample):
    root = agy_root()
    secret = root / "brain" / sample["named"] / "unreadable.md"
    secret.write_text("x", encoding="utf-8")
    secret.chmod(0)
    # By id: reading the parent through SQLite may leave its -wal and -shm,
    # as agy itself does.
    def ids() -> set[str]:
        return {p.name.split(".")[0] for d in ("conversations", "brain") for p in (root / d).iterdir()}

    before = ids()
    try:
        assert agy.fork(sample["alpha"], sample["named"], "Doomed") is None
    finally:
        secret.chmod(0o600)
    assert ids() == before
    assert not (root / "annotations").exists()
    assert not (state.state_dir() / "antigravity-forks.json").exists()


def test_acc_agy_248_rename_writes_the_annotations_file_and_the_label_follows(agy, sample):
    name = 'Plan \\ "v2"'
    assert agy.rename(sample["alpha"], sample["named"], name) == name
    annotation = agy_root() / "annotations" / f"{sample['named']}.pbtxt"
    assert annotation.read_text(encoding="utf-8") == 'title:"Plan \\\\ \\"v2\\""'
    # The summaries row still says "Release plan" until agy next starts.
    row = next(r for r in agy.list_sessions() if r["project_path"] == sample["alpha"])
    assert row["name"] == name


@pytest.mark.parametrize("resume", [False, True])
def test_acc_agy_249_skip_permissions_adds_the_flag_only_when_on(agy, sample, resume):
    session = {"session_id": sample["named"]} if resume else {}
    on = agy.launch_argv(CLI, mode=MODE_SKIP_PERMISSIONS, project_path=sample["alpha"], **session)
    off = agy.launch_argv(CLI, project_path=sample["alpha"], **session)
    assert on == [*off, "--dangerously-skip-permissions"]
    assert "--dangerously-skip-permissions" not in off


def test_acc_agy_250_gemini_and_agy_list_only_their_own_data(agy, scratch_stores):
    alpha = scratch_stores / "work" / "alpha"
    chat = new_uuid()
    write_gemini_tree(Path.home() / ".gemini", "alpha-1a2b3c", [{"id": chat}])
    conversation = new_uuid()
    write_conversation(conversation, alpha, "", "Only in agy")
    gemini = GeminiStore()
    gemini.provider_id = "gemini"
    assert [row["session_id"] for row in gemini.list_sessions()] == [chat]
    assert [row["session_id"] for row in agy.list_sessions()] == [conversation]
