"""Per-adapter store scans against fixture trees.

Each assistant keeps its history in a different shape, and the store adapter is
the only place that shape is understood. The trees below mirror the layouts of the
retired standalone extensions; nothing here reads a real assistant directory.
"""
from __future__ import annotations

import io
import json
import os
import time

import pytest

from jupyterlab_ai_code_assistants_extension.core import state
from jupyterlab_ai_code_assistants_extension.core import store as store_module
from jupyterlab_ai_code_assistants_extension.core.store import SessionNotFound
from jupyterlab_ai_code_assistants_extension.providers import codex as codex_provider
from jupyterlab_ai_code_assistants_extension.providers import gemini as gemini_provider
from jupyterlab_ai_code_assistants_extension.providers import claude as claude_provider
from jupyterlab_ai_code_assistants_extension.providers.claude import ClaudeStore
from jupyterlab_ai_code_assistants_extension.providers.codex import CodexStore
from jupyterlab_ai_code_assistants_extension.providers.gemini import (
    GeminiStore,
    parse_resume_id as gemini_resume_id,
)
from jupyterlab_ai_code_assistants_extension.providers.kimi import (
    KimiStore,
    derived_colour,
    normalize_session_id,
    parse_resume_id as kimi_resume_id,
)

from .conftest import (
    CLAUDE_ENCODED,
    PROJECT_PATH,
    new_uuid,
    write_claude_tree,
    write_codex_db,
    write_gemini_tree,
    write_kimi_tree,
)


def cmdline(*args: str) -> bytes:
    """A ``/proc/<pid>/cmdline`` - NUL separated, NUL terminated."""
    return b"\0".join(arg.encode() for arg in args) + b"\0"


def touch(path, offset_s: float) -> None:
    """Stamp a file's mtime relative to now, so recency is not a race.

    Every store resolves a project's current conversation by recency, and a
    fixture written in one burst leaves the files tied to the microsecond.
    """
    when = time.time() + offset_s
    os.utime(path, (when, when))


# ------------------------------------------------------------------- claude


@pytest.fixture
def claude(scratch_stores):
    store = ClaudeStore()
    store.provider_id = "claude"
    return store, scratch_stores / "claude"


def test_a_malformed_number_costs_a_row_a_field_not_the_whole_listing(
    claude, scratch_stores
):
    """The assistants write these files; the panel only reads them.

    ``updatedAt`` is compared and subtracted, so an ISO string there - from a future or older CLI, in a directory
    Claude never prunes - used to raise out of the executor and 500 the
    sessions poll for EVERY project, on every tick, with nothing naming the
    file. One unusable value must cost its own field and nothing else.
    """
    store, root = claude
    sid = new_uuid()
    write_claude_tree(root, [{"id": sid, "cwd": PROJECT_PATH, "turns": 1}])

    states = root / "sessions"
    states.mkdir(parents=True, exist_ok=True)
    (states / "999.json").write_text(
        json.dumps(
            {"cwd": PROJECT_PATH, "pid": 999, "updatedAt": "2026-01-01T00:00:00Z"}
        ),
        encoding="utf-8",
    )
    index = root / "sessions-index.json"
    if index.exists():
        data = json.loads(index.read_text(encoding="utf-8"))
    else:
        data = {}
    index.write_text(json.dumps(data), encoding="utf-8")

    rows = store.list_sessions()
    assert len(rows) == 1
    assert rows[0]["session_id"] == sid


def test_an_out_of_range_pid_costs_a_row_a_field_not_the_whole_listing(
    claude, scratch_stores
):
    """The defect above, one field over - and this one reaches ``os.kill``.

    ``os.kill`` answers an int outside C ``pid_t`` with ``OverflowError``,
    which is NOT an ``OSError`` and so passed straight through ``pid_alive``'s
    own handler, out of the executor, and 500'd the sessions poll for EVERY
    project on every tick. Found by adversarial review of a change that was
    then dropped; the fault is older than that change and independent of it
    (DEF-126).
    """
    store, root = claude
    sid = new_uuid()
    write_claude_tree(root, [{"id": sid, "cwd": PROJECT_PATH, "turns": 1}])

    states = root / "sessions"
    states.mkdir(parents=True, exist_ok=True)
    (states / "1.json").write_text(
        json.dumps({"cwd": PROJECT_PATH, "pid": 2**63, "updatedAt": 1}),
        encoding="utf-8",
    )

    rows = store.list_sessions()
    assert len(rows) == 1
    assert rows[0]["session_id"] == sid
    # The unit underneath: a pid no process can hold reads dead, never raises.
    assert store_module.pid_alive(2**63) is False


def test_a_non_positive_pid_is_dead_and_never_gates_the_repair(claude):
    """The defect above, one value over in the other direction (DEF-129).

    ``os.kill(0, 0)`` signals the CALLER's own process group and
    ``os.kill(-N, 0)`` signals group N, so every non-positive pid used to
    measure ALIVE. A record carrying ``"pid": 0`` then made a conversation
    look live forever and the transcript repair a permanent no-op for it -
    with no log and nothing the user could see.
    """
    store, root = claude
    # The unit: a signalling idiom is not a process handle.
    assert store_module.pid_alive(0) is False
    assert store_module.pid_alive(-1) is False
    assert store_module.pid_alive(-os.getpid()) is False

    # The consequence: the repair runs instead of being gated by that record.
    sid = new_uuid()
    path = _compacted(write_claude_tree(root, []), sid)
    states = root / "sessions"
    states.mkdir(parents=True, exist_ok=True)
    (states / "0.json").write_text(
        json.dumps({"pid": 0, "sessionId": sid, "cwd": PROJECT_PATH}),
        encoding="utf-8",
    )

    assert claude_provider.make_continuable(sid) == 1
    assert _chain_root(path)["type"] == "user"


def test_claude_lists_one_row_per_project(claude, scratch_stores):
    store, root = claude
    older, newer = new_uuid(), new_uuid()
    project_dir = write_claude_tree(
        root,
        [
            {"id": older, "cwd": PROJECT_PATH, "turns": 3},
            {"id": newer, "cwd": PROJECT_PATH, "title": "Refactor", "colour": "blue"},
        ],
    )
    touch(project_dir / f"{older}.jsonl", -600)
    touch(project_dir / f"{newer}.jsonl", 0)

    rows = store.list_sessions()
    assert len(rows) == 1
    row = rows[0]
    assert row["project_path"] == PROJECT_PATH
    assert row["encoded_path"] == CLAUDE_ENCODED
    assert row["session_id"] == newer
    # A ``/rename`` record is the conversation's own name and beats the folder.
    assert (row["name"], row["name_source"]) == ("Refactor", "session")
    assert row["extra_sessions"] == 1
    # Claude's own colour maps onto the tab vocabulary, never passed through
    # raw - and it is spelled the British way the wire uses, in the store too.
    assert row["colour"] == "sky"


def test_claude_branches_exclude_the_current_conversation(claude):
    store, root = claude
    first, second = new_uuid(), new_uuid()
    write_claude_tree(
        root,
        [
            {"id": first, "cwd": PROJECT_PATH, "title": "Parent"},
            {"id": second, "cwd": PROJECT_PATH},
        ],
    )
    listing = store.list_branches(CLAUDE_ENCODED)
    assert listing["total"] == 2
    assert len(listing["branches"]) == 1
    assert listing["branches"][0]["session_id"] != listing["current"]
    assert set(store.project_session_ids(CLAUDE_ENCODED)) == {first, second}


def test_claude_switch_touches_and_the_route_side_pin_outlives_recency(claude):
    store, root = claude
    first, second = new_uuid(), new_uuid()
    project_dir = write_claude_tree(
        root, [{"id": first, "cwd": PROJECT_PATH}, {"id": second, "cwd": PROJECT_PATH}]
    )
    # Age the rival: with no store-side pin, `current` resolves by recency,
    # and both transcripts are written in the same second - the switch's own
    # utime must be the unambiguous newest.
    touch(project_dir / f"{second}.jsonl", -600)
    # The target is aged too, so the touch assertion below compares against a
    # clearly-older stamp rather than racing the clock on a same-instant one.
    touch(project_dir / f"{first}.jsonl", -300)
    before = (project_dir / f"{first}.jsonl").stat().st_mtime
    result = store.switch(CLAUDE_ENCODED, first)
    assert result == {"requested": first}
    # The touch is the switch's one remaining side effect - it aligns Claude's
    # own --resume picker - so its loss must redden something.
    assert (project_dir / f"{first}.jsonl").stat().st_mtime > before
    # The route writes the pin once the store's switch returns (state writes
    # are loop-owned, DEF-99/DEF-101), so the fixture reproduces both halves -
    # the same split kimi's test below documents.
    state.write_pin("claude", CLAUDE_ENCODED, first)
    # The pin outlives recency: the other transcript being newer must not drag
    # the row back to it.
    touch(project_dir / f"{second}.jsonl", 60)
    assert store.resolve_current(CLAUDE_ENCODED) == first
    assert store.switch(CLAUDE_ENCODED, new_uuid()) == {"error": "branch_not_found"}


def test_claude_delete_never_touches_the_current_conversation(claude):
    store, root = claude
    keep, drop = new_uuid(), new_uuid()
    project_dir = write_claude_tree(
        root, [{"id": keep, "cwd": PROJECT_PATH}, {"id": drop, "cwd": PROJECT_PATH}]
    )
    # Age the rival: with no store-side pin (DEF-101), `resolve_current` here
    # rides on recency, and both transcripts are written in the same instant -
    # the switch's utime must be the unambiguous newest or glob order decides
    # which conversation the delete protects.
    touch(project_dir / f"{drop}.jsonl", -600)
    store.switch(CLAUDE_ENCODED, keep)
    # The ids that ACTUALLY went, so the core drops exactly those colours.
    assert store.delete_branches(CLAUDE_ENCODED, [keep, drop]) == [drop]
    assert store.project_session_ids(CLAUDE_ENCODED) == [keep]
    # An id already gone was removed by someone else, not a failure.
    assert store.delete_branches(CLAUDE_ENCODED, [drop]) == []


def test_claude_has_no_server_side_fork(claude):
    """The FRONTEND mints a native-flag fork id and carries it on the launch.

    A store-side mint would be a second, competing id for one branch, so the
    branch route serves ``server-copy`` only and this store keeps the contract
    default (unsupported).
    """
    store, _root = claude
    assert store.fork(CLAUDE_ENCODED, new_uuid()) is None


def test_claude_launch_argv(claude):
    store, _root = claude
    session_id, fork_id = new_uuid(), new_uuid()
    assert store.launch_argv("/bin/claude") == ["/bin/claude"]
    assert store.launch_argv("/bin/claude", session_id=session_id) == [
        "/bin/claude",
        "--resume",
        session_id,
    ]
    assert store.launch_argv("/bin/claude", new_session_id=session_id) == [
        "/bin/claude",
        "--session-id",
        session_id,
    ]
    assert store.launch_argv(
        "/bin/claude", session_id=session_id, fork_session_id=fork_id, name="Branch"
    ) == [
        "/bin/claude",
        "--resume",
        session_id,
        "--fork-session",
        "--session-id",
        fork_id,
        "-n",
        "Branch",
    ]
    assert "--dangerously-skip-permissions" in store.launch_argv(
        "/bin/claude", mode="dangerouslySkipPermissions"
    )


def test_claude_parse_session_id_prefers_the_fork(claude):
    store, _root = claude
    parent, fork = new_uuid(), new_uuid()
    assert (
        store.parse_session_id(
            cmdline("claude", "--resume", parent, "--fork-session", "--session-id", fork)
        )
        == fork
    )
    assert store.parse_session_id(cmdline("claude", f"--resume={parent}")) == parent
    assert store.parse_session_id(cmdline("claude")) is None
    # A flag with its value missing must not swallow the next flag as an id.
    assert store.parse_session_id(cmdline("claude", "--resume", "--verbose")) is None


def test_claude_default_colour_reads_the_conversation_not_the_row(claude):
    store, root = claude
    plain, coloured = new_uuid(), new_uuid()
    write_claude_tree(
        root,
        [
            {"id": plain, "cwd": PROJECT_PATH},
            {"id": coloured, "cwd": PROJECT_PATH, "colour": "green"},
        ],
    )
    assert store.default_colour(coloured) == "mint"
    assert store.default_colour(plain) is None
    assert store.default_colour("../escape") is None


# -------------------------------------------------------------------- codex


@pytest.fixture
def codex(scratch_stores, monkeypatch):
    # The live-process dot scans /proc for a running codex; a developer's own
    # session must not decide a test's outcome.
    monkeypatch.setattr(codex_provider, "live_cwds", lambda: set())
    store = CodexStore()
    store.provider_id = "codex"
    return store, scratch_stores / "codex"


def test_codex_reads_the_newest_state_generation(codex, scratch_stores):
    store, root = codex
    old_thread, new_thread = new_uuid(), new_uuid()
    write_codex_db(root, [{"id": new_thread, "name": "Current", "recency_ms": 5000}])
    # An abandoned older generation must never win.
    (root / "state_4.sqlite").write_bytes(b"")
    assert codex_provider.state_db_path(root).name == "state_5.sqlite"
    rows = store.list_sessions()
    assert [row["session_id"] for row in rows] == [new_thread]
    assert rows[0]["encoded_path"] == PROJECT_PATH
    assert (rows[0]["name"], rows[0]["name_source"]) == ("Current", "session")
    assert old_thread not in [row["session_id"] for row in rows]


def test_codex_hides_archived_and_subagent_threads(codex):
    store, root = codex
    visible, archived, sub = new_uuid(), new_uuid(), new_uuid()
    write_codex_db(
        root,
        [
            {"id": visible, "recency_ms": 3000},
            {"id": archived, "archived": True, "recency_ms": 4000},
            {"id": sub, "source": "sub_agent", "recency_ms": 5000},
        ],
    )
    assert [row["session_id"] for row in store.list_sessions()] == [visible]


def test_codex_husks_are_enumerable_but_never_current(codex):
    """A thread with no turns yet must be forkable-watchable, not the row."""
    store, root = codex
    real, husk = new_uuid(), new_uuid()
    write_codex_db(
        root,
        [
            {"id": real, "preview": "hello", "recency_ms": 1000},
            {"id": husk, "has_user_event": False, "recency_ms": 9000},
        ],
    )
    rows = store.list_sessions()
    assert [row["session_id"] for row in rows] == [real]
    listing = store.list_branches(PROJECT_PATH)
    assert listing["current"] == real
    assert [b["session_id"] for b in listing["branches"]] == [husk]


def test_codex_falls_back_to_the_rollout_scan(codex):
    """An unreadable index degrades to a disk scan, never to an empty panel."""
    store, root = codex
    thread = new_uuid()
    rollout = root / "sessions" / "2026" / "08" / "07"
    rollout.mkdir(parents=True)
    (rollout / f"rollout-2026-08-07T10-00-00-{thread}.jsonl").write_text(
        json.dumps({"payload": {"id": thread, "cwd": PROJECT_PATH}}) + "\n",
        encoding="utf-8",
    )
    (root / "state_5.sqlite").write_bytes(b"not a database")
    assert [row["session_id"] for row in store.list_sessions()] == [thread]


def test_codex_switch_answers_without_writing(codex):
    store, root = codex
    current, other = new_uuid(), new_uuid()
    write_codex_db(
        root,
        [
            {"id": current, "preview": "a", "recency_ms": 9000},
            {"id": other, "preview": "b", "recency_ms": 1000},
        ],
    )
    assert store.switch(PROJECT_PATH, other) == {"requested": other}
    assert store.switch(PROJECT_PATH, new_uuid()) == {"error": "branch_not_found"}
    # Not a thread id at all - refused before it can reach an argv.
    assert store.switch(PROJECT_PATH, "--all") is None


def test_codex_launch_argv(codex):
    store, _root = codex
    thread = new_uuid()
    assert store.launch_argv("/bin/codex") == ["/bin/codex"]
    assert store.launch_argv("/bin/codex", session_id=thread) == [
        "/bin/codex",
        "resume",
        thread,
    ]
    assert store.launch_argv("/bin/codex", fork_from=thread) == [
        "/bin/codex",
        "fork",
        thread,
    ]
    assert store.launch_argv(
        "/bin/codex", mode="dangerouslyBypassApprovalsAndSandbox"
    ) == ["/bin/codex", "--dangerously-bypass-approvals-and-sandbox"]
    # A tampered id never becomes an argument.
    assert store.launch_argv("/bin/codex", session_id="--all") == ["/bin/codex"]


def test_codex_parse_session_id(codex):
    store, _root = codex
    thread = new_uuid()
    assert store.parse_session_id(cmdline("codex", "resume", thread)) == thread
    assert (
        store.parse_session_id(cmdline("codex", "resume", "-C", "/tmp", thread))
        == thread
    )
    # A fork argv names the parent, not what the terminal ends up running.
    assert store.parse_session_id(cmdline("codex", "fork", thread)) is None
    assert store.parse_session_id(cmdline("codex")) is None


# --------------------------------------------------------------------- kimi


KIMI_WD = "wd-7788"


@pytest.fixture
def kimi(scratch_stores):
    store = KimiStore(scratch_stores / "kimi")
    store.provider_id = "kimi"
    return store, scratch_stores / "kimi"


def test_kimi_lists_registered_workspaces_only(kimi, scratch_stores):
    store, root = kimi
    session = f"session_{new_uuid()}"
    write_kimi_tree(
        root,
        KIMI_WD,
        [{"id": session, "title": "Ported panel", "custom_title": True, "messages": 4}],
    )
    # A tombstoned workspace keeps its directory but must not produce a row.
    (root / "sessions" / "wd-deleted").mkdir(parents=True)
    rows = store.list_sessions()
    assert len(rows) == 1
    row = rows[0]
    assert row["encoded_path"] == KIMI_WD
    assert row["session_id"] == session
    assert (row["name"], row["name_source"]) == ("Ported panel", "session")
    assert row["message_count"] == 4


def test_kimi_auto_title_does_not_beat_the_folder_name(kimi):
    store, root = kimi
    session = f"session_{new_uuid()}"
    write_kimi_tree(root, KIMI_WD, [{"id": session, "title": "auto summary"}])
    row = store.list_sessions()[0]
    assert (row["name"], row["name_source"]) == ("demo", "basename")


def test_kimi_fork_copies_the_directory_and_appends_the_index(kimi):
    store, root = kimi
    parent = f"session_{new_uuid()}"
    write_kimi_tree(root, KIMI_WD, [{"id": parent, "title": "Parent", "messages": 2}])
    new_id = store.fork(KIMI_WD, parent, "Branch")
    assert new_id and new_id != parent
    copied = root / "sessions" / KIMI_WD / new_id
    assert copied.is_dir()
    state = json.loads((copied / "state.json").read_text(encoding="utf-8"))
    assert state["title"] == "Branch"
    assert state["isCustomTitle"] is True
    assert state["workDir"] == PROJECT_PATH
    # The copy carries the conversation, so its transcript comes along.
    assert (copied / "agents" / "main" / "wire.jsonl").read_text().count("\n") == 2
    index = (root / "session_index.jsonl").read_text(encoding="utf-8")
    assert new_id in index
    assert store.fork(KIMI_WD, "session_not-a-uuid") is None


def test_kimi_fork_default_title_names_its_parent(kimi):
    store, root = kimi
    parent = f"session_{new_uuid()}"
    write_kimi_tree(root, KIMI_WD, [{"id": parent, "title": "Parent"}])
    new_id = store.fork(KIMI_WD, parent)
    state = json.loads(
        (root / "sessions" / KIMI_WD / new_id / "state.json").read_text("utf-8")
    )
    assert state["title"] == "Fork of Parent"


def test_kimi_delete_keeps_the_current_and_prunes_the_index(kimi):
    store, root = kimi
    keep = f"session_{new_uuid()}"
    drop = f"session_{new_uuid()}"
    write_kimi_tree(
        root,
        KIMI_WD,
        [
            {"id": keep, "updated": "2026-08-02T10:00:00.000Z"},
            {"id": drop, "updated": "2026-08-01T10:00:00.000Z"},
        ],
    )
    touch(root / "sessions" / KIMI_WD / keep / "state.json", 0)
    touch(root / "sessions" / KIMI_WD / drop / "state.json", -600)
    assert store.delete_branches(KIMI_WD, [keep, drop]) == [drop]
    assert store.resolve_current(KIMI_WD) == keep
    assert drop not in (root / "session_index.jsonl").read_text(encoding="utf-8")


def test_kimi_pin_outlives_recency(kimi):
    """Work continuing in another conversation must not drag the row back."""
    store, root = kimi
    pinned = f"session_{new_uuid()}"
    busier = f"session_{new_uuid()}"
    write_kimi_tree(root, KIMI_WD, [{"id": pinned}, {"id": busier}])
    touch(root / "sessions" / KIMI_WD / pinned / "state.json", -600)
    touch(root / "sessions" / KIMI_WD / busier / "state.json", 0)
    assert store.resolve_current(KIMI_WD) == busier

    # The route writes the pin once the store's switch returns, so the fixture
    # reproduces both halves.
    store.switch(KIMI_WD, pinned)
    state.write_pin("kimi", KIMI_WD, pinned)
    assert state.read_pin("kimi", KIMI_WD) == pinned
    # The other conversation is worked in again and overtakes on mtime.
    touch(root / "sessions" / KIMI_WD / busier / "state.json", 60)
    assert store.resolve_current(KIMI_WD) == pinned


def test_kimi_launch_argv_and_argv_read_back(kimi):
    store, _root = kimi
    session = f"session_{new_uuid()}"
    assert store.launch_argv("/bin/kimi") == ["/bin/kimi"]
    assert store.launch_argv("/bin/kimi", session_id=session) == [
        "/bin/kimi",
        "-S",
        session,
    ]
    assert store.launch_argv("/bin/kimi", mode="yoloMode") == ["/bin/kimi", "--yolo"]
    # The two directions must agree or terminal reuse degrades to duplicates.
    assert store.parse_session_id(cmdline(*store.launch_argv("kimi", session_id=session)))
    assert kimi_resume_id(cmdline("kimi", "-S", session)) == session
    assert kimi_resume_id(cmdline("kimi", "-c")) is None
    assert normalize_session_id(session[8:]) == session
    assert normalize_session_id("nonsense") is None


def test_kimi_derived_colour_is_stable_and_in_vocabulary(kimi):
    session = f"session_{new_uuid()}"
    colour = derived_colour(session)
    assert colour in ("rose", "peach", "lemon", "mint", "sky", "lavender")
    assert derived_colour(session) == colour
    # Bound to the SAME literals Jest pins for the TypeScript hash
    # (src/__tests__/colour.spec.ts). Both runtimes hash the same string over
    # the same ordered six-colour vocabulary, and nothing else forces them to
    # agree: reorder either list and a fork inherits the server's colour while
    # the tab is immediately repainted the frontend's, one visible flip per
    # fork, with every test still green.
    assert derived_colour("session_demo") == "peach"
    assert derived_colour("11111111-1111-4111-8111-111111111111") == "peach"
    assert derived_colour("22222222-2222-4222-8222-222222222222") == "lavender"
    assert kimi[0].default_colour(session) == colour


# ------------------------------------------------------------------- gemini


GEMINI_SHORT_ID = "demo-4c5d"


@pytest.fixture
def gemini(scratch_stores):
    store = GeminiStore()
    store.provider_id = "gemini"
    return store, scratch_stores / "home" / ".gemini"


def test_gemini_scans_the_registry_and_chat_files(gemini):
    store, root = gemini
    session = new_uuid()
    write_gemini_tree(root, GEMINI_SHORT_ID, [{"id": session, "messages": 4}])
    rows = store.list_sessions()
    assert len(rows) == 1
    row = rows[0]
    assert row["encoded_path"] == GEMINI_SHORT_ID
    assert row["session_id"] == session
    assert row["message_count"] == 4
    # The first prompt is read for the BRANCH label, not put on the row - no
    # client reads it there.
    assert store.list_branches(GEMINI_SHORT_ID) is not None


def test_gemini_skips_subagent_transcripts(gemini):
    store, root = gemini
    real, sub = new_uuid(), new_uuid()
    write_gemini_tree(
        root,
        GEMINI_SHORT_ID,
        [{"id": real, "summary": "Main"}, {"id": sub, "kind": "subagent"}],
    )
    listing = store.list_branches(GEMINI_SHORT_ID)
    assert listing["total"] == 1
    assert listing["current"] == real


def test_gemini_fork_rewrites_every_metadata_record(gemini):
    store, root = gemini
    parent = new_uuid()
    chats = write_gemini_tree(
        root, GEMINI_SHORT_ID, [{"id": parent, "summary": "Parent", "messages": 2}]
    )
    # A later `$set` re-sends the id, so stamping the head alone would leave the
    # parent's id in the copy.
    source = next(chats.iterdir())
    with source.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"$set": {"sessionId": parent, "summary": "Parent"}}) + "\n")

    new_id = store.fork(GEMINI_SHORT_ID, parent, "Branch")
    assert new_id and new_id != parent
    copy = next(p for p in chats.iterdir() if new_id[:8] in p.name)
    text = copy.read_text(encoding="utf-8")
    assert parent not in text
    assert text.count(new_id) == 2
    assert '"summary":"Branch"' in text
    listing = store.list_branches(GEMINI_SHORT_ID)
    assert {b["session_id"] for b in listing["branches"]} | {listing["current"]} == {
        parent,
        new_id,
    }


def test_gemini_fork_copies_a_record_carrying_a_line_separator_untouched(gemini):
    """A raw U+2028 and non-ASCII text survive the copy byte for byte.

    ``str.splitlines()`` breaks on U+2028, U+2029 and U+0085 - which a Node
    CLI's ``JSON.stringify`` writes unescaped - and ``ensure_ascii`` at its
    default rewrites every non-ASCII character, so either one re-authors the
    file the fork docstring says is copied through untouched.
    """
    store, root = gemini
    parent = new_uuid()
    chats = write_gemini_tree(
        root, GEMINI_SHORT_ID, [{"id": parent, "summary": "Parent", "messages": 2}]
    )
    source = next(chats.iterdir())
    lines = source.read_text(encoding="utf-8").split("\n")
    content = "line one\u2028line two za\u017c\u00f3\u0142\u0107"
    lines[1] = json.dumps(
        {"type": "user", "content": content},
        separators=(",", ":"),
        ensure_ascii=False,
    )
    source.write_text("\n".join(lines), encoding="utf-8")
    before = [line for line in source.read_bytes().split(b"\n") if line.strip()]

    new_id = store.fork(GEMINI_SHORT_ID, parent, "Branch")
    assert new_id
    copy = next(p for p in chats.iterdir() if new_id[:8] in p.name)
    raw = copy.read_bytes()
    after = [line for line in raw.split(b"\n") if line.strip()]
    assert len(after) == len(before)
    for line in after:
        json.loads(line)
    assert "\u2028".encode() in raw and b"\\u2028" not in raw
    assert "za\u017c\u00f3\u0142\u0107".encode() in raw and b"\\u017c" not in raw

    # The legacy single-object shape is not written by ``write_gemini_tree``,
    # so its own re-encode is pinned with a direct call.
    legacy = gemini_provider.stamp_fork(
        json.dumps(
            {
                "sessionId": parent,
                "summary": "podsumowanie",
                "startTime": "x",
                "lastUpdated": "y",
                "messages": [{"type": "user", "content": "za\u017c\u00f3\u0142\u0107"}],
            },
            separators=(",", ":"),
            ensure_ascii=False,
        ),
        new_uuid(),
        "Fork",
    )
    assert legacy is not None
    assert "\\u" not in legacy


def test_gemini_lists_a_chat_whose_metadata_record_carries_a_line_separator(gemini):
    """A separator inside the METADATA record hides the whole conversation.

    Split on it, the record shreds into fragments, ``_parse_chat`` never sees
    ``sessionId`` and the conversation is absent from the listing - a read-only
    path, not the fork file.
    """
    store, root = gemini
    parent = new_uuid()
    chats = write_gemini_tree(
        root, GEMINI_SHORT_ID, [{"id": parent, "summary": "Parent", "messages": 2}]
    )
    source = next(chats.iterdir())
    lines = source.read_text(encoding="utf-8").split("\n")
    meta = json.loads(lines[0])
    meta["summary"] = "parent\u2028chat"
    lines[0] = json.dumps(meta, separators=(",", ":"), ensure_ascii=False)
    source.write_text("\n".join(lines), encoding="utf-8")

    listing = store.list_branches(GEMINI_SHORT_ID)
    assert listing is not None
    seen = {b["session_id"] for b in listing["branches"]} | {listing["current"]}
    assert parent in seen
    assert store.fork(GEMINI_SHORT_ID, parent, "Branch") is not None


def test_gemini_fork_declines_a_record_that_cannot_be_encoded(gemini):
    """A lone surrogate survives ``json.loads`` and fails only at the write,
    where it raises ``UnicodeEncodeError`` - a ``ValueError``, not an
    ``OSError``. The store method the route awaits bare must not be the thing
    that raises, and no zero-byte orphan may be left in the chats dir."""
    store, root = gemini
    parent = new_uuid()
    chats = write_gemini_tree(
        root, GEMINI_SHORT_ID, [{"id": parent, "summary": "Parent"}]
    )
    source = next(chats.iterdir())
    with source.open("a", encoding="utf-8") as fh:
        fh.write('{"type":"user","content":"bad \\ud800 here","id":"m1"}\n')
    before = sorted(p.name for p in chats.iterdir())

    assert store.fork(GEMINI_SHORT_ID, parent, "Branch") is None
    assert sorted(p.name for p in chats.iterdir()) == before


def test_gemini_launch_argv_resumes_by_chat_file_never_by_resume(gemini):
    """Resume names the conversation's FILE, never ``--resume``.

    ``--resume`` takes ``latest`` or a listing index - a position in a list
    re-sorted by start time - so it cannot address a conversation by id and a
    clicked row would open whatever had drifted into that slot
    (docs/defects.md DEF-8, acc-crit "Gemini / Resume").
    """
    store, root = gemini
    session = new_uuid()
    chats = write_gemini_tree(root, GEMINI_SHORT_ID, [{"id": session}])
    chat_file = next(p for p in chats.iterdir() if session[:8] in p.name)

    argv = store.launch_argv("/bin/gemini", session_id=session)
    assert argv == ["/bin/gemini", "--session-file", str(chat_file)]
    assert "--resume" not in argv

    # A conversation whose file is gone REFUSES the launch: a bare ``gemini``
    # would open a brand-new conversation in the clicked row's place, which
    # reads as the resume that was asked for. The route turns this into the
    # 404 the panel already renders.
    chat_file.unlink()
    with pytest.raises(SessionNotFound):
        store.launch_argv("/bin/gemini", session_id=session)


def test_gemini_launch_argv_starts_and_modes(gemini):
    store, _root = gemini
    session = new_uuid()
    assert store.launch_argv("/bin/gemini", new_session_id=session) == [
        "/bin/gemini",
        "--session-id",
        session,
    ]
    assert store.launch_argv("/bin/gemini", mode="yoloMode") == [
        "/bin/gemini",
        "--yolo",
    ]
    # The approval ladder is gone (DEF-111): an old `approvalMode` token a
    # stale client could still send is ignored, never passed to the CLI.
    assert store.launch_argv("/bin/gemini", mode="approvalMode=plan") == [
        "/bin/gemini"
    ]


def test_gemini_parse_session_id_reads_the_chat_file(gemini):
    """A resume carries a path, and the filename holds only the id's first
    eight characters - so the whole id is read back out of the file itself."""
    store, root = gemini
    session = new_uuid()
    chats = write_gemini_tree(root, GEMINI_SHORT_ID, [{"id": session}])
    chat_file = next(p for p in chats.iterdir() if session[:8] in p.name)
    assert (
        store.parse_session_id(cmdline("gemini", "--session-file", str(chat_file)))
        == session
    )
    # A path that is not a conversation is never claimed for one.
    assert (
        store.parse_session_id(cmdline("gemini", "--session-file", "/nope.jsonl"))
        is None
    )


def test_gemini_parse_session_id_ignores_the_positional_forms(gemini):
    store, _root = gemini
    session = new_uuid()
    assert store.parse_session_id(cmdline("gemini", "--resume", session)) == session
    assert store.parse_session_id(cmdline("gemini", "--session-id", session)) == session
    assert store.parse_session_id(cmdline("gemini", "--resume", "latest")) is None
    assert store.parse_session_id(cmdline("gemini", "--resume", "3")) is None
    assert gemini_resume_id(cmdline("gemini")) is None


def test_gemini_remove_drops_only_the_conversations(gemini):
    store, root = gemini
    session = new_uuid()
    write_gemini_tree(root, GEMINI_SHORT_ID, [{"id": session}])
    project_dir = root / "tmp" / GEMINI_SHORT_ID
    assert store.remove(GEMINI_SHORT_ID) == [session]
    assert not (project_dir / "chats").exists()
    # The CLI's own working state and its registry survive.
    assert (project_dir / ".project_root").is_file()
    assert (root / "projects.json").is_file()


@pytest.mark.parametrize("node_comm", ["MainThread", "node-MainThread", "node"])
def test_gemini_claims_only_a_node_process_that_is_actually_gemini(
    gemini, monkeypatch, node_comm
):
    """Every node process reports the same comm, so the argv decides.

    Whatever Node writes there is what a plain ``node`` writes too, so a comm match alone claims ``npm run dev``
    in a registered project as a running conversation - and the colour loop
    then writes that terminal's tab colour into gemini's store under a
    cwd-guessed id.
    """
    store, _root = gemini
    # Patched in gemini's own namespace, and over EVERY spelling Node uses for
    # its main thread - `MainThread` up to Node 24, `node-MainThread` from 26.
    # Pinning one of them here is what hid the version skew that made Gemini
    # terminals unidentifiable on the Node releases the CLI supports.
    monkeypatch.setattr(gemini_provider, "process_comm", lambda pid: node_comm)
    cmdlines = {
        11: cmdline("node", "/home/lab/project/node_modules/.bin/vite", "dev"),
        22: cmdline(
            "node", "/usr/lib/node_modules/@google/gemini-cli/dist/gemini.js"
        ),
        33: None,
        44: cmdline("node", "/home/lab/projects/my-gemini-app/server.js", "--port"),
    }
    monkeypatch.setattr(
        gemini_provider, "process_cmdline", lambda pid: cmdlines.get(pid)
    )
    assert store.owns_pid(11) is False
    assert store.owns_pid(22) is True
    # An unreadable cmdline is never claimed either.
    assert store.owns_pid(33) is False
    # The name of the folder the user works in is not the CLI: a substring
    # match claims this one, an argv ELEMENT that IS the bundle does not.
    assert store.owns_pid(44) is False


def test_a_native_binary_store_claims_a_pid_by_comm_alone(claude, monkeypatch):
    """The default identity is the comm, which is exact for a native binary."""
    store, _root = claude
    monkeypatch.setattr(store_module, "process_comm", lambda pid: "claude")
    assert store.owns_pid(1) is True
    monkeypatch.setattr(store_module, "process_comm", lambda pid: "bash")
    assert store.owns_pid(1) is False


# ------------------------------------------------ `claude -c` continuability


def _compacted(project_dir, sid, *, compacted=True):
    """A transcript shaped as Claude writes one, optionally post-compaction."""
    boundary, first, second = new_uuid(), new_uuid(), new_uuid()
    records = [{"type": "custom-title", "customTitle": "Ported", "sessionId": sid}]
    if compacted:
        records.append(
            {
                "parentUuid": None,
                "type": "system",
                "subtype": "compact_boundary",
                "content": "Conversation compacted",
                "uuid": boundary,
                "sessionId": sid,
                "cwd": PROJECT_PATH,
                "version": "2.1.218",
                "gitBranch": "main",
                "logicalParentUuid": second,
                "compactMetadata": {"trigger": "manual", "preTokens": 607119},
            }
        )
    records.append(
        {
            "parentUuid": boundary if compacted else None,
            "type": "user",
            "uuid": first,
            "cwd": PROJECT_PATH,
            "sessionId": sid,
        }
    )
    path = project_dir / f"{sid}.jsonl"
    path.write_text(
        "\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8"
    )
    path.chmod(0o600)
    return path


def _records(path):
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _chain_root(path):
    return next(
        (r for r in _records(path) if r.get("parentUuid") is None and r.get("uuid")),
        None,
    )


def _live_record(root, sid):
    """A pid file claiming a RUNNING process serves this conversation."""
    states = root / "sessions"
    states.mkdir(parents=True, exist_ok=True)
    (states / f"{os.getpid()}.json").write_text(
        json.dumps({"pid": os.getpid(), "sessionId": sid, "cwd": PROJECT_PATH}),
        encoding="utf-8",
    )


def test_a_compacted_transcript_gets_a_root_claude_c_will_select(claude):
    """`claude -c` walks a conversation to its chain root and refuses one rooted
    at a compact_boundary - the shape every conversation takes once compacted -
    then falls back to the next transcript. A project whose only conversation
    was compacted therefore answers "No conversation found to continue" against
    a transcript that is intact and still resumable by id.
    """
    store, root = claude
    sid = new_uuid()
    path = _compacted(write_claude_tree(root, []), sid)

    assert claude_provider.ensure_continuable(path) is True

    fixed = _chain_root(path)
    assert (fixed["type"], fixed["isMeta"]) == ("user", True)
    # Nothing is removed. The boundary survives, re-pointed at the new root,
    # and keeps the metadata saying what was compacted away.
    boundary = next(r for r in _records(path) if r.get("subtype") == "compact_boundary")
    assert boundary["parentUuid"] == fixed["uuid"]
    assert boundary["compactMetadata"]["preTokens"] == 607119
    assert boundary["logicalParentUuid"]


def test_an_already_continuable_transcript_is_left_byte_for_byte(claude):
    """The common case, and the one that makes a repair on every launch safe to
    run: a conversation that was never compacted is not rewritten at all."""
    store, root = claude
    sid = new_uuid()
    path = _compacted(write_claude_tree(root, []), sid, compacted=False)
    before = path.read_bytes()

    assert claude_provider.ensure_continuable(path) is False
    assert path.read_bytes() == before


def test_a_transcript_that_cannot_be_parsed_whole_is_declined(claude):
    """A file we cannot read whole is one we cannot write back whole, and half a
    transcript is worse than an unhelpful `-c`."""
    store, root = claude
    sid = new_uuid()
    path = _compacted(write_claude_tree(root, []), sid)
    with path.open("a", encoding="utf-8") as handle:
        handle.write("{not json\n")
    before = path.read_bytes()

    assert claude_provider.ensure_continuable(path) is False
    assert path.read_bytes() == before


def test_a_live_conversation_is_never_rewritten(claude):
    """Transcripts are append-only, so a rewrite racing an append drops the
    appended turns. A conversation open elsewhere is left alone entirely."""
    store, root = claude
    sid = new_uuid()
    path = _compacted(write_claude_tree(root, []), sid)
    before = path.read_bytes()
    _live_record(root, sid)

    assert claude_provider.make_continuable(sid) == 0
    assert path.read_bytes() == before


def test_switching_to_a_compacted_conversation_makes_claude_c_select_it(claude):
    """Wiring, panel side. The switch already touches the mtime so the picker
    sorts this transcript first; being selectable at all is the other half."""
    store, root = claude
    sid = new_uuid()
    path = _compacted(write_claude_tree(root, []), sid)

    assert store.switch(CLAUDE_ENCODED, sid) == {"requested": sid}
    assert _chain_root(path)["type"] == "user"


def test_launching_a_compacted_conversation_makes_claude_c_select_it(claude):
    """Wiring, launch side - the path a user actually takes to open a session,
    and the one that repairs a project the panel has never switched."""
    store, root = claude
    sid = new_uuid()
    path = _compacted(write_claude_tree(root, []), sid)

    assert store.launch_argv("/bin/claude", session_id=sid) == [
        "/bin/claude",
        "--resume",
        sid,
    ]
    assert _chain_root(path)["type"] == "user"


def test_the_repair_keeps_the_transcript_private(claude):
    """The rewrite goes through a temp file, which is created with the process
    umask rather than the mode of the file it replaces. A conversation is not
    world-readable and must not become so by being repaired."""
    store, root = claude
    sid = new_uuid()
    path = _compacted(write_claude_tree(root, []), sid)

    assert claude_provider.ensure_continuable(path) is True
    assert path.stat().st_mode & 0o777 == 0o600


class _AppendsWhileRead:
    """A transcript that grows while it is being read - a live CLI writing a turn
    the reader has already passed."""

    def __init__(self, path, turn):
        self._path = path
        self._turn = turn
        self.name = path.name

    def __fspath__(self):
        return str(self._path)

    def stat(self):
        return self._path.stat()

    def with_name(self, name):
        return self._path.with_name(name)

    def open(self, *args, **kwargs):
        content = self._path.read_text(encoding="utf-8")
        with self._path.open("a", encoding="utf-8") as appender:
            appender.write(json.dumps(self._turn) + "\n")
        return io.StringIO(content)


def test_an_append_racing_the_read_is_never_published(claude):
    """The size/mtime guard is anchored BEFORE the read. A turn landing while the
    transcript is read would otherwise already be inside the baseline, so the
    guard would agree with itself and publish a record list that never held it -
    losing what the user just typed, and reporting success."""
    store, root = claude
    sid = new_uuid()
    path = _compacted(write_claude_tree(root, []), sid)
    turn = {
        "parentUuid": new_uuid(),
        "type": "user",
        "uuid": new_uuid(),
        "sessionId": sid,
    }

    assert claude_provider.ensure_continuable(_AppendsWhileRead(path, turn)) is False
    assert turn["uuid"] in {r.get("uuid") for r in _records(path)}


def test_the_repair_rewrites_only_the_two_records_it_touches(claude):
    """Writing into another program's append-only file is authorised here on the
    grounds that the repair is additive. Claude writes compact, unescaped JSON,
    so re-encoding with Python's defaults would rewrite every line and inflate
    the file - measured at 1.8x on a transcript that is mostly non-ASCII."""
    store, root = claude
    sid = new_uuid()
    boundary, tail = new_uuid(), new_uuid()
    records = [
        {"type": "custom-title", "customTitle": "Ported - caf\u00e9", "sessionId": sid},
        {
            "parentUuid": None,
            "type": "system",
            "subtype": "compact_boundary",
            "uuid": boundary,
            "sessionId": sid,
            "cwd": PROJECT_PATH,
        },
        {
            "parentUuid": boundary,
            "type": "user",
            "uuid": tail,
            "message": {"role": "user", "content": "\u65e5\u672c\u8a9e na\u00efve"},
        },
    ]
    path = write_claude_tree(root, []) / f"{sid}.jsonl"
    path.write_text(
        "".join(
            json.dumps(r, separators=(",", ":"), ensure_ascii=False) + "\n"
            for r in records
        ),
        encoding="utf-8",
    )
    path.chmod(0o600)
    original = path.read_bytes().splitlines()

    assert claude_provider.ensure_continuable(path) is True

    after = path.read_bytes().splitlines()
    # One record added, the boundary re-pointed, and nothing else re-encoded.
    assert len(after) == len(original) + 1
    assert after[0] == original[0]
    assert after[-1] == original[-1]
    assert "\u65e5\u672c\u8a9e".encode() in after[-1]


def test_a_record_that_cannot_be_encoded_declines_instead_of_raising(claude):
    """A lone surrogate survives `json.loads` and fails only at the write, where
    it raises `UnicodeEncodeError` - a `ValueError`, not an `OSError`. The store
    method the route awaits bare must not be the thing that raises, and the
    transcript must be left exactly as it was found."""
    store, root = claude
    sid = new_uuid()
    project_dir = write_claude_tree(root, [])
    path = _compacted(project_dir, sid)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(
            '{"parentUuid":"p","type":"user","uuid":"x",'
            '"message":{"role":"user","content":"\\ud800"}}\n'
        )
    before = path.read_bytes()

    assert claude_provider.ensure_continuable(path) is False
    assert path.read_bytes() == before
    assert list(project_dir.glob("*.continuable")) == []
    assert store.switch(CLAUDE_ENCODED, sid) == {"requested": sid}
