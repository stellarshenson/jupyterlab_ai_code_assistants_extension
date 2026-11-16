"""Antigravity - Google's ``agy`` CLI, the Gemini CLI's successor.

The store layout below was measured on agy 1.5.9, with test conversations in
a signed-in install, on 2026-11-16 (tmp/workflows/agy-real/findings.md). Every
path is under ``~/.gemini/antigravity-cli/`` (``agy_home``). ``HOME`` moves
it; ``ANTIGRAVITY_GEMINI_DIR`` does not. Gemini's own ``tmp/`` and
``projects.json`` sit beside it and are never read here (ACC-AGY-250).

* ``conversation_summaries.db``, table ``conversation_summaries``: one row per
  conversation. ``title`` is '' until the user names it, ``preview`` is the
  first prompt (or the ``/rename`` name), ``workspace_uris`` is a JSON array
  of ``file://`` URIs whose first is the folder agy ran in, ``step_count`` and
  ``last_modified_time`` (``YYYY-MM-DD HH:MM:SS.fffffffff+00:00``) follow.
  agy rebuilds the table from the files below on every start, so a write to
  it is lost: it is only ever opened read-only. It is in WAL mode
  (``_summaries``)
* ``conversations/<uuid>.db``: the conversation itself, SQLite. agy keeps a
  summaries row after this file is deleted and hides that row; so does this
  reader
* ``annotations/<uuid>.pbtxt``: the user's title as the text proto
  ``title:"<name>"``, written by agy's interactive ``/rename`` and read back
  on start. agy has no non-interactive rename, so the panel's rename writes
  this file (``_write_title``)
* ``brain/<uuid>/``: transcript and agent files. Never read for a label: agy
  wraps each prompt there in ``<USER_REQUEST>`` tags (DEF-PROV-392)
* a conversation's label is its annotations title, else ``title``, else
  ``preview``, else its short id (``_label``)
* a copy is a branch agy 1.5.9 resumes with ``--conversation <new id>``: the
  db through the SQLite backup API with the 36-byte parent id replaced by the
  new id in every text and blob value (seven places in a measured db; equal
  lengths keep the protobuf length prefixes valid), and ``brain/<uuid>/``
  copied as it is (``_copy_db``)
* a plain ``agy`` starts a new conversation in the folder it runs in and
  records that folder in ``workspace_uris`` itself; agy takes no id for it
* ``presence/<uuid>.lock``: held open by the agy process running that
  conversation, a plain ``agy`` included; the files outlive the process, so
  only an open one names a running conversation (``session_id_for_pid``)

A branch has no summaries row until agy first opens it, so ``fork`` records
the branch's folder in the extension's state directory, and the reader lists
it from there until agy's own row exists (``_load_forks``).

``encoded_path`` is the plain project path, as for Codex: agy keys nothing by
project on disk, so the store never joins it onto a path.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import sqlite3
import uuid
from contextlib import closing
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from ..core import state
from ..core.registry import Capabilities, ProviderDescriptor
from ..core.store import (
    SessionNotFound,
    SessionStore,
    cmdline_args,
    dispose_path,
    flag_value,
    iso_ms,
    load_json,
    mtime_ms,
    write_json_atomic,
)

_log = logging.getLogger(__name__)


GEMINI_DIRNAME = ".gemini"
AGY_DIRNAME = "antigravity-cli"
SUMMARIES_DB = "conversation_summaries.db"
CONVERSATIONS_DIRNAME = "conversations"
ANNOTATIONS_DIRNAME = "annotations"
BRAIN_DIRNAME = "brain"
PRESENCE_DIRNAME = "presence"
DB_SUFFIX = ".db"
ANNOTATION_SUFFIX = ".pbtxt"
LOCK_SUFFIX = ".lock"
# The extension's own record of branches agy has not opened yet, beside the
# provider's state file.
FORKS_SUFFIX = "-forks.json"
# Busy timeout on agy's databases; a running agy holds them in WAL mode.
SQLITE_TIMEOUT_S = 2
SUMMARIES_QUERY = (
    "SELECT conversation_id, title, preview, workspace_uris, step_count,"
    " last_modified_time FROM conversation_summaries"
)

# Conversation ids are uuids; the charset keeps a tampered id off a path join.
SESSION_ID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
_TITLE_RE = re.compile(r'\btitle\s*:\s*"((?:[^"\\\n]|\\.)*)"')
_UNESCAPES = {"n": "\n", "t": "\t", "r": "\r"}
# Bound on a label, a row title rather than a document.
FIRST_PROMPT_CHARS = 200

# agy's own name for its approval switch, the flag in camelCase.
MODE_SKIP_PERMISSIONS = "dangerouslySkipPermissions"

# The 30 s poll would repeat an unreadable summaries db in every log line.
_unreadable_logged = False


def agy_home() -> Path:
    """agy's storage root, resolved from ``$HOME`` on every call as the CLI does."""
    return Path.home() / GEMINI_DIRNAME / AGY_DIRNAME


def _children(directory: Path) -> list[Path]:
    try:
        return sorted(directory.iterdir())
    except OSError:
        return []


def _db_path(root: Path, session_id: str) -> Path:
    return root / CONVERSATIONS_DIRNAME / f"{session_id}{DB_SUFFIX}"


def _db_family(db: Path) -> list[Path]:
    """A SQLite file and the ``-wal`` and ``-shm`` files beside it."""
    return [db, db.with_name(db.name + "-wal"), db.with_name(db.name + "-shm")]


def _conversation_paths(root: Path, session_id: str) -> list[Path]:
    """Every file and directory agy keeps for one conversation's history."""
    return [*_db_family(_db_path(root, session_id)), root / BRAIN_DIRNAME / session_id]


def _connect_ro(db: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"{db.as_uri()}?mode=ro", uri=True, timeout=SQLITE_TIMEOUT_S)


def _summaries(root: Path) -> list[tuple]:
    """Every row of agy's summaries table, or none when it cannot be read.

    A missing or locked database lists nothing for agy rather than failing
    the panel, and is logged once per process.
    """
    global _unreadable_logged
    db = root / SUMMARIES_DB
    try:
        with closing(_connect_ro(db)) as conn:
            return conn.execute(SUMMARIES_QUERY).fetchall()
    except sqlite3.Error as err:
        if not _unreadable_logged:
            _unreadable_logged = True
            _log.warning("antigravity lists nothing, %s is unreadable: %s", db, err)
        return []


def _workspace(uris: Any) -> str | None:
    """The folder of the first ``file://`` URI in a ``workspace_uris`` value."""
    try:
        values = json.loads(uris)
    except (TypeError, ValueError):
        return None
    for value in values if isinstance(values, list) else []:
        if isinstance(value, str) and value.startswith("file://"):
            path = unquote(urlparse(value).path)
            if path:
                return path.rstrip("/") or "/"
    return None


def _annotation_title(root: Path, session_id: str) -> str | None:
    """The ``title`` field of ``annotations/<id>.pbtxt``, unescaped, or None."""
    path = root / ANNOTATIONS_DIRNAME / f"{session_id}{ANNOTATION_SUFFIX}"
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, ValueError):
        return None
    match = _TITLE_RE.search(text)
    if match is None:
        return None
    return re.sub(r"\\(.)", lambda m: _UNESCAPES.get(m[1], m[1]), match[1])


def _label(root: Path, session_id: str, title: Any, preview: Any) -> str | None:
    """The annotations title, else ``title``, else ``preview``: first line, bounded."""
    for text in (_annotation_title(root, session_id), title, preview):
        line = text.strip().split("\n", 1)[0].strip() if isinstance(text, str) else ""
        if line:
            return line[:FIRST_PROMPT_CHARS]
    return None


def _write_title(root: Path, session_id: str, title: str) -> bool:
    """Write ``annotations/<id>.pbtxt`` as agy's ``/rename`` does.

    Text-proto escaping for backslash, double quote and newline. Written
    through a neighbouring temporary file, so a failed write leaves the old
    title in place.
    """
    path = root / ANNOTATIONS_DIRNAME / f"{session_id}{ANNOTATION_SUFFIX}"
    tmp = path.with_name(f".{path.name}.tmp")
    escaped = title.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(f'title:"{escaped}"', encoding="utf-8")
        os.replace(tmp, path)
    except (OSError, ValueError) as err:
        _log.warning("antigravity could not name %s: %s", session_id, err)
        tmp.unlink(missing_ok=True)
        return False
    return True


def _quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _copy_db(src: Path, dst: Path, old_id: str, new_id: str) -> None:
    """Copy a conversation db to ``dst`` with ``old_id`` replaced by ``new_id``.

    The SQLite backup API reads through the source's WAL, so turns a running
    agy has not checkpointed are carried. Every text and blob value of every
    table is rewritten: agy keeps the id inside protobuf blobs as well as in a
    text column. Built beside ``dst`` and moved into place only after
    ``integrity_check`` answers ok, so agy never sees a half-made copy.
    Raises ``sqlite3.Error`` or ``OSError``.
    """
    old_bytes, new_bytes = old_id.encode(), new_id.encode()

    def holds_id(value: Any) -> bool:
        if isinstance(value, str):
            return old_id in value
        return isinstance(value, bytes) and old_bytes in value

    def swap_id(value: Any) -> Any:
        if isinstance(value, str):
            return value.replace(old_id, new_id)
        return value.replace(old_bytes, new_bytes)

    tmp = dst.with_name(f".{dst.name}.tmp")
    try:
        with closing(_connect_ro(src)) as source, closing(sqlite3.connect(tmp)) as copy:
            source.backup(copy)
            copy.create_function("holds_id", 1, holds_id, deterministic=True)
            copy.create_function("swap_id", 1, swap_id, deterministic=True)
            tables = [
                row[0]
                for row in copy.execute(
                    "SELECT name FROM sqlite_master"
                    " WHERE type = 'table' AND name NOT GLOB 'sqlite_*'"
                ).fetchall()
            ]
            for table in tables:
                for column in copy.execute(f"PRAGMA table_info({_quote(table)})").fetchall():
                    name = _quote(column[1])
                    copy.execute(
                        f"UPDATE {_quote(table)} SET {name} = swap_id({name})"
                        f" WHERE holds_id({name})"
                    )
            copy.commit()
            verdict = copy.execute("PRAGMA integrity_check").fetchone()[0]
        if verdict != "ok":
            raise sqlite3.DatabaseError(f"copy failed integrity_check: {verdict}")
        shutil.copymode(src, tmp)
        os.replace(tmp, dst)
    finally:
        for leftover in _db_family(tmp):
            leftover.unlink(missing_ok=True)


class AntigravityStore(SessionStore):
    """agy's summaries table, read in place, over one db per conversation."""

    comm_name = "agy"

    # -- the fork record -------------------------------------------------
    # Read, changed and written only by ``fork``, which the branch route
    # serialises per provider.

    def _forks_path(self) -> Path:
        return state.state_dir() / f"{self.provider_id}{FORKS_SUFFIX}"

    def _load_forks(self) -> dict[str, str]:
        """``{branch id: project path}``; a corrupt record reads empty."""
        data = load_json(self._forks_path())
        if not isinstance(data, dict):
            return {}
        return {sid: path for sid, path in data.items() if isinstance(path, str) and path}

    # -- enumeration -----------------------------------------------------

    def _index(self) -> dict[str, dict]:
        """Every listable conversation by id, with ``project``, ``label``,
        ``steps``, ``mtime`` and ``recorded`` (listed from the fork record
        because agy has no row for it yet)."""
        root = agy_home()
        on_disk = {
            path.stem
            for path in _children(root / CONVERSATIONS_DIRNAME)
            if path.suffix == DB_SUFFIX and SESSION_ID_RE.fullmatch(path.stem)
        }
        convs: dict[str, dict] = {}
        for sid, title, preview, uris, steps, modified in _summaries(root):
            project = _workspace(uris)
            if sid not in on_disk or not project:
                continue
            convs[sid] = {
                "project": project,
                "label": _label(root, sid, title, preview),
                "steps": steps if isinstance(steps, int) else 0,
                "mtime": iso_ms(modified) or 0,
                "recorded": False,
            }
        for sid, project in self._load_forks().items():
            if sid in on_disk and sid not in convs:
                convs[sid] = {
                    "project": project,
                    "label": _label(root, sid, None, None),
                    "steps": 0,
                    "mtime": mtime_ms(_db_path(root, sid)),
                    "recorded": True,
                }
        return convs

    def _project(self, encoded_path: str) -> dict[str, dict]:
        if not isinstance(encoded_path, str) or not encoded_path:
            return {}
        return {
            sid: conv for sid, conv in self._index().items() if conv["project"] == encoded_path
        }

    def _current(self, pinned: str | None, convs: dict[str, dict]) -> str | None:
        return state.pick_current(pinned, {sid: conv["mtime"] for sid, conv in convs.items()})

    # -- listing ---------------------------------------------------------

    def list_sessions(self, root_dir: str | None = None) -> list[dict]:
        """One row per project directory, newest first. ``root_dir`` is ignored,
        as every store here does: a project outside it is still resumable."""
        by_project: dict[str, dict[str, dict]] = {}
        for sid, conv in self._index().items():
            by_project.setdefault(conv["project"], {})[sid] = conv
        pins = state.load_state(self.provider_id)["pins"]
        rows = []
        for project_path, convs in by_project.items():
            current_id = self._current(pins.get(project_path), convs)
            current = convs[current_id]
            label = current["label"]
            rows.append({
                "project_path": project_path,
                "encoded_path": project_path,
                "session_id": current_id,
                "name": label or os.path.basename(project_path.rstrip("/")) or project_path,
                "name_source": "session" if label else "basename",
                "message_count": current["steps"],
                "file_mtime": current["mtime"],
                "extra_sessions": len(convs) - 1,
            })
        rows.sort(key=lambda row: row["file_mtime"], reverse=True)
        return rows

    def list_branches(self, encoded_path: str, include_extras: bool = False) -> dict | None:
        """A project's other conversations, newest first, current excluded."""
        convs = self._project(encoded_path)
        current = self._current(state.read_pin(self.provider_id, encoded_path), convs)
        if current is None:
            return None
        branches = [
            {
                "session_id": sid,
                "file_mtime": conv["mtime"],
                "label": conv["label"] or self.short_id(sid),
            }
            for sid, conv in convs.items()
            if sid != current
        ]
        branches.sort(key=lambda branch: branch["file_mtime"], reverse=True)
        return {"current": current, "total": len(convs), "branches": branches}

    def resolve_current(self, encoded_path: str) -> str | None:
        return self._current(
            state.read_pin(self.provider_id, encoded_path), self._project(encoded_path)
        )

    def switch(self, encoded_path: str, session_id: str) -> dict | None:
        """Validate ``session_id``. The route's pin decides ``current``; the
        recency clock is agy's ``last_modified_time``, which is never written."""
        if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
            return None
        if session_id not in self._project(encoded_path):
            return {"error": "branch_not_found"}
        return {"requested": session_id}

    # -- mutation --------------------------------------------------------

    def _dispose(self, sid: str, to_trash: bool) -> bool:
        for path in _conversation_paths(agy_home(), sid):
            if not path.exists():
                continue
            try:
                dispose_path(path, to_trash)
            except OSError as err:
                _log.warning("antigravity could not dispose of %s: %s", sid, err)
                return False
        return True

    def remove(self, encoded_path: str, to_trash: bool = False) -> list[str] | None:
        """Drop every conversation of the project; answers the ids that went."""
        convs = self._project(encoded_path)
        if not convs:
            return None
        return [sid for sid in convs if self._dispose(sid, to_trash)]

    def delete_branches(
        self, encoded_path: str, session_ids: list, to_trash: bool = False
    ) -> list[str] | None:
        """Drop the named conversations, never the current one."""
        if not isinstance(session_ids, list) or not session_ids:
            return None
        if not all(isinstance(sid, str) and SESSION_ID_RE.fullmatch(sid) for sid in session_ids):
            return None
        convs = self._project(encoded_path)
        keep = self._current(state.read_pin(self.provider_id, encoded_path), convs)
        return [
            sid
            for sid in session_ids
            if sid != keep and sid in convs and self._dispose(sid, to_trash)
        ]

    def fork(self, encoded_path: str, session_id: str, name: str | None = None) -> str | None:
        """Copy the conversation's db and brain directory under a fresh id.

        agy has no fork flag (``/fork`` exists only inside the TUI), so the
        copy is made here (``_copy_db``) and resumed like any row. The branch
        is recorded under its project until agy writes a row for it, and its
        name goes to ``annotations/<new id>.pbtxt``. A failed copy takes
        everything it wrote with it.
        """
        if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
            return None
        if name is not None and not isinstance(name, str):
            return None
        index = self._index()
        conv = index.get(session_id)
        if conv is None or conv["project"] != encoded_path:
            return None
        root = agy_home()
        new_id = str(uuid.uuid4())
        brain = root / BRAIN_DIRNAME / session_id
        try:
            _copy_db(_db_path(root, session_id), _db_path(root, new_id), session_id, new_id)
            if brain.is_dir():
                shutil.copytree(brain, brain.with_name(new_id))
            forks = {
                sid: path
                for sid, path in self._load_forks().items()
                if sid in index and index[sid]["recorded"]
            }
            forks[new_id] = conv["project"]
            write_json_atomic(self._forks_path(), forks)
        except (OSError, sqlite3.Error) as err:
            _log.warning("antigravity could not branch %s: %s", session_id, err)
            self._dispose(new_id, to_trash=False)
            return None
        title = name.strip() if isinstance(name, str) and name.strip() else (
            f"Fork of {conv['label'] or self.short_id(session_id)}"
        )
        _write_title(root, new_id, title)
        return new_id

    def rename(self, encoded_path: str, session_id: str, name: str) -> str | None:
        """Write ``name`` to the conversation's annotations file, which agy's
        ``/resume`` shows and the panel's label reads first."""
        if not isinstance(session_id, str) or session_id not in self._project(encoded_path):
            return None
        return name if _write_title(agy_home(), session_id, name) else None

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
        """``agy --conversation <id>`` to resume, plain ``agy`` to start.

        Never ``--continue``, which picks the most recent conversation rather
        than the clicked one. A resume whose conversation db is gone is
        refused rather than dropped to a bare ``agy``, which would start a new
        conversation in its place. ``new_session_id`` is ignored: agy takes no
        id for a new conversation, and records the folder it runs in itself.
        """
        argv = [cli_path]
        if session_id:
            if not (
                SESSION_ID_RE.fullmatch(session_id)
                and _db_path(agy_home(), session_id).is_file()
            ):
                raise SessionNotFound(session_id)
            argv += ["--conversation", session_id]
        if mode == MODE_SKIP_PERMISSIONS:
            argv.append("--dangerously-skip-permissions")
        return argv

    # -- terminal identity ----------------------------------------------

    def parse_session_id(self, cmdline: bytes) -> str | None:
        """The conversation an ``agy --conversation <id>`` cmdline is on; a bare
        ``agy`` carries no id on its cmdline."""
        value = flag_value(cmdline_args(cmdline), "--conversation")
        return value if value and SESSION_ID_RE.fullmatch(value) else None

    def session_id_for_pid(self, pid: int) -> str | None:
        """The conversation of the ``presence/<id>.lock`` the agy process at
        ``pid`` holds open, else its ``--conversation``.

        The lock is the only place a plain ``agy``'s id can be read from, so a
        terminal started by the + button or by hand is identified too
        (DEF-PANE-394).
        """
        presence = os.path.realpath(agy_home() / PRESENCE_DIRNAME)
        try:
            fds = sorted(os.listdir(f"/proc/{pid}/fd"), key=int)
        except (OSError, ValueError):
            fds = []
        # shortcut: the lowest fd wins if agy ever holds two locks; measured
        # agy 1.5.9 holds one.
        for fd in fds:
            try:
                folder, name = os.path.split(os.readlink(f"/proc/{pid}/fd/{fd}"))
            except OSError:
                continue
            sid = name.removesuffix(LOCK_SUFFIX)
            if folder == presence and name.endswith(LOCK_SUFFIX) and SESSION_ID_RE.fullmatch(sid):
                return sid
        return super().session_id_for_pid(pid)


DESCRIPTOR = ProviderDescriptor(
    id="antigravity",
    label="Antigravity",
    cli_binary="agy",
    capabilities=Capabilities(
        # `/fork` exists only inside the TUI, so the store copies the files.
        fork_strategy="server-copy",
        colour_source="none",
        launch_modes=(MODE_SKIP_PERMISSIONS,),
        # The name is `title:` in annotations/<id>.pbtxt, the file agy's
        # `/rename` writes.
        can_rename=True,
    ),
    legacy=None,
)

STORE = AntigravityStore()
