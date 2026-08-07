# Adversarial review - harvest instructions (written before session limit)

Round 1 spawned 2026-08-07 ~15:5x as three detached `claude -p` processes (still running at handoff).
Results land in:
`/tmp/claude-1000/-home-lab-workspace-private-jupyterlab-jupyterlab-ai-code-assistants-extension/0257fef0-9212-4c10-ab11-3a300a3b5938/scratchpad/adv/<adversary>-round1.txt`
for adversary in: architect, bug-hunter, ux-designer.

On resume:

1. If those files exist with a VERDICT line - copy them here (`logs/adversarial/`) and triage per the
   devils-advocate:adversarial-review skill rounds protocol: confirm each finding against the code,
   fix real ones, re-run the SAME adversary PINNED to the fixes (round 2). Clean confirming round
   closes the acc-crit "Adversarial review gate" criterion.
2. If the files are empty/absent (container died), re-spawn round 1 from the prompts in this
   directory: cd repo root, then per adversary:
   env -u CLAUDECODE claude -p "$(cat logs/adversarial/<a>-prompt.txt)" --output-format text \
   --dangerously-skip-permissions --max-turns 50 --no-session-persistence \
   > logs/adversarial/<a>-round1.txt 2>/dev/null < /dev/null &
3. Tree state at handoff: v0.1.9, DEF-1..9 all closed, 127 pytest + 59 Jest green, Galata 16/16
   (v0.1.6 run; re-run after adversarial fixes), 121/124 acc-crit closed, 2 deferred to release,
   1 open (this gate). Goal: all green + 3 adversaries clean + ship (user confirms version/registry).
