export const meta = {
  name: 'close-19-v1.0.10',
  description:
    'Close all 19 open ledger defects - 14 code fixes in five file-partitioned lanes',
  phases: [
    {
      title: 'Lane A - TypeScript panel',
      detail:
        'DEF-76+81, DEF-74, DEF-85+86, DEF-92 - four sequential steps sharing panel.ts',
      model: 'opus'
    },
    {
      title: 'Lanes B-E - parallel',
      detail: 'python providers, routes.py, guards, migration+fixture',
      model: 'opus'
    }
  ]
};

// Repo root every lane works in. All lanes are IDEMPOTENT: inspect the file
// first, return already-done when the remedy is present, repair partial work.
const ROOT =
  '/home/lab/workspace/private/jupyterlab/jupyterlab_ai_code_assistants_extension';
const SCRATCH =
  '/tmp/claude-1000/-home-lab-workspace-private-jupyterlab-jupyterlab-ai-code-assistants-extension/0257fef0-9212-4c10-ab11-3a300a3b5938/scratchpad/close19';

const CONSTITUTION = `
BINDING CONSTRAINTS (violating any one = stop and report instead):
- Work ONLY in ${ROOT}. Edit ONLY the files this spec lists. An edit you think is needed outside them = STOP, return status 'blocked' with the reason. Never improvise a different mechanism than the one specified - the remedies are the defect ledger's own, chosen to be regression-proof.
- NO adjacent improvements: no comment rewrites outside the touched mechanism, no formatting of untouched lines, no renames, no new helpers beyond what the spec names.
- Mutation checks: copy the file to ${SCRATCH}/<your-lane>/ BEFORE mutating, restore from that scratch copy byte-identical afterwards. NEVER use git checkout/restore - the tree carries uncommitted work from other lanes.
- NEVER run: make targets, npm/jlpm/pip install, git commit/push, npx tsc --noEmit (it disarms a freshness guard - DEF-79). TypeScript verification is 'jlpm build:lib' (emits + typechecks).
- Python tests: run as PYTHONPATH=${ROOT} python -m pytest <paths> -q from ${ROOT} (the conda site-packages copy is stale - DEF-98 - so PYTHONPATH must force the tree).
- Do NOT edit docs/defects.md - a single ledger writer records closures after all lanes land.
- Your final message is parsed as data. Return ONLY the JSON the schema asks for.`;

const LANE_SCHEMA = {
  type: 'object',
  required: ['defects', 'deviations'],
  properties: {
    defects: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'status', 'summary', 'files', 'verification'],
        properties: {
          id: { type: 'string' },
          status: { enum: ['fixed', 'already-done', 'blocked'] },
          summary: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          verification: {
            type: 'string',
            description:
              'exact commands run and their results, incl. mutation checks: what was mutated, which test reddened, restore confirmed byte-identical'
          },
          observed: {
            type: 'string',
            description:
              'DEF-87 only: the end-to-end rehearsal result as observed'
          }
        }
      }
    },
    deviations: { type: 'array', items: { type: 'string' } }
  }
};

// ── Lane A: four sequential steps, all sharing src/core/panel.ts ─────────────

const A1 = `You are closing DEF-76 and DEF-81 in ${ROOT} - the ONE deliberate pass over the panel's three error helpers that both ledger entries call for.
${CONSTITUTION}
Files you may edit: src/core/panel.ts. Read first: src/core/request.ts (the isRequestTimeout predicate at ~line 57 and RequestTimeoutError), then panel.ts's _showError, _showActionError, _notifyLaunchError and every _showError call site (five today).

DEF-76 - _showError prefixes every message with "Could not reach the server - retrying." which is TRUE only on the two poll/refresh paths that own a retry. The three false sites:
1. The cleanup catch inside _cleanupParallel (near the code that writes "Cleanup failed: <msg>" into its own modal): the modal already carries the message, so DROP the _showError call there entirely - the banner duplicated the modal.
2+3. The two JupyterLab command rejections (commands.execute for 'terminal:create-new' and 'filebrowser:go-to-path', around lines 2050-2090): these never touch the server. Route each through _showActionError with copy naming what failed, e.g. 'Could not open a terminal for this session - try again.' and 'Could not open the project folder - try again.' Match the existing _showActionError copy style exactly (sentence, ' - try again.').

DEF-81 - isRequestTimeout is exported with no production consumer. Wire it into _showError: when isRequestTimeout(err), the banner copy must say the server was reached but did not answer in time (slow, not gone) - e.g. 'The server is not answering - retrying.' - while the non-timeout copy keeps the existing 'Could not reach the server - retrying.' Import isRequestTimeout beside the existing imports from './request'. Do NOT touch _showActionError's or _notifyLaunchError's own copy.

Verification: panel.ts is NOT Jest-importable, so: (a) jlpm build:lib exit 0; (b) npx eslint src/core/panel.ts - 0 errors; (c) grep-inventory the final state: exactly two _showError call sites remain (poll + refresh), cleanup site gone, two command sites on _showActionError - list them with line numbers in your verification field; (d) confirm isRequestTimeout now has a src/ consumer via grep. No mutation check is possible for copy on a non-importable file - say so honestly in verification.
Return JSON per the schema: defects DEF-76 and DEF-81.`;

const A2 = `You are closing DEF-74 in ${ROOT}: the server-copy fork path (kimi, gemini) can hand a branch the parent's OLD colour, because the SERVER copies the colour during the fork while a client-side capture may still be queued unsent.
${CONSTITUTION}
Files you may edit: src/core/panel.ts (and src/__tests__/colour.spec.ts ONLY if you find the DEF-31 test harness there covers this path and can be extended cheaply - read it first).

The remedy is the ledger's own: reuse DEF-31's exact landed pattern from _inheritColour - gate on the store's isPending(parentId); when pending, await the store's public load() (which IS the serialisation-chain step: a queued request cannot be sent until the capture ahead of it has been answered). Apply it in _branchByServerCopy BEFORE the branch POST is issued, so the server's read of the colour store is fresh. Read _inheritColour and DEF-31's mechanism in src/core/colour.ts first (isPending, _pending, the _run chain) - your change should be the same few statements, not new machinery. The panel's ColourStore for the provider is reachable the same way _inheritColour reaches it.

Verification: (a) jlpm build:lib exit 0; (b) npx jest src/__tests__/colour.spec.ts green; (c) if you extended a spec, mutation-check it (scratch copy, restore byte-identical, name the reddened test); (d) state honestly, as DEF-31's own closure note did, that jsdom proves request ordering, not the rendered tint.
Return JSON per the schema: defect DEF-74.`;

const A3 = `You are closing DEF-85 and DEF-86 in ${ROOT}: the three recentLimit bounds exist in three places (src/core/panel.ts constants, hard literals in scripts/generate-schema.mjs, and the schema output), and two exported constants have no importer.
${CONSTITUTION}
Files you may edit: src/core/limits.ts (NEW), src/core/panel.ts, src/index.ts, scripts/generate-schema.mjs. Nothing else.

The single home: create src/core/limits.ts - a dependency-free module (NO imports at all - it must be importable under plain Node like lib/providers/index.js is) exporting DEFAULT_RECENT_LIMIT = 10, MIN_RECENT_LIMIT = 1, MAX_RECENT_LIMIT = 100, with a short doc comment explaining it is the ONE home for these bounds and why it must stay import-free (the schema generator imports the compiled lib/core/limits.js under Node). Then:
- panel.ts: delete its three constant definitions (currently ~lines 90-92), import them from './limits', keep every use site untouched. Re-export from panel.ts ONLY if something imports them from panel today - check src/index.ts:17 and update its import to '../core/limits' (or wherever the current path style points) instead.
- generate-schema.mjs: import the compiled lib/core/limits.js the same way it already imports the provider barrel, and use DEFAULT/MIN/MAX for the recentLimit schema entry's default/minimum/maximum in place of the literals 10/1/100.

Verification: (a) jlpm build:lib exit 0; (b) jlpm generate:schema (or the direct node invocation the file's header names) and confirm schema/plugin.json is BYTE-IDENTICAL to before (git diff --stat schema/) - the values did not change, only their home; (c) mutation check: in a scratch-copied limits.ts set MAX_RECENT_LIMIT = 50, rebuild lib, regenerate schema, confirm the schema now says maximum 50 (proves the generator genuinely reads the module), restore byte-identical, rebuild, regenerate, confirm schema back to 100; (d) npx jest src/__tests__ green (the clamp behaviour must be unchanged); (e) grep: MIN/MAX_RECENT_LIMIT now have importers outside their defining file.
Return JSON per the schema: defects DEF-85 and DEF-86.`;

const A4 = `You are closing DEF-92 in ${ROOT}: namingStrategy is a three-valued union ('launch-flag' | 'server-side' | 'none') of which the entire core reads exactly one bit (panel.ts: !== 'none'). This is a PURE REMOVAL - collapse it to a boolean.
${CONSTITUTION}
Files you may edit: src/core/types.ts, src/core/panel.ts, src/providers/claude.ts, src/providers/codex.ts, src/providers/gemini.ts, src/providers/kimi.ts, src/__tests__/registry.spec.ts, src/__tests__/panel.spec.ts. namingStrategy is TypeScript-only - grep-verified, no Python descriptor carries it, the parity test does not compare it. Do not touch Python.

The complete site list (verify by grep before editing, line numbers may have drifted):
- types.ts:89 field + the NamingStrategy union type + its doc block; also the comment at ~:238 referencing "namingStrategy: 'launch-flag'"
- panel.ts:919 reader: if (this._descriptor.namingStrategy !== 'none')
- claude.ts:52 'launch-flag' / gemini.ts:54 'server-side' / kimi.ts:127 'server-side' / codex.ts:48 'none' (plus the explanatory header comments in kimi.ts:12 and gemini.ts:12)
- registry.spec.ts:20 NAMING_STRATEGIES + :33 + :68; panel.spec.ts:62

Replace with promptsForBranchName: boolean - true for claude/gemini/kimi, false for codex - documented in types.ts as "whether the branch flow asks the user to name the new conversation" (where the name then GOES is forkStrategy's job, which is the confusion the union created). Update the kimi/gemini header comments and the ~:238 comment to speak in terms of the boolean. registry.spec asserts typeof descriptor.promptsForBranchName === 'boolean'; drop NAMING_STRATEGIES.

Verification: (a) grep -rn namingStrategy src/ returns NOTHING; (b) jlpm build:lib exit 0; (c) npx jest src/__tests__ green; (d) mutation check on a scratch copy: flip codex to true and confirm which test (if any) pins the per-provider VALUES - if none does, say so honestly rather than inventing one (the value is behaviour, pinned by the fork flow, not by registry.spec); restore byte-identical.
Return JSON per the schema: defect DEF-92.`;

// ── Lanes B-E: parallel, disjoint files ──────────────────────────────────────

const B = `You are closing DEF-97 and DEF-90 in ${ROOT} (Python providers and state).
${CONSTITUTION}
Files you may edit: jupyterlab_ai_code_assistants_extension/providers/gemini.py, providers/kimi.py, core/state.py, and (for DEF-90 only, if you add the caplog test) a test file under jupyterlab_ai_code_assistants_extension/tests/.

DEF-97 - two of three per-file metadata caches are uncapped. The capped sibling is providers/claude.py: _TAIL_CACHE_MAX = 1024 (near line 131) and, before insert (lines ~192-194), "if len(_tail_cache) >= _TAIL_CACHE_MAX: _tail_cache.clear()". Apply EXACTLY that three-line shape (module constant + wholesale clear before insert, with the same comment style claude.py uses) to gemini.py's _meta_cache (insert at ~:327) and kimi.py's _message_count_cache (insert at ~:226). Same constant value 1024. Nothing else.

DEF-90 - core/state.py swallows two OSErrors (near :136 and :153, both "except OSError: pass") and has no logger. The DEF-66 precedent shape, byte-for-byte in spirit: add _log = logging.getLogger(__name__) at module top matching how core/migrate.py declares its logger, and replace each bare pass with a _log.warning naming the provider id, the state file path and the errno. KEEP the swallow - best-effort is documented and intended; the docstrings say why. Do not touch the docstrings.

Verification: (a) PYTHONPATH=${ROOT} python -m pytest jupyterlab_ai_code_assistants_extension/tests -q - full suite green (163+ passing); (b) DEF-90 mutation check via a caplog test in the style the suite already uses: assert the warning fires when save_state raises OSError (monkeypatch), then scratch-mutate state.py back to bare pass and confirm exactly that test reddens, restore byte-identical, green; (c) DEF-97: a cheap test is welcome ONLY if the suite already has a natural home for cache tests - otherwise verify by code-trace and say so.
Return JSON per the schema: defects DEF-97 and DEF-90.`;

const C = `You are closing DEF-91 and DEF-82 in ${ROOT} (both in jupyterlab_ai_code_assistants_extension/core/routes.py - you own that file alone).
${CONSTITUTION}
Files you may edit: jupyterlab_ai_code_assistants_extension/core/routes.py, and tests under jupyterlab_ai_code_assistants_extension/tests/ if an assertion needs updating.

DEF-91 first - the saved-settings file is re-parsed 4-5x per request: _user_settings() (~:204) globs + regex-strips JSONC on every call, and _enabled_providers() calls it once per provider through _provider_enabled. The ledger's remedy: an OPTIONAL settings parameter on _provider_enabled (default None -> read as today), and _enabled_providers() reads _user_settings() ONCE and passes it down. No cache, no state, no other signature changes.

DEF-82 second - uniform IOLoop discipline. Six synchronous handlers do filesystem work on the event loop while every async body already uses run_in_executor: StatusHandler.get, FavouriteHandler.post, ColoursHandler.get / .post / .delete, TerminalHandler.get (ledger cited lines 323/506/555/562/591/851 - RE-LOCATE by name, the file changed since). Convert each to async def and move its filesystem-touching work into await loop.run_in_executor(None, ...), matching the exact idiom the file's existing seven sites use (loop = asyncio.get_running_loop() binding placement included). Keep response shapes and error paths byte-equivalent. Where a handler's fs work is a single call, wrap that call; where it is interleaved with request parsing, hoist the fs part into a small local function and executor-wrap that - the smallest change that gets fs off the loop, no restructuring beyond it.

Verification: (a) PYTHONPATH=${ROOT} python -m pytest jupyterlab_ai_code_assistants_extension/tests -q full green; (b) DEF-91 mutation check: instrument or monkeypatch-count load_jsonc/_user_settings calls in a scratch-side test run to show StatusHandler.get now parses ONCE (was 4) - report before/after counts; (c) DEF-82: grep the final file and report an inventory - every handler method and whether its fs work is executor-wrapped - in the verification field.
Return JSON per the schema: defects DEF-91 and DEF-82.`;

const D = `You are closing DEF-80 and DEF-84 in ${ROOT} (guard fixes - test files only).
${CONSTITUTION}
Files you may edit: src/__tests__/core-neutrality.spec.ts, plus ONE new pytest file jupyterlab_ai_code_assistants_extension/tests/test_request_ceiling.py.

DEF-80 - ONLY the real half: stripComments' block-comment removal (spec line ~87) deletes the newlines inside the comment, so a genuine violation in panel.ts would be reported ~141 lines off. Fix: the block-comment replacement preserves its newlines (replace each matched block with '\\n'.repeat(count of newlines in the match)). The '//'-inside-string truncation on the next line stays UNBUILT - the ledger rules it has nothing behind it; do not add a string-aware scanner.
Mutation check: on a SCRATCH COPY of a core file, plant a violation at a known line, run the guard, confirm the reported line matches the true line (it would have been off before); restore, guard green. Also verify the nine icons.ts http:// truncations still scan clean (they are namespace URLs, no violation behind them).

DEF-84 - REQUEST_TIMEOUT_MS (src/core/request.ts, 60_000) is bound to codex.py's _CLI_TIMEOUT_S = 30 by prose alone. Write test_request_ceiling.py in the repo's established source-reading-guard style (see core-neutrality.spec.ts and the DEF-73 block in colour.spec for the pattern; test_descriptor_parity.py for pytest file conventions): regex REQUEST_TIMEOUT_MS out of src/core/request.ts source, import _CLI_TIMEOUT_S from jupyterlab_ai_code_assistants_extension.providers.codex (import the module - do not regex Python you can import), assert REQUEST_TIMEOUT_MS >= 2 * _CLI_TIMEOUT_S * 1000, with a docstring naming DEF-84 and WHY the ratio (a Codex disposal legitimately holds the server one full CLI timeout; the client must sit a full timeout above). The regex must FAIL LOUDLY (pytest.fail, not skip) if the constant is not found - a silent skip is the vacuous-guard shape this ledger keeps burying.
Mutation check: scratch-copy request.ts, set the constant to 30_000, confirm the new test reds; restore byte-identical, green.

Verification: npx jest src/__tests__/core-neutrality.spec.ts green; PYTHONPATH=${ROOT} python -m pytest jupyterlab_ai_code_assistants_extension/tests/test_request_ceiling.py -q green; both mutation checks reported with the exact reddened test names.
Return JSON per the schema: defects DEF-80 and DEF-84.`;

const E = `You are closing DEF-87 and DEF-88 in ${ROOT} (migration end-to-end + Galata fixture).
${CONSTITUTION}
Files you may edit: a NEW pytest file under jupyterlab_ai_code_assistants_extension/tests/ (e.g. test_migrate_end_to_end.py), ui-tests/jupyter_server_test_config.py, ui-tests/tests/panel-regressions.spec.ts.

DEF-87 (MAJOR) - routes.py passes _user_settings_dir() into migrate.migrate, migrate accepts it, and BOTH ends can be severed with pytest staying green. The migration has also never been executed end to end. Two parts, in order:
1. REHEARSAL FIRST: read core/migrate.py to learn the exact legacy shape it consumes (the retired extensions' plugin ids, their user-settings file layout, favourites keys). Build a scratch settings tree under ${SCRATCH}/laneE/ seeding a REAL standalone-extension shape (e.g. the claude legacy plugin id from src/providers/claude.ts's legacyPluginId, a plugin.jupyterlab-settings with a favourite and a setting migrate maps). Run the migration against it through the same tornado test harness the existing route tests use, ONCE, and record in the 'observed' field exactly what came back (mapped keys, files written) - this is the campaign's first end-to-end execution of the modality.
2. THEN the committed test: turn that rehearsal into test_migrate_end_to_end.py, asserting (a) the mapped keys land, (b) the SETTINGS-DIR PLUMBING specifically - the route reads the CONFIGURED settings dir you point it at, not a default (this is the assertion whose absence is DEF-87: severing the _user_settings_dir() argument must redden this test).
Mutation check: scratch-copy routes.py, sever the settings-dir argument (pass None or the default), confirm the new test reds; restore byte-identical, green.

DEF-88 - the Galata fixture answers the agents route with [], so DEF-41's rendered proof covers the branch badge only. In ui-tests/jupyter_server_test_config.py, seed exactly ONE background agent into the agents answer (read how the config fakes the other routes and match its style; read what shape the real agents route returns from routes.py/the claude provider). Extend panel-regressions.spec.ts with one spec asserting the bg-agent chip renders inside its row (find the chip's class in panel.ts, sibling to the branchBadge assertion that exists). DO NOT run Galata - one runner at a time is a standing rule and the orchestrator runs the full suite in the gates phase. Verify the spec compiles: npx tsc --noEmit is BANNED; use the ui-tests tsconfig if one exists or leave TS verification to the suite run, but lint it: npx eslint ui-tests/tests/panel-regressions.spec.ts.

Verification: PYTHONPATH=${ROOT} python -m pytest jupyterlab_ai_code_assistants_extension/tests -q full green including your new file; the DEF-87 mutation check with the reddened test named; the observed rehearsal result; eslint clean on the spec.
Return JSON per the schema: defects DEF-87 and DEF-88.`;

// ── Execution ────────────────────────────────────────────────────────────────

log('Lane A (sequential, owns panel.ts) and lanes B-E (parallel) launching');

const laneA = (async () => {
  const out = [];
  out.push(
    await agent(A1, {
      label: 'A1 error-pass DEF-76+81',
      phase: 'Lane A - TypeScript panel',
      schema: LANE_SCHEMA,
      model: 'opus'
    })
  );
  out.push(
    await agent(A2, {
      label: 'A2 fork-drain DEF-74',
      phase: 'Lane A - TypeScript panel',
      schema: LANE_SCHEMA,
      model: 'opus'
    })
  );
  out.push(
    await agent(A3, {
      label: 'A3 limits DEF-85+86',
      phase: 'Lane A - TypeScript panel',
      schema: LANE_SCHEMA,
      model: 'opus'
    })
  );
  out.push(
    await agent(A4, {
      label: 'A4 collapse DEF-92',
      phase: 'Lane A - TypeScript panel',
      schema: LANE_SCHEMA,
      model: 'opus'
    })
  );
  return out;
})();

const rest = parallel([
  () =>
    agent(B, {
      label: 'B providers DEF-97+90',
      phase: 'Lanes B-E - parallel',
      schema: LANE_SCHEMA,
      model: 'opus'
    }),
  () =>
    agent(C, {
      label: 'C routes DEF-91+82',
      phase: 'Lanes B-E - parallel',
      schema: LANE_SCHEMA,
      model: 'opus'
    }),
  () =>
    agent(D, {
      label: 'D guards DEF-80+84',
      phase: 'Lanes B-E - parallel',
      schema: LANE_SCHEMA,
      model: 'opus'
    }),
  () =>
    agent(E, {
      label: 'E migration DEF-87+88',
      phase: 'Lanes B-E - parallel',
      schema: LANE_SCHEMA,
      model: 'opus'
    })
]);

const [a, bcde] = [await laneA, await rest];
const all = [...a, ...bcde.filter(Boolean)];
const flat = all.filter(Boolean).flatMap(r => r.defects || []);
log(
  `${flat.filter(d => d.status === 'fixed' || d.status === 'already-done').length} of 14 defects landed, ${flat.filter(d => d.status === 'blocked').length} blocked`
);
return {
  lanes: all,
  deviations: all.filter(Boolean).flatMap(r => r.deviations || [])
};
