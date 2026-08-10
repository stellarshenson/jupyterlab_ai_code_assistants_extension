# Closing the adversarial-review defects for v1.0.0

## Context

`jupyterlab_ai_code_assistants_extension` is at v1.0.0, uncommitted, and the goal is a SHIP verdict from all four adversaries (architect, ux-designer, bug-hunter, slop-hunter). Round 3 is now complete for all four. Slop-hunter's 16 findings were triaged and closed earlier in this session; bug-hunter round 3 returned six, one of them a CRITICAL that reaches beyond this extension into the whole Jupyter server, and one a MAJOR regression introduced by my own round-2 fix.

Two facts drive the ordering below. First, the pty-resize fix I added in round 2 to kill a 5 s launch stall is itself racy - measured 1-in-5 launches exec the assistant into a 1x1 terminal. Second, the terminal probe route calls a terminado API that creates what it fails to find, so a single probe of a stale name breaks `GET /api/terminals` for every client of the server until restart. Neither is visible from the panel, and both are runtime-proven rather than inferred.

The intended outcome: every confirmed finding closed, no new ones introduced, each change bounded by a graphify blast radius before it is made, and a confirming round from all four adversaries that returns SHIP.

## Findings being closed

| #   | Sev      | What                                                                                                                                                                                     | Where                                            |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| N-1 | CRITICAL | Probe route uses get-**or-create** `get_terminal`; a stale name spawns a ghost pty with no `last_activity`, so `TerminalManager.list()` raises and `GET /api/terminals` 500s server-wide | `core/routes.py:811`                             |
| N-2 | MAJOR    | Server-side `setwinsize(1,1)` races the init waiter's SIGWINCH trap; the assistant can exec into a 1x1 pty with no client attached                                                       | `core/routes.py:753-757` vs `_INIT_WAITER:44-54` |
| N-3 | MAJOR    | Flattened branch item reads `Default (Bypass Approvals)` or bare `Normal` - no verb, no branch icon - and forks with no dialog on Codex                                                  | `panel.ts:2100-2108`, `:1978-1983`               |
| N-4 | MINOR    | `+` button's direct-execute path never names the launch mode it carries                                                                                                                  | `panel.ts:309-315`, `:324-330`                   |
| N-5 | MINOR    | `model["name"]` subscript sits above the dict-or-object defence, inside an `except` that omits `TypeError`                                                                               | `core/routes.py:753-757`                         |
| S-1 | MINOR    | `'No favorites yet.'` is unreachable - the section only renders when a favourite exists or a filter is active                                                                            | `panel.ts:1400-1405`                             |
| S-2 | MINOR    | `reconcileColours` swallows every failure with no trace, against the project's `LOG_PREFIX` convention                                                                                   | `terminals.ts:379-389`                           |
| S-3 | MINOR    | DEF-31's reproduction cites rotted line numbers in an OPEN defect                                                                                                                        | `docs/defects.md:115`                            |

N-6 (contradicting `refresh()` comments) is already closed this session, as are all 16 slop-hunter items except the two declined below.

## Approach

### 1. Remove the resize race by moving the sentinel into the child (closes N-2 and N-5)

The current design has the server mark the pty 1x1 after `create()` while the child concurrently captures a baseline and traps SIGWINCH. Two processes, no ordering guarantee - which is the race. Bug-hunter's measurements show the bad side lands whenever the server is ~5 ms slower than bash startup.

Make the child own both halves. `_INIT_WAITER` sets its own size first, then polls for it to change:

```
stty rows 1 cols 1; loop until `stty size` != "1 1", or 5 s; clear; exec "$@"
```

Marking and polling then happen in one process, in order, so no interleaving exists. The SIGWINCH trap and the `R0 C0` baseline go away with it - neither is needed once the sentinel is absolute rather than differential. A browser client never renders 1x1, so every attach is a real change; this is strictly stronger than the old 24x80 comparison it replaces.

The server-side resize block at `routes.py:748-757` is then deleted whole, which removes the `model["name"]` subscript and closes N-5 with no separate edit.

**Verify before committing to it**: confirm `stty rows 1 cols 1` succeeds on the child's own tty under `bash -c` with no controlling terminal surprises. If it does not, fall back to passing `dimensions=` through to `PtyProcessUnicode.spawn` and leave the waiter differential.

### 2. Stop the probe route creating terminals (closes N-1)

Replace the get-or-create call with a membership lookup, which makes the existing 404 branch live for the first time:

```python
terminal = getattr(terminal_manager, "terminals", {}).get(terminal_name)
```

`_FakeTerminalManager` in `tests/test_routes.py` must grow a real `terminals` mapping so the fake models the failure rather than hiding it - the same discipline the `_FakePty` winsize assertion already follows. New test: probing an unknown name answers 404 **and** leaves `terminal_manager.terminals` empty.

### 3. Give the flattened branch item its own identity (closes N-3)

`_cmd('branch-session')` serves two positions - inside the submenu, and at top level when `_visibleVariantCount() === 0`. Its label and icon are already functions, so both can branch on that same predicate: at top level it reads `Branch Session` plus the variant suffix and wears `branchIcon`; inside the submenu it keeps `Normal` / `Default (…)` under the submenu title that already names the verb.

This also cures the bare-`Normal` rendering bug-hunter found on Claude rows holding a live background agent, where `_resolvedVariant()` is null-guarded but `_buildsSameLaunch` is not. The underlying guard asymmetry stays as it is - the visible symptom is what the finding is about, and widening the guard is a change no finding asked for.

### 4. Name the mode on the `+` button (closes N-4)

Append `_variantSuffix()` inside `nameNewButton` at `panel.ts:309-315`, so the tooltip matches what the dropdown item said before the single-entry collapse replaced it.

### 5. Three small closures

- delete the unreachable `'No favorites yet.'` arm, leaving the two states that can render
- log the swallowed failure in `reconcileColours` with the existing `LOG_PREFIX` convention from `core/registry.ts`; leave `clearColours` silent, which has nothing to report
- correct DEF-31's cites to `panel.ts:845` and `_inheritColour` at `:1012`

### Declined, with reasons

- **`launch-mode.spec.ts:87-92`** (slop-hunter, delete as redundant) - its mutation table only covers mutants of today's delegating implementation. The assertion guards precedence at the surface the panel actually calls, and an inlined reimplementation of `resolvedLaunchModeEntry` would break precedence with only this test to catch it.
- **`README.md:80`** (slop-hunter, duplicate of `:44`) - it sits inside `## Migrating from the standalone extensions`, which a reader lands in directly during an upgrade without having read the feature list 36 lines above.
- **UX row-tooltip and 13x13 caution-triangle findings** - not reproduced. `_buildRowTooltip` reads its `s` argument throughout, and `style/base.css` carries no warning rule at all. Both go back to the ux-designer for evidence in the confirming round rather than being coded against unverified claims.

## Blast-radius discipline

Before each edit, `graphify affected "<symbol>" --graph tmp/graphify-out/graph.json` establishes the budget; anything outside it is out of scope. Known limitation carried forward: the graph models cross-file edges only, so an empty result for an intra-file helper is not evidence of no caller - grep confirms those. Full `graphify update` after the Python batch and again after the TypeScript batch.

## Files

- `jupyterlab_ai_code_assistants_extension/core/routes.py` - waiter, deleted resize block, probe lookup
- `jupyterlab_ai_code_assistants_extension/tests/test_routes.py` - `_FakeTerminalManager.terminals`, ghost-terminal test, winsize assertion follows the waiter change
- `src/core/panel.ts` - branch label and icon, `+` tooltip, favourites empty state
- `src/core/terminals.ts` - one logged catch
- `docs/defects.md` - DEF-32..DEF-35 for the four new defects, DEF-31 cite correction

## Verification

1. `python -m pytest jupyterlab_ai_code_assistants_extension/tests -q` - expect 149 plus the new ghost-terminal test
2. `npx jest` (82) and `jlpm build:lib` (exit 0)
3. `npx eslint . --no-cache`, `npx prettier --check`, `npx stylelint --no-cache "style/**/*.css"` - run as three legs, not through the cached script, since a cached green has hidden a real failure before
4. **N-2 runtime proof**: re-run bug-hunter's harness - 20 trials against a real pty with `_wrap_with_init`, asserting 0/20 exec below a usable size, and no launch slower than ~2 s at a 24x80 client
5. **N-1 runtime proof**: probe an unknown name against a live `TerminalManager`, assert `terminals` stays empty and `list()` still succeeds
6. Galata `ui-tests/` in `ui-tests/.venv` - 20/20, plus a screenshot of the collapsed context menu and the `+` tooltip, since UI claims need rendered evidence
7. `acc-crit.py check --strict` and `journal-tools check`
8. Confirming round: all four adversaries re-run against the fixed tree, pinned to the findings above. SHIP from all four is the bar; two consecutive clean verdicts is the stopping condition, and the review stops there.

Version stays 1.0.0 - no `make build`/`make publish`, which would increment it. Nothing is committed without explicit approval.
