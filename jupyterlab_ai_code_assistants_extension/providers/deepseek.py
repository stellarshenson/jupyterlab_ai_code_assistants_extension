"""DeepSeek - the DeepSeek Harness ``dsh`` CLI.

New provider: no standalone extension preceded it, so the store below is
written against the harness's own on-disk format, verified in the installed
bundle of ``@deepseek-ai/dsh`` 0.1.5 (``dsh-session-persistence-jsonl``).

The store reads ``$DSH_HOME/sessions`` (``~/.dsh/sessions`` by default): one
directory per project named ``--<key>--``, the key being the project path
with its separators collapsed to ``-``; under it one directory per
conversation, named by the conversation id; inside, the log
``session.v<N>.jsonl.zstd`` - a header line, then one JSON event per line,
stored as concatenated Zstandard frames. The harness reads the numerically
highest generation ``N`` and so does this store; a root written with
``compression: 'none'`` holds the same lines as plain ``session.v<N>.jsonl``.

Three consequences shape everything below:

* the ``--<key>--`` directory name IS the ``encoded_path``. The key is a lossy
  encoding, so the project path is read from the header line's ``cwd``
* the harness has no interactive terminal surface: ``dsh --profile web``
  serves a browser UI that lists and resumes the project's conversations, and
  ``dsh --profile headless`` runs one task and exits. A launch therefore
  starts the web server in the project directory - ``--no-open``, because
  the browser is on the user's side of JupyterLab, and ``--port 0``, so the
  OS picks a free port - and the terminal shows the ``dsh web:`` line that
  carries the authenticated URL. No flag names a conversation, so a row's
  Open is the project's web UI rather than that one conversation, and every
  launch of a project reads the same
* no fork verb and no colour concept: branching copies the log under a fresh
  id (the ``server-copy`` strategy), and a tint only ever comes from the
  extension's own colour store

Favourites and the current-conversation pin live in the extension's own state
directory (``core.state``), never under ``$DSH_HOME`` - the harness's files
are read, never written, apart from the logs the user explicitly forks or
deletes.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import uuid
from pathlib import Path

import zstandard

from ..core import state
from ..core.registry import Capabilities, ProviderDescriptor
from ..core.store import (
    NODE_COMMS,
    FileMemo,
    SessionNotFound,
    SessionStore,
    cmdline_args,
    dispose_path,
    is_safe_segment,
    process_cmdline,
    process_comm,
)

# A refused deletion is otherwise invisible: the count simply comes back short
# and the server log is empty, which is where an admin looks first.
_log = logging.getLogger(__name__)


DSH_HOME_ENV = "DSH_HOME"
DSH_DIRNAME = ".dsh"
SESSIONS_DIRNAME = "sessions"

# The harness mints ``session-<uuid4>`` and names the conversation's directory
# after it, so the charset is what keeps a tampered id off a path join.
SESSION_ID_RE = re.compile(
    r"session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)
# The harness's own project-key shape: safe code units kept, every other one
# escaped as ``~XXXX``, the whole wrapped in ``--``. Conversations with no
# working directory land in ``_no-cwd``, which never matches - there is no
# project to launch them in.
PROJECT_KEY_RE = re.compile(r"--[A-Za-z0-9._~-]+--")
# ``session.v3.jsonl`` or ``session.v3.jsonl.zstd``; the first released
# generation carries no version segment.
LOG_RE = re.compile(r"session(?:\.v(\d+))?\.jsonl(\.zstd)?")

# Each stored line is one ``JSON.stringify`` of an event whose first key is
# ``type``, so the prefix is an exact test of the event kind at the cost of a
# string compare - a transcript runs to megabytes and the count is display
# only, so the message lines are never parsed.
_MESSAGE_PREFIXES = ('{"type":"user/message"', '{"type":"assistant/message"')
_TITLE_PREFIX = '{"type":"session/title"'

# Per-log parse memo: a log is re-read only when its mtime or size changed.
_meta_memo = FileMemo()


def dsh_home() -> Path:
    """The harness's storage root: ``$DSH_HOME``, else ``~/.dsh``.

    Resolved on every call rather than at import, exactly as the harness
    resolves it, so pointing either variable at a scratch directory moves the
    extension's view and the assistant's own writes together.
    """
    override = os.environ.get(DSH_HOME_ENV, "").strip()
    return Path(override) if override else Path.home() / DSH_DIRNAME


def read_log(path: Path) -> str | None:
    """A log's text, or None when it cannot be read or decoded.

    The compressed form is a concatenation of frames. A torn final frame - the
    harness crashed mid-append - contributes the blocks it holds whole and
    nothing after them, which is the harness's own recovery rule; the harness
    rewrites the tail on its next write-open. Only a frame that is corrupt in
    what it does hold fails the decode.
    """
    try:
        raw = path.read_bytes()
        if path.suffix == ".zstd":
            raw = zstandard.ZstdDecompressor().stream_reader(
                raw, read_across_frames=True
            ).read()
    except (OSError, zstandard.ZstdError):
        return None
    return raw.decode("utf-8", "replace")


def _title_event(line: str) -> dict | None:
    """A ``session/title`` record with its ``data`` dict, or None."""
    if not line.startswith(_TITLE_PREFIX):
        return None
    try:
        record = json.loads(line)
    except ValueError:
        return None
    if not isinstance(record, dict) or not isinstance(record.get("data"), dict):
        return None
    return record


def _parse_log(path: Path, st: os.stat_result) -> dict | None:
    """Header and display metadata of one log, or None when it is not one.

    Only the header and the ``session/title`` events are parsed; message
    events are counted by prefix (see ``_MESSAGE_PREFIXES``). The newest title
    wins, since the harness re-titles a conversation as it grows. The mtime is
    recorded from the stat the memo already took: the memo re-parses on any
    change to it, so the stored value is always the file's current one.
    """
    text = read_log(path)
    if text is None:
        return None
    # A final line with no newline is a record torn mid-write; it is not a
    # message and not a title, so it is dropped rather than read.
    lines = text.split("\n")[:-1]
    if not lines:
        return None
    try:
        header = json.loads(lines[0])
    except ValueError:
        return None
    if not isinstance(header, dict) or header.get("type") != "session":
        return None
    session_id = header.get("id")
    cwd = header.get("cwd")
    if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
        return None
    if not isinstance(cwd, str) or not cwd:
        return None
    count = 0
    title = None
    for line in lines[1:]:
        if line.startswith(_MESSAGE_PREFIXES):
            count += 1
            continue
        record = _title_event(line)
        candidate = record["data"].get("title") if record else None
        if isinstance(candidate, str) and candidate.strip():
            title = candidate.strip()
    return {
        "session_id": session_id,
        "cwd": cwd,
        "subagent": header.get("origin") == "subagent",
        "title": title,
        "message_count": count,
        "mtime_ms": int(st.st_mtime * 1000),
    }


def log_file(session_dir: Path) -> Path | None:
    """The conversation's current log: the highest generation present."""
    best: tuple[int, Path] | None = None
    try:
        children = list(session_dir.iterdir())
    except OSError:
        return None
    for child in children:
        match = LOG_RE.fullmatch(child.name)
        if match is None or not child.is_file():
            continue
        version = int(match.group(1) or 0)
        if best is None or version > best[0]:
            best = (version, child)
    return best[1] if best else None


def retitle(text: str, name: str) -> str | None:
    """Rewrite the newest ``session/title`` event to carry ``name``.

    None when the log holds no title event. The harness records a title only
    as an event and this store writes no events of its own, so a log the
    harness has not titled yet offers nothing to rewrite - and a title record
    invented here would be one whose shape only THIS reader is known to
    accept, leaving the panel showing a name the web UI never does.
    """
    lines = text.split("\n")
    for index in range(len(lines) - 1, 0, -1):
        record = _title_event(lines[index])
        if record is None:
            continue
        record["data"]["title"] = name
        lines[index] = json.dumps(record, separators=(",", ":"), ensure_ascii=False)
        return "\n".join(lines)
    return None


def stamp_fork(text: str, new_id: str, name: str) -> str:
    """Rewrite a log's text as a fork: the header under ``new_id``, the newest
    title event carrying ``name``.

    Only those two records change; every other event is the conversation
    being branched and is copied through byte for byte. A log that carries no
    title event keeps its lines as they are and the fork is listed under the
    project's name, since the harness records a title only as an event and
    this store writes no events of its own. ``text`` is a listed log, so its
    first line is a header.
    """
    lines = text.split("\n")
    header = json.loads(lines[0])
    header["id"] = new_id
    lines[0] = json.dumps(header, separators=(",", ":"), ensure_ascii=False)
    stamped = "\n".join(lines)
    return retitle(stamped, name) or stamped


def encode_log(text: str, compressed: bool) -> bytes:
    """The bytes of a log in the harness's own layout: the header line alone in
    the first frame, every event after it in a second, both checksummed - the
    harness's listing reads only the first frame and validates it as a header.
    """
    if not compressed:
        return text.encode("utf-8")
    header, _, events = text.partition("\n")
    compressor = zstandard.ZstdCompressor(write_checksum=True)
    out = compressor.compress((header + "\n").encode("utf-8"))
    if events:
        out += compressor.compress(events.encode("utf-8"))
    return out


class DeepSeekStore(SessionStore):
    """One directory per project, one directory per conversation."""

    # The harness is a Node script, so the pty's own process is node and its
    # comm is whatever this Node release names its main thread - the same for
    # every node process on the machine, which is why ``owns_pid`` confirms
    # the argv as well.
    comm_name = "node-MainThread"

    @property
    def root(self) -> Path:
        """Resolved at call time, not construction: the store is instantiated
        at import and the scratch-directory override is set per test run."""
        return dsh_home() / SESSIONS_DIRNAME

    # -- paths -----------------------------------------------------------

    def _project_dir(self, encoded_path: str) -> Path | None:
        """``<root>/--<key>--``, rejecting anything that is not a project key.

        The key arrives from the client, so it is gated as a single path
        segment against the harness's own charset before the join. Existence
        is not required - a caller that needs the directory checks it.
        """
        if not is_safe_segment(encoded_path) or not PROJECT_KEY_RE.fullmatch(
            encoded_path
        ):
            return None
        return self.root / encoded_path

    def _project_dirs(self) -> list[Path]:
        try:
            children = sorted(self.root.iterdir())
        except OSError:
            return []
        return [
            child
            for child in children
            if child.is_dir() and PROJECT_KEY_RE.fullmatch(child.name)
        ]

    # -- enumeration -----------------------------------------------------

    def _sessions(self, project_dir: Path) -> dict[str, tuple[Path, dict]]:
        """``id -> (log, metadata)`` for every conversation of a project.

        Sub-agent conversations are skipped - the harness stores them beside
        their parent, under an ``origin`` mark in the header. Anything
        unreadable, or whose header names another id than its directory, is
        skipped rather than surfaced as a broken row.
        """
        out: dict[str, tuple[Path, dict]] = {}
        try:
            children = sorted(project_dir.iterdir())
        except OSError:
            return out
        for child in children:
            if not child.is_dir() or not SESSION_ID_RE.fullmatch(child.name):
                continue
            log = log_file(child)
            if log is None:
                continue
            meta = _meta_memo.get(log, _parse_log)
            if meta is None or meta["subagent"] or meta["session_id"] != child.name:
                continue
            out[child.name] = (log, meta)
        return out

    def _current(
        self, pinned: str | None, sessions: dict[str, tuple[Path, dict]]
    ) -> tuple[Path, dict] | None:
        """The core's pin-or-newest rule over the logs' mtimes."""
        current = state.pick_current(
            pinned, {sid: meta["mtime_ms"] for sid, (_, meta) in sessions.items()}
        )
        return sessions[current] if current else None

    def _pin(self, encoded_path: str) -> str | None:
        return state.read_pin(self.provider_id, encoded_path)

    def _find_log(self, session_id: str) -> Path | None:
        """The log of one conversation, searched across every project.

        ``launch_argv`` is handed ids, not the project that owns them, and the
        directory layout makes the search a stat per project.
        """
        if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
            return None
        for project_dir in self._project_dirs():
            log = log_file(project_dir / session_id)
            if log is not None:
                return log
        return None

    # -- listing ---------------------------------------------------------

    def list_sessions(self, root_dir: str | None = None) -> list[dict]:
        """One row per project directory, newest first.

        ``root_dir`` is ignored: the harness's store is the authority on which
        projects exist, and a project outside the served root is still a
        conversation the user may want to resume. An absent root yields an
        empty listing.
        """
        # Read once for the whole listing, not once per project.
        pins = state.load_state(self.provider_id)["pins"]
        rows: list[dict] = []
        for project_dir in self._project_dirs():
            sessions = self._sessions(project_dir)
            current = self._current(pins.get(project_dir.name), sessions)
            if current is None:
                continue
            _, meta = current
            project_path = meta["cwd"]
            if meta["title"]:
                name, name_source = meta["title"], "session"
            else:
                name, name_source = (
                    os.path.basename(project_path.rstrip("/")) or project_path,
                    "basename",
                )
            rows.append({
                "project_path": project_path,
                "encoded_path": project_dir.name,
                "session_id": meta["session_id"],
                "name": name,
                "name_source": name_source,
                "message_count": meta["message_count"],
                "file_mtime": meta["mtime_ms"],
                "extra_sessions": max(len(sessions) - 1, 0),
            })
        rows.sort(key=lambda row: row["file_mtime"], reverse=True)
        return rows

    def list_branches(
        self, encoded_path: str, include_extras: bool = False
    ) -> dict | None:
        """A project's other conversations, newest first, current excluded.

        ``include_extras`` is accepted and ignored - the harness has no
        background workers, so there is no decoration to pay for.
        """
        project_dir = self._project_dir(encoded_path)
        if project_dir is None:
            return None
        sessions = self._sessions(project_dir)
        current = self._current(self._pin(encoded_path), sessions)
        if current is None:
            return None
        current_id = current[1]["session_id"]
        branches = [
            {
                "session_id": session_id,
                "file_mtime": meta["mtime_ms"],
                "label": meta["title"] or self.short_id(session_id),
            }
            for session_id, (_, meta) in sessions.items()
            if session_id != current_id
        ]
        branches.sort(key=lambda branch: branch["file_mtime"], reverse=True)
        return {"current": current_id, "total": len(sessions), "branches": branches}

    def resolve_current(self, encoded_path: str) -> str | None:
        project_dir = self._project_dir(encoded_path)
        if project_dir is None:
            return None
        current = self._current(self._pin(encoded_path), self._sessions(project_dir))
        return current[1]["session_id"] if current else None

    def switch(self, encoded_path: str, session_id: str) -> dict | None:
        """Validate ``session_id`` and stamp its log's mtime.

        The route's pin, written after this returns, is what decides
        ``current``; the touch is read back through mtime - the project row's
        ``file_mtime`` and ordering, the branch list's ordering, and the
        recency fallback when no pin resolves.
        """
        if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
            return None
        project_dir = self._project_dir(encoded_path)
        if project_dir is None:
            return None
        log = log_file(project_dir / session_id)
        if log is None:
            return {"error": "branch_not_found"}
        try:
            os.utime(log, None)
        except OSError:
            # The pin still carries the switch; only the recency alignment is
            # lost, and a failed touch must not fail the action.
            pass
        return {"requested": session_id}

    # -- mutation --------------------------------------------------------

    def remove(self, encoded_path: str, to_trash: bool = False) -> list[str] | None:
        """Drop a project's whole history: its ``--<key>--`` directory.

        The harness keeps no registry to update - the directory is the whole
        record of the project. One disposal, so it is all or nothing: every
        id the project held on success, none on failure. The ids are read
        BEFORE the disposal - afterwards there is nothing left to enumerate.
        """
        project_dir = self._project_dir(encoded_path)
        if project_dir is None or not project_dir.is_dir():
            return None
        known = list(self._sessions(project_dir))
        try:
            dispose_path(project_dir, to_trash)
        except OSError as err:
            _log.warning("deepseek could not remove %s: %s", project_dir, err)
            return None
        return known

    def delete_branches(
        self, encoded_path: str, session_ids: list, to_trash: bool = False
    ) -> list[str] | None:
        """Drop the named conversations, never the current one.

        A conversation already gone was removed by someone else and is
        skipped, so two panels deleting the same row do not both fail; one
        that cannot be disposed of costs only itself, and stays out of the
        answer so its stored colour survives with it.
        """
        if not isinstance(session_ids, list) or not session_ids:
            return None
        for session_id in session_ids:
            if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(
                session_id
            ):
                return None
        project_dir = self._project_dir(encoded_path)
        if project_dir is None:
            return None
        sessions = self._sessions(project_dir)
        current = self._current(self._pin(encoded_path), sessions)
        keep = current[1]["session_id"] if current else None
        removed: list[str] = []
        for session_id in session_ids:
            if session_id == keep or session_id not in sessions:
                continue
            try:
                dispose_path(project_dir / session_id, to_trash)
            except OSError as err:
                _log.warning("deepseek could not dispose of %s: %s", session_id, err)
                continue
            removed.append(session_id)
        return removed

    def fork(
        self, encoded_path: str, session_id: str, name: str | None = None
    ) -> str | None:
        """Branch a conversation by copying its log under a fresh id.

        The harness has no fork verb, so the extension forks on its behalf:
        the log is re-encoded into a sibling directory under a new id, in the
        harness's own frame layout, so its web UI lists the copy as an ordinary
        conversation. The copy is written whole and only then does the id
        become live; a failed write takes its directory with it, so a
        half-copied transcript never lists as a conversation.
        """
        if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
            return None
        if name is not None and not isinstance(name, str):
            return None
        project_dir = self._project_dir(encoded_path)
        if project_dir is None:
            return None
        found = self._sessions(project_dir).get(session_id)
        if found is None:
            return None
        src, meta = found
        text = read_log(src)
        if text is None:
            return None

        new_id = f"session-{uuid.uuid4()}"
        if isinstance(name, str) and name.strip():
            fork_name = name.strip()
        else:
            fork_name = f"Fork of {meta['title'] or self.short_id(session_id)}"
        content = stamp_fork(text, new_id, fork_name)
        dst_dir = project_dir / new_id
        try:
            dst_dir.mkdir()
            (dst_dir / src.name).write_bytes(
                encode_log(content, compressed=src.suffix == ".zstd")
            )
        except OSError:
            shutil.rmtree(dst_dir, ignore_errors=True)
            return None
        return new_id

    def rename(self, encoded_path: str, session_id: str, name: str) -> str | None:
        """Rewrite the conversation's newest ``session/title`` event.

        The title is where the harness's own web UI reads a conversation's
        name, so it is the only place a rename can go. A conversation the
        harness has not titled yet carries no such event and cannot be named
        here - the store answers None and the route reports it, rather than
        writing a record whose shape is a guess.

        The harness re-titles a conversation as it grows and the newest title
        wins, so this name holds until it does. That is the harness's
        behaviour, not a gap here.

        The log's mtime is put back, because a rename is not activity and that
        mtime IS the row's last-activity time.
        """
        if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
            return None
        project_dir = self._project_dir(encoded_path)
        if project_dir is None:
            return None
        found = self._sessions(project_dir).get(session_id)
        if found is None:
            return None
        src, _meta = found
        text = read_log(src)
        if text is None:
            return None
        content = retitle(text, name)
        if content is None:
            return None
        try:
            before = src.stat()
        except OSError as err:
            _log.warning("deepseek could not rename %s: %s", session_id, err)
            return None
        tmp = src.with_name(f"{src.name}.rename")
        try:
            tmp.write_bytes(encode_log(content, compressed=src.suffix == ".zstd"))
            # On the temporary file, before it becomes the conversation: a
            # failed utime leaves the original exactly as it was.
            os.utime(tmp, (before.st_atime, before.st_mtime))
            os.replace(tmp, src)
            # The restored mtime is what makes this necessary: with the size
            # unchanged too, the memo's key is the pre-rename key and it would
            # go on serving the old title.
            _meta_memo.drop(src)
        except OSError as err:
            _log.warning("deepseek could not rename %s: %s", session_id, err)
            try:
                tmp.unlink()
            except OSError:
                pass
            return None
        return name

    # -- launch ----------------------------------------------------------

    def launch_argv(
        self,
        cli_path: str,
        *,
        session_id: str | None = None,
        new_session_id: str | None = None,
        fork_session_id: str | None = None,
        fork_from: str | None = None,
        mode: str | None = None,
        name: str | None = None,
    ) -> list[str]:
        """``dsh --profile web --no-open --port 0``, whatever the row.

        The web UI is the harness's only interactive surface and it takes no
        conversation on its command line, so the same argv serves a resume, a
        fork (already on disk under its own id by the time this runs) and a
        new conversation; the terminal prints the ``dsh web:`` URL and the
        conversation is chosen in the browser. A resume whose conversation is
        gone REFUSES the launch all the same, so the row's Open never opens a
        UI in which the conversation the user clicked does not exist.
        """
        if session_id and self._find_log(session_id) is None:
            raise SessionNotFound(session_id)
        return [cli_path, "--profile", "web", "--no-open", "--port", "0"]

    # -- terminal identity ----------------------------------------------

    def owns_pid(self, pid: int) -> bool:
        """Whether the node process at ``pid`` is the harness rather than any
        script.

        Every node process reports the same comm, so a comm match alone claims
        ``npm run dev`` in a project as a running conversation. The argv is
        what tells the two apart: a launch runs the ``dsh`` binary on PATH,
        or the ``bin.js`` behind it by its full package path - never a bare
        ``bin.js``, which any package on the machine may carry.
        """
        if process_comm(pid) not in NODE_COMMS:
            return False
        cmdline = process_cmdline(pid)
        if cmdline is None:
            return False
        return any(
            arg.rsplit("/", 1)[-1] == "dsh" or arg.endswith("/dsh/lib/bin.js")
            for arg in cmdline_args(cmdline)
        )


DESCRIPTOR = ProviderDescriptor(
    id="deepseek",
    label="DeepSeek",
    cli_binary="dsh",
    capabilities=Capabilities(
        # No fork verb exists, so the store copies the log itself.
        fork_strategy="server-copy",
        # No colour concept anywhere in the harness - the extension's
        # write-back store is the only source of a tint.
        colour_source="none",
        # The web surface has no approval switch on its command line.
        launch_modes=(),
        # A name is the newest ``session/title`` event of the log, which is
        # where the harness's web UI reads it.
        can_rename=True,
    ),
    # No standalone extension preceded this provider, so there is no state to
    # carry over.
    legacy=None,
    # Every id is ``session-<uuid4>``; the short id is the uuid's head.
    session_id_prefix="session-",
)

STORE = DeepSeekStore()
