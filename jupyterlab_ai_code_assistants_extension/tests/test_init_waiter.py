"""The terminal-init waiter, driven against a real pty.

``_INIT_WAITER`` is a bash one-liner whose whole job is that the assistant
starts in a window a person can read. Nothing but a real pty can answer whether
it does: the grammar is testable by eye and was wrong anyway - both timeout
paths exec'd at 1x1 (DEF-47). The pty is spawned exactly as
``LaunchHandler`` spawns it - terminado's ``PtyWithClients`` calls
``PtyProcessUnicode.spawn(argv, cwd=...)``, which sizes the pty 24x80 - and the
argv it wraps reports the size the assistant would have been handed.

Both waiting cases run concurrently, because each one costs the waiter's full
5 s timeout.
"""
from __future__ import annotations

import re
import threading
import time

import pytest

from jupyterlab_ai_code_assistants_extension.core.routes import _wrap_with_init


ptyprocess = pytest.importorskip("ptyprocess")

# What the exec'd assistant sees as its window, printed on the pty.
PROBE = ["/bin/sh", "-c", "stty size"]
SIZE_RE = re.compile(r"(\d+)\s+(\d+)")
# A browser attach, in rows and columns. Deliberately unlike the 24x80 the pty
# is born with, so a restore of the baseline is told apart from a restore of
# the default.
CLIENT_ROWS, CLIENT_COLS = 30, 120


def _size_at_exec(client_size: tuple[int, int] | None) -> str:
    """Spawn the waiter and answer the pty size the exec'd argv saw.

    ``client_size`` is applied IMMEDIATELY - before the child has run its own
    ``stty rows 1 cols 1`` - which is the interleaving that leaves a real
    attached client stuck at the timeout: nothing changes the size after the
    marking, so the poll never breaks. None is the no-client-ever case.
    """
    proc = ptyprocess.PtyProcessUnicode.spawn(_wrap_with_init(PROBE), cwd="/tmp")
    out: list[str] = []

    def drain() -> None:
        while True:
            try:
                out.append(proc.read(1024))
            except EOFError:
                return

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    if client_size is not None:
        proc.setwinsize(*client_size)
    reader.join(timeout=60)
    # ``clear`` precedes the exec, so the last two numbers on the pty are the
    # probe's own answer rather than anything the escape sequences carry.
    found = SIZE_RE.findall("".join(out).replace("\x1b", " "))
    assert found, f"probe printed no size: {''.join(out)!r}"
    return "x".join(found[-1])


def test_init_waiter_never_execs_into_a_one_by_one_window():
    """Both timeout paths hand the assistant a usable window (DEF-47).

    With no client the pty's own 24x80 baseline comes back; with a client whose
    resize landed before the marking, that client's real size does - which is
    why the two are asserted apart rather than as "not 1x1".
    """
    sizes: dict[str, str] = {}

    def measure(name: str, client_size: tuple[int, int] | None) -> None:
        sizes[name] = _size_at_exec(client_size)

    threads = [
        threading.Thread(target=measure, args=("no_client", None)),
        threading.Thread(
            target=measure, args=("early_client", (CLIENT_ROWS, CLIENT_COLS))
        ),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert sizes["no_client"] == "24x80"
    assert sizes["early_client"] == f"{CLIENT_ROWS}x{CLIENT_COLS}"


def test_init_waiter_still_waits_for_a_client():
    """The waiting itself is intact: a resize during the poll wins the window.

    The guard above would pass just as well against a waiter that stopped
    marking and polling altogether, which is the regression this one blocks.
    """
    proc = ptyprocess.PtyProcessUnicode.spawn(_wrap_with_init(PROBE), cwd="/tmp")
    out: list[str] = []
    marked = threading.Event()

    def drain() -> None:
        while True:
            try:
                out.append(proc.read(1024))
            except EOFError:
                return

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    # Wait for the child's own marking to land, so the resize is unambiguously
    # the thing that ends the poll. Bounded: a waiter that stopped marking
    # would otherwise spin here rather than fail.
    deadline = time.monotonic() + 10
    while not marked.is_set() and time.monotonic() < deadline:
        if proc.getwinsize() == (1, 1):
            marked.set()
        else:
            time.sleep(0.01)
    assert marked.is_set(), "the waiter never marked its pty"
    proc.setwinsize(CLIENT_ROWS, CLIENT_COLS)
    reader.join(timeout=60)
    found = SIZE_RE.findall("".join(out).replace("\x1b", " "))
    assert found, f"probe printed no size: {''.join(out)!r}"
    assert "x".join(found[-1]) == f"{CLIENT_ROWS}x{CLIENT_COLS}"
