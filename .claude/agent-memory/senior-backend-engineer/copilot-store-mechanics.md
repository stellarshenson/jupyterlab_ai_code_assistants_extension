---
name: copilot-store-mechanics
description: copilot CLI 1.0.112 store facts measured 2026-11-16 - folders are the list source, name in workspace.yaml, inuse.<pid>.lock, account refuses model turns
metadata:
  type: project
---

Measured copilot 1.0.112 against an isolated `COPILOT_HOME` (login carried by `cp -p ~/.copilot/config.json`; tokens sit in plain `authTokens`, no keyring).

- The owner's GitHub account gets 403 "not authorized to use this Copilot feature" on every model call, so no real turn can be measured. `copilot sessions import <semantic.jsonl>` writes real events without a model (header `{"type":"session","version":1,"externalId","createdAt","workspace":{"workingDirectory"}}`, records `{"type":"message","id","timestamp","role","content":[{"type":"text","text"}]}`)
- Listing and `--resume=<name>` read `session-state/<id>/workspace.yaml` (`name`), never `session-store.db`; the db row (summary = name) is stale after a folder delete and `/chronicle reindex` only upserts
- An external `name:` write survives resume and a later workspace write by the running session (merge from disk); the running TUI keeps its OSC title `<name> - GitHub Copilot`
- `events.jsonl` appears only when something is persisted (named session exit, turn); idle resumes write nothing; copilot and (since DEF-PROV-399) the provider hide unnamed sessions with no user.message
- `inuse.<pid>.lock` holds the native pid (comm `MainThread`, child of the `node-MainThread` loader), `.hold` is flocked; kill -9 leaves both until the next start
- An in-TUI `/resume` or `/new` does not move the lock: it adds a pair in the new session and keeps the first held; a switch back changes no lock; no store file records the foreground session, so the provider answers the newest lock. The process log `$COPILOT_HOME/logs/process-<ts>-<native pid>.log` does log `Registering foreground session: <id>` on every switch (unused so far)
- `copilot --resume` with no value creates a placeholder session folder before showing the picker; `trash-put` cannot trash under `/tmp` (other volume), so move test folders instead

**Why:** the provider was written from docs; these are the measured divergences. **How to apply:** before changing `providers/copilot.py`, check against these; full evidence was returned by workflow copilot-real (`tmp/workflows/copilot-real/`). Related: [[agy-store-mechanics]]
