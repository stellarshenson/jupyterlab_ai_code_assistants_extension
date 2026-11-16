---
name: before-copies-get-collected
description: jest and pytest both collect test files copied under tmp/ (patches/before/<lane>/...); keep such copies with a .before suffix or make test fails
metadata:
  type: project
---

Jest's `testRegex` is `src/.*/.*.spec.ts[x]?$` with no ignore for `tmp/`, so a copy at `tmp/workflows/<wf>/patches/before/<lane>/src/__tests__/x.spec.ts` runs as a suite and fails on its relative imports. pytest has no `testpaths`, so a copy at `tmp/.../tests/test_x.py` breaks collection with "attempted relative import with no known parent package", which interrupts the whole `make test` run.

**Why:** On 2026-11-16 the agy-real workflow told each lane to keep before-copies under `patches/before/<lane>/` with the repo-relative path. A jest run of `terminals.spec.ts` matched the tab lane's copy too, and `pytest --collect-only` errored on the store lane's copy.

**How to apply:** When a brief asks for before-copies under `tmp/`, rename any copied `*.spec.ts` or `test_*.py` to `<name>.before` right after copying (a tracked file can be restored from `git show HEAD:<path>` anyway), and say so in the report. Check `python -m pytest --collect-only -q | grep tmp/` before handing work to a `make test` stage.
