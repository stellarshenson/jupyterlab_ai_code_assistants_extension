export const meta = {
  name: 'fix-wave-v1.0.0',
  description:
    'Close the 21 surviving round-5 adversarial findings and DEF-41..DEF-49 in five file-partitioned lanes',
  whenToUse:
    'After a confirming round has produced a verified work-list, to close it without parallel agents colliding on one file',
  phases: [
    { title: 'Fix', detail: 'five lanes, partitioned so no two share a file' },
    { title: 'Gate', detail: 'the whole suite re-measured against the result' }
  ]
};

const REPO =
  '/home/lab/workspace/private/jupyterlab/jupyterlab_ai_code_assistants_extension';

// Every lane obeys these. The file-ownership clause is what makes the lanes
// safe to run in parallel - there is no merge step, so a stray edit outside
// your lane is silently overwritten by whichever lane owns that file.
const RULES = `
REPO: ${REPO} (v1.0.0, uncommitted, on branch main).

HARD RULES - breaking any of these fails the lane:
- EDIT ONLY THE FILES YOUR LANE OWNS. Four other agents are editing this tree right now, partitioned by file. If a fix seems to need a file you do not own, do NOT edit it - report it as a cross-lane dependency and move on.
- Do NOT edit docs/defects.md, docs/acc-crit-*.md or .claude/JOURNAL.md. Every lane would collide there. Report what you closed; the coordinator records it.
- Do NOT commit, push, tag, or change any version number. Do NOT run \`make build\`, \`make publish\`, \`jlpm build:prod\`, or anything that runs increment_version.
- Do NOT run Galata / Playwright. No lane in this run may.
- NEVER restore a file with git - the whole tree is uncommitted work and a checkout destroys it. To mutation-check, copy the file to a scratch path, edit the ORIGINAL, run the test, then restore from YOUR COPY. This exact mistake cost this campaign a whole file once already.
- Match the surrounding style. Comments in this codebase explain WHY, name the defect id, and are written for someone who will read them in a year. Terse, no marketing, no emojis, no em-dashes (use " - "), unicode arrows over ASCII.

GATES you may and should run (all read-only):
- \`cd ${REPO} && npx tsc --noEmit\` (expect exit 0)
- \`cd ${REPO} && npx jest\` (82 passing before this wave)
- \`cd ${REPO} && python -m pytest jupyterlab_ai_code_assistants_extension/tests -q\` (150 passing before this wave)
- \`cd ${REPO} && npx eslint . --no-cache\` (0 errors / 54 warnings before this wave)
- \`cd ${REPO} && npx prettier --check .\` and \`npx stylelint --no-cache "style/**/*.css"\`
Run the ones your lane can affect, before and after, and report both numbers.

EVIDENCE BAR: every fix you report as done must be backed by something you executed - a test you added that reddens when the fix is reverted, a gate that moved, or a runtime probe. "I read the code and it looks right" is not done. If you cannot verify a fix, say so plainly rather than claiming it.

DECLINING is allowed and expected. If an item is wrong, already fixed, or costs more than it closes, decline it and state the reason. A declined item with a reason is a result; a silently dropped one is a defect.
`;

const LANE_SCHEMA = {
  type: 'object',
  required: ['lane', 'closed', 'declined'],
  properties: {
    lane: { type: 'string' },
    closed: {
      type: 'array',
      items: {
        type: 'object',
        required: ['item', 'file', 'what', 'evidence'],
        properties: {
          item: { type: 'string', description: 'DEF id or finding title' },
          file: { type: 'string' },
          what: { type: 'string', description: 'the change, in one sentence' },
          evidence: {
            type: 'string',
            description: 'what you executed and what it printed'
          },
          test: {
            type: 'string',
            description: 'test added, and whether it was mutation-checked'
          }
        }
      }
    },
    declined: {
      type: 'array',
      items: {
        type: 'object',
        required: ['item', 'why'],
        properties: {
          item: { type: 'string' },
          why: { type: 'string' }
        }
      }
    },
    cross_lane: {
      type: 'array',
      description: 'fixes that need a file this lane does not own',
      items: { type: 'string' }
    },
    gates: {
      type: 'string',
      description: 'gate numbers before and after, as you measured them'
    },
    notes: { type: 'string' }
  }
};

const LANE_A1 = `You are LANE A, STAGE 1 of a five-lane fix wave.

FILES YOU OWN: src/core/panel.ts, src/core/popup.ts, style/base.css. Nothing else.
${RULES}

Close these seven logged defects. Their full text is in docs/defects.md (read it, do not edit it):

1. DEF-41 - the branch count and the background-agent chip are clipped away on long project names. The name's ellipsis eats the badges that follow it.
2. DEF-42 - the extension's submenus draw no submenu affordance. Cause: a plain Lumino \`Menu\` where JupyterLab's own menus use \`MenuSvg\`, which supplies the caret. Check that swapping it does not change anything else about how the menus render.
3. DEF-43 - Ok on an empty branch name is a silent no-op. Decide between disabling Ok while the field is empty and reporting the refusal; pick the one that matches how the rest of this panel treats invalid input, and say which and why.
4. DEF-44 - Recent and All render the identical list below the recent limit, so the two sections duplicate each other on any project with few conversations.
5. DEF-45 - "Clean Up Parallel Sessions" is destructive and unmarked, sitting beside a Remove entry that IS marked. Note that DEF-51 just gave both destructive DIALOGS \`defaultButton: 0\`; this is about the MENU ENTRY's marking, and the warning glyph is already imported in this file.
6. DEF-46 - the row tooltip promises a launch mode on a background-agent row where the server discards the flag. \`_resumeVariant()\` exists for exactly this class of question - the tooltip describes an attach, so it must use the attach-aware test, not the settings-only \`_resolvedVariant()\`.
7. The \`open-branch\` command label and the popup's Open title do not name the launch mode in force, while every sibling surface does. Reported by the architect adversary in round 4.

Report per the schema. Say plainly which of the seven you verified by execution and which only by reading.`;

const LANE_A2 = `You are LANE A, STAGE 2 of a five-lane fix wave. Stage 1 has finished and its changes are already in the file - read it fresh, do not assume its state.

FILES YOU OWN: src/core/panel.ts, src/core/popup.ts, style/base.css. Nothing else.
${RULES}

STAGE 1 REPORTED:
%%A1%%

Close these five UX findings. Each survived an adversarial refutation pass in round 5, and the file:line references were correct at the time - re-locate them, stage 1 has moved lines.

1. MAJOR - A failed launch erases its own error message before it can be read. In \`_openSession\`, the catch calls \`_showError(err)\` and the \`finally\` then calls \`_fetch()\`, whose success path clears the inline banner. The user sees an error flash and vanish. Route launch failures to \`Notification.error\` instead, matching the 404 branch three lines above it in the same catch. Note the inline copy is wrong for this case anyway - it reads "Could not reach the server - retrying" for a launch that reached the server and was refused. Check every other \`_showError\` call site for the same shape before you change the helper itself; several are poll failures where the inline banner IS right.

2. MAJOR - The one-click approval-bypassing launch is the only launch surface with no warning glyph. With an unsafe mode in force, \`_visibleVariantCount() === 0\` makes the "+" button launch directly on click, carrying only \`addIcon\`, while every menu entry for that same action carries \`warningIcon\`. DEF-35 established the remedy for this class: the mode's glyph wins. \`_variantIcon()\` and \`_variantSuffix()\` already exist and \`_renameNewButton\` is already re-run from \`setModes\`, so the icon must be re-set there too, not only at build time - that was DEF-38's whole lesson.

3. MAJOR (contested - one of two skeptics refuted it, so judge it yourself and say what you concluded) - The cleanup progress modal hides its only exit. \`_cleanupParallel\` hides the dialog footer for the duration of the request and restores it in \`finally\`. On a hung request there is no keyboard or mouse way out of the modal. The simplest fix is to stop hiding it: closing the dialog does not cancel the request, and a modal with no exit is worse than one dismissed early. Verify there is genuinely no timeout on the request path before you accept the premise.

4. MINOR - The filter toggle communicates its pressed state to sighted users only. \`filterBtn\` has no \`aria-pressed\`; add it and keep it in step with \`_toggleFilterBar\`.

5. MINOR - Every row is a tab stop, and one project can be three of them: the same project renders in Favourites, Recent and All, each row \`tabIndex = 0\`, so tabbing through the panel hits it three times. Implement roving tabindex per section - one stop per section, arrow keys moving within it. The row already carries \`role="button"\` and \`dataset.encodedPath\`, and the poll already restores focus by that dataset key, so keep that working. This is the largest item in the lane; if it cannot be done without destabilising focus restoration, say so and decline it rather than shipping a half-version.

Report per the schema.`;

const LANE_B = `You are LANE B of a five-lane fix wave: the Python server core and providers.

FILES YOU OWN: jupyterlab_ai_code_assistants_extension/core/routes.py, core/colour_store.py, core/store.py, providers/gemini.py, providers/codex.py, and the pytest files that cover ONLY those (tests/test_routes.py is owned by LANE C - do not touch it).
${RULES}

Close these:

1. DEF-47 plus a contested round-5 MAJOR, which are the same hole from two sides. \`_INIT_WAITER\` in routes.py marks its own pty 1x1, polls for that to change, and after 50 iterations gives up and \`exec\`s the assistant AT 1x1 - the exact outcome the waiter exists to prevent. The contested finding reaches it the other way: if the browser's resize lands BEFORE the child's \`stty rows 1 cols 1\`, nothing will ever change the size again, so a real attached client still ends in the 5s timeout and a 1x1 exec. One fix closes both - restore a usable size on the timeout path before \`exec\`, so the worst case is a stall into a working terminal rather than an unusable one. Do NOT reintroduce the server-side \`setwinsize\`; DEF-33 records in detail why marking must happen in the child. Prove your fix by driving a real pty with ptyprocess exactly as the route does, with and without a simulated client attach, and report the measured sizes at exec.

2. routes.py hardcodes JupyterLab's default user-settings path (\`Path(jupyter_config_dir()) / "lab" / "user-settings" / ...\`) rather than the settings directory the server is actually configured with, which it already has access to. Find what the running ServerApp exposes, prefer it, and keep the current path as the fallback so an unconfigured server behaves as it does today.

3. Gemini Resume silently starts a NEW conversation when the chats directory is gone. The launch pre-flight cannot catch it, so a resume that cannot find its chat file must fail loudly rather than opening a fresh session that looks like the old one. Match how the other providers answer a missing conversation - a 404 the panel already knows how to render.

4. codex.py - the comment above \`_THREAD_COLUMNS\` says "Columns \`_list_threads\` needs". No \`_list_threads\` exists; the consumer is \`_threads_from_db\`. One-line correction.

5. colour_store.py is the one core module with a failure path and no logger. Give it the same logger the sibling core modules use, and log where it currently swallows.

6. store.py - \`default_colour\`'s docstring advertises a \`colour_source\` precedence the core stopped implementing. Correct the docstring to what the code does; do not change the code to match the docstring without saying why.

Report per the schema.`;

const LANE_C1 = `You are LANE C, STAGE 1 of a five-lane fix wave: the cross-runtime guards.

FILES YOU OWN: src/__tests__/core-neutrality.spec.ts, jupyterlab_ai_code_assistants_extension/tests/test_descriptor_parity.py, jupyterlab_ai_code_assistants_extension/tests/test_routes.py. Nothing else - in particular you may NOT edit src/core/*.ts or the provider modules; if a guard fails because production code is wrong, report it as a cross-lane dependency.
${RULES}

Close these:

1. MAJOR (architect) - the core-neutrality guard's assistant list is a hardcoded regex. The invariant is that core code never names an assistant; the guard greps core files for the four current names. Add a fifth provider and the guard passes over a core file that names it, silently. Derive the name list from the provider registry so the guard grows with the roster instead of aging out of it. Prove it: add a throwaway name to the registry in a scratch copy and show the guard picks it up.

2. MINOR (architect) - the descriptor parity test is the only binding between the TypeScript and Python descriptor copies, and it discards enum VALUES - the exact drift class its own docstring names. Compare the values, not only the presence of the fields.

3. MINOR (architect) - three cross-runtime guards read built artifacts under lib/ that \`make test\` never refreshes, so the parity guard can pass against yesterday's TypeScript. Do NOT edit the Makefile - it is a copy of a canonical shared file and forking it is out of scope. Fix it inside the test: fail loudly, with a message naming the build command, when lib/ is older than src/.

4. MINOR (architect) - FNV-1a and the colour vocabulary are implemented twice, once per runtime, with nothing binding them. A differential run of 505 ids in round 4 found one divergence, on the input "𝕏id". Bind the two implementations in the parity test, and make sure that specific input is in the corpus.

5. MAJOR (slop-hunter) - the terminal probe route's success path has zero tests and the \`_FakePty\` built for it is provably dead code. DEF-32 added a test for the 404 path only. Cover the success path: a probe of a KNOWN terminal resolving its session and colour. Mutation-check it.

Report per the schema.`;

const LANE_C2 = `You are LANE C, STAGE 2 of a five-lane fix wave, and you carry the single most important item in it.

FILES YOU OWN: src/__tests__/panel.spec.ts (NEW - create it) and nothing else. Lane A has finished editing src/core/panel.ts; read it fresh. You may READ anything.
${RULES}

THE FINDING (slop-hunter, MAJOR, survived refutation): "Six defects closed in panel.ts/icons.ts this session and no runnable suite can redden any of them." It is correct. src/__tests__/ holds colour, core-neutrality, labels, launch-mode and registry specs and nothing for the panel, so every panel fix this campaign has made was verified by rendering it once and never again.

That the panel IS testable in jsdom is already proven: DEF-51 was demonstrated in jsdom against the real JupyterLab \`Dialog\`. So write src/__tests__/panel.spec.ts covering, at minimum:

- DEF-51 - both destructive dialogs (\`_removeProject\` and \`_cleanupParallel\`) pass \`defaultButton: 0\`, so the keyboard lands on Cancel and not on the destructive button. This is the highest-value assertion in the file: without it, one careless edit silently re-arms an Enter key that destroys project history.
- DEF-36 / DEF-38 - the "+" button's title carries the launch-mode suffix AFTER \`setModes\` runs, not only at build time. The build-time-only version is the bug that was shipped once already.
- DEF-35 / DEF-39 - the branch entry's label and icon with no visible variants: the label reads the mode suffix and the mode's glyph wins over the neutral branch icon.
- DEF-40 - the warning icon is 16x16 and carries \`jp-icon-warn0\`, not the neutral \`jp-icon3\` grey.
- Whatever Lane A stages 1 and 2 changed that you can reach: read their reports below and cover what is testable.

LANE A STAGE 1 REPORTED:
%%A1%%

LANE A STAGE 2 REPORTED:
%%A2%%

MUTATION-CHECK EVERY ASSERTION. For each, revert the fix in the production file, confirm the test reddens, then restore the production file FROM YOUR SCRATCH COPY - never from git. Report which assertions you mutation-checked and what the failure message was. An assertion you did not mutation-check is worth reporting as unverified rather than claiming.

If the panel widget cannot be constructed in jsdom without a real JupyterLab app, say so explicitly and test what you can reach directly - do not fabricate a passing suite around mocks so heavy that they assert only themselves. That failure mode is exactly what this finding is about.

Report per the schema.`;

const LANE_D = `You are LANE D of a five-lane fix wave: lint config, docs and the remaining TypeScript.

FILES YOU OWN: eslint.config.mjs, logs/README.md, src/index.ts, src/core/types.ts. Nothing else - src/core/panel.ts belongs to Lane A.
${RULES}

Close these:

1. eslint.config.mjs has no ignore for tmp/ or tmp/graphify-out, which .gitignore and .prettierignore both gained this session. NOTE: the finding claimed "lint gate is red now" and that claim does NOT reproduce - I measured 0 errors / 54 warnings with the graph present. Add the ignore for consistency with its sibling config files, and do not repeat the red-gate claim.

2. \`@typescript-eslint/no-unused-vars\` is configured \`{ args: 'none' }\`, which does not cover caught errors or variables, while this codebase's own convention is a leading underscore for deliberately-unused bindings. 9 of the 54 standing warnings are that mismatch (\`_err\`, \`error\`). Configure the rule against the convention the code actually uses, then re-measure and report the new warning count. Do NOT silence a warning that is a real unused binding - fix or report those separately.

3. logs/README.md documents two log families out of the ten present in logs/, and one of the two cannot exist. List what is actually there.

4. src/index.ts restates the settings defaults as literals instead of importing the named constants that already define them, and the clamp bounds are unnamed magic numbers. Import the constants; name the bounds.

5. src/core/types.ts - \`ForkStrategy\` carries a \`'none'\` member with no producer and no consumer, and its justification is contradicted by the field being required. Verify that with a grep across BOTH runtimes before deleting it, and report the grep.

Report per the schema.`;

const LANE_E = `You are LANE E of a five-lane fix wave: the Galata UI suite's own reliability.

FILES YOU OWN: everything under ui-tests/ (playwright.config.js, tests/shared.ts, tests/*.spec.ts). Nothing outside it.
${RULES}
ADDITIONAL: you may NOT run the suite - no Galata in this wave, for any lane. You are fixing the harness; the coordinator runs it afterwards on a free port. This is not a limitation to work around: two concurrent runs deleting each other's fixtures is literally DEF-49, the defect you are fixing.

Close these:

1. DEF-49 - \`webServer.command\` in playwright.config.js does \`rm -rf .scratch\` against a literal path, so two runs destroy each other's fixtures REGARDLESS of port. It has cost this campaign three runs. Derive the scratch path per run - from the port already in the config, or a run id - so two suites cannot alias. Check every other literal path in the config and the tests for the same aliasing.

2. DEF-48 - the gate races the panels it asserts on. Galata's \`waitForApplication\` never waits for panels to dock, and its \`openTab\` does a single \`count()\` with no retry, so a green run is partly luck. tests/shared.ts already overrides \`waitForApplication\` for a related reason - extend that pattern with a retrying tab-open helper and route the call sites through it.

3. The suite reads the developer's live Jupyter config despite the config advertising that it does not. It was proven by an unrelated extension's import error appearing in the suite's own server log. Isolate it properly and say how you verified the isolation without running the suite.

Report per the schema. Static verification only: \`node --check\`, tsc where it applies, and reading Galata's own source under node_modules for what \`openTab\` and \`waitForApplication\` actually do.`;

phase('Fix');

// Lane A owns panel.ts and runs its two stages in sequence; the panel spec is
// a third link in the same chain because it can only assert what A has left
// in the file. Every other lane is independent by file, so they run alongside.
const laneAChain = async () => {
  const a1 = await agent(LANE_A1, {
    label: 'lane-A1:panel-defects',
    phase: 'Fix',
    schema: LANE_SCHEMA
  });
  const a1Text = JSON.stringify(a1, null, 2);
  const a2 = await agent(LANE_A2.replace('%%A1%%', a1Text), {
    label: 'lane-A2:panel-ux',
    phase: 'Fix',
    schema: LANE_SCHEMA
  });
  const c2 = await agent(
    LANE_C2.replace('%%A1%%', a1Text).replace(
      '%%A2%%',
      JSON.stringify(a2, null, 2)
    ),
    { label: 'lane-C2:panel-spec', phase: 'Fix', schema: LANE_SCHEMA }
  );
  return [a1, a2, c2];
};

const lanes = await parallel([
  laneAChain,
  () =>
    agent(LANE_B, {
      label: 'lane-B:python',
      phase: 'Fix',
      schema: LANE_SCHEMA
    }),
  () =>
    agent(LANE_C1, {
      label: 'lane-C1:guards',
      phase: 'Fix',
      schema: LANE_SCHEMA
    }),
  () =>
    agent(LANE_D, {
      label: 'lane-D:config',
      phase: 'Fix',
      schema: LANE_SCHEMA
    }),
  () =>
    agent(LANE_E, {
      label: 'lane-E:ui-tests',
      phase: 'Fix',
      schema: LANE_SCHEMA
    })
]);

const reports = lanes.filter(Boolean).flat().filter(Boolean);
const closed = reports.reduce((n, r) => n + (r.closed?.length ?? 0), 0);
const declined = reports.reduce((n, r) => n + (r.declined?.length ?? 0), 0);
log(
  `${reports.length} lanes reported: ${closed} items closed, ${declined} declined`
);

phase('Gate');

// One measurement of the whole tree AFTER every lane has landed. Each lane
// measured only what it could affect and none of them saw the others' edits,
// so a lane-local green says nothing about the combined result.
const gate = await agent(
  `Re-measure every gate on ${REPO} after a five-lane fix wave. Change NOTHING - this is measurement only.
${RULES}

Run each, report the exact numbers and any failure output verbatim:
1. \`npx tsc --noEmit\` - was exit 0
2. \`npx jest\` - was 82 passing, and a new src/__tests__/panel.spec.ts should have been added
3. \`python -m pytest jupyterlab_ai_code_assistants_extension/tests -q\` - was 150 passing
4. \`npx eslint . --no-cache\` - was 0 errors / 54 warnings; the warning count was deliberately changed this wave, so report what it is now
5. \`npx prettier --check .\`
6. \`npx stylelint --no-cache "style/**/*.css"\`
7. \`node --check\` on any ui-tests JS that changed

For anything that fails, report the failing test name and its output. Do NOT fix it - the coordinator triages. Name which lane's files the failure sits in if you can tell.`,
  { label: 'gate:full-suite', phase: 'Gate' }
);

return { reports, closed, declined, gate };
