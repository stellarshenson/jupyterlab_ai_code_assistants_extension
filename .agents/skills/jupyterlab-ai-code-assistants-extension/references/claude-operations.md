# Claude Code operations

Mechanics and procedures for Claude Code sessions beyond `session-operations.md`. `$dir` stands for the project's transcript directory `~/.claude/projects/<encoded-cwd>`; find it by the records' `cwd`, as in `session-operations.md`.

## Contents

- [Stores beyond the transcript](#stores-beyond-the-transcript)
- [How continue and resume choose](#how-continue-and-resume-choose)
- [No conversation found to continue](#no-conversation-found-to-continue)
- [Background jobs](#background-jobs)
- [Re-homed and moved transcripts](#re-homed-and-moved-transcripts)
- [Branches](#branches)
- [Find the current session id](#find-the-current-session-id)
- [Make a conversation the project default](#make-a-conversation-the-project-default)
- [Transcript clean-up](#transcript-clean-up)
- [Symptoms and fixes](#symptoms-and-fixes)

## Stores beyond the transcript

- `CLAUDE_CONFIG_DIR` replaces `~/.claude` as the config root when set
- `~/.claude/sessions/<pid>.json` - one record per started process: `pid`, `sessionId`, `cwd`, `status`, `name`, `updatedAt`
- A background job's record adds `"kind": "bg"` and `jobId`
- Nothing prunes `~/.claude/sessions/`; a record outlives its process and can name a recycled pid
- `bridgeSessionId` in a record marks a remote-control bridge; it stays set after the bridge disconnects
- `~/.claude/jobs/<jobId>/state.json` - background job status: `state`, `detail`, `inFlight`
- `$dir/sessions-index.json` - Claude's own index; it drifts after an interrupted write, so trust the `*.jsonl` files
- `$dir/memory/` - project auto-memory, not session data; it has no matching `.jsonl`
- `~/.claude.json` `projects["<cwd>"]` also holds `lastGracefulShutdown` and per-project settings; its `history` array is typed-prompt history
- `~/.claude/history.jsonl` - global command history, not a transcript
- A transcript with no `user` or `assistant` record is metadata only (`last-prompt`, `custom-title`, `agent-name`, `mode`, `bridge-session`, `cost-state`); Claude writes that shape while a fork or bridge session starts
- `$dir/.jl-current` - pin of the retired standalone Claude Code extension; the panel reads it only when it holds no pin for the project, and deletes it on the next switch

## How continue and resume choose

- `claude -c` (`--continue`) orders the cwd's transcripts by file mtime and continues the newest it accepts
- It skips a transcript it refuses and tries the next newest (measured on CLI 2.1.246)
- It refuses a transcript whose chain root is a `system` record of subtype `compact_boundary`; every conversation takes that shape once compacted
- A live process holding a conversation keeps `-c` and `--resume <id>` off it
- The session you type in holds its own transcript, so `-c` cannot be tested from inside the conversation it should resume
- `claude -c -p "<prompt>"` on a closed conversation appends to the same transcript; no new file
- `claude --resume` without an id opens the project's interactive picker
- `claude --resume <id>` ignores mtime and opens a compacted conversation
- A live background worker holding the conversation makes `--resume <id>` refuse it
- No setting lets two live processes share one transcript, or lets `-c` attach to a live conversation
- An append sets the mtime to now; a transcript stamped with a future mtime stays newest until it is itself appended to

## No conversation found to continue

`claude -c` prints "No conversation found to continue" when it accepts no transcript of the cwd. Check the causes in this order.

| Cause                               | Diagnosis                                                                  | Fix                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Compacted root on every candidate   | first record with `"parentUuid": null` has `"subtype": "compact_boundary"` | open or Switch from the panel, which repairs it, or [repair the root](#repair-a-compacted-root); `claude --resume <id>` works meanwhile |
| Live process holds the conversation | [check for a live holder](#check-for-a-live-holder)                        | `/exit` that session                                                                                                                    |
| Orphaned bridge fork holds it       | holder has PPID 1, record `status: idle`, its launcher pid is dead         | [free the held transcript](#free-a-held-transcript)                                                                                     |
| Live background worker holds it     | `claude agents --json` lists it with a `pid`                               | [promote it](#promote-to-an-ordinary-session)                                                                                           |
| Wrong directory                     | no `$dir` for the cwd                                                      | run from `pwd -P`; a symlinked path component encodes differently                                                                       |

### Check for a live holder

```bash
pgrep -af "<id>"
python3 - "<id>" <<'EOF'
import glob, json, os, sys
for f in sorted(glob.glob(os.path.expanduser('~/.claude/sessions/*.json'))):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    if d.get('sessionId') == sys.argv[1]:
        pid = d.get('pid')
        print(os.path.basename(f), d.get('kind'), d.get('jobId'), d.get('status'), pid, os.path.exists(f'/proc/{pid}'))
EOF
```

- `pgrep -af "<id>"` matches `--resume <id>`, `--session-id <id>` and the pty host's `<id>.sock`
- A fork's command line reads `--session-id <child> --fork-session --resume <parent>`; match `--session-id <id>` and `<id>.sock`, never `resume <id>` alone
- A record whose pid is dead holds nothing

### Repair a compacted root

The panel repairs every copy of a conversation on Switch and on open. By hand:

- Confirm no live process holds the id; a rewrite that races an append loses the appended turns
- Repair every copy: `find ~/.claude/projects -name "<id>.jsonl"`
- The repair inserts a synthetic `isMeta` user record as the new root and points the boundary's `parentUuid` at it; every other line stays byte-identical and the mtime is kept
- `--fork-session` does not help: the fork inherits the boundary root

Save as `repair-root.py`, run `python3 repair-root.py <transcript>`:

```python
import json, os, sys, uuid
p = os.path.realpath(sys.argv[1])
st = os.stat(p)
with open(p, 'rb') as f:
    lines = f.readlines()
for i, raw in enumerate(lines):
    rec = json.loads(raw) if raw.strip() else {}
    if rec.get('uuid') and rec.get('parentUuid') is None:
        break
else:
    sys.exit('no root record')
if (rec.get('type'), rec.get('subtype')) != ('system', 'compact_boundary'):
    sys.exit('root is not a compact boundary - nothing to repair')
new = {'parentUuid': None, 'isSidechain': False, 'userType': 'external', 'type': 'user', 'isMeta': True,
       'message': {'role': 'user', 'content': '[conversation continued after compaction]'},
       'uuid': str(uuid.uuid4())}
new.update({k: rec[k] for k in ('timestamp', 'cwd', 'sessionId', 'version', 'gitBranch') if k in rec})
rec['parentUuid'] = new['uuid']
dump = lambda r: json.dumps(r, separators=(',', ':'), ensure_ascii=False).encode() + b'\n'
lines[i:i + 1] = [dump(new), dump(rec)]
tmp = p + '.repair'
with open(tmp, 'wb') as f:
    f.writelines(lines)
now = os.stat(p)
if (now.st_size, now.st_mtime_ns) != (st.st_size, st.st_mtime_ns):
    os.unlink(tmp)
    sys.exit('transcript changed while repairing - retry when idle')
os.chmod(tmp, st.st_mode & 0o777)
os.utime(tmp, ns=(st.st_atime_ns, st.st_mtime_ns))
os.replace(tmp, p)
print('repaired', p)
```

### Free a held transcript

An orphaned holder is a background bridge process left attached after its JupyterLab side died.

1. Find the pair: `pgrep -af "session-id <id>"` and `pgrep -af "<id>.sock"`
2. Run `ps -o pid,ppid,stat,etime,cmd -p <pids>`; PPID 1, idle state and a dead `--spawned-by` pid mark an orphan
3. Run `kill <session-pid> <pty-host-pid>`; use `kill -9` only on a survivor
4. Killing an idle holder loses nothing; the transcript on disk is append-only
5. Re-list with `ls -t "$dir"/*.jsonl`; a killed `claude --resume <missing-id>` writes a metadata-only stub for that id, which becomes newest
6. Confirm the stub holds no `user` or `assistant` record, then delete it
7. Check the real transcript's last line parses: `tail -n1 <file> | python3 -c 'import sys,json; json.loads(sys.stdin.read())'`

## Background jobs

- The daemon runs a job as `claude bg-pty-host --bg-pty-host <...>/<id>.sock ... --session-id <id> --fork-session --resume <parent>.jsonl --reply-on-resume --name "<label>"`
- A job keeps running after its terminal closes; `pgrep -af "<id>"` is the evidence, not the closed window
- `claude agents --json` lists agents; a background one has `"kind": "background"`, `id` (8-character short id) and `sessionId`
- The listing derives from on-disk job records and keeps finished jobs; only an entry carrying `pid` has a live worker
- A live worker owns its conversation and `claude --resume <id>` is refused while it runs
- `claude attach <short-id>` connects a terminal to the worker; the worker keeps ownership, so turns typed there stay in the agent and `-c` keeps skipping it
- `claude attach` takes no options; extra arguments print "warning: extra arguments ignored"
- `{"type": "agent-name", ...}` records in the transcript only label it an agent session in listings
- Hundreds of `agent-name` records are normal: one per rename plus periodic re-emission

### Promote to an ordinary session

1. Run `claude agents --json`; note the agent's `id`, `sessionId` and `pid`
2. Read `inFlight` in `~/.claude/jobs/<jobId>/state.json` (`jobId` from the session record); `{tasks: 0, queued: 0}` is safe to stop
3. Ignore `detail` for this decision; it lags and can describe finished work
4. Run `claude stop <short-id>` in a terminal; it ends the worker and its pty host, removes the record and keeps the conversation
5. Run `claude stop` on a TTY; without one (CLI 2.1.283) it starts a print-mode conversation with the prompt "stop" and leaves the agent running
6. If `claude stop` fails: `kill <job-pid> <bg-pty-host-pid>`, then wait with `timeout 20 tail --pid=<job-pid> -f /dev/null`
7. Confirm `~/.claude/sessions/<pid>.json` is gone; a clean SIGTERM removes it
8. Kill helpers the job left under `~/.claude/jobs/<jobId>/tmp/` with PPID 1; they hold no transcript but outlive the job
9. Confirm `pgrep -af "<id>"` prints nothing, then run `claude --resume <id>`; the resumed session is interactive (measured on CLI 2.1.283)
10. Optional: [strip the agent-name records](#strip-agent-name-records)

The panel performs steps 4 and 9 when it opens a conversation a live agent holds; it falls back to `claude attach` only when the stop fails.

### Strip agent-name records

- Only with no live process; a live one re-emits the records and rewrites the file
- Leave `<id>/custom-title.json`; it carries the human title
- The script writes `<file>.bak`, drops `agent-name` lines, and keeps every other line byte-identical and the mtime

```python
import json, os, shutil, sys
p = os.path.realpath(sys.argv[1])
st = os.stat(p)
shutil.copy2(p, p + '.bak')
kept, dropped = [], 0
with open(p, 'rb') as f:
    for raw in f:
        try:
            if json.loads(raw).get('type') == 'agent-name':
                dropped += 1
                continue
        except (ValueError, AttributeError):
            pass
        kept.append(raw)
with open(p + '.tmp', 'wb') as f:
    f.writelines(kept)
os.utime(p + '.tmp', ns=(st.st_atime_ns, st.st_mtime_ns))
os.replace(p + '.tmp', p)
print('kept', len(kept), 'dropped', dropped)
```

## Re-homed and moved transcripts

- One id can sit under two encoded dirs; a project folder rename leaves it under the old and the new one
- After a rename the records still carry the old `cwd`
- The copies share a byte-identical prefix and diverge where the second writer started: `cmp -n "$(stat -c %s A)" A B`
- `claude -c` in either directory continues that directory's copy
- A tool matching by id alone can pick the other project; match the `cwd` as well
- Deleting one copy deletes only that location's history
- To keep one conversation, resume it from one directory only
- Repair a compacted root in every copy

Moving a conversation, in addition to `session-operations.md`:

- Close the conversation first; a running session writes to its cwd-derived path on every turn, so a file moved live is recreated at the old path
- An absent open file descriptor does not prove the session idle; the bridge opens, appends and closes per write
- `pgrep -af "resume <id>"` can miss a bridge branch, whose live process may be attached to the parent id
- Confirm the id from `/status` inside the session or from the user; `lastSessionId` and the `--resume` process can name the pre-compact parent
- `sessions move` creates the target's transcript directory; `--to` must be an existing folder
- A compacted branch carries its summary and resumes without its parent; move the parent only for the pre-compact history
- A running session's cwd is fixed; it changes only on the relaunch from the target directory
- The panel honours a pin whose transcript records a foreign `cwd`; unpinned, it prefers the newest transcript whose `cwd` encodes to the directory

## Branches

- Every transcript with a `user` or `assistant` record in `$dir` is a branch; the panel shows a count badge and "Switch and Manage Sessions" when there is more than one
- Branch from the CLI, in the project directory that encodes to `$dir`; a record's `cwd` can be a subfolder or a pre-rename path:

```bash
new=$(python3 -c 'import uuid; print(uuid.uuid4())')
claude -p --resume <id> --fork-session --session-id "$new" "/rename <name>"
claude --resume "$new"
```

- Print mode runs `/rename` and `/color` without a model turn
- The child inherits a compacted root; [repair it](#repair-a-compacted-root) for `-c`

### Collapse to one

1. Branch the conversation to keep when a live process holds it; the child is a new, unheld, newest id
2. Exit every live process on the other branches
3. Delete each other branch with `jupyterlab-ai-code-assistants sessions delete <id> -a claude -p <project>`; it removes `<id>.jsonl` and `<id>/` as a pair
4. Re-pin; a `.pinned-session` or panel pin naming a removed id is stale
5. `claude -c` now has one candidate

- Panel "Clean Up Parallel Sessions (N)" removes every conversation of the project except the current one
- The panel never deletes the current conversation; its deletes follow JupyterLab's `delete_to_trash` setting

## Find the current session id

- Inside a session: `/status`
- Panel: Copy Session ID
- Index: `python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.claude.json')))['projects']['$PWD']['lastSessionId'])"`
- `lastSessionId` has been seen `null` with `lastGracefulShutdown: false`, and can name a pre-compact parent
- Disk: `ls -t "$dir"/*.jsonl | head -1` gives the newest by mtime, which `-c` tries first
- Running process: `sessionId` in `~/.claude/sessions/<pid>.json`; Claude writes it for every interactive launch, whatever the flags
- Command line: `--session-id` names the running conversation when both it and `--resume` appear
- An attach client writes no record; its id is the `claude attach <short-id>` argument, the prefix of the transcript name

## Make a conversation the project default

- `jupyterlab-ai-code-assistants sessions switch <id> -a claude` runs panel Switch from a terminal; never stamp by hand while a server answers
- With one conversation, the newest accepted unheld transcript is already the default for `-c`
- Panel Switch repairs a compacted root, gives back the previous switch's stamp, stamps the target's mtime 30 days ahead and pins it in the panel state
- The stamp holds until the stamped transcript is next appended to, which is the first turn in it; a sibling append can overtake it after that
- A plain `touch` loses within seconds to any sibling still being written
- Only when no server answers (the command exits 3), stamp by hand: `touch -m -d "@$(( $(date +%s) + 2592000 ))" "$dir/<id>.jsonl"`
- A hand stamp leaves a panel pin unchanged: the panel marks the pinned conversation current while `claude -c` resumes the stamped one; run `sessions switch` once a server answers
- Before a hand stamp, give the old stamp back:

```bash
now=$(date +%s)
for f in "$dir"/*.jsonl; do
  m=$(stat -c %Y "$f")
  if [ "$m" -gt "$now" ]; then touch -m -d "@$((m - 2592000))" "$f"; fi
done
```

- `claude --resume <id>` ignores mtime and always lands on `<id>`

### Pins

- `$dir/.pinned-session` holds a plain id; Claude's `*.jsonl` scan ignores it
- Panel pin: `pins["<encoded-cwd>"]` in `<jupyter-data-dir>/ai-code-assistants/claude.json`
- `pin_snapshots["<encoded-cwd>"]` in the same file: `ids`, every conversation the project held when the panel pin was written, and `at`, that time in epoch seconds
- A transcript holding a message whose id is missing from `ids` was created after the panel pin and supersedes it: the panel pin is skipped and the newest transcript of all is current; a panel pin with no `pin_snapshots` entry is honoured
- `JUPYTERLAB_AI_CODE_ASSISTANTS_STATE_DIR` replaces `<jupyter-data-dir>/ai-code-assistants`
- Print the data dir: `python3 -c 'from jupyter_core.paths import jupyter_data_dir; print(jupyter_data_dir())'`
- Neither pin drives `claude -c`
- Pin by hand: `printf '%s' "<id>" > "$dir/.pinned-session"`

### Resume the pinned conversation

Resume a project's pinned conversation by id, with a fallback when no pin resolves:

1. `cd` to the project and resolve `$dir` from `pwd -P`
2. Take the id in `$dir/.pinned-session` when `$dir/<id>.jsonl` exists
3. Otherwise take the panel pin for the encoded dir when its transcript exists, unless a transcript holding a message is missing from its `pin_snapshots` ids; such a pin is superseded and skipped. A superseded pin leaves the current conversation to this read-only command, which ranks a future mtime as that mtime less 30 days:

   ```bash
   now=$(date +%s); for f in "$dir"/*.jsonl; do m=$(stat -c %Y "$f"); [ "$m" -gt "$now" ] && m=$((m - 2592000)); echo "$m $f"; done | sort -rn | head -1
   ```

4. Otherwise take the newest: `ls -t "$dir"/*.jsonl | head -1`
5. Run `claude --resume <id>`

- A pin naming a deleted transcript is skipped; rewrite or remove it

## Transcript clean-up

Survey both classes before proposing anything. In-session artifacts usually outweigh extra transcripts: one measured sweep freed 16 MiB of extra transcripts against 2,027 MiB inside kept sessions.

### Extra transcripts

1. Survey each project: keep the newest, size the rest with their side dirs (script below)
2. Split by the newest extra's age: 30 days and older is stale, newer may still be active
3. Ask the user; transcripts exist only here and deletion is permanent unless moved to a trash
4. Delete each extra with `jupyterlab-ai-code-assistants sessions delete <id> -a claude -p <project>`, which removes `<id>.jsonl` and `<id>/` as a pair; an orphaned `<id>/` is unreachable
5. Re-scan: each acted-on project holds one conversation; check `du -sh ~/.claude/projects`

```python
import sys, time
from pathlib import Path
base = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else Path.home() / '.claude/projects'
now = time.time()
def size(t):
    side = t.with_suffix('')
    return t.stat().st_size + (sum(f.stat().st_size for f in side.rglob('*') if f.is_file()) if side.is_dir() else 0)
for d in sorted(p for p in base.iterdir() if p.is_dir()):
    ts = sorted(d.glob('*.jsonl'), key=lambda t: t.stat().st_mtime, reverse=True)
    if len(ts) > 1:
        extras = ts[1:]
        age = (now - extras[0].stat().st_mtime) / 86400
        print(f'{d.name}\textras={len(extras)}\tMiB={sum(map(size, extras)) / 2**20:.1f}\tnewest_extra_days={age:.0f}')
```

### In-session artifacts

Sweep each child of `<id>/` separately:

| Child                               | Holds                                | Conversation history        | Cutoff                         |
| ----------------------------------- | ------------------------------------ | --------------------------- | ------------------------------ |
| `tool-results/`                     | overflow files of large tool outputs | no                          | 30 days; largest single target |
| `subagents/`                        | subagent transcripts                 | yes; say so before deleting | 30 days                        |
| `workflows/`                        | workflow run artifacts               | no                          | 7 days                         |
| `session-memory/`, `remote-agents/` | negligible                           | -                           | leave                          |

### Other stores

- `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` keeps every superseded version; keep the `installPath` in `~/.claude/plugins/installed_plugins.json`, delete the rest
- Never pick a plugin version dir by glob; it can resolve to a stale one
- `~/.claude/sessions/<pid>.json`: delete records whose pid is dead; a recycled pid reads as alive and is kept
- `~/.claude/tasks/<session-id>/`: keep every dir holding a `pending` or `in_progress` task; delete empty and all-completed ones

### Never delete

- The newest conversation of a project, or the one a pin names
- The running session's own `<id>/`; its `tool-results/` may still be read this turn
- `$dir/memory/`; exclude it by name before any "no matching transcript" test
- `~/.claude/projects/` itself, or `~/.claude/history.jsonl`
- A project dir with no conversation; report it and change nothing

## Symptoms and fixes

| Symptom                                                                             | Cause                                                                      | Fix                                                                     |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| "No conversation found to continue" on an intact, unheld transcript the panel opens | compacted root                                                             | panel open or Switch, or [repair the root](#repair-a-compacted-root)    |
| "No conversation found to continue" with the only conversation open                 | a live process holds it                                                    | `/exit` that session                                                    |
| "No conversation found to continue" on a single-transcript project nobody works in  | orphaned bridge fork holds it                                              | [free the held transcript](#free-a-held-transcript)                     |
| Listed as an agent session; closing the terminal changes nothing                    | a running background job                                                   | [promote it](#promote-to-an-ordinary-session)                           |
| `agent-name` records stripped, `-c` still skips it                                  | the job still runs                                                         | `claude stop <short-id>` first                                          |
| Opened through `claude attach`, `-c` still skips it                                 | the worker keeps ownership                                                 | stop the agent, resume by id                                            |
| `-c` opens an empty conversation after a cleanup kill                               | a metadata-only stub became newest                                         | delete the stub                                                         |
| `-c` lands on another conversation than the panel shows                             | a sibling append overtook the switch stamp, or a newer conversation exists | Switch again, or resume by id                                           |
| Resume by pin fails                                                                 | the pin names a branch deleted in a collapse                               | re-pin to the surviving id                                              |
| Nothing under `$dir`                                                                | wrong cwd or a symlinked path component                                    | run from `pwd -P`                                                       |
| Transcript present but unreadable                                                   | truncated last line                                                        | check it as in [free a held transcript](#free-a-held-transcript) step 7 |
