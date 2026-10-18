"""The store mechanics every provider shares: the per-file parse memo, the
mtime reading and the pin-or-newest rule. Provider-neutral, so they are tested
on their own."""
from __future__ import annotations

import logging
import os

import send2trash

from jupyterlab_ai_code_assistants_extension.core.state import pick_current
from jupyterlab_ai_code_assistants_extension.core.store import (
    FileMemo,
    dispose_path,
    mtime_ms,
)


def test_file_memo_reparses_only_when_the_file_moved(tmp_path):
    memo = FileMemo()
    path = tmp_path / "log"
    path.write_text("one")
    calls = []

    def parse(p, st):
        calls.append(st.st_size)
        return p.read_text()

    assert memo.get(path, parse) == "one"
    assert memo.get(path, parse) == "one"
    assert calls == [3]
    # Same size, later mtime: a rewrite in place is still seen.
    path.write_text("two")
    when = path.stat().st_mtime + 5
    os.utime(path, (when, when))
    assert memo.get(path, parse) == "two"
    assert calls == [3, 3]
    # A vanished file answers None and drops its entry, so a file recreated
    # under the same name is parsed afresh.
    path.unlink()
    assert memo.get(path, parse) is None
    path.write_text("three")
    os.utime(path, (when, when))
    assert memo.get(path, parse) == "three"


def test_file_memo_clears_wholesale_at_its_bound(tmp_path):
    memo = FileMemo(max_entries=2)
    paths = [tmp_path / name for name in "abc"]
    for p in paths:
        p.write_text(p.name)
    seen = []
    for p in paths:
        memo.get(p, lambda q, st: seen.append(q.name))
    # The third insert found the memo full and started over.
    assert len(memo._entries) == 1


def test_mtime_ms_reads_zero_for_a_missing_file(tmp_path):
    path = tmp_path / "log"
    assert mtime_ms(path) == 0
    path.write_text("x")
    os.utime(path, (1_700_000_000.25, 1_700_000_000.25))
    assert mtime_ms(path) == 1_700_000_000_250


def test_pick_current_honours_a_pin_that_resolves_and_falls_back_to_recency():
    assert pick_current(None, {}) is None
    assert pick_current(None, {"old": 1, "new": 2}) == "new"
    assert pick_current("old", {"old": 1, "new": 2}) == "old"
    # A dangling pin is ignored rather than resolved to nothing.
    assert pick_current("gone", {"other": 1, "new": 2}) == "new"


def test_dispose_path_moves_to_the_trash_when_it_accepts(tmp_path, monkeypatch):
    moved = []
    monkeypatch.setattr(send2trash, "send2trash", moved.append)
    target = tmp_path / "session.jsonl"
    target.write_text("x")

    dispose_path(target, to_trash=True)

    assert moved == [str(target)]
    # The fake move does not unlink, so a surviving file proves disposal did
    # not also take the permanent path.
    assert target.exists()


def test_dispose_path_removes_when_the_trash_refuses(tmp_path, monkeypatch, caplog):
    def refuse(_path):
        raise OSError("no trash on this filesystem")

    monkeypatch.setattr(send2trash, "send2trash", refuse)
    transcript = tmp_path / "session.jsonl"
    transcript.write_text("x")
    side_dir = tmp_path / "session"
    side_dir.mkdir()
    (side_dir / "agent.jsonl").write_text("y")

    with caplog.at_level(logging.WARNING):
        dispose_path(transcript, to_trash=True)
        dispose_path(side_dir, to_trash=True)

    assert not transcript.exists()
    assert not side_dir.exists()
    # The refusal is recorded, not silent: a permanent removal must leave a
    # trace a developer can find.
    assert "trash refused" in caplog.text


def test_dispose_path_does_not_try_the_trash_when_not_asked(tmp_path, monkeypatch):
    moved = []
    monkeypatch.setattr(send2trash, "send2trash", moved.append)
    target = tmp_path / "session.jsonl"
    target.write_text("x")

    dispose_path(target)

    assert moved == []
    assert not target.exists()
