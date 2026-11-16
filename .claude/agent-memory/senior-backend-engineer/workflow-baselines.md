---
name: workflow-baselines
description: patch baselines of test files under tmp/workflows/<name>/before/ need a .before suffix, or make test's bare pytest collects them and fails
metadata:
  type: project
---

`make test` runs `pytest -vv` from the repo root with no `testpaths`, so a baseline copy `tmp/workflows/<name>/before/.../tests/test_x.py` is collected and fails with "attempted relative import with no known parent package". Earlier workflows (agy-real) name such copies `test_x.py.before`; the diff writer maps the suffix back.

**Why:** a workflow brief asks for `before/<path>` copies; taken literally for test files they break the gate. **How to apply:** copy any `test_*.py` (and `*.spec.ts`) baseline with a `.before` suffix from the start.
