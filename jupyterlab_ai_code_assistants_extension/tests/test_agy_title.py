"""agy's terminal title command (ACC-AGY-264-TITLE-ESCAPES).

The command runs as agy runs it: a fresh interpreter, the JSON payload on
stdin, stdout read to its end. The busy loop is driven by a fake agy - a
script named ``agy``, so its process name is agy's - that runs the command
through ``sh -c`` and has a pty as its controlling terminal, whose other end
the tests read. ``HOME`` is the scratch home of ``conftest.py`` and
``XDG_RUNTIME_DIR`` a temporary folder, so neither the real agy store nor the
real run folder is touched.
"""

import fcntl
import json
import os
import pty
import re
import select
import shlex
import signal
import subprocess
import sys
import termios
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
MODULE = "jupyterlab_ai_code_assistants_extension.agy_title"
COMMAND = f"{shlex.quote(sys.executable)} -m {MODULE}"
SESSION = "1fd21ea8-0000-4000-8000-000000000001"
FRAME_S = 0.96
OSC_2 = re.compile(rb"\x1b\]2;([^\x07]*)\x07")
FAKE_AGY = """#!{python}
# Fake agy: runs the title command (argv[2]) as agy 1.5.9 does, once per
# payload line on stdin, and appends its stdout, one line per run, to argv[1].
import subprocess, sys
for line in iter(sys.stdin.buffer.readline, b""):
    out = subprocess.run(
        ["sh", "-c", sys.argv[2]], input=line, capture_output=True, timeout=10
    ).stdout
    with open(sys.argv[1], "ab") as titles:
        titles.write(out + b"\\n")
"""


def _payload(state, title="T", conversation_id=SESSION):
    return json.dumps(
        {"agent_state": state, "conversation_id": conversation_id, "conversation_title": title}
    )


def _title(payload):
    """One run outside any agy; no loop can start."""
    result = subprocess.run(
        [sys.executable, "-m", MODULE],
        input=payload,
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": str(REPO)},
        timeout=10,
    )
    return result.returncode, result.stdout


def _alive(pid):
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rpartition(")")[2].split()[0]
    except OSError:
        return False
    return state not in "ZX"


def _wait_until(condition, seconds=3.0):
    deadline = time.monotonic() + seconds
    while not condition() and time.monotonic() < deadline:
        time.sleep(0.02)
    return condition()


class FakeAgy:
    """A process named agy on a pty, running the title command per payload."""

    def __init__(self, tmp_path):
        self.titles = tmp_path / "titles"
        self.titles.touch()
        script = tmp_path / "bin" / "agy"
        script.parent.mkdir()
        script.write_text(FAKE_AGY.format(python=sys.executable))
        script.chmod(0o755)
        self.master, slave = pty.openpty()
        self.process = subprocess.Popen(
            [str(script), str(self.titles), COMMAND],
            stdin=subprocess.PIPE,
            stdout=slave,
            stderr=slave,
            cwd=tmp_path,
            start_new_session=True,
            preexec_fn=lambda: fcntl.ioctl(1, termios.TIOCSCTTY, 0),
        )
        os.close(slave)
        self.pid_file = tmp_path / "run" / f"agy-title.{self.process.pid}.pid"

    def run(self, state, title="T"):
        """agy's next run of the title command; its stdout."""
        done = len(self.titles.read_bytes().splitlines())
        self.process.stdin.write(_payload(state, title).encode() + b"\n")
        self.process.stdin.flush()
        assert _wait_until(lambda: len(self.titles.read_bytes().splitlines()) > done, 10)
        return self.titles.read_text(encoding="utf-8").splitlines()[-1]

    def loop_pid(self):
        try:
            return int(self.pid_file.read_text().partition("\n")[0])
        except (OSError, ValueError):
            return None

    def frames(self, seconds):
        """``(seconds since the call, title)`` of each OSC 2 the tty shows."""
        start = time.monotonic()
        found, buffer = [], b""
        while (left := start + seconds - time.monotonic()) > 0:
            if select.select([self.master], [], [], left)[0]:
                buffer += os.read(self.master, 4096)
                for match in OSC_2.finditer(buffer):
                    found.append((time.monotonic() - start, match[1].decode()))
                buffer = OSC_2.sub(b"", buffer)
        return found

    def exit(self):
        self.process.stdin.close()
        self.process.wait(timeout=10)


@pytest.fixture
def agy(tmp_path, monkeypatch):
    run = tmp_path / "run"
    run.mkdir(mode=0o700)
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(run))
    monkeypatch.setenv("PYTHONPATH", str(REPO))
    fake = FakeAgy(tmp_path)
    yield fake
    loop = fake.loop_pid()
    if fake.process.poll() is None:
        fake.exit()
    if loop and _alive(loop):
        os.kill(loop, signal.SIGKILL)
    os.close(fake.master)


def test_acc_agy_264_idle_prints_the_idle_mark_and_the_title():
    assert _title(_payload("idle")) == (0, "✳ T")


def test_acc_agy_264_working_prints_the_first_busy_mark_and_the_title():
    assert _title(_payload("working")) == (0, "◐ T")


def test_acc_agy_264_authenticating_prints_the_idle_mark_and_the_fallback_label():
    assert _title(_payload("authenticating", title=None)) == (0, "✳ Antigravity")


@pytest.mark.parametrize("payload", ["not json", "[1]"])
def test_acc_agy_264_a_malformed_payload_prints_antigravity_and_exits_0(payload):
    assert _title(payload) == (0, "Antigravity")


def test_acc_agy_264_the_annotations_title_beats_agy_conversation_title():
    annotations = Path.home() / ".gemini" / "antigravity-cli" / "annotations"
    annotations.mkdir(parents=True)
    (annotations / f"{SESSION}.pbtxt").write_text('title:"Panel \\"name\\""', encoding="utf-8")

    assert _title(_payload("idle")) == (0, '✳ Panel "name"')


def test_acc_agy_264_working_starts_one_loop_per_agy(agy):
    assert agy.run("working") == "◐ T"
    first = agy.loop_pid()
    assert first and _alive(first)

    assert agy.run("working") == "◐ T"

    assert agy.loop_pid() == first


def test_acc_agy_264_the_loop_alternates_the_half_circles_every_960_ms(agy):
    agy.run("working")

    frames = agy.frames(2.6 * FRAME_S)

    assert [title for _, title in frames[:2]] == ["◑ T", "◐ T"]
    assert 0.75 * FRAME_S < frames[1][0] - frames[0][0] < 1.5 * FRAME_S


def test_acc_agy_264_idle_stops_the_loop_before_it_prints(agy):
    agy.run("working")
    loop = agy.loop_pid()
    assert agy.frames(1.5 * FRAME_S)

    assert agy.run("idle") == "✳ T"

    assert not _alive(loop)
    assert not agy.pid_file.exists()
    assert agy.frames(1.5 * FRAME_S) == []


def test_acc_agy_264_the_loop_ends_when_its_agy_exits(agy):
    agy.run("working")
    loop = agy.loop_pid()
    assert loop and _alive(loop)

    agy.exit()

    assert _wait_until(lambda: not _alive(loop), 2 * FRAME_S)
    assert not agy.pid_file.exists()
