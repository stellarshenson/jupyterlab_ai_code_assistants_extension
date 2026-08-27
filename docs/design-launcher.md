# Launcher Tiles Design

Every docked assistant gets one tile in an "AI Assistants" section of the JupyterLab Launcher; a click opens that assistant in the file browser's current folder, resuming the folder's conversation when one exists. The tile's lifecycle is the panel's lifecycle - no second enable decision, no new setting. Criteria: `ACC-LNCH-143..159`, `ACC-LNCH-163`, `ACC-TEST-160..161` in `docs/acc-crit-jupyterlab-ai-code-assistants.md`.

## Mechanism

- **One command per provider** - `ai-code-assistants:<id>:launch-here` on `app.commands`, built with the existing `commandId()` helper; `label` from `descriptor.label`, `icon` a `launcherTileIcon` view of `providerIcon(descriptor.iconName, descriptor.iconSvg)` (see Section icon)
- **One `ILauncher.add()` per provider** - `{ command, category: 'AI Assistants', rank: <registry index>, categoryRank }`; the call returns an `IDisposable` that removes the tile
- **Re-render is the Launcher's own** - `LauncherModel.add` and its disposable both emit `stateChanged`; every open Launcher tab shares that model, so a tile appears or vanishes with no reload
- **Empty section costs nothing** - the Launcher builds sections from items only; the last tile disposed removes the header with it
- **`ILauncher` is optional** - declared last in the plugin's `optional` list, after `IColourfulTabs`; without a launcher the extension registers the command and adds no tile, and behaves as today otherwise
- **Core stays assistant-free** - tiles derive from registry descriptors; `core-neutrality.spec.ts` remains the guard

## Lifecycle

Tiles ride the `reconcile` loop in `src/index.ts`; nothing else decides whether a tile exists.

- **`start(id)`** - docks the panel, registers the refresh command and the tile command, adds the tile; the `ILivePanel` record gains `launchCommand: IDisposable` and `tile: IDisposable | null` (null when there is no launcher)
- **`stop(id)`** - disposes panel, refresh command, tile command and tile together, the tile before the command it runs
- **Enable + available + roster** - the DEF-132 contract applies unchanged: enabled in settings, and binary present or roster not yet known; a `false` roster answer removes panel and tile alike
- **Settings toggle** - `settings.changed → reconcile()` already exists; no new signal, no new subscriber

## Click path

The Launcher passes `args.cwd` (file browser Contents-API path, kept live by `pathChanged`) on every click. The command resolves the folder, decides new versus resume, then launches.

- **Entry point** - `AssistantSessionsPanel.launchHere(cwd)`; the command in `src/index.ts` is a one-line delegate to it, because the root join, the listing fetch, the terminal reuse ladder and the resolved launch mode are all already the panel's
- **Folder** - `cwd` joined onto `status.root_dir` exactly as `_currentFolder()` does in `src/core/panel.ts`; empty root → no launch
- **Listing** - `GET providers/<id>/sessions` through the panel's own `_fetch` on EVERY click, never the cached rows: the poll that fills the cache stops while the panel is hidden, and the tile is clickable then; a row with `project_path === folder` means the folder has a conversation
- **Resume** - row found → `TerminalManager.findForSession(row.session_id)`; a terminal already running it is activated and focused, no launch
- **New** - no row → new session; id minted client-side with `UUID.uuid4()` when `descriptor.mintsNewSessionId`, otherwise the CLI mints it
- **Mode** - `resolveLaunchMode(descriptor.launchModes, settings)` with no forced mode, the `+` button's default
- **Argv** - one request to the new route below; the server owns `cli_path`, mode flag, resume verb and pin bookkeeping
- **Terminal** - `commands.execute('basic-terminal:launch', { argv, cwd })`; the sibling extension exec's argv shell-less behind its own init waiter and resolves to the terminal widget
- **Launcher tab** - the command returns that widget, so the Launcher closes and the terminal takes its place, as notebook tiles do

## Launch argv route

The existing `POST providers/<id>/launch` spawns the terminal itself and is untouched. The tile needs argv only, because `basic-terminal:launch` does the spawn.

- `POST providers/<id>/launch-argv` body `{project_path, encoded_path?, session_id?, new_session_id?, fork_session_id?, fork_from?, mode?, name?}` → `{argv: [...]}`; the tile sends `project_path`, `encoded_path`, `session_id`, `new_session_id` and `mode`, and the fork and `name` keys are accepted and validated because the validator is the launch route's own
- Same validation as `LaunchHandler`: directory exists, `new_session_id` exclusive with `session_id`, `mode` declared on the descriptor → 400 `mode_unsupported`
- Same side effect: the pin bookkeeping - `state.clear_pin` on a launch that opens no existing conversation, `state.write_pin` on a fork - is one shared method on `_LaunchBase`, so neither route can drift from the other. A tile launch never reaches either branch: a tile resumes with a session id, or starts new in a project that has no row and therefore no `encoded_path` to key a pin on
- Same provider hook: `store.launch_argv(cli_path, ...)`, so per-provider verbs (`claude --resume`, `codex resume`, `gemini --session-file`, `kimi -S`) need no change
- 503 `cli_not_found` when `shutil.which(cli_binary)` is empty; the tile shows one Notification naming the binary

## Section placement and order

- **Category order** - Launcher ranks Notebook 0, Console 20, Other 100; unranked categories land after Other alphabetically
- **`categoryRank`** - one value on every tile, above Other's 100 and finite → section sits after Other and before any unranked third-party category; the smallest rank across a category's items wins
- **Version floor** - `categoryRank` exists from JupyterLab 4.6.0; `@jupyterlab/launcher` pinned `^4.6.0`, runtime here is 4.6.3
- **Tile order** - `rank` = provider index in `src/providers/index.ts`, matching the sidebar
- **Section icon** - the Launcher has no section icon of its own; it draws the header with the FIRST item's command icon under the `launcherSection` stylesheet preset and each tile under `launcherCard`. Every tile command carries `launcherTileIcon(providerIcon(...))` from `src/core/icons.ts`: a view of the provider icon (a prototype child, as `LabIcon.bindprops` builds) whose `react` renders the extension's joint icon `assistantsIcon` under the section preset and the provider's own glyph otherwise, so the header shows the vendor-neutral robot head while each tile keeps its mark (`ACC-LNCH-163`). No phantom item, no DOM patching; if the Launcher stopped passing the preset, the header would fall back to the first tile's icon

## Dependencies

- **`@jupyterlab/launcher ^4.6.0`** - npm, for `ILauncher` and `categoryRank`
- **`jupyterlab-basic-terminal-extension >=1.0.7`** - pip runtime dependency in `pyproject.toml`; it ships its own labextension, and the server half is mandatory
- **No npm coupling to the sibling** - it exports no token; the contract is the command id `basic-terminal:launch` and its args `{argv: string[], cwd?: string}`, checked with `hasCommand` at click time

## Edge cases

- **No roster yet** - `status === null` → no launch, one Notification "Waiting for the server root"; never joins a path onto an empty root
- **Non-default drive** - `cwd` with a drive prefix → no launch, one Notification naming the reason
- **Sibling command absent** - `hasCommand('basic-terminal:launch')` false → no launch, one Notification naming `jupyterlab_basic_terminal_extension`
- **Binary vanished after docking** - the click's listing request answers 503 `cli_not_found` first (the argv route carries the same gate) → one Notification naming the binary; the next roster undocks panel and tile
- **Double click** - the Launcher's own `pending` flag ignores clicks while one execute is in flight
- **Sibling refuses the spawn** - a rejection from `basic-terminal:launch` is caught and shown as one Notification; the Launcher keeps its tab, because an escaping rejection is what raises its modal "Launcher Error"
- **Pre-roster tile** - present under the null-roster rule like the panel, so a restored layout finds it; the click guard above covers the window
- **Resume re-docks an open terminal** - when the reuse ladder returns a terminal already in the main area, the launcher-extension callback re-adds it with `ref` = the Launcher's id, so a terminal running in a split dock moves into the Launcher's slot (4.6.3 `jlab_core`); a consequence of returning the widget, documented not fixed (`DEF-PANE-144`)

## Decisions

Four choices the user locked on 2026-08-27, with the alternative declined, and one the implementation made under the user's requirement of a vendor-neutral header icon.

- **Resume trigger** - a conversation exists for the folder (listing row), not a live process; a live-process check would be Codex-only today (`hasLiveProcess`) and needs a probe across every terminal
- **Launch path** - `basic-terminal:launch` over the existing launch route; costs a pip dependency and the argv route, buys one shared terminal spawner across the user's extensions
- **Placement** - after Other, explicit through `categoryRank` rather than left to the unranked alphabetical tail; costs the `^4.6.0` floor. Originally between Console and Other; moved on the user's word on 2026-08-27
- **After click** - Launcher tab replaced by the terminal over keeping the Launcher open
- **Section icon** - a `launcherTileIcon` view that answers the `launcherSection` preset, over a phantom rank-minus-one item hidden by CSS (a fake entry in the launcher model) or a `MutationObserver` patching the header (the `jupyterlab_launcher_sections_extension` route, DOM surgery against React's re-render); costs the direct `react` dependency

## Tests

The spec files are the list of cases; this section names only where each tier lives and what it proves.

- **Jest `src/__tests__/launcher.spec.ts`, `index.spec.ts` and `launcher-icon.spec.ts`** - the click path branch by branch, tile add/dispose with the panel, and the header icon view under each preset
- **pytest `tests/test_routes.py`** - the argv route against the launch route: validation, argv parity, pin bookkeeping
- **Galata `ui-tests/tests/launcher-tiles.spec.ts`** - the section in a real Launcher, the settings toggle, and the click-through with nothing mocked, with screenshots
- **Galata needs `test.use({ terminals: null })`** - Galata mocks `GET /api/terminals` in the page and answers it from the terminals it saw created through that same API. A terminal born through the sibling's own route is absent from that answer, so the sibling's liveness check fails every launch. The mock is off in this spec only
