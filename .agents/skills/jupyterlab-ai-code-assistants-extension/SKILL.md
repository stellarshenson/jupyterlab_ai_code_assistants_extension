---
name: jupyterlab-ai-code-assistants-extension
description: Claude Code session operations for the assistant panels of this extension - find, move, split, rename, copy a session into another project under a fresh id, promote a background job so `claude -c` resumes it, enable the task list, and run Claude Code against Kimi K3 or DeepSeek. Use when a session is missing, `claude -c` reports "No conversation found to continue", work must continue in another project, tasks do not appear, or Claude Code must use another provider.
---

# Session operations

Runbook for sessions the assistant panels list. Full storage mechanics: `my-claude`. Takeover: `session-transfer`. Outbound document: `handoff`.

## Stores

- `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` - one conversation; UUID is id and filename stem
- Encoding: every character outside `A-Za-z0-9` becomes `-`; names over 200 characters are truncated with a hash. Prefer a record's `cwd` or an existing directory
- `~/.claude.json` -> `projects["<cwd>"].lastSessionId` - current conversation
- `.pinned-session` in the project dir - id for `claude-here`; the panel keeps its own pin; `claude -c` ignores both
- `claude -c` takes only newest transcript for cwd, no fallback; a live process holding it blocks it, a dead `kind: "bg"` record does not

## Operations

- Find: resolve root, match encoded dir or first `cwd`; `find ~/.claude/projects -name "<id>.jsonl"` lists copies
- Move: copy `<id>.jsonl` and `<id>/` into target encoded dir, append `{"cwd": "<target>"}`, resume with `claude --resume <id>`; resuming from another cwd keeps the source file and copies nothing
- Copy, fresh id: `python3 scripts/copy-session.py <src.jsonl> <target-dir> --with-side-files` rewrites every `sessionId` and `session_id` (nested and side files), copies the side directory and pins; no shared tasks or background work
- Split: Branch Session forks at current point; copy with fresh id gives two independent continuations
- Collapse: branch wanted conversation, stop or delete the held branch - `-c` takes the newest, so re-pinning does not free it
- Rename: panel Rename Session or CLI `/rename`; both append `custom-title` record; no live process may hold file
- Promote background job: stop the live job, confirm no pid holds transcript; resume with `claude-here` or `claude --resume <id>`; `claude-here --sanitize` and `agent-name` stripping are optional cleanup
- Handoff: outbound document to OS temp dir, suggested skills and artifact paths, secrets redacted; inbound reads newest transcript fully and checks stop point against live state

Details: `references/session-operations.md`.

## Task list

- `CLAUDE_CODE_ENABLE_TASKS=1` enables task tools; default on; `=false` disables
- `CLAUDE_CODE_TASK_LIST_ID` names shared list
- Records: `~/.claude/tasks/<session-id>/`; keep `pending` and `in_progress`

## Another provider

- Kimi K3: `references/provider-launchers.md`; `KIMI_API_KEY` becomes `ANTHROPIC_AUTH_TOKEN`, endpoint `https://api.moonshot.ai/anthropic`
- DeepSeek: run `claude-deepseek`; requires `DEEPSEEK_AUTH_TOKEN`
- Never put token on command line; both launchers refuse to start without it, so Claude Code never sends own credentials

<!-- improved 2026-10-18 | body 1073→411w / 125→43L | benchmark n/a (not-requested) | via improve-skill -->
<!-- improved 2026-10-18 | body 467→457w / 43→43L | benchmark n/a (not-requested) | via improve-skill -->
