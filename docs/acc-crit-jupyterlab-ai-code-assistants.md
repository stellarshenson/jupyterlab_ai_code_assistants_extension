# Acceptance Criteria - AI Code Assistants

One extension replacing `jupyterlab_claude_code_extension`, `jupyterlab_codex_extension` and `jupyterlab_kimi_code_extension`. A provider registry holds one descriptor per assistant; the shared core renders a panel, serves routes and handles sessions for every registered provider, and each provider module supplies only what differs. Adding or removing an assistant means adding or deleting one TypeScript module and one Python module, with no core edit.

## Contents

- [Provider Core](#provider-core)
- [Settings](#settings)
- [Panel](#panel)
- [Sessions](#sessions)
- [Colour](#colour)
- [Retirement and Migration](#retirement-and-migration)
- [Claude Provider](#claude-provider)
- [Codex Provider](#codex-provider)
- [Kimi Provider](#kimi-provider)
- [Gemini Provider](#gemini-provider)
- [Testing](#testing)
- [API](#api)

## Provider Core

Registry of assistant descriptors, one panel widget per enabled provider, all sharing one session core. A provider is defined once and consumed by both the frontend registry and the server registry.

Availability is two-dimensional - the user's setting and whether the CLI binary exists on PATH. Both must hold for a panel to appear.

| Functionality   | Enabled, CLI present | Enabled, CLI missing | Disabled in settings    |
| --------------- | -------------------- | -------------------- | ----------------------- |
| Panel widget    | docked               | not docked           | not docked              |
| Commands        | registered           | not registered       | not registered          |
| Session polling | running              | stopped              | stopped                 |
| Settings entry  | shown, on            | shown, on, warned    | shown, off              |
| Server routes   | serve                | 503 `cli_not_found`  | 404 `provider_disabled` |

- [x] **Descriptor** - a provider is one descriptor carrying id, display label, icon, CLI binary name, session store path, and a capability set
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - descriptor pair (TS+PY) bound by tests/test_descriptor_parity.py (2 passed); store path lives in the store adapter registered with the descriptor - the pair is the unit of definition
- [x] **Registry: frontend** - a `providers/index.ts` barrel is the single registration point; the core iterates the registry and never names an assistant
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Registry: server** - `core/registry.py` discovers provider modules and exposes them by id; `core/routes.py` dispatches on the id and never names an assistant
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Capability flags** - divergent behaviour is expressed as descriptor flags (`forkStrategy`, `colourSource`, `launchModes`, `hasRemoteControl`), never as branches on provider id inside core code
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Add a provider** - adding an assistant requires exactly one new TS module, one new Python module and one barrel line; no core file is edited
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Remove a provider** - deleting both modules and the barrel line removes the assistant completely, leaving no dangling settings key, command, widget id or route
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Core has no assistant names** - grep for `claude`, `codex`, `kimi` in `src/core/` and `*/core/*.py` returns no matches outside comments
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **CLI detection** - each provider's binary is probed at status time; absence disables that provider only, never the extension
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Command namespace** - commands are namespaced per provider as `ai-code-assistants:<provider-id>:<action>`, so two providers never collide
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Widget id** - each panel gets a unique widget id `jupyterlab-ai-code-assistants-<provider-id>` for layout restore
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Layout restore** - each enabled provider's panel registers with `ILayoutRestorer` and its open/closed state survives a reload independently
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Independent failure** - one provider throwing during activation, status probe or poll leaves the others working
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: no provider available** - every assistant disabled or missing its CLI leaves the extension activated with zero panels and no error dialog
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: unknown provider id in settings** - a stale id in saved settings is ignored with a console warning, never a hard failure
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: duplicate provider id** - two descriptors sharing an id fail loudly at registration time, not silently at render time
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: CLI appears after start** - a binary installed while JupyterLab runs enables its panel on the next status refresh, without a reload
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7

## Settings

One settings section for all assistants, replacing the three separate sections. Per-provider enable toggles default to on. Toggling applies live.

- [x] **Single section** - JupyterLab settings show one "AI Code Assistants" entry, not one per assistant
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Enable toggle** - every registered provider has a boolean `providers.<id>.enabled` key, defaulting to `true`
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Default all on** - a fresh install with no saved settings enables every provider whose CLI is present
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Missing key reads as on** - an absent enable key means enabled; only an explicit `false` disables
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Schema generated from registry** - the settings schema lists exactly the registered providers, so adding one adds its toggle without a hand edit
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - generator fixed for Node ESM (globs lib/providers/*.js), wired into build and build:prod, output prettier-normalised; schema now emitted from live descriptors
- [x] **Live enable** - switching a provider on docks its panel, registers its commands and starts its polling without a reload
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Live disable** - switching a provider off disposes its widget, stops its polling, removes its commands and clears its terminal tab tints without a reload
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Shared settings** - `presentationMode`, `recentLimit` and `sidebar` apply to every provider panel from one key each
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Per-provider settings** - assistant-specific keys live under `providers.<id>.*` and appear only for registered providers
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Unsafe mode per provider, own name** - every provider exposes its assistant's skip-permissions equivalent under `providers.<id>.*` using the assistant's own terminology (Claude `dangerouslySkipPermissions`, Codex `dangerouslyBypassApprovalsAndSandbox`, Kimi `yoloMode`, Gemini `yoloMode` + `approvalMode`), each off by default, each with matching context-menu launch variants
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Sidebar move** - changing `sidebar` re-docks every enabled panel to the chosen side
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: disable while terminal open** - disabling a provider leaves its running terminals alive and untouched, only the panel and tint go
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: disable the last enabled provider** - permitted; leaves zero panels and no error
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: rapid toggle** - toggling a provider off and on repeatedly leaves exactly one docked widget and one set of registered commands, no duplicates
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: settings load failure** - a settings registry error falls back to all-providers-enabled defaults with a console warning
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7

## Panel

Each enabled provider renders its own side panel. Layout and interaction are shared; only labels, icons and capability-gated menu items differ.

- [x] **Three sections** - Favorites, Recent and All projects, each scrolling independently
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Distinct identity** - each panel carries its assistant's icon and title so two docked panels are told apart at a glance
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Activity column** - each row shows last activity as `now`, `5m ago`, `2h ago`, `3d ago` in an aligned column
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Activity emphasis** - rows active within the last minute take the theme brand colour; rows idle over a week dim
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Favourites** - a row is starred and unstarred from the context menu, persisting per provider
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Search** - a funnel button toggles a fuzzy filter across projects, with a clear button
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Presentation mode** - rows label by session name or by path relative to the JupyterLab root, per the shared setting
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Hover tooltip** - shows project path, last activity, message count, conversation count, git branch and session id
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Refresh** - a refresh button and a per-provider refresh command reload that panel only
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Capability-gated menu** - a context-menu item whose capability the provider lacks is absent, not shown-and-disabled
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: empty history** - a provider with no sessions shows an empty-state message, not a blank panel
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: server unreachable** - a failed poll shows an inline error in that panel and retries, leaving other panels unaffected
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7

## Sessions

Resume, branch, switch, delete and clean up, served by one core against per-provider session stores.

- [x] **One-click resume** - clicking a row opens that conversation in a terminal
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Terminal reuse** - a terminal already running that exact conversation is focused, never duplicated
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Conversation switcher** - a submenu lists a project's other conversations with short id and last activity; picking one makes it the row's current conversation
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Manage sessions popup** - a searchable scrollable table over all of a project's conversations, current one pinned at top
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Multi-select delete** - conversations are selected by checkbox and deleted together, honouring JupyterLab's move-to-trash setting
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Open branched conversation** - any conversation opens directly in its own terminal, so branches run side by side
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Branch session** - forks the current conversation into a new one in its own terminal, by the provider's `forkStrategy`
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Copy session id** - copies the row's current conversation id to the clipboard
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Remove project** - drops a project's history after a confirmation naming the project, honouring the trash setting
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Clean up parallel sessions** - removes a project's extra conversations keeping only the current, showing the count and confirming first
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Store isolation** - a provider only ever reads and writes its own session store; a bug in one cannot touch another's history
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: conversation removed before click** - resume returns 404, the panel shows an error and refreshes
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: switch to already-current** - no-op success
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: same project in two providers** - a folder used by two assistants shows one row in each panel, with independent favourite and current-conversation state
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: concurrent delete** - deleting a conversation another panel has open reports the failure and refreshes, never leaving a phantom row
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7

## Colour

Terminal tab tint per conversation. The `colourSource` capability flag names where the default tint comes from; the extension keeps its own per-provider colour store so users can set colours on any assistant, including ones whose CLI has no colour concept.

| Functionality        | native (Claude)          | derived (Kimi)              | none (Codex, Gemini)      |
| -------------------- | ------------------------ | --------------------------- | ------------------------- |
| Default tint         | assistant's own colour   | hash of session id          | no tint                   |
| User sets tab colour | via assistant (`/color`) | write-back store overrides  | write-back store supplies |
| Branch inherits      | always                   | always (overrides new hash) | always                    |

- [x] **Colour source flag** - `colourSource` on the descriptor is `native`, `derived` or `none` and decides only the default tint
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Tab colour write-back** - for providers without native colour, changing the colour on a terminal tab registers as that conversation's colour in the extension's store, exactly as if the assistant itself had changed colour
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Write-back persistence** - user-set colours persist per provider keyed by session id and survive a JupyterLab reload
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Override precedence** - a user-set colour beats the derived hash (Kimi) and the empty default (Codex, Gemini); native colour (Claude) remains owned by the assistant
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Branch colour inheritance** - a branched conversation always inherits the parent's effective colour at fork time, for every provider
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: branch of a branch** - inherits the effective colour of its immediate parent, including any user-set override
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: colour of a deleted conversation** - deleting a conversation drops its stored colour entry, leaving no orphan keys
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7

## Retirement and Migration

This extension retires the three standalone extensions. A user upgrading must not end up with duplicate panels or lost state.

- [x] **Feature parity** - every feature listed in the three standalone READMEs is present here or explicitly recorded as dropped, with a reason
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed: closed - docs/feature-parity.md audits all 41 README features with file:line evidence: 42 present after the DEF-9 fix, 2 dropped with recorded reasons (statusline installer CLIs), 0 missing
- [x] **Conflict detection** - a standalone extension still installed alongside this one is detected at activation
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Conflict resolution** - a detected standalone extension suppresses this extension's panel for that assistant, so the user never sees two panels for one assistant
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Conflict notice** - the suppressed case tells the user which package to uninstall, once, not on every refresh
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Settings migration** - saved settings from each standalone plugin id are read once and mapped onto the matching `providers.<id>.*` keys
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Favourites migration** - favourites recorded by a standalone extension carry over to the matching provider
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Session stores untouched** - migration reads the assistants' own history directories in place and never moves, copies or rewrites them
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Migration is idempotent** - running twice changes nothing the second time and never overwrites a value the user has since set here
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [ ] **Metapackage updated** - `stellars_jupyterlab_extensions` depends on this extension and drops the three standalone ones
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 deferred until this package is published - the metapackage cannot depend on an unpublished package; execute at release
- [ ] **Standalone repos marked** - each retired extension's README states it is superseded, naming this package
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 deferred until release alongside the metapackage repoint - marking READMEs superseded before the replacement is installable would strand users
- [x] **Edge: nothing to migrate** - a fresh install with no prior extension runs migration as a silent no-op
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: partial prior install** - one standalone extension present and two absent migrates the one and skips the rest without error
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: corrupt prior settings** - unreadable saved settings are skipped with a console warning, defaults apply, migration continues for the others
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7

## Claude Provider

Ported from `jupyterlab_claude_code_extension` v1.2.73, the architectural base. Capabilities - native fork, user-set colour, remote control, background agents.

- [x] **Native fork** - branching uses `claude --fork-session`; the chosen name is stamped and the fork becomes the row's current conversation
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Remote control indicator** - a green dot marks sessions actively under remote control, not merely a running terminal
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Background agents** - a conversation held by a running background agent shows a `bg` chip and is attached to, never resumed
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Launch verb resolved server-side** - the server decides resume-versus-attach at launch time, so a stale panel cannot pick the wrong one
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Coloured tabs from `/color`** - the terminal tab tint comes from the session's own colour, via `jupyterlab_colourful_tab_extension`
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Skip-permissions mode** - an opt-in setting and matching menu entries launch with `--dangerously-skip-permissions`, off by default
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7

## Codex Provider

Ported from `jupyterlab_codex_extension` v0.6.12. Capabilities - no colour source, approval-bypass launch mode.

- [x] **Live activity indicator** - shows which projects have a Codex process running right now
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Approval bypass** - an opt-in setting and matching menu entry launch with `--dangerously-bypass-approvals-and-sandbox`, off by default
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **No native colour** - the provider declares `colourSource: none`; default is no tint, user-set colours apply via the write-back store per the Colour section
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 reworded - write-back store makes user-set colour possible on colour-less assistants
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7

## Kimi Provider

Ported from `jupyterlab_kimi_code_extension` v0.7.8. Capabilities - server-side fork, session-id-derived colour, YOLO launch mode.

- [x] **Resume by session id** - conversations open with `kimi -S <session-id>`
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Server-side fork** - Kimi has no fork flag, so branching copies the session directory with a fresh id and title, then opens it
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **YOLO mode** - every launch action has a YOLO variant using `--yolo`; a setting makes it the default, off by default
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Deterministic tab colour** - the default tint derives from the session id, stable per conversation, since Kimi has no colour command; a user-set colour and branch inheritance override it per the Colour section
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 reworded - derived hash is the default only, write-back and inheritance take precedence
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7

## Gemini Provider

New provider - no standalone extension to port from. Gemini CLI 0.54.4 (`@google/gemini-cli`, installed via `lab-utils install-ai-assistant/google-gemini-cli`). Store: `~/.gemini/projects.json` registry maps project root to a short id; chats live under `~/.gemini/tmp/<shortId>/chats/` as JSON files. Capabilities - no fork flag (server-side fork), no colour command (`colourSource: none`), YOLO and approval-mode launch modes.

- [x] **Store scan** - projects come from the `projects.json` registry and sessions from `tmp/<shortId>/chats/*.json`, read in place, never via the auth-gated CLI listing
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Resume** - clicking a row opens the conversation via its chat file (`--session-file <path>`), never by the positional index of `--resume`, which is ordering-dependent and stale the moment another session lands
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **New session** - a new conversation launches with `--session-id <uuid>` minted by the extension, so the row can be tracked from first poll
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Server-side fork** - Gemini has no fork flag, so branching copies the chat file with a fresh id, Kimi-style, and opens it
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **YOLO mode** - launch actions offer a `--yolo` variant; an `approvalMode` setting maps to `--approval-mode default|auto_edit|yolo|plan`, defaulting to `default`
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: unauthenticated CLI** - a gemini binary without auth configured still lists sessions in the panel (disk scan); the auth error surfaces only inside the launched terminal
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: registry migration** - Gemini versions that migrate legacy hash-named project dirs to registry short ids must not produce duplicate rows during migration
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7

## Testing

Three tiers - pytest for the server core and each provider module, Jest for frontend units, Galata for the UI. Galata is the only tier that fails when the packaging is wrong rather than the code, so the provider registry and the live enable/disable path are asserted there.

| Functionality      | pytest             | Jest                 | Galata                       |
| ------------------ | ------------------ | -------------------- | ---------------------------- |
| Registry discovery | modules resolve    | barrel exports       | panel count matches enabled  |
| Enable/disable     | route gating       | descriptor filtering | panel appears and disappears |
| CLI absent         | 503 on missing bin | -                    | no panel for absent binary   |
| Session operations | store logic        | response shaping     | resume opens a real terminal |
| Migration          | idempotent mapping | -                    | -                            |

- [x] **Port knob** - `JLAB_TEST_PORT` threads through `playwright.config.js` baseURL, the webServer command and `jupyter_server_test_config.py`, so the suite runs where 8888 is taken
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Empty port value** - the server config reads the port with `or "8888"`, not a `get()` default, so an exported-but-empty variable does not raise
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **No server adoption** - `reuseExistingServer` is `false` unconditionally; the suite drives terminals and session stores and must never adopt a developer's live lab
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Serialised specs** - `workers: 1` and `fullyParallel: false`, since all specs share one server and its per-provider session stores
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Exit status preserved** - test runs redirect rather than pipe through `tee`, so a suite whose server never started reports failure
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Isolated session stores** - Galata points every provider's session store at a scratch directory; no test reads or writes the developer's real assistant history
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Isolated runtime dir** - `JUPYTER_RUNTIME_DIR` points at a private folder and inherited hub tokens are deleted from the spawn environment
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Scratch swept at both ends** - scratch stores are cleared by the webServer command before start and again in `globalTeardown`, since `globalSetup` runs after the server
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Activation message** - `src/index.ts` logs `JupyterLab extension jupyterlab_ai_code_assistants_extension is activated!` verbatim, matching the template UI test
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Galata: panel per enabled provider** - with all providers enabled and their CLIs stubbed present, the shell shows exactly one panel per provider, each with its own title
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Galata: live disable** - toggling a provider off removes its panel within the test's timeout, leaving the others docked
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Galata: live enable** - toggling a provider back on re-docks exactly one panel, not two
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Galata: CLI absent** - a provider whose stub binary is removed from PATH renders no panel and raises no error dialog
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Galata: resume opens a terminal** - clicking a seeded session row opens a terminal, proving the launch route end to end
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Galata: Claude regression vs original** - the original `jupyterlab_claude_code_extension` Galata suite, ported to the new panel's selectors, passes against the Claude provider as feature-parity evidence
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Galata: venv isolation** - the Galata server runs from a dedicated venv containing only this extension; the standalone extensions are absent from it and the developer's live environment is never installed into, uninstalled from, or modified
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Adversarial review gate** - `/devils-advocate:adversarial-review` runs clean with the architect and bug-hunter adversaries before release
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-08 closed: clean verdicts from all three adversaries: architect SHIP (round 2), bug-hunter SHIP (round 3), ux-designer SHIP (round 4); 4 fix batches, DEF-10..29 registered and closed; evidence logs/adversarial/
- [x] **pytest: registry** - every provider module in `providers/` is discovered, exposes a unique id and satisfies the descriptor contract
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **pytest: route gating** - a disabled provider's routes return 404 `provider_disabled` and an absent CLI returns 503 `cli_not_found`
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **pytest: store isolation** - a provider handler given another provider's encoded path refuses rather than reading across stores
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **pytest: migration idempotence** - running migration twice against the same fixture produces an identical result and no second write
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Jest: no assistant names in core** - a source-reading test asserts `src/core/` contains no provider id outside comments
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Suite can fail** - each tier is mutation-checked once: break the registry, the route gating and the toggle in turn, and confirm the guarding test goes red
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - mutation check performed by the unit-test agent: duplicate-id guard, route disabled-gate, enable toggle, barrel entry and core-neutrality each broken in turn, each guarding test went red, restoration verified byte-identical by diff (wf_a4376a8b-03e tests:unit result)
- [x] **No both-ends mocking** - no Galata spec mocks both the panel and the server for the same assertion; the tier exists to catch packaging and integration breaks
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: spawn error listener** - any test spawning a shipped console script wires `child.on('error')`, so a missing binary reports as not-on-PATH rather than killing the worker
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7
- [x] **Edge: snapshot updates** - visual baselines update through the `please update snapshots` PR comment workflow, never by hand-committed images
  - log: 2026-08-07 criterion added (v0.1.0)
  - log: 2026-08-07 closed - post-fix conformance review (wf_a4376a8b-03e) verdict with file:line evidence; make install + 125 pytest + 59 Jest + 16/16 Galata green at v0.1.7

## API

All routes are namespaced by provider id under the extension base `jupyterlab-ai-code-assistants-extension`.

- `GET status` -> `{root_dir, providers: [{id, label, enabled, cli_path, available}]}`
- `GET providers/<id>/sessions` -> `{sessions: [...]}`; 404 `provider_unknown`, 404 `provider_disabled`, 503 `cli_not_found`
- `GET providers/<id>/branches?encoded_path=...` -> `{current, total, branches: [...]}`
- `POST providers/<id>/switch` body `{encoded_path, session_id}` -> `{requested, current}`; 404 `branch_not_found`, 400 invalid input
- `POST providers/<id>/favourite` body `{project_path, favourite}` -> `{favourites: [...]}`
- `POST providers/<id>/launch` body `{project_path, session_id?, mode?}` -> `{terminal_name}`; 404 `session_not_found`, 400 `mode_unsupported`
- `POST providers/<id>/branch` body `{encoded_path, session_id, name?}` -> `{session_id}`; 400 `fork_unsupported`
- `DELETE providers/<id>/sessions` body `{encoded_path, session_ids?}` -> `{removed_count}`
- `POST migrate` -> `{migrated: [{provider_id, keys, favourites}]}`; idempotent, safe to call repeatedly
