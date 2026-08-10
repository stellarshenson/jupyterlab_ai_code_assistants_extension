# Round 6 triage - stop the fix-induced defect cycle

## Context

Round 6 returned 1 SHIP and 3 DO-NOT-SHIP, with 18 findings surviving two skeptics each. The reflex response is a sixth fix wave. The ledger says that is the wrong move.

Scanning all 75 defect entries for one that names a prior fix as its cause returns **11**. Their causing fixes were mostly trivial:

| Causing fix                                           | Its severity | What it spawned                             |
| ----------------------------------------------------- | ------------ | ------------------------------------------- |
| DEF-26 - popup rows "semantically anonymous"          | MINOR        | DEF-27 CRITICAL, DEF-28 MAJOR, DEF-29 MAJOR |
| DEF-35 - branch item "names no verb, carries no icon" | MAJOR        | DEF-39 MAJOR                                |
| DEF-36 - `+` button "never names the mode"            | MINOR        | DEF-38 MINOR                                |
| DEF-60 - guards read stale build artifacts            | MINOR        | DEF-75 MINOR                                |
| DEF-31 - fork inherits old colour in a 30 s window    | MINOR        | DEF-74 MINOR                                |
| DEF-12 - colour entries dropped on failed delete      | MINOR        | DEF-23 MINOR                                |

Six of the nine causing fixes were MINORs. The worst offender was cosmetic: correcting the accessible name of a popup row spawned a CRITICAL and two MAJORs. The guard chain is the same story one level up - DEF-60 added a freshness guard, its fix became DEF-75, and DEF-75's fix produced round 6's silent false negative. Three rounds of machinery protecting machinery, ending in a guard that certifies stale output without saying so.

Campaign-wide the fix-induced rate is 15%. In the last wave it was 50%. **Fixing more is what makes it worse.**

Three impact agents then scoped the MAJORs against the rebuilt graph (1,861 nodes / 3,102 edges). Every one was downgraded or refuted, and in each case the reviewer had the mechanism wrong. What survives is **two lines of code**.

## The rule this plan applies

Code is touched only when all three hold:

1. A user can hit it, or a guard is silently green when it should be red
2. The change **removes or corrects** rather than adds - no new fields, no new state, no new parser
3. The blast radius is bounded and named from the graph before the edit

Everything else is logged in `docs/defects.md` and left alone. A MINOR is logged, not fixed. A finding about the phrasing of a comment that is _true_ is not a finding.

## What gets changed

### The two lines

`src/core/panel.ts:995` and `:1044` route a refused branch through `_showError`, which says "Could not reach the server - retrying." The server was reached, it refused, and nothing retries - both sites `return` inside their catch. Three of the four assistants get this: codex through `_branchByNativeCommand`, gemini and kimi through `_branchByServerCopy`. Claude does not, because `_branchByNativeFlag:968` already calls `_showActionError`.

Both lines become byte-identical to that working sibling:

```
this._showActionError('Could not branch this session - try again.', err);
```

**`_showActionError`, not `_notifyLaunchError`.** The latter switches surface from banner to toast, and its docstring justifies that by the refetch-in-`finally` flash - which neither of these two sites has. Using it would be a behaviour change wearing a copy fix's clothes.

This is DEF-53 landing half-way: its note names both the flash and the copy, fixes the flash at two sites, and says the other two were "deliberately left alone" - true of the flash, silent about the copy.

Blast radius, from the graph: `_showActionError` reaches only `_setInlineError`, which reaches nothing. No test in `src/__tests__/` or `ui-tests/` asserts any of these strings.

### Three false comments

Each asserts the opposite of what the code has done since DEF-72. A false comment is worse than none - it is what the next reader plans against.

- `src/core/panel.ts:767-768` - "the request has no timeout either"
- `src/core/panel.ts:2393` - "`requestAPI` sets no timeout"
- `src/core/request.ts:24-25` - reads as though N-scaling callers pass their own signal. None does; the hatch exists and is unused. Reword to say so, with the measured thresholds.

## What gets logged and not fixed

Seven entries, `DEF-76` onward, written from the impact reports rather than the round-6 titles - the reports corrected the reviewers on every one.

- **`_showError` copy is false at three more sites** - `:806` cleanup (already writes its own message into the modal), `:2053` and `:2075` (JupyterLab command rejections, no server involved). Left out to keep this round's diff at two lines in one function pair.
- **Tint survives disabling a provider.** Real, and narrower than reported - the reviewer's line and mechanism are both wrong. Disabling writes the setting to disk _before_ the panel disposes, so the server answers 404 and the `clearColours()` that fires on dispose cannot resolve what to clear. Dies on reload, no data affected. The fix needs a new `Set` of widget references - new retention, new state, and `clearColours` has zero test coverage today.
- **The N-scaling DELETE ceiling.** Effectively refuted. Three DELETE sites scale with N, and only Codex shells out per conversation. At the measured 0.7 s per invocation a breach needs **86 conversations in one project**; at 70 ms, 858. A breach costs a spurious toast, not data - the server thread runs to completion, the colour drop still executes, retry is idempotent.
- **The freshness guard is disarmed by `tsc --noEmit`.** Confirmed by my own measurement. **Fix the cause, not the detector:** three plan files under `.claude/plans/` instruct `npx tsc --noEmit` as a verification step, which is what disarms it - amend them to `jlpm build:lib`. CI is unaffected either way, because `pip install .[test]` builds `lib/` before pytest runs. Adding a parser for `affectedFilesPendingEmit` - a private TypeScript structure whose rename would degrade to a silent green - is the next link in exactly the chain that produced this defect.
- **core-neutrality's comment stripper** truncates a line at a `//` inside a string. Nine lines in `icons.ts` are affected, all `http://` inside an SVG template literal, and none is behind a real violation. The fix is a 30-line character scanner inside a guard that has nothing to catch. Also logged: the block-comment strip eats newlines, so a real violation would be reported about 141 lines off in `panel.ts`.
- **`isRequestTimeout` has no production consumer.** Correcting the reviewers, who said the whole surface was dead: `RequestTimeoutError` _is_ thrown and does reach users. Only the predicate is unused. Resolve it with a single deliberate pass over all three error helpers, not by bolting a second string onto `_showError` while the branch copy is mid-flight.
- **`MigrateHandler.post` runs synchronously on the IOLoop** while every other route uses `run_in_executor`. Not a timeout risk; a latent inconsistency.

Not logged as defects, recorded as the next campaign: the completeness critic's five unrun modalities - specs never type-checked, no Python static analysis, packaging never rehearsed at 1.0.7, CHANGELOG stopped at 0.6.17, migration never executed end to end.

## Workflow shape

The code change collapsed to two lines, so the workflow is sized to what is left rather than to the original list. Three agents, file-partitioned, no two touching the same file.

- **Lane 1** - `src/core/panel.ts` and `src/core/request.ts`: the two substitutions and the three comment corrections. Told explicitly: if the minimal change requires adding state, stop and report rather than improvise
- **Lane 2** - `docs/defects.md` and the three `.claude/plans/*.md` verification steps: the seven ledger entries and the `tsc --noEmit` amendment. This is the bulk of the writing
- **Gate** - re-measure every gate uncached, confirm neither lane moved the other's file

## Verification

1. `pytest -q` - 163 now
2. `npx jest` - 119 now
3. `jlpm build:lib` - emits, so it refreshes `lib/` honestly. Deliberately not `npx tsc --noEmit`, which refreshes the buildinfo without emitting and is what `DEF-79` logs as the guard-disarmer
4. Three uncached lint legs, never the cached script
5. `acc-crit.py check --strict` 0/0
6. Galata is **not** re-run - no lane touches a rendered surface
7. `graphify update` after the wave
8. One patch bump via `make increment_version`, `package-lock.json` synced

No round 7. The diff is two lines, three comments and a ledger - none of it is reviewable surface, and a review run past its stopping condition manufactures findings. Gates only.
