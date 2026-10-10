---
name: make-build-side-effects
description: make build uninstalls the installed extension and can pip-install build tools; an agent allowed make build but not make install leaves JupyterLab without the extension
metadata:
  type: project
---

`make build` is not only a rebuild of `lib/` and `schema/plugin.json`. Its prerequisite chain is `clean` → `uninstall`, so it runs `pip uninstall` on the wheel in `dist/` and removes the installed extension from `/opt/conda`. Only `make install` installs it again, and `make install` also raises the patch version. `check_dependencies` runs `pip install` for every missing build tool, and `jlpm install` and `python -m build` download from the registries.

**Why:** On 2026-10-09 a workflow brief allowed `make build` and forbade `make install`, and described `make build` as a rebuild only. The run uninstalled extension 1.2.56 from the live JupyterLab environment and installed twine 7.0.0 with 13 dependencies into `/opt/conda`. The agent could not run `make install`, so the extension was still uninstalled when the agent returned its report.

**How to apply:** Before running `make build`, read whether the brief also allows `make install`. When it does not, state in the report that the extension is now uninstalled and that `make install` restores it. Check `/opt/conda/lib/python3.*/site-packages` for `pytest` before a pytest step: after the container rebuild of 2026-10-07 it was absent, and the pytest command from the brief failed with "No module named pytest". pytest 9.1.1 with pytest-asyncio, pytest-cov and pytest-jupyter was installed there on 2026-10-09 at 10:24, so the absence is expected again only after another container rebuild. A second `make build` on the same day, with the extension already uninstalled and twine present, changed nothing in `/opt/conda`: the uninstall step found nothing and `check_dependencies` installed nothing.
