---
name: agy-store-mechanics
description: measured facts about Google Antigravity CLI (agy 1.5.9) store - where titles persist, row rebuilds, fork-by-copy, isolation
metadata:
  type: project
---

Measured 2026-11-16 on agy 1.5.9 (~/.gemini/antigravity-cli).

- User title from `/rename` lives in `annotations/<id>.pbtxt` (`title:"<name>"`); conversation_summaries rows are rebuilt on every agy start, so SQLite title/raw_summary writes are lost
- `agy -p` conversations get title '' and preview = first prompt; no non-interactive rename (print mode refuses `/rename`, ACP has no rename method)
- Prompt must follow `-p` directly: `agy --conversation <id> -p "x"`; `agy -p --conversation <id> "x"` exits 2
- Fork by copy (db + brain, id replaced in 7 places) resumes fine; parent_conversation_id stays ''
- Trashing conversations/<id>.db does not drop its summaries row; agy hides it from its own list
- `HOME=<dir>` isolates agy from the real store; `ANTIGRAVITY_GEMINI_DIR` was ignored by `agy models`

- A forked copy has no summaries row until agy first opens it, and the branch route's launch pre-flight 404s an id the project does not list; the provider therefore keeps `antigravity-forks.json` (fork id → folder) in the extension state dir
- Opening a WAL db with `mode=ro` leaves its `-wal`/`-shm` behind (agy leaves the same); compare conversation ids, not file names, in "nothing left behind" tests
- Signed-in store, verified: a written annotations file is adopted. An agy restart puts it in `cache/conversation_metadata.json` only; the summaries row takes it (title = preview = name) on the next turn
- A running agy holds `presence/<uuid>.lock` open (seen in `/proc/<pid>/fd` of a bare `agy --dangerously-skip-permissions`); lock files outlive the process, so only an open fd counts. `AntigravityStore.session_id_for_pid` reads it (fix-1, 2026-11-16); the terminal probe, server-side reuse and live-process ids use it (tab naming from it was removed 2026-11-16)
- Workflow trap: jest (`testRegex src/.*/.*.spec.ts`) and pytest collect before-copies under `tmp/workflows/*/patches/before/`; suffix test copies `.before`
- Verifier trap: `test_core_neutrality.py` builds its name list from the live registry at import, so a mutation that drops a provider from discovery also drops that name from the scan; mutate the core with a no-op string instead

**Why:** the Antigravity provider's rename/list/fork must follow these, not guesses.
**How to apply:** check `conversations/<id>.db` existence when listing; rename means writing the annotations file (verified on the signed-in store).
