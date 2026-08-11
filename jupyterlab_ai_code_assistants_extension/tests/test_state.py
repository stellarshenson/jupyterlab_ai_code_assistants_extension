"""A pin write that fails leaves its reason in the server log.

The swallow is intended - a pin is written after an irreversible action, so a
failure must fall back to recency rather than fail the fork or the terminal.
What must not be swallowed with it is the errno: the user sees a switch that
appears to have worked, and the log is the only place that says it did not.
"""
from __future__ import annotations

from jupyterlab_ai_code_assistants_extension.core import state

from .conftest import CLAUDE_ENCODED


SESSION_ID = "11111111-2222-3333-4444-555555555555"


def _refuse_writes(monkeypatch):
    monkeypatch.setattr(
        state,
        "write_json_atomic",
        lambda *a, **kw: (_ for _ in ()).throw(OSError("no space")),
    )


def test_a_refused_pin_write_says_so_in_the_server_log(monkeypatch, caplog):
    _refuse_writes(monkeypatch)
    with caplog.at_level("WARNING", logger=state.__name__):
        state.write_pin("claude", CLAUDE_ENCODED, SESSION_ID)
    assert "no space" in caplog.text
    # The provider and the file, so a log line identifies which state failed.
    assert "claude" in caplog.text
    assert state.read_pin("claude", CLAUDE_ENCODED) is None


def test_a_refused_pin_clear_says_so_in_the_server_log(monkeypatch, caplog):
    state.write_pin("claude", CLAUDE_ENCODED, SESSION_ID)
    _refuse_writes(monkeypatch)
    with caplog.at_level("WARNING", logger=state.__name__):
        state.clear_pin("claude", CLAUDE_ENCODED)
    assert "no space" in caplog.text
    assert "claude" in caplog.text
