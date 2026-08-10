"""Gemini - Google's ``gemini`` CLI.

New provider: there is no standalone extension to port from, so the store below
is written against the CLI's own on-disk format, verified in the installed
bundle of ``@google/gemini-cli`` 0.54.4.

The store reads ``~/.gemini``: ``projects.json`` is Gemini's own registry
mapping a project root to a short id (a slug matching ``[a-z0-9-]+``), and that
short id names a directory under ``tmp/`` whose ``chats/`` folder holds one file
per conversation. Files are ``session-<stamp>-<short session id>.jsonl`` - a
JSON record per line, the first carrying the metadata - with older ``.json``
files holding a single object; both shapes are read here.

Four consequences shape everything below:

* the registry short id IS the ``encoded_path`` - the panel echoes it back and
  only this module ever joins it onto a path
* the CLI is auth-gated even for ``--list-sessions``, so listing NEVER shells to
  it (acc-crit "Store scan" / "Edge: unauthenticated CLI"): an unauthenticated
  install still shows every conversation, and the auth error surfaces inside the
  launched terminal where the user can act on it
* Gemini has no fork flag, so branching copies the chat file under a fresh id -
  the ``server`` fork strategy
* Gemini has no colour command and records no colour, so a tint only ever comes
  from the extension's own colour store

Resuming is ``--session-file <chat file>``, and the choice is load-bearing.
``--resume`` is the CLI's only other way back into a conversation and it cannot
address one by id: its argument is ``latest`` or a POSITION in a list re-sorted
by start time, so it names a different conversation the moment another one
lands, and a row clicked in the panel would open whatever had drifted into that
slot. The chat file is the one handle that stays bound to a conversation for its
whole life, so the store maps a session id onto its file and hands the CLI the
path (acc-crit "Gemini / Resume", docs/defects.md DEF-8).

Favourites and the current-conversation pin live in the extension's own state
directory (``core.state``), never in ``~/.gemini`` - the assistant's own files
are read, never written, apart from the chat files the user explicitly forks or
deletes.
"""
from __future__ import annotations

import json
import logging
import os
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from ..core.registry import Capabilities, ProviderDescriptor
from ..core.state import read_pin
from ..core.store import (
    SessionNotFound,
    SessionStore,
    cmdline_args,
    dispose_path,
    flag_value,
    git_branch,
    is_safe_segment,
    load_json,
    now_iso_z,
    process_cmdline,
    process_comm,
)


# What Node reports as its main thread's ``comm``, across the releases the
# Gemini CLI supports. Node 24 and earlier write ``MainThread``; Node 26 writes
# ``node-MainThread``; a build that names the process itself writes ``node``.
# The argv check is the real discriminator (docs/defects.md DEF-24) - this set
# only keeps the cheap pre-filter from failing closed on a version skew.
_NODE_COMMS = frozenset({"node", "MainThread", "node-MainThread"})


# A refused deletion is otherwise invisible: the count simply comes back short
# and the server log is empty, which is where an admin looks first.
_log = logging.getLogger(__name__)


GEMINI_DIRNAME = ".gemini"
PROJECTS_FILENAME = "projects.json"
TMP_DIRNAME = "tmp"
CHATS_DIRNAME = "chats"
# Written by the CLI inside ``tmp/<short id>/``, naming the project root that
# owns the slug. It is how a slug is mapped back to a project when the registry
# entry is missing.
PROJECT_ROOT_FILE = ".project_root"
CHAT_FILE_PREFIX = "session-"
CHAT_FILE_SUFFIXES = (".json", ".jsonl")

# The registry's own slug charset, so a tampered ``projects.json`` cannot smuggle
# a path segment through ``encoded_path``.
SHORT_ID_RE = re.compile(r"[a-z0-9-]+")
# Conversation ids are uuid4. The restricted charset keeps a corrupt or tampered
# id (a slash, control bytes, "."/"..") from ever reaching a path join.
SESSION_ID_RE = re.compile(r"[0-9a-fA-F-]{36}")

# Message records the CLI writes as their own lines. Matched as substrings, not
# parsed: a transcript runs to megabytes and the count is display only.
_MESSAGE_MARKERS = ('"type":"user"', '"type":"gemini"')
_USER_MARKER = '"type":"user"'
# Markers of a metadata record - the head of the file, and the ``$set`` updates
# that follow it. Tested before the message markers, because a ``$set`` may
# re-send the whole message list on one line.
_META_MARKERS = ('"$set"', '"sessionId"')

# The metadata keys carried by the first line of a chat file, and re-sent inside
# ``$set`` records as the conversation grows.
_META_KEYS = ("sessionId", "summary", "kind")

# Per-file metadata cache: path -> (st_mtime_ns, st_size, parsed). A chat file
# is re-read only when its mtime or size changed, so the 30s sessions poll stops
# re-scanning transcripts that did not move.
_meta_cache: dict[str, tuple[int, int, dict | None]] = {}

# Bound on the first-prompt preview, which is a tooltip line rather than a
# document - an unbounded first turn would carry a whole pasted file into every
# poll response.
FIRST_PROMPT_CHARS = 200

# Gemini's approval ladder, in the CLI's own vocabulary. ``default`` is the
# CLI's own default and is passed through explicitly, so a project that set
# another mode is returned to prompting by choosing it back.
APPROVAL_MODES = ("default", "auto_edit", "yolo", "plan")
YOLO_MODE = "yoloMode"
APPROVAL_MODE = "approvalMode"


def gemini_home() -> Path:
    """Gemini's storage root, ``~/.gemini``.

    Resolved from ``$HOME`` on every call rather than at import: the CLI does
    the same, so pointing ``HOME`` at a scratch directory moves the extension's
    view and the assistant's own writes together.
    """
    return Path.home() / GEMINI_DIRNAME


def _fork_stamp() -> str:
    """Filename timestamp in the CLI's shape - ``2026-08-07T14-30``."""
    return datetime.now().strftime("%Y-%m-%dT%H-%M")


def _content_text(content: Any) -> str:
    """Flatten a message record's content to plain text.

    A record carries either a string or the Gemini SDK's part list, where only
    the text parts matter here; anything else (a function call, inline data)
    contributes nothing to a preview.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            part.get("text")
            for part in content
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        ]
        return "".join(parts)
    return ""


def _preview(text: str) -> str | None:
    """One-line, length-bounded preview of a first prompt."""
    collapsed = " ".join(text.split())
    if not collapsed:
        return None
    return collapsed[:FIRST_PROMPT_CHARS]


def load_projects(root: Path) -> dict[str, str]:
    """Map project root -> short id from ``projects.json``.

    Entries whose slug would not survive a path join are dropped rather than
    trusted; an absent or corrupt registry reads as no projects at all, which is
    an empty panel rather than an error.
    """
    data = load_json(root / PROJECTS_FILENAME)
    projects = data.get("projects") if isinstance(data, dict) else None
    if not isinstance(projects, dict):
        return {}
    result: dict[str, str] = {}
    for project_path, short_id in projects.items():
        if not isinstance(project_path, str) or not project_path:
            continue
        if not is_safe_segment(short_id) or not SHORT_ID_RE.fullmatch(short_id):
            continue
        result[project_path] = short_id
    return result


def load_marker_projects(root: Path) -> dict[str, str]:
    """Map project root -> short id from the ``.project_root`` markers.

    The CLI drops the registry entry of a slug whose marker no longer names the
    same project and re-claims a slug from the markers, so during that migration
    a project can own a directory the registry has forgotten. Reading the
    markers as well is what keeps such a project listed - and because both maps
    are keyed by project root, a project present in both yields exactly one row
    (acc-crit "Edge: registry migration").
    """
    result: dict[str, str] = {}
    try:
        children = sorted((root / TMP_DIRNAME).iterdir())
    except OSError:
        return result
    for child in children:
        if not child.is_dir() or not SHORT_ID_RE.fullmatch(child.name):
            continue
        try:
            owner = (child / PROJECT_ROOT_FILE).read_text(encoding="utf-8").strip()
        except (OSError, ValueError):
            continue
        if owner:
            result[owner] = child.name
    return result


def _parse_chat(raw: bytes) -> dict | None:
    """Metadata of one chat file, or None when it is not a conversation.

    Handles both shapes the CLI reads back: a JSON-per-line transcript, and the
    older single-object file. Message records are recognised by substring rather
    than parsed, so the cost of a long transcript stays a scan instead of a few
    thousand ``json.loads`` calls; the remaining lines - the metadata record and
    the ``$set`` updates that follow it - are parsed, since those are what carry
    the conversation's id, summary and timestamps.
    """
    text = raw.decode("utf-8", "replace")

    legacy = None
    try:
        parsed = json.loads(text)
    except ValueError:
        parsed = None
    if isinstance(parsed, dict) and isinstance(parsed.get("sessionId"), str):
        legacy = parsed

    meta: dict[str, Any] = {}
    count = 0
    first_prompt: str | None = None

    if legacy is not None:
        meta = {key: legacy.get(key) for key in _META_KEYS}
        messages = legacy.get("messages")
        for message in messages if isinstance(messages, list) else []:
            if not isinstance(message, dict) or message.get("type") not in (
                "user",
                "gemini",
            ):
                continue
            count += 1
            if first_prompt is None and message.get("type") == "user":
                first_prompt = _preview(_content_text(message.get("content")))
    else:
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            # A metadata record can carry a whole message list, so the metadata
            # markers are tested FIRST - otherwise such a line reads as a
            # message and the id it carries is never seen.
            if not any(marker in line for marker in _META_MARKERS) and any(
                marker in line for marker in _MESSAGE_MARKERS
            ):
                count += 1
                if first_prompt is None and _USER_MARKER in line:
                    try:
                        record = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(record, dict):
                        first_prompt = _preview(_content_text(record.get("content")))
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if not isinstance(record, dict):
                continue
            update = record.get("$set")
            payload = update if isinstance(update, dict) else record
            for key in _META_KEYS:
                if key in payload:
                    meta[key] = payload[key]
            # A metadata record may re-send the whole message list, which
            # replaces what came before it rather than adding to it.
            messages = payload.get("messages")
            if isinstance(messages, list):
                count = sum(
                    1
                    for message in messages
                    if isinstance(message, dict)
                    and message.get("type") in ("user", "gemini")
                )

    session_id = meta.get("sessionId")
    if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
        return None
    summary = meta.get("summary")
    return {
        "session_id": session_id,
        "summary": summary.strip() if isinstance(summary, str) else None,
        "kind": meta.get("kind"),
        "message_count": count,
        "first_prompt": first_prompt,
    }


def read_chat_meta(path: Path) -> dict | None:
    """Cached :func:`_parse_chat` of one chat file."""
    try:
        st = path.stat()
    except OSError:
        return None
    key = str(path)
    cached = _meta_cache.get(key)
    if cached is not None and cached[:2] == (st.st_mtime_ns, st.st_size):
        return cached[2]
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    meta = _parse_chat(raw)
    _meta_cache[key] = (st.st_mtime_ns, st.st_size, meta)
    return meta


def parse_resume_id(cmdline: bytes) -> str | None:
    """The conversation id a NUL-separated gemini cmdline carries as a FLAG.

    ``--session-id`` names a brand-new conversation under an id we minted, and
    ``--resume <uuid>`` is read for a terminal a user launched by hand that way.
    ``--resume latest`` and ``--resume <index>`` read back as None - neither
    names a conversation, so such a terminal is never claimed for one it may not
    be running. The resume this extension itself spawns carries a FILE rather
    than an id; :meth:`GeminiStore.parse_session_id` resolves that one.
    Pure (bytes in, no pid) so the grammar is testable without a live process.
    """
    args = cmdline_args(cmdline)
    for flag in ("--session-id", "--resume", "-r"):
        value = flag_value(args, flag)
        if value and SESSION_ID_RE.fullmatch(value):
            return value
    return None


def parse_session_file(cmdline: bytes) -> str | None:
    """The chat file path a NUL-separated gemini cmdline was resumed from."""
    return flag_value(cmdline_args(cmdline), "--session-file")


def stamp_fork(text: str, new_id: str, name: str) -> str | None:
    """Rewrite a chat file's content as a fork: fresh id, fresh timestamps, name.

    Both file shapes go through here. Every metadata record is re-stamped, not
    only the first: the id, the timestamps and the summary are all re-sent in
    ``$set`` updates as a conversation grows, so stamping the head alone would
    leave a later line restoring the parent's id. Message records are copied
    through untouched - they are the conversation being branched.

    None when no metadata record carried an id, which means the file is not a
    conversation and must not be forked into one.
    """
    now = now_iso_z()

    def stamp(record: dict) -> bool:
        update = record.get("$set")
        payload = update if isinstance(update, dict) else record
        carries_id = "sessionId" in payload
        if carries_id:
            payload["sessionId"] = new_id
        if "startTime" in payload:
            payload["startTime"] = now
        if "lastUpdated" in payload:
            payload["lastUpdated"] = now
        if carries_id or "summary" in payload:
            payload["summary"] = name
        return carries_id

    try:
        parsed = json.loads(text)
    except ValueError:
        parsed = None
    if isinstance(parsed, dict) and isinstance(parsed.get("sessionId"), str):
        stamp(parsed)
        return json.dumps(parsed, separators=(",", ":"))

    stamped = False
    lines: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            # A torn trailing line is content this function does not understand;
            # copy it through rather than dropping a turn of the conversation.
            lines.append(line)
            continue
        if isinstance(record, dict) and stamp(record):
            stamped = True
        lines.append(json.dumps(record, separators=(",", ":")))
    if not stamped:
        return None
    return "\n".join(lines) + "\n"


class GeminiStore(SessionStore):
    """One project registry, one file per conversation."""

    # Gemini ships as a Node script, so the pty's own process is node: the
    # binary on PATH is a symlink to ``gemini.js`` behind a ``#!/usr/bin/env
    # node`` shebang. Node names its main thread, which is what ``/proc/<pid>/
    # comm`` reports - and EVERY node process on the machine reports the same
    # thing, which is why ``owns_pid`` below confirms the argv as well.
    #
    # Only a candidacy marker here, never an equality test: what Node writes
    # to ``comm`` CHANGED between releases - ``MainThread`` up to Node 24,
    # ``node-MainThread`` from 26 - and the shebang resolves against the
    # Jupyter server's PATH, not the author's. Matching one spelling exactly
    # made every Gemini terminal unidentifiable on the Node versions the CLI
    # actually supports (``engines: >=20``), which costs duplicate terminals
    # and untinted tabs, silently. ``owns_pid`` accepts the set below.
    comm_name = "node-MainThread"

    @property
    def root(self) -> Path:
        """Resolved at call time, not construction: the store is instantiated at
        import and the scratch-directory override is set per test run."""
        return gemini_home()

    # -- paths -----------------------------------------------------------

    def _chats_dir_path(self, encoded_path: str) -> Path | None:
        """``tmp/<short id>/chats``, rejecting path traversal.

        The short id arrives from the client, so it is gated as a single path
        segment against the registry's own charset, and the resolved directory
        must still sit under the tmp root. Existence is not required -
        ``_chats_dir`` is the variant that checks it.
        """
        if not is_safe_segment(encoded_path) or not SHORT_ID_RE.fullmatch(encoded_path):
            return None
        base = self.root / TMP_DIRNAME
        try:
            chats = (base / encoded_path / CHATS_DIRNAME).resolve()
            base = base.resolve()
        except (OSError, ValueError):
            return None
        try:
            chats.relative_to(base)
        except ValueError:
            return None
        return chats

    def _chats_dir(self, encoded_path: str) -> Path | None:
        chats = self._chats_dir_path(encoded_path)
        if chats is None or not chats.is_dir():
            return None
        return chats

    # -- enumeration -----------------------------------------------------

    def _chats(self, chats_dir: Path) -> list[tuple[Path, dict]]:
        """``(chat_file, metadata)`` for every conversation of a project.

        Sub-agent transcripts are skipped, in both places the CLI puts them: a
        ``kind`` of ``subagent`` in the metadata, and the per-parent
        subdirectory, which is not a file and so never matches at all. Anything
        unreadable or without an id is skipped rather than surfaced as a broken
        row.
        """
        out: list[tuple[Path, dict]] = []
        try:
            children = sorted(chats_dir.iterdir())
        except OSError:
            return out
        for child in children:
            if not child.is_file() or not child.name.startswith(CHAT_FILE_PREFIX):
                continue
            if child.suffix not in CHAT_FILE_SUFFIXES:
                continue
            meta = read_chat_meta(child)
            if meta is None or meta.get("kind") == "subagent":
                continue
            out.append((child, meta))
        return out

    def _activity(self, path: Path) -> int:
        """ms-epoch of a conversation's last activity.

        The file's mtime, not the recorded ``lastUpdated``: the CLI appends to
        the file on every turn but re-stamps the field only with the metadata
        updates, and a fork's own copy carries the parent's field until its
        first turn.
        """
        try:
            return int(path.stat().st_mtime * 1000)
        except OSError:
            return 0

    def _pick_current(
        self, encoded_path: str, chats: list[tuple[Path, dict]]
    ) -> tuple[Path, dict] | None:
        """The project's current conversation: the pin when it still resolves,
        otherwise the most recently active.

        The pin is the core's, written on a switch or a fork. Honouring it over
        recency is what stops continued work in another conversation dragging
        the row back to it; a dangling pin is ignored and recency resumes.
        """
        if not chats:
            return None
        pinned = read_pin(self.provider_id, encoded_path)
        if pinned:
            for path, meta in chats:
                if meta["session_id"] == pinned:
                    return path, meta
        return max(chats, key=lambda item: self._activity(item[0]))

    def _find_chat(self, chats_dir: Path, session_id: str) -> Path | None:
        """The file holding one conversation, or None."""
        for path, meta in self._chats(chats_dir):
            if meta["session_id"] == session_id:
                return path
        return None

    def chat_file(self, session_id: str) -> Path | None:
        """The chat file of one conversation, searched across every project.

        ``launch_argv`` is handed ids, not the project that owns them, and the
        resume flag takes a path - so the mapping is resolved here. The scan is
        bounded by the registry and every file it reads is served from the mtime
        cache, so a launch pays a stat per conversation and nothing more.
        """
        if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
            return None
        root = self.root
        short_ids = set(load_marker_projects(root).values())
        short_ids.update(load_projects(root).values())
        for short_id in sorted(short_ids):
            chats_dir = self._chats_dir(short_id)
            if chats_dir is None:
                continue
            found = self._find_chat(chats_dir, session_id)
            if found is not None:
                return found
        return None

    # -- listing ---------------------------------------------------------

    def list_sessions(self, root_dir: str | None = None) -> list[dict]:
        """One row per registered project, newest first.

        ``root_dir`` is ignored: Gemini's registry is the authority on which
        projects exist, and a project outside the served root is still a
        conversation the user may want to resume. An absent ``~/.gemini`` and an
        empty registry both yield an empty listing.
        """
        root = self.root
        projects = load_marker_projects(root)
        # The registry wins on a conflict: it is what the CLI itself consults
        # first, so a slug it has re-pointed must not be listed under the old
        # marker as well.
        projects.update(load_projects(root))
        if not projects:
            return []

        git_cache: dict[str, str | None] = {}
        rows: list[dict] = []
        for project_path in sorted(projects):
            short_id = projects[project_path]
            chats_dir = root / TMP_DIRNAME / short_id / CHATS_DIRNAME
            if not chats_dir.is_dir():
                continue
            chats = self._chats(chats_dir)
            current = self._pick_current(short_id, chats)
            if current is None:
                continue
            path, meta = current

            # The conversation's own summary is the CLI's display name for it,
            # so it is the only name worth preferring over the project folder.
            summary = meta.get("summary")
            if summary:
                name, name_source = summary, "session"
            else:
                name, name_source = (
                    os.path.basename(project_path) or short_id,
                    "basename",
                )

            if project_path not in git_cache:
                git_cache[project_path] = git_branch(project_path)

            rows.append({
                "project_path": project_path,
                "encoded_path": short_id,
                "session_id": meta["session_id"],
                "name": name,
                "name_source": name_source,
                "message_count": meta["message_count"],
                "file_mtime": self._activity(path),
                "git_branch": git_cache[project_path],
                "extra_sessions": max(len(chats) - 1, 0),
            })

        rows.sort(key=lambda row: row["file_mtime"], reverse=True)
        return rows

    def list_branches(
        self, encoded_path: str, include_extras: bool = False
    ) -> dict | None:
        """A project's other conversations, newest first, current excluded.

        ``include_extras`` is accepted and ignored - Gemini has no background
        workers, so there is no decoration to pay for.
        """
        chats_dir = self._chats_dir(encoded_path)
        if chats_dir is None:
            return None
        chats = self._chats(chats_dir)
        current = self._pick_current(encoded_path, chats)
        if current is None:
            return None
        current_id = current[1]["session_id"]

        branches = []
        for path, meta in chats:
            session_id = meta["session_id"]
            if session_id == current_id:
                continue
            # Fallback label is the short id the CLI itself puts in the
            # filename, which is what a user reading either surface sees.
            branches.append({
                "session_id": session_id,
                "file_mtime": self._activity(path),
                "label": meta.get("summary")
                or meta.get("first_prompt")
                or session_id[:8],
            })
        branches.sort(key=lambda branch: branch["file_mtime"], reverse=True)
        return {
            "current": current_id,
            "total": len(chats),
            "branches": branches,
        }

    def resolve_current(self, encoded_path: str) -> str | None:
        chats_dir = self._chats_dir(encoded_path)
        if chats_dir is None:
            return None
        current = self._pick_current(encoded_path, self._chats(chats_dir))
        return current[1]["session_id"] if current else None

    def switch(self, encoded_path: str, session_id: str) -> dict | None:
        """Make ``session_id`` current by touching its chat file's mtime.

        The durable half of the switch is the core's pin, written after this
        returns; the touch is what makes the re-resolution below agree with the
        request instead of answering with the recency winner.
        """
        if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
            return None
        chats_dir = self._chats_dir(encoded_path)
        if chats_dir is None:
            return None
        target = self._find_chat(chats_dir, session_id)
        if target is None:
            return {"error": "branch_not_found"}
        try:
            os.utime(target, None)
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

        Only ``chats/`` goes. The rest of ``tmp/<short id>/`` is the CLI's own
        working state - the ownership marker, memory, checkpoints, logs - and
        ``projects.json`` is Gemini's registry: a project with no conversations
        is simply a row-less entry, exactly as it is before its first session.

        One directory disposal, so it is all or nothing: every id the project
        held on success, none of them on failure. The ids are read BEFORE the
        disposal - afterwards there is nothing left to enumerate.
        """
        chats_dir = self._chats_dir_path(encoded_path)
        if chats_dir is None:
            return None
        if not chats_dir.is_dir():
            return None
        known = self.project_session_ids(encoded_path)
        try:
            dispose_path(chats_dir, to_trash)
        except OSError as err:
            _log.warning("gemini could not remove %s: %s", chats_dir, err)
            return None
        return known

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
        for session_id in session_ids:
            if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(
                session_id
            ):
                return None
        chats_dir = self._chats_dir(encoded_path)
        if chats_dir is None:
            return None
        chats = self._chats(chats_dir)
        current = self._pick_current(encoded_path, chats)
        keep = current[1]["session_id"] if current else None
        by_id = {meta["session_id"]: path for path, meta in chats}
        removed: list[str] = []
        for session_id in session_ids:
            if session_id == keep:
                continue
            path = by_id.get(session_id)
            if path is None:
                continue
            try:
                dispose_path(path, to_trash)
            except OSError as err:
                _log.warning("gemini could not dispose of %s: %s", session_id, err)
                continue
            removed.append(session_id)
        return removed

    def fork(
        self, encoded_path: str, session_id: str, name: str | None = None
    ) -> str | None:
        """Branch a conversation by copying its chat file under a fresh id.

        Gemini has no fork flag - its one import path, ``--session-file``,
        rewrites the conversation under an id it mints itself, which the panel
        could never track - so the extension forks on its behalf: the file is
        re-written beside the original under a new uuid, with the CLI's own
        filename shape so the CLI lists it as an ordinary conversation, and
        ``--resume <new id>`` opens it.

        The copy is written whole and only then does the id become live, and a
        failed write is rolled back: a half-copied transcript would list as a
        conversation truncated mid-record.
        """
        if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
            return None
        if name is not None and not isinstance(name, str):
            return None
        chats_dir = self._chats_dir(encoded_path)
        if chats_dir is None:
            return None
        src = self._find_chat(chats_dir, session_id)
        if src is None:
            return None
        meta = read_chat_meta(src) or {}

        new_id = str(uuid.uuid4())
        old_name = meta.get("summary") or session_id[:8]
        if isinstance(name, str) and name.strip():
            fork_name = name.strip()
        else:
            fork_name = f"Fork of {old_name}"
        # The CLI's own shape - prefix, minute-resolution stamp, the first eight
        # characters of the id - because that is what its delete and resume
        # paths match on.
        dst = chats_dir / f"{CHAT_FILE_PREFIX}{_fork_stamp()}-{new_id[:8]}{src.suffix}"
        try:
            content = stamp_fork(
                src.read_text(encoding="utf-8", errors="replace"), new_id, fork_name
            )
            if content is None:
                return None
            with dst.open("w", encoding="utf-8") as fh:
                fh.write(content)
        except OSError:
            try:
                dst.unlink()
            except OSError:
                pass
            return None
        return new_id

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
        """``gemini --session-file <chat>`` to resume, ``--session-id`` to start.

        The conversation is named by its FILE, never by ``--resume``: that flag
        takes ``latest`` or a listing index, a position in a list re-sorted by
        start time, so it is stale the moment another conversation lands and
        would open a different conversation than the row that was clicked.

        A session id whose file cannot be found REFUSES the launch. Dropping
        the flag instead leaves a bare ``gemini``, which starts a brand-new
        conversation that immediately becomes the project's current one - the
        clicked row keeps its place, the terminal looks like the resume that
        was asked for, and the conversation the user meant to continue is
        simply not in it. The route's pre-flight cannot catch this: it asks the
        store which conversations the project holds, and a project whose
        ``chats/`` directory has gone answers none at all, which reads as "this
        store cannot enumerate" and is let through.

        A fork is an ordinary resume - the copy is already on disk under its own
        id by the time this runs, so ``fork_session_id`` and ``fork_from`` never
        reach here. ``name`` has no CLI surface either: a fork's name is stamped
        into the copied file.
        """
        argv = [cli_path]
        if session_id:
            chat = self.chat_file(session_id)
            if chat is None:
                raise SessionNotFound(session_id)
            argv += ["--session-file", str(chat)]
        elif new_session_id and SESSION_ID_RE.fullmatch(new_session_id):
            argv += ["--session-id", new_session_id]
        if mode == YOLO_MODE:
            argv.append("--yolo")
        elif isinstance(mode, str) and mode.startswith(APPROVAL_MODE + "="):
            value = mode.split("=", 1)[1]
            if value in APPROVAL_MODES:
                argv += ["--approval-mode", value]
        return argv

    # -- terminal identity ----------------------------------------------

    def owns_pid(self, pid: int) -> bool:
        """Whether the node process at ``pid`` is gemini rather than any script.

        Every node process reports the same comm, whatever this Node spells it,
        so a comm match alone claims ``npm run dev`` in a registered project as
        a running conversation: the colour loop then tints that terminal and
        writes the tab colour the user set on it into gemini's colour store
        under a cwd-guessed id. The argv is the only thing that tells the two
        apart - a real launch runs the CLI's own bundle.

        The bundle, not the substring: a project path carrying ``gemini`` in a
        folder name lands in the argv of every child process started there
        (``npm run dev`` inside ``my-gemini-app``), so the match is an argv
        ELEMENT that IS the CLI - the ``gemini`` binary on PATH or the
        ``gemini.js`` bundle behind it.
        """
        if process_comm(pid) not in _NODE_COMMS:
            return False
        cmdline = process_cmdline(pid)
        if cmdline is None:
            return False
        return any(
            arg.rsplit("/", 1)[-1].lower() in ("gemini", "gemini.js")
            for arg in cmdline_args(cmdline)
        )

    def _confined_chat_file(self, path: str) -> Path | None:
        """A ``--session-file`` path read off ``/proc``, if it is one of ours.

        The path is whatever a process advertises, so it is confined under this
        store's ``tmp/`` root before anything reads and JSON-parses it - the
        same gate every other path join in this module runs.
        """
        try:
            base = (self.root / TMP_DIRNAME).resolve()
            chat = Path(path).resolve()
            chat.relative_to(base)
        except (OSError, ValueError):
            return None
        return chat

    def parse_session_id(self, cmdline: bytes) -> str | None:
        """The conversation a running gemini is on, from its argv.

        Gemini writes no per-pid file, so argv is the only handle. A resume this
        extension spawned carries ``--session-file <path>``, so the id is read
        back out of that file - the filename holds only the first eight
        characters of the id and the reuse ladder matches on the whole one. The
        flag-carried forms (``--session-id``, a hand-typed ``--resume <uuid>``)
        are read directly; anything else reads back as None rather than being
        claimed for a conversation it may not be running.
        """
        path = parse_session_file(cmdline)
        if path:
            chat = self._confined_chat_file(path)
            meta = read_chat_meta(chat) if chat is not None else None
            if meta:
                return meta["session_id"]
        return parse_resume_id(cmdline)


DESCRIPTOR = ProviderDescriptor(
    id="gemini",
    label="Gemini",
    cli_binary="gemini",
    capabilities=Capabilities(
        # No fork flag exists, so the store copies the chat file itself.
        fork_strategy="server-copy",
        # No colour concept anywhere in Gemini - the extension's write-back
        # store is the only source of a tint.
        colour_source="none",
        # Two launch surfaces: the unsafe switch, and the approval ladder, whose
        # chosen value rides in the token because a mode reaches the store as a
        # single string.
        launch_modes=(YOLO_MODE,)
        + tuple(f"{APPROVAL_MODE}={value}" for value in APPROVAL_MODES),
    ),
    # No standalone extension preceded this provider, so there is no state to
    # carry over.
    legacy=None,
)

STORE = GeminiStore()
