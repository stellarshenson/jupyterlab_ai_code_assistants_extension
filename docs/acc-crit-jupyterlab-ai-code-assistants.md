# Acceptance Criteria - AI Code Assistants

One extension replacing `jupyterlab_claude_code_extension`, `jupyterlab_codex_extension` and `jupyterlab_kimi_code_extension`. A provider registry holds one descriptor per assistant; the shared core renders a panel, serves routes and handles sessions for every registered provider, and each provider module supplies only what differs. Adding or removing an assistant means adding or deleting one TypeScript module and one Python module, with no core edit.

Every criterion was added 2026-08-07 at v0.1.0 unless one of its `log:` lines says otherwise. The criteria logged `closed - conformance review (v0.1.7)` were closed together by one post-fix review (run `wf_a4376a8b-03e`), which recorded a verdict with file:line evidence per criterion against `make install` plus 125 pytest, 59 Jest and 16/16 Galata green.

## Authors

- `@kj` Konrad Jelen

## Provider Core `PROV`

Registry of assistant descriptors, one panel widget per enabled provider, all sharing one session core. A provider is defined once and consumed by both the frontend registry and the server registry.

Availability is two-dimensional - the user's setting and whether the CLI binary exists on PATH. Both must hold for a panel to appear.

| Functionality   | Enabled, CLI present | Enabled, CLI missing | Disabled in settings    |
| --------------- | -------------------- | -------------------- | ----------------------- |
| Panel widget    | docked               | not docked           | not docked              |
| Commands        | registered           | not registered       | not registered          |
| Session polling | running              | stopped              | stopped                 |
| Settings entry  | shown, on            | shown, on, warned    | shown, off              |
| Server routes   | serve                | 503 `cli_not_found`  | 404 `provider_disabled` |

- [x] `ACC-PROV-1` **Descriptor** - a provider is one descriptor carrying id, display label, icon, CLI binary name, session store path, and a capability set
  - log: 2026-08-07T00:00:00Z @kj closed - descriptor pair (TS+PY) bound by tests/test_descriptor_parity.py (2 passed); store path lives in the store adapter registered with the descriptor - the pair is the unit of definition
- [x] `ACC-PROV-2` **Registry: frontend** - a `providers/index.ts` barrel is the single registration point; the core iterates the registry and never names an assistant
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PROV-3` **Registry: server** - `core/registry.py` discovers provider modules and exposes them by id; `core/routes.py` dispatches on the id and never names an assistant
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PROV-4` **Capability flags** - divergent behaviour is expressed as descriptor flags (`forkStrategy`, `colourSource`, `launchModes`, `hasRemoteControl`), never as branches on provider id inside core code
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PROV-5` **Add a provider** - adding an assistant requires exactly one new TS module, one new Python module and one barrel line; no core file is edited
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PROV-6` **Remove a provider** - deleting both modules and the barrel line removes the assistant completely, leaving no dangling settings key, command, widget id or route
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PROV-7` **Core has no assistant names** - grep for `claude`, `codex`, `kimi` in `src/core/` and `*/core/*.py` returns no matches outside comments
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PROV-8` **CLI detection** - each provider's binary is probed at status time; absence disables that provider only, never the extension
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PROV-9` **Command namespace** - commands are namespaced per provider as `ai-code-assistants:<provider-id>:<action>`, so two providers never collide
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PROV-10` **Widget id** - each panel gets a unique widget id `jupyterlab-ai-code-assistants-<provider-id>` for layout restore
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PROV-11` **Layout restore** - each enabled provider's panel registers with `ILayoutRestorer` and its open/closed state survives a reload independently
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
  - log: 2026-08-27T00:00:00Z @kj re-verified - was false whenever the first probe failed, because no panel existed for JupyterLab to restore; measured in the user's lab and fixed under DEF-132; the evidence is that lab measurement in the ledger - Galata DEF-132 saves no layout and does not reload (v1.0.33)
- [x] `ACC-PROV-12` **Independent failure** - one provider throwing during activation, status probe or poll leaves the others working
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PROV-13` **Edge: no provider available** - every assistant disabled or missing its CLI leaves the extension activated with zero panels and no error dialog
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
  - log: 2026-08-27T00:00:00Z @kj qualified - holds once a roster exists; with none yet every enabled assistant is docked (DEF-132) (v1.0.33)
- [x] `ACC-PROV-14` **Edge: unknown provider id in settings** - a stale id in saved settings is ignored with a console warning, never a hard failure
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PROV-15` **Edge: duplicate provider id** - two descriptors sharing an id fail loudly at registration time, not silently at render time
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PROV-16` **Edge: CLI appears after start** - a binary installed while JupyterLab runs enables its panel on the next status refresh, without a reload
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PROV-17` **Edge: status probe fails** - a failed probe warns that the last known roster stands until a later probe answers, never that the panels are gone for good, and names no cadence it cannot honour at that moment
  - log: 2026-08-19T00:00:00Z @kj added (v1.0.29)
  - log: 2026-08-19T00:00:00Z @kj closed - warning reworded (DEF-117) (v1.0.29)
  - log: 2026-08-19T00:00:00Z @kj reworded again - the cadence dropped from the text, since the same warning prints from the activation probe before any retry is armed (DEF-122) (v1.0.29)
  - log: 2026-08-27T00:00:00Z @kj qualified - a failed probe no longer removes any panel; with no roster yet every enabled assistant is docked, and the warning says so (DEF-132, v1.0.33)
- [x] `ACC-PROV-18` **Edge: browser wakes from sleep** - once activation has finished, coming back online re-probes status at once, and so does the tab becoming visible, rather than either waiting out the 60s cadence
  - log: 2026-08-19T00:00:00Z @kj added (v1.0.29)
  - log: 2026-08-19T00:00:00Z @kj closed - online and visibilitychange listeners re-probe independently; Galata DEF-117 dispatches them separately and each assertion is measured against the count taken before its own dispatch, so deleting either listener reddens the suite - verified by deleting each in turn and rebuilding (v1.0.29)
  - log: 2026-08-19T00:00:00Z @kj scoped to post-activation - a wake arriving before the listeners register is not heard, logged as DEF-122 with the reason it is not fixed (v1.0.29)
- [x] `ACC-PROV-19` **Edge: two probes in flight** - a roster is written whichever probe answers last; a failure writes nothing, so it needs no ordering against a roster
  - log: 2026-08-19T00:00:00Z @kj added - generation stamp in probeStatus (DEF-121) (v1.0.29)
  - log: 2026-08-19T00:00:00Z @kj closed - scoped to the failure path after round 3 found the success half discarded good rosters; both orderings pinned by Galata DEF-121 tests, each falsified by mutation (DEF-121) (v1.0.29)
  - log: 2026-08-27T00:00:00Z @kj reworded - a failure never writes (DEF-132); the generation stamp is deleted, one of the two DEF-121 Galata tests with it (v1.0.33)

## Settings `SETT`

One settings section for all assistants, replacing the three separate sections. Per-provider enable toggles default to on. Toggling applies live.

- [x] `ACC-SETT-20` **Single section** - JupyterLab settings show one "AI Code Assistants" entry, not one per assistant
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SETT-21` **Enable toggle** - every registered provider has a boolean `providers.<id>.enabled` key, defaulting to `true`
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SETT-22` **Default all on** - a fresh install with no saved settings enables every provider whose CLI is present
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SETT-23` **Missing key reads as on** - an absent enable key means enabled; only an explicit `false` disables
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SETT-24` **Schema generated from registry** - the settings schema lists exactly the registered providers, so adding one adds its toggle without a hand edit
  - log: 2026-08-07T00:00:00Z @kj closed - generator fixed for Node ESM (globs lib/providers/*.js), wired into build and build:prod, output prettier-normalised; schema now emitted from live descriptors
- [x] `ACC-SETT-25` **Live enable** - switching a provider on docks its panel, registers its commands and starts its polling without a reload
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SETT-26` **Live disable** - switching a provider off disposes its widget, stops its polling, removes its commands and clears its terminal tab tints without a reload
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SETT-27` **Shared settings** - `presentationMode`, `recentLimit` and `sidebar` apply to every provider panel from one key each
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SETT-28` **Per-provider settings** - assistant-specific keys live under `providers.<id>.*` and appear only for registered providers
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SETT-29` **Unsafe mode per provider, own name** - every provider exposes its assistant's skip-permissions equivalent under `providers.<id>.*` using the assistant's own terminology (Claude `dangerouslySkipPermissions`, Codex `dangerouslyBypassApprovalsAndSandbox`, Kimi `yoloMode`, Gemini `yoloMode`), exactly one approval control per provider, each off by default, each with matching context-menu launch variants
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
  - log: 2026-08-12T00:00:00Z @kj reopened - Gemini's second control (`approvalMode` enum) removed per DEF-111, one switch per provider (v1.0.21)
  - log: 2026-08-12T00:00:00Z @kj closed: closed - Gemini back to one switch (yoloMode), enum deleted per DEF-111 (v1.0.22)
- [x] `ACC-SETT-30` **Sidebar move** - changing `sidebar` re-docks every enabled panel to the chosen side
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SETT-31` **Edge: disable while terminal open** - disabling a provider leaves its running terminals alive and untouched, only the panel and tint go
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SETT-32` **Edge: disable the last enabled provider** - permitted; leaves zero panels and no error
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SETT-33` **Edge: rapid toggle** - toggling a provider off and on repeatedly leaves exactly one docked widget and one set of registered commands, no duplicates
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SETT-34` **Edge: settings load failure** - a settings registry error falls back to all-providers-enabled defaults with a console warning
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)

## Panel `PANE`

Each enabled provider renders its own side panel. Layout and interaction are shared; only labels, icons and capability-gated menu items differ.

- [x] `ACC-PANE-35` **Three sections** - Favorites, Recent and All projects, each scrolling independently
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PANE-36` **Distinct identity** - each panel carries its assistant's icon and title so two docked panels are told apart at a glance
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PANE-37` **Activity column** - each row shows last activity as `now`, `5m ago`, `2h ago`, `3d ago` in an aligned column
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PANE-38` **Activity emphasis** - rows active within the last minute take the theme brand colour; rows idle over a week dim
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PANE-39` **Favourites** - a row is starred and unstarred from the context menu, persisting per provider
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PANE-40` **Search** - a funnel button toggles a fuzzy filter across projects, with a clear button
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PANE-41` **Presentation mode** - rows label by session name or by path relative to the JupyterLab root, per the shared setting
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PANE-42` **Hover tooltip** - shows project path, last activity, message count, conversation count, git branch and session id
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PANE-43` **Refresh** - a refresh button and a per-provider refresh command reload that panel only
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PANE-44` **Capability-gated menu** - a context-menu item whose capability the provider lacks is absent, not shown-and-disabled
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PANE-45` **Edge: empty history** - a provider with no sessions shows an empty-state message, not a blank panel
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PANE-46` **Edge: server unreachable** - a failed poll shows an inline error in that panel and retries, leaving other panels unaffected
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-PANE-47` **Header button glyph** - the header new-session button wears the + glyph in every launch-mode state, armed or not, never the mode's shield (DEF-112)
  - log: 2026-08-12T00:00:00Z @kj criterion added (v1.0.21)
  - log: 2026-08-12T00:00:00Z @kj closed: closed - addIcon unconditional, _repaintNewIcon deleted; Galata asserts + survives arming (v1.0.22)
- [x] `ACC-PANE-48` **Header menu when unarmed** - with no launch mode on, the header + drops a menu reading exactly `New session` and `New session (<mode label>)` - no provider name in either entry
  - log: 2026-08-12T00:00:00Z @kj criterion added (v1.0.21)
  - log: 2026-08-12T00:00:00Z @kj closed - pre-existing variant-menu behaviour, unchanged by DEF-112 (v1.0.22)
  - log: 2026-08-13T00:00:00Z @kj reworded per Star Colonel - exact entry texts, vendor name banned; label change landed with DEF-114 (v1.0.25)
- [x] `ACC-PANE-49` **Header direct launch when armed** - with a launch mode on, the header + starts the session on click with NO menu - a two-entry menu would offer the armed mode twice - and the tooltip names the mode
  - log: 2026-08-12T00:00:00Z @kj criterion added (v1.0.21)
  - log: 2026-08-12T00:00:00Z @kj closed: closed - title suffix asserted in unit + Galata tests (v1.0.22)
  - log: 2026-08-13T00:00:00Z @kj reworded per Star Colonel - "no menu, just + starts new session"; behaviour and tests unchanged (v1.0.23)
  - log: 2026-08-14T00:00:00Z @kj rendered proof added (DEF-115) - Galata clicks the armed + and asserts no menu is in the DOM and a terminal opens; it was ticked on unit evidence alone before (v1.0.27)
- [x] `ACC-PANE-50` **Header button title** - the + tooltip is the static `New session in current folder` - no provider name, no interpolated folder path (deep trees make it unreadable) - plus the armed mode in parentheses when one is on
  - log: 2026-08-13T00:00:00Z @kj criterion added and closed - unit (DEF-36/38) and Galata assertions updated to the new text (v1.0.23)
  - log: 2026-08-13T00:00:00Z @kj corrected per Star Colonel - the folder path is not shown at all; landed with DEF-114 (v1.0.25)
- [x] `ACC-PANE-51` **Shield on menu entries only** - the shield glyph marks skip-permissions menu entries (header menu and row context menu), never the header button itself
  - log: 2026-08-12T00:00:00Z @kj criterion added (v1.0.21)
  - log: 2026-08-12T00:00:00Z @kj closed: closed - Galata proves the shield on Resume (Skip Permissions) by path data (v1.0.22)
- [x] `ACC-PANE-52` **Edge: live mode toggle** - flipping a mode setting updates the header button's tooltip and click behaviour without a reload; the glyph never changes
  - log: 2026-08-12T00:00:00Z @kj criterion added (v1.0.21)
  - log: 2026-08-12T00:00:00Z @kj closed: closed - setModes re-titles only; glyph constant, Galata-verified (v1.0.22)

## Sessions `SESS`

Resume, branch, switch, delete and clean up, served by one core against per-provider session stores.

- [x] `ACC-SESS-53` **One-click resume** - clicking a row opens that conversation in a terminal
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SESS-54` **Terminal reuse** - a terminal already running that exact conversation is focused, never duplicated
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SESS-55` **Conversation switcher** - a submenu lists a project's other conversations with short id and last activity; picking one makes it the row's current conversation
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SESS-56` **Manage sessions popup** - a searchable scrollable table over all of a project's conversations, current one pinned at top
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SESS-57` **Multi-select delete** - conversations are selected by checkbox and deleted together, honouring JupyterLab's move-to-trash setting
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SESS-58` **Open branched conversation** - any conversation opens directly in its own terminal, so branches run side by side
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SESS-59` **Branch session** - forks the current conversation into a new one in its own terminal, by the provider's `forkStrategy`
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SESS-60` **Copy session id** - copies the row's current conversation id to the clipboard
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SESS-61` **Remove project** - drops a project's history after a confirmation naming the project, honouring the trash setting
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SESS-62` **Clean up parallel sessions** - removes a project's extra conversations keeping only the current, showing the count and confirming first
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SESS-63` **Store isolation** - a provider only ever reads and writes its own session store; a bug in one cannot touch another's history
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SESS-64` **Edge: conversation removed before click** - resume returns 404, the panel shows an error and refreshes
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SESS-65` **Edge: switch to already-current** - no-op success
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SESS-66` **Edge: same project in two providers** - a folder used by two assistants shows one row in each panel, with independent favourite and current-conversation state
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SESS-67` **Edge: concurrent delete** - deleting a conversation another panel has open reports the failure and refreshes, never leaving a phantom row
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-SESS-68` **Edge: unusable field in an assistant's session record** - a value the assistant wrote that the panel cannot use - an ISO string where a number is compared, a pid outside the OS range - costs its own row that field and nothing else; the listing still answers for every project
  - log: 2026-08-26T00:00:00Z @kj added
  - log: 2026-08-26T00:00:00Z @kj closed: closed - DEF-126: pid_alive catches OverflowError so an out-of-range pid reads dead; pinned by test_an_out_of_range_pid_costs_a_row_a_field_not_the_whole_listing, mutation-verified (v1.0.30 tree)

## Colour `COLO`

Terminal tab tint per conversation. The `colourSource` capability flag names where the default tint comes from; the extension keeps its own per-provider colour store so users can set colours on any assistant, including ones whose CLI has no colour concept.

| Functionality        | native (Claude)            | derived (Kimi)              | none (Codex, Gemini)      |
| -------------------- | -------------------------- | --------------------------- | ------------------------- |
| Default tint         | assistant's own colour     | hash of session id          | no tint                   |
| User sets tab colour | write-back store overrides | write-back store overrides  | write-back store supplies |
| Branch inherits      | stored colour only         | always (overrides new hash) | always                    |

- [x] `ACC-COLO-69` **Colour source flag** - `colourSource` on the descriptor is `native`, `derived` or `none` and decides only the default tint
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-COLO-70` **Tab colour write-back** - for EVERY provider, changing the colour on a terminal tab registers as that conversation's colour in the extension's store, exactly as if the assistant itself had changed colour
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
  - log: 2026-08-09T00:00:00Z @kj widened - was "for providers without native colour"; a hand-set tab colour now registers for native providers too (v1.0.0)
- [x] `ACC-COLO-71` **Write-back persistence** - user-set colours persist per provider keyed by session id and survive a JupyterLab reload
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-COLO-72` **Override precedence** - a user-set colour beats every default: the derived hash (Kimi), the empty default (Codex, Gemini) AND the assistant's own colour (Claude's `/color`). Releasing the override hands the conversation back to its default
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
  - log: 2026-08-09T00:00:00Z @kj widened - was "native colour (Claude) remains owned by the assistant"; the tab is the control surface for every assistant, so the last preference the user expressed wins and is remembered (v1.0.0)
- [x] `ACC-COLO-73` **Colour release affordance** - a "Reset Tab Colour" item in the row's context menu drops the stored override and re-tints from the default at once; it is shown only while a HAND-SET override exists and tab colouring is on. It covers every conversation of that project whose branch list arrived, never fewer than the row's own conversation, names its count, and drops them in a single request so a release is never half applied. The companion extension's own Clear cannot serve as the release - it strips the tab's classes but not the stored colour, which the next tab re-render puts back
  - log: 2026-08-09T00:00:00Z @kj criterion added - adversarial round 1 (ux CRITICAL, bug-hunter MAJOR, architect MINOR): without it a hand-set colour was a one-way door and `/color` never showed again (v1.0.0)
  - log: 2026-08-09T00:00:00Z @kj closed - Galata drives the menu item itself: hidden with no override, visible with one, and clicking it empties the store and restores the assistant's colour (19/19)
  - log: 2026-08-09T00:00:00Z @kj widened - adversarial round 2, all three adversaries: the item covered only the row's CURRENT conversation, so a colour set on a terminal opened via Open Branched Conversation was unreachable; it now targets every conversation of the row that carries an override, and is absent while tab colouring is off (v1.0.0)
  - log: 2026-08-09T00:00:00Z @kj narrowed - adversarial round 3 (architect MAJOR): the item keyed on any stored colour, but forks write into the same store, so one click un-inherited every branch of a derived provider; it now offers hand-set colours only, carries its count and releases in one DELETE (v1.0.0)
  - log: 2026-08-09T00:00:00Z @kj counted at one target too - the single target may be a branch whose tab is not open; a row whose branch list could not be fetched offers nothing rather than a scope it cannot state (v1.0.0)
  - log: 2026-08-09T00:00:00Z @kj corrected - adversarial round 5 (architect MAJOR, ux MAJOR): hiding the item when the branch list had not arrived removed the only way out of a hand-set colour, and ux measured the branch fetch at 318-334ms against a 250ms budget on the one provider that spawns a CLI for it; the scope now narrows to the row's own conversation, which the count states exactly, and the budget is 1.5s to bound a hang rather than clip honest work
  - log: 2026-08-09T00:00:00Z @kj menu budget 1500ms -> 800ms with the losing branch fetch kept per project - ux round 6 MAJOR: a right-click silent past a second reads as lost, and the retry supersedes the first open and restarts the wait; keeping the fetch means losing the race costs one degraded menu rather than the branch submenus for good (v1.0.0)
  - log: 2026-08-09T00:00:00Z @kj branch-cache fallback gated on the row having other conversations - architect, bug-hunter and ux all traced the same defect: a cleaned-up project served its old listing for good, since 'no branches' and 'fetch did not arrive' were the same value; the cache is also cleared when a conversation is deleted (v1.0.0)
- [x] `ACC-COLO-74` **Colour capture safety** - a hand-set colour is written against the OBSERVED conversation only, never one guessed from a cwd, and the tab is left untouched until the store is CONFIRMED to hold the colour - painting it makes the companion extension release its own record, so an optimistic cache entry does not count as held. Caveat: a conversation whose id cannot yet be read from its process - a brand-new Codex or Kimi launch, which carries no id on its argv - is not captured at all, and reopening it from the panel opens a NEW terminal, so the colour has to be set again there
  - log: 2026-08-09T00:00:00Z @kj criterion added - adversarial round 1, raised independently by all three adversaries (v1.0.0)
  - log: 2026-08-09T00:00:00Z @kj closed - write-back keys on `info.session_id`; `ColourStore.set` answers whether the write landed and rolls the cache back when it did not
  - log: 2026-08-09T00:00:00Z @kj extended - adversarial round 2 (bug-hunter): the pass now strips THIS extension's own tint before bailing, since Lumino rebuilds the tab classes from title.className and a stale tint would otherwise keep showing in place of the colour just picked (v1.0.0)
  - log: 2026-08-09T00:00:00Z @kj extended - adversarial round 5 (bug-hunter, three repros): a rollback restored the whole cache, so a failing write undid a concurrent successful one, and a poll's answer could speak for a write still on the wire; both are per-key now, with mutation-checked Jest cases (v1.0.0)
  - log: 2026-08-09T00:00:00Z @kj hardened - adversarial round 6 (architect MAJOR + bug-hunter 3 MAJORs, all reproduced): the cache is written optimistically, so the confirmed-write gate could read another pass's unanswered write as stored and paint on it; writes now carry a sequence number and a per-id pending count, a reload cannot speak for an id written since it asked, an overtaken write neither rolls back nor re-asserts, and the gate requires not-pending (v1.0.0)
  - log: 2026-08-09T00:00:00Z @kj simplified - adversarial round 7 (architect MAJOR, reproduced): two overlapping FAILED writes left a phantom the gate read as held, because the cache was written optimistically and the overtaken write's restore point predated it; the cache now takes only CONFIRMED values, which deletes the snapshot, every rollback and the pending count, and a reload answered after a newer one is discarded (bug-hunter MAJOR) (v1.0.0)
- [x] `ACC-COLO-75` **Branch colour inheritance** - a branched conversation inherits the parent's effective colour at fork time. For a native provider only a colour this extension's own store holds for the parent is inherited - an entry the parent itself inherited counts; copying the parent's assistant-chosen tint would pin the fork to it and shadow the fork's own `/color`
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
  - log: 2026-08-09T00:00:00Z @kj qualified - native providers inherit only the override, now that the store accepts writes for them (v1.0.0)
  - log: 2026-08-09T00:00:00Z @kj wording corrected - adversarial round 5 (architect, bug-hunter, both traced): the code inherits any STORED colour, which is what Edge: branch of a branch requires; five artefacts said hand-set only, inviting a filter that would break that criterion
- [x] `ACC-COLO-76` **Edge: branch of a branch** - inherits the effective colour of its immediate parent, including any user-set override
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-COLO-77` **Edge: colour of a deleted conversation** - deleting a conversation drops its stored colour entry, leaving no orphan keys
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-COLO-78` **Edge: colour set on a branch terminal** - a terminal opened with Open Branched Conversation carries a conversation that is not the row's current one; a colour set on that tab is stored against the branch and released from the same row, without first switching the project's current conversation
  - log: 2026-08-09T00:00:00Z @kj added
  - log: 2026-08-09T00:00:00Z @kj closed - the reset targets the row's conversation plus its branches; Galata asserts the release of a branch-only colour, mutation-checked against the row-only keying (v1.0.0)
- [x] `ACC-COLO-79` **Colour origin** - the store records whether a colour was set by hand on a tab or written at fork time; both outrank the default identically and only the hand-set ones are offered for release, so dropping an override never un-inherits a branch. A store written before origins were recorded holds NOTHING hand-set - both writers predate the marker, and offering an inherited tint for release destroys a branch's colour with no undo, while withholding the release costs one re-pick on the tab. Caveat: an inherited tint has no release of its own, so releasing a parent's override leaves branches that inherited it still wearing that colour
  - log: 2026-08-09T00:00:00Z @kj added
  - log: 2026-08-09T00:00:00Z @kj closed - state file carries `overrides` beside `colours`; pytest covers inherit-vs-hand-set, the legacy file and the marker's removal, and Galata asserts an inherited tint survives a release (v1.0.0)
  - log: 2026-08-09T00:00:00Z @kj corrected - adversarial round 4 (architect MAJOR, bug-hunter MAJOR, both reproduced): the legacy rule claimed a pre-1.0.0 file held only tab write-backs, but inherit_colour shipped in 8e62249, so an upgrader's release would un-inherit exactly as before; a legacy file now holds nothing hand-set, and re-picking the colour on the tab is the way back
- [x] `ACC-COLO-80` **Colour write failure is reported** - a colour the store cannot persist answers 500 rather than 200, and the panel treats an answer that does not hold the colour as a failed write - it leaves the cache untouched and does not paint, since painting makes the companion extension drop the tab's own record of the choice
  - log: 2026-08-09T00:00:00Z @kj added
  - log: 2026-08-09T00:00:00Z @kj closed - adversarial round 3 (bug-hunter MAJOR, reproduced against a full disk): route answers colour_store_unwritable, and ColourStore.set/forget verify the returned map (v1.0.0)
  - log: 2026-08-09T00:00:00Z @kj extended - adversarial round 4: a malformed colour answers 400 colour_invalid rather than the 500 that means the state dir is unwritable, and the DELETE half of the 500 is now covered by a test (v1.0.0)

## Retirement and Migration `RETI`

This extension retires the three standalone extensions. A user upgrading must not end up with duplicate panels or lost state.

- [x] `ACC-RETI-81` **Feature parity** - every feature listed in the three standalone READMEs is present here or explicitly recorded as dropped, with a reason
  - log: 2026-08-07T00:00:00Z @kj closed - all 41 README features of the three standalone extensions audited with file:line evidence: 42 present after the DEF-9 fix, 0 missing, and 2 dropped - the `install-claude-statusline` and `install-kimi-statusline` companion CLIs, orthogonal to session management, so no `[project.scripts]` entry ships here
- [x] `ACC-RETI-82` **Conflict detection** - a standalone extension still installed alongside this one is detected at activation
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-RETI-83` **Conflict resolution** - a detected standalone extension suppresses this extension's panel for that assistant, so the user never sees two panels for one assistant
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-RETI-84` **Conflict notice** - the suppressed case tells the user which package to uninstall, once, not on every refresh
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-RETI-85` **Settings migration** - saved settings from each standalone plugin id are read once and mapped onto the matching `providers.<id>.*` keys
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-RETI-86` **Favourites migration** - favourites recorded by a standalone extension carry over to the matching provider
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-RETI-87` **Session stores untouched** - migration reads the assistants' own history directories in place and never moves, copies or rewrites them
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-RETI-88` **Migration is idempotent** - running twice changes nothing the second time and never overwrites a value the user has since set here
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-RETI-89` **Metapackage updated** - `stellars_jupyterlab_extensions` depends on this extension and drops the three standalone ones
  - log: 2026-08-07T00:00:00Z @kj deferred until this package is published - the metapackage cannot depend on an unpublished package; execute at release
  - log: 2026-08-08T00:00:00Z @kj closed: stellars_jupyterlab_extensions 1.1.5 published: claude/codex deps replaced with jupyterlab_ai_code_assistants_extension, README bullet updated, pushed
- [x] `ACC-RETI-90` **Standalone repos marked** - each retired extension's README states it is superseded, naming this package
  - log: 2026-08-07T00:00:00Z @kj deferred until release alongside the metapackage repoint - marking READMEs superseded before the replacement is installable would strand users
  - log: 2026-08-08T00:00:00Z @kj closed: superseded notice added atop README of claude/codex/kimi standalone repos, committed and pushed
- [x] `ACC-RETI-91` **Edge: nothing to migrate** - a fresh install with no prior extension runs migration as a silent no-op
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-RETI-92` **Edge: partial prior install** - one standalone extension present and two absent migrates the one and skips the rest without error
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-RETI-93` **Edge: corrupt prior settings** - unreadable saved settings are skipped with a console warning, defaults apply, migration continues for the others
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)

## Claude Provider `CLAU`

Ported from `jupyterlab_claude_code_extension` v1.2.73, the architectural base. Capabilities - native fork, user-set colour, remote control, background agents.

- [x] `ACC-CLAU-94` **Native fork** - branching uses `claude --fork-session`; the chosen name is stamped and the fork becomes the row's current conversation
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-CLAU-95` **Remote control indicator** - a green dot marks sessions actively under remote control, not merely a running terminal
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-CLAU-96` **Background agents** - a conversation held by a running background agent shows a `bg` chip and is attached to, never resumed
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-CLAU-97` **Launch verb resolved server-side** - the server decides resume-versus-attach at launch time, so a stale panel cannot pick the wrong one
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-CLAU-98` **Coloured tabs from `/color`** - the terminal tab tint comes from the session's own colour, via `jupyterlab_colourful_tab_extension`, unless the user set a colour on the tab by hand (see Colour / Override precedence)
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
  - log: 2026-08-09T00:00:00Z @kj qualified - `/color` is now the DEFAULT, not the last word; a hand-set tab colour overrides it (v1.0.0)
- [x] `ACC-CLAU-99` **Skip-permissions mode** - an opt-in setting and matching menu entries launch with `--dangerously-skip-permissions`, off by default
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-CLAU-100` **Terminal -c follows the panel** - switching to or launching a conversation makes plain 'claude -c' in that project resume it, including a conversation that has been compacted
  - log: 2026-08-26T00:00:00Z @kj added
  - log: 2026-08-26T00:00:00Z @kj closed: closed - DEF-127: switch and launch repair a compact_boundary root so -c can select it; verified end to end against the real CLI, 7 mutation-checked tests
  - log: 2026-08-26T00:00:00Z @kj qualified - -c picks by mtime, and only the SWITCH path touches it; an already-continuable conversation opened by launch alone still leaves -c on the project's newest transcript until the resumed CLI appends (round-1 architect)
  - log: 2026-08-26T00:00:00Z @kj qualified - launching a conversation held by a background agent attaches to that agent and does NOT repair it, so an agent-held compacted conversation is not made -c-selectable by launch (see DEF-128)

## Codex Provider `CODE`

Ported from `jupyterlab_codex_extension` v0.6.12. Capabilities - no colour source, approval-bypass launch mode.

- [x] `ACC-CODE-101` **Live activity indicator** - shows which projects have a Codex process running right now
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-CODE-102` **Approval bypass** - an opt-in setting and matching menu entry launch with `--dangerously-bypass-approvals-and-sandbox`, off by default
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-CODE-103` **No native colour** - the provider declares `colourSource: none`; default is no tint, user-set colours apply via the write-back store per the Colour section
  - log: 2026-08-07T00:00:00Z @kj reworded - write-back store makes user-set colour possible on colour-less assistants
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)

## Kimi Provider `KIMI`

Ported from `jupyterlab_kimi_code_extension` v0.7.8. Capabilities - server-side fork, session-id-derived colour, YOLO launch mode.

- [x] `ACC-KIMI-104` **Resume by session id** - conversations open with `kimi -S <session-id>`
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-KIMI-105` **Server-side fork** - Kimi has no fork flag, so branching copies the session directory with a fresh id and title, then opens it
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-KIMI-106` **YOLO mode** - every launch action has a YOLO variant using `--yolo`; a setting makes it the default, off by default
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-KIMI-107` **Deterministic tab colour** - the default tint derives from the session id, stable per conversation, since Kimi has no colour command; a user-set colour and branch inheritance override it per the Colour section
  - log: 2026-08-07T00:00:00Z @kj reworded - derived hash is the default only, write-back and inheritance take precedence
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)

## Gemini Provider `GEMI`

New provider - no standalone extension to port from. Gemini CLI 0.54.4 (`@google/gemini-cli`, installed via `lab-utils install-ai-assistant/google-gemini-cli`). Store: `~/.gemini/projects.json` registry maps project root to a short id; chats live under `~/.gemini/tmp/<shortId>/chats/` as JSON files. Capabilities - no fork flag (server-side fork), no colour command (`colourSource: none`), YOLO launch mode.

- [x] `ACC-GEMI-108` **Store scan** - projects come from the `projects.json` registry and sessions from `tmp/<shortId>/chats/*.json`, read in place, never via the auth-gated CLI listing
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-GEMI-109` **Resume** - clicking a row opens the conversation via its chat file (`--session-file <path>`), never by the positional index of `--resume`, which is ordering-dependent and stale the moment another session lands
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-GEMI-110` **New session** - a new conversation launches with `--session-id <uuid>` minted by the extension, so the row can be tracked from first poll
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-GEMI-111` **Server-side fork** - Gemini has no fork flag, so branching copies the chat file with a fresh id, Kimi-style, and opens it
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-GEMI-112` **YOLO mode** - one boolean `yoloMode` setting, off by default, with matching `--yolo` launch variants; the four-rung `approvalMode` ladder is not exposed (DEF-111)
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
  - log: 2026-08-12T00:00:00Z @kj reopened - rewritten to the single-switch shape; `auto_edit` and `plan` are no longer settable (v1.0.21)
  - log: 2026-08-12T00:00:00Z @kj closed: closed - single boolean per DEF-111 (v1.0.22)
- [x] `ACC-GEMI-113` **Edge: stale approvalMode key** - a saved `providers.gemini.approvalMode` from an older version is ignored with a warning, and no `--approval-mode` flag ever reaches the CLI
  - log: 2026-08-12T00:00:00Z @kj criterion added (v1.0.21)
  - log: 2026-08-12T00:00:00Z @kj closed: closed - registry warns on unknown keys; stale token dropped server-side, pinned in test_provider_stores.py (v1.0.22)
- [x] `ACC-GEMI-114` **Edge: unauthenticated CLI** - a gemini binary without auth configured still lists sessions in the panel (disk scan); the auth error surfaces only inside the launched terminal
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-GEMI-115` **Edge: registry migration** - Gemini versions that migrate legacy hash-named project dirs to registry short ids must not produce duplicate rows during migration
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)

## Testing `TEST`

Three tiers - pytest for the server core and each provider module, Jest for frontend units, Galata for the UI. Galata is the only tier that fails when the packaging is wrong rather than the code, so the provider registry and the live enable/disable path are asserted there.

| Functionality      | pytest             | Jest             | Galata                       |
| ------------------ | ------------------ | ---------------- | ---------------------------- |
| Registry discovery | modules resolve    | barrel exports   | panel count matches enabled  |
| Enable/disable     | route gating       | -                | panel appears and disappears |
| CLI absent         | 503 on missing bin | -                | no panel for absent binary   |
| Session operations | store logic        | response shaping | resume opens a real terminal |
| Migration          | idempotent mapping | -                | -                            |

- [x] `ACC-TEST-116` **Port knob** - `JLAB_TEST_PORT` threads through `playwright.config.js` baseURL, the webServer command and `jupyter_server_test_config.py`, so the suite runs where 8888 is taken
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-117` **Empty port value** - the server config reads the port with `or "8888"`, not a `get()` default, so an exported-but-empty variable does not raise
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-118` **No server adoption** - `reuseExistingServer` is `false` unconditionally; the suite drives terminals and session stores and must never adopt a developer's live lab
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-119` **Serialised specs** - `workers: 1` and `fullyParallel: false`, since all specs share one server and its per-provider session stores
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-120` **Exit status preserved** - test runs redirect rather than pipe through `tee`, so a suite whose server never started reports failure
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-121` **Isolated session stores** - Galata points every provider's session store at a scratch directory; no test reads or writes the developer's real assistant history
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-122` **Isolated runtime dir** - `JUPYTER_RUNTIME_DIR` points at a private folder and inherited hub tokens are deleted from the spawn environment
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-123` **Scratch swept at both ends** - scratch stores are cleared by the webServer command before start and again in `globalTeardown`, since `globalSetup` runs after the server
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-124` **Activation message** - `src/index.ts` logs `JupyterLab extension jupyterlab_ai_code_assistants_extension is activated!` verbatim, matching the template UI test
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-125` **Galata: panel per enabled provider** - with all providers enabled and their CLIs stubbed present, the shell shows exactly one panel per provider, each with its own title
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-126` **Galata: live disable** - toggling a provider off removes its panel within the test's timeout, leaving the others docked
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-127` **Galata: live enable** - toggling a provider back on re-docks exactly one panel, not two
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-128` **Galata: CLI absent** - a provider whose stub binary is removed from PATH renders no panel and raises no error dialog
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-129` **Galata: resume opens a terminal** - clicking a seeded session row opens a terminal, proving the launch route end to end
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-130` **Galata: Claude regression vs original** - the original `jupyterlab_claude_code_extension` Galata suite, ported to the new panel's selectors, passes against the Claude provider as feature-parity evidence
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-131` **Galata: venv isolation** - the Galata server runs from a dedicated venv containing only this extension; the standalone extensions are absent from it and the developer's live environment is never installed into, uninstalled from, or modified
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-132` **Adversarial review gate** - `/devils-advocate:adversarial-review` runs clean with the architect and bug-hunter adversaries before release
  - log: 2026-08-08T00:00:00Z @kj closed: clean verdicts from all three adversaries: architect SHIP (round 2), bug-hunter SHIP (round 3), ux-designer SHIP (round 4); 4 fix batches, DEF-10..29 registered and closed; evidence logs/adversarial/
  - log: 2026-08-09T00:00:00Z @kj re-run for the colour-override change (v1.0.0): round 1 architect/ux-designer/bug-hunter all DO-NOT-SHIP - guessed-conversation write-back, failed-write destroying the colour, one-way-door override, stale native-is-read-only artefacts; fixed and round 2 pinned re-confirm spawned
  - log: 2026-08-09T00:00:00Z @kj colour-override change, rounds 2 and 3 (v1.0.0): all three adversaries DO-NOT-SHIP both times, converging each round on one defect - the release keyed on the wrong conversation, then the release keyed on any stored colour and so un-inherited branches; both fixed, plus a 200 answered for a colour the server could not persist
- [x] `ACC-TEST-133` **pytest: registry** - every provider module in `providers/` is discovered, exposes a unique id and satisfies the descriptor contract
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-134` **pytest: route gating** - a disabled provider's routes return 404 `provider_disabled` and an absent CLI returns 503 `cli_not_found`
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-135` **pytest: store isolation** - a provider handler given another provider's encoded path refuses rather than reading across stores
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-136` **pytest: migration idempotence** - running migration twice against the same fixture produces an identical result and no second write
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-137` **Jest: no assistant names in core** - a source-reading test asserts `src/core/` contains no provider id outside comments
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-138` **Suite can fail** - each tier is mutation-checked once: break the registry, the route gating and the toggle in turn, and confirm the guarding test goes red
  - log: 2026-08-07T00:00:00Z @kj closed - mutation check performed by the unit-test agent: duplicate-id guard, route disabled-gate, enable toggle, barrel entry and core-neutrality each broken in turn, each guarding test went red, restoration verified byte-identical by diff (wf_a4376a8b-03e tests:unit result)
- [x] `ACC-TEST-139` **No both-ends mocking** - no Galata spec mocks both the panel and the server for the same assertion; the tier exists to catch packaging and integration breaks
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-140` **Edge: spawn error listener** - any test spawning a shipped console script wires `child.on('error')`, so a missing binary reports as not-on-PATH rather than killing the worker
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-141` **Edge: snapshot updates** - visual baselines update through the `please update snapshots` PR comment workflow, never by hand-committed images
  - log: 2026-08-07T00:00:00Z @kj closed - conformance review (v0.1.7)
- [x] `ACC-TEST-142` **Galata: colour override and release** - the colour specs drive the panel itself - right-click the row, assert `Reset Tab Colour` is hidden with no override and visible with one, click it and assert the store empties and the row returns to the assistant's colour; a route-only assertion does not count, since it passes on a path no user can walk
  - log: 2026-08-09T00:00:00Z @kj added
  - log: 2026-08-09T00:00:00Z @kj closed - ui-tests/tests/colour-override.spec.ts drives the menu item; Galata 19/19 in ui-tests/.venv (v1.0.0)
  - log: 2026-08-09T00:00:00Z @kj extended - adversarial round 2: the seeded conversation now carries an assistant colour, so 'back to the assistant's' is a real tint rather than null-vs-null; the route-only precedence case was dropped as a pytest duplicate and a branch-conversation release case added, mutation-checked (v1.0.0)
  - log: 2026-08-09T00:00:00Z @kj extended - adversarial round 3: two cases added - an inherited tint is left alone by the release, and the item names its count when it reaches more than one conversation; the inheritance case is mutation-checked against keying on any stored colour (21/21, v1.0.0)

## API `API`

All routes are namespaced by provider id under the extension base `jupyterlab-ai-code-assistants-extension`.

- `GET status` -> `{root_dir, providers: [{id, label, enabled, cli_path, available}]}`
- `GET providers/<id>/sessions` -> `{sessions: [...]}`; 404 `provider_unknown`, 404 `provider_disabled`, 503 `cli_not_found`
- `GET providers/<id>/branches?encoded_path=...` -> `{current, total, branches: [...]}`
- `POST providers/<id>/switch` body `{encoded_path, session_id}` -> `{requested, current}`; 404 `branch_not_found`, 400 invalid input
- `POST providers/<id>/favourite` body `{project_path, favourite}` -> `{favourites: [...]}`
- `POST providers/<id>/launch` body `{project_path, session_id?, mode?}` -> `{terminal_name}`; 404 `session_not_found`, 400 `mode_unsupported`
- `POST providers/<id>/branch` body `{encoded_path, session_id, name?}` -> `{session_id}`; 400 `fork_unsupported`
- `DELETE providers/<id>/sessions` body `{encoded_path, session_ids?}` -> `{removed_count}`
- `GET providers/<id>/colours` -> `{colours: {session_id: colour}, overrides: [session_id]}`; `overrides` names the hand-set colours among them
- `POST providers/<id>/colours` body `{session_id, colour, hand_set?}` -> the whole store; `colour` null drops the entry, `hand_set` false marks a fork's inherited tint; 400 `colour_invalid`, 500 `colour_store_unwritable`
- `DELETE providers/<id>/colours` body `{session_ids}` -> the whole store; 500 `colour_store_unwritable`
- `POST migrate` -> `{migrated: [{provider_id, keys, favourites}]}`; idempotent, safe to call repeatedly
