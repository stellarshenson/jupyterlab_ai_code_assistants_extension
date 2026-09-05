# Changelog

<!-- <START NEW CHANGELOG ENTRY> -->

<!-- <END NEW CHANGELOG ENTRY> -->

## [1.2.5] - 2026-09-05

### Changed

- `jupyterlab_colourful_tab_extension` is now required at 1.1.20 or newer (`^1.1.20` in `package.json`, `>=1.1.20` in `pyproject.toml`), which is the release that carries the tab ownership API and the terminal fingerprint route. Until now the requirement named 1.0.19, so a fresh install resolved to a companion without that API and every assistant tab went untinted behind a warning; the floor could not name 1.1.20 before it was published. The runtime check stays in place, because a requirement binds the install and a companion can be downgraded after it

## [1.2.4] - 2026-09-05

### Fixed

- A terminal tab could keep showing a colour that belonged to a conversation which had already ended, and the assistant's own `/color` was then powerless to change it. The server hands a closed terminal's number to the next terminal opened, and a colour stored against that number was read back as a colour you had chosen, which outranks everything the assistant picks. Colours you pick are now learned from the pick itself instead of being read out of the companion extension's browser storage, so a stored value can no longer be mistaken for a choice, and a colour kept against a terminal number survives only while the process behind that number is unchanged
- Clearing a colour from the tab's own right-click menu now releases the colour recorded for that conversation, for a conversation whose terminal is open; before, only `Reset Tab Colour` could undo it

### Changed

- Terminal tab tinting now requires `jupyterlab_colourful_tab_extension` at the release that reports the colours you pick and lets another extension own a tab. Against an older companion this extension tints no tabs at all and says so once, in a notification that stays until dismissed; the companion's own right-click colours are unaffected
- A terminal running an assistant is claimed with the companion, so the companion stores nothing for that tab and the two extensions no longer hold competing records of one tab's colour

### Added

- Design note `docs/design-tab-colour-ownership.md` describing the ownership protocol across the two extensions

## [1.2.1] - 2026-08-28

### Changed

- Version line moved to 1.2 to mark the Launcher tiles as a feature release; the content is that of 1.1.13

## [1.1.13] - 2026-08-28

### Added

- An "AI Assistants" section in the JupyterLab Launcher with one tile per enabled assistant; a click opens that assistant in the file browser's current folder, resuming the folder's conversation when one exists and starting a new one otherwise, in a terminal spawned through `jupyterlab_basic_terminal_extension`
- The section carries the extension's own robot-head icon rather than the first assistant's, sits after Other, and appears or disappears live as assistants are enabled or disabled in settings - no section when none is enabled
- `POST providers/<id>/launch-argv` returns the command line the launch route would spawn, with the same validation and pin bookkeeping
- Design note `docs/design-launcher.md`, kept in step with the implementation

### Changed

- `@jupyterlab/launcher` pinned `^4.6.0` for `categoryRank`; `jupyterlab-basic-terminal-extension>=1.0.7` is a runtime dependency; `react` is a direct dependency for the section-icon view

### Fixed

- `yarn.lock` is back in the berry format the build reads; a yarn v1 shim had rewritten it in the previous commit, and both lockfiles now resolve one tree

## [1.0.41] - 2026-08-27

### Fixed

- A sign-in or proxy page returned with status 200 no longer empties the sidebar - the extension now treats a non-JSON answer as "the server did not answer" and keeps the panels it has, instead of reading it as "no assistant is installed"
- Opening a conversation held by a session record with a zero or negative process id no longer skips the transcript repair and no longer routes the launch to a background agent that does not exist
- Forking a Gemini conversation keeps the chat file byte-faithful - a line-separator character inside a message no longer splits the record, non-ASCII text is no longer re-escaped, and a record that cannot be encoded declines the fork cleanly instead of failing with a server error
- Before the server has answered its first status check, Open Terminal and Show in File Browser now say "Waiting for the server root" instead of blaming a folder outside the JupyterLab root
- Rows drawn before the server root is known now show root-relative paths the moment the root arrives, instead of at the next 30-second refresh
- An assistant that is enabled but not installed now says so in its panel, naming the missing command, instead of "Could not reach the server - retrying"
- The "enabled but its binary was not found" notice can fire again after a false alarm - the once-per-page latch clears as soon as a status check reports the assistant available

### Changed

- The plugin's activation path is now covered by a Jest suite; `jest.config.js` ignores the two virtual environments whose duplicate labextension copies broke module resolution

## [1.0.39] - 2026-08-27

### Fixed

- The sidebar no longer stays collapsed after a reload or a JupyterLab restart whose first status check fails - the extension read "the server did not answer" as "no assistant is installed" and docked nothing, so JupyterLab found no panel to restore and closed the sidebar itself; a failed check now leaves the last known set of panels in place, and until the server has answered once every enabled assistant is docked so the panel you had open comes back where it was
- A panel docked before the server's first answer can no longer start a session in the wrong folder - the new-session button used to join the file browser's folder to an unknown root and could launch at the top of the filesystem
- A panel docked before the server's first answer can no longer delete conversations permanently on one click - the Manage Sessions Delete button now arms first whenever the trash setting is not yet known
- The new-session button is disabled, dimmed and titled "Waiting for the server root" until the server has answered, instead of looking live and doing nothing

### Changed

- Defect and acceptance-criteria tracking moved to the `project-management` schema - every item carries a permanent id (`DEF-GUARD-132`) and an author handle; existing defect numbers are unchanged

## [1.0.32] - 2026-08-26

### Fixed

- Opening or switching to a conversation no longer reads the whole transcript to find there is nothing to repair - measured at 0.8 s and 438 MiB of server memory for a single click on a 100 MB conversation, on the path 91 of 107 conversations take
- A conversation being written to while the panel opens it can no longer lose that turn - the check meant to abort such a rewrite took its reference point after reading the file, so a turn typed during the read was already counted as part of it
- Repairing a compacted conversation no longer rewrites or inflates the rest of the transcript - it grew a 105 MB file to 170 MB by re-encoding every line, where now only the two records the repair touches differ
- A transcript the repair cannot write, or a directory it cannot write into, no longer fails the switch with a server error
- Launching a conversation held by a background agent no longer rewrites it - that launch attaches to the agent and never needs the repair

## [1.0.31] - 2026-08-26

### Fixed

- `claude -c` in a project now resumes the conversation you last opened or switched to in the panel, including one that has been compacted - Claude Code refuses to continue a compacted conversation, so the terminal reported "No conversation found to continue" against a session the panel opened without complaint
- A single session record carrying an out-of-range process id no longer breaks the project list - one unusable value now costs its own row a field instead of failing the listing for every project on every refresh

## [1.0.30] - 2026-08-19

### Fixed

- Panels come back within a second of a laptop waking or a tab regaining focus - the extension re-checks which assistants are available on `online` and on the tab becoming visible, instead of leaving the sidebar empty until the next 60-second refresh
- A status check that times out can no longer discard a newer one that succeeded - overlapping checks are now ordered, so a slow request finishing late cannot undock every panel while the server is healthy
- The warning printed when a status check fails no longer promises a retry schedule it cannot honour, and no longer implies the panels are gone for good

## [1.0.29] - 2026-08-14

### Changed

- No runtime change - the defect ledger now records two reported symptoms as environment, not extension: a burst of 404s from the panel's endpoints that never reached the Jupyter server (a hop in front of it, with two unrelated extensions failing in the same instant), and a `Show in File Browser` that looked dead because the file browser was already sitting in the target folder

## [1.0.28] - 2026-08-14

### Added

- Browser-rendered proof that an armed launch mode leaves the header + with no menu at all - it clicks through and starts the session, which until now was asserted only under jsdom (Galata 29 checks)

## [1.0.27] - 2026-08-13

### Changed

- The header + menu entries read `New session` and `New session (Skip Permissions)` - the provider name gone from both - and the button's tooltip is the static `New session in current folder`, no longer interpolating a folder path that deep trees make unreadable; the armed launch mode is still named in the tooltip's parentheses

## [1.0.25] - 2026-08-13

### Changed

- The header new-session button's tooltip reads `New session in <folder>` - the provider name dropped, since the panel's own tab already says which assistant it is; the armed launch mode is still named in parentheses, and an armed mode still means the button launches on click with no menu

## [1.0.23] - 2026-08-12

### Changed

- Gemini settings collapse to a single approval control - the YOLO switch - like every other provider; the four-rung `approvalMode` dropdown is gone (`auto_edit` and `plan` are no longer settable, and a stale saved key is ignored)
- The panel's header new-session button always wears +, whatever launch mode is armed - the armed mode is still named in its tooltip, and the shield marks only the menu entries that skip approval

### Removed

- The enum launch-mode machinery (`kind`/`values`/`unsafeValues` on `ILaunchMode`, the resolver's enum-precedence branch, the schema generator's enum output) - dead once Gemini's ladder went

## [1.0.21] - 2026-08-12

### Changed

- The shield on the permission-skipping entries paints in the theme's standard grey like every other menu icon - the shape alone marks the entry, replacing the orange fill
- `Clean Up Parallel Sessions` wears its own sweep-trash glyph (the bulk variant of the trash `Remove from ...` carries) instead of sharing the unsafe-launch shield

## [1.0.19] - 2026-08-11

### Changed

- The danger marker on the unsafe launch entries (`Resume (Skip Permissions)` and its New/Branch variants, plus the destructive `Clean Up Parallel Sessions`) is now the shield - the established glyph for an action touching the permission system - replacing the caution triangle; its conspicuous 16x16 orange rendering is unchanged

## [1.0.17] - 2026-08-11

### Added

- Single home for the recent-conversations limit constants (`src/core/limits.ts`), shared by the panel, the settings plugin and the schema generator
- Migration end-to-end test against a real standalone-extension settings and favourites shape, plus tests pinning the state-write logging, the CLI timeout parity floor and the route-side switch pin
- Background-agent chip rendered proof in the Galata suite (now 27 checks)

### Changed

- Store `switch()` contract slimmed to `{"requested"}` - the route owns both the pin write (IOLoop thread) and the post-pin `current` resolution; four dead store-side resolutions deleted and every switch docstring made truthful
- State and colour file writes serialised on the IOLoop again after an executor conversion had de-serialised them (lost update reproduced 200/200)
- `namingStrategy` union collapsed to `promptsForBranchName: boolean`; saved settings parsed once per request instead of four to five times
- Per-file metadata caches capped in gemini and kimi to match claude's

### Fixed

- Every switch after the first in a pinned project answered the OLD pin as `current` and toasted a failure for a switch that succeeded (kimi and gemini since the port)
- Claude's store-internal pin write raced the loop-side writers from the executor pool
- Command rejection toasts for terminal-open and folder-open now name the failed command; request timeouts read as a slow server, not a dead one
- Swallowed `OSError`s in the state store now log provider, path and errno
- Block-comment stripping in the core-neutrality guard preserved line numbers (a measured ~141-line report skew)
- Defect ledger grown to 110 entries, 0 open, across adversarial rounds 8-20 ending in a clean two-lens pair

## [1.0.10] - 2026-08-10

### Added

- Client-side request deadline: every server call is bounded at 60 seconds, with a distinct timeout error so the panel can tell a slow server from a dead one
- Browser-measured panel regression suite (`ui-tests/tests/panel-regressions.spec.ts`, Galata 26/26)
- Cross-runtime descriptor parity guard now also binds the display label, launch-mode values and the derived tab colour (UTF-8 FNV-1a, 508-id differential corpus)

### Changed

- Colour store rewritten around a serialised operation chain - optimistic cache writes, rollbacks and write-sequencing removed; the cache holds only server-confirmed values
- Context menu, branch submenus and tab-colour capture hardened against right-click races (generation token, per-project branch cache, bounded state budget)
- Destructive and listing routes moved off the IOLoop into an executor, including the launch pre-flight (a measured 191 ms whole-server freeze per row click)

### Fixed

- Server refusals rendered as the literal `[object Object]` instead of the error message
- Cleanup of an already-clean project reported "Cleanup failed" instead of "Nothing left to clean up."
- Colour refresh polling could queue unboundedly behind a hung server
- sdists shipped internal files (`.claude/`, `logs/`, `docs/defects.md`) - now excluded from the package
- Gemini terminals were unidentifiable on Node 24 and below (`/proc` comm-name match), spawning duplicates and never tinting
- A further ~70 defects from the seven-round adversarial campaign, tracked in `docs/defects.md`

## [0.6.17] - 2026-08-08

### Changed

- Kimi panel icon replaced with the official Moonshot "K" mark (the `k-only` glyph from Moonshot's branding guide) rendered monochrome in the theme foreground
- Gemini panel icon replaced with the silhouette of Google's official 2025 Gemini spark, rendered monochrome in the theme foreground
- README rewritten to the full launcher-and-manager shape: why-section, complete feature list, migration guide from the standalone extensions, build-pin warning, and a panel screenshot

## [0.6.15] - 2026-08-07

### Added

- Initial release consolidating `jupyterlab_claude_code_extension`, `jupyterlab_codex_extension` and `jupyterlab_kimi_code_extension` into one provider-registry extension with Claude Code, Codex, Kimi and Gemini panels, a joint settings page with live per-assistant toggles, and one-shot migration of standalone settings and favourites
