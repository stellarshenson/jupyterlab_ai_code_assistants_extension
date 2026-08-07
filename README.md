# jupyterlab_ai_code_assistants_extension

[![GitHub Actions](https://github.com/stellarshenson/jupyterlab_ai_code_assistants_extension/actions/workflows/build.yml/badge.svg)](https://github.com/stellarshenson/jupyterlab_ai_code_assistants_extension/actions/workflows/build.yml)
[![npm version](https://img.shields.io/npm/v/jupyterlab_ai_code_assistants_extension.svg)](https://www.npmjs.com/package/jupyterlab_ai_code_assistants_extension)
[![PyPI version](https://img.shields.io/pypi/v/jupyterlab-ai-code-assistants-extension.svg)](https://pypi.org/project/jupyterlab-ai-code-assistants-extension/)
[![Total PyPI downloads](https://static.pepy.tech/badge/jupyterlab-ai-code-assistants-extension)](https://pepy.tech/project/jupyterlab-ai-code-assistants-extension)
[![JupyterLab 4](https://img.shields.io/badge/JupyterLab-4-orange.svg)](https://jupyterlab.readthedocs.io/en/stable/)
[![Brought To You By KOLOMOLO](https://img.shields.io/badge/Brought%20To%20You%20By-KOLOMOLO-00ffff?style=flat)](https://kolomolo.com)
[![Donate PayPal](https://img.shields.io/badge/Donate-PayPal-blue?style=flat)](https://www.paypal.com/donate/?hosted_button_id=B4KPBJDLLXTSA)

One extension for every AI code assistant in JupyterLab. Replaces the separate `jupyterlab_claude_code_extension`, `jupyterlab_codex_extension` and `jupyterlab_kimi_code_extension` packages with a single install that keeps each assistant's own side panel while sharing one settings page and one session-handling core underneath.

> [!NOTE]
> Early development. The scaffolding, build lifecycle and packaging are in place; the assistant panels are being ported from the standalone extensions.

## Features

- **One install, every assistant** - Claude Code, Codex and Kimi supported from a single package instead of three
- **Individual right-panel per assistant** - each assistant keeps its own side panel with Favorites, Recent and All projects
- **Joint settings page** - one settings section covering all assistants, replacing three separate ones
- **Per-assistant toggles** - switch any assistant's support on or off in settings; all are enabled by default
- **Shared session core** - resume, branch, switch and clean up conversations through one common mechanism across assistants
- **Auto-disabled when absent** - an assistant whose CLI is not installed does not show a panel

## Requirements

- JupyterLab >= 4.0.0
- Python >= 3.10

## Install

To install the extension, execute:

```bash
pip install jupyterlab_ai_code_assistants_extension
```

## Uninstall

To remove the extension, execute:

```bash
pip uninstall jupyterlab_ai_code_assistants_extension
```
