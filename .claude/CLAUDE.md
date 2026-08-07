<!-- @import /home/lab/.claude/CLAUDE.md -->
<!-- @import /home/lab/workspace/.claude/CLAUDE.md -->

# Project-Specific Configuration

This file is a thin overlay. It imports and does not duplicate:

- **User-level** (global, every project on this machine): `/home/lab/.claude/CLAUDE.md`
- **Workspace-level** (everything under `/home/lab/workspace`): `/home/lab/workspace/.claude/CLAUDE.md`

All rules in both layers apply here. Only project-specific rules live below.

## Mandatory Bans (Reinforced)

The following workspace rules are STRICTLY ENFORCED for this project:

- **No automatic git tags** - only create tags when user explicitly requests
- **No automatic version changes** - only modify version in package.json/pyproject.toml/etc. when user explicitly requests
- **No automatic publishing** - never run `make publish`, `npm publish`, `twine upload`, or similar without explicit user request
- **No manual package installs if Makefile exists** - use `make install` or equivalent Makefile targets, not direct `pip install`/`uv install`/`npm install`
- **No automatic git commits or pushes** - only when user explicitly requests

## Build Lifecycle - Makefile Only

**MANDATORY**: the project `Makefile` owns the entire build lifecycle. Never run `pip`, `jlpm`, `yarn`, `npm`, build, publish, or clean commands directly.

- `make install` - build and install the extension
- `make publish` - release (explicit user request only, per the bans above)
- `make clean` - remove build artefacts
- `make mrproper` - remove all build and venv artefacts
- `make test` - run the test suite
- `make help` - list all targets

**Makefile currency**: always check the local `Makefile` version header against the canonical `/home/lab/workspace/private/jupyterlab/@utils/jupyterlab-extensions/Makefile` and update the local copy as soon as a newer version is found. Both files carry `# Makefile for Jupyterlab extensions version N.NN` on line 1.

## Repository Rules

- **Initialised locally** with `git init -b main` and an initial import of all artefacts
- **Always commit `package.json` and `package-lock.json` together** - a lockfile that drifts from the manifest breaks reproducible CI builds

## Feature and Defect Tracking

- **Acceptance criteria** - create and maintain one per feature using the `/acceptance-criteria` skill, written to `docs/acc-crit-<feature>.md`
- **Defects** - track in the single master list `docs/defects.md` using the `/defects-tracking` skill

## Required Workspace Skills

Skills live at `/home/lab/.claude/skills/` (global, available in every project).

- **`jupyterlab-extension`** - extension development guidelines, CI/CD with jupyter-releaser, TypeScript compatibility, common caveats. Mandatory for all work in this repository
- **`my-browser`** - Playwright browser automation for screenshots and UI verification of the extension in a running JupyterLab

## Project Context

JupyterLab 4 extension that consolidates the individual `jupyterlab_*_code_extension` extensions into a single package: one joint capability layer, one shared settings page, and an individual right-toolbar panel per code assistant. Settings decide which assistants are active (default - all enabled).

**Assistants consolidated**: `jupyterlab_claude_code_extension`, `jupyterlab_codex_extension`, `jupyterlab_kimi_code_extension` (siblings under `/home/lab/workspace/private/jupyterlab/`), which serve as the reference implementations for panel behaviour, session handling, and settings shape.

**Stack**: TypeScript frontend (`src/`) against `@jupyterlab/application` 4.x, Python `jupyter_server` extension (`jupyterlab_ai_code_assistants_extension/routes.py`), settings schema in `schema/plugin.json`, Jest unit tests, Playwright UI tests in `ui-tests/`. Scaffolded from the `jupyterlab/extension-template` copier template (`.copier-answers.yml`) - do not hand-edit that file.

**Packaging**: npm package `jupyterlab_ai_code_assistants_extension`, PyPI package `jupyterlab-ai-code-assistants-extension`.

## Journal Rules (Project-Specific)

- **APPEND ONLY**: New journal entries MUST be appended at the end of the file, never inserted between existing entries
- Entries maintain strict chronological order by position - the last entry in the file is always the most recent work
- Never reorder, move, or insert entries out of sequence
- The Stellars **journal plugin** is the canonical tool for this file: create via `/journal:create`, append via `/journal:update`, archive via `/journal:archive`. The `journal:journal` skill auto-triggers on any mention of "journal" and runs `journal-tools check` after every write
- Direct edits to `JOURNAL.md` are a last resort - prefer the plugin so modus secundis format, continuous numbering and append-only order are enforced automatically

## Strengthened Rules

- **Version bumps are the Makefile's job** - `make build` runs `increment_version`; never hand-edit the version in `package.json`
- **Surgical changes** - this extension absorbs three working extensions; when porting behaviour, copy the mechanism, not the whole file, and keep each assistant's panel isolated behind its settings toggle
- **UI claims need verification** - never state that a panel, menu, or icon renders correctly without a Playwright screenshot from a running JupyterLab
