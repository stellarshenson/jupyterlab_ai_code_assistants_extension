# Changelog

<!-- <START NEW CHANGELOG ENTRY> -->

<!-- <END NEW CHANGELOG ENTRY> -->

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
