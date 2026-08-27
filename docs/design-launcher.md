# Launcher Tiles Design

Every docked assistant gets one tile in an "AI Assistants" section of the JupyterLab Launcher; a click opens that assistant in the file browser's current folder, resuming the folder's conversation when one exists. The tile's lifecycle is the panel's lifecycle - no second enable decision, no new setting. Criteria: `ACC-LNCH-143..159`, `ACC-TEST-160..161` in `docs/acc-crit-jupyterlab-ai-code-assistants.md`.

## Mechanism

- **One command per provider** - `ai-code-assistants:<id>:launch-here` on `app.commands`, built with the existing `commandId()` helper; `label` from `descriptor.label`, `icon` from `providerIcon(descriptor.iconName, descriptor.iconSvg)`
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

- **Entry point** - `AssistantSessionsPanel.launchHere(cwd)`; the command in `src/index.ts` is a one-line delegate to it, because the root join, the cached rows, the terminal reuse ladder and the resolved launch mode are all already the panel's
- **Folder** - `cwd` joined onto `status.root_dir` exactly as `_currentFolder()` does in `src/core/panel.ts`; empty root → no launch
- **Listing** - `GET providers/<id>/sessions`; a row with `project_path === folder` means the folder has a conversation
- **Resume** - row found → `TerminalManager.findForSession(row.session_id)`; a terminal already running it is activated and focused, no launch
- **New** - no row → new session; id minted client-side with `UUID.uuid4()` when `descriptor.mintsNewSessionId`, otherwise the CLI mints it
- **Mode** - `resolveLaunchMode(descriptor.launchModes, settings)` with no forced mode, the `+` button's default
- **Argv** - one request to the new route below; the server owns `cli_path`, mode flag, resume verb and pin bookkeeping
- **Terminal** - `commands.execute('basic-terminal:launch', { argv, cwd })`; the sibling extension exec's argv shell-less behind its own init waiter and resolves to the terminal widget
- **Launcher tab** - the command returns that widget, so the Launcher closes and the terminal takes its place, as notebook tiles do

## Launch argv route

The existing `POST providers/<id>/launch` spawns the terminal itself and is untouched. The tile needs argv only, because `basic-terminal:launch` does the spawn.

- `POST providers/<id>/launch-argv` body `{project_path, encoded_path?, session_id?, new_session_id?, mode?}` → `{argv: [...]}`
- Same validation as `LaunchHandler`: directory exists, `new_session_id` exclusive with `session_id`, `mode` declared on the descriptor → 400 `mode_unsupported`
- Same side effect: a new session clears the project pin (`state.clear_pin`)
- Same provider hook: `store.launch_argv(cli_path, ...)`, so per-provider verbs (`claude --resume`, `codex resume`, `gemini --session-file`, `kimi -S`) need no change
- 503 `cli_not_found` when `shutil.which(cli_binary)` is empty; the tile shows one Notification naming the binary

## Section placement and order

- **Category order** - Launcher ranks Notebook 0, Console 20, Other 100; unranked categories land after Other alphabetically
- **`categoryRank`** - one value on every tile, between 20 and 100 → section sits between Console and Other; the smallest rank across a category's items wins
- **Version floor** - `categoryRank` exists from JupyterLab 4.6.0; `@jupyterlab/launcher` pinned `^4.6.0`, runtime here is 4.6.3
- **Tile order** - `rank` = provider index in `src/providers/index.ts`, matching the sidebar
- **Section icon** - none set by this extension; `jupyterlab_launcher_sections_extension` can decorate the header by exact title match if wanted

## Dependencies

- **`@jupyterlab/launcher ^4.6.0`** - npm, for `ILauncher` and `categoryRank`
- **`jupyterlab-basic-terminal-extension >=1.0.7`** - pip runtime dependency in `pyproject.toml`; it ships its own labextension, and the server half is mandatory
- **No npm coupling to the sibling** - it exports no token; the contract is the command id `basic-terminal:launch` and its args `{argv: string[], cwd?: string}`, checked with `hasCommand` at click time

## Edge cases

- **No roster yet** - `status === null` → no launch, one Notification "Waiting for the server root"; never joins a path onto an empty root
- **Non-default drive** - `cwd` with a drive prefix → no launch, one Notification naming the reason
- **Sibling command absent** - `hasCommand('basic-terminal:launch')` false → no launch, one Notification naming `jupyterlab_basic_terminal_extension`
- **Binary vanished after docking** - the argv route answers 503 → one Notification naming the binary; the next roster undocks panel and tile
- **Double click** - the Launcher's own `pending` flag ignores clicks while one execute is in flight
- **Pre-roster tile** - present under the null-roster rule like the panel, so a restored layout finds it; the click guard above covers the window

## Decisions

Four choices the user locked on 2026-08-27, with the alternative declined.

- **Resume trigger** - a conversation exists for the folder (listing row), not a live process; a live-process check would be Codex-only today (`hasLiveProcess`) and needs a probe across every terminal
- **Launch path** - `basic-terminal:launch` over the existing launch route; costs a pip dependency and the argv route, buys one shared terminal spawner across the user's extensions
- **Placement** - between Console and Other over default placement; costs the `^4.6.0` floor
- **After click** - Launcher tab replaced by the terminal over keeping the Launcher open

## Tests

- **Jest `src/__tests__/launcher.spec.ts`** - add/dispose on toggle, ranks, and every click branch: new, resume, terminal reuse, no root, non-default drive, sibling absent, 503
- **pytest** - the argv route: validation, pin clearing, per-provider argv parity with `launch`
- **Galata `ui-tests/tests/launcher-tiles.spec.ts`** - tiles per enabled provider, removal on disable, no section with all disabled, section order, screenshots
