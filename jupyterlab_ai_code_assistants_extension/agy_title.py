"""agy's terminal title command, in Claude Code's style (ACC-AGY-264-TITLE-ESCAPES).

agy 1.5.9 runs the command of the ``title`` key in its per-user
``~/.gemini/antigravity-cli/settings.json`` on every state change, with a JSON
payload on stdin, and writes the command's stdout as the terminal title
(OSC 2)::

    "title": {"type": "command",
              "command": "/opt/conda/bin/python -I -m jupyterlab_ai_code_assistants_extension.agy_title"}

Any state but ``working`` prints ``✳ <label>``. ``working`` prints
``◐ <label>`` and starts one detached loop per agy process that alternates
``◑`` and ``◐`` on ``/dev/tty`` every 960 ms, because agy reruns the command
only on events. The loop ends when a later run removes or rewrites its pid
file, or when its agy exits; the next run that is not ``working`` removes the
file and waits for the loop to go before it prints.

The label is the panel's name for the conversation
(``annotations/<id>.pbtxt``), else agy's ``conversation_title``, else
``Antigravity``. Stdlib only: this runs on every agy state change.
"""

from __future__ import annotations

import json
import os
import re
import stat
import sys
import time

IDLE_MARK = "✳"
BUSY_MARKS = ("◐", "◑")
FRAME_S = 0.96
# The loop checks its pid file this many times per frame, so a stopping run
# waits a slice, not a frame.
SLICES_PER_FRAME = 16
STOP_WAIT_S = 0.5
FALLBACK_LABEL = "Antigravity"
AGY_COMM = "agy"

# The parse of providers/antigravity.py `_annotation_title`, repeated because
# importing that module pulls jupyter_core into every agy state change.
_SESSION_ID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
_TITLE_RE = re.compile(r'\btitle\s*:\s*"((?:[^"\\\n]|\\.)*)"')
_UNESCAPES = {"n": "\n", "t": "\t", "r": "\r"}


def _annotation_title(conversation_id: object) -> str | None:
    """The ``title`` of ``annotations/<id>.pbtxt``, unescaped, or None."""
    if not isinstance(conversation_id, str) or not _SESSION_ID_RE.fullmatch(conversation_id):
        return None
    path = os.path.join(
        os.path.expanduser("~"),
        ".gemini",
        "antigravity-cli",
        "annotations",
        f"{conversation_id}.pbtxt",
    )
    try:
        with open(path, encoding="utf-8") as file:
            match = _TITLE_RE.search(file.read())
    except (OSError, ValueError):
        return None
    return match and re.sub(r"\\(.)", lambda m: _UNESCAPES.get(m[1], m[1]), match[1])


def label(conversation_id: object, conversation_title: object) -> str:
    """The annotations title, else ``conversation_title``, else ``Antigravity``.

    First line, trimmed, without the control characters that would end the
    escape sequence it is written into.
    """
    for text in (_annotation_title(conversation_id), conversation_title):
        if isinstance(text, str):
            line = "".join(c for c in text.strip().split("\n", 1)[0] if c.isprintable()).strip()
            if line:
                return line
    return FALLBACK_LABEL


def _proc_stat(pid: int) -> tuple[str, list[str]] | None:
    """``(comm, [state, ppid, ...])`` of a process, or None once it is gone."""
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8", errors="replace") as file:
            text = file.read()
    except OSError:
        return None
    comm, _, rest = text[text.find("(") + 1 :].rpartition(")")
    return comm, rest.split()


def _alive(pid: int) -> bool:
    """Whether a process runs; a zombie has already exited."""
    found = _proc_stat(pid)
    return found is not None and found[1][0] not in "ZX"


def _agy_pid() -> int | None:
    """The nearest ancestor process whose command is agy, else None."""
    pid = os.getppid()
    while pid > 1:
        found = _proc_stat(pid)
        if found is None:
            return None
        if found[0] == AGY_COMM:
            return pid
        pid = int(found[1][1])
    return None


def _run_dir() -> str | None:
    """``$XDG_RUNTIME_DIR``, else ``/tmp/agy-title-<uid>`` with mode 0700."""
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime:
        return runtime
    path = f"/tmp/agy-title-{os.getuid()}"
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    except OSError:
        return None
    try:
        info = os.lstat(path)
    except OSError:
        return None
    # A symlink, or a directory another user made first in the shared /tmp,
    # is not used.
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        return None
    return path


def _read_pid_file(path: str) -> tuple[int, str] | None:
    """``(loop pid, agy's conversation title)`` from a pid file, or None."""
    try:
        with open(path, encoding="utf-8") as file:
            pid, _, title = file.read().partition("\n")
        return int(pid), title
    except (OSError, ValueError):
        return None


def _write_pid_file(path: str, pid: int, title: object) -> None:
    """Replace the pid file at once, so the loop never reads half of it. A
    failed write leaves no file, which a loop reads as its end."""
    temporary = f"{path}.{os.getpid()}.tmp"
    try:
        with open(temporary, "w", encoding="utf-8") as file:
            file.write(f"{pid}\n{title if isinstance(title, str) else ''}")
        os.replace(temporary, path)
    except OSError:
        pass


def _animate(tty: int, pid_file: str, agy_pid: int, conversation_id: object) -> None:
    """Alternate the busy marks on ``tty`` while this loop owns ``pid_file``
    and agy runs; remove the file on the way out when it is still this
    loop's."""
    me = os.getpid()
    frame = 0
    try:
        while True:
            for _ in range(SLICES_PER_FRAME):
                time.sleep(FRAME_S / SLICES_PER_FRAME)
                owner = _read_pid_file(pid_file)
                if owner is None or owner[0] != me or not _alive(agy_pid):
                    return
            frame += 1
            mark = BUSY_MARKS[frame % 2]
            os.write(tty, f"\x1b]2;{mark} {label(conversation_id, owner[1])}\x07".encode())
    except OSError:
        return
    finally:
        owner = _read_pid_file(pid_file)
        if owner is not None and owner[0] == me:
            try:
                os.remove(pid_file)
            except OSError:
                pass


def _start_loop(pid_file: str, agy_pid: int, conversation_id: object, title: object) -> None:
    """Fork the busy loop, fully detached from agy's pipe and session."""
    try:
        # Opened before setsid, which leaves the child without a controlling
        # terminal to open.
        tty = os.open("/dev/tty", os.O_WRONLY | os.O_NOCTTY)
    except OSError:
        return
    if os.fork():
        os.close(tty)
        return
    try:
        os.setsid()
        # Written before agy sees this command end, so agy's next run finds it.
        _write_pid_file(pid_file, os.getpid(), title)
        # agy reads this command's stdout until every copy of it is closed.
        null = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(null, fd)
        _animate(tty, pid_file, agy_pid, conversation_id)
    finally:
        os._exit(0)


def _stop_loop(pid_file: str) -> None:
    """Remove the pid file, which ends the loop, and wait a bounded time for
    the loop to go, so its last frame cannot land after this run's title."""
    owner = _read_pid_file(pid_file)
    if owner is None:
        return
    try:
        os.remove(pid_file)
    except OSError:
        pass
    deadline = time.monotonic() + STOP_WAIT_S
    while _alive(owner[0]) and time.monotonic() < deadline:
        time.sleep(FRAME_S / SLICES_PER_FRAME / 4)


def main() -> None:
    """Read agy's payload on stdin and print the title for its state."""
    try:
        payload = json.load(sys.stdin)
        state = payload.get("agent_state")
        conversation_id = payload.get("conversation_id")
        title = payload.get("conversation_title")
    except (ValueError, AttributeError):
        sys.stdout.write(FALLBACK_LABEL)
        return
    agy_pid = _agy_pid()
    run_dir = _run_dir() if agy_pid else None
    pid_file = os.path.join(run_dir, f"agy-title.{agy_pid}.pid") if run_dir else None
    if state == "working":
        owner = _read_pid_file(pid_file) if pid_file else None
        if owner is not None and _alive(owner[0]):
            # The running loop takes agy's newest title from here.
            _write_pid_file(pid_file, owner[0], title)
        elif pid_file:
            _start_loop(pid_file, agy_pid, conversation_id, title)
        mark = BUSY_MARKS[0]
    else:
        if pid_file:
            _stop_loop(pid_file)
        mark = IDLE_MARK
    sys.stdout.write(f"{mark} {label(conversation_id, title)}")


if __name__ == "__main__":
    main()
