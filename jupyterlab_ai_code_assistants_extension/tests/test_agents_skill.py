"""The agent skill ships in the wheel unchanged and its copy tool works."""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SKILL_NAME = "jupyterlab-ai-code-assistants-extension"
SKILL_DIR = REPO / ".agents" / "skills" / SKILL_NAME
INSTALLED_DIR = (
    Path(sys.prefix) / "share" / "jupyter" / "agents" / "skills" / SKILL_NAME
)
SCRIPT = SKILL_DIR / "scripts" / "copy-session.py"
FILES = (
    "SKILL.md",
    "references/session-operations.md",
    "references/provider-launchers.md",
    "references/claude-operations.md",
    "references/cross-assistant-sessions.md",
    "scripts/copy-session.py",
)
FIXED_ID = "11111111-1111-4111-8111-111111111111"
OTHER_ID = "22222222-2222-4222-8222-222222222222"


def run_copy(*args: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *(str(arg) for arg in args)],
        capture_output=True,
        text=True,
    )


def test_the_skill_exists_with_its_frontmatter():
    text = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
    assert text.startswith("---\n")
    frontmatter, body = text[4:].split("\n---\n", 1)
    assert f"name: {SKILL_NAME}" in frontmatter
    assert "description:" in frontmatter
    assert body.strip()
    assert (SKILL_DIR / "references" / "session-operations.md").is_file()
    assert (SKILL_DIR / "references" / "provider-launchers.md").is_file()
    assert (SKILL_DIR / "references" / "claude-operations.md").is_file()
    assert (SKILL_DIR / "references" / "cross-assistant-sessions.md").is_file()


def test_every_reference_named_in_the_skill_exists():
    text = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
    named = set(re.findall(r"references/[A-Za-z0-9._-]+\.md", text))
    assert named
    for relative in sorted(named):
        assert (SKILL_DIR / relative).is_file(), relative


def test_the_installed_skill_matches_the_repository_copy():
    for relative in FILES:
        assert (INSTALLED_DIR / relative).read_text(encoding="utf-8") == (
            SKILL_DIR / relative
        ).read_text(encoding="utf-8")


def test_copy_session_rewrites_every_id_and_pins(tmp_path):
    source = tmp_path / "old.jsonl"
    source.write_text(
        '{"sessionId": "old", "session_id": "old", "type": "user"}\n{"type": "meta"}\n',
        encoding="utf-8",
    )
    target = tmp_path / "target"
    target.mkdir()

    result = run_copy(source, target)
    assert result.returncode == 0, result.stderr
    new_id = result.stdout.strip()
    records = [
        json.loads(line)
        for line in (target / f"{new_id}.jsonl")
        .read_text(encoding="utf-8")
        .splitlines()
    ]
    assert records[0]["sessionId"] == new_id
    assert records[0]["session_id"] == new_id
    assert "sessionId" not in records[1]
    assert (target / ".pinned-session").read_text(encoding="utf-8") == new_id


def test_copy_session_rewrites_side_files_and_nested_ids(tmp_path):
    source = tmp_path / "old.jsonl"
    source.write_text(
        '{"sessionId": "old", "worktreeSession": {"sessionId": "old"}, '
        '"type": "user"}\n',
        encoding="utf-8",
    )
    side = tmp_path / "old"
    (side / "subagents").mkdir(parents=True)
    (side / "subagents" / "agent-a.jsonl").write_text(
        '{"sessionId": "old", "type": "agent"}\n', encoding="utf-8"
    )
    (side / "custom-title.json").write_text(
        '{"customTitle": "kept"}\n', encoding="utf-8"
    )
    target = tmp_path / "target"
    target.mkdir()

    result = run_copy(source, target, "--new-id", FIXED_ID, "--with-side-files")
    assert result.returncode == 0, result.stderr

    main = json.loads(
        (target / f"{FIXED_ID}.jsonl").read_text(encoding="utf-8").splitlines()[0]
    )
    assert main["sessionId"] == FIXED_ID
    assert main["worktreeSession"]["sessionId"] == FIXED_ID
    agent = json.loads(
        (target / FIXED_ID / "subagents" / "agent-a.jsonl")
        .read_text(encoding="utf-8")
        .splitlines()[0]
    )
    assert agent["sessionId"] == FIXED_ID
    assert (target / FIXED_ID / "custom-title.json").is_file()


def test_copy_session_leaves_nothing_on_a_malformed_source(tmp_path):
    source = tmp_path / "old.jsonl"
    source.write_text('{"sessionId": "old"}\n{not json\n', encoding="utf-8")
    target = tmp_path / "target"
    target.mkdir()

    result = run_copy(source, target, "--new-id", FIXED_ID)
    assert result.returncode != 0
    assert not (target / f"{FIXED_ID}.jsonl").exists()
    assert not (target / ".pinned-session").exists()


def test_copy_session_refuses_an_existing_side_directory(tmp_path):
    source = tmp_path / "old.jsonl"
    source.write_text('{"sessionId": "old"}\n', encoding="utf-8")
    target = tmp_path / "target"
    (target / OTHER_ID).mkdir(parents=True)

    result = run_copy(
        source, target, "--new-id", OTHER_ID, "--with-side-files"
    )
    assert result.returncode != 0
    assert not (target / f"{OTHER_ID}.jsonl").exists()
