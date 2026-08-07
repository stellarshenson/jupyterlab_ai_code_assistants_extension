# Fix batch 3 - triaged orders from round-2 confirming reviews

Source reports: `bug-hunter-round2.txt`, `ux-designer-round2.txt` (this directory). Architect
round 2 = SHIP (closed, no orders). Four findings, all MINOR, all fix-introduced regressions
from batches 1-2. Apply exactly - do not widen.

## Orders

1. [bug-hunter 1] Whole-project delete honesty for partial-success stores: `remove()` on the
   store contract reports the ids that actually went (codex already computes the list at
   codex.py:633 and throws it away - return it). `core/routes.py:344-358` hands exactly those
   ids to `drop_colours` and emits them as `removed_ids`, instead of the pre-read `known` list.
   Atomic stores (claude/kimi/gemini - one directory disposal) keep their current
   all-or-nothing semantics: report all known ids on success, none on failure;
   `removed_count` semantics for them unchanged. Pytest: a codex remove where one thread
   survives keeps the survivor's colour and omits it from `removed_ids`.

2. [bug-hunter 2] Gemini `owns_pid` argv match is a bare substring (`gemini.py:845`,
   `b"gemini" in cmdline.lower()`) - runtime-proven to claim `node /tmp/my-gemini-app/server.js`.
   Match the bundle, not the substring: an argv ELEMENT whose basename is `gemini` or that ends
   with `/gemini.js` (the installed CLI bundle path). Update the existing pytest pair so the
   bundle-path case still claims and add a case: node with a gemini-substring PROJECT path in
   argv is NOT claimed.

3. [ux 1] Launch-mode settings copy states the inverse of the implemented precedence -
   `src/providers/gemini.ts:71` (schema/plugin.json:75 is GENERATED - fix the TS source only,
   regen flows through the build chain). Reword to the actual rule, e.g.: "Passed when set to a
   value other than the default. A non-default value here takes precedence over the YOLO
   switch; only the forced YOLO menu action overrides it." Architect independently endorsed
   this clause shape.

4. [ux 2] Popup switch rows semantically anonymous - `src/core/popup.ts:332-338`: add
   `role="button"` and the same Space-key branch the panel rows use (panel.ts:1374-1378
   pattern: Space triggers switch, scroll suppressed). Keep Enter behaviour as is.

## Declined this round (do not touch)

- Architect residual: inline codex `LEGACY_STATE_FILENAME` - taste, architect is at SHIP;
  churn without a correctness gain
- test_descriptor_parity `_mode_tokens` stripping `=value` (bug-hunter "tested and cleared"
  note) - test-coverage gap only, no live drift; not ordered

## Finish bar

`make build` exit 0 (NEVER `make install` - the system Python is frozen; wheel goes nowhere
except ui-tests/.venv), `make test` exit 0, `npx eslint src` no new errors, force-reinstall
the fresh wheel into ui-tests/.venv and Galata all green. Verify schema/plugin.json regenerated
with the new wording (build chain does it). Register-and-close the four findings via
defects.py against docs/defects.md (next free DEF numbers after DEF-22), dated notes.
Return: files changed, test counts, DEF numbers, any deviation.
