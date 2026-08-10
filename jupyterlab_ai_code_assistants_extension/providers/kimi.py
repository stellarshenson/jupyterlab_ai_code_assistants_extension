"""Kimi Code - Moonshot AI's ``kimi`` CLI.

Ported from ``jupyterlab_kimi_code_extension`` v0.7.8. The store reads
``~/.kimi-code``: ``workspaces.json`` is Kimi's own registry mapping an opaque
``wd_id`` to a project root, and every conversation is a directory
``sessions/<wd_id>/session_<uuid>/`` holding a ``state.json`` plus one
``agents/*/wire.jsonl`` per agent.

Three consequences shape everything below:

* the ``wd_id`` IS the ``encoded_path`` - there is no path encoding to reverse,
  so a project the registry does not list simply has no row
* Kimi has no fork flag, so branching is a directory copy with a re-stamped
  ``state.json`` and an appended index line - the ``server`` fork strategy
* Kimi has no colour command, so a conversation's default tint is a hash of its
  id; the extension's own colour store still overrides it

Favourites and the current-conversation pin live in the extension's own state
directory (``core.state``), never in ``~/.kimi-code`` - the assistant's own
files are read, never written, apart from the conversation directories the user
explicitly forks or deletes.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from ..core.registry import Capabilities, LegacySource, ProviderDescriptor
from ..core.state import read_pin
from ..core.store import (
    SessionStore,
    cmdline_args,
    dispose_path,
    flag_value,
    git_branch,
    is_safe_segment,
    load_json,
    now_iso_z,
    process_comm,
)


# A refused deletion is otherwise invisible: the count simply comes back short
# and the server log is empty, which is where an admin looks first.
_log = logging.getLogger(__name__)

HOME_ENV = "KIMI_CODE_HOME"
SESSIONS_DIRNAME = "sessions"
WORKSPACES_FILENAME = "workspaces.json"
INDEX_FILENAME = "session_index.jsonl"
STATE_FILENAME = "state.json"

# Kimi session ids are ``session_`` + uuid4 (hex plus hyphen, 36 chars). The
# restricted charset keeps a tampered or corrupt id (a slash, control bytes,
# "."/"..") from ever reaching a path join.
SESSION_ID_RE = re.compile(r"session_[0-9a-f-]{36}")
# ``-S`` also accepts a bare uuid, which is normalised by prepending the prefix.
_BARE_UUID_RE = re.compile(r"[0-9a-f-]{36}")

# Byte pattern identifying a message event in a wire log. Counted as a
# substring, not parsed - counting must stay cheap on multi-MB transcripts.
_MESSAGE_PATTERN = b'"type":"context.append_message"'
# Per-wire-file message-count cache: path -> (st_mtime_ns, st_size, count). A
# wire log is re-read only when its mtime or size changed, so the 30s sessions
# poll stops re-scanning transcripts that did not move.
_message_count_cache: dict[str, tuple[int, int, int]] = {}

# The colour vocabulary of ``jupyterlab_colourful_tab_extension``, in its own
# order. Kimi has no ``/color``, so a conversation's default tint is a hash onto
# these six - the same hash the frontend runs, so a tint is stable whichever
# side computed it.
_TAB_COLOUR_IDS = ("rose", "peach", "lemon", "mint", "sky", "lavender")

# The launch mode, in Kimi's own terminology - the settings key, the wire token
# and the flag mapping all read it from here.
YOLO_MODE = "yoloMode"


def kimi_home() -> Path:
    """Kimi's storage root: ``$KIMI_CODE_HOME`` when set, else ``~/.kimi-code``.

    The override is what lets the UI suite point the store at a scratch
    directory instead of a developer's real history.
    """
    override = os.environ.get(HOME_ENV)
    if override:
        return Path(override).expanduser()
    return Path.home() / ".kimi-code"


def _load_state(session_dir: Path) -> dict | None:
    """A conversation's ``state.json``; None when missing or corrupt, which
    skips that conversation rather than failing the whole listing."""
    data = load_json(session_dir / STATE_FILENAME)
    return data if isinstance(data, dict) else None


def _parse_iso_ms(value: Any) -> int:
    """Parse an ISO-8601 ``...Z`` timestamp to ms-epoch; 0 when malformed."""
    if not isinstance(value, str) or not value:
        return 0
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return 0
    return int(parsed.timestamp() * 1000)


def load_workspaces(root: Path) -> dict[str, str]:
    """Map ``wd_id`` -> project root from ``workspaces.json``.

    Entries listed in ``deleted_workspace_ids`` and entries without a usable
    ``root`` are skipped: Kimi tombstones a removed workspace rather than
    dropping it, so honouring the list is what keeps deleted projects off the
    panel.
    """
    data = load_json(root / WORKSPACES_FILENAME)
    if not isinstance(data, dict):
        return {}
    deleted_raw = data.get("deleted_workspace_ids")
    deleted = (
        {item for item in deleted_raw if isinstance(item, str)}
        if isinstance(deleted_raw, list)
        else set()
    )
    workspaces = data.get("workspaces")
    if not isinstance(workspaces, dict):
        return {}
    result: dict[str, str] = {}
    for wd_id, entry in workspaces.items():
        if not isinstance(wd_id, str) or wd_id in deleted:
            continue
        if not isinstance(entry, dict):
            continue
        project_root = entry.get("root")
        if not isinstance(project_root, str) or not project_root:
            continue
        result[wd_id] = project_root
    return result


def parse_resume_id(cmdline: bytes) -> str | None:
    """The conversation id a NUL-separated kimi cmdline was launched with.

    Kimi resumes with ``-S <id>`` / ``--session <id>`` / ``--session=<id>``. A
    bare ``-S`` opens the interactive picker, and ``-c`` or a bare ``kimi``
    carry no id at all - all of those read back as None, so a terminal whose
    conversation is unknown is never claimed for one it may not be running.
    Pure (bytes in, no pid) so the grammar is testable without a live process.
    """
    args = cmdline_args(cmdline)
    return flag_value(args, "-S") or flag_value(args, "--session")


def normalize_session_id(value: str | None) -> str | None:
    """Normalise a parsed ``-S`` value to a full session id, or None.

    A full ``session_<uuid>`` is kept as-is, a bare ``<uuid>`` gets the prefix
    prepended, anything else is not a session id at all.
    """
    if not value:
        return None
    if SESSION_ID_RE.fullmatch(value):
        return value
    if _BARE_UUID_RE.fullmatch(value):
        return "session_" + value
    return None


def derived_colour(session_id: str) -> str:
    """Map a conversation id onto one of the six tab colours.

    FNV-1a (32-bit) over the id's UTF-8 BYTES, in the same colour order as the
    frontend's own default, so a conversation tints identically whichever side
    resolved it. Bytes rather than characters on purpose: FNV-1a is defined
    over an octet stream, and the idiomatic loop differs per language - ``ord``
    walks code points here, ``charCodeAt`` walks UTF-16 units there, and the
    two answered different colours for an id outside the BMP ("𝕏id" was peach
    here and rose in the browser, DEF-52). Bytes are the one reading both
    languages spell naturally, so the drift cannot return the next time either
    loop is rewritten. Real ids are ASCII, where every reading coincides.
    """
    hash_ = 0x811C9DC5  # FNV offset basis
    for byte in session_id.encode("utf-8"):
        hash_ ^= byte
        hash_ = (hash_ * 0x01000193) & 0xFFFFFFFF
    return _TAB_COLOUR_IDS[hash_ % len(_TAB_COLOUR_IDS)]


def _message_count(session_dir: Path) -> int:
    """Message events across every agent wire log of a conversation.

    Read in binary so a corrupt byte never aborts the count, and memoised per
    file by (mtime, size) so the poll re-reads only logs that actually moved.
    """
    count = 0
    try:
        wires = list((session_dir / "agents").glob("*/wire.jsonl"))
    except OSError:
        return 0
    for wire in wires:
        try:
            st = wire.stat()
        except OSError:
            continue
        key = str(wire)
        cached = _message_count_cache.get(key)
        if cached is not None and cached[:2] == (st.st_mtime_ns, st.st_size):
            count += cached[2]
            continue
        file_count = 0
        try:
            with wire.open("rb") as fh:
                for line in fh:
                    if _MESSAGE_PATTERN in line:
                        file_count += 1
        except OSError:
            continue
        _message_count_cache[key] = (st.st_mtime_ns, st.st_size, file_count)
        count += file_count
    return count


#: What the Kimi CLI reports as its ``comm`` once it has settled. The launched
#: binary renames its own process: sampling ``/proc/<pid>/comm`` every 0.5ms
#: from exec gives ``python`` -> ``kimi`` -> ``MainThread`` -> ``kimi-code``,
#: and it stays at the last one. Matching only ``kimi`` therefore identified a
#: Kimi terminal for the first few milliseconds of its life and never again
#: (DEF-50). Same failure and same remedy as Gemini's ``_NODE_COMMS``: a
#: candidate set, so the cheap pre-filter cannot fail closed on a rename.
_KIMI_COMMS = frozenset({"kimi", "kimi-code"})


class KimiStore(SessionStore):
    """One workspace registry, one directory per conversation."""

    comm_name = "kimi-code"

    def owns_pid(self, pid: int) -> bool:
        """Whether the process at ``pid`` is kimi, at any point in its startup.

        The CLI renames its own process as it boots, so exact equality against
        one spelling is true for a few milliseconds and false forever after
        (DEF-50). The set is the whole override - unlike gemini there is no
        interpreter to disambiguate from, since every spelling here is the
        assistant naming itself.
        """
        return process_comm(pid) in _KIMI_COMMS

    def __init__(self, root: Path | None = None) -> None:
        self._root = root

    @property
    def root(self) -> Path:
        """Resolved at call time, not construction: the store is instantiated at
        import and the scratch-directory override is set per test run."""
        return self._root if self._root is not None else kimi_home()

    # -- paths -----------------------------------------------------------

    def _wd_dir_path(self, encoded_path: str) -> Path | None:
        """``sessions/<wd_id>``, rejecting path traversal.

        The ``wd_id`` arrives from the client, so it is gated as a single path
        segment and the resolved directory must still sit under the sessions
        root. Existence is not required - ``_wd_dir`` is the variant that
        checks it.
        """
        if not is_safe_segment(encoded_path):
            return None
        try:
            base = (self.root / SESSIONS_DIRNAME).resolve()
            wd_dir = (base / encoded_path).resolve()
        except (OSError, ValueError):
            return None
        try:
            wd_dir.relative_to(base)
        except ValueError:
            return None
        return wd_dir

    def _wd_dir(self, encoded_path: str) -> Path | None:
        wd_dir = self._wd_dir_path(encoded_path)
        if wd_dir is None or not wd_dir.is_dir():
            return None
        return wd_dir

    # -- enumeration -----------------------------------------------------

    def _session_dirs(self, wd_dir: Path) -> list[tuple[Path, dict]]:
        """``(session_dir, state)`` for every valid conversation of a project.

        A directory must be named like a session id and carry a readable
        ``state.json``; anything else - a stray folder, a half-written copy -
        is skipped rather than surfaced as a broken row.
        """
        out: list[tuple[Path, dict]] = []
        try:
            children = sorted(wd_dir.iterdir())
        except OSError:
            return out
        for child in children:
            if not child.is_dir() or not SESSION_ID_RE.fullmatch(child.name):
                continue
            state = _load_state(child)
            if state is None:
                continue
            out.append((child, state))
        return out

    def _activity(self, session_dir: Path, state: dict) -> int:
        """ms-epoch of a conversation's last activity: the later of the
        recorded ``updatedAt`` and the ``state.json`` mtime.

        Both are needed - Kimi rewrites the file more often than it re-stamps
        the field, and a copied conversation carries the source's field.
        """
        try:
            mtime_ms = int((session_dir / STATE_FILENAME).stat().st_mtime * 1000)
        except OSError:
            mtime_ms = 0
        return max(_parse_iso_ms(state.get("updatedAt")), mtime_ms)

    def _pick_current(
        self, encoded_path: str, sessions: list[tuple[Path, dict]]
    ) -> tuple[Path, dict] | None:
        """The project's current conversation: the pin when it still resolves,
        otherwise the most recently active.

        The pin is the core's, written on a switch or a fork. Honouring it over
        recency is what stops continued work in another conversation dragging
        the row back to it; a dangling pin is ignored and recency resumes.
        """
        if not sessions:
            return None
        pinned = read_pin(self.provider_id, encoded_path)
        if pinned:
            for session_dir, state in sessions:
                if session_dir.name == pinned:
                    return session_dir, state
        return max(sessions, key=lambda item: self._activity(*item))

    # -- listing ---------------------------------------------------------

    def list_sessions(self, root_dir: str | None = None) -> list[dict]:
        """One row per registered workspace, newest first.

        ``root_dir`` is ignored: Kimi's registry is the authority on which
        projects exist, and a workspace outside the served root is still a
        conversation the user may want to resume.
        """
        root = self.root
        workspaces = load_workspaces(root)
        if not workspaces:
            return []

        # One subprocess per unique project root, shared by every row of it.
        git_cache: dict[str, str | None] = {}
        rows: list[dict] = []
        for wd_id in sorted(workspaces):
            project_path = workspaces[wd_id]
            wd_dir = root / SESSIONS_DIRNAME / wd_id
            if not wd_dir.is_dir():
                continue
            sessions = self._session_dirs(wd_dir)
            current = self._pick_current(wd_id, sessions)
            if current is None:
                continue
            session_dir, state = current

            title = state.get("title")
            title = title if isinstance(title, str) else ""
            # Honour the conversation's own name only when the user set it: an
            # auto-derived title is the first prompt reworded, so the folder
            # basename is the better label until the session is renamed.
            if title.strip() and bool(state.get("isCustomTitle")):
                name = title
                name_source = "session"
            else:
                name = os.path.basename(project_path) or wd_id
                name_source = "basename"

            if project_path not in git_cache:
                git_cache[project_path] = git_branch(project_path)

            rows.append({
                "project_path": project_path,
                "encoded_path": wd_id,
                "session_id": session_dir.name,
                "name": name,
                "name_source": name_source,
                "message_count": _message_count(session_dir),
                "file_mtime": self._activity(session_dir, state),
                "git_branch": git_cache[project_path],
                "extra_sessions": max(len(sessions) - 1, 0),
            })

        rows.sort(key=lambda r: r["file_mtime"], reverse=True)
        return rows

    def list_branches(
        self, encoded_path: str, include_extras: bool = False
    ) -> dict | None:
        """A project's other conversations, newest first, current excluded.

        ``include_extras`` is accepted and ignored - Kimi has no background
        workers, so there is no decoration to pay for.
        """
        wd_dir = self._wd_dir(encoded_path)
        if wd_dir is None:
            return None
        sessions = self._session_dirs(wd_dir)
        current = self._pick_current(encoded_path, sessions)
        if current is None:
            return None
        current_sid = current[0].name

        branches = []
        for session_dir, state in sessions:
            if session_dir.name == current_sid:
                continue
            title = state.get("title")
            # Fallback label is the first 8 chars of the uuid part - the
            # "session_" prefix is shared by every directory and carries no
            # information at all.
            label = (
                title.strip()
                if isinstance(title, str) and title.strip()
                else session_dir.name[8:16]
            )
            branches.append({
                "session_id": session_dir.name,
                "file_mtime": self._activity(session_dir, state),
                "label": label,
            })
        branches.sort(key=lambda b: b["file_mtime"], reverse=True)
        return {
            "current": current_sid,
            "total": len(sessions),
            "branches": branches,
        }

    def resolve_current(self, encoded_path: str) -> str | None:
        wd_dir = self._wd_dir(encoded_path)
        if wd_dir is None:
            return None
        current = self._pick_current(encoded_path, self._session_dirs(wd_dir))
        return current[0].name if current else None

    def switch(self, encoded_path: str, session_id: str) -> dict | None:
        """Make ``session_id`` current by touching its ``state.json`` mtime.

        The durable half of the switch is the core's pin, written after this
        returns; the touch is what makes the re-resolution below agree with the
        request instead of answering with the recency winner.
        """
        if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
            return None
        wd_dir = self._wd_dir(encoded_path)
        if wd_dir is None:
            return None
        target = wd_dir / session_id
        if _load_state(target) is None:
            return {"error": "branch_not_found"}
        try:
            os.utime(target / STATE_FILENAME, None)
        except OSError:
            # The pin still carries the switch; only the recency alignment is
            # lost, and a failed touch must not fail the action.
            pass
        return {
            "requested": session_id,
            "current": self.resolve_current(encoded_path),
        }

    # -- mutation --------------------------------------------------------

    def remove(self, encoded_path: str, to_trash: bool = False) -> list[str] | None:
        """Drop a project's whole history.

        ``workspaces.json`` is deliberately left alone: the registry is Kimi's
        own, and a workspace with no conversations is simply a row-less entry.

        One directory disposal, so it is all or nothing: every id the workspace
        held on success, none of them on failure.
        """
        wd_dir = self._wd_dir_path(encoded_path)
        if wd_dir is None:
            return None
        ids = self._index_ids_under(wd_dir)
        existed = wd_dir.is_dir()
        if existed:
            for session_dir, _state in self._session_dirs(wd_dir):
                ids.add(session_dir.name)
            try:
                dispose_path(wd_dir, to_trash)
            except OSError as err:
                _log.warning("kimi could not remove %s: %s", wd_dir, err)
                return None
        self._prune_index(ids)
        if not existed and not ids:
            return None
        return sorted(ids)

    def delete_branches(
        self, encoded_path: str, session_ids: list, to_trash: bool = False
    ) -> list[str] | None:
        """Drop the named conversations, never the current one.

        A conversation already gone was removed by someone else and is skipped,
        so two panels deleting the same row do not both fail; one that cannot
        be disposed of costs only itself, and stays out of the answer so its
        stored colour survives with it.
        """
        if not isinstance(session_ids, list) or not session_ids:
            return None
        for sid in session_ids:
            if not isinstance(sid, str) or not SESSION_ID_RE.fullmatch(sid):
                return None
        wd_dir = self._wd_dir(encoded_path)
        if wd_dir is None:
            return None
        current = self._pick_current(encoded_path, self._session_dirs(wd_dir))
        keep = current[0].name if current else None
        removed: list[str] = []
        for sid in session_ids:
            if sid == keep:
                continue
            session_dir = wd_dir / sid
            if not session_dir.is_dir():
                continue
            try:
                dispose_path(session_dir, to_trash)
            except OSError as err:
                _log.warning("kimi could not dispose of %s: %s", sid, err)
                continue
            removed.append(sid)
        self._prune_index(removed)
        return removed

    def fork(
        self, encoded_path: str, session_id: str, name: str | None = None
    ) -> str | None:
        """Branch a conversation by copying its directory under a fresh id.

        Kimi has no fork flag, so the extension forks on its behalf:
        ``session_<uuid>`` is copied next to the original, the copy's
        ``state.json`` is re-stamped (title, ``isCustomTitle``, created and
        updated timestamps; ``workDir`` and the agent logs are kept as copied)
        and a line is appended to ``session_index.jsonl``. Kimi then picks the
        copy up as an ordinary conversation - ``kimi -S <new-id>`` resumes it.

        A failed copy is rolled back, because a half-copied directory would
        list as a conversation whose transcript is truncated mid-record.
        """
        if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
            return None
        if name is not None and not isinstance(name, str):
            return None
        wd_dir = self._wd_dir(encoded_path)
        if wd_dir is None:
            return None
        src = wd_dir / session_id
        state = _load_state(src) if src.is_dir() else None
        if state is None:
            return None

        new_id = f"session_{uuid.uuid4()}"
        dst = wd_dir / new_id
        try:
            shutil.copytree(src, dst)
            new_state = dict(state)
            old_title = state.get("title")
            old_title = (
                old_title.strip()
                if isinstance(old_title, str) and old_title.strip()
                else session_id
            )
            new_state["title"] = (
                name.strip()
                if isinstance(name, str) and name.strip()
                else f"Fork of {old_title}"
            )
            new_state["isCustomTitle"] = True
            now = now_iso_z()
            new_state["createdAt"] = now
            new_state["updatedAt"] = now
            with (dst / STATE_FILENAME).open("w", encoding="utf-8") as fh:
                json.dump(new_state, fh, indent=2)
                fh.write("\n")
            work_dir = state.get("workDir")
            record = {
                "sessionId": new_id,
                "sessionDir": str(dst),
                "workDir": work_dir if isinstance(work_dir, str) else "",
            }
            # A single appended line, so a crash mid-write can only leave one
            # torn trailing line, which readers skip.
            with (self.root / INDEX_FILENAME).open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, separators=(",", ":")) + "\n")
        except (OSError, shutil.Error):
            shutil.rmtree(dst, ignore_errors=True)
            return None
        return new_id

    # -- index -----------------------------------------------------------

    def _index_ids_under(self, wd_dir: Path) -> set[str]:
        """Session ids whose index line points into ``wd_dir``.

        Catches stale lines whose conversation directory is already gone, so
        removing a project prunes all of its lines, not only the live ones.
        """
        prefix = str(wd_dir) + os.sep
        ids: set[str] = set()
        try:
            with (self.root / INDEX_FILENAME).open("r", encoding="utf-8") as fh:
                for line in fh:
                    try:
                        record = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(record, dict):
                        continue
                    sdir = record.get("sessionDir")
                    sid = record.get("sessionId")
                    if (
                        isinstance(sdir, str)
                        and isinstance(sid, str)
                        and (sdir == str(wd_dir) or sdir.startswith(prefix))
                    ):
                        ids.add(sid)
        except OSError:
            pass
        return ids

    def _prune_index(self, session_ids) -> None:
        """Rewrite ``session_index.jsonl`` without the removed conversations.

        Lines that do not parse are kept - pruning must never destroy content it
        does not understand. Best-effort: a missing or unwritable index leaves
        nothing to prune.
        """
        ids = set(session_ids)
        if not ids:
            return
        index_path = self.root / INDEX_FILENAME
        try:
            with index_path.open("r", encoding="utf-8") as fh:
                lines = fh.readlines()
        except OSError:
            return
        kept: list[str] = []
        for line in lines:
            try:
                record = json.loads(line)
            except ValueError:
                kept.append(line)
                continue
            sid = record.get("sessionId") if isinstance(record, dict) else None
            if isinstance(sid, str) and sid in ids:
                continue
            kept.append(line)
        tmp = index_path.with_suffix(index_path.suffix + ".tmp")
        try:
            with tmp.open("w", encoding="utf-8") as fh:
                fh.writelines(kept)
            os.replace(tmp, index_path)
        except OSError:
            try:
                tmp.unlink()
            except OSError:
                pass

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
        """``kimi -S <id>`` to resume, bare ``kimi`` to start fresh.

        ``new_session_id``, ``fork_session_id`` and ``fork_from`` are not
        reachable for this assistant - it accepts no id for a new conversation
        and has no fork verb at all, so the server copies the session directory
        and the branch opens as an ordinary resume. ``name`` has no CLI surface
        either: a fork's title is stamped into the copied ``state.json``.
        """
        argv = [cli_path]
        if session_id and SESSION_ID_RE.fullmatch(session_id):
            argv += ["-S", session_id]
        if mode == YOLO_MODE:
            argv.append("--yolo")
        return argv

    # -- terminal identity ----------------------------------------------

    def parse_session_id(self, cmdline: bytes) -> str | None:
        """The conversation a running kimi is on, from its argv.

        Kimi writes no per-pid file, so argv is the only handle: an id is known
        only for launches handed one, which is every resume this extension
        spawns. A bare launch reads back as None and is never claimed.
        """
        return normalize_session_id(parse_resume_id(cmdline))

    # -- colour ----------------------------------------------------------

    def default_colour(self, session_id: str) -> str | None:
        return derived_colour(session_id) if session_id else None


DESCRIPTOR = ProviderDescriptor(
    id="kimi",
    label="Kimi",
    cli_binary="kimi",
    capabilities=Capabilities(
        # Kimi has no fork verb, so the store copies the session directory
        # under a fresh id and the branch opens as an ordinary resume.
        fork_strategy="server-copy",
        colour_source="derived",
        launch_modes=(YOLO_MODE,),
    ),
    legacy=LegacySource(
        plugin_id="jupyterlab_kimi_code_extension",
        # The retired extension kept its favourites beside Kimi's own store.
        # Read in place, never rewritten.
        state_file="~/.kimi-code/jupyterlab_kimi_code_extension.json",
        # Only the assistant-specific key maps: the rest of that plugin's
        # settings (presentation mode, recent limit, sidebar, coloured tabs) are
        # shared across every panel here, so carrying one assistant's values
        # onto them would let whichever extension migrated last decide for all.
        settings_map={YOLO_MODE: f"providers.kimi.{YOLO_MODE}"},
    ),
)

STORE = KimiStore()
