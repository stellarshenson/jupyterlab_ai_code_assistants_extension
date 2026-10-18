# Session operations

## Stores

- `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` - one conversation; UUID is id and filename stem
- Encoding: every character outside `A-Za-z0-9` becomes `-`; names over 200 characters are truncated with a hash. Prefer a record's `cwd` field or an existing directory over re-deriving
- `<session-id>/` - side directory: subagent transcripts, `custom-title.json`, workflows, tool results
- `~/.claude.json` -> `projects["<cwd>"].lastSessionId` - current conversation
- `~/.claude/projects/<encoded-cwd>/.pinned-session` - id read by `claude-here`, which falls back to the panel's pin in the Jupyter data dir and then the newest transcript; the panel does not read this file; plain `claude -c` ignores it
- `claude -c` resolves only newest transcript for cwd, no fallback
- A live process holding the newest transcript blocks `-c`; a dead `kind: "bg"` record in `~/.claude/sessions/<pid>.json` does not (tested 2026-08-26: absent, synthetic and real dead records all continued)

## Find

1. Resolve root: `git rev-parse --show-toplevel` or `pwd`
2. Match encoded dir; when absent, scan `~/.claude/projects/*/*.jsonl` and keep first `cwd` equal to root or under it
3. Sort by last activity, newest first; current conversation is `lastSessionId`, pin names deliberate one
4. `find ~/.claude/projects -name "<session-id>.jsonl"` lists every copy
5. Takeover: read newest session fully before editing (`session-transfer`)

## Move to another project

- Resuming by id from another cwd keeps appending to the source project's transcript; it creates no copy and leaves `claude -c` in the target with nothing
- To move: copy `<id>.jsonl` and `<id>/` into the target encoded dir, append `{"cwd": "<target>"}`, then run `claude --resume <id>` there
- Delete the source copy only when the move must be one-way
- Two live processes on two copies of one id fork silently

## Copy to another project, fresh id

Independent copy: no shared task ids, notifications or background workflows.

1. Create UUID
2. Copy transcript to target dir as `<new-id>.jsonl` and the whole `<old-id>/` side directory as `<new-id>/`
3. Rewrite every `sessionId` and `session_id` at any depth in the transcript and in every JSON/JSONL side file; parse each record, never text replace
4. Write `<new-id>` to `.pinned-session` for `claude-here`; resume with `claude --resume <new-id>` or `claude-here`

Run `scripts/copy-session.py <src.jsonl> <target-dir> --with-side-files`. It parses before writing, stages the side directory, renames the transcript into place only on success, and cleans partial output on failure.

- Copy does not see turns written to original after copy; original does not see turns written to copy
- The pin does not drive `claude -c`; use `claude-here` or `claude --resume <new-id>`

## Split and branch

- Branch at current point: panel Branch Session forks transcript into new id, keeps history to fork
- Split into two independent continuations: copy with fresh id
- Collapse to one transcript: branch wanted conversation, stop or delete the held branch; re-pinning does not free a held newest branch

## Rename

- Panel Rename Session calls provider rename route; Claude provider appends `{"type": "custom-title", "customTitle": ...}` record, same as CLI `/rename`
- Rename only while no live process holds transcript; live process rewrites file
- Leave `custom-title.json` alone when stripping agent markings; it carries human title

## Promote a background job

Only a live background process holding the newest transcript blocks `claude -c`. A dead `kind: "bg"` record is inert.

1. Confirm the live job's pid; `pgrep -af "<session-id>"`
2. Stop the job; confirm no process holds the transcript
3. Ensure the transcript is the newest for the cwd, or resume by id: `claude --resume <id>` or `claude-here` (which reads `.pinned-session`)
4. `claude -c` now picks it when it is the newest unheld transcript
5. `claude-here --sanitize` and `agent-name` stripping are optional cleanup, not a fix

## Handoff and takeover

- Outbound: write handoff document to OS temp dir, not workspace; include what next session needs and suggested-skills section; reference artifacts by path; redact secrets (`handoff`)
- Inbound: read newest transcript fully; verify stop point against `git status`, live pids and logs; report and stop (`session-transfer`)
