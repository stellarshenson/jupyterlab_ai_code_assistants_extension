export const meta = {
  name: 'implement-ai-code-assistants',
  description:
    'Implement provider-registry core, four assistant providers, tests - per acceptance criteria',
  phases: [
    {
      title: 'Core',
      detail: 'TS panel core + Python server core, in parallel',
      model: 'opus'
    },
    {
      title: 'Providers',
      detail: 'claude / codex / kimi / gemini modules, in parallel',
      model: 'opus'
    },
    {
      title: 'Integrate',
      detail: 'make install + lint, fix loop until green',
      model: 'opus'
    },
    { title: 'Tests', detail: 'pytest + Jest, then Galata', model: 'opus' },
    {
      title: 'Fix',
      detail: 'fix DEF-1/3/4/5 from the defects register',
      model: 'opus'
    },
    {
      title: 'Re-verify',
      detail: 'make install + make test + Galata after fixes',
      model: 'opus'
    },
    {
      title: 'Review',
      detail: 'acceptance-criteria conformance audit',
      model: 'opus'
    }
  ]
};

const REPO =
  '/home/lab/workspace/private/jupyterlab/jupyterlab_ai_code_assistants_extension';

const PREAMBLE = `
Repo: ${REPO} - a JupyterLab 4 extension consolidating four AI code assistant panels behind a provider registry.

MANDATORY first reads, in this order:
1. ${REPO}/docs/acc-crit-jupyterlab-ai-code-assistants.md - the acceptance criteria; your work must satisfy the sections named in your task
2. ${REPO}/.claude/CLAUDE.md - project rules

Reference sources (read what your task needs, port mechanisms not files):
- BASE (architecture to generalise): /home/lab/workspace/private/jupyterlab/jupyterlab_claude_code_extension
- /home/lab/workspace/private/jupyterlab/jupyterlab_codex_extension
- /home/lab/workspace/private/jupyterlab/jupyterlab_kimi_code_extension

DISCIPLINE (non-negotiable):
- NEVER run git commit/push/tag, never publish, never edit version fields in package.json/pyproject.toml, never edit .copier-answers.yml
- Build lifecycle is Makefile-only; do NOT run pip/jlpm/npm/tsc or any build unless your task explicitly says so - builds are serialized in a later phase
- Match the base extension's code style (imperative DOM, no React, same comment density); docs use " - " never em-dash, no emojis
- Core code (src/core/, python core/) must never name an assistant - divergences are descriptor capability flags

RESUME RULE (the container hosting this run can die; the workflow re-runs from scratch): before writing anything, inspect your deliverable files. If they already exist and are complete, verify briefly and return status "already-done". If partially written, continue and repair - do not rewrite from scratch, do not duplicate.

Your final output goes through StructuredOutput. Keep "summary" under 150 words.
`;

const STATUS = {
  type: 'object',
  required: ['status', 'summary', 'files'],
  properties: {
    status: {
      type: 'string',
      enum: ['done', 'already-done', 'partial', 'blocked']
    },
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' }
  }
};

const GREEN = {
  type: 'object',
  required: ['green', 'summary'],
  properties: {
    green: { type: 'boolean' },
    summary: { type: 'string' },
    errors: { type: 'string' }
  }
};

const REVIEW = {
  type: 'object',
  required: ['summary', 'sections', 'risks'],
  properties: {
    summary: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['section', 'verdict', 'evidence'],
        properties: {
          section: { type: 'string' },
          verdict: { type: 'string', enum: ['met', 'partial', 'unmet'] },
          evidence: { type: 'string' }
        }
      }
    },
    risks: { type: 'array', items: { type: 'string' } }
  }
};

// ---------- Phase 1: Core (parallel pair) ----------
phase('Core');
log('Building TS panel core and Python server core in parallel');

const core = await parallel([
  () =>
    agent(
      `${PREAMBLE}
TASK: Build the TypeScript core of the extension. Deliverables:
- src/core/types.ts - IProviderDescriptor (id, label, icon name, cliBinary, capability flags: forkStrategy 'native-flag'|'native-command'|'server-copy', colourSource 'native'|'derived'|'none', launchModes, hasRemoteControl, hasBgAgents, hasLiveProcess, namingStrategy), plus the shared session/response interfaces generalised from the base's types.ts (ISession keyed so all four stores fit - see the types delta in the research doc)
- src/core/request.ts - requestAPI against namespace 'jupyterlab-ai-code-assistants-extension', provider-scoped paths 'providers/<id>/...' per the acc-crit API section
- src/core/panel.ts - the sessions panel widget generalised from BASE src/widget.ts (2571 lines): three sections, fuzzy filter, polling (30s, paused while menu open), context menu in a private CommandRegistry namespaced 'ai-code-assistants:<provider-id>:<action>', Manage Sessions popup, terminal-reuse ladder, launch flow. Provider-specific behaviour (badges, menu items, colour, launch payload extras, fork flow) must enter ONLY through the descriptor and small provider hook interfaces you define. Decompose - do not ship one 2500-line class if clean seams exist (panel vs popup vs terminal manager are natural splits)
- src/core/colour.ts - colour store client per the acc-crit Colour section: effective colour = user-set (write-back store) > native > derived FNV-1a > none; branch inheritance handled at fork call sites
- src/core/registry.ts - frontend registry consuming the barrel
- src/providers/index.ts - barrel importing ./claude ./codex ./kimi ./gemini (modules arrive in the next phase - fine, nothing builds yet)
- src/index.ts - activation: status probe listing providers, iterate registry, one panel per enabled+available provider, live enable/disable on settings change (dock/dispose, start/stop polling, add/remove commands, clear tints), sidebar re-dock, layout restore per widget id 'jupyterlab-ai-code-assistants-<id>'. MUST log verbatim: 'JupyterLab extension jupyterlab_ai_code_assistants_extension is activated!'
- schema/plugin.json - shared settings (presentationMode, recentLimit, sidebar) + per-provider 'providers.<id>.enabled' (default true) and per-provider mode settings. Each provider's unsafe-launch mode uses the ASSISTANT'S OWN terminology as the key and title, all off by default: claude dangerouslySkipPermissions, codex dangerouslyBypassApprovalsAndSandbox, kimi yoloMode, gemini yoloMode + approvalMode (default|auto_edit|yolo|plan). Note the schema-generated-from-registry criterion - a scripts/generate-schema.mjs emitting it from the barrel satisfies it, wire it as a package.json script but do not run builds
- src/core/icons.ts + style/base.css - port the icon/CSS scaffolding with a jp-AiAssistants prefix
Do NOT write the four provider modules. Do NOT run any build. Satisfy acc-crit sections: Provider Core, Settings, Panel, Sessions (frontend side), Colour.`,
      { label: 'core:ts', phase: 'Core', model: 'opus', schema: STATUS }
    ),

  () =>
    agent(
      `${PREAMBLE}
TASK: Build the Python server core. Deliverables under ${REPO}/jupyterlab_ai_code_assistants_extension/:
- core/registry.py - discovers provider modules in providers/ (import + iterate package modules), each exposing a descriptor (id, cli_binary, capabilities) and a store adapter instance; duplicate ids fail loudly at registration
- core/store.py - the store adapter contract (ABC): list_sessions(root_dir), list_branches, resolve_current, switch, fork, remove, cleanup, delete_branches, launch_argv(session_id?, new_id?, fork?, mode?), terminal identity hooks (comm name, cmdline parsers). Derived from the BASE sessions.py mechanisms but assistant-neutral
- core/routes.py - the full route tree from the acc-crit API section: GET status (providers list with id/label/enabled/cli_path/available), GET/POST providers/<id>/sessions|branches|switch|favourite|launch|branch, DELETE providers/<id>/sessions, POST migrate, GET terminal-cwd/<name>. Dispatch on provider id via the registry; 404 provider_unknown/provider_disabled, 503 cli_not_found. Port the launch trampoline (_INIT_WAITER SIGWINCH/stty wrapper) and terminal_manager.create flow from BASE routes.py verbatim - it is assistant-neutral
- core/colour_store.py - per-provider user-set colour persistence (extension-owned JSON file, atomic tmp+os.replace, keyed by session id), plus branch-inheritance write at fork time - acc-crit Colour section
- core/state.py - favourites + current-pin persistence generalised (per-provider state file; pin validation alnum+hyphen before any path join)
- core/migrate.py - idempotent one-shot migration reading the three standalone extensions' state files (paths in the research doc) into this extension's stores; never rewrites assistant session stores
- providers/__init__.py - package init for registry discovery
- routes.py + __init__.py at package top - rewire _load_jupyter_server_extension to core.routes setup
- tests/ - keep conftest.py working; do not write the test suite (a later phase owns it)
Do NOT write the four provider modules. Do NOT run pip or builds. Satisfy acc-crit sections: Provider Core (server side), Sessions (server side), Colour (store), Retirement and Migration (migration mechanics), API.`,
      { label: 'core:py', phase: 'Core', model: 'opus', schema: STATUS }
    )
]);

const coreBad = core.filter(Boolean).filter(r => r.status === 'blocked');
if (core.filter(Boolean).length < 2 || coreBad.length) {
  return { halted: 'core', core };
}

// ---------- Phase 2: Providers (parallel four) ----------
phase('Providers');
log('Core contracts on disk - implementing four providers in parallel');

const PROVIDERS = [
  {
    id: 'claude',
    brief: `Port from BASE. forkStrategy native-flag (--fork-session --session-id <client-uuid>), colourSource native (/color JSONL agent-color records via the six-id map), launch mode --dangerously-skip-permissions, hasRemoteControl (pid-file bridgeSessionId + 1h freshness), hasBgAgents (claude agents --json with 5s timeout + 35s cache, alive-pid predicate, attach verb decided server-side at launch, bg chips display-only). Store adapter: ~/.claude/projects JSONL scan with the lossy-encoding recovery chain, .jl-current pin, tail scans for cwd/custom-title/agent-color, sessions-index enrichment with distrust rules. Naming: -n flag. Satisfy acc-crit section: Claude Provider.`
  },
  {
    id: 'codex',
    brief: `Port from CODEX. forkStrategy native-command (codex fork <parent>, CLI mints id, frontend discovery watcher 2s x 90), colourSource none, launch mode --dangerously-bypass-approvals-and-sandbox. Store adapter: read-only SQLite state_<N>.sqlite (highest generation, URI + immutable fallback, rollout-JSONL degraded fallback), project key = cwd (adapter maps to the core's encoded-path slot), archived/sub_agent filtered from listing but not branches, destructive ops shell to codex archive / codex delete --force with 30s timeout and {removed_count, failed_count} reporting, delete_to_trash surfaced in status, hasLiveProcess (/proc comm==codex scan). Satisfy acc-crit section: Codex Provider.`
  },
  {
    id: 'kimi',
    brief: `Port from KIMI. forkStrategy server-copy (validate session_[0-9a-f-]{36}, copytree session dir, restamp state.json title/isCustomTitle/createdAt/updatedAt, append session_index.jsonl line, rmtree on failure, pin), colourSource derived (FNV-1a hash of session id mod six ids - but user write-back and branch inheritance take precedence per Colour section), launch kimi -S <id> + --yolo. Store adapter: workspaces.json wd_id registry honouring deleted_workspace_ids, state.json metadata, wire.jsonl message-count substring scan with mtime+size memo cache, recency = max(updatedAt, mtime). Port label.ts column-aware truncation into the provider (or core labels util if the core exposed one). Satisfy acc-crit section: Kimi Provider.`
  },
  {
    id: 'gemini',
    brief: `New provider - no source extension; research doc has the verified store and flags. forkStrategy server-copy (copy chat JSON with fresh id, stamp what the format allows - inspect a real chat file shape defensively), colourSource none, launch modes --yolo and --approval-mode (setting approvalMode default|auto_edit|yolo|plan). Store adapter: ~/.gemini/projects.json registry (project root -> short id), sessions at ~/.gemini/tmp/<shortId>/chats/*.json read in place - NEVER shell to the auth-gated CLI for listing. Resume via --session-file <path> (never --resume <index>), new session via --session-id <uuid> minted by the extension. Handle absent ~/.gemini and empty registry as empty listings. Satisfy acc-crit section: Gemini Provider.`
  }
];

const providers = await parallel(
  PROVIDERS.map(
    p => () =>
      agent(
        `${PREAMBLE}
TASK: Implement the ${p.id} provider. The core contracts are already on disk - read src/core/types.ts, src/providers/index.ts, jupyterlab_ai_code_assistants_extension/core/store.py and core/registry.py FIRST and conform to them exactly; if a contract is missing something your provider needs, note it in "notes" rather than editing core files.
Deliverables - exactly two modules plus nothing else:
- src/providers/${p.id}.ts
- jupyterlab_ai_code_assistants_extension/providers/${p.id}.py
${p.brief}
Do NOT edit any file outside your two modules. Do NOT run builds.`,
        {
          label: `provider:${p.id}`,
          phase: 'Providers',
          model: 'opus',
          schema: STATUS
        }
      )
  )
);

// ---------- Phase 3: Integrate (fix loop) ----------
phase('Integrate');
let integration = null;
for (let round = 1; round <= 4; round++) {
  log(`Integration round ${round}/4`);
  integration = await agent(
    `${PREAMBLE}
TASK: Make the extension build green. You ARE allowed to run builds - Makefile targets only, serialized in this phase.
1. Run: cd ${REPO} && make install 2>&1 | tail -50 (use set -o pipefail or capture exit properly - a piped tail must not mask failure)
2. If it fails: fix the actual errors - contract mismatches between core and providers, missing imports, TS config (typescript ~5.8.0 if lib0 TS2315 appears; webpack 5.106.0 and chalk 4.1.2 pins per the research doc - pins go in resolutions AND overrides)
3. Then: jlpm lint (allowed here, it is the Makefile-adjacent lint entry) and fix what it cannot auto-fix
4. Verify: jupyter labextension list and jupyter server extension list both show the extension OK
Round ${round} of at most 4. Prefer minimal surgical fixes; if a provider/core contract mismatch is systematic, fix the provider side, not the core, unless the core is plainly wrong. Report green only when make install exits 0 AND both extension listings show OK.`,
    {
      label: `integrate:r${round}`,
      phase: 'Integrate',
      model: 'opus',
      schema: GREEN
    }
  );
  if (integration && integration.green) break;
}

if (!integration || !integration.green) {
  return { halted: 'integration', core, providers, integration };
}

// ---------- Phase 4: Tests (sequential - shared node_modules and jlpm cache) ----------
phase('Tests');
log('Build green - authoring and running tests');

const unitTests = await agent(
  `${PREAMBLE}
TASK: Author and run the unit test tiers. Builds/tests via Makefile: make test (runs pytest + jest).
- pytest under jupyterlab_ai_code_assistants_extension/tests/: registry discovery + descriptor contract + duplicate-id failure; route gating (404 provider_disabled, 503 cli_not_found); store isolation (provider handler refuses another provider's paths); migration idempotence (fixture run twice = identical, no second write); colour store persistence + branch inheritance; per-adapter store scans against tmp fixture trees mimicking each assistant's layout (fixtures from the research doc shapes - never touch the real ~/.claude etc.)
- Jest under src/__tests__/: descriptor filtering, no-assistant-names-in-core source test (grep src/core/ for claude|codex|kimi|gemini outside comments), colour precedence logic, label truncation
- Acc-crit Testing section is your spec - including the mutation check: temporarily break registry discovery, confirm the guarding test goes red, restore, and record the evidence in your notes
Run make test; iterate until green or report what remains red and why.`,
  { label: 'tests:unit', phase: 'Tests', model: 'opus', schema: GREEN }
);

const galata = await agent(
  `${PREAMBLE}
TASK: Author the Galata suite per the acc-crit Testing section, then attempt to run it.

ENVIRONMENT ISOLATION (hard requirement from the user - the live system must not be touched):
- The Galata server runs from a DEDICATED VENV, not the conda/system environment: python3 -m venv ${REPO}/ui-tests/.venv && ${REPO}/ui-tests/.venv/bin/pip install "jupyterlab>=4,<5" "${REPO}" (the labextension assets are already built by the earlier make install, so the hatch hook reuses them via skip-if-exists)
- Verify inside the venv: its jupyter labextension list shows this extension OK and does NOT list jupyterlab_claude_code_extension / jupyterlab_codex_extension / jupyterlab_kimi_code_extension - a fresh venv guarantees their absence; NEVER pip uninstall anything from the conda/system environment, never modify the developer's live JupyterLab
- The webServer command must invoke the venv's jupyter (prefix PATH with ui-tests/.venv/bin), HOME/store env vars pointed at scratch fixtures, JUPYTER_RUNTIME_DIR private, hub tokens deleted per the research doc

SUITE:
- ui-tests/playwright.config.js: JLAB_TEST_PORT knob threaded to baseURL + webServer command + jupyter_server_test_config.py (read port with 'or "8888"' not a get() default), reuseExistingServer: false UNCONDITIONALLY, workers: 1, fullyParallel: false
- Specs: panel-per-enabled-provider (stub each provider's CLI as a fake executable on PATH inside the test env and point each store env-var/HOME at scratch fixtures), live disable/enable toggle docking exactly one panel, CLI-absent provider renders no panel and no error dialog, resume-opens-terminal against a seeded fixture store, activation-message grep
- CLAUDE REGRESSION SPEC (user requirement): port the original suite at /home/lab/workspace/private/jupyterlab/jupyterlab_claude_code_extension/ui-tests/tests/jupyterlab_claude_code_extension.spec.ts (1088 lines) into ui-tests/tests/claude-regression.spec.ts against the new Claude provider panel - translate selectors (old jp-ClaudeSessionsPanel prefix to the new panel classes, old command ids to ai-code-assistants:claude:*) while preserving every behavioural assertion that maps to a ported feature; list any assertion you had to drop with the reason in "errors"
- Scratch stores swept in webServer.command and globalTeardown (globalSetup runs AFTER the server - research doc)
- Run: cd ui-tests && jlpm install && jlpm playwright install chromium && JLAB_TEST_PORT=8899 jlpm playwright test > run.log 2>&1; echo exit:$? (never pipe through tee)
If the environment blocks the run (no browser download, port conflicts), author everything, get as far as possible, and return status with exact blocker in "errors".`,
  { label: 'tests:galata', phase: 'Tests', model: 'opus', schema: GREEN }
);

// ---------- Phase 4b: Fix defects (added after first full pass) ----------
phase('Fix');
log('Fixing DEF-1, DEF-3, DEF-4, DEF-5 from docs/defects.md');

const defectFix = await agent(
  `${PREAMBLE}
TASK: Fix EVERY open [ ] defect in ${REPO}/docs/defects.md (DEF-1, DEF-3, DEF-4, DEF-5, DEF-6, DEF-7, DEF-8 at the time of writing - the register is the source of truth, re-read it). Read the register first - each entry names cause and fix direction. You may run Makefile builds (make install, make test) - this phase is serialized. A previous fix attempt may have been interrupted mid-edit - repair and continue, do not restart from scratch.

- DEF-4 (decided by the user: HARD PIP DEPENDENCY, not bundling): add "jupyterlab_colourful_tab_extension>=1.0.19" to pyproject.toml [project] dependencies, mirroring the base extension (see its pyproject.toml:29-31 comment block for the federation rationale); keep the sharedPackages singleton config as-is; package.json dependency entry ^1.0.19 like the base
- DEF-5: core/routes.py must read the flat dotted settings keys ("providers.<id>.enabled") exactly as schema/plugin.json and src/index.ts write them; missing key reads as enabled per acc-crit
- DEF-3: align the three route-shape mismatches to the acc-crit API section as the contract of record - server implements the colour store routes the frontend calls (GET/POST/DELETE providers/<id>/colours), launch payload agrees on one shape (pick the simpler, update BOTH sides consistently), StatusHandler emits delete_to_trash, TerminalCwdHandler emits running
- DEF-1: give the core launch path a fork_from field for forkStrategy native-command providers (server passes it to the store's launch_argv; codex builds [codex, fork, <parent>]), and wire the frontend discovery watcher (port the 2s x 90 watcher mechanism from the original codex extension widget.ts:2456-2537) so the CLI-minted fork id is discovered and pinned; remove the codex xfail once green
- DEF-6: src/index.ts calls POST migrate exactly once at activation (before the first status render); it is idempotent server-side so a failure is a console.warn, never a hard stop
- DEF-7: at activation, app.hasPlugin('jupyterlab_claude_code_extension:plugin') (and codex/kimi equivalents) suppresses this extension's panel for that assistant and shows a one-time notice naming the package to uninstall - per the acc-crit Retirement conflict criteria; a suppressed provider must not poll or register commands
- DEF-8: gemini resume must use --session-file <chat file path>, never --resume <uuid>; the gemini store maps session id to its chat JSON path and launch_argv builds accordingly; cover with a unit test asserting the argv shape
After each fix: update the defect entry via the CLI ONLY - python3 /home/lab/.claude/skills/defects-tracking/scripts/defects.py log|close docs/defects.md --id DEF-N --event "..." (never edit defects.md directly), and extend the unit suites to cover the fixed behaviour (the route-gating test for DEF-5, a colour-route contract test for DEF-3, a codex fork test replacing the xfail for DEF-1).
Finish with make test green and make install green. Report green only when both exit 0 and all four defects are closed in the register.`,
  { label: 'fix:defects', phase: 'Fix', model: 'opus', schema: GREEN }
);

phase('Re-verify');
const reverify = await agent(
  `${PREAMBLE}
TASK: Re-run the full verification after the defect fixes. Serialized phase - builds allowed.
1. make install - must exit 0, both jupyter extension listings show OK
2. make test - must exit 0 (pytest + jest)
3. cd ui-tests && JLAB_TEST_PORT=8899 jlpm playwright test > run.log 2>&1; echo exit:$? - must exit 0; the .venv already exists, REINSTALL this extension into it first (ui-tests/.venv/bin/pip install --force-reinstall --no-deps "${REPO}") so the venv runs the fixed build; never touch the live environment
4. Confirm docs/defects.md has no open [ ] entries except any explicitly deferred with a dated note
Report green only when all three commands exit 0.`,
  { label: 'reverify', phase: 'Re-verify', model: 'opus', schema: GREEN }
);

// ---------- Phase 5: Review ----------
phase('Review');
const review = await agent(
  `${PREAMBLE}
TASK: Read-only conformance audit (post-defect-fix pass - DEF-1/3/4/5 have been fixed and re-verified before this audit runs). For every section of docs/acc-crit-jupyterlab-ai-code-assistants.md (Provider Core, Settings, Panel, Sessions, Colour, Retirement and Migration, Claude/Codex/Kimi/Gemini Providers, Testing, API), inspect the implementation and tests and give a verdict met/partial/unmet with concrete file:line evidence. Do NOT modify any file, do NOT tick any checkbox - the main session owns the doc. Verify the load-bearing negatives yourself: grep src/core/ and the python core/ for assistant names outside comments; confirm reuseExistingServer is unconditionally false; confirm no git commits were made (git log should still show only the initial import). List the top risks for a first live JupyterLab run.`,
  { label: 'review:acc-crit', phase: 'Review', model: 'opus', schema: REVIEW }
);

return { core, providers, integration, unitTests, galata, review };
