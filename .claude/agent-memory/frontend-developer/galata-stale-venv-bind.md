---
name: galata-stale-venv-bind
description: ui-tests/.venv lags make install; when a brief forbids pip installs, bind the repo package and labextension over the venv copies in the second bwrap layer instead
metadata:
  type: project
---

The Galata server runs from `ui-tests/.venv`, which `make install` never updates. On 2026-11-16 it held wheel 1.3.18 while the repo was at 1.3.21, so the new copilot and antigravity providers were missing from it. Earlier campaigns synced it with `ui-tests/.venv/bin/pip install --no-deps --force-reinstall dist/<wheel>`.

**Why:** Workflow briefs in this project often forbid any hand-run pip install. A run against the stale venv tests old code and fails every assertion about new work.

**How to apply:** Check `ui-tests/.venv/bin/pip list | grep ai-code` against `dist/`. If it lags and pip is forbidden, add two `--ro-bind` lines in the second bwrap layer: the repo's `jupyterlab_ai_code_assistants_extension/` over `.venv/lib/python3.14/site-packages/jupyterlab_ai_code_assistants_extension`, and its `labextension/` over `.venv/share/jupyter/labextensions/@stellarshenson/jupyterlab-ai-code-assistants-extension`. Reference runner: `tmp/workflows/providers-antigravity-copilot/galata.sh`. With these binds, a mutation of the built bundle or a provider `.py` file takes effect in the next run without a rebuild (restore it with `cp -p`, see [[mutation-restore-keeps-mtime]]). Assistant panels dock in the RIGHT sidebar, so a tab screenshot targets `.jp-SideBar` that contains the tab, not `.jp-mod-left`.
