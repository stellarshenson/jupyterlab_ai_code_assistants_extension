---
name: mutation-restore-keeps-mtime
description: In a mutation re-check, back up and restore src/ files with cp -p so the pytest lib-freshness guard stays green without another make build; the Python schema test can only be mutated through the generator plus two builds
metadata:
  type: project
---

Back up and restore a mutated `src/` file with `cp -p`, not plain `cp`. `cp -p` keeps the original modification time, so `lib/index.js` stays newer than every file in `src/` and the pytest guard for a stale `lib/` still passes. The Edit tool also accepts the restored file without a new Read.

**Why:** A plain `cp` restore gives the file a new modification time. The pytest guard then fails until another `make build`, and `make build` has side effects in `/opt/conda` and contacts the registries (see [[make-build-side-effects]]). On 2026-10-09 a verifier ran 40 mutations on `src/core/panel.ts` and `src/index.ts` with `cp -p` restores and needed no rebuild for them.

**How to apply:** Copy the pristine file once with `cp -p` before the first mutation, restore with `cp -p` after each jest run, and confirm with `diff`. Compare `git diff HEAD | sha256sum` before and after the whole session. `test_settings_schema.py` reads the generated `schema/plugin.json`; when a brief forbids editing that file by hand, mutate `scripts/generate-schema.mjs`, run `make build`, run the test, restore the generator and run `make build` again - two builds for one Python mutation.
