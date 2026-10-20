# Recovery State - jupyterlab_ai_code_assistants_extension

## 2026-10-16 07:40 - RESUMED

The brace below is closed. Same session returned; no job had died. CI on `5bc8bb0` is green in every job - Build, Check Links, Integration tests (`Running 70 tests` -> `70 passed (4.2m)`, the sum of the `test(` declarations across all 17 spec files) and test_isolated, plus Check Release. That run answers pending item 1 and item 4 below, so `wf_00698ace-52c` was dropped rather than relaunched. `wf_322da9c6-751` was resumed from cache to file the two MINORs and run the two re-checks.

## 2026-10-16 06:45 - BRACE (reason: usage limits)

**HORIZON: LIMIT** - taken from the Star Colonel's stated reason, not from the probe. `brace-horizon` printed `CLEAR` (no Claude usage window near its ceiling); the cap being braced for is not the one that probe reads. Consequences: the host is fine, detached compute is not at risk, and this session should return after the cap resets. Workflows below are **paused, not killed** - resume them in this session and their completed agents replay from cache.

### Stopped workflows

1. run `wf_322da9c6-751` (task `w80oftej2`)
   - script: `/home/lab/.claude/projects/-home-lab-workspace-private-jupyterlab-jupyterlab-ai-code-assistants-extension/994048a0-6618-4947-a103-025bbd19ec03/workflows/scripts/last-two-statements-and-reconfirm-wf_322da9c6-751.js`
   - args: none
   - transcript dir: `.../subagents/workflows/wf_322da9c6-751`
   - phase reached: **Fix complete** - `README.md:41` now names only Kimi and DeepSeek, and the `core/routes.py` 409 comment states the contract in the right order (both verified by hand). The **Ledger lane was running and did not finish**; the ux and architect re-checks never ran.
   - resume: `Workflow({scriptPath, resumeFromRunId: 'wf_322da9c6-751'})` in this session; the fix agent replays from cache.

2. run `wf_00698ace-52c` (task `w1vynj6ul`)
   - script: `.../workflows/scripts/run-the-whole-browser-suite-wf_00698ace-52c.js`
   - args: none
   - transcript dir: `.../subagents/workflows/wf_00698ace-52c`
   - phase reached: Run lane started, **0 results** - the full 17-spec Galata suite never reported. Nothing cached.
   - resume: relaunch the same script, or let CI's `integration-tests` job run it.

### State

- Tree: `git status --porcelain` byte-identical before and after the stops (28 entries, snapshot at `/tmp/brace-tree-before.txt`). No file was left half-written; the docs gate (`pm-tools check docs/`) exits 0 with 0 errors.
- Running jobs of mine: none. Detached compute: none. Paused processes needing `kill -CONT`: none. Orphaned `dsh tui` probe processes were killed earlier today.

### Valid on disk (measured against the 1.2.78 build)

- pytest 351 passed, Jest 341 passed, `tsc` exit 0, prettier and eslint clean, 7 Galata specs green (deepseek 3, native-branch 2, codex-reuse 1, codex-rename 1)
- ledger: **0 open defects, 0 open criteria**; `pm-tools check docs/` exit 0, 448 warnings
- version 1.2.78; last commit `fdd5527`; tag `CHECKPOINT_DEEPSEEK_TAKEOVER_1.2.73` is local only and unpushed
- screenshots for every UI claim under `ui-tests/test-results/` (logo-verify, 8899)

### Pending work, in order

1. **FIRST ACTION** - read the CI run triggered by the push below (`build`, `integration-tests`, `check_links`; `gh run list --limit 3`), and fix the first red job. The push is **already done**: `bd19fd8..a8ba078` on `main`, so do not push again - just watch. The `integration-tests` job runs **all 17** ui-tests specs; only the four tonight's work touches have run locally, so it may report failures the local runs never saw.
2. File and close the two accepted MINORs from the final confirming round, through pm-tools: (a) the success toasts that echo a stored name can overrun JupyterLab's 140-character clip; (b) the minted-branch path prints a raw server code for non-409 refusals. Both are recorded in the confirming-round transcripts at `.../workflows/wf_81c0247e-692/journal.jsonl`.
3. Re-check the two corrected sentences with the ux and architect lenses (their agents never ran in the stopped workflow).
4. Run the full Galata suite locally (script in 2 above) if CI is not reachable.
5. Goal state at brace: clauses 1-7 of the project goal were met except clause 6's confirming-round accounting - ux and bug-hunter had confirmed, the architect's re-check and the ledger closure were the two open items. The goal hook is suspended by this brace and is reinstated on resume.

## BRACE 2026-10-20 16:09

### Horizon

- `brace-horizon` printed `CLEAR`: no usage window near its ceiling. The user gave no reason, so the board assumes **SERVER RESTART** (the worst case): every session-bound process is gone, and only what is on disk counts

### Stopped workflow

1. run `wf_a349b780-f06` (task `wf4rnr2tj`), stopped with TaskStop
   - script: `tmp/workflows/user-rulings/script.js` (gitignored under `tmp/`, kept on the workspace disk); it nests `tmp/workflows/review-busy-dialog/script.js`
   - args: none
   - transcript dir: `~/.claude/projects/-home-lab-workspace-private-jupyterlab-jupyterlab-ai-code-assistants-extension/82b6185d-3753-4627-9870-6ba388d6235e/subagents/workflows/wf_a349b780-f06`
   - phase reached: Implement - agent `implement-1` had started; it changed no file and wrote no checkpoint. Nothing to salvage from `journal.jsonl`
   - resume: same session `Workflow({scriptPath: 'tmp/workflows/user-rulings/script.js', resumeFromRunId: 'wf_a349b780-f06'})`; after a restart, relaunch with `scriptPath` alone - every stage returns its checkpoint when it holds
   - input it reads: `tmp/workflows/review-project/review-state-final.json` (the SHIP state of the project-wide review, round 2)

### Tree difference from the stop

- None: `git status --porcelain` was empty before and after the stop

### State

- HEAD `b719002` on `main`, pushed; working tree clean; installed build 1.2.172
- npm and PyPI carry 1.2.163; 1.2.171 and 1.2.172 are not published
- Trackers: 0 open of 215 criteria; 0 open of 329 closed and 11 rejected defects; `pm-tools check docs/` exit 0
- Gates at 1.2.172: Jest 378/378, pytest 387, Galata 84/84, lint clean
- Project-wide adversarial review of HEAD `3563288` (architect, bug-hunter, ux-designer): SHIP in round 2; its three MAJOR fixes are commit `b719002` (journal entry 140)
- Running jobs: none. Detached compute: none. Paused processes: none

### Pending work, in order

1. **FIRST ACTION** - relaunch the stopped workflow (command above). It applies the user's three rulings of 2026-10-20:
   - R1: in Manage Sessions, the second click of a double-click is ignored only within 600 ms of arming Delete
   - R2: a terminal that opens after the user pressed Hide does not take the keyboard
   - R3: dialog buttons show a focus outline for keyboard focus only (`:focus-visible`)
   - It then runs the confirming round of the project-wide review and writes the conclusions into `~/.claude/skills/jupyterlab-extension/design-language.md` and `design-system/extension-design-system.dc.html`, as the user asked ("update design system in /jupyterlab-extension with those conclusions")
2. After it returns SHIP: ask the user for commit approval for the project changes; the design-system edits in `~/.claude` stay uncommitted unless the user asks
3. Active goal (suspended by this brace, reinstated on resume): all functionality per acceptance criteria, criteria updated via pm-tools, unit and Galata tests green, no open defects with root causes recorded, architecture sound, project survived the adversarial review with architect, bug-hunter and ux-designer, last round SHIP. The rulings work must end in a SHIP round for the goal to hold
