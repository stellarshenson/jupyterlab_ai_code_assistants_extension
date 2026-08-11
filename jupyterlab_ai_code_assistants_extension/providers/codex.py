"""The Codex provider: OpenAI's ``codex`` CLI.

Ported from ``jupyterlab_codex_extension`` v0.6.12. Codex indexes its threads in
``~/.codex/state_<N>.sqlite`` and this store reads that index READ-ONLY, falling
back to scanning the rollout JSONL files when the database is missing, locked,
or from a generation whose schema is unreadable - the same degradation the Codex
CLI itself performs.

Codex's data is never modified, but "read-only" is not "writes nothing": its
store is in WAL mode, and reading through a WAL requires sqlite to create the
``-shm``/``-wal`` index beside the db. Those two files are the only thing this
module ever puts in Codex's directory, and only when the directory is writable -
see ``_connect_ro`` for the immutable fallback.

Destructive operations shell to ``codex archive`` / ``codex delete --force``
rather than touching the store, so Codex's own lifecycle stays authoritative.

Three shape notes for the core contract:

* ``encoded_path`` is the plain project cwd. Codex keys threads by ``cwd`` and
  has no path encoding at all, so the opaque token the core passes around is
  simply the project path - the adapter maps it into the encoded-path slot and
  nothing else in the system needs to know.
* the extension's own favourites and pins live in the core state store, keyed by
  provider id; this module only READS the pin, and never writes the retired
  extension's ``~/.codex/jupyterlab_codex_extension.json`` sidecar (migration
  reads it once, in place).
* thread ids are UUID-shaped and every one of them ends up in a subprocess argv,
  so each is re-gated by shape at the point of use, whatever its provenance.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import urllib.parse
from pathlib import Path
from typing import Any

from ..core import state
from ..core.registry import Capabilities, LegacySource, ProviderDescriptor
from ..core.store import SessionStore, process_comm


# Degradations here are otherwise invisible: a swallowed sqlite error looks
# exactly like an empty store, and a refused `codex archive` reaches the panel
# as a bare `remove_failed`.
_log = logging.getLogger(__name__)

PROVIDER_ID = "codex"
CLI_BINARY = "codex"
# What a running codex looks like in /proc. Verified against the shipped 0.145.0
# musl launcher, which execs in place.
CODEX_COMM = "codex"
SESSIONS_DIRNAME = "sessions"
# The retired standalone extension's sidecar, read once by the migration.
LEGACY_STATE_FILENAME = "jupyterlab_codex_extension.json"
# Codex's own name for its unsafe switch, used verbatim as the settings key and
# the launch-mode token.
BYPASS_MODE = "dangerouslyBypassApprovalsAndSandbox"
BYPASS_FLAG = "--dangerously-bypass-approvals-and-sandbox"

# Codex thread ids are UUIDs (v7). Restrict every id that reaches a subprocess
# argv or a db query to this shape so a tampered value cannot smuggle a flag
# (e.g. ``--all``) into a ``codex`` invocation.
_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
    r"-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
# How long a single ``codex archive`` / ``codex delete`` invocation may run.
# Measured at ~70 ms against 0.145.0, but the standalone launcher self-extracts
# on every start and a real archive reaches the app-server, so keep a generous
# margin rather than tuning to the fast path.
_CLI_TIMEOUT_S = 30
# Columns ``_threads_from_db`` needs; anything missing in an older/newer schema is
# selected as NULL so one query shape serves every known generation.
_THREAD_COLUMNS = (
    "id",
    "cwd",
    "name",
    "preview",
    "first_user_message",
    "created_at",
    "updated_at",
    "created_at_ms",
    "updated_at_ms",
    "recency_at_ms",
    "git_branch",
    "model",
    "tokens_used",
    "source",
    "archived",
    "has_user_event",
)
_ROLLOUT_META_SCAN_LINES = 10


def codex_home() -> Path:
    """The Codex config root (``$CODEX_HOME`` or ``~/.codex``)."""
    env = os.environ.get("CODEX_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".codex"


def is_thread_id(value: object) -> bool:
    """Whether ``value`` is a Codex thread id (UUID-shaped)."""
    return isinstance(value, str) and _UUID_RE.fullmatch(value) is not None


def state_db_path(codex_root: Path) -> Path | None:
    """The newest-generation ``state_<N>.sqlite`` under ``codex_root``.

    The generation counter is baked into the Codex binary (``state_5`` at
    0.145.0); an upgrade abandons the old file and creates ``state_<N+1>``.
    Picking the highest N keeps the panel working across upgrades as long as
    the ``threads`` schema stays readable; when it is not, callers fall back to
    the rollout scan.
    """
    best: tuple[int, Path] | None = None
    try:
        for path in codex_root.glob("state_*.sqlite"):
            m = re.fullmatch(r"state_(\d+)\.sqlite", path.name)
            if not m:
                continue
            n = int(m.group(1))
            if best is None or n > best[0]:
                best = (n, path)
    except OSError:
        return None
    return best[1] if best else None


def _connect_ro(db_path: Path) -> sqlite3.Connection:
    """Open the state db read-only; raises ``sqlite3.Error`` on failure.

    The path is percent-quoted: a ``#``, ``?`` or ``%`` anywhere in
    ``$CODEX_HOME`` would otherwise be parsed as URI syntax and the open would
    fail into the degraded rollout scan for no good reason.

    Two attempts, in this order. Plain ``mode=ro`` reads THROUGH Codex's WAL, so
    it sees the newest committed rows - but sqlite has to create the
    ``-shm``/``-wal`` index beside the db to do that, which needs a writable
    directory. Where that is impossible (read-only home, home owned by another
    uid) retry with ``immutable=1``, which reads the main db file alone: it
    creates nothing, at the cost of missing whatever is still only in the WAL.
    Fresh-but-incomplete beats correct-but-blank.
    """
    uri = "file:" + urllib.parse.quote(str(db_path))
    last: sqlite3.Error | None = None
    for params in ("mode=ro", "mode=ro&immutable=1"):
        conn = None
        try:
            conn = sqlite3.connect(f"{uri}?{params}", uri=True, timeout=2)
            # Probe before returning. Opening proves nothing: against a WAL
            # store in a non-writable directory the connect SUCCEEDS and the
            # first statement is what raises, because that is when sqlite needs
            # to create the -shm index. Without this the immutable retry could
            # never fire in the case it exists for.
            conn.execute("PRAGMA schema_version").fetchone()
            return conn
        except sqlite3.Error as err:
            last = err
            if conn is not None:
                conn.close()
    raise last if last is not None else sqlite3.Error("connect failed")


def _first_ms(ms: Any, seconds: Any) -> int:
    """Best millisecond timestamp from an ``*_ms`` column or a seconds one."""
    if isinstance(ms, int) and ms > 0:
        return ms
    if isinstance(seconds, int) and seconds > 0:
        return seconds * 1000
    return 0


def _threads_from_db(codex_root: Path) -> list[dict] | None:
    db_path = state_db_path(codex_root)
    if db_path is None:
        return None
    try:
        conn = _connect_ro(db_path)
    except sqlite3.Error as err:
        _log.warning("cannot read %s (%s) - scanning rollouts instead", db_path, err)
        return None
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(threads)").fetchall()}
        if "id" not in cols or "cwd" not in cols:
            return None
        select = ", ".join(
            c if c in cols else f"NULL AS {c}" for c in _THREAD_COLUMNS
        )
        rows = conn.execute(f"SELECT {select} FROM threads").fetchall()
    except sqlite3.Error as err:
        _log.warning("%s has no readable threads table (%s)", db_path, err)
        return None
    finally:
        conn.close()

    threads: list[dict] = []
    for row in rows:
        rec = dict(zip(_THREAD_COLUMNS, row))
        tid = rec.get("id")
        cwd = rec.get("cwd")
        # Same shape gate as the rollout path: an id read from the store is no
        # more trusted than one off the wire, and both end up in argv.
        if not is_thread_id(tid):
            continue
        if not isinstance(cwd, str) or not cwd:
            continue
        created_ms = _first_ms(rec.get("created_at_ms"), rec.get("created_at"))
        updated_ms = _first_ms(rec.get("updated_at_ms"), rec.get("updated_at"))
        recency_ms = rec.get("recency_at_ms")
        if not isinstance(recency_ms, int) or recency_ms <= 0:
            recency_ms = updated_ms or created_ms or 0
        threads.append({
            "id": tid,
            "cwd": cwd,
            "name": rec.get("name") if isinstance(rec.get("name"), str) else None,
            "preview": rec.get("preview") or "",
            "first_user_message": rec.get("first_user_message") or "",
            "created_ms": created_ms,
            "updated_ms": updated_ms,
            "recency_ms": recency_ms,
            "git_branch": rec.get("git_branch"),
            "model": rec.get("model"),
            "tokens_used": rec.get("tokens_used") or 0,
            "source": rec.get("source"),
            "archived": bool(rec.get("archived")),
            "has_user_event": bool(rec.get("has_user_event")),
        })
    return threads


def _rollout_meta(path: Path) -> tuple[str, str] | None:
    """The ``(thread_id, cwd)`` recorded near the top of a rollout file."""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh):
                if i >= _ROLLOUT_META_SCAN_LINES:
                    break
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(record, dict):
                    continue
                payload = record.get("payload")
                candidates = [record]
                if isinstance(payload, dict):
                    candidates.append(payload)
                for cand in candidates:
                    tid = cand.get("id")
                    cwd = cand.get("cwd")
                    if is_thread_id(tid) and isinstance(cwd, str) and cwd:
                        return tid, cwd
    except OSError:
        return None
    return None


def _threads_from_rollouts(codex_root: Path) -> list[dict]:
    """Degraded thread list scanned from ``sessions/**/rollout-*.jsonl``.

    Each rollout's opening lines carry a session-meta record with the thread id
    and cwd. Only the id, cwd and file mtime are recoverable this way - names,
    previews and git metadata are absent, and ``.jsonl.zst`` compressed rollouts
    are skipped. Good enough to keep the panel alive when the sqlite index is
    unreadable.
    """
    sessions_dir = codex_root / SESSIONS_DIRNAME
    if not sessions_dir.is_dir():
        return []
    threads: list[dict] = []
    seen: set[str] = set()
    for path in sessions_dir.rglob("rollout-*.jsonl"):
        meta = _rollout_meta(path)
        if meta is None:
            continue
        tid, cwd = meta
        if tid in seen:
            continue
        seen.add(tid)
        try:
            mtime_ms = int(path.stat().st_mtime * 1000)
        except OSError:
            continue
        threads.append({
            "id": tid,
            "cwd": cwd,
            "name": None,
            "preview": "",
            "first_user_message": "",
            "created_ms": 0,
            "updated_ms": mtime_ms,
            "recency_ms": mtime_ms,
            "git_branch": None,
            "model": None,
            "tokens_used": 0,
            "source": None,
            "archived": False,
            # The db's visibility filter is unavailable here; treat every
            # rollout as visible so the degraded list errs on showing rows.
            "has_user_event": True,
        })
    return threads


def list_threads(codex_root: Path) -> list[dict]:
    """All Codex threads as plain dicts, newest-activity first.

    Tries the sqlite index first; on ANY failure (missing db, lock, schema from
    an unknown generation) falls back to scanning the rollout files.
    """
    threads = _threads_from_db(codex_root)
    # Empty is treated as failure, not as "no sessions": the newest
    # generation's db opening cleanly but yielding nothing usable is exactly
    # what a Codex store upgrade or a column-type change looks like, and
    # silently emptying the panel is the worst possible answer. On a genuinely
    # fresh install the rollout scan is empty too, so this costs one rglob.
    if not threads:
        threads = _threads_from_rollouts(codex_root)
    threads.sort(key=lambda t: t["recency_ms"], reverse=True)
    return threads


def _is_visible(thread: dict) -> bool:
    """Mirror the Codex picker's notion of a session worth listing.

    A thread that never saw a user event and has no preview is an empty husk
    (started and abandoned before the first turn) - hidden from the project
    rows, but still enumerable as a branch so the fork watcher can discover a
    thread before its first turn.
    """
    return bool(
        thread["has_user_event"]
        or thread["preview"]
        or thread["first_user_message"]
    )


def live_cwds() -> set[str]:
    """The working directories of every live ``codex`` process.

    A row whose project path appears here gets the activity dot. Codex keeps no
    per-pid session record, so "a Codex process is running in this project" is
    the available liveness signal. Linux ``/proc`` only - other platforms report
    nothing.
    """
    cwds: set[str] = set()
    if sys.platform != "linux":
        return cwds
    try:
        pids = [int(name) for name in os.listdir("/proc") if name.isdigit()]
    except OSError:
        return cwds
    for pid in pids:
        if process_comm(pid) != CODEX_COMM:
            continue
        try:
            cwd = os.readlink(f"/proc/{pid}/cwd")
        except OSError:
            continue
        if cwd.startswith("/"):
            # No realpath: a /proc/<pid>/cwd readlink is already resolved, and
            # so is the getcwd() codex records - normalising only this side
            # would make the two stop matching if it ever changed anything.
            cwds.add(cwd)
    return cwds


class CodexStore(SessionStore):
    """Codex's thread index, behind the shared session-store contract."""

    comm_name = CODEX_COMM

    # -- thread population ----------------------------------------------

    def _project_threads(self, project_path: str) -> list[dict]:
        """One project's live threads, recency-sorted, husks included.

        Archived and sub-agent threads are excluded, exactly as
        ``list_sessions`` excludes them. Husks stay in because this is the
        ENUMERATION population: the fork watcher must see a new thread before
        its first turn lands, and cleanup must be able to sweep abandoned ones.
        Which of them is *current* is a separate question - use
        ``_resolve_project_current``, never ``threads[0]``.
        """
        if not isinstance(project_path, str) or not project_path:
            return []
        return [
            t
            for t in list_threads(codex_home())
            if t["cwd"] == project_path
            and not t["archived"]
            and t["source"] != "sub_agent"
        ]

    def _pin(self, project_path: str) -> str | None:
        return state.read_pin(self.provider_id, project_path)

    @staticmethod
    def _resolve(threads: list[dict], pin: str | None) -> dict:
        """A project's representative thread: the pin when it still exists,
        else the most recently active one. ``threads`` must be non-empty and
        recency-sorted descending."""
        if pin:
            for t in threads:
                if t["id"] == pin:
                    return t
        return threads[0]

    def _resolve_project_current(
        self, project_path: str, threads: list[dict]
    ) -> dict:
        """The conversation the PANEL calls current for this project.

        Resolution runs over the VISIBLE population - the same one
        ``list_sessions`` builds rows from - so a husk that happens to carry the
        newest recency can never become a "current" the user cannot see, and a
        destructive path can never spare the invisible one while disposing the
        visible one. Falls back to the full list for a project that is nothing
        but husks, where there is no visible thread to prefer.
        """
        visible = [t for t in threads if _is_visible(t)]
        pin = self._pin(project_path)
        return self._resolve(visible or threads, pin)

    # -- listing ---------------------------------------------------------

    def list_sessions(self, root_dir: str | None = None) -> list[dict]:
        """One row per project (distinct thread cwd), newest activity first.

        ``root_dir`` is ignored: Codex records an absolute cwd per thread and a
        user's projects routinely sit outside whatever directory Jupyter happens
        to serve, so scoping the listing to it would hide rows the panel can
        still open a terminal in.
        """
        by_cwd: dict[str, list[dict]] = {}
        for thread in list_threads(codex_home()):
            if thread["archived"] or thread["source"] == "sub_agent":
                continue
            if not _is_visible(thread):
                continue
            by_cwd.setdefault(thread["cwd"], []).append(thread)

        active = live_cwds()
        rows: list[dict] = []
        for cwd, threads in by_cwd.items():
            current = self._resolve(threads, self._pin(cwd))
            basename = os.path.basename(cwd.rstrip("/")) or cwd
            name = current["name"]
            if isinstance(name, str) and name.strip():
                name_source = "session"
            else:
                name = basename
                name_source = "basename"
            rows.append({
                "project_path": cwd,
                # Codex has no path encoding: the project key IS the cwd.
                "encoded_path": cwd,
                "session_id": current["id"],
                "name": name,
                "name_source": name_source,
                # Codex's index records no per-thread turn count, and deriving
                # one would mean opening every rollout on every 30s poll.
                "message_count": 0,
                "model": current["model"],
                "tokens_used": current["tokens_used"],
                "file_mtime": current["recency_ms"],
                "git_branch": current["git_branch"],
                "live": cwd in active,
                "extra_sessions": len(threads) - 1,
            })

        rows.sort(key=lambda r: r["file_mtime"], reverse=True)
        return rows

    def list_branches(
        self, encoded_path: str, include_extras: bool = False
    ) -> dict | None:
        """A project's other conversations, newest first, the current excluded.

        Unlike ``list_sessions`` this does NOT hide empty husks: the fork
        watcher must see a new thread before its first turn lands.
        ``include_extras`` is inert - Codex has no background agents, so there
        are no decorations to pay for.
        """
        threads = self._project_threads(encoded_path)
        if not threads:
            return None
        current = self._resolve_project_current(encoded_path, threads)
        branches = []
        for t in threads:
            if t["id"] == current["id"]:
                continue
            label = (
                (t["name"] or "").strip()
                or (t["preview"] or "").strip()
                or t["id"][:8]
            )
            branches.append({
                "session_id": t["id"],
                "file_mtime": t["recency_ms"],
                "label": label,
            })
        return {
            "current": current["id"],
            "total": len(threads),
            "branches": branches,
        }

    def resolve_current(self, encoded_path: str) -> str | None:
        threads = self._project_threads(encoded_path)
        if not threads:
            return None
        return self._resolve_project_current(encoded_path, threads)["id"]

    def switch(self, encoded_path: str, session_id: str) -> dict | None:
        """Validate that ``session_id`` can be switched to.

        Nothing is written here, and nothing is resolved: the route writes the
        pin and resolves ``current`` once this returns (docs/defects.md
        DEF-102/DEF-103), so this store's whole contribution is the checks
        below.
        """
        if not is_thread_id(session_id):
            return None
        threads = self._project_threads(encoded_path)
        if not threads:
            return None
        if not any(t["id"] == session_id for t in threads):
            return {"error": "branch_not_found"}
        return {"requested": session_id}

    # -- disposal --------------------------------------------------------

    @staticmethod
    def _dispose_thread(codex: str, thread_id: str, to_trash: bool) -> bool:
        """Archive (recoverable) or permanently delete one thread via the CLI.

        ``to_trash`` maps JupyterLab's trash semantics onto Codex's native
        lifecycle: ``codex archive`` is the recoverable analog of the desktop
        trash, ``codex delete --force`` is the permanent path.
        """
        if to_trash:
            argv = [codex, "archive", thread_id]
        else:
            argv = [codex, "delete", "--force", thread_id]
        try:
            result = subprocess.run(
                argv,
                capture_output=True,
                # Never inherit the server's stdin. `codex archive` has no
                # --force, so a prompt would read whatever the Jupyter process
                # was started with - the operator's tty under a bare launch -
                # and stall until the CLI timeout with no way to answer it.
                stdin=subprocess.DEVNULL,
                timeout=_CLI_TIMEOUT_S,
            )
        except (OSError, subprocess.TimeoutExpired) as err:
            _log.warning("codex %s %s failed to run: %s", argv[1], thread_id, err)
            return False
        if result.returncode != 0:
            # The only place codex says WHY it refused. Without this the panel
            # reports a bare failure and the server log is empty, which is where
            # an admin looks first.
            _log.warning(
                "codex %s %s exited %d: %s",
                argv[1],
                thread_id,
                result.returncode,
                (result.stderr or b"").decode("utf-8", "replace").strip(),
            )
            return False
        return True

    def _dispose(self, thread_ids: list[str], to_trash: bool) -> list[str] | None:
        """Dispose of each id via the CLI; answer the ids that went.

        None when the binary is gone. A shortfall is not a failure: whatever
        was disposed of is already gone, permanently when the trash setting is
        off - but a refused id must stay OUT of the answer, because the core
        drops the stored colour of every id it is handed and that would cost the
        surviving conversation its tint.

        Takes no Codex root: ``codex archive`` / ``codex delete`` resolve the
        Codex home themselves from the environment, so nothing here can scope
        them to another root.
        """
        codex = shutil.which(CLI_BINARY)
        if not codex:
            return None
        removed: list[str] = []
        for tid in thread_ids:
            # Last gate before argv, whatever the id's provenance.
            if not is_thread_id(tid):
                continue
            if self._dispose_thread(codex, tid, to_trash):
                removed.append(tid)
        failed = len(thread_ids) - len(removed)
        if failed:
            _log.warning(
                "codex disposed %d of %d conversation(s); %d refused",
                len(removed),
                len(thread_ids),
                failed,
            )
        return removed

    def remove(self, encoded_path: str, to_trash: bool = False) -> list[str] | None:
        """Archive (or delete) EVERY thread in a project's cwd.

        Husks included, so the row disappears completely.

        Thread by thread through the CLI, so this is the one removal that can
        come back partly refused - only the ids that actually went are
        answered, and a survivor keeps its stored colour.
        """
        threads = self._project_threads(encoded_path)
        if not threads:
            return None
        removed = self._dispose([t["id"] for t in threads], to_trash)
        return removed or None

    def delete_branches(
        self, encoded_path: str, session_ids: list, to_trash: bool = False
    ) -> list[str] | None:
        """Archive/delete selected conversations of a project.

        The current thread is never touched even when requested; an id that no
        longer exists counts as already gone and is skipped silently. EVERY id
        is validated before anything is touched.
        """
        if not isinstance(session_ids, list) or not session_ids:
            return None
        for tid in session_ids:
            if not is_thread_id(tid):
                return None
        threads = self._project_threads(encoded_path)
        if not threads:
            return None
        current = self._resolve_project_current(encoded_path, threads)
        existing = {t["id"] for t in threads}
        targets = [
            tid for tid in session_ids if tid != current["id"] and tid in existing
        ]
        return self._dispose(targets, to_trash)

    # -- launch ----------------------------------------------------------

    def launch_argv(
        self,
        cli_path: str,
        *,
        session_id: str | None = None,
        new_session_id: str | None = None,
        fork_session_id: str | None = None,
        mode: str | None = None,
        name: str | None = None,
        fork_from: str | None = None,
    ) -> list[str]:
        """The argv that opens a conversation in a terminal.

        ``codex resume <id>`` continues an existing thread; ``codex fork
        <parent>`` branches one into a new thread whose id codex mints itself,
        which is why nothing here consumes ``fork_session_id`` - the frontend's
        discovery watcher owns fork identity. A bare ``codex`` starts a fresh
        thread; ``new_session_id`` and ``name`` have no flag to carry them, and
        the descriptor says so, so neither is ever sent.
        """
        argv = [cli_path]
        if session_id and is_thread_id(session_id):
            argv += ["resume", session_id]
        elif fork_from and is_thread_id(fork_from):
            argv += ["fork", fork_from]
        if mode == BYPASS_MODE:
            argv.append(BYPASS_FLAG)
        return argv

    # -- terminal identity ----------------------------------------------

    def parse_session_id(self, cmdline: bytes) -> str | None:
        """The conversation id a codex cmdline is running, or None.

        ``codex resume <uuid>`` carries the running conversation as the first
        UUID-shaped positional after the ``resume`` subcommand - non-UUID tokens
        (flag values like ``-C <dir>``) are skipped by shape. A ``codex fork
        <uuid>`` argv names the PARENT, not the conversation the terminal ends
        up running, so fork argvs yield None. A cmdline with no resume id is a
        brand-new session (None).
        """
        args = [p.decode("utf-8", "replace") for p in cmdline.split(b"\x00") if p]
        try:
            at = args.index("resume")
        except ValueError:
            return None
        for arg in args[at + 1:]:
            if arg.startswith("-"):
                continue
            if is_thread_id(arg):
                return arg
        return None


DESCRIPTOR = ProviderDescriptor(
    id=PROVIDER_ID,
    label="Codex",
    cli_binary=CLI_BINARY,
    capabilities=Capabilities(
        # The CLI owns the fork verb AND mints the fork's id itself, so a
        # branch is a ``fork_from`` launch and the id is discovered afterwards -
        # there is no server-side fork for the branch route to serve.
        fork_strategy="native-command",
        # No colour concept anywhere in Codex - the extension's write-back store
        # is the only source of a tint.
        colour_source="none",
        launch_modes=(BYPASS_MODE,),
    ),
    legacy=LegacySource(
        plugin_id="jupyterlab_codex_extension",
        # Home-relative literal, expanded at use like every other provider's -
        # baking ``codex_home()`` in here would freeze the environment read at
        # import time.
        state_file=f"~/.codex/{LEGACY_STATE_FILENAME}",
        settings_map={
            # The retired extension borrowed Claude's wording for a flag Codex
            # spells differently; the migration maps the old key onto Codex's
            # own terminology.
            "dangerouslySkipPermissions": f"providers.{PROVIDER_ID}.{BYPASS_MODE}",
        },
    ),
)

STORE = CodexStore()
