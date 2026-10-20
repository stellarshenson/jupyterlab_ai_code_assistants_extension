# Session operations

## Stores

- `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` - one conversation; UUID is id and filename stem
- Match a transcript to a project by its records' `cwd` (the root or a path under it), never by re-deriving `<encoded-cwd>`; the dash encoding is lossy
- `<session-id>/` - side directory: subagent transcripts, `custom-title.json`, workflows, tool results
- `~/.claude.json` `projects["<cwd>"].lastSessionId` - current conversation
- `~/.claude/projects/<encoded-cwd>/.pinned-session` - id read by the resume-by-pin steps in `claude-operations.md`, which fall back to the panel's pin in the Jupyter data dir and then the newest transcript; the panel does not read this file; plain `claude -c` ignores it
- `claude -c` orders the cwd's transcripts by mtime and falls back to the next newest past one it refuses, such as a compacted root
- A live process holding a transcript keeps `-c` off it; a dead `kind: "bg"` record in `~/.claude/sessions/<pid>.json` does not (tested 2026-08-26: absent, synthetic and real dead records all continued)

## Find

1. Resolve root: `git rev-parse --show-toplevel` or `pwd`
2. Match encoded dir; when absent, scan `~/.claude/projects/*/*.jsonl` and keep first `cwd` equal to root or under it
3. Sort by last activity, newest first; current conversation is `lastSessionId`, pin names deliberate one
4. `find ~/.claude/projects -name "<session-id>.jsonl"` lists every copy
5. Takeover: read newest session fully before editing (`cross-assistant-sessions.md`)

## Move to another project

- One id under two encoded dirs comes from a project folder rename; the re-homed records keep the old `cwd` (`claude-operations.md`)
- To move: copy `<id>.jsonl` and `<id>/` into the target encoded dir, append `{"cwd": "<target>"}`, then run `claude --resume <id>` there
- Delete the source copy only when the move must be one-way
- Two live processes on two copies of one id fork silently

## Copy to another project, fresh id

Independent copy: no shared task ids, notifications or background workflows.

1. Create UUID
2. Copy transcript to target dir as `<new-id>.jsonl` and the whole `<old-id>/` side directory as `<new-id>/`
3. Rewrite every `sessionId` and `session_id` at any depth in the transcript and in every JSON/JSONL side file; parse each record, never text replace
4. Write `<new-id>` to `.pinned-session`; resume with `claude --resume <new-id>`

Run `scripts/copy-session.py <src.jsonl> <target-dir> --with-side-files`. It parses before writing, stages the side directory, renames the transcript into place only on success, and cleans partial output on failure.

- Copy does not see turns written to original after copy; original does not see turns written to copy
- The pin does not drive `claude -c`; use `claude --resume <new-id>`

## Split and branch

- Branch at current point: panel Branch Session forks transcript into new id, keeps history to fork
- Split into two independent continuations: copy with fresh id
- Collapse to one transcript: branch wanted conversation, stop or delete the held branch; re-pinning does not free a held branch

## Rename

- Panel Rename Session calls provider rename route; Claude provider appends `{"type": "custom-title", "customTitle": ...}` record, same as CLI `/rename`
- Rename only while no live process holds transcript; live process rewrites file
- Leave `custom-title.json` alone when stripping agent markings; it carries human title

## Promote a background job

Only a live background process holding the transcript keeps `claude -c` off it. A dead `kind: "bg"` record is inert.

1. Confirm the live job's pid; `pgrep -af "<session-id>"`
2. Stop the job; confirm no process holds the transcript
3. Ensure the transcript is the newest for the cwd, or resume by id: `claude --resume <id>`
4. `claude -c` now picks it when it is the newest unheld transcript
5. `agent-name` stripping is optional cleanup, not a fix (`claude-operations.md`)

## Handoff and takeover

- Outbound: write handoff document to OS temp dir, not workspace; include what next session needs and suggested-skills section; reference artifacts by path; redact secrets
- Inbound: read newest transcript fully; verify stop point against `git status`, live pids and logs; report and stop (`cross-assistant-sessions.md`)
