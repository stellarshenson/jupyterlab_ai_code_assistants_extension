export const meta = {
  name: 'colour-store-chain-v1.0.0',
  description:
    'Close DEF-30 and DEF-31 by bounding the shared request first, then serialising the colour store and settling before a fork',
  whenToUse:
    'When a deferred defect has an identified prerequisite and the three steps must land in order against the same two files',
  phases: [
    { title: 'Chain', detail: 'bound the request, serialise, settle' },
    { title: 'Gate', detail: 'the whole suite re-measured against the result' }
  ]
};

const REPO =
  '/home/lab/workspace/private/jupyterlab/jupyterlab_ai_code_assistants_extension';

// Sequential by necessity: all three stages touch src/core/colour.ts or the
// file that calls it, and each reads the tree the previous one left. There is
// no parallelism here to take, and faking some would only reintroduce the
// conflict the last wave's file partition existed to avoid.
const RULES = `
REPO: ${REPO} (v1.0.0, uncommitted, on branch main).

HARD RULES - breaking any of these fails the stage:
- Do NOT commit, push, tag, or change any version number. Do NOT run \`make build\`, \`make install\`, \`make publish\`, or \`jlpm build:prod\` - \`make build\` runs increment_version AND clean, which would bump the version off 1.0.0 and delete lib/.
- Do NOT run Galata / Playwright. The coordinator runs it afterwards; only one runner may hold the port.
- NEVER restore a file with git - the whole tree is uncommitted work and a checkout destroys it. To mutation-check, copy the file to a scratch path, edit the ORIGINAL, run the test, then restore from YOUR COPY. This mistake already cost this campaign a whole file once.
- Do NOT edit docs/defects.md, docs/acc-crit-*.md or .claude/JOURNAL.md. Report what you closed; the coordinator records it.
- Match the surrounding style. Comments here explain WHY, name the defect id, and are written for someone reading them in a year. Terse, no marketing, no emojis, no em-dashes (use " - "), unicode arrows over ASCII.

GATES (all read-only, run before and after and report both):
- \`cd ${REPO} && npx tsc --noEmit\` (expect exit 0)
- \`cd ${REPO} && npx jest\` (103 passing at the start of this chain)
- \`cd ${REPO} && npx tsc --sourceMap && python -m pytest jupyterlab_ai_code_assistants_extension/tests -q\` (163 passing) - the tsc FIRST is not optional: a freshness guard fails four parity tests against a lib/ older than src/, by design, and that is not a defect you introduced.
- \`cd ${REPO} && npx eslint . --no-cache\` (0 errors / 43 warnings), \`npx prettier --check "**/*{.ts,.tsx,.js,.jsx,.css,.json,.md}"\`

EVIDENCE BAR: every claim must be backed by something you executed. "I read the code and it looks right" is not done. If you cannot verify something, say so plainly rather than claiming it.

DECLINING is allowed and expected. An item that is wrong, already fixed, or costs more than it closes gets declined WITH ITS REASON. A silently dropped item is a defect.
`;

const STAGE_SCHEMA = {
  type: 'object',
  required: ['stage', 'done', 'declined'],
  properties: {
    stage: { type: 'string' },
    done: {
      type: 'array',
      items: {
        type: 'object',
        required: ['item', 'file', 'what', 'evidence'],
        properties: {
          item: { type: 'string' },
          file: { type: 'string' },
          what: { type: 'string', description: 'the change, in one sentence' },
          evidence: {
            type: 'string',
            description: 'what you executed and what it printed'
          },
          test: {
            type: 'string',
            description: 'test added or deleted, and how it was checked'
          }
        }
      }
    },
    deleted_tests: {
      type: 'array',
      description:
        'tests removed, each with the PROOF that its state can no longer occur',
      items: {
        type: 'object',
        required: ['test', 'proof'],
        properties: {
          test: { type: 'string' },
          proof: { type: 'string' }
        }
      }
    },
    declined: {
      type: 'array',
      items: {
        type: 'object',
        required: ['item', 'why'],
        properties: { item: { type: 'string' }, why: { type: 'string' } }
      }
    },
    gates: { type: 'string' },
    handoff: {
      type: 'string',
      description: 'what the next stage needs to know about what you left'
    },
    notes: { type: 'string' }
  }
};

const STAGE_1 = `You are STAGE 1 of a three-stage chain: bound the shared request helper.

FILE YOU OWN: src/core/request.ts, plus a spec under src/__tests__/ for it.
${RULES}

THE PROBLEM: \`requestAPI\` sets no timeout, and neither does \`ServerConnection.makeRequest\` beneath it, so a hung request hangs for as long as the browser will hold the socket. This is a defect in its own right - it is what made DEF-55's cleanup modal a genuine trap - and it is the stated prerequisite for DEF-30, whose deferral note reads: "a serialisation chain needs a bounded request first, which is a change to the shared request helper rather than to this store".

WHAT TO DO: give \`requestAPI\` a default timeout, applied ONLY when the caller passes no \`signal\` of its own, so a future caller can still supply one.

THE NUMBER, AND WHY IT IS NOT FREE TO PICK: \`jupyterlab_ai_code_assistants_extension/providers/codex.py\` sets \`_CLI_TIMEOUT_S = 30\` - a Codex fork can legitimately keep the server busy for thirty seconds while it shells out. A client timeout at or below that breaks branching for Codex, silently, on exactly the slow path it was tuned for. Use 60s, and put the reason in the comment naming \`_CLI_TIMEOUT_S\`, or the next person tunes it to the fast path and reintroduces this. Verify that 30 is still the server-side number before you rely on it, and check whether any OTHER route can legitimately run longer - grep the Python side for timeouts and subprocess calls.

TWO THINGS TO GET RIGHT:
- Hand-roll it with \`AbortController\` plus a timer rather than \`AbortSignal.timeout\`. Do not assume the latter exists in the jsdom the Jest tier runs on - check, and say what you found either way.
- A timeout must surface as a DISTINGUISHABLE error, not as a generic network failure. \`panel.ts\` already branches on error shape (\`isResponseStatus\`), and a caller that cannot tell "the server is slow" from "the server is gone" cannot report either honestly. Clear the timer on both paths so a fast response leaves nothing pending.

Cover it with a spec that proves the abort fires and that a caller-supplied signal is respected. Mutation-check it. Report per the schema, and in \`handoff\` tell stage 2 exactly what the store can now rely on.`;

const STAGE_2 = `You are STAGE 2 of a three-stage chain: serialise the colour store. This is DEF-30.

FILES YOU OWN: src/core/colour.ts and src/__tests__/colour.spec.ts.
${RULES}

STAGE 1 (the bounded request) REPORTED:
%%S1%%

THE DEFECT, from docs/defects.md (read it, do not edit it): "ColourStore hand-rolls write ordering instead of serialising its own requests". It carries a monotonic write counter, a per-id record of the latest write and a reload counter - \`_writeSeq\`, \`_writeStart\`, \`_readSeq\`, \`_readAbsorbed\`, with \`_openWrite\` / \`_closeWrite\` / \`_current\` / \`_absorb\` - so that answers arriving out of order cannot undo each other. Every one of those questions becomes UNCONSTRUCTIBLE if the store chains its own \`load\` / \`set\` / \`forget\` through one promise, because only one request is ever on the wire. The ordering rules were added defect by defect across three adversarial rounds rather than designed.

WHAT TO DO: introduce a \`_run(op)\` chain field, route \`load\`, \`set\` and \`forget\` through it, then delete what can no longer happen - 23 references across a 413-line file.

KEEP \`_pending\` AND \`isPending\`. \`forget()\` reads them, and stage 3 needs them.

THE BAR ON DELETION, WHICH IS THE WHOLE POINT OF THIS STAGE: src/__tests__/colour.spec.ts is 516 lines at roughly 94% statement coverage of colour.ts, and its interleaving tests describe states that are REAL today. For every test you delete you must PROVE the state can no longer occur - an argument from the serialisation, not an assertion that it is fine - and report that proof in \`deleted_tests\`. A test deleted without proof is coverage thrown away, and this file's coverage is the only thing standing between this store and its fifth regression.

THE HISTORY YOU ARE WORKING AGAINST, stated so you take it seriously: this object was rewritten four times across rounds 5 to 8 of an earlier sweep, and each rewrite ADDED machinery and seeded the next round's defect. This change is different only if it genuinely deletes more than it adds. If you find yourself adding a second mechanism to make the first one work, stop and say so - declining this stage with a clear reason is a better outcome than a fifth rewrite.

WATCH FOR: a chained \`load\` behind a slow \`set\` now DELAYS the read rather than racing it. Check what that does to the panel's first paint and to \`reconcileColours\` in terminals.ts, and report it even if it is acceptable.

Report per the schema, and in \`handoff\` tell stage 3 what settlement primitive it can use.`;

const STAGE_3 = `You are STAGE 3 of a three-stage chain: settle before a fork. This is DEF-31.

FILES YOU OWN: src/core/panel.ts and src/core/terminals.ts. src/core/colour.ts belongs to stage 2 - if the settlement primitive it left is not enough, say so rather than extending it.
${RULES}

STAGE 1 REPORTED:
%%S1%%

STAGE 2 (the serialised store) REPORTED:
%%S2%%

THE DEFECT, from docs/defects.md: "A fork started inside the capture window inherits the parent's OLD colour". \`_branchSession\` reads the parent's tint at click time (via \`TerminalManager.colourFor\`, and the native branch of \`_inheritColour\`), and because the cache holds only server-CONFIRMED values, a colour the user set on the parent's tab moments earlier is not there yet. The branch is then born with the previous tint or the id hash, stored as INHERITED, so it is never offered for release and no later pass corrects it. The window is one round trip and the damage is permanent when it fires.

WHY IT WAS DEFERRED, AND WHAT CHANGED: the deferral priced two options - awaiting a pending write inside the fork path, which contradicts the deliberate snapshot-before-fork, or a new settlement API on the store, which is more machinery than the defect. Stage 2's serialisation is that settlement API, arrived at for a different reason, so the fix should now be ONE chain step rather than new machinery. If it is not - if closing this needs something built - that is the signal to decline and say why.

A graphify blast radius over \`ColourStore\` named 17 consumer sites across three files; 15 satisfy the confirmed-value contract and these two are the whole remainder. Re-derive that yourself rather than trusting the number, and note that graphify does not model intra-file calls, so grep is the authority.

Cover it with a test that reddens when the settlement is removed - a fork started while a parent write is in flight must inherit the NEW colour. Mutation-check it. Report per the schema.`;

phase('Chain');

const s1 = await agent(STAGE_1, {
  label: 'stage-1:bounded-request',
  phase: 'Chain',
  schema: STAGE_SCHEMA
});
const s1Text = JSON.stringify(s1, null, 2);

const s2 = await agent(STAGE_2.replace('%%S1%%', s1Text), {
  label: 'stage-2:serialise-store',
  phase: 'Chain',
  schema: STAGE_SCHEMA
});
const s2Text = JSON.stringify(s2, null, 2);

const s3 = await agent(
  STAGE_3.replace('%%S1%%', s1Text).replace('%%S2%%', s2Text),
  { label: 'stage-3:settle-before-fork', phase: 'Chain', schema: STAGE_SCHEMA }
);

const stages = [s1, s2, s3].filter(Boolean);
const deleted = stages.reduce((n, s) => n + (s.deleted_tests?.length ?? 0), 0);
log(
  `${stages.length} stages reported, ${stages.reduce((n, s) => n + (s.done?.length ?? 0), 0)} items done, ${deleted} tests deleted with proof`
);

phase('Gate');

const gate = await agent(
  `Re-measure every gate on ${REPO} after a three-stage change to the request helper, the colour store and the panel's fork path. Change NOTHING - this is measurement only.
${RULES}

Run each and report exact numbers plus any failure output verbatim:
1. \`npx tsc --noEmit\` - was exit 0
2. \`npx jest\` - was 103 passing across 6 suites. Tests were deliberately DELETED this run, so a lower count is expected; report the count per suite and name which suite moved.
3. \`npx tsc --sourceMap\` THEN \`python -m pytest jupyterlab_ai_code_assistants_extension/tests -q\` - was 163 passing. The tsc first is mandatory; without it a freshness guard fails four parity tests by design.
4. \`npx eslint . --no-cache\` - was 0 errors / 43 warnings
5. \`npx prettier --check "**/*{.ts,.tsx,.js,.jsx,.css,.json,.md}"\` - was clean
6. \`npx stylelint --no-cache "style/**/*.css"\` - was clean

Then one judgement, and be blunt about it: read src/core/colour.ts as it now stands and say whether the file is SIMPLER than a store that hand-rolled write ordering, or whether one mechanism was traded for another. That was the entire justification for touching this file, and it is the one thing the gates cannot measure.`,
  { label: 'gate:full-suite', phase: 'Gate' }
);

return { stages, gate };
