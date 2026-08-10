# Fix wave for v1.0.0 - close the round-5 survivors and the nine open defects

## Context

`jupyterlab_ai_code_assistants_extension` sits at v1.0.0, uncommitted, with 40 defects closed and 11 open. The goal has not moved: a SHIP verdict from all four adversarial lenses on one clean round, without the fix-seeds-the-next-defect cycle that has run this campaign since round 1.

Round 5 was the first round whose findings had to survive attack before counting - four lenses produced 24 findings, two skeptics per lens tried to refute each, and 23 survived. Two of the survivors were CRITICAL and are already closed (`DEF-50` Kimi process identity, `DEF-51` destructive dialogs focusing Remove). Architect returned the campaign's first SHIP. What remains is 21 surviving findings plus nine open defects, and this plan closes them.

The reason to act in bulk now, which was not true in earlier rounds: every item below has been through a refutation pass or through my own verification, so the work-list is evidence rather than claims. Three claims did not survive that check and are declined below rather than silently dropped.

## Triage

### Verified before planning

- **eslint is not red.** slop-hunter's `tmp/graphify-out` finding asserts "lint gate is red now". Measured: `npx eslint . --no-cache` gives **0 errors, 54 warnings** - the standing baseline. The missing ignore is a consistency gap with `.gitignore` and `.prettierignore`, not a broken gate, and is fixed on those grounds only
- **`codex.py` comment names a function that does not exist.** Confirmed - the comment says `_list_threads`; the function is `_threads_from_db` at line 183
- **`make test` never refreshes `lib/`.** Confirmed - the target runs `jlpm test` then `pytest` with no build step, and `test_descriptor_parity.py` reads built `lib/`. The parity guard can therefore pass against yesterday's TypeScript
- **The cleanup modal really does hide its only exit.** Confirmed at `panel.ts:715` - the footer is hidden for the duration and restored in `finally`, so a hung request leaves a modal with no way out
- **No `panel.spec.ts` exists.** Confirmed - `src/__tests__/` holds colour, core-neutrality, labels, launch-mode and registry specs and nothing for the panel. slop-hunter's MAJOR is correct: six defects closed in `panel.ts` and `icons.ts` this session have no runnable test that can redden them

### Declined, with reasons

- **Delete `package-lock.json`** - the standing project rule commits it alongside `package.json`, and removing it from `make publish` forks the local Makefile from the canonical shared copy. Your call, recorded. The drift risk it names is real and is what the `mkdirp` CRITICAL was
- **Reserved separator for per-provider state filenames** - a SUSPICION, refuted by one of two skeptics, and changing on-disk filenames costs a migration to close a collision nobody has hit
- **`DEF-30` / `DEF-31`, the colour store** - unchanged from the previous plan: both need new machinery inside the object whose four rewrites caused rounds 5 through 8 of the earlier sweep

## The work - five lanes, partitioned by file

No two lanes touch the same file, so they run in parallel without conflict. `panel.ts` carries eleven items and is therefore a lane on its own, run as two sequential stages.

### Lane A - `src/core/panel.ts` and `style/base.css` (two sequential stages)

**A1, the logged defects:**

| Item       | Fix                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------- |
| `DEF-41`   | branch count and background-agent chip clipped by the name's ellipsis                     |
| `DEF-42`   | submenus draw no caret - plain Lumino `Menu` instead of `MenuSvg`                         |
| `DEF-43`   | Ok on an empty branch name is a silent no-op                                              |
| `DEF-44`   | Recent and All render the identical list below the recent limit                           |
| `DEF-45`   | `Clean Up Parallel Sessions` unmarked beside a marked Remove                              |
| `DEF-46`   | row tooltip names a launch mode on a background-agent row where the server drops the flag |
| arch queue | `open-branch` label and the popup Open title do not name the mode                         |

**A2, the round-5 UX survivors:**

- **A failed launch erases its own error** - `_openSession` calls `_showError`, then its `finally` refreshes and the refresh clears the banner. Fix by routing launch failures to `Notification.error`, matching the 404 branch three lines above it. The inline copy is wrong for this case anyway: it reads "Could not reach the server - retrying" for a launch that reached the server and failed
- **The one-click approval-bypassing launch has no warning glyph** - with an unsafe mode in force the `+` button launches directly, carrying only `addIcon`, while every menu entry for the same action carries `warningIcon`. Same remedy as `DEF-35`: the mode's glyph wins
- **The cleanup modal hides its only exit** - delete the two blocks that hide and restore the footer. Closing the dialog does not cancel the request, and a modal with no exit is worse than one dismissed early
- **The filter toggle has no `aria-pressed`** - one attribute, kept in step with `_toggleFilterBar`
- **Every row is a tab stop and one project can be three of them** - roving tabindex per section with arrow-key navigation, so a section is one stop and the arrows move within it

### Lane B - Python providers and server core

- **`DEF-47` plus bug-hunter's contested MAJOR** - the init waiter's 5s fallback execs the assistant into the 1x1 sentinel it set itself. The contested finding is the same hole reached from the other side: a client resize landing before the child's `stty rows 1 cols 1` means nothing ever changes the size again, so the poll runs out and execs at 1x1 with a real client attached. One fix closes both - restore a usable size on the timeout path before `exec`, so the worst case is a 5s stall into a working terminal rather than an unusable one
- **`routes.py` hardcodes JupyterLab's default user-settings path** rather than the configured settings directory it already holds
- **Gemini Resume silently starts a NEW conversation** when the chats directory is gone - the launch pre-flight cannot catch it, so resume must fail loudly
- **`codex.py`** - the `_THREAD_COLUMNS` comment names `_list_threads`; the function is `_threads_from_db`
- **`colour_store.py`** - the one core module with a failure path and no logger
- **`store.py`** - `default_colour`'s docstring advertises a `colour_source` precedence the core stopped implementing

### Lane C - guards and tests

- **The core-neutrality guard's assistant list is a hardcoded regex** (architect MAJOR). The invariant that core code never names an assistant stops being guarded the moment a fifth provider is added, because the regex will not know its name. Derive the list from the provider registry so the guard grows with the roster
- **The descriptor parity test discards enum values** - the one binding between the two descriptor copies drops exactly the drift class its own docstring names
- **`make test` reads a stale `lib/`** - fix inside the test, not by forking the shared Makefile: the parity test fails loudly when `lib/` is older than `src/`
- **FNV-1a and the colour vocabulary exist twice across runtimes** with nothing binding them - a differential run of 505 ids found one divergence (`"𝕏id"`). Bind them in the parity test
- **The terminal probe route's success path has zero tests** and the fake built for it is provably dead
- **`src/__tests__/panel.spec.ts`, new, after A2** - the item that matters most in this plan. `DEF-51` was proven in jsdom against the real `Dialog`, which means the panel is testable in jsdom and the six closed defects were simply never given a test. Cover both dialogs' `defaultButton`, the `+` button title after `setModes`, the branch label and icon with no visible variants, and the warning icon's size and class

### Lane D - lint config, docs, and the remaining TypeScript

- `eslint.config.mjs` - add the `tmp` ignore for consistency with `.gitignore` and `.prettierignore`; the red-gate claim did not reproduce
- `eslint.config.mjs` - `no-unused-vars` is configured against the codebase's own `_` prefix convention; 9 of the 54 standing warnings are that mismatch
- `logs/README.md` - documents two log families out of ten, and one of the two cannot exist
- `src/index.ts` - settings defaults restated as literals instead of importing the named constants; clamp bounds unnamed
- `src/core/types.ts` - `ForkStrategy` `'none'` has no producer and no consumer

### Lane E - `ui-tests/`

- **`DEF-49`** - `rm -rf .scratch` in `webServer.command` with a literal path means two Galata runs destroy each other regardless of port. Derive the scratch path per run. This one has already cost three runs across the campaign, two of architect's and one of mine
- **`DEF-48`** - Galata's `openTab` does a single `count()` with no retry and `waitForApplication` never waits for panels to dock, so the gate races the panels it asserts on
- The suite reads the developer's live Jupyter config despite advertising that it does not - proven by an unrelated import error surfacing in the server log

## Workflow shape

One workflow, sized from the work-list rather than fixed in advance: a pipeline over the five lanes, with Lane A running its two stages in sequence and the panel spec in Lane C gated on A2's completion. Seven agents, no worktrees - the file partition is what prevents conflict, and hand-merging eleven edits to one 2400-line file is where regressions come from.

Every lane agent is told: fix only its own files, run the gates it can run, mutation-check every new test against a scratch **copy** and never against git, and report what it declined and why.

After the wave returns I run the gates myself, run `graphify update`, and take a clean solo Galata run on a port nobody else holds. Round 6 - the confirming round - is a separate invocation so the results of the wave are read before the next fan-out is shaped, and its verification depth scales with how many findings come back.

## Verification

1. `pytest -q` - 150 now; the probe-success test, the parity binding and the Gemini resume guard each add to it
2. `npx jest` (82 now, plus `panel.spec.ts`) and `jlpm build:lib` exit 0
3. Three uncached lint legs - `eslint . --no-cache`, `prettier --check`, `stylelint --no-cache` - never the cached script
4. `jlpm build`, then Galata from `ui-tests/` with `ui-tests/.venv` on PATH on a free port - 20/20, plus rendered evidence for `DEF-41`, `DEF-42` and `DEF-45`
5. `acc-crit.py check --strict` - 0/0
6. Every new test mutation-checked: break the fix in a scratch copy, confirm the test reddens, restore
7. `graphify update` after the wave
8. Round 6, all four lenses, one clean round is the bar

## Constraints held throughout

Version stays 1.0.0 - no `make build`, no `make publish`, both of which increment it. Nothing committed, pushed or tagged without your word. Galata belongs to one runner at a time. The journal entry stays blocked on the plugin and library version skew until you pick a remedy.
