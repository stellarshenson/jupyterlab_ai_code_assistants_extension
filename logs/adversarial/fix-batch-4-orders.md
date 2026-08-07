# Fix batch 4 - triaged orders from ux-designer round 3

Source report: `ux-designer-round3.txt` (this directory). Bug-hunter and architect are closed at
SHIP - their files are NOT to be touched. Three findings, all regressions from batch-3 fix 2,
all confined to the branch-row block of `src/core/popup.ts`. The reviewer's structural remedy
collapses them; apply it as ONE change, do not widen.

## Orders

1. [CRITICAL + MAJOR nested-interactive, one structural fix] Move the switch affordance OFF the
   row and onto a dedicated element: the label span (popup.ts:280) hosts `role="button"`,
   `tabIndex = 0`, and the Enter/Space keydown (preventDefault, scroll suppressed). The row
   loses role/tabIndex/keydown and returns to a plain container. Row click-to-switch mouse
   behaviour stays as it was. This restores native keyboard operation of the checkbox
   (popup.ts:249) and the Open/Copy buttons (popup.ts:141-153) and clears the ARIA
   nested-interactive violation.
2. [MAJOR] Busy-lock parity: the new keydown opens with `if (deleting) return;` mirroring the
   panel's `if (removing) return;` (panel.ts:1371) - the jp-mod-busy pointer-events CSS does not
   block keyboard, per popup.ts's own comment.

## Declined / out of scope

- Everything previously CLOSED or ruled by any adversary. No other file, no other block.

## Finish bar

`make build` exit 0 (NEVER `make install` - system Python frozen; wheel only into
ui-tests/.venv), `make test` exit 0, `npx eslint src` no new errors (baseline 0/51),
force-reinstall wheel into ui-tests/.venv, Galata all green (16/16). Register-and-close the
three findings via defects.py in docs/defects.md (next free numbers after DEF-26, category
"Panel and settings UX"), dated notes; defects.py check clean.
Return: diff summary, test counts, DEF numbers, any deviation.
