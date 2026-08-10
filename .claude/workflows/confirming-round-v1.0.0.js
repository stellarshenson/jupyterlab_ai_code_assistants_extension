export const meta = {
  name: 'confirming-round-v1.0.0',
  description:
    'Round 5 confirming review of jupyterlab_ai_code_assistants_extension: four lenses, every finding adversarially refuted before it counts',
  whenToUse:
    'After a fix batch, when the question is which findings are REAL rather than how many were reported',
  phases: [
    { title: 'Review', detail: 'four lenses over the frozen tree' },
    {
      title: 'Refute',
      detail: 'two skeptics per lens, prompted to break its findings'
    },
    {
      title: 'Synthesise',
      detail: 'survivors ranked, refutations recorded, gaps named'
    }
  ]
};

const REPO =
  '/home/lab/workspace/private/jupyterlab/jupyterlab_ai_code_assistants_extension';

// Rules every agent in this run obeys. The Galata clause is not advisory:
// `rm -rf .scratch` in webServer.command plus a literal SCRATCH path makes two
// suites destroy each other REGARDLESS of port - it cost the round-4 architect
// two of its three runs and cost the main session one.
const RULES = `
REPO: ${REPO} (v1.0.0, uncommitted).

HARD RULES:
- Do NOT edit, commit, push or tag anything. This is a review, not a fix.
- Do NOT run \`make build\`, \`make publish\`, \`jlpm build:prod\` or anything that increments the version off 1.0.0.
- Do NOT run Galata / Playwright. Exactly one agent in this run is permitted to, and it is not you unless your prompt says so explicitly. Use pytest, jest and tsc.
- Never restore a file with git - the tree carries uncommitted work. Use a scratch COPY.

BASELINES (re-measure, do not trust): pytest 150 passed; \`npx jest\` 82 passed; \`npx tsc --noEmit\` exit 0; \`npx eslint . --no-cache\` 0 errors / 54 warnings; prettier clean; stylelint clean; Galata 20/20.

ALREADY LOGGED AND OPEN in docs/defects.md - do NOT re-report these, they are scheduled work:
DEF-30, DEF-31, DEF-41 (branch/bg badges clipped by the name ellipsis), DEF-42 (no submenu caret - plain Lumino Menu), DEF-43 (Ok on an empty branch name is a silent no-op), DEF-44 (Recent duplicates All below the limit), DEF-45 (Clean Up Parallel Sessions unmarked), DEF-46 (row tooltip names a launch mode on a background-agent row where the server drops the flag), DEF-47 (init waiter's timeout path execs the assistant at 1x1), DEF-48 (Galata's openTab races the panel docking), DEF-49 (concurrent Galata runs delete each other's scratch regardless of port).
Also already reported by the round-4 architect and queued: GeminiStore.comm_name as a dead marker plus the identity-function filter in _tree_assistant; ForkStrategy 'none'; colour_store.py lacking a logger; default_colour's stale colour_source docstring; settings-default literals in index.ts; the open-branch label not naming the mode; FNV-1a duplicated across runtimes; ui-tests reading the developer's live Jupyter config.

CLOSED THIS SESSION - your job is to check these HOLD, and to catch anything they broke:
DEF-32 probe route reads terminal_manager.terminals instead of get-or-create get_terminal.
DEF-33 _INIT_WAITER marks its own pty 1x1 and polls; the SIGWINCH trap, the baseline read and the server-side setwinsize are deleted.
DEF-34 closed with DEF-33's deletion.
DEF-35/DEF-39 branch item label and icon branch on _visibleVariantCount() === 0; the mode's glyph wins, branchIcon is the fallback.
DEF-36/DEF-38 the + button title appends _variantSuffix() and is re-run from setModes.
DEF-37 _resolvedVariant() is settings-only; the background-agent attach test moved to _resumeVariant(), read by the resume command alone.
DEF-40 warning icon is 16x16 jp-icon-warn0.
Plus: yarn.lock's stale mkdirp entry removed; 'Empty.' and 'No favorites yet.' deleted as unreachable; 117 duplicate acc-crit log lines shortened; ISession.colour docs corrected.
`;

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['SHIP', 'DO-NOT-SHIP'] },
    closures_hold: {
      type: 'string',
      description: 'Which of the listed closures you verified, and how'
    },
    findings: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        required: ['severity', 'title', 'file', 'evidence', 'kind'],
        properties: {
          severity: { type: 'string', enum: ['CRITICAL', 'MAJOR', 'MINOR'] },
          title: { type: 'string' },
          file: { type: 'string', description: 'path:line' },
          evidence: {
            type: 'string',
            description: 'what you executed and what it printed'
          },
          kind: { type: 'string', enum: ['FACT', 'SUSPICION'] },
          repro: {
            type: 'string',
            description: 'exact steps or command to reproduce'
          }
        }
      }
    }
  }
};

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'refuted', 'why'],
        properties: {
          title: { type: 'string' },
          refuted: { type: 'boolean' },
          why: {
            type: 'string',
            description: 'what you ran and what it showed'
          }
        }
      }
    }
  }
};

const LENSES = [
  {
    key: 'architect',
    brief:
      'architecture, consistency, hardcodings, config drift, separation of concerns, over-engineering. The provider registry must never let core code name an assistant.'
  },
  {
    key: 'bug-hunter',
    brief:
      'runtime behaviour, races, lifecycle, error paths, library internals. Prove findings by EXECUTING them, never by reading. You MAY run Galata if you need rendered proof - you are the ONE agent in this run permitted to, on JLAB_TEST_PORT=8931, from ui-tests/ with ui-tests/.venv on PATH.'
  },
  {
    key: 'ux-designer',
    brief:
      'friction, hierarchy, focus, accessibility, safety cues, copy. You may NOT run Galata this round; reason from the code and say plainly what you could not render.'
  },
  {
    key: 'slop-hunter',
    brief:
      'dead weight, duplication, unreachable code, stale prose, tests that kill no mutant, config that does nothing. Run the lint gate as THREE UNCACHED LEGS, never the cached script. For every deletion you propose, run the delete-test and report the result.'
  }
];

// Two skeptics per lens rather than three per finding: same adversarial
// property, an order of magnitude fewer agents. They attack from different
// angles because this campaign's failures never had one shape - some findings
// were unreproducible, others were true of code that had already changed.
const SKEPTICS = [
  {
    key: 'reproduce',
    brief:
      "Execute each finding's repro against the CURRENT tree. Refuted unless it actually reproduces in front of you. A finding you cannot run is refuted."
  },
  {
    key: 'claim-truth',
    brief:
      "Check each finding's asserted file:line and every claim it makes about what the code does. Round 4 produced three findings that were false prose about code that had already changed. Refuted if the citation does not land or the claim misdescribes the code."
  }
];

phase('Review');

const reviewed = await pipeline(
  LENSES,
  lens =>
    agent(
      `You are the ${lens.key.toUpperCase()} adversary in a CONFIRMING round (round 5).\n\n${lens.brief}\n${RULES}\n\nReturn at most 8 findings, most severe first, and set verdict SHIP only if you found none that matter. Mark each FACT (you executed it) or SUSPICION. Also write your full prose report to logs/adversarial/wholerepo-${lens.key}-round5.txt.`,
      { label: `review:${lens.key}`, phase: 'Review', schema: FINDINGS_SCHEMA }
    ),
  (review, lens) => {
    if (!review || !review.findings || review.findings.length === 0) {
      return { lens: lens.key, review, verdicts: [] };
    }
    const list = review.findings
      .map(
        (f, i) =>
          `${i + 1}. [${f.severity}] ${f.title}\n   at ${f.file}\n   claimed evidence: ${f.evidence}\n   repro: ${f.repro ?? '(none given)'}`
      )
      .join('\n');
    return parallel(
      SKEPTICS.map(
        s => () =>
          agent(
            `You are a SKEPTIC. Your job is to REFUTE the findings below, not to confirm them. Default to refuted=true when uncertain.\n\nYour angle: ${s.brief}\n${RULES}\n\nFindings reported by the ${lens.key} lens:\n\n${list}\n\nFor each, answer refuted true/false and say exactly what you ran and what it showed.`,
            {
              label: `refute:${lens.key}:${s.key}`,
              phase: 'Refute',
              schema: VERDICT_SCHEMA
            }
          )
      )
    ).then(verdicts => ({
      lens: lens.key,
      review,
      verdicts: verdicts.filter(Boolean)
    }));
  }
);

phase('Synthesise');

const rounds = reviewed.filter(Boolean);

// A finding survives unless BOTH skeptics refuted it. One refutation is a
// disagreement worth reporting, not a kill - the two angles are different
// questions and either can be wrong on its own.
const survivors = [];
const refuted = [];
for (const r of rounds) {
  for (const f of r.review?.findings ?? []) {
    const votes = r.verdicts
      .flatMap(v => v.results ?? [])
      .filter(
        x => x.title && f.title && x.title.slice(0, 40) === f.title.slice(0, 40)
      );
    const kills = votes.filter(v => v.refuted).length;
    const entry = { lens: r.lens, ...f, refutations: votes.map(v => v.why) };
    if (votes.length >= 2 && kills >= 2) {
      refuted.push(entry);
    } else {
      survivors.push({ ...entry, contested: kills === 1 });
    }
  }
}

log(
  `${survivors.length} findings survived refutation, ${refuted.length} killed, across ${rounds.length} lenses`
);

const critic = await agent(
  `A four-lens confirming round of ${REPO} produced these SURVIVING findings:\n\n${JSON.stringify(survivors, null, 2)}\n\nand refuted these:\n\n${JSON.stringify(
    refuted.map(r => ({ title: r.title, why: r.refutations })),
    null,
    2
  )}\n\n${RULES}\n\nWhat is MISSING? Name the modality nobody ran, the claim nobody verified, the surface nobody looked at. Be specific and short. Do not re-review the code yourself.`,
  { label: 'completeness-critic', phase: 'Synthesise' }
);

return {
  verdicts: rounds.map(r => ({
    lens: r.lens,
    verdict: r.review?.verdict ?? 'unknown'
  })),
  survivors,
  refuted: refuted.map(r => ({
    lens: r.lens,
    severity: r.severity,
    title: r.title,
    why: r.refutations
  })),
  gaps: critic
};
