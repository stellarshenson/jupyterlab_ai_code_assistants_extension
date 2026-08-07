"""Fixtures shared by the server-side suite.

Two invariants hold for every test in this package:

* no test reads or writes a real assistant store - each one gets a scratch
  tree, pointed at through the same environment overrides the UI suite uses
  (``CLAUDE_CONFIG_DIR``, ``CODEX_HOME``, ``KIMI_CODE_HOME``, and ``HOME`` for
  Gemini, which resolves its root from the home directory like the CLI does)
* no test spawns an assistant CLI - the one listing path that would
  (``claude agents --json``, on every sessions poll) is stubbed out, so a
  wedged or absent binary cannot slow or fail the suite
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path

import pytest

from jupyterlab_ai_code_assistants_extension.core import registry, state
from jupyterlab_ai_code_assistants_extension.providers import (
    claude as claude_provider,
)


# A project the fixtures pretend the user works in. It never has to exist on
# disk: every store keys a project by its own recorded string, and keeping the
# path synthetic is what stops a fixture from depending on where pytest ran.
PROJECT_PATH = "/home/lab/projects/demo"
# Claude's own encoding of it - "/", "_" and "." all become "-".
CLAUDE_ENCODED = "-home-lab-projects-demo"


@pytest.fixture(autouse=True)
def scratch_stores(tmp_path, monkeypatch):
    """Point every store and the extension's own state at a scratch tree."""
    scratch = tmp_path / "scratch"
    home = scratch / "home"
    home.mkdir(parents=True, exist_ok=True)
    # Gemini resolves its root from the home directory, exactly as its CLI
    # does, and the retired extensions' sidecars are home-relative paths - so
    # the home a test sees has to be scratch too.
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv(state.STATE_DIR_ENV, str(scratch / "state"))
    monkeypatch.setenv(claude_provider.CONFIG_DIR_ENV, str(scratch / "claude"))
    monkeypatch.setenv("CODEX_HOME", str(scratch / "codex"))
    monkeypatch.setenv("KIMI_CODE_HOME", str(scratch / "kimi"))
    # The background-agent roster is the only listing path that shells out.
    monkeypatch.setattr(claude_provider, "bg_agents", lambda binary=None: {})
    monkeypatch.setattr(claude_provider, "_bg_agents_refresh", lambda binary=None: {})
    monkeypatch.setattr(claude_provider, "bg_agents_cached", lambda: {})
    yield scratch


@pytest.fixture(autouse=True)
def fresh_registry():
    """Drop the discovery cache around every test.

    The registry memoises discovery per process, and the registry tests swap
    the providers package underneath it - without this the swap would leak into
    whatever ran next.
    """
    registry.reload()
    yield
    registry.reload()


# ------------------------------------------------------------ store fixtures


def write_claude_tree(root: Path, sessions: list[dict]) -> Path:
    """A ``~/.claude``-shaped tree: one project dir of ``<id>.jsonl`` transcripts.

    Each entry is ``{"id", "cwd", "title"?, "colour"?, "turns"?}``; the records
    written are the three the store's tail scan looks for.
    """
    project_dir = root / claude_provider.PROJECTS_DIRNAME / CLAUDE_ENCODED
    project_dir.mkdir(parents=True, exist_ok=True)
    for entry in sessions:
        lines = [{"type": "user", "cwd": entry.get("cwd", PROJECT_PATH)}]
        for _ in range(entry.get("turns", 0)):
            lines.append({"type": "assistant", "cwd": entry.get("cwd", PROJECT_PATH)})
        if entry.get("title"):
            lines.append({"type": "custom-title", "customTitle": entry["title"]})
        if entry.get("colour"):
            lines.append({"type": "agent-color", "agentColor": entry["colour"]})
        path = project_dir / f"{entry['id']}.jsonl"
        path.write_text(
            "\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf-8"
        )
    return project_dir


def write_codex_db(root: Path, threads: list[dict]) -> Path:
    """A ``~/.codex``-shaped tree with the newest-generation thread index."""
    root.mkdir(parents=True, exist_ok=True)
    db_path = root / "state_5.sqlite"
    conn = sqlite3.connect(db_path)
    conn.execute(
        "CREATE TABLE threads (id TEXT, cwd TEXT, name TEXT, preview TEXT, "
        "first_user_message TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, "
        "recency_at_ms INTEGER, git_branch TEXT, model TEXT, tokens_used INTEGER, "
        "source TEXT, archived INTEGER, has_user_event INTEGER)"
    )
    for thread in threads:
        conn.execute(
            "INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                thread["id"],
                thread.get("cwd", PROJECT_PATH),
                thread.get("name"),
                thread.get("preview", ""),
                thread.get("first_user_message", ""),
                thread.get("created_ms", 1000),
                thread.get("updated_ms", 2000),
                thread.get("recency_ms", 2000),
                thread.get("git_branch"),
                thread.get("model"),
                thread.get("tokens_used", 0),
                thread.get("source"),
                int(thread.get("archived", False)),
                int(thread.get("has_user_event", True)),
            ),
        )
    conn.commit()
    conn.close()
    return db_path


def write_kimi_tree(root: Path, wd_id: str, sessions: list[dict]) -> Path:
    """A ``~/.kimi-code``-shaped tree: workspace registry plus session dirs."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "workspaces.json").write_text(
        json.dumps(
            {
                "workspaces": {wd_id: {"root": PROJECT_PATH}},
                "deleted_workspace_ids": ["wd-deleted"],
            }
        ),
        encoding="utf-8",
    )
    wd_dir = root / "sessions" / wd_id
    wd_dir.mkdir(parents=True, exist_ok=True)
    index_lines = []
    for entry in sessions:
        session_dir = wd_dir / entry["id"]
        (session_dir / "agents" / "main").mkdir(parents=True, exist_ok=True)
        (session_dir / "state.json").write_text(
            json.dumps(
                {
                    "title": entry.get("title", ""),
                    "isCustomTitle": entry.get("custom_title", False),
                    "createdAt": entry.get("created", "2026-08-01T10:00:00.000Z"),
                    "updatedAt": entry.get("updated", "2026-08-01T10:00:00.000Z"),
                    "workDir": PROJECT_PATH,
                }
            ),
            encoding="utf-8",
        )
        wire = session_dir / "agents" / "main" / "wire.jsonl"
        wire.write_text(
            "".join(
                '{"type":"context.append_message","i":%d}\n' % i
                for i in range(entry.get("messages", 0))
            ),
            encoding="utf-8",
        )
        index_lines.append(
            json.dumps(
                {
                    "sessionId": entry["id"],
                    "sessionDir": str(session_dir),
                    "workDir": PROJECT_PATH,
                }
            )
        )
    (root / "session_index.jsonl").write_text(
        "\n".join(index_lines) + "\n" if index_lines else "", encoding="utf-8"
    )
    return wd_dir


def write_gemini_tree(root: Path, short_id: str, chats: list[dict]) -> Path:
    """A ``~/.gemini``-shaped tree: project registry plus one chat file each."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "projects.json").write_text(
        json.dumps({"projects": {PROJECT_PATH: short_id}}), encoding="utf-8"
    )
    project_dir = root / "tmp" / short_id
    chats_dir = project_dir / "chats"
    chats_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / ".project_root").write_text(PROJECT_PATH, encoding="utf-8")
    for entry in chats:
        meta = {
            "sessionId": entry["id"],
            "startTime": "2026-08-01T10:00:00.000Z",
            "lastUpdated": "2026-08-01T11:00:00.000Z",
            "summary": entry.get("summary"),
        }
        if entry.get("kind"):
            meta["kind"] = entry["kind"]
        # Compact, exactly as the CLI's own ``JSON.stringify`` writes it - the
        # store recognises message records by substring, so the separators are
        # part of the fixture's fidelity.
        lines = [json.dumps(meta, separators=(",", ":"))]
        for i in range(entry.get("messages", 0)):
            role = "user" if i % 2 == 0 else "gemini"
            lines.append(
                json.dumps(
                    {"type": role, "content": f"turn {i}"}, separators=(",", ":")
                )
            )
        name = f"session-2026-08-01T10-00-{entry['id'][:8]}.jsonl"
        (chats_dir / name).write_text("\n".join(lines) + "\n", encoding="utf-8")
    return chats_dir


def new_uuid() -> str:
    return str(uuid.uuid4())
