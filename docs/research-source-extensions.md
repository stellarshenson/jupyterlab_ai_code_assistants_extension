# Source Extension Research

Reference for implementing the provider core. Compiled from file-line-verified exploration of the three source extensions and the Gemini CLI. Paths below are absolute on this machine.

- BASE: `/home/lab/workspace/private/jupyterlab/jupyterlab_claude_code_extension` (v1.2.73)
- CODEX: `/home/lab/workspace/private/jupyterlab/jupyterlab_codex_extension` (v0.6.12)
- KIMI: `/home/lab/workspace/private/jupyterlab/jupyterlab_kimi_code_extension` (v0.7.8)
- GEMINI CLI: `@google/gemini-cli` 0.54.4 at `~/.local/bin/gemini`, bundle source at `~/.local/lib/node_modules/@google/gemini-cli/bundle/`

## Capability matrix

| capability       | claude (BASE)                                                  | codex                                                           | kimi                                                               | gemini                                                                      |
| ---------------- | -------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| store            | `~/.claude/projects/<enc>/*.jsonl`                             | `~/.codex/state_<N>.sqlite` (read-only), rollout-JSONL fallback | `~/.kimi-code/{workspaces.json, sessions/<wd_id>/session_*/}`      | `~/.gemini/projects.json` registry + `~/.gemini/tmp/<shortId>/chats/*.json` |
| project key      | lossy dash-encoded path                                        | plain cwd (`DISTINCT cwd`)                                      | opaque `wd_id` registry                                            | registry short id                                                           |
| native fork      | `--fork-session --session-id <client-uuid>`                    | `codex fork <parent>` (CLI mints id, needs discovery watcher)   | none                                                               | none                                                                        |
| server fork      | -                                                              | -                                                               | `copytree` session dir + restamp `state.json` + index append + pin | copy chat JSON with fresh id (to implement, Kimi strategy)                  |
| colour           | native `/color`, read from JSONL `agent-color` records         | none                                                            | FNV-1a(session_id) mod 6                                           | none                                                                        |
| launch modes     | `--dangerously-skip-permissions`                               | `--dangerously-bypass-approvals-and-sandbox`                    | `--yolo`                                                           | `--yolo`, `--approval-mode default\|auto_edit\|yolo\|plan`                  |
| resume           | `claude --resume <uuid>`                                       | `codex resume <uuid>`                                           | `kimi -S <session_uuid>`                                           | `--session-file <path>` (never `--resume <index>` - positional, stale)      |
| new session      | `claude --session-id <uuid>`                                   | `codex`                                                         | `kimi`                                                             | `gemini --session-id <uuid>`                                                |
| naming           | `-n <name>` CLI flag                                           | none (forks unnamed)                                            | server-side: `state.json.title` + `isCustomTitle`                  | unknown; stamp file if format allows                                        |
| remote control   | `~/.claude/sessions/<pid>.json` bridgeSessionId + 1h freshness | -                                                               | -                                                                  | -                                                                           |
| bg agents        | `claude agents --json`, attach verb at launch                  | -                                                               | -                                                                  | -                                                                           |
| live process dot | -                                                              | `/proc` scan `comm == "codex"` + readlink cwd                   | -                                                                  | -                                                                           |
| destructive ops  | direct file delete (send2trash honoured)                       | shells to `codex archive` / `codex delete --force`              | direct dir delete + index prune                                    | direct file delete (to implement)                                           |

## Base mechanism (port this architecture)

**Activation** (`index.ts`, 142 L): status probe is a hard gate - `GET status` checks `shutil.which("claude")` server-side (sessions.py:53); throw or `enabled:false` → panel never registers. `ILabShell` required (docking only, rank 600); `ILayoutRestorer`, `ISettingRegistry`, `ITerminalTracker`, `IDefaultFileBrowser`, `IColourfulTabs` all optional with graceful degradation. Settings sidebar read before first dock; `apply()` re-run on `settings.changed`. One `app.commands` command (refresh); everything else lives in a private `CommandRegistry` in the widget - invisible to palette.

**Widget** (`widget.ts`, 2571 L, one class): all imperative DOM, no React. One `_sessions` array; Favorites = filter, Recent = mtime sort + limit, All = name sort. Full teardown re-render with scrollTop capture. Expanded state in localStorage. Client-side fuzzy filter (NFD normalise + substring + 5% Levenshtein). Context menu rebuilt on every open (Lumino submenus lack isVisible); branch submenus fetch `branches?include_bg=1` on open, top 5 + "Manage Sessions... (N)". Manage popup is ~410 lines of hand-built DOM: search, multi-select, pinned current row, delete without confirm (trash), busy-scrim, re-sync from fresh fetch not optimistic splice.

**Polling**: rows 30s (`POLL_INTERVAL_MS`), skipped while context menu open; colour pass separate 30s setTimeout chain surviving panel hide; fork watcher 2s x 90 attempts. The 30s poll is coupled by comment contract to the server's 35s bg-agents cache (`BG_AGENTS_CACHE_MAX_AGE_S`).

**Terminal reuse**: three-step ladder - microcache keyed `project_path` (fast path only), tracker walk reading `widget.content.session.name` → `GET terminal-cwd/<name>` matching on session_id alone, else fresh launch. Identity is always server-resolved: BFS the pty's `/proc` tree for `comm == "claude"`, then attach-id-from-cmdline FIRST (attach clients write no pidfile), then pidfile, then `--resume` cmdline parse. cwds read from `/proc/<pid>/cwd`, never `PWD`.

**Launch** (routes.py:614-769): server decides verb at launch time (re-runs bg check; panel data up to 30s stale): attach / --resume / --session-id / bare, + fork flags, + mode flag, + `-n`. All wrapped in `_INIT_WAITER` bash trampoline: traps SIGWINCH, polls `stty size` up to 5s for pty resize, `clear`, `exec "$@"` so the assistant replaces bash on the same pid. Spawned via `terminal_manager.create(shell_command=..., cwd=...)`.

**Current-conversation resolution** (sessions.py:378-473): Claude's own sessions-index.json is distrusted; pin file `.jl-current` wins if consistent, else newest JSONL with consistent cwd, else filesystem-walk recovery. Pin written on fork/switch, cleared on new-session. Pin content validated alnum+hyphen before path join.

**State the extension writes**: favourites `~/.claude/jupyterlab_claude_code_extension.json` (atomic tmp+replace); pins `.jl-current` per project dir. Everything else re-derived per request; one server cache (bg agents, 35s).

## Derivative deltas that matter

**Codex**: SQLite read-only URI connect with immutable fallback; highest `state_<N>` generation wins. No encoded_path anywhere - all endpoints keyed `project_path`. Filters archived/sub_agent/invisible threads from listing but NOT from branches (fork watcher must see pre-first-turn threads). Fork = `codex fork`, id discovered by 2s watcher diffing branch list, then pinned via switch. Pre-flight existence check before launch (404 branch_not_found). `delete_to_trash` surfaced in status so dialogs say archive vs delete. Disposal returns `{removed_count, failed_count}` (CLI can partially fail). Terminal probe returns id only - no cwd fallback (plain shell in project dir must never look like a session). State file `~/.codex/jupyterlab_codex_extension.json` holds favourites AND pins.

**Kimi**: `wd_id` from `workspaces.json` (honour `deleted_workspace_ids`) IS the encoded_path - no decode machinery. Sessions are directories `session_<uuid>/` with `state.json` (title, isCustomTitle, createdAt, updatedAt, workDir) + `agents/*/wire.jsonl`. Message count = binary substring count of `"type":"context.append_message"` with mtime+size memo cache. Recency = max(state.updatedAt, state.json mtime). Server fork: validate id regex `session_[0-9a-f-]{36}`, copytree, restamp title/isCustomTitle/createdAt/updatedAt, append `{sessionId, sessionDir, workDir}` line to `session_index.jsonl`, rmtree on failure, pin. Strict launch body allow-list + commonpath check under served root. `label.ts`: column-aware truncation (60 cols, CJK/emoji wide ranges, code-point iteration).

**Gemini** (verified from bundle source + `--help`): `ProjectRegistry` at `~/.gemini/projects.json` maps project root → short id (`registry.getShortId(root)`), with legacy hash-dir migration. Chats: `path.join(getProjectTempDir(), "chats")` = `~/.gemini/tmp/<shortId>/chats/`, JSON files, resume reads `session.fileName`. CLI is auth-gated even for `--list-sessions` (needs GEMINI_API_KEY / vertex / GCA env) - so the provider must scan disk, never shell to the CLI for listing. Flags: `-r/--resume latest|<index>`, `--session-file <json>`, `--session-id <uuid>`, `--list-sessions`, `--delete-session <index>`, `-y/--yolo`, `--approval-mode`, `-p` headless, `-o json`.

## Coupling points to burn out of the core

1. Binary gate must become per-provider (status returns provider list).
2. Store layout / path encoding is per-provider adapter territory - Claude's three lossy-encoding recovery mechanisms are Claude-only.
3. JSONL record parsing (cwd/custom-title/agent-color tail scans, 128 KiB window) is Claude's store adapter.
4. Pid-file protocol + remote-control heuristic = Claude capability flag.
5. argv grammar both directions (construction AND /proc cmdline re-parse) is per-provider.
6. `/color` six-entry map → colour store in core, per-provider colourSource (see acc-crit Colour section).
7. Bg-agents subsystem (cache, include_bg, attach verb, bg chips, disabled menu items) = Claude-only capability threaded through every layer - gate all of it on a descriptor flag.
8. Naming surface: URL namespace, widget ids, command prefix, CSS prefix, icon names, localStorage keys, user-facing strings - all must derive from provider id / extension namespace.
9. widget.ts has no seam between panel and provider - the port must decompose: panel core (sections, render, menus, popup, polling, terminal reuse ladder) vs provider hooks (labels, badges, menu items, colour, launch payload).
10. cli.py (statusline installers) is orthogonal - do not port into core.

## Environment facts

- Build lifecycle: Makefile only (`make install`, `make test`, `make clean`); `make build` auto-increments version - never hand-edit versions
- TypeScript: template ships 5.5.4 but lib0 needs 5.8+ (`TS2315: Type 'Uint8Array' is not generic`) - bump to `~5.8.0` if the error appears
- webpack pinned 5.106.0 in resolutions+overrides (license-webpack-plugin crash on >=5.106.1); chalk pinned 4.1.2 (Node 24 duplicate crash); commit yarn.lock with package-lock.json when pins change
- Activation message `JupyterLab extension jupyterlab_ai_code_assistants_extension is activated!` must stay verbatim (UI test greps it)
- Galata: `JLAB_TEST_PORT` knob, `reuseExistingServer: false` unconditional, workers 1, redirect not tee
- `jupyterlab_colourful_tab_extension` supplies `IColourfulTabs.setColour(widget, colourId)`, vocabulary exactly six ids: rose/peach/lemon/mint/sky/lavender
