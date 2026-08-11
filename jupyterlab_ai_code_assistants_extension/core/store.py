"""The session store contract every provider implements.

Generalised from the base extension's ``sessions.py``: the same operations -
list, branch, switch, fork, dispose, launch - with the assistant-specific path
encoding, record parsing and argv grammar pushed behind abstract methods. The
core never opens an assistant's history itself, so a bug in one provider can
never reach another's files (acc-crit "Store isolation").

Two conventions the whole contract rests on:

* ``encoded_path`` is whatever opaque token the provider uses to name a
  project inside its own store - a lossy encoding of the project path, an
  opaque workspace id from a registry, or the plain cwd. The core passes it
  back and forth verbatim and never interprets it; only the store may join it
  onto a path, and only after its own validation.
* every method is synchronous and may touch the filesystem or spawn the CLI.
  The routes run them off the IOLoop, so a slow store stalls one request, not
  the server.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# JupyterLab writes user settings as JSON with comments - the raw editor seeds
# every file with a commented copy of the schema - so a plain ``json.loads``
# fails on any settings file the user has opened once.
_LINE_COMMENT_RE = re.compile(r"^\s*//.*$", re.MULTILINE)
_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)

# Ceiling on a per-project ``git branch --show-current`` call. A sessions poll
# must never hang on a wedged repo - on timeout the row degrades to "no branch"
# rather than stalling the listing.
GIT_BRANCH_TIMEOUT_S = 2.0


def load_json(path: Path) -> Any:
    """Parse ``path`` as JSON, or None when missing/unreadable/corrupt."""
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def load_jsonc(path: Path) -> dict | None:
    """Parse a JupyterLab settings file (JSON, comments tolerated)."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, ValueError):
        return None
    stripped = _BLOCK_COMMENT_RE.sub("", _LINE_COMMENT_RE.sub("", text))
    for candidate in (text, stripped):
        try:
            data = json.loads(candidate)
        except ValueError:
            continue
        return data if isinstance(data, dict) else None
    return None


def write_json_atomic(path: Path, payload: dict) -> None:
    """Write ``payload`` to ``path`` via a tmp file and ``os.replace``.

    The fsync matters: without it a crash between write and rename can publish
    a truncated file, and ``load_json`` swallows the decode error - so every
    favourite, pin and colour would vanish silently.

    The temp name is UNIQUE per write. One shared ``<name>.tmp`` makes the
    rename atomic only against itself: two servers under one data directory -
    the default ``~/.local/share/jupyter`` - open the same inode, the loser's
    buffered write lands inside the file the winner already renamed into
    place, and its own replace then fails on a path that is gone. Measured at
    a third of writes lost with three writers, and a reader landing in that
    window reads the state as EMPTY, which silently drops every pin.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name + ".", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, indent=2))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def pid_alive(pid: int) -> bool:
    """True if PID exists.

    ``PermissionError`` from ``os.kill(pid, 0)`` means the process is alive but
    the caller cannot signal it (e.g. PID 1 on CI runners) - that's alive.
    """
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def process_comm(pid: int) -> str | None:
    """``/proc/<pid>/comm`` of a process, or None when it cannot be read."""
    if sys.platform != "linux":
        return None
    try:
        with open(f"/proc/{pid}/comm", "r") as fh:
            return fh.read().strip()
    except OSError:
        return None


def process_cmdline(pid: int) -> bytes | None:
    """The NUL-separated ``/proc/<pid>/cmdline`` of a process, or None."""
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as fh:
            return fh.read()
    except OSError:
        return None


def cmdline_args(cmdline: bytes) -> list[str]:
    """A NUL-separated ``/proc`` cmdline as its argument list."""
    return [part.decode("utf-8", "replace") for part in cmdline.split(b"\x00") if part]


def flag_value(args: list[str], flag: str) -> str | None:
    """The value of ``--flag value`` or ``--flag=value`` in an argv, or None.

    Every assistant's cmdline grammar needs the same read-back, so it lives
    here once. A following token that is itself a flag means the value is
    missing or malformed - it is never swallowed as the value.
    """
    for i, arg in enumerate(args):
        if arg == flag:
            nxt = args[i + 1] if i + 1 < len(args) else ""
            return None if nxt.startswith("-") else (nxt or None)
        if arg.startswith(flag + "="):
            return arg[len(flag) + 1:] or None
    return None


def git_branch(project_path: str) -> str | None:
    """Current git branch of a project root, or None on any failure."""
    try:
        proc = subprocess.run(
            ["git", "-C", project_path, "branch", "--show-current"],
            capture_output=True,
            timeout=GIT_BRANCH_TIMEOUT_S,
            check=False,
            text=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    branch = proc.stdout.strip()
    return branch or None


def now_iso_z() -> str:
    """Current UTC time in the ``...Z`` format the assistants stamp records with."""
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def is_safe_segment(name: Any) -> bool:
    """True when ``name`` may be joined onto a path as a single segment.

    Path-traversal gate shared by every store: no separator, no ``.``/``..``,
    no NUL, non-empty.
    """
    return (
        isinstance(name, str)
        and bool(name)
        and "/" not in name
        and "\0" not in name
        and name not in (".", "..")
    )


def dispose_path(target: Path, to_trash: bool = False) -> None:
    """Delete ``target`` (file or dir), via the desktop trash when asked.

    Honours JupyterLab's ``ContentsManager.delete_to_trash``. A failed trash
    move (no backend, unsupported filesystem, permissions) RAISES rather than
    falling through to a permanent delete: the dialog promised the user a
    recoverable outcome, and silently destroying the data instead is the one
    answer that cannot be taken back. The caller counts the item as not
    disposed of.
    """
    if to_trash:
        from send2trash import send2trash

        send2trash(str(target))
        return
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()


class SessionNotFound(Exception):
    """A launch named a conversation the store cannot open.

    Raised out of ``launch_argv``. The alternative - dropping the id and
    launching the assistant bare - starts a BRAND-NEW conversation that then
    occupies the row the user clicked, so the loss of the old one is invisible
    until they look for its history. The route turns this into the same 404
    ``session_not_found`` its pre-flight answers, which the panel already
    renders as "that conversation no longer exists".
    """


class SessionStore(ABC):
    """Per-provider access to one assistant's conversation history."""

    #: ``/proc/<pid>/comm`` of the assistant's own process. Used to find the
    #: assistant inside a terminal's process tree, so a plain shell opened in a
    #: project folder is never mistaken for a running conversation.
    comm_name: str = ""

    #: Set by the registry at registration time from the descriptor, so a store
    #: can reach its own favourites, pins and colours in the core stores.
    provider_id: str = ""

    # -- listing ---------------------------------------------------------

    @abstractmethod
    def list_sessions(self, root_dir: str | None = None) -> list[dict]:
        """One row per project, newest first.

        Each row carries at least ``project_path``, ``encoded_path``,
        ``session_id``, ``name``, ``name_source``, ``message_count``,
        ``file_mtime``, ``extra_sessions``; optionally ``git_branch``,
        ``colour``, ``remote_control``. ``colour`` is British on the wire and
        inside the store alike, and carries the conversation's OWN colour for
        an assistant that records one. ``favourite`` is added by the core, not
        by the store. ``root_dir`` is the directory Jupyter serves, for stores
        that scope their listing to it.
        """

    @abstractmethod
    def list_branches(
        self, encoded_path: str, include_extras: bool = False
    ) -> dict | None:
        """``{"current", "total", "branches": [...]}`` for one project.

        Branches are the project's other conversations, newest first, the
        current one excluded; each carries ``session_id``, ``file_mtime`` and
        ``label``. ``include_extras`` asks for the decorations only the
        user-facing fetches need (the base extension's background-agent
        markers), so a 2s fork watcher never pays for them. None on an invalid
        ``encoded_path`` or when no current conversation resolves.
        """

    @abstractmethod
    def resolve_current(self, encoded_path: str) -> str | None:
        """The project's current conversation id, or None."""

    @abstractmethod
    def switch(self, encoded_path: str, session_id: str) -> dict | None:
        """Make ``session_id`` the project's current conversation.

        Returns ``{"requested"}`` on success - the store's job is validation
        plus, where the provider has one, a recency-aligning touch. The route
        writes the pin and resolves ``current`` once this returns
        (docs/defects.md DEF-102/DEF-103). ``{"error": "branch_not_found"}``
        when it no longer exists (removed between menu display and click),
        None on invalid input.
        """

    # -- mutation --------------------------------------------------------

    @abstractmethod
    def remove(self, encoded_path: str, to_trash: bool = False) -> list[str] | None:
        """Drop a project's whole history.

        Answers the ids this call ACTUALLY disposed of, for the same reason
        ``delete_branches`` does: a store that disposes of conversations one by
        one can come back partly refused, and dropping the stored colours of
        the ids that SURVIVED costs them their tint. A store whose removal is
        one atomic directory disposal answers all its known ids on success.
        None on invalid path or failure.
        """

    @abstractmethod
    def delete_branches(
        self, encoded_path: str, session_ids: list, to_trash: bool = False
    ) -> list[str] | None:
        """Drop the named conversations, never the current one.

        Answers the ids this call ACTUALLY disposed of, not a count: the core
        drops exactly those conversations' stored colours, and a refused
        deletion whose colour was dropped anyway costs the SURVIVING
        conversation its tint. A conversation already gone was removed by
        someone else and is skipped silently, as is one that could not be
        disposed of. None on invalid input.
        """

    def fork(
        self, encoded_path: str, session_id: str, name: str | None = None
    ) -> str | None:
        """Branch ``session_id``, returning the new conversation id.

        Unsupported by default: a store that cannot fork inherits this and the
        route answers 400 ``fork_unsupported``. A
        ``native`` store mints the id the CLI will be handed at launch without
        touching disk; a ``server`` store copies the conversation on disk and
        returns the copy's id. None means "cannot fork", which the core turns
        into 400 ``fork_unsupported``.
        """
        return None

    # -- launch ----------------------------------------------------------

    @abstractmethod
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
        """The argv that opens a conversation in a terminal.

        Exactly one of the four ids applies: ``session_id`` opens an existing
        conversation, ``new_session_id`` starts a fresh one under an id the
        caller chose (so the terminal is identifiable from its argv),
        ``fork_session_id`` branches the resumed one under an id the store
        minted, and ``fork_from`` names the conversation a
        ``fork_strategy: native-command`` CLI is to branch into an id it mints
        itself inside the terminal. ``mode`` is a launch mode
        from the descriptor's ``launch_modes`` - the core has already rejected
        any the provider does not declare. ``name`` is the display name, for
        assistants that take one.

        Resolved here rather than by the caller: the panel's view of a
        conversation is only as fresh as its last poll, so a verb chosen in the
        browser can be wrong by the time the launch lands. The store re-checks
        at launch time (the base extension's resume-versus-attach decision) -
        and a re-check that cannot find the named conversation raises
        :class:`SessionNotFound` rather than launching without it.
        """

    # -- terminal identity ----------------------------------------------

    def owns_pid(self, pid: int) -> bool:
        """Whether the process at ``pid`` is THIS assistant.

        The default is a ``/proc/<pid>/comm`` match, which is exact for an
        assistant shipped as a native binary. An assistant that runs inside an
        interpreter shares its comm with every other script of that runtime, so
        it overrides this to confirm from the argv - otherwise an unrelated
        process is claimed as a running conversation, and the colour loop
        writes tab colours into that assistant's store under a cwd-guessed id.
        """
        return bool(self.comm_name) and process_comm(pid) == self.comm_name

    def parse_session_id(self, cmdline: bytes) -> str | None:
        """The conversation id a NUL-separated ``/proc`` cmdline is running.

        Pure (bytes in, no pid) so the argv grammar is unit-testable without a
        live process. The default understands nothing; a provider implements
        its own grammar, in both directions - this parse and ``launch_argv``
        must agree or terminal reuse degrades to duplicate terminals.
        """
        return None

    def session_id_for_pid(self, pid: int) -> str | None:
        """The conversation the assistant process at ``pid`` is on, or None.

        The default reads argv, which only carries an id for launches that were
        handed one. A provider whose CLI records the running conversation
        elsewhere (the base extension's ``sessions/<pid>.json``) overrides this
        so terminals the extension did not launch are identified too.
        """
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as fh:
                return self.parse_session_id(fh.read())
        except OSError:
            return None

    # -- colour ----------------------------------------------------------

    def default_colour(self, session_id: str) -> str | None:
        """The conversation's tint before any user override.

        Read from the assistant for a ``native`` colour source, derived from
        the id for a ``derived`` one, None for ``none``.

        Precedence is NOT off the ``colour_source`` flag: the extension's own
        colour store beats this value for every provider alike
        (``routes._effective_colour``), because a colour set by hand on the tab
        is a later expression of intent than whatever produced the default. The
        flag decides only what a FORK inherits - a ``native`` parent's own tint
        is left behind so the branch's own ``/color`` is not shadowed
        (``routes.BranchHandler``).
        """
        return None

    def project_session_ids(self, encoded_path: str) -> list[str]:
        """Every conversation id in a project - current one included.

        Used by the core to drop the colour entries of conversations it is
        about to delete, so no orphan keys are left behind. Derived from
        ``list_branches`` by default.
        """
        listing = self.list_branches(encoded_path)
        if not isinstance(listing, dict):
            return []
        ids = [
            b.get("session_id")
            for b in listing.get("branches") or []
            if isinstance(b, dict) and isinstance(b.get("session_id"), str)
        ]
        current = listing.get("current")
        if isinstance(current, str) and current:
            ids.append(current)
        return ids
