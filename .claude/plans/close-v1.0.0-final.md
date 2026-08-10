# Closing v1.0.0 - the last two defects, the rendered proof, and the final round

## Context

The fix wave closed 20 defects and every gate is green: pytest 163, Jest 103, `tsc` 0, eslint 0 errors / 43 warnings, prettier and stylelint clean, acc-crit 0/0. Sixty-nine defects are closed and two remain, both in the colour store, both deferred since round 8 of the earlier sweep.

Three things stand between this tree and a ship verdict, and this plan takes all three.

**The two open defects have a prerequisite that is now identified.** `DEF-30`'s deferral note named it exactly: "a serialisation chain needs a bounded request first, which is a change to the shared request helper rather than to this store". The fix wave re-confirmed that fact independently and from a different direction - Lane A2, judging the cleanup-modal finding, verified that `src/core/request.ts` has no `AbortController`, no signal and no timeout, and that `ServerConnection.makeRequest` beneath it has none either. The same missing bound is behind both. Fix it once and both defects become tractable.

**Four visual claims are owed a screenshot.** `DEF-41`, `DEF-42`, `DEF-54` and `DEF-55` are verified structurally under jsdom, which performs no layout and no painting. Three separate agents declined to assert the visual half rather than claim it. The project rule is explicit: a panel, menu or icon is never stated to render correctly without a screenshot from a running JupyterLab.

**Galata has not run since the harness was rewritten.** Lane E keyed every run directory by port and moved the `HOME` redirect into `webServer.env`, and none of it has been exercised - no lane was permitted to, which is what `DEF-49` is about.

## Graph-led scope

`graphify affected` over the three touched symbols, against the graph refreshed after the wave (1,779 nodes, 3,010 edges):

- **`requestAPI`** - the single choke point. All 24 production call sites across `index.ts`, `panel.ts`, `colour.ts` and `terminals.ts` funnel through it, so the timeout lands in one function and reaches everything. Grep-verified rather than taken from the graph, which does not model intra-file calls
- **`ColourStore`** - consumers are `panel.ts`, `terminals.ts`, `popup.ts` and the two specs. That is the change budget; anything outside it is out of scope

**One number the graph does not give and the change turns on:** `codex.py` sets `_CLI_TIMEOUT_S = 30`, so a fork can legitimately keep the server busy for thirty seconds. A client timeout below that breaks branching for Codex. The bound must sit above it - 60s - and the reason belongs in the comment, or the next person tunes it to the fast path and breaks forking.

## The work

### 1. Bound the request - `src/core/request.ts`

Give `requestAPI` a default timeout via `AbortController` plus a timer, applied only when the caller passes no `signal` of its own. Hand-rolled rather than `AbortSignal.timeout`, whose availability under the jsdom the Jest tier runs on is not something to assume. A timeout must surface as a distinguishable error, not as a generic network failure, because `panel.ts` already branches on error shape.

This is a fix in its own right, not only a prerequisite: it is the hazard that made `DEF-55`'s modal trap real.

### 2. Serialise the colour store - `DEF-30`, `src/core/colour.ts`

Replace the hand-rolled ordering with a `_run(op)` promise chain, then delete what becomes unconstructible: `_writeSeq`, `_writeStart`, `_readSeq`, `_readAbsorbed`, and the `_openWrite` / `_closeWrite` / `_current` helpers - 23 references across a 413-line file.

**Every deleted test needs its state proven unreachable, not asserted to be.** `colour.spec.ts` is 516 lines at 93.98% statement coverage and its interleaving tests describe real states today. The bar is the one this campaign has used throughout: show the state cannot occur, then delete the test that describes it.

`_pending` and `isPending` stay - `forget()` reads them, and they are the seed of step 3.

### 3. Settle before the fork - `DEF-31`, `src/core/panel.ts`

With a serialised store, "await the pending write" is one chain step rather than the new settlement API the deferral priced. `_branchSession` awaits settlement before snapshotting the parent's tint, so a colour set moments earlier is on the wire and confirmed before the branch inherits.

### 4. Build, install, and run Galata

**Measured, because it decides whether the screenshots mean anything:** the venv does NOT hold the current code. Its install is a regular wheel, not editable - `ui-tests/.venv/share/jupyter/labextensions/.../static/` is a real directory dated **07:53**, not a symlink into the source tree - and eight source files have been written since, including `panel.ts`, `colour.ts`, `icons.ts`, `terminals.ts` and `index.ts`. The source build at `jupyterlab_ai_code_assistants_extension/labextension/static/` is itself dated 09:01, before the fix wave finished.

Running the suite as-is would photograph the pre-wave panel. Every one of the four screenshots is of a change the wave made, so a green run against 07:53 assets is a false confirmation - the worst possible outcome here, because it looks like proof.

So: `jlpm build` to rebuild the labextension, then `ui-tests/.venv/bin/pip install --force-reinstall --no-deps .` to refresh the test environment. **A stated deviation from the Makefile-only rule, forced by the version freeze:** `make install` depends on `make build`, which runs `increment_version` (bumping off 1.0.0) and `clean` (wiping `lib/`). Hatch reads the version from `package.json`, so a direct install preserves 1.0.0.

Then the suite from `ui-tests/` on a port nobody else holds, output redirected rather than piped - a pipe reports `tee`'s exit status, so a suite whose server never started reads as a pass. That mistake is already in this campaign's record.

### 5. The four screenshots

Against the running test server: a long-named row showing both badges (`DEF-41`), a submenu drawing its caret (`DEF-42`), the `+` button wearing the warning glyph with an unsafe mode armed (`DEF-54`), and the cleanup modal with its Close button present (`DEF-55`). Each closure note gets the result, including a negative one.

### 6. Round 6 - the confirming round

Four lenses, two skeptics each, the round-5 shape - the first shape that produced a work-list worth acting on in bulk. Architect returned SHIP at round 5, so this measures whether the wave held rather than reopening settled ground. One clean round from all four is the bar.

## Workflow shape

**Two invocations, not one**, because steps 4 and 5 are mine and must sit between them.

**Workflow A - the colour store chain.** Strictly sequential: bounded request → serialisation → fork settlement. Each stage reads the tree the previous one left. No parallelism is available here and none should be faked: all three touch the same two files. A fourth agent re-measures every gate afterwards, since no stage sees the others' edits. Four agents.

Then I build, install, run Galata and take the screenshots - single-threaded by necessity, and the one part of this plan that cannot be delegated, because only one runner may hold the port.

**Workflow B - round 6.** Four lenses in a pipeline, each finding refuted by two skeptics as soon as its lens reports, then synthesis and a completeness critic. Sized from what comes back rather than fixed in advance: a lens returning nothing spawns no verifiers. About 13 agents.

Both scripts are persisted in `.claude/workflows/` and the plan in `.claude/plans/`, so a container restart resumes from disk rather than from session state.

## Verification

1. `pytest -q` - 163 now; the request bound and the settlement each add to it
2. `npx jest` - 103 now; deleted colour tests must be replaced by proof, not by absence
3. `jlpm build:lib` exit 0
4. Three uncached lint legs, never the cached script
5. `npx tsc --sourceMap` before pytest - the new freshness guard fails the parity tests against a stale `lib/`, by design
6. Galata from `ui-tests/` on a free port, output redirected, plus the four screenshots
7. `acc-crit.py check --strict` 0/0
8. Every new test mutation-checked against a scratch copy, never against git
9. `graphify update` after the chain
10. Round 6 - one clean round from all four lenses

## Constraints held throughout

Version stays 1.0.0. No `make build`, no `make publish`, no `make install`. Nothing committed, pushed or tagged without your word. Galata belongs to one runner at a time. The journal entry stays blocked on the plugin and library version skew until you pick a remedy.

## The risk, stated plainly

The colour store is the object whose four rewrites caused rounds 5 through 8 of the earlier sweep, and this plan rewrites it a fifth time. Three things are different, and if they turn out not to be, the honest move is to stop and leave both defects deferred: the prerequisite is identified rather than discovered mid-change; the change **deletes** machinery where every earlier one added it; and the tier that was missing then - a panel suite that can redden a regression - exists now at 103 tests.
