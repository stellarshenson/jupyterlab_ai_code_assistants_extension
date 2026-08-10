# Changelog

<!-- <START NEW CHANGELOG ENTRY> -->

<!-- <END NEW CHANGELOG ENTRY> -->

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
