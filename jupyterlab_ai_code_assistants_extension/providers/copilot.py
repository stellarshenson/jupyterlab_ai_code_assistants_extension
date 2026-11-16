"""Copilot - GitHub's ``copilot`` CLI (npm ``@github/copilot``).

Measured on copilot 1.0.112 against an isolated ``$COPILOT_HOME`` on
2026-11-16 (tmp/workflows/copilot-real). The home is ``$COPILOT_HOME``, else
``~/.copilot``.

* a session is ``session-state/<uuid>/``. ``workspace.yaml``, flat ``key:
  value`` lines written at start, holds ``id`` and ``cwd``, and ``name`` with
  ``user_named`` once named. ``events.jsonl`` appears at the first persisted
  event: ``session.start`` carries ``data.sessionId`` and
  ``data.context.cwd``, ``user.message`` carries ``data.content``
* copilot lists and resumes from these folders and ``name`` alone, and hides an
  unnamed session with no message; so does this reader (``_session``).
  ``session-store.db`` is a search index copilot does not list or resume from;
  it is never opened here. A flat pre-1.0.11 ``session-state/<uuid>.jsonl`` is
  refused by copilot and ignored here
* ``--session-id <uuid>`` resumes that session, and starts one under the id
  when its folder does not exist; ``--resume`` and ``--continue`` match by
  prefix, name or recency, so the extension never passes them
* each session a process opens - at start, ``/resume``, ``/new`` - gets
  ``inuse.<pid>.lock`` holding the pid of the native binary the npm loader
  spawns, kept until the process exits (``session_id_for_pid``)
* no fork flag (``/fork`` is TUI-only), so branching copies the session
  directory under a fresh id (the ``server-copy`` strategy); no colour concept

``encoded_path`` is the plain project cwd, as for Codex: a project is only the
cwd its sessions record, compared and never joined onto a path.

Favourites and the current-session pin live in the extension's own state
directory (``core.state``), never under the Copilot home.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Any

from ..core import state
from ..core.registry import Capabilities, ProviderDescriptor
from ..core.store import (
    NODE_COMMS,
    FileMemo,
    SessionNotFound,
    SessionStore,
    cmdline_args,
    dispose_path,
    flag_value,
    mtime_ms,
    process_children,
    process_cmdline,
    process_comm,
)

# A refused deletion is otherwise invisible: the count simply comes back short
# and the server log is empty, which is where an admin looks first.
_log = logging.getLogger(__name__)


COPILOT_HOME_ENV = "COPILOT_HOME"
COPILOT_DIRNAME = ".copilot"
SESSION_STATE_DIRNAME = "session-state"
EVENTS_FILENAME = "events.jsonl"
WORKSPACE_FILENAME = "workspace.yaml"

# Session ids are UUIDs and name a directory, so the charset is what
# keeps a tampered id off a path join and out of an argv.
SESSION_ID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)

# Event kinds matched as substrings, not parsed: a transcript runs to megabytes
# and the count is display only. A JSON string escapes its quotes, so message
# text cannot carry the marker; a parsed line is still checked for its type.
_START_MARKER = '"type":"session.start"'
_USER_MARKER = '"type":"user.message"'
_ASSISTANT_MARKER = '"type":"assistant.message"'

# A top-level ``key: value`` line of workspace.yaml.
_YAML_KEY_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$")
_YAML_NULLS = ("", "~", "null", "Null", "NULL")

# Bound on the title taken from a first prompt - a row label, not a document.
FIRST_PROMPT_CHARS = 200

# Copilot's approval switch, in the CLI's own vocabulary.
YOLO_MODE = "yoloMode"

# Per-file parse memo, so the 30s sessions poll re-reads only what moved.
_workspace_memo = FileMemo()
_events_memo = FileMemo()


def copilot_home() -> Path:
    """The CLI's home: ``$COPILOT_HOME``, else ``~/.copilot``.

    Resolved on every call rather than at import, exactly as the CLI resolves
    it, so pointing either variable at a scratch directory moves the
    extension's view and the assistant's own writes together.
    """
    override = os.environ.get(COPILOT_HOME_ENV, "").strip()
    return Path(override) if override else Path.home() / COPILOT_DIRNAME


# -- workspace.yaml ------------------------------------------------------


def _yaml_spans(lines: list[str]) -> dict[str, tuple[int, int]]:
    """Top-level key -> ``(first line, end line)`` of its value.

    An indented line continues the previous key's value: a YAML writer folds a
    long scalar across lines, and a block scalar (``|``, ``>``) always starts
    on the next one.
    """
    spans: dict[str, tuple[int, int]] = {}
    key = None
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        if line[0] in " \t":
            if key is not None:
                spans[key] = (spans[key][0], index + 1)
            continue
        match = _YAML_KEY_RE.match(line)
        key = match.group(1) if match else None
        if key is not None:
            spans[key] = (index, index + 1)
    return spans


def _yaml_scalar(lines: list[str]) -> str | None:
    """One scalar value from its key line and continuation lines.

    shortcut: YAML-only escapes in a double-quoted value (``\\x``, ``\\e``,
    ``\\N``...) are kept literal; parse with a YAML library if the CLI is seen
    writing them.
    """
    head = (lines[0].split(":", 1)[1]).strip()
    rest = [line.strip() for line in lines[1:]]
    if head[:1] in ("|", ">"):
        return ("\n" if head[0] == "|" else " ").join(rest).strip() or None
    text = " ".join(part for part in (head, *rest) if part)
    if text[:1] == '"':
        try:
            value = json.loads(text)
        except ValueError:
            return text.strip('"')
        return value if isinstance(value, str) else None
    if text[:1] == "'":
        return text[1:].removesuffix("'").replace("''", "'")
    text = text.split(" #", 1)[0].strip()
    return None if text in _YAML_NULLS else text


def parse_workspace(text: str) -> dict[str, str | None]:
    """The flat ``key: scalar`` pairs of a workspace.yaml.

    Hand-parsed because the file is flat scalars and the project carries no
    YAML dependency. A key whose value is null reads as None, so a caller can
    still tell it is present.
    """
    lines = text.split("\n")
    return {
        key: _yaml_scalar(lines[start:end])
        for key, (start, end) in _yaml_spans(lines).items()
    }


def stamp_workspace(text: str, name: str, session_id: str | None = None) -> str:
    """workspace.yaml content under a new ``name`` (and ``id``, for a fork).

    Only those keys are rewritten - a folded value replaced whole - and every
    other line is kept as it was. ``user_named`` is set where the CLI already
    writes it, so the CLI does not replace a name the user chose with one it
    generates; it is never added. Values are written as JSON strings, which
    are valid YAML double-quoted scalars.
    """
    lines = text.rstrip("\n").split("\n") if text.strip() else []
    spans = _yaml_spans(lines)
    values: dict[str, Any] = {}
    if session_id is not None:
        values["id"] = session_id
    values["name"] = name
    if "user_named" in spans:
        values["user_named"] = True
    appended = [f"{key}: {json.dumps(v)}" for key, v in values.items() if key not in spans]
    # Bottom-up, so an earlier span's indices survive a later replacement.
    for key in sorted(
        (key for key in values if key in spans), key=lambda k: spans[k][0], reverse=True
    ):
        start, end = spans[key]
        lines[start:end] = [f"{key}: {json.dumps(values[key])}"]
    return "\n".join(lines + appended) + "\n"


# -- events.jsonl --------------------------------------------------------


def _record(line: str | bytes, kind: str) -> dict | None:
    """One event line parsed, or None when it is not an event of ``kind``."""
    try:
        record = json.loads(line)
    except ValueError:
        return None
    if not isinstance(record, dict) or record.get("type") != kind:
        return None
    return record


def _start_cwd(record: dict) -> str | None:
    """The cwd a ``session.start`` event records, or None."""
    data = record.get("data")
    data = data if isinstance(data, dict) else {}
    context = data.get("context") or record.get("context")
    cwd = context.get("cwd") if isinstance(context, dict) else None
    return cwd if isinstance(cwd, str) and cwd else None


def _first_line(content: Any) -> str | None:
    """The first non-blank line of a prompt, bounded, or None."""
    if not isinstance(content, str):
        return None
    for line in content.split("\n"):
        if line.strip():
            return line.strip()[:FIRST_PROMPT_CHARS]
    return None


def _parse_events(path: Path, _st: os.stat_result) -> dict | None:
    """cwd, message count, first prompt and whether a user message exists."""
    try:
        text = path.read_bytes().decode("utf-8", "replace")
    except OSError:
        return None
    cwd = None
    count = 0
    has_user = False
    first_prompt = None
    # `\n` only: ``str.splitlines()`` also breaks on U+2028, which Node's
    # ``JSON.stringify`` writes unescaped inside string content.
    for line in text.split("\n"):
        is_user = _USER_MARKER in line
        has_user = has_user or is_user
        if is_user or _ASSISTANT_MARKER in line:
            count += 1
        if is_user and first_prompt is None:
            record = _record(line, "user.message")
            data = record.get("data") if record else None
            first_prompt = _first_line(data.get("content")) if isinstance(data, dict) else None
        elif cwd is None and _START_MARKER in line:
            record = _record(line, "session.start")
            cwd = _start_cwd(record) if record else None
    return {
        "cwd": cwd, "message_count": count, "first_prompt": first_prompt, "has_user": has_user
    }


def _parse_workspace_file(path: Path, _st: os.stat_result) -> dict | None:
    try:
        return parse_workspace(path.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return None


def stamp_events(raw: bytes, new_id: str) -> bytes:
    """An event log with its ``session.start`` event under ``new_id``.

    Only that line changes; every other event is the session being branched
    and is copied through byte for byte.
    """
    lines = raw.split(b"\n")
    for index, line in enumerate(lines):
        if _START_MARKER.encode() not in line:
            continue
        record = _record(line, "session.start")
        data = record.get("data") if record else None
        if isinstance(data, dict) and "sessionId" in data:
            data["sessionId"] = new_id
            lines[index] = json.dumps(record, separators=(",", ":")).encode()
            break
    return b"\n".join(lines)


class CopilotStore(SessionStore):
    """One flat ``session-state`` directory; a project is the cwd sessions record."""

    # Matches a process that names itself copilot. The real npm loader reports
    # ``node-MainThread`` and the native binary it spawns ``MainThread``, comms
    # every node process shares, so ``owns_pid`` confirms those from the argv.
    comm_name = "copilot"

    @property
    def root(self) -> Path:
        """Resolved at call time, not construction: the store is instantiated
        at import and the scratch-directory override is set per test run."""
        return copilot_home() / SESSION_STATE_DIRNAME

    # -- enumeration -----------------------------------------------------

    def _session(self, child: Path) -> dict | None:
        """One session from its directory, or None when it records no project
        or is unnamed with no user message, which copilot does not list."""
        session_id = child.name
        if not SESSION_ID_RE.fullmatch(session_id) or not child.is_dir():
            return None
        events = child / EVENTS_FILENAME
        workspace = child / WORKSPACE_FILENAME
        fields = _workspace_memo.get(workspace, _parse_workspace_file) or {}
        meta = _events_memo.get(events, _parse_events) or {}
        cwd = fields.get("cwd") or meta.get("cwd")
        if not cwd or not (fields.get("name") or meta.get("has_user")):
            return None
        activity = events if events.exists() else workspace
        return {
            "session_id": session_id,
            "cwd": cwd,
            "title": fields.get("name") or meta.get("first_prompt"),
            "message_count": meta.get("message_count", 0),
            "path": child,
            "events": events,
            "workspace": workspace,
            "activity": activity,
            "mtime_ms": mtime_ms(activity),
        }

    def _scan(self) -> dict[str, dict]:
        """``id -> session`` for every listable session in the store."""
        try:
            children = sorted(self.root.iterdir())
        except OSError:
            return {}
        out: dict[str, dict] = {}
        for child in children:
            session = self._session(child)
            if session is not None:
                out[session["session_id"]] = session
        return out

    def _project(self, encoded_path: str) -> dict[str, dict] | None:
        """The sessions of one project, or None for a malformed key."""
        if not isinstance(encoded_path, str) or not encoded_path:
            return None
        return {
            sid: session
            for sid, session in self._scan().items()
            if session["cwd"] == encoded_path
        }

    def _current(self, pinned: str | None, sessions: dict[str, dict]) -> dict | None:
        """The core's pin-or-newest rule over the sessions' activity."""
        current = state.pick_current(
            pinned, {sid: session["mtime_ms"] for sid, session in sessions.items()}
        )
        return sessions[current] if current else None

    def _pin(self, encoded_path: str) -> str | None:
        return state.read_pin(self.provider_id, encoded_path)

    # -- listing ---------------------------------------------------------

    def list_sessions(self, root_dir: str | None = None) -> list[dict]:
        """One row per recorded cwd, newest first.

        ``root_dir`` is ignored: the session store is the authority on which
        projects exist, and a project outside the served root is still a
        session the user may want to resume.
        """
        projects: dict[str, dict[str, dict]] = {}
        for sid, session in self._scan().items():
            projects.setdefault(session["cwd"], {})[sid] = session
        # Read once for the whole listing, not once per project.
        pins = state.load_state(self.provider_id)["pins"]
        rows: list[dict] = []
        for cwd, sessions in projects.items():
            current = self._current(pins.get(cwd), sessions)
            if current is None:
                continue
            if current["title"]:
                name, name_source = current["title"], "session"
            else:
                name, name_source = os.path.basename(cwd.rstrip("/")) or cwd, "basename"
            rows.append({
                "project_path": cwd,
                "encoded_path": cwd,
                "session_id": current["session_id"],
                "name": name,
                "name_source": name_source,
                "message_count": current["message_count"],
                "file_mtime": current["mtime_ms"],
                "extra_sessions": len(sessions) - 1,
            })
        rows.sort(key=lambda row: row["file_mtime"], reverse=True)
        return rows

    def list_branches(
        self, encoded_path: str, include_extras: bool = False
    ) -> dict | None:
        """A project's other sessions, newest first, current excluded.

        ``include_extras`` is accepted and ignored - Copilot has no background
        workers to decorate.
        """
        sessions = self._project(encoded_path)
        current = self._current(self._pin(encoded_path), sessions) if sessions else None
        if current is None:
            return None
        branches = [
            {
                "session_id": sid,
                "file_mtime": session["mtime_ms"],
                "label": session["title"] or self.short_id(sid),
            }
            for sid, session in sessions.items()
            if sid != current["session_id"]
        ]
        branches.sort(key=lambda branch: branch["file_mtime"], reverse=True)
        return {
            "current": current["session_id"],
            "total": len(sessions),
            "branches": branches,
        }

    def resolve_current(self, encoded_path: str) -> str | None:
        sessions = self._project(encoded_path)
        current = self._current(self._pin(encoded_path), sessions) if sessions else None
        return current["session_id"] if current else None

    def switch(self, encoded_path: str, session_id: str) -> dict | None:
        """Validate ``session_id`` and stamp its activity file's mtime.

        The route's pin, written after this returns, is what decides
        ``current``; the touch aligns the recency order with it.
        """
        sessions = self._project(encoded_path)
        if sessions is None or not isinstance(session_id, str):
            return None
        session = sessions.get(session_id)
        if session is None:
            return {"error": "branch_not_found"}
        try:
            os.utime(session["activity"], None)
        except OSError:
            # The pin still carries the switch; a failed touch must not fail it.
            pass
        return {"requested": session_id}

    # -- mutation --------------------------------------------------------

    def _dispose(self, sessions: dict[str, dict], ids: list[str], to_trash: bool) -> list[str]:
        """Dispose of each named session; answer the ids that actually went."""
        removed: list[str] = []
        for sid in ids:
            try:
                dispose_path(sessions[sid]["path"], to_trash)
            except OSError as err:
                _log.warning("copilot could not dispose of %s: %s", sid, err)
                continue
            removed.append(sid)
        return removed

    def remove(self, encoded_path: str, to_trash: bool = False) -> list[str] | None:
        """Drop every session recorded under this cwd, one at a time.

        The store keeps no project directory, so there is no single disposal
        to make: a session that cannot be disposed of costs only itself and
        stays out of the answer, so its stored colour survives with it.
        """
        sessions = self._project(encoded_path)
        if not sessions:
            return None
        return self._dispose(sessions, list(sessions), to_trash)

    def delete_branches(
        self, encoded_path: str, session_ids: list, to_trash: bool = False
    ) -> list[str] | None:
        """Drop the named sessions, never the current one; one already gone
        is skipped."""
        if not isinstance(session_ids, list) or not session_ids:
            return None
        if not all(isinstance(sid, str) for sid in session_ids):
            return None
        sessions = self._project(encoded_path)
        if sessions is None:
            return None
        current = self._current(self._pin(encoded_path), sessions)
        keep = current["session_id"] if current else None
        ids = [sid for sid in session_ids if sid in sessions and sid != keep]
        return self._dispose(sessions, ids, to_trash)

    def fork(
        self, encoded_path: str, session_id: str, name: str | None = None
    ) -> str | None:
        """Branch a session by copying its directory under a fresh id.

        The copy's ``workspace.yaml`` and ``session.start`` event carry the new
        id and its name; the parent is only read. Its ``inuse.<pid>`` files
        stay behind: they name the process running the parent. A failed copy
        takes its directory with it, so a half-copied session never lists.
        """
        if not isinstance(session_id, str) or (
            name is not None and not isinstance(name, str)
        ):
            return None
        sessions = self._project(encoded_path)
        session = sessions.get(session_id) if sessions else None
        if session is None:
            return None
        new_id = str(uuid.uuid4())
        if name and name.strip():
            fork_name = name.strip()
        else:
            fork_name = f"Fork of {session['title'] or self.short_id(session_id)}"
        dst = self.root / new_id
        try:
            dst.mkdir()
        except OSError:
            return None
        copied = dst / WORKSPACE_FILENAME
        try:
            shutil.copytree(
                session["path"], dst, dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("inuse.*"),
            )
            yaml_text = (
                copied.read_text(encoding="utf-8")
                if copied.is_file()
                else f"cwd: {json.dumps(session['cwd'])}\n"
            )
            if session["events"].exists():
                (dst / EVENTS_FILENAME).write_bytes(
                    stamp_events(session["events"].read_bytes(), new_id)
                )
            copied.write_text(
                stamp_workspace(yaml_text, fork_name, new_id), encoding="utf-8"
            )
        except (OSError, ValueError) as err:
            _log.warning("copilot could not fork %s: %s", session_id, err)
            shutil.rmtree(dst, ignore_errors=True)
            return None
        return new_id

    def rename(self, encoded_path: str, session_id: str, name: str) -> str | None:
        """Set ``name`` in the session's workspace.yaml.

        ``name`` is what ``copilot --resume`` and ``/resume`` match and show, so
        it is the only place a rename can go.

        Written through a neighbouring temporary file and renamed into place,
        so a failed write leaves the file as it was. The mtime is put back: a
        rename is not activity, and the memo is dropped because an unchanged
        mtime and size would keep serving the old name.
        """
        sessions = self._project(encoded_path)
        if not sessions or not isinstance(session_id, str):
            return None
        session = sessions.get(session_id)
        if session is None:
            return None
        workspace = session["workspace"]
        tmp = workspace.with_name(f"{workspace.name}.rename")
        try:
            before = workspace.stat()
            content = stamp_workspace(workspace.read_text(encoding="utf-8"), name)
            tmp.write_text(content, encoding="utf-8")
            os.utime(tmp, (before.st_atime, before.st_mtime))
            os.replace(tmp, workspace)
        except (OSError, ValueError) as err:
            _log.warning("copilot could not rename %s: %s", session_id, err)
            tmp.unlink(missing_ok=True)
            return None
        _workspace_memo.drop(workspace)
        return name

    # -- launch ----------------------------------------------------------

    def launch_argv(
        self,
        cli_path: str,
        *,
        session_id: str | None = None,
        new_session_id: str | None = None,
        mode: str | None = None,
        project_path: str | None = None,
    ) -> list[str]:
        """``copilot --session-id <uuid>``, to resume and to start alike.

        A resume whose session is gone REFUSES the launch: ``--session-id``
        with an unknown UUID silently starts a new session under it, which
        would read as the resume that was asked for.
        """
        argv = [cli_path]
        if session_id:
            if not (
                SESSION_ID_RE.fullmatch(session_id) and (self.root / session_id).is_dir()
            ):
                raise SessionNotFound(session_id)
            argv += ["--session-id", session_id]
        elif new_session_id and SESSION_ID_RE.fullmatch(new_session_id):
            argv += ["--session-id", new_session_id]
        if mode == YOLO_MODE:
            argv.append("--yolo")
        return argv

    # -- terminal identity ----------------------------------------------

    def parse_session_id(self, cmdline: bytes) -> str | None:
        """The session a copilot cmdline names with ``--session-id``, the one
        form this extension spawns."""
        value = flag_value(cmdline_args(cmdline), "--session-id")
        return value if value and SESSION_ID_RE.fullmatch(value) else None

    def session_id_for_pid(self, pid: int) -> str | None:
        """The session of the newest ``inuse.<pid>.lock`` this process or a
        child of it wrote, else the ``--session-id`` on its argv.

        The lock names a session opened by ``--resume``, ``--continue`` or
        inside the TUI, which no argv carries. The native binary writes it,
        and its parent, the npm loader, is the copilot a terminal's tree walk
        reaches first. A lock left by a killed process under a reused pid is
        older than the live process's own.

        shortcut: copilot keeps every session it opened locked until it exits,
        so after ``/resume`` back to one of them the newest lock still names
        the later; no store file records which one is in front.
        """
        locks = []
        for owner in (pid, *process_children(pid)):
            for lock in self.root.glob(f"*/inuse.{owner}.lock"):
                try:
                    locks.append((lock.stat().st_mtime_ns, lock.parent.name))
                except OSError:
                    continue
        sids = [sid for _mtime, sid in sorted(locks) if SESSION_ID_RE.fullmatch(sid)]
        return sids[-1] if sids else super().session_id_for_pid(pid)

    def owns_pid(self, pid: int) -> bool:
        """Whether the process at ``pid`` is copilot.

        The loader's comm ``node-MainThread`` and the native binary's
        ``MainThread`` are shared by every node process, so an argv element
        must BE the CLI - the ``copilot`` launcher or a file of the
        ``@github/copilot`` package - never a substring of a project path.
        """
        comm = process_comm(pid)
        if comm == self.comm_name:
            return True
        if comm not in NODE_COMMS:
            return False
        cmdline = process_cmdline(pid)
        return cmdline is not None and any(
            arg.rsplit("/", 1)[-1] == "copilot" or "/node_modules/@github/copilot/" in arg
            for arg in cmdline_args(cmdline)
        )


DESCRIPTOR = ProviderDescriptor(
    id="copilot",
    label="Copilot",
    cli_binary="copilot",
    capabilities=Capabilities(
        # No fork flag exists, so the store copies the session itself.
        fork_strategy="server-copy",
        # No colour concept - the extension's write-back store is the only
        # source of a tint.
        colour_source="none",
        launch_modes=(YOLO_MODE,),
        # ``name`` in workspace.yaml, which the CLI's resume matches and shows.
        can_rename=True,
    ),
    # No standalone extension preceded this provider.
    legacy=None,
)

STORE = CopilotStore()
