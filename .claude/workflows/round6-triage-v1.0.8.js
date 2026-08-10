export const meta = {
  name: 'round6-triage-v1.0.8',
  description:
    'Land the round-6 triage: two error-helper substitutions, three false comments corrected, seven log-only defect entries',
  whenToUse:
    'After a review round whose findings were scoped by impact agents and mostly declined - when the deliverable is a small diff plus an honest ledger',
  phases: [
    { title: 'Land', detail: 'two file-partitioned lanes, no shared file' },
    { title: 'Gate', detail: 'every gate re-measured uncached' }
  ]
};

const REPO =
  '/home/lab/workspace/private/jupyterlab/jupyterlab_ai_code_assistants_extension';

// The governing constraint, and the reason this wave is two lines rather than
// eighteen fixes. 11 of 75 defects in this project were created by a previous
// fix, and six of the nine causing fixes were MINORs - one cosmetic MINOR
// (DEF-26) spawned a CRITICAL and two MAJORs. Every lane is told this.
const RULES = `
REPO: ${REPO} (v1.0.7, entirely uncommitted).

WHY THIS WAVE IS SMALL - read before you touch anything:
Round 6 returned 18 surviving findings. Three impact agents scoped them and every MAJOR was downgraded or refuted, with the reviewer wrong about the mechanism each time. 11 of this project's 75 defects were CREATED by a previous fix, and six of the nine causing fixes were MINORs. The fix-induced rate was 15% campaign-wide and 50% in the last wave. So the approved plan fixes two lines and logs the rest.

HARD RULES:
- Change ONLY the files your lane names. Another lane owns the others and you will collide.
- Do NOT "improve" adjacent code, comments or formatting. Every changed line must trace to an item in your lane.
- Do NOT add a field, a helper, a parameter, a class or a test double. If your minimal change needs new state, STOP and report it unlanded rather than improvising - that is the exact behaviour that produced this defect ledger.
- Do NOT run \`make build\`, \`make install\`, \`make publish\` or \`jlpm build:prod\` - \`make build\` runs increment_version AND clean.
- Do NOT run Galata / Playwright. Nothing in this wave touches a rendered surface.
- Do NOT commit, push or tag.
- Never restore a file with git - the tree is uncommitted with no commit behind it. Use a scratch COPY under /tmp.
- Run \`npx prettier --write\` on any file you edit before you finish; CI's prettier glob includes **/*.md.

BASELINES (must still hold when you finish): pytest 163 passed; \`npx jest\` 119 passed / 7 suites; \`npx tsc --noEmit\` exit 0; \`npx eslint . --no-cache\` 0 errors / 43 warnings; prettier clean; stylelint clean.
`;

const LANE_SCHEMA = {
  type: 'object',
  required: ['landed', 'files', 'notes'],
  properties: {
    landed: {
      type: 'array',
      description: 'One entry per item you actually changed',
      items: {
        type: 'object',
        required: ['item', 'file', 'what'],
        properties: {
          item: { type: 'string' },
          file: { type: 'string', description: 'path:line' },
          what: { type: 'string', description: 'the change, in one sentence' }
        }
      }
    },
    unlanded: {
      type: 'array',
      description:
        'Items you deliberately did NOT land, with the reason. An empty array means you landed everything.',
      items: {
        type: 'object',
        required: ['item', 'why'],
        properties: { item: { type: 'string' }, why: { type: 'string' } }
      }
    },
    files: {
      type: 'array',
      items: { type: 'string' },
      description: 'Every file you wrote to'
    },
    notes: { type: 'string' }
  }
};

const LANE_1 = `
LANE 1 - src/core/panel.ts and src/core/request.ts. You own these two files and nothing else.

ITEM 1 (code, 2 lines). \`panel.ts:995\` and \`panel.ts:1044\` both call \`this._showError(err)\` on a REFUSED branch. \`_showError\` (panel.ts:604) emits "Could not reach the server - retrying." - the server was reached, it refused, and nothing retries: both sites \`return\` inside their catch. Replace each with EXACTLY:

    this._showActionError('Could not branch this session - try again.', err);

That string is not invented - it makes both sites byte-identical to the already-correct sibling at \`panel.ts:968\` (\`_branchByNativeFlag\`, the claude path). Read line 968 and copy it.

Use \`_showActionError\`, NOT \`_notifyLaunchError\`. The latter switches surface from inline banner to toast, and its docstring justifies that by the refetch-in-\`finally\` flash which neither of these two sites has. Switching surface would be a behaviour change wearing a copy fix's clothes.

Do NOT touch the other five \`_showError\` call sites (240, 806, 2053, 2075, 2555). Two are poll/refresh paths where "retrying" is TRUE; the other three are logged as a defect by lane 2 deliberately.

ITEM 2 (comment). \`panel.ts:767-768\` reads "Closing early cancels nothing (the request has no timeout either)". FALSE since DEF-72 bounded requestAPI at 60s. Correct the parenthetical only - the surrounding paragraph about Escape and the hidden button is right and must not be rewritten.

ITEM 3 (comment). \`panel.ts:2393\` reads "\`requestAPI\` sets no timeout, so a suspended connection would otherwise cost the user...". FALSE for the same reason. The paragraph's POINT still stands - the menu budget is much shorter than the request ceiling, so racing is still right. Correct the false clause, keep the justification.

ITEM 4 (docstring). \`request.ts:24-25\`, last sentence of the REQUEST_TIMEOUT_MS docstring: "A caller that knows it is starting such a sweep passes its own \`signal\` and gets no ceiling from here." That reads as though such callers exist. Measured: ZERO call sites in src/ pass a signal; the hatch is exercised only by request.spec.ts. Reword to say the hatch EXISTS AND IS CURRENTLY UNUSED, and record the measured thresholds: at ~0.7s per Codex CLI invocation a breach needs 86 conversations in one project, at ~70ms it needs 858, and a breach costs a spurious toast rather than data because the server thread runs to completion and retry is idempotent. Keep it tight - this is a docstring, not an essay.

VERIFY before returning: \`npx tsc --noEmit\` exit 0, \`npx jest\` 119 passed, \`npx eslint . --no-cache\` 0 errors, prettier clean on both files.
`;

const LANE_2 = `
LANE 2 - docs/defects.md and the three files .claude/plans/fix-wave-v1.0.0.md, .claude/plans/close-v1.0.0-final.md, .claude/plans/close-adversarial-defects-v1.0.0.md. You own these four files and nothing else. Do NOT touch any .ts or .py file.

ITEM 1 - seven new defect entries, DEF-76 onward (76 is the next free id; verify before writing). Match the file's existing entry format EXACTLY - read several entries first. Each gets a severity, a one-line title, the mechanism, the file, and a dated report note. All seven are LOG-ONLY: none is being fixed in this wave, and each entry must say WHY it was left, because that reasoning is the deliverable.

Write them from the evidence below, NOT from the round-6 finding titles - the impact agents corrected the reviewers on every one.

(a) MINOR - \`_showError\`'s "Could not reach the server - retrying." is false at three more sites: panel.ts:806 (cleanup, which already writes "Cleanup failed: <msg>" into its own modal, so a copy fix there would duplicate the text - the smaller correct move is dropping the banner, which is a behaviour change), panel.ts:2053 and panel.ts:2075 (JupyterLab command rejections - terminal:create-new and filebrowser:go-to-path - which never touch the server at all). Left out to keep this wave's diff at two lines in one function pair. panel.ts:240 and :2555 are poll/refresh paths where the copy is TRUE.

(b) MINOR - a tab tint survives disabling its provider. The reviewer cited terminals.ts:432 and blamed an unwired clearColours(); both are wrong. clearColours IS wired (terminals.ts:262 and panel.ts:217). The real gate is terminals.ts:449 plus the server: JupyterLab persists the setting to disk BEFORE emitting \`changed\`, so by the time panel.dispose() fires clearColours(), every probe() gets 404 provider_disabled (routes.py:277) and returns null, so _applyColour(widget, null) never runs. Ordered outcome, not a race. Bounded: the tint lives only on the widget's title.className, so it dies on reload or when the tab closes; no data affected. Left unfixed because the only honest fix is a client-side Set of widget references - new retention, new state, in a method with zero test coverage.

(c) MINOR - the N-scaling DELETE residual, effectively refuting round 6's MAJOR. Three DELETE call sites scale with N (panel.ts:703 _removeProject, :777 _cleanupParallel, :1244 _deleteBranches), not two. Only Codex shells out per conversation (_dispose, one subprocess per thread at _CLI_TIMEOUT_S=30); claude, gemini and kimi do pure filesystem work. At the measured ~0.7s per invocation a breach of the 60s client ceiling needs 86 conversations in one project; at ~70ms it needs 858. A breach costs a spurious toast, not data: the tornado executor thread runs to completion, colour_store.drop_colours still executes, and a retry is idempotent. Logged because DEF-72's note acknowledged the residual without ever giving it an id.

(d) MINOR - the lib-freshness guard is disarmed by \`npx tsc --noEmit\`, the project's own typecheck. MEASURED, not reported: buildinfo at 14:28:57, one comment appended to src/core/types.ts, tsc --noEmit run, buildinfo 14:57:57 - so BUILD_INFO (test_descriptor_parity.py:41, added by the DEF-75 fix) now makes a provably stale lib/ look fresh. This is a silent green, the exact failure the guard exists to prevent, and it is the third link in a chain: DEF-60 added the guard, its false positive became DEF-75, and DEF-75's fix became this. Scope: CI is unaffected, because .github/workflows/build.yml runs \`pip install .[test]\` (which builds lib/) before pytest; it bites the LOCAL loop only. Left unfixed in code deliberately - the candidate fix is to parse \`program.affectedFilesPendingEmit\`, a private TypeScript structure whose rename would degrade to a silent green, which is the same trade that produced this entry. The CAUSE is fixed instead, in item 2 below.

(e) MINOR - core-neutrality's comment stripper (src/__tests__/core-neutrality.spec.ts:80) truncates a line at the first \`//\` even inside a string. Nine lines are affected, all in src/core/icons.ts (15, 24, 33, 42, 60, 69, 80, 91, 104), every one an \`http://\` inside an SVG template literal, and none hides a violation - grep of icons.ts for any assistant name returns nothing. It is a hole with nothing behind it, and closing it means a 30-line character scanner inside a guard with nothing to catch. Record the adjacent real bug too: the block-comment strip at :82 deletes newlines, so a genuine violation in panel.ts would be reported about 141 lines off (2633 lines before stripping, 2492 after).

(f) MINOR - \`isRequestTimeout\` (request.ts:53) has no production consumer. Correct the round-6 reviewers, who claimed the whole surface was dead: \`RequestTimeoutError\` IS constructed and thrown at request.ts:116 and its message reaches users. Only the predicate is unused. Left unfixed because both options are worse right now - deleting it removes the only ready-made hook for a distinction the file's own docstring argues is necessary, and wiring it into _showError adds a second string to the most-executed error path while the branch copy is being changed in the same wave. Resolve it as one deliberate pass over _showError, _showActionError and _notifyLaunchError together.

(g) MINOR - \`MigrateHandler.post\` (core/routes.py:915) runs synchronously on the IOLoop while every other route uses run_in_executor. O(4 providers) of small JSON reads with no subprocess, so not a timeout risk - a latent inconsistency, logged for consistency's sake.

ITEM 2 - the cause fix for (d). In each of the three .claude/plans/*.md files, the verification section instructs \`npx tsc --noEmit\`. That is the command that disarms the freshness guard. Change it to \`jlpm build:lib\`, which emits and genuinely refreshes lib/. Change ONLY those verification lines; the plan files are historical records and their prose must not be edited otherwise. If a file mentions the command somewhere that is not a verification instruction, leave it and say so.

VERIFY before returning: \`python3 ~/.claude/skills/acceptance-criteria/scripts/acc-crit.py check --strict docs\` if that path resolves (report if it does not), prettier clean on all four files, and the defect ledger's counts still add up.
`;

phase('Land');

const lanes = await parallel([
  () =>
    agent(`${LANE_1}\n${RULES}`, {
      label: 'lane1:code+comments',
      phase: 'Land',
      schema: LANE_SCHEMA
    }),
  () =>
    agent(`${LANE_2}\n${RULES}`, {
      label: 'lane2:ledger+plans',
      phase: 'Land',
      schema: LANE_SCHEMA
    })
]);

const landed = lanes.filter(Boolean);
log(
  `${landed.reduce((n, l) => n + (l.landed?.length ?? 0), 0)} items landed, ` +
    `${landed.reduce((n, l) => n + (l.unlanded?.length ?? 0), 0)} deliberately not`
);

phase('Gate');

const gate = await agent(
  `You are the GATE for a two-lane wave that has just finished. Re-measure everything from a cold start and report numbers, not impressions.\n${RULES}\n\nWhat the lanes claim they changed:\n${JSON.stringify(landed, null, 2)}\n\nRun, in this order, and report each result exactly:\n1. \`npx tsc --noEmit\` - expect exit 0\n2. \`npx jest\` - expect 119 passed across 7 suites\n3. \`pytest -q\` - expect 163 passed\n4. THREE UNCACHED lint legs, never the cached script: \`npx eslint . --no-cache\` (expect 0 errors / 43 warnings), \`npx prettier --check\` on the CI glob, \`npx stylelint\` on style/**/*.css\n5. \`git status --porcelain\` - list every changed file and confirm the two lanes touched DISJOINT sets. Lane 1 owns src/core/panel.ts and src/core/request.ts; lane 2 owns docs/defects.md and three .claude/plans/*.md. A file changed by neither lane's remit is a finding.\n6. \`git diff --stat\` - the code diff must be small. If src/core/panel.ts changed by more than ~15 lines, read the diff and say what else was touched.\n7. Read the actual diff of src/core/panel.ts:995 and :1044 and confirm both now read exactly \`this._showActionError('Could not branch this session - try again.', err);\`, byte-identical to line 968.\n\nDo NOT fix anything. Report. If a gate is red, say which and paste the failure.`,
  { label: 'gate', phase: 'Gate' }
);

return { lanes: landed, gate };
