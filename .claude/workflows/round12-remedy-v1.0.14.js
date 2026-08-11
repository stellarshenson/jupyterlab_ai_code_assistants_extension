export const meta = {
  name: 'round12-remedy',
  description:
    'Delete dead store-side switch current + restore contract truth (DEF-103), then gate',
  phases: [
    {
      title: 'Fix',
      detail: 'one Opus lane - coupled 7-file removal',
      model: 'opus'
    },
    {
      title: 'Gates',
      detail: 'pytest x3 + isolation x10 + prettier check',
      model: 'opus'
    }
  ]
};

const ROOT =
  '/home/lab/workspace/private/jupyterlab/jupyterlab_ai_code_assistants_extension';
const SCRATCH =
  '/tmp/claude-1000/-home-lab-workspace-private-jupyterlab-jupyterlab-ai-code-assistants-extension/0257fef0-9212-4c10-ab11-3a300a3b5938/scratchpad/round12';

const FIX_SCHEMA = {
  type: 'object',
  required: ['edits', 'pytest', 'mutation', 'deviations'],
  properties: {
    edits: {
      type: 'array',
      items: { type: 'string' },
      description: 'one line per file edited: path - what changed'
    },
    pytest: {
      type: 'string',
      description: 'full-suite result after the edits, e.g. "170 passed"'
    },
    mutation: {
      type: 'string',
      description:
        'mutation-check outcome: which test reddened, restore verified byte-identical'
    },
    deviations: {
      type: 'string',
      description: 'anything done outside the spec, or "none"'
    }
  }
};

const GATE_SCHEMA = {
  type: 'object',
  required: ['suite_runs', 'isolation', 'prettier', 'verdict'],
  properties: {
    suite_runs: {
      type: 'array',
      items: { type: 'string' },
      description: 'one line per full-suite run: "N passed in Xs"'
    },
    isolation: {
      type: 'string',
      description:
        'per-test isolation tally, e.g. "4 tests x 10 runs, all green" or the failures'
    },
    prettier: { type: 'string' },
    verdict: { type: 'string', enum: ['GREEN', 'RED'] }
  }
};

phase('Fix');
const fix = await agent(
  `You are executing ONE precisely-specified removal in the JupyterLab extension repo at ${ROOT}. Every edit below was adjudicated from an adversarial architecture review; your job is to land EXACTLY these edits - nothing more.

CONTEXT (read once, do not re-derive): the switch route in core/routes.py writes the provider pin itself after the store's switch() returns, then re-resolves \`current\` (docs/defects.md DEF-102). That made every store's own switch-side \`current\` computation DEAD - the route unconditionally overwrites it - and left two docstrings claiming a wire dependence that no longer exists. The remedy is a strict removal: stores return {"requested"} only; \`current\` is the route's answer.

BINDING RULES:
- Touch ONLY the seven files named below, only at the named spots. No adjacent improvements, no comment rewrites outside the touched mechanism, no new helpers.
- NEVER run git checkout / git restore / git stash. Restores only from scratch copies you make under ${SCRATCH} (mkdir -p it).
- Run tests as: cd ${ROOT} && PYTHONPATH=$PWD python -m pytest jupyterlab_ai_code_assistants_extension/tests -q
- Do NOT run make, jlpm, npm, pip installs. Do NOT commit. Do NOT touch docs/defects.md or .claude/.

EDITS:

1. ${ROOT}/jupyterlab_ai_code_assistants_extension/core/store.py (~line 283) - the abstract switch() docstring currently reads:
   """Make \`\`session_id\`\` the project's current conversation.

   Returns \`\`{"requested", "current"}\`\` with \`\`current\`\` re-resolved after
   the write - the two differ when the requested conversation cannot
   become current. \`\`{"error": "branch_not_found"}\`\` when it no longer
   exists (removed between menu display and click), None on invalid input.
   """
   Rewrite the middle promise to the truth: returns \`\`{"requested"}\`\` on success - the store's job is validation plus its one recency-aligning write; the ROUTE writes the pin and resolves \`\`current\`\` after this returns (docs/defects.md DEF-102/DEF-103). Keep the branch_not_found and None-on-invalid-input sentences as they are.

2. ${ROOT}/jupyterlab_ai_code_assistants_extension/providers/claude.py (~line 870) - switch() ends with:
   return {
       "requested": session_id,
       "current": self.resolve_current(encoded_path),
   }
   Replace with: return {"requested": session_id}
   The docstring's mtime-touch and pin-is-the-route's-job paragraphs STAY; only adjust if any clause describes the removed current-resolution.

3. ${ROOT}/jupyterlab_ai_code_assistants_extension/providers/kimi.py (~line 483) and 4. ${ROOT}/jupyterlab_ai_code_assistants_extension/providers/gemini.py (~line 685) - both switch() methods end with the same two-key return; replace with: return {"requested": session_id}
   Both docstrings carry the clause "the touch is what makes the re-resolution below agree with the request instead of answering with the recency winner" - "below" now points at nothing. Reword that clause minimally so it names the ROUTE's post-pin re-resolution instead (e.g. "the touch is what keeps the provider's own picker aligned and lets the route's post-pin re-resolution agree with the request"). Keep the "durable half of the switch is the core's pin" sentence.

5. ${ROOT}/jupyterlab_ai_code_assistants_extension/providers/codex.py:
   a. switch() (~line 526) - the docstring currently claims: "Answer what pinning session_id will make current. ... The frontend depends on that disagreement to say the switch has not taken effect, so the pair must not be collapsed." That claim is FALSE (the route overwrites current; an independent probe proved identical outcomes in every branch). Rewrite the docstring truthfully: switch validates and writes nothing - the core writes the pin and resolves \`\`current\`\` once this returns (DEF-102/DEF-103).
   b. switch() body - the tail:
      current = self._resolve_project_current(encoded_path, threads, session_id)
      return {"requested": session_id, "current": current["id"]}
      becomes: return {"requested": session_id}
      Keep the is_thread_id guard, the empty-threads None, and the branch_not_found check exactly as they are.
   c. _resolve_project_current (~line 419) - the \`pin: str | None = None\` parameter now has zero callers passing it (the switch call was the only one). Remove the parameter and collapse \`if pin is None: pin = self._pin(project_path)\` to the unconditional \`pin = self._pin(project_path)\`. Verify with grep that the three remaining call sites (~:499, :524, :654) pass no pin argument before you touch the signature.

6. ${ROOT}/jupyterlab_ai_code_assistants_extension/core/routes.py (~line 520) - the comment block above \`result["current"] = await ...\` currently opens "The store resolved \`current\` BEFORE this pin existed..." - a universal codex contradicted, and now stale since stores no longer resolve current at all. Rewrite the comment: \`current\` is answered HERE, after the pin is on disk - stores no longer compute it (DEF-103); answering before the pin landed served the OLD pin and the panel toasted a failed switch (docs/defects.md DEF-102). Keep the final sentence about it being a pooled READ applying the store's own pin validation. Do NOT change the code lines themselves.

7. Tests:
   a. ${ROOT}/jupyterlab_ai_code_assistants_extension/tests/test_provider_stores.py line ~162: \`assert result == {"requested": first, "current": first}\` becomes \`assert result == {"requested": first}\`
   b. same file lines ~351-353: \`assert store.switch(PROJECT_PATH, other) == {"requested": other, "current": other}\` becomes \`assert store.switch(PROJECT_PATH, other) == {"requested": other}\`
   c. ${ROOT}/jupyterlab_ai_code_assistants_extension/tests/test_routes.py, test_a_switch_writes_the_pin_on_the_route_side: the kimi mock deliberately returns a stale "current" key - KEEP IT, and extend its comment by one clause noting that stores no longer return \`current\` at all, so the stale key proves the route overwrites even a nonconforming store.

VERIFY:
- Full suite green: cd ${ROOT} && PYTHONPATH=$PWD python -m pytest jupyterlab_ai_code_assistants_extension/tests -q (expect 170 passed - the count must not change).
- MUTATION CHECK (proves the slimmed tests still bite): mkdir -p ${SCRATCH}; cp codex.py to ${SCRATCH}/codex.py.orig; in the tree, sever the branch_not_found guard in codex switch (delete the \`if not any(...)\` block); run pytest -k codex - expect EXACTLY test_codex_switch_answers_without_writing to redden on its branch_not_found assertion; restore: cp ${SCRATCH}/codex.py.orig back, verify byte-identical with cmp, rerun the codex tests green.

Return the structured result. Report any spot where the file did not match this spec under deviations and STOP editing that spot rather than improvising.`,
  {
    label: 'fix:def-103-removal',
    phase: 'Fix',
    model: 'opus',
    schema: FIX_SCHEMA
  }
);

log(
  `Fix lane: ${fix ? fix.pytest + ' | mutation: ' + fix.mutation + ' | deviations: ' + fix.deviations : 'AGENT DIED'}`
);
if (!fix) return { error: 'fix lane died' };

phase('Gates');
const gates = await agent(
  `You are the verification gate for a just-landed removal in the repo at ${ROOT}. Do NOT edit any file. Run these and report honestly:

1. Full pytest suite THREE times: cd ${ROOT} && PYTHONPATH=$PWD python -m pytest jupyterlab_ai_code_assistants_extension/tests -q
   Expect 170 passed each run. Record each run's tally.
2. Isolation runs (mtime-flake discipline - these tests have a history of coarse-clock-tick flakes): run each of these FOUR tests 10 times each, individually:
   - jupyterlab_ai_code_assistants_extension/tests/test_provider_stores.py::test_claude_switch_touches_and_the_route_side_pin_outlives_recency
   - jupyterlab_ai_code_assistants_extension/tests/test_provider_stores.py::test_codex_switch_answers_without_writing
   - jupyterlab_ai_code_assistants_extension/tests/test_provider_stores.py::test_kimi_pin_outlives_recency
   - jupyterlab_ai_code_assistants_extension/tests/test_routes.py::test_a_switch_writes_the_pin_on_the_route_side
   (same PYTHONPATH incantation, -q). Tally green/red per test.
3. Prettier: cd ${ROOT} && jlpm run prettier:check (if that script does not exist, use jlpm run lint:check). Only Python files changed, so expect clean - but run it, do not assume.

Verdict GREEN only if every suite run is 170 passed, all 40 isolation runs green, and prettier clean. Any red: verdict RED with the exact failing output excerpt.`,
  {
    label: 'gates:pytest-battery',
    phase: 'Gates',
    model: 'opus',
    schema: GATE_SCHEMA
  }
);

log(
  `Gates: ${gates ? gates.verdict + ' | ' + gates.isolation + ' | prettier: ' + gates.prettier : 'AGENT DIED'}`
);
return { fix, gates };
