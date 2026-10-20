#!/usr/bin/env python3
"""Copy a Claude Code conversation into another project under a fresh session id.

The copy is independent. Every ``sessionId`` and ``session_id`` in the main transcript and in the
copied side directory (subagent transcripts, ``custom-title.json``, workflows,
tool results) is rewritten to the new id, and the id is written to ``.pinned-session``.

Pass the encoded project directory under ``~/.claude/projects``. The dash
encoding is lossy; find the directory by its transcripts' ``cwd`` field or take
an existing directory rather than re-deriving the name.

``claude -c`` does not read ``.pinned-session``. Resume the copy with
``claude --resume <new-id>``.

Examples:
  copy-session.py ~/.claude/projects/-home-user-a/<id>.jsonl \\
      ~/.claude/projects/-home-user-b
  copy-session.py <src.jsonl> <target-dir> --with-side-files
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import uuid
from pathlib import Path


def rewrite_ids(value: object, new_id: str) -> object:
    """Replace every ``sessionId`` or ``session_id`` key at any depth with ``new_id``."""
    if isinstance(value, dict):
        return {
            key: new_id if key in ("sessionId", "session_id") else rewrite_ids(item, new_id)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [rewrite_ids(item, new_id) for item in value]
    return value


def read_jsonl(path: Path) -> list[object]:
    """Parse every record first, so a bad line writes nothing."""
    records: list[object] = []
    with path.open(encoding="utf-8") as reader:
        for number, line in enumerate(reader, 1):
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as err:
                raise SystemExit(f"error: {path}:{number}: {err.msg}") from None
    return records


def write_jsonl(path: Path, records: list[object]) -> None:
    with path.open("w", encoding="utf-8") as writer:
        for record in records:
            writer.write(json.dumps(record, separators=(",", ":")) + "\n")


def rewrite_side_files(root: Path, new_id: str) -> None:
    """Rewrite every JSON record under a copied side directory."""
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix not in (".json", ".jsonl"):
            continue
        try:
            if path.suffix == ".json":
                document = json.loads(path.read_text(encoding="utf-8"))
                path.write_text(
                    json.dumps(rewrite_ids(document, new_id), separators=(",", ":"))
                    + "\n",
                    encoding="utf-8",
                )
            else:
                write_jsonl(
                    path, [rewrite_ids(record, new_id) for record in read_jsonl(path)]
                )
        except (json.JSONDecodeError, UnicodeDecodeError):
            print(f"warning: left {path} unchanged; not JSON", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Copy a Claude Code conversation under a fresh session id.",
        epilog=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("source", type=Path, help="transcript .jsonl to copy")
    parser.add_argument(
        "target_dir",
        type=Path,
        help="encoded project directory under ~/.claude/projects",
    )
    parser.add_argument(
        "--new-id", default=None, help="session id to use (default: a fresh UUID)"
    )
    parser.add_argument(
        "--with-side-files",
        action="store_true",
        help="copy and rewrite the <old-id>/ directory (subagents, custom title, workflows, tool results)",
    )
    parser.add_argument(
        "--no-pin", action="store_true", help="do not write .pinned-session"
    )
    args = parser.parse_args()

    source = args.source.expanduser()
    target_dir = args.target_dir.expanduser()
    if not source.is_file():
        print(f"error: {source} is not a file", file=sys.stderr)
        return 1
    if not target_dir.is_dir():
        print(
            f"error: {target_dir} is not a directory; pass the encoded project directory",
            file=sys.stderr,
        )
        return 1

    new_id = args.new_id or str(uuid.uuid4())
    destination = target_dir / f"{new_id}.jsonl"
    side_source = source.parent / source.stem
    side_destination = target_dir / new_id
    if destination.exists():
        print(f"error: {destination} already exists", file=sys.stderr)
        return 1
    if args.with_side_files and side_destination.exists():
        print(f"error: {side_destination} already exists", file=sys.stderr)
        return 1

    records = [rewrite_ids(record, new_id) for record in read_jsonl(source)]
    temporary = target_dir / f".{new_id}.jsonl.tmp"
    try:
        if args.with_side_files and side_source.is_dir():
            shutil.copytree(side_source, side_destination)
            rewrite_side_files(side_destination, new_id)
        write_jsonl(temporary, records)
        os.replace(temporary, destination)
        if not args.no_pin:
            (target_dir / ".pinned-session").write_text(new_id, encoding="utf-8")
    except (Exception, SystemExit, KeyboardInterrupt) as err:
        temporary.unlink(missing_ok=True)
        destination.unlink(missing_ok=True)
        if side_destination.exists():
            shutil.rmtree(side_destination, ignore_errors=True)
        print(f"error: {str(err).removeprefix('error: ') or 'interrupted'}", file=sys.stderr)
        return 1

    print(new_id)
    print(f"copied {len(records)} records to {destination}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
