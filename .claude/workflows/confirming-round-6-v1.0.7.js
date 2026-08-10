export const meta = {
  name: 'confirming-round-6-v1.0.7',
  description:
    'Round 6 confirming review of jupyterlab_ai_code_assistants_extension at v1.0.7: four lenses over the fix wave, every finding adversarially refuted before it counts',
  whenToUse:
    'After the last fix batch, when the question is whether the wave HELD rather than what else can be found',
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

// The Galata clause is not advisory: two suites destroy each other REGARDLESS
// of port, which cost the round-4 architect two of its three runs. Exactly one
// agent in this run holds the port.
const RULES = `
REPO: ${REPO} (v1.0.7, entirely uncommitted - 114 changed files).

HARD RULES:
- Do NOT edit, commit, push or tag anything. This is a review, not a fix.
- Do NOT run \`make build\`, \`make install\`, \`make publish\` or \`jlpm build:prod\`. \`make build\` runs increment_version AND clean, so it bumps the version and wipes lib/.
- Do NOT run Galata / Playwright. Exactly one agent in this run is permitted to, and it is not you unless your prompt says so explicitly. Use pytest, jest and tsc.
- Never restore a file with git - the tree carries uncommitted work with no commit behind it. Use a scratch COPY under /tmp.
- Do NOT delete tsconfig.tsbuildinfo or otherwise force a rebuild; another agent may be mid-run against lib/.

BASELINES (re-measure, do not trust): pytest 163 passed; \`npx jest\` 119 passed across 7 suites; \`npx tsc --noEmit\` exit 0; \`npx eslint . --no-cache\` 0 errors / 43 warnings; prettier clean on the CI glob; stylelint clean; Galata 26/26; \`acc-crit.py check --strict\` 0 errors / 0 warnings.

DEFECT LEDGER: docs/defects.md holds 74 closed and 1 open. Read it before reporting anything - a finding already in there is not a finding.

THE ONE OPEN DEFECT, deliberately deferred, do NOT re-report it:
DEF-74 - _branchByServerCopy (kimi, gemini) is not a ColourStore consumer, so the SERVER copies the colour during a fork and a capture still queued on the client is not in the store the server reads. Logged, reasoned, left open by decision.

WHAT LANDED SINCE ROUND 5 - this is what round 6 is measuring. Your job is to check these HOLD and to catch anything they broke:
- DEF-72 src/core/request.ts: requestAPI now bounded at REQUEST_TIMEOUT_MS = 60_000 via a hand-rolled AbortController plus timer, armed only when the caller passes no signal of its own. Surfaces RequestTimeoutError / isRequestTimeout. The 60s floor is set by codex.py's _CLI_TIMEOUT_S = 30, so a fork can legitimately hold the server for 30s.
- DEF-30 src/core/colour.ts: the hand-rolled ordering is replaced by a _run(op) promise chain - load, set and forget all enter through it, so only one of this store's requests is ever on the wire. Deleted with it: _writeSeq, _writeStart, _readSeq, _readAbsorbed, _current(ids, seq), _absorb. 22 references before, 0 after. _pending / isPending stay and now count from the CALL rather than the send.
- DEF-73 src/__tests__/colour.spec.ts: a source-reading guard asserts load/set/forget never call back into the queue. The invariant cannot be enforced at runtime - an inner call is indistinguishable from a legitimate outer one.
- DEF-31 src/core/panel.ts: _inheritColour gates on isPending(parentId), awaits load(), then re-reads, with the click-time value as fallback.
- DEF-52 src/core/colour.ts + providers/kimi.py: both FNV-1a implementations now hash UTF-8 BYTES. test_descriptor_parity.py gained TextEncoder in its vm sandbox and hashes a 508-id corpus differentially.
- DEF-75 test_descriptor_parity.py: the freshness guard counts tsconfig.tsbuildinfo as a build marker and its failure message names \`rm tsconfig.tsbuildinfo\` as the remedy for the one known false positive.
- DEF-63 core/migrate.py: settings_dir is a PARAMETER, not an import - routes already imports migrate, so the reverse would be circular.
- DEF-71 src/core/panel.ts exports DEFAULT_RECENT_LIMIT / MIN_RECENT_LIMIT / MAX_RECENT_LIMIT / DEFAULT_PRESENTATION_MODE; src/index.ts imports them instead of restating literals.
- DEF-58 src/__tests__/core-neutrality.spec.ts derives its assistant-name list from the registry instead of a hardcoded regex.
- NEW TIER: ui-tests/tests/panel-regressions.spec.ts, 6 tests, rendered proof in a real browser for DEF-41, DEF-42, DEF-54/DEF-40, DEF-45, DEF-55 and DEF-57. ui-tests/jupyter_server_test_config.py seeds a second project with deliberately older mtimes and an overflowing name.
- Version tracking: 1.0.0 -> 1.0.7 via make increment_version, one bump per landed unit, package-lock.json synced (it had drifted to 0.6.17).
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
      'architecture, consistency, hardcodings, config drift, separation of concerns, over-engineering. The provider registry must never let core code name an assistant. You returned SHIP at round 5 - the question this round is whether the wave broke that, not what else exists.'
  },
  {
    key: 'bug-hunter',
    brief:
      'runtime behaviour, races, lifecycle, error paths, library internals. The colour store was rewritten a FIFTH time this wave and the request helper gained a timeout - attack both. Prove findings by EXECUTING them, never by reading. You MAY run Galata if you need rendered proof - you are the ONE agent in this run permitted to, on JLAB_TEST_PORT=8931, from ui-tests/ with ui-tests/.venv/bin on PATH, output redirected to a file rather than piped (a pipe reports tee exit status).'
  },
  {
    key: 'ux-designer',
    brief:
      'friction, hierarchy, focus, accessibility, safety cues, copy. Six panel defects gained rendered proof this wave - check the proofs assert what the defects were actually about. You may NOT run Galata this round; reason from the code and the committed spec files, and say plainly what you could not render.'
  },
  {
    key: 'slop-hunter',
    brief:
      'dead weight, duplication, unreachable code, stale prose, tests that kill no mutant, config that does nothing. The colour store deleted 22 references this wave - check nothing orphaned survived, and check the five replacement tests each redden a real mutant. Run the lint gate as THREE UNCACHED LEGS, never the cached script. For every deletion you propose, run the delete-test and report the result.'
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
      "Check each finding's asserted file:line and every claim it makes about what the code does, AND check docs/defects.md for whether it is already logged. Round 4 produced three findings that were false prose about code that had already changed. Refuted if the citation does not land, the claim misdescribes the code, or the defect is already in the ledger."
  }
];

phase('Review');

const reviewed = await pipeline(
  LENSES,
  lens =>
    agent(
      `You are the ${lens.key.toUpperCase()} adversary in a CONFIRMING round (round 6). One clean round from all four lenses is the ship bar, and this is that round.\n\n${lens.brief}\n${RULES}\n\nReturn at most 8 findings, most severe first, and set verdict SHIP only if you found none that matter. Mark each FACT (you executed it) or SUSPICION. Also write your full prose report to logs/adversarial/wholerepo-${lens.key}-round6.txt.`,
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
  `A four-lens confirming round (round 6, the ship round) of ${REPO} produced these SURVIVING findings:\n\n${JSON.stringify(survivors, null, 2)}\n\nand refuted these:\n\n${JSON.stringify(
    refuted.map(r => ({ title: r.title, why: r.refutations })),
    null,
    2
  )}\n\n${RULES}\n\nWhat is MISSING? Name the modality nobody ran, the claim nobody verified, the surface nobody looked at. Be specific and short. Do not re-review the code yourself.`,
  { label: 'completeness-critic', phase: 'Synthesise' }
);

return {
  verdicts: rounds.map(r => ({
    lens: r.lens,
    verdict: r.review?.verdict ?? 'unknown',
    closures_hold: r.review?.closures_hold ?? null
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
