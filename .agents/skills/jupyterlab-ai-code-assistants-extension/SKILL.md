---
name: jupyterlab-ai-code-assistants-extension
description: Session operations for the assistant panels of this extension. Claude Code - find, move, split, rename, copy a session into another project under a fresh id, promote a background job so `claude -c` resumes it, repair a compacted conversation, pin a default, clean up transcripts, enable the task list, run Claude Code against Kimi K3 or DeepSeek. Codex, Kimi, Gemini and DeepSeek - read, inventory, take over and resume a project's sessions. Use when a session is missing, `claude -c` reports "No conversation found to continue", a session lists as an agent session, work must continue in another project, tasks do not appear, Claude Code must use another provider, or the user says "take over", "read the other session", "where did the last agent stop", "list sessions across assistants", "resume the Gemini session" or "continue what Codex was doing".
---

# Session operations

Runbook for sessions the assistant panels list. Claude Code mechanics: `references/claude-operations.md`. Other assistants and takeover: `references/cross-assistant-sessions.md`.

## Stores

- `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` - one conversation; UUID is id and filename stem
- Match a transcript to a project by its records' `cwd`, never by re-deriving `<encoded-cwd>`; the dash encoding is lossy
- `~/.claude.json` `projects["<cwd>"].lastSessionId` - current conversation
- `.pinned-session` in the project dir - id for the resume-by-pin steps in `references/claude-operations.md`; the panel keeps its own pin; `claude -c` ignores both
- `claude -c` orders the cwd's transcripts by mtime and skips one it refuses, such as a compacted root; a live process holding a conversation keeps it off, a dead `kind: "bg"` record does not

## Operations

- Find: resolve root, match encoded dir or first `cwd`; `find ~/.claude/projects -name "<id>.jsonl"` lists copies
- Move: copy `<id>.jsonl` and `<id>/` into target encoded dir, append `{"cwd": "<target>"}`, resume with `claude --resume <id>`; a project folder rename leaves one id under two encoded dirs
- Copy, fresh id: `python3 scripts/copy-session.py <src.jsonl> <target-dir> --with-side-files` rewrites every `sessionId` and `session_id` (nested and side files), copies the side directory and pins; no shared tasks or background work
- Split: Branch Session forks at current point; copy with fresh id gives two independent continuations
- Collapse: branch wanted conversation, stop or delete the held branch - `-c` ignores pins, so re-pinning does not free it
- Rename: panel Rename Session or CLI `/rename`; both append `custom-title` record; no live process may hold file
- Promote background job: stop the live job, confirm no pid holds transcript; resume with `claude --resume <id>`; `agent-name` stripping is optional cleanup
- Handoff: outbound document to OS temp dir, suggested skills and artifact paths, secrets redacted; inbound reads newest transcript fully and checks stop point against live state

Details: `references/session-operations.md`. Compaction repair, background jobs, pins and transcript clean-up: `references/claude-operations.md`.

## Other assistants

- Codex, Kimi, Gemini and DeepSeek (`dsh`): stores, transcript formats, read commands and resume commands in `references/cross-assistant-sessions.md`
- Inventory: one project's sessions across all five assistants, newest first
- Take over: live state first, read the newest session in full, verify the stop point, report, stop

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
