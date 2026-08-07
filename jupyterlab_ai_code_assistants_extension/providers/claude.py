"""The Claude Code provider: ``~/.claude`` as a session store.

Ported from ``jupyterlab_claude_code_extension`` v1.2.73, the architectural
base. Everything Claude-specific lives here and nowhere else:

* the lossy dash encoding of a project path into a store directory name, and
  the three-step recovery chain that gets a real path back out of it
* the transcript grammar - one ``<session id>.jsonl`` per conversation, whose
  tail carries the working directory, the ``/rename`` title and the ``/color``
  colour
* the pid-file protocol under ``~/.claude/sessions/`` that says which
  conversation a running process is on and whether a remote bridge is driving it
* the background-agent roster from ``claude agents --json``, and the
  attach-versus-resume decision it drives at launch time
* the argv grammar, in both directions - what is spawned, and what a ``/proc``
  cmdline is read back as

The core never sees any of it: it holds a descriptor with capability flags and
a store implementing ``SessionStore``.
"""
from __future__ import annotations

import glob
import json
import logging
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

from ..core import state
from ..core.registry import Capabilities, LegacySource, ProviderDescriptor
from ..core.store import (
    SessionStore,
    cmdline_args,
    dispose_path,
    flag_value,
    is_safe_segment,
    load_json,
    pid_alive,
)


# A refused deletion is otherwise invisible: the count simply comes back short
# and the server log is empty, which is where an admin looks first.
_log = logging.getLogger(__name__)

CLI_BINARY = "claude"
# Claude's own override for its config root, honoured so the store and the CLI
# always read the same directory - which is also what lets the UI suite point
# the provider at a scratch tree instead of a developer's real history.
CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR"
PROJECTS_DIRNAME = "projects"
SESSIONS_DIRNAME = "sessions"
INDEX_FILENAME = "sessions-index.json"
# Sidecar the RETIRED standalone extension wrote into a project dir to pin that
# project's current conversation. Read as a fallback so an upgrading user keeps
# the conversation they had switched to; never written - pins live in the
# core's own state now (see ``core.state``).
LEGACY_PIN_FILENAME = ".jl-current"

# The launch mode, in Claude's own terminology. The core rejects anything else
# with 400 ``mode_unsupported`` before ``launch_argv`` is reached.
MODE_SKIP_PERMISSIONS = "dangerouslySkipPermissions"

# A bridged session counts as remote-controlled only if it was active within
# this window. Claude leaves ``bridgeSessionId`` set in the pid file after the
# bridge disconnects and the interactive process keeps running, so a live pid
# with a bridge id is not enough. There is no idle heartbeat - the pid file is
# rewritten only on a busy/idle status transition, which fires on every turn
# whether local or remote - so ``updatedAt`` freshness is the only signal that
# the bridge is actually being driven now.
REMOTE_CONTROL_FRESH_MS = 3_600_000  # 1 hour

# Ceiling on the ``claude agents --json`` call (typically ~0.4s). A sessions
# poll must never hang on a wedged CLI - on timeout the panel degrades to "no
# background agents", which is the safe direction: a plain ``--resume``.
BG_AGENTS_TIMEOUT_S = 5.0
# Display surfaces (the context menu's branches fetch) may serve a roster this
# old instead of spawning on the click path. Just over the panel's 30s sessions
# poll, which refreshes the cache - so a menu open between polls is spawn-free
# AND its markers agree with the row chips (same snapshot).
BG_AGENTS_CACHE_MAX_AGE_S = 35.0

# 128 KiB is enough to hold the last ``cwd``, ``custom-title`` and
# ``agent-color`` records: measured across live transcripts the newest of each
# sits within ~14 KiB of EOF, so a tens-of-MB transcript is never read whole.
_TAIL_BYTES = 131072
# Lines read from the FRONT of a transcript when its tail carries no cwd at all.
_HEAD_SCAN_LIMIT = 50
_DECODE_MAX_DEPTH = 20

# Charset gate for a background-agent id as ``claude attach`` takes it (the
# 8-char short form, or a full session uuid). Its only job is to keep anything
# that is not an id out of the glob in ``_expand_short_session_id``, on the
# ``/proc`` read-back path.
_ATTACH_ID_RE = re.compile(r"[0-9a-f-]{4,64}")

# Claude's per-conversation colour (``/color``, or auto-assigned) mapped onto
# the six-id vocabulary of ``jupyterlab_colourful_tab_extension``. That
# extension owns the tab CSS and the ids; the store only feeds it one of them,
# and an unrecognised name resolves to no tint rather than to a guess.
_TAB_COLOUR_ID = {
    "red": "rose",
    "orange": "peach",
    "yellow": "lemon",
    "green": "mint",
    "blue": "sky",
    "purple": "lavender",
}


def claude_dir() -> Path:
    """The user's Claude config root."""
    override = os.environ.get(CONFIG_DIR_ENV)
    if override:
        return Path(override).expanduser()
    return Path.home() / ".claude"


# --------------------------------------------------------------- transcripts


# One entry per transcript: ``path -> (mtime, size, records)``. A transcript is
# append-only, so an unchanged (mtime, size) pair means an unchanged tail - and
# the panel asks for the same handful of files every 30s, for the row title,
# the row colour and every branch label. Cleared wholesale rather than evicted:
# the map is a memo, and rebuilding it costs one tail read per file in use.
_tail_cache: dict[str, tuple[float, int, dict]] = {}
_TAIL_CACHE_MAX = 1024


def _tail_records(path: Path) -> dict:
    """``{"cwd", "custom_title", "agent_colour"}`` from a transcript's tail.

    One pass over the last ``_TAIL_BYTES`` for all three, because all three are
    "the last record of this type wins" and the panel needs them together:

    * ``cwd`` - the directory the conversation last ran in, which differs from
      the front of the file when the project folder was renamed and Claude
      re-homed the conversation under the new directory
    * ``custom_title`` - ``/rename`` appends ``{"type": "custom-title", ...}``
      and Claude re-appends it on every resume, so the newest sits near the
      end. The pid files do NOT carry the rename, so this is its only durable
      store
    * ``agent_colour`` - ``/color`` appends ``{"type": "agent-color", ...}``;
      auto-assigned multi-session colours land there too, so a conversation
      that never ran ``/color`` still carries one
    """
    key = str(path)
    try:
        stat = path.stat()
    except OSError:
        _tail_cache.pop(key, None)
        return {}
    cached = _tail_cache.get(key)
    if cached is not None and cached[0] == stat.st_mtime and cached[1] == stat.st_size:
        return cached[2]

    try:
        with path.open("rb") as fh:
            if stat.st_size > _TAIL_BYTES:
                fh.seek(-_TAIL_BYTES, os.SEEK_END)
                fh.readline()  # discard the partial line at the seek point
            chunk = fh.read()
    except OSError:
        return {}

    records: dict = {}
    for raw_line in chunk.splitlines():
        try:
            record = json.loads(raw_line)
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(record, dict):
            continue
        cwd = record.get("cwd")
        if isinstance(cwd, str) and cwd:
            records["cwd"] = cwd
        kind = record.get("type")
        if kind == "custom-title":
            title = record.get("customTitle")
            if isinstance(title, str) and title.strip():
                records["custom_title"] = title
        elif kind == "agent-color":
            colour = record.get("agentColor")
            if isinstance(colour, str) and colour.strip():
                records["agent_colour"] = colour.strip().lower()

    if len(_tail_cache) >= _TAIL_CACHE_MAX:
        _tail_cache.clear()
    _tail_cache[key] = (stat.st_mtime, stat.st_size, records)
    return records


def _mtime(path: Path) -> float:
    """A transcript's mtime, or 0 when it vanished under us.

    Transcripts are deleted concurrently - by a second browser tab, or by
    Claude's own housekeeping - between a ``glob`` and the ``stat`` that sorts
    its result. An unguarded stat turns that race into a 500 on the whole
    sessions poll; a file that is gone simply sorts last.
    """
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _head_cwd(path: Path) -> str | None:
    """First ``cwd`` near the top of a transcript, or None.

    Only reached when the tail carries none at all - a conversation whose last
    128 KiB is one enormous record.
    """
    try:
        with path.open("r", encoding="utf-8") as fh:
            for i, line in enumerate(fh):
                if i >= _HEAD_SCAN_LIMIT:
                    break
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                cwd = record.get("cwd") if isinstance(record, dict) else None
                if isinstance(cwd, str) and cwd:
                    return cwd
    except (OSError, ValueError):
        return None
    return None


def _jsonl_cwd(path: Path) -> str | None:
    """Best-effort cwd for a transcript: its most recent one, else its first."""
    return _tail_records(path).get("cwd") or _head_cwd(path)


# ------------------------------------------------------------ path encoding


def _encode_path(path: str) -> str:
    """Mirror Claude's encoding: replace ``/``, ``_`` and ``.`` with ``-``."""
    return "".join("-" if ch in ("/", "_", ".") else ch for ch in path)


def _encode_segment(name: str) -> str:
    """Per-segment variant of ``_encode_path`` (no ``/`` to replace)."""
    return "".join("-" if ch in ("_", ".") else ch for ch in name)


def _project_path_for_cwd(cwd: str, dirname: str) -> str | None:
    """The project path when ``cwd`` is the project dir or inside it.

    ``_encode_path`` is char-by-char and length-preserving, so when the encoded
    cwd extends ``dirname`` the first ``len(dirname)`` characters of ``cwd``
    ARE the project path - no lossy decode needed. The boundary character must
    be a real ``/`` so a sibling like ``/x/foo-bar`` does not match project
    ``/x/foo``. Subdirectory cwds are legitimate: Claude records a cwd per
    message, so working in a subfolder moves the tail cwd while the
    conversation still belongs to the project. None when the cwd is foreign.
    """
    enc = _encode_path(cwd)
    if enc == dirname:
        return cwd
    if enc.startswith(dirname) and len(cwd) > len(dirname) and cwd[len(dirname)] == "/":
        return cwd[: len(dirname)]
    return None


def _find_path_matching_encoded(encoded_dir_name: str, root: str = "/") -> str | None:
    """Walk the filesystem for a real directory that encodes to ``encoded_dir_name``.

    Recovers a real cwd when the user renamed a project folder on disk AND the
    corresponding ``projects/<encoded>`` directory to match - none of the
    transcripts inside carry the new path, because they pre-date the rename.
    The encoded name uses ``-`` as the separator AND as the replacement for
    ``_``, ``.`` and a literal ``-``, so one segment can split many ways: the
    longest split is tried first at each step, and the first existing match
    wins.
    """
    parts = encoded_dir_name.lstrip("-").split("-")
    if not parts or not all(parts):
        return None
    return _walk_decode(Path(root), parts, 0)


def _walk_decode(current: Path, remaining: list[str], depth: int) -> str | None:
    if not remaining:
        return str(current)
    if depth >= _DECODE_MAX_DEPTH:
        return None
    try:
        children = list(current.iterdir())
    except OSError:
        return None
    for k in range(len(remaining), 0, -1):
        target = "-".join(remaining[:k])
        for child in children:
            try:
                if not child.is_dir() or _encode_segment(child.name) != target:
                    continue
            except OSError:
                continue
            result = _walk_decode(child, remaining[k:], depth + 1)
            if result is not None:
                return result
    return None


def _decode_dirname(name: str) -> str:
    """Last-resort decode of ``-home-lab-foo`` to ``/home/lab/foo``.

    Lossy - Claude replaces ``/``, ``_`` and ``.`` all with ``-`` - so it is
    used only when neither a transcript's own cwd nor the filesystem walk
    produced a path.
    """
    if not name.startswith("-"):
        return name
    return "/" + name[1:].replace("-", "/")


# ------------------------------------------------------------ pid files, bg


def _session_state_by_cwd(root: Path) -> dict[str, dict]:
    """Map ``cwd`` to the newest ``sessions/<pid>.json`` record for it.

    The pid file's ``name`` is the label Claude itself shows for a session, and
    its ``bridgeSessionId`` is how remote control announces itself. When several
    pid files name one cwd the highest ``updatedAt`` wins, so the row reflects
    the most recently active session of that project.
    """
    by_cwd: dict[str, dict] = {}
    sessions_dir = root / SESSIONS_DIRNAME
    if not sessions_dir.is_dir():
        return by_cwd

    now_ms = int(time.time() * 1000)
    for entry in sessions_dir.glob("*.json"):
        data = load_json(entry)
        if not isinstance(data, dict):
            continue
        cwd = data.get("cwd")
        if not isinstance(cwd, str):
            continue
        updated_at = data.get("updatedAt") or data.get("startedAt") or 0
        previous = by_cwd.get(cwd)
        if previous is not None and previous["updated_at"] >= updated_at:
            continue
        pid = data.get("pid")
        live = isinstance(pid, int) and pid_alive(pid)
        name = data.get("name") if isinstance(data.get("name"), str) else None
        # A live pid alone is NOT remote control - Claude writes a pid file for
        # every interactive session. The bridge link is the non-null
        # ``bridgeSessionId``, and it outlives the bridge itself, so the record
        # has to be fresh as well.
        bridge = data.get("bridgeSessionId")
        fresh = (now_ms - updated_at) <= REMOTE_CONTROL_FRESH_MS
        by_cwd[cwd] = {
            "updated_at": updated_at,
            "name": name,
            "remote_control": bool(
                live and isinstance(bridge, str) and bridge and fresh
            ),
        }
    return by_cwd


def _session_id_from_pidfile(pid: int) -> str | None:
    """The conversation Claude records for its own process at ``pid``.

    Claude writes ``sessions/<pid>.json`` for EVERY interactive session and
    stamps the running conversation into it whatever the launch flags were - a
    bare ``claude``, ``-c``, ``--resume`` and a fork all record it. argv only
    carries an id for launches that were handed one, so this is what makes a
    terminal the extension did not launch identifiable.
    """
    data = load_json(claude_dir() / SESSIONS_DIRNAME / f"{pid}.json")
    if not isinstance(data, dict):
        return None
    sid = data.get("sessionId")
    return sid if isinstance(sid, str) and sid else None


def bg_agents(binary: str | None = None) -> dict[str, str]:
    """Map conversation id to short agent id for every LIVE background agent.

    A background agent owns its conversation only while its worker process
    lives: that is exactly when ``claude --resume <id>`` is refused, and such a
    conversation must be opened with ``claude attach <short>`` instead.

    ``claude agents --json`` is Claude's own scripting surface, but it is NOT a
    live-worker roster - it is derived from the on-disk job records, so it keeps
    listing a job whose worker is long gone. Membership therefore does not mean
    a resume would be refused; liveness does. The listing publishes ``pid`` only
    for a worker it has verified alive and start-time-matched, which is the same
    set Claude's own refusal consults, so that field - not ``kind`` - is the
    honest predicate. ``pid_alive`` re-checks it only to close the gap between
    Claude's check and ours. Returns ``{}`` when the CLI is missing or the call
    fails, times out or answers garbage: the panel then degrades to "no
    background agents", which is the safe direction.
    """
    binary = binary or shutil.which(CLI_BINARY)
    if not binary:
        return {}
    try:
        proc = subprocess.run(
            [binary, "agents", "--json"],
            capture_output=True,
            timeout=BG_AGENTS_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    if proc.returncode != 0:
        return {}
    try:
        entries = json.loads(proc.stdout or b"[]")
    except ValueError:
        return {}
    if not isinstance(entries, list):
        return {}
    owned: dict[str, str] = {}
    for entry in entries:
        # Interactive sessions are listed too; only a background worker holds
        # its conversation against a resume.
        if not isinstance(entry, dict) or entry.get("kind") != "background":
            continue
        pid = entry.get("pid")
        if not isinstance(pid, int) or not pid_alive(pid):
            continue
        session_id = entry.get("sessionId")
        short = entry.get("id")
        if (
            isinstance(session_id, str)
            and session_id
            and isinstance(short, str)
            and short
        ):
            owned[session_id] = short
    return owned


# Last ``bg_agents()`` snapshot: (monotonic stamp, roster).
_bg_agents_cache: tuple[float, dict[str, str]] | None = None


def _bg_agents_refresh(binary: str | None = None) -> dict[str, str]:
    """Spawn ``bg_agents()`` and stamp the snapshot."""
    global _bg_agents_cache
    result = bg_agents(binary)
    _bg_agents_cache = (time.monotonic(), result)
    return result


def bg_agents_cached() -> dict[str, str]:
    """``bg_agents()``, served from the last snapshot when young enough.

    A context menu must open in the sub-100ms band, but its branch markers
    would otherwise spawn the CLI on the click path. The sessions poll refreshes
    the snapshot every 30s anyway, so a menu open between polls is served
    spawn-free AND its markers agree with the row chips - same snapshot. A stale
    or absent snapshot falls through to a real spawn.
    """
    snapshot = _bg_agents_cache
    if (
        snapshot is not None
        and time.monotonic() - snapshot[0] <= BG_AGENTS_CACHE_MAX_AGE_S
    ):
        return snapshot[1]
    return _bg_agents_refresh()


def _parse_attach_id(cmdline: bytes) -> str | None:
    """The background-agent id a ``claude attach <id>`` cmdline is showing.

    An attach client is the only Claude launch that identifies its conversation
    NOWHERE else: it carries no ``--session-id``/``--resume`` and writes no pid
    file, because the conversation lives in the daemon's worker rather than in
    this process. Its argv is the only handle on it - without this parse every
    click on a background-agent row spawns yet another attach terminal instead
    of focusing the open one. ``attach`` must be the FIRST positional and the id
    must look like an id, so a prompt that merely contains the word cannot be
    mistaken for one.
    """
    args = [p.decode("utf-8", "replace") for p in cmdline.split(b"\x00") if p]
    if len(args) < 3 or args[1] != "attach":
        return None
    return args[2] if _ATTACH_ID_RE.fullmatch(args[2]) else None


def _expand_short_session_id(short: str) -> str | None:
    """Full conversation id behind a background agent's short id, or None.

    ``claude attach`` takes the 8-char short form, but the panel identifies
    terminals by full conversation id. The short id is that id's own prefix, so
    the transcript filename resolves it. Matches are compared by conversation
    id, not by path: a renamed project leaves the SAME conversation under two
    encoded dirs, and treating that as ambiguous would cost reuse for every
    project that was ever renamed. Genuine ambiguity - two conversations sharing
    a prefix - yields None rather than a guess, so the cost is a duplicate
    terminal, never a terminal claimed for the wrong conversation.
    """
    if not _ATTACH_ID_RE.fullmatch(short):
        return None
    try:
        stems = {
            p.stem
            for p in (claude_dir() / PROJECTS_DIRNAME).glob(
                f"*/{glob.escape(short)}*.jsonl"
            )
        }
    except OSError:
        return None
    return stems.pop() if len(stems) == 1 else None


def _read_legacy_pin(project_dir: Path) -> str | None:
    """The pin the retired standalone extension left in a project dir.

    Read-only, and charset-gated before it can reach a path join: a corrupt or
    tampered sidecar is ignored and recency resumes.
    """
    try:
        sid = (project_dir / LEGACY_PIN_FILENAME).read_text(encoding="utf-8").strip()
    except (OSError, ValueError):
        return None
    if not sid or not all(c.isalnum() or c == "-" for c in sid):
        return None
    return sid


class ClaudeStore(SessionStore):
    """``~/.claude/projects`` as a session store."""

    comm_name = CLI_BINARY

    # -- paths -----------------------------------------------------------

    def _projects_root(self) -> Path:
        return claude_dir() / PROJECTS_DIRNAME

    def _project_dir(self, encoded_path: str) -> Path | None:
        """``projects/<encoded_path>`` when it is a real dir under the root.

        Path-traversal gate for every endpoint that takes an ``encoded_path``:
        a single safe segment, and the resolved directory must still sit under
        the projects root after symlinks.
        """
        if not is_safe_segment(encoded_path):
            return None
        base = self._projects_root().resolve()
        project_dir = (self._projects_root() / encoded_path).resolve()
        try:
            project_dir.relative_to(base)
        except ValueError:
            return None
        return project_dir if project_dir.is_dir() else None

    def _pin(self, encoded_path: str, project_dir: Path) -> str | None:
        """The conversation pinned as this project's current one.

        The core's state file is authoritative. The retired standalone
        extension's ``.jl-current`` sidecar is read as a fallback so an
        upgrading user keeps the conversation they had switched to; it is never
        written, because pins are the core's to keep now.
        """
        return state.read_pin(self.provider_id, encoded_path) or _read_legacy_pin(
            project_dir
        )

    # -- resolution ------------------------------------------------------

    def _resolve_latest(
        self, project_dir: Path, index: dict | None, pinned: str | None
    ) -> dict | None:
        """Pick a project's representative conversation, trusting the filesystem.

        Claude's own ``sessions-index.json`` drifts - an interrupted write or a
        crash leaves it naming only an older conversation while newer
        transcripts sit on disk - so the transcripts are scanned directly and
        the index is used for enrichment only.

        Among them the preferred one is the most recent whose recorded cwd is
        consistent with how Claude named this directory. That matters after a
        folder rename: Claude re-homes the old transcripts under the new
        directory but their records still carry the old cwd, so the newest file
        on disk can point at a path that no longer exists. A pin wins over
        recency, but only while it still resolves - a dangling or cwd-foreign
        pin is ignored and the recency scan resumes.
        """
        jsonls = list(project_dir.glob("*.jsonl"))
        if not jsonls:
            return None
        jsonls.sort(key=_mtime, reverse=True)
        dirname = project_dir.name

        chosen: Path | None = None
        chosen_cwd: str | None = None

        if pinned:
            pin_jsonl = project_dir / f"{pinned}.jsonl"
            if is_safe_segment(pinned) and pin_jsonl.is_file():
                cwd = _jsonl_cwd(pin_jsonl)
                project_path = _project_path_for_cwd(cwd, dirname) if cwd else None
                if project_path:
                    chosen, chosen_cwd = pin_jsonl, project_path

        if chosen is None:
            for jsonl in jsonls:
                cwd = _jsonl_cwd(jsonl)
                project_path = _project_path_for_cwd(cwd, dirname) if cwd else None
                if project_path:
                    chosen, chosen_cwd = jsonl, project_path
                    break
        if chosen is None:
            # No transcript records a cwd that encodes to this directory name -
            # the user renamed both the project folder and the encoded dir after
            # the transcripts were written. Walk the filesystem for a real
            # directory that encodes to the name; only if even that fails is the
            # stale cwd accepted.
            chosen = jsonls[0]
            chosen_cwd = _find_path_matching_encoded(dirname) or _jsonl_cwd(chosen)

        sid = chosen.stem
        fs_mtime = int(_mtime(chosen) * 1000)
        records = _tail_records(chosen)

        indexed: dict | None = None
        if isinstance(index, dict):
            for entry in index.get("entries") or []:
                if isinstance(entry, dict) and entry.get("sessionId") == sid:
                    indexed = entry
                    break

        latest = dict(indexed) if indexed is not None else {
            "sessionId": sid,
            "summary": "",
            "firstPrompt": "",
            "messageCount": 0,
            "created": None,
            "modified": None,
            "gitBranch": None,
        }
        # The index is distrusted on exactly the two fields it is known to get
        # wrong: an mtime it never refreshed, and an ``originalPath`` that a
        # folder rename left stale.
        latest["fileMtime"] = max(int(latest.get("fileMtime") or 0), fs_mtime)
        if chosen_cwd:
            latest["projectPath"] = chosen_cwd
        latest["customTitle"] = records.get("custom_title")
        latest["agentColor"] = records.get("agent_colour")
        return latest

    # -- listing ---------------------------------------------------------

    def list_sessions(self, root_dir: str | None = None) -> list[dict]:
        """One row per project folder, newest first.

        ``root_dir`` is ignored: Claude's store is global, and a conversation
        held outside the directory Jupyter serves is still worth resuming - the
        panel only loses the ability to reveal it in the file browser.
        """
        projects_dir = self._projects_root()
        if not projects_dir.is_dir():
            return []

        pins = state.load_state(self.provider_id)["pins"]
        states = _session_state_by_cwd(claude_dir())
        # One lookup per poll, shared by every row - and this poll IS what keeps
        # the snapshot fresh for the cache-served branches path.
        bg_owned = _bg_agents_refresh()

        rows: list[dict] = []
        for project_dir in sorted(projects_dir.iterdir()):
            if not project_dir.is_dir():
                continue
            index = load_json(project_dir / INDEX_FILENAME)
            pinned = pins.get(project_dir.name) or _read_legacy_pin(project_dir)
            latest = self._resolve_latest(project_dir, index, pinned)
            if latest is None:
                continue

            # ``_resolve_latest`` already picked the cwd consistent with this
            # directory's name when one exists, so its ``projectPath`` is
            # trusted first; the index's ``originalPath`` is the value most
            # likely to be stale after a rename, and the lossy decode is last.
            original_path = (
                index.get("originalPath")
                if isinstance(index, dict)
                and isinstance(index.get("originalPath"), str)
                else None
            )
            project_path: str | None = None
            for candidate in (latest.get("projectPath"), original_path):
                if isinstance(candidate, str) and candidate:
                    project_path = candidate
                    if _encode_path(candidate) == project_dir.name:
                        break
            if not project_path:
                project_path = _decode_dirname(project_dir.name)

            # Honour the conversation's own name: ``/rename`` persists as a
            # ``custom-title`` record, so the chosen transcript's title is
            # authoritative. The pid record's ``name`` (older Claude versions
            # wrote the rename there) is the fallback, then the folder basename.
            session_state = states.get(project_path) or {}
            custom_title = latest.get("customTitle")
            session_name = (
                custom_title
                if isinstance(custom_title, str) and custom_title.strip()
                else session_state.get("name")
            )
            if isinstance(session_name, str) and session_name.strip():
                name, name_source = session_name, "session"
            else:
                name = os.path.basename(project_path) or project_dir.name
                name_source = "basename"

            session_id = latest.get("sessionId") or ""
            rows.append({
                "project_path": project_path,
                "encoded_path": project_dir.name,
                "session_id": session_id,
                "name": name,
                "name_source": name_source,
                "summary": latest.get("summary") or "",
                "first_prompt": latest.get("firstPrompt") or "",
                "message_count": latest.get("messageCount") or 0,
                "created": latest.get("created"),
                "modified": latest.get("modified"),
                "file_mtime": latest.get("fileMtime") or 0,
                "git_branch": latest.get("gitBranch"),
                "extra_sessions": max(
                    len(list(project_dir.glob("*.jsonl"))) - 1, 0
                ),
                "remote_control": bool(session_state.get("remote_control")),
                # The conversation's own ``/color``, already read from the tail
                # scan above - British on the wire and here alike, so the core
                # never re-derives per row what the store has in hand.
                "colour": _TAB_COLOUR_ID.get(latest.get("agentColor") or ""),
                # Set means "open by attaching, not resuming" - a resume would
                # be refused. Display only: the launch endpoint decides the verb
                # itself, where it cannot be stale.
                "bg_id": bg_owned.get(session_id),
            })

        # Two encoded folders can resolve to the same cwd - a conversation
        # started before a rename keeps its old folder. The canonical row is the
        # one whose folder name matches the encoding of the path; failing that,
        # the more recent one.
        by_path: dict[str, dict] = {}
        for row in rows:
            path = row["project_path"]
            previous = by_path.get(path)
            if previous is None:
                by_path[path] = row
                continue
            canonical = _encode_path(path)
            is_canonical = row["encoded_path"] == canonical
            was_canonical = previous["encoded_path"] == canonical
            if is_canonical and not was_canonical:
                by_path[path] = row
            elif is_canonical == was_canonical and (
                row["file_mtime"] > previous["file_mtime"]
            ):
                by_path[path] = row

        deduped = list(by_path.values())
        deduped.sort(key=lambda r: r["file_mtime"], reverse=True)
        return deduped

    def list_branches(
        self, encoded_path: str, include_extras: bool = False
    ) -> dict | None:
        """A project's other conversations, newest first.

        The label prefers the branch's own ``custom-title`` record, then the
        index summary, then the first 8 characters of its id. ``bg_id`` is
        filled only when ``include_extras`` is set, and then from the
        poll-refreshed snapshot, so the context-menu open stays spawn-free; the
        fork watcher polls without it and never pays for the CLI at all.
        """
        project_dir = self._project_dir(encoded_path)
        if project_dir is None:
            return None
        index = load_json(project_dir / INDEX_FILENAME)
        latest = self._resolve_latest(
            project_dir, index, self._pin(encoded_path, project_dir)
        )
        if latest is None:
            return None
        current = latest.get("sessionId")

        summaries: dict[str, str] = {}
        if isinstance(index, dict):
            for entry in index.get("entries") or []:
                if isinstance(entry, dict) and isinstance(entry.get("sessionId"), str):
                    summary = entry.get("summary")
                    if isinstance(summary, str) and summary.strip():
                        summaries[entry["sessionId"]] = summary

        jsonls = [p for p in project_dir.glob("*.jsonl") if p.stem != current]
        jsonls.sort(key=_mtime, reverse=True)
        bg_owned = bg_agents_cached() if include_extras else {}
        branches = [
            {
                "session_id": jsonl.stem,
                "file_mtime": int(_mtime(jsonl) * 1000),
                "label": (
                    _tail_records(jsonl).get("custom_title")
                    or summaries.get(jsonl.stem)
                    or jsonl.stem[:8]
                ),
                "bg_id": bg_owned.get(jsonl.stem),
            }
            for jsonl in jsonls
        ]
        return {
            "current": current,
            "total": len(jsonls) + 1,
            "branches": branches,
        }

    def resolve_current(self, encoded_path: str) -> str | None:
        project_dir = self._project_dir(encoded_path)
        if project_dir is None:
            return None
        latest = self._resolve_latest(
            project_dir,
            load_json(project_dir / INDEX_FILENAME),
            self._pin(encoded_path, project_dir),
        )
        return latest.get("sessionId") if latest else None

    def switch(self, encoded_path: str, session_id: str) -> dict | None:
        """Make ``session_id`` the project's current conversation.

        Two writes, for two different readers: the transcript's mtime is touched
        so Claude's own ``--resume`` picker stays roughly aligned, and the pin is
        written so this store's resolution sticks even after later activity in
        another conversation bumps its mtime higher. The pin is written only
        when the branch can actually become current - a cwd-foreign branch
        cannot, so pinning it would clobber a valid pin and silently fall back
        to recency. ``current`` is re-resolved after both writes, so it differs
        from ``requested`` exactly when the switch could not take.
        """
        if not is_safe_segment(session_id):
            return None
        project_dir = self._project_dir(encoded_path)
        if project_dir is None:
            return None
        jsonl = project_dir / f"{session_id}.jsonl"
        if not jsonl.is_file():
            return {"error": "branch_not_found"}
        try:
            os.utime(jsonl, None)
        except OSError:
            pass
        cwd = _jsonl_cwd(jsonl)
        if cwd and _project_path_for_cwd(cwd, project_dir.name):
            state.write_pin(self.provider_id, encoded_path, session_id)
        return {
            "requested": session_id,
            "current": self.resolve_current(encoded_path),
        }

    # -- mutation --------------------------------------------------------

    def remove(self, encoded_path: str, to_trash: bool = False) -> list[str] | None:
        """Drop a project's whole history.

        One directory disposal, so it is all or nothing: every id the project
        held on success, none of them on failure. The ids are read BEFORE the
        disposal - afterwards there is nothing left to enumerate.
        """
        project_dir = self._project_dir(encoded_path)
        if project_dir is None:
            return None
        known = self.project_session_ids(encoded_path)
        try:
            dispose_path(project_dir, to_trash)
        except OSError:
            return None
        return known

    def delete_branches(
        self, encoded_path: str, session_ids: list, to_trash: bool = False
    ) -> list[str] | None:
        """Drop the named conversations, never the current one.

        Per item, so one unwritable transcript costs its own conversation and
        not the rest of the selection - and the id is left out of the answer,
        which is what keeps the survivor's stored colour.
        """
        if not isinstance(session_ids, list) or not session_ids:
            return None
        if not all(is_safe_segment(sid) for sid in session_ids):
            return None
        project_dir = self._project_dir(encoded_path)
        if project_dir is None:
            return None
        keep = self.resolve_current(encoded_path)
        removed: list[str] = []
        for sid in session_ids:
            # Already gone was removed by someone else, silently.
            if sid == keep or not (project_dir / f"{sid}.jsonl").is_file():
                continue
            try:
                self._dispose_conversation(project_dir, sid, to_trash)
            except OSError as err:
                _log.warning("claude could not dispose of %s: %s", sid, err)
                continue
            removed.append(sid)
        return removed

    def _dispose_conversation(
        self, project_dir: Path, session_id: str, to_trash: bool
    ) -> None:
        """Drop one conversation: its transcript and its subagent directory.

        Anything else in the folder - ``sessions-index.json``, ``memory/`` - is
        left alone.
        """
        dispose_path(project_dir / f"{session_id}.jsonl", to_trash)
        side_dir = project_dir / session_id
        if side_dir.is_dir():
            dispose_path(side_dir, to_trash)

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
        """The argv that opens a conversation.

        ``fork_from`` is never consumed: Claude forks from a flag pair under an
        id the store minted (``fork_strategy: native-flag``), so a branch
        arrives as ``fork_session_id``.

        Resume versus attach is decided HERE rather than by the caller: a
        conversation held by a live background agent refuses ``--resume``, and
        an agent can start or finish inside the panel's 30s poll window, so a
        verb chosen in the browser can be wrong by the time the launch lands.
        Only a plain open can be attached to - a fork is Claude's own documented
        escape from an agent-owned conversation, and a new conversation has no
        agent yet.
        """
        attach_id: str | None = None
        if session_id and not fork_session_id:
            attach_id = bg_agents(cli_path).get(session_id)

        if attach_id:
            argv = [cli_path, "attach", attach_id]
        elif session_id:
            argv = [cli_path, "--resume", session_id]
        elif new_session_id:
            argv = [cli_path, "--session-id", new_session_id]
        else:
            argv = [cli_path]
        if fork_session_id:
            argv += ["--fork-session", "--session-id", fork_session_id]
        # ``attach`` takes no options - it answers an extra argument with
        # "warning: extra arguments ignored". The running agent already owns its
        # permission mode and its name, so passing either would print that
        # warning into the user's terminal and promise something it never did.
        if attach_id:
            return argv
        if mode == MODE_SKIP_PERMISSIONS:
            argv.append("--dangerously-skip-permissions")
        if isinstance(name, str) and name.strip():
            argv += ["-n", name.strip()]
        return argv

    # -- terminal identity ----------------------------------------------

    def parse_session_id(self, cmdline: bytes) -> str | None:
        """The conversation a Claude cmdline is running, from its flags.

        A forked launch is ``claude --resume <parent> --fork-session
        --session-id <fork>`` - the running conversation is the FORK, so
        ``--session-id`` wins over ``--resume`` when both are present. Both the
        ``--flag <value>`` and ``--flag=<value>`` forms are understood; a
        cmdline with neither flag is a brand-new conversation (None).
        """
        args = cmdline_args(cmdline)
        return flag_value(args, "--session-id") or flag_value(args, "--resume")

    def session_id_for_pid(self, pid: int) -> str | None:
        """The conversation the Claude process at ``pid`` is on.

        An attach client is checked FIRST, and only it. Claude never prunes
        ``sessions/``, so a pid file left by a long-dead process can name the
        pid an attach client later gets. Every other launch flavour overwrites
        such a leftover with its own pid file; an attach client writes none, so
        the stale id would win permanently - focusing this terminal for an
        unrelated row and tinting it with that conversation's colour. Its argv
        is self-identifying and mutually exclusive with the flags below, so
        checking it first changes no other path.
        """
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as fh:
                cmdline = fh.read()
        except OSError:
            return None
        short = _parse_attach_id(cmdline)
        attached = _expand_short_session_id(short) if short else None
        return (
            attached
            or _session_id_from_pidfile(pid)
            or self.parse_session_id(cmdline)
        )

    # -- colour ----------------------------------------------------------

    def default_colour(self, session_id: str) -> str | None:
        """The conversation's own ``/color`` colour, as a tab colour id.

        For the TERMINAL probe only - once per probed terminal, never per row.
        A row carries its own colour from the tail scan ``list_sessions``
        already performs; a probed terminal may be running any conversation of
        a project, including one no row represents, and resolving that by row
        would clear the tint of every such terminal. The id is a file NAME,
        never a glob pattern, so it is escaped before it reaches the glob.
        """
        if not is_safe_segment(session_id):
            return None
        try:
            matches = self._projects_root().glob(
                f"*/{glob.escape(session_id)}.jsonl"
            )
            for path in matches:
                return _TAB_COLOUR_ID.get(_tail_records(path).get("agent_colour") or "")
        except OSError:
            return None
        return None


DESCRIPTOR = ProviderDescriptor(
    id="claude",
    label="Claude Code",
    cli_binary=CLI_BINARY,
    capabilities=Capabilities(
        # The CLI forks in-process from a flag pair, under an id the FRONTEND
        # mints and carries on the launch - so there is no server-side fork.
        fork_strategy="native-flag",
        # Claude owns its conversations' colours through ``/color``, so the
        # extension's write-back store never overrides them.
        colour_source="native",
        launch_modes=(MODE_SKIP_PERMISSIONS,),
    ),
    legacy=LegacySource(
        plugin_id="jupyterlab_claude_code_extension",
        state_file="~/.claude/jupyterlab_claude_code_extension.json",
        settings_map={
            "dangerouslySkipPermissions": (
                f"providers.claude.{MODE_SKIP_PERMISSIONS}"
            ),
        },
    ),
)

STORE = ClaudeStore()
