---
name: jupyterlab-ai-code-assistants-extension
description: Session operations for the assistant panels. Any assistant - list, rename, move, delete, branch or make current a session, and refresh the panels, with the `jupyterlab-ai-code-assistants` command; read, inventory, take over and resume sessions. Claude Code - find, split, copy a session to another project under a fresh id, promote a background job so `claude -c` resumes it, repair a compacted conversation, pin a default, clean up transcripts, enable the task list, run Claude Code against Kimi K3 or DeepSeek. Use when a session is missing, `claude -c` reports "No conversation found to continue", a session lists as an agent session, work must continue in another project, tasks do not appear, an assistant CLI was installed or removed, Claude Code must use another provider, or the user names `jupyterlab-ai-code-assistants` or says "take over", "read the other session", "where did the last agent stop", "list sessions across assistants", "resume the Gemini session" or "continue what Codex was doing".
---

# Session operations

Runbook for sessions the assistant panels list. List, rename, move, delete, branch and make current a session with the `jupyterlab-ai-code-assistants` command, never by editing an assistant's store. Claude Code mechanics: `references/claude-operations.md`. Other assistants and takeover: `references/cross-assistant-sessions.md`.

## Command

- Changes go through the running JupyterLab server; every open panel shows them at once
- Not on `PATH`: `python -m jupyterlab_ai_code_assistants_extension.cli`, with the Python that runs the lab
- `--url URL` (base URL without `/lab`) and `--json` go before the subcommand; default server is the running one
- `status`, also with no subcommand - server, then per assistant id, label, enabled and CLI path; `-a` takes that id
- `sessions list [-a ID] [-p PATH]` - one row per project, its current session; with `-p`, that project's other sessions too
- `sessions rename SESSION NAME -a ID`
- `sessions move SESSION --to PATH -a ID` - `--to` is an existing folder; the session becomes current there
- `sessions delete SESSION -a ID` - follows JupyterLab's move-to-trash setting; never the project's current session
- `sessions branch SESSION -a ID [--name NAME]` - the branch becomes current; unnamed, it is numbered after SESSION's title
- `sessions switch SESSION -a ID` - makes SESSION its project's current session
- SESSION is the full id `sessions list` prints; `-p PATH` names the project holding it, else every project is searched
- `refresh` after installing or removing an assistant CLI: panels dock or leave in every open window
- A Codex move forks into the target under a new id and archives the source; resume the id the command prints after `as`
- Exit 2: usage error, or several servers run - pass `--url`
- Exit 3: no server answers - start JupyterLab or pass `--url`
- Exit 4: refused - session open in a running terminal (close it), delete of the current session (`sessions switch` first), already in the `--to` project, `--to` not a folder, name refused, or the assistant does not offer it
- Exit 5: not found - assistant unknown, turned off or not installed (`status`), or no such session or project (`sessions list`)
- Exit 1: the server failed; the stderr line says why

## Stores

- `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` - one conversation; UUID is id and filename stem
- Match a transcript to a project by its records' `cwd`, never by re-deriving `<encoded-cwd>`; the dash encoding is lossy
- `~/.claude.json` `projects["<cwd>"].lastSessionId` - current conversation
- `.pinned-session` in the project dir - id for the resume-by-pin steps in `references/claude-operations.md`; the panel keeps its own pin; `claude -c` ignores both
- `claude -c` orders the cwd's transcripts by mtime and skips one it refuses, such as a compacted root; a live process holding a conversation keeps it off, a dead `kind: "bg"` record does not

## Operations

- Find: `sessions list -a claude -p <root>`; without a server, match encoded dir or first `cwd`; `find ~/.claude/projects -name "<id>.jsonl"` lists copies
- Move: `sessions move <id> --to <target> -a <assistant>`, then resume in the target folder, `claude --resume <id>`; a project folder rename leaves one id under two encoded dirs
- Copy, fresh id: `python3 scripts/copy-session.py <src.jsonl> <target-dir> --with-side-files` rewrites every `sessionId` and `session_id` (nested and side files), copies the side directory and pins; no shared tasks or background work
- Split: `sessions branch` forks at current point; copy with fresh id gives two independent continuations
- Collapse: `sessions branch` the wanted conversation, stop the process holding the other, then `sessions delete` it - `-c` ignores pins, so re-pinning does not free it
- Rename: `sessions rename`, panel Rename Session or CLI `/rename`; each appends a `custom-title` record; no live process may hold the file
- Promote background job: stop the live job, confirm no pid holds transcript; resume with `claude --resume <id>`; `agent-name` stripping is optional cleanup
- Handoff: outbound document to OS temp dir, suggested skills and artifact paths, secrets redacted; inbound reads newest transcript fully and checks stop point against live state

Details: `references/session-operations.md`. Compaction repair, background jobs, pins and transcript clean-up: `references/claude-operations.md`.

## Other assistants

- Codex, Kimi, Gemini and DeepSeek (`dsh`): stores, transcript formats, read commands and resume commands in `references/cross-assistant-sessions.md`
- Change their sessions with the command, as for Claude Code
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
