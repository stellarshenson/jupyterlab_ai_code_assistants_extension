# Cross-assistant sessions

Read, inventory, resume and take over the sessions of one project across the five assistants the panels list: Claude Code, Codex, Kimi, Gemini and DeepSeek (`dsh`). Claude Code storage mechanics beyond reading live in `session-operations.md` and `claude-operations.md`.

Contents:

- [Setup](#setup)
- [Stores](#stores)
- [Resume as the extension launches](#resume-as-the-extension-launches)
- [Claude Code](#claude-code)
- [Codex](#codex)
- [Kimi](#kimi)
- [Gemini](#gemini)
- [DeepSeek and dsh](#deepseek-and-dsh)
- [Inventory across all five](#inventory-across-all-five)
- [Take over another assistant's work](#take-over-another-assistants-work)
- [Reading rules](#reading-rules)

## Setup

```bash
REAL=$(realpath "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
OUT="${TMPDIR:-/tmp}/session-transfer"; mkdir -p "$OUT"
under() { case "$1" in "$REAL"|"$REAL"/*) return 0 ;; esac; return 1; }
rd() { case "$1" in *.zst|*.zstd) zstd -dc -- "$1" ;; *) cat -- "$1" ;; esac; }
```

- Match a session to the exact root or a path under it; a session started in a subfolder belongs to the project
- Prefer the exact root when both exist
- Without the `zstd` command, decompress with `zstandard`, a dependency of the extension, in the Python that runs the Jupyter server: `python3 -c 'import sys, zstandard; sys.stdout.buffer.write(zstandard.ZstdDecompressor().stream_reader(open(sys.argv[1], "rb").read(), read_across_frames=True).read())' "$F"`

## Stores

| Assistant   | Root (override)                   | Project key               | One conversation                                      | Id               | Last activity                                                                                                                 |
| ----------- | --------------------------------- | ------------------------- | ----------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `~/.claude` (`CLAUDE_CONFIG_DIR`) | record `cwd`              | `projects/<encoded-cwd>/<id>.jsonl`                   | UUID             | newest record `timestamp`                                                                                                     |
| Codex       | `~/.codex` (`CODEX_HOME`)         | thread `cwd`              | `sessions/YYYY/MM/DD/rollout-*.jsonl` or `.jsonl.zst` | UUID             | `recency_at_ms` in `state_<N>.sqlite`, else `updated_at_ms`, then `created_at_ms`; rollout mtime when the index is unreadable |
| Kimi        | `~/.kimi-code` (`KIMI_CODE_HOME`) | `workspaces.json` `wd_id` | `sessions/<wd_id>/session_<uuid>/`                    | `session_<uuid>` | later of `updatedAt` and `state.json` mtime                                                                                   |
| Gemini      | `~/.gemini` (follows `HOME`)      | `projects.json` short id  | `tmp/<short id>/chats/session-*.jsonl` or `.json`     | UUID             | chat file mtime                                                                                                               |
| DeepSeek    | `~/.dsh` (`DSH_HOME`)             | header `cwd`              | `sessions/--<key>--/<id>/session.v<N>.jsonl.zstd`     | `session-<uuid>` | log mtime                                                                                                                     |

- A panel switch stamps a Claude transcript's mtime 30 days ahead so `claude -c` selects it; the mtime is then not activity
- A panel switch touches the Kimi `state.json`, Gemini chat file or DeepSeek log to the switch time
- A panel rename of a Claude, Kimi, Gemini or DeepSeek conversation puts the mtime back
- Panel pins and favourites live in the extension's own state, never in an assistant's store

## Resume as the extension launches

| Assistant   | Resume                          | New                          | Approval mode flag                           |
| ----------- | ------------------------------- | ---------------------------- | -------------------------------------------- |
| Claude Code | `claude --resume <id>`          | `claude --session-id <uuid>` | `--dangerously-skip-permissions`             |
| Codex       | `codex resume <id>`             | `codex`                      | `--dangerously-bypass-approvals-and-sandbox` |
| Kimi        | `kimi -S <session_id>`          | `kimi`                       | `--yolo`                                     |
| Gemini      | `gemini --resume <id>`          | `gemini --session-id <uuid>` | `--yolo`                                     |
| DeepSeek    | `dsh tui --resume <session-id>` | `dsh tui`                    | none                                         |

- Claude: a live background agent holding the conversation refuses `--resume`
- Claude: the extension stops that agent with `claude stop <short id>`, then resumes; it runs `claude attach <short id>` only when the stop fails
- Claude: run `claude stop` on a terminal; without a TTY the CLI starts a print-mode conversation with the prompt "stop" and leaves the agent running (measured on CLI 2.1.283)
- Claude: `claude agents --json` lists agents; an entry with `kind: "background"` and a `pid` is a live worker
- Codex: the extension creates a new thread through `codex app-server --stdio` (`thread/start` with the project `cwd`), then runs `codex resume <id>`, so every terminal carries its id
- Kimi: `--session <id>` equals `-S <id>`; a bare UUID gets the `session_` prefix
- Kimi: a bare `-S` opens the interactive picker
- Gemini: pass the full session id; the CLI matches a full id before it reads the argument as a listing index, and appends the new turns to that conversation's own file under the same id
- Gemini: `--resume latest` and `--resume <index>` name no fixed conversation
- Gemini: run it in the project directory; the lookup covers the chats of the project the working directory belongs to
- Gemini: the lookup skips a chat without `projectHash` or without one message worth resuming; a panel branch keeps both from its source
- Gemini: the chat filename carries only the first 8 characters of the id; find the file by its `sessionId` record
- Gemini: `--session-file <chat file>` is no resume; it imports the chat as a new conversation, a copy `session-<epoch ms>-<first 8 characters of a new id>.jsonl`, and writes the new turns there, none to the named file
- DeepSeek: `dsh tui` needs the `tui` profile, a directory `profiles/tui` under `$DSH_HOME` (default `~/.dsh`)
- DeepSeek: mount the profile with `dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui`
- DeepSeek: `dsh tui` boots the TUI in the project directory; the TUI mints a new conversation's id

## Claude Code

- The side directory `<id>/`: `session-operations.md`
- Match a transcript by its records' `cwd`, not the directory name; the tail `cwd` is where it last ran and differs from the head after a folder rename
- `projects/<encoded-cwd>/sessions-index.json` - Claude's own index, `entries[].sessionId` and `.summary`; it drifts after a crash, so scan the transcripts
- `sessions/<pid>.json` - one per interactive process: `sessionId`, `cwd`, `pid`, `updatedAt` (epoch ms), `name`, `bridgeSessionId`; never pruned, so check the pid is alive
- A transcript with no `user` or `assistant` record is a stub written while a fork or bridge session is created; skip it
- A `deepseek-*` value in `message.model` marks a DeepSeek model run through Claude Code; it lives in this store
- Subagents: `<encoded-cwd>/<id>/subagents/*.jsonl`; tasks: `~/.claude/tasks/<id>/*.json`

Per transcript `F`:

```bash
# Title: the last custom-title, else the last ai-title
jq -nrR '[inputs | fromjson? | select(.type=="custom-title" or .type=="ai-title")] | (map(select(.type=="custom-title")) | last | .customTitle) // (last | .aiTitle) // ""' "$F"
# Models
jq -rR 'fromjson? | select(.type=="assistant") | .message.model' "$F" | sort | uniq -c
# First and last timestamp
jq -rR 'fromjson? | select(.timestamp != null) | .timestamp' "$F" | sed -n '1p;$p'
# Human prompts (tool results and meta records excluded)
jq -rR 'fromjson? | select(.type=="user" and .isMeta != true) | .timestamp as $t | (.message.content | if type=="string" then . else ([.[]? | select(.type=="text") | .text] | join("\n")) end) as $x | select($x != "") | "### " + $t + "\n" + $x' "$F"
# System events: task notifications, goal notices, local-command output
jq -rR 'fromjson? | select(.type=="user" and .isMeta == true) | .timestamp as $t | (.message.content | if type=="string" then . else ([.[]? | select(.type=="text") | .text] | join("\n")) end) as $x | select($x|test("<task-notification>|<command-name>|<local-command-stdout>|Goal set|system-reminder")) | "### " + $t + "\n" + $x' "$F"
# Assistant text
jq -rR 'fromjson? | select(.type=="assistant") | .timestamp as $t | ([.message.content[]? | select(.type=="text") | .text] | join("\n")) as $x | select($x != "") | "### " + $t + "\n" + $x' "$F"
# Tool calls
jq -rR 'fromjson? | select(.type=="assistant") | .timestamp as $t | .message.content[]? | select(.type=="tool_use") | "### " + $t + " | " + .name + " | " + (((.input.command // .input.file_path // .input.path // .input.description // .input.pattern // .input.summary // .input.skill // "") | tostring) | gsub("\n"; " "))[0:180]' "$F"
# Last answer
jq -nrR '[inputs | fromjson? | select(.type=="assistant") | [.message.content[]? | select(.type=="text") | .text] | join("\n") | select(. != "")] | last // ""' "$F"
```

- A compaction summary is the first user message starting `[conversation continued after compaction]` or `This session is being continued`; read it first
- A `system` record with `subtype` `compact_boundary` marks a compaction
- A meta `user` record whose whole content is `[conversation continued after compaction]` is the root the extension adds so `claude -c` accepts a compacted transcript; it carries no summary

## Codex

- Index: `state_<N>.sqlite`, highest `N`, table `threads`: `id`, `cwd`, `name`, `preview`, `first_user_message`, `created_at_ms`, `updated_at_ms`, `recency_at_ms`, `git_branch`, `model`, `tokens_used`, `source`, `archived`, `has_user_event`; older generations lack some columns
- `name` is the thread title; `codex app-server` method `thread/name/set` writes it
- The panel lists no thread with `archived` set or `source` `sub_agent`
- A thread with no user event, preview or first user message has no turn yet: abandoned, or new and before its first turn
- The panel keys a project by exact `cwd`; a thread started in a subfolder is its own panel row
- Rollouts: `sessions/**/rollout-*.jsonl` and compressed `rollout-*.jsonl.zst`; older ones in `archived_sessions/`
- The first lines of a rollout carry `session_meta` with `payload.id` and `payload.cwd`
- No index, or an unreadable one: scan the rollouts, as the extension does
- `session_index.jsonl` - one line per thread with `id`, `thread_name`, `updated_at`

```bash
# Threads of this project from the index, read-only
python3 -c '
import glob, os, re, sqlite3, sys, urllib.parse
home = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
db = max((int(m.group(1)), p) for p in glob.glob(os.path.join(home, "state_*.sqlite")) if (m := re.fullmatch(r"state_(\d+)\.sqlite", os.path.basename(p))))[1]
con = sqlite3.connect("file:" + urllib.parse.quote(db) + "?mode=ro", uri=True)
cols = [r[1] for r in con.execute("PRAGMA table_info(threads)")]
want = [c for c in ("recency_at_ms", "id", "name", "model", "source", "archived", "cwd") if c in cols]
for row in con.execute("SELECT " + ",".join(want) + " FROM threads"):
    r = dict(zip(want, row))
    c = r.get("cwd") or ""
    if c == sys.argv[1] or c.startswith(sys.argv[1] + "/"):
        print(*(str(r.get(k, "")).replace("\n", " ") for k in want), sep="\t")
' "$REAL" | sort -rn
```

Per rollout `F`:

```bash
# Start, id, cwd, CLI version, provider
rd "$F" | jq -rR 'fromjson? | select(.type=="session_meta") | [.payload.timestamp, .payload.id, .payload.cwd, .payload.cli_version, .payload.model_provider] | @tsv' | head -n 1
# Title from the session index
jq -r --arg id "<id>" 'select(.id==$id) | [.thread_name, .updated_at] | @tsv' "${CODEX_HOME:-$HOME/.codex}/session_index.jsonl"
# Last timestamp
rd "$F" | jq -rR 'fromjson? | .timestamp // empty' | tail -n 1
# User messages
rd "$F" | jq -rR 'fromjson? | select(.type=="response_item" and .payload.type=="message" and .payload.role=="user") | "### " + .timestamp + "\n" + ([.payload.content[]? | select(.type=="input_text") | .text] | join("\n"))'
# Assistant messages
rd "$F" | jq -rR 'fromjson? | select(.type=="response_item" and .payload.type=="message" and .payload.role=="assistant") | "### " + .timestamp + "\n" + ([.payload.content[]? | select(.type=="output_text") | .text] | join("\n"))'
# Tool calls; payload types vary by tool family
rd "$F" | jq -rR 'fromjson? | select(.type=="response_item") | .payload | select(.type|test("call")) | "### " + (.name // .type) + " | " + ((.input // .arguments // .action // "")|tostring|gsub("\n";" "))[0:180]'
# Payload types, when a shape is not covered
rd "$F" | jq -rR 'fromjson? | select(.type=="response_item") | .payload.type' | sort | uniq -c
# Last answer
rd "$F" | jq -rR 'fromjson? | select(.type=="event_msg" and .payload.type=="task_complete") | .payload.last_agent_message' | tail -n 1
```

## Kimi

- `workspaces.json`: `workspaces.<wd_id>.root` is the project root; skip ids listed in `deleted_workspace_ids`
- One conversation: `sessions/<wd_id>/session_<uuid>/` with `state.json` and one `agents/<agent>/wire.jsonl` per agent; the main agent is `agents/main/`
- `state.json`: `title`, `isCustomTitle`, `createdAt`, `updatedAt`, `workDir`, `lastPrompt`
- `isCustomTitle: true` marks a name the user set; otherwise the CLI derives the title from the first prompt
- `session_index.jsonl` - one line per conversation with `sessionId`, `sessionDir`, `workDir`; an alternative project match by `workDir`

```bash
KM="${KIMI_CODE_HOME:-$HOME/.kimi-code}"
# Session directories of this project
jq -r --arg r "$REAL" '(.deleted_workspace_ids // []) as $d | .workspaces // {} | to_entries[] | select(.key | IN($d[]) | not) | select((.value.root // "") as $p | $p == $r or ($p | startswith($r + "/"))) | .key' "$KM/workspaces.json" | while read -r wd; do ls -d "$KM/sessions/$wd"/session_*; done
```

Per session directory `SDIR`, with `WIRE="$SDIR/agents/main/wire.jsonl"`:

```bash
# Title, times, last prompt
jq -r '[.createdAt, .updatedAt, .title, .workDir, .lastPrompt] | @tsv' "$SDIR/state.json"
# User prompts; turn.prompt is canonical, context.append_message can repeat it
jq -rR 'fromjson? | select(.type=="turn.prompt") | "### " + (.time|tostring) + "\n" + ([.input[]? | select(.type=="text") | .text] | join("\n"))' "$WIRE"
# Assistant text
jq -rR 'fromjson? | select(.type=="context.append_loop_event" and .event.type=="content.part" and .event.part.type=="text") | "### " + (.time|tostring) + "\n" + .event.part.text' "$WIRE"
# Assistant reasoning
jq -rR 'fromjson? | select(.type=="context.append_loop_event" and .event.type=="content.part" and .event.part.type=="think") | .event.part.think' "$WIRE"
# Tool calls
jq -rR 'fromjson? | select(.type=="context.append_loop_event" and .event.type=="tool.call") | "### " + (.time|tostring) + " | " + .event.name + " | " + ((.event.args|tostring)|gsub("\n";" "))[0:180]' "$WIRE"
# Tool results
jq -rR 'fromjson? | select(.type=="context.append_loop_event" and .event.type=="tool.result") | .event.result.output' "$WIRE"
# Last answer: assistant text after the last prompt
jq -nrR '[inputs | fromjson? | select(.type=="turn.prompt" or (.type=="context.append_loop_event" and .event.type=="content.part" and .event.part.type=="text"))] | ((map(.type=="turn.prompt") | rindex(true)) // -1) as $i | [.[$i+1:][] | .event.part.text] | join("\n")' "$WIRE"
```

- Subagents: `agents/<id>/wire.jsonl` beside `agents/main/`

## Gemini

- `projects.json`: `{"projects": {"<root>": "<short id>"}}`; a short id matches `[a-z0-9-]+`
- `tmp/<short id>/.project_root` names the root that owns the short id; read it when the registry lacks the root; the registry wins on a conflict
- Chat file: `tmp/<short id>/chats/session-<YYYY-MM-DDTHH-MM>-<first 8 characters of id>.jsonl`, the stamp in UTC (a panel branch stamps local time); a `--session-file` copy is `session-<epoch ms>-<first 8 characters of its new id>.jsonl`; older chats are one `.json` object with a `messages` array
- First record: metadata `sessionId`, `projectHash`, `startTime`, `lastUpdated`, `kind`; a copy adds `messageCount`, `userMessageCount`, `firstUserMessage`, `hasResumableContent`
- Message records: `id`, `timestamp`, `type`, `content`; a later record with the same `id` replaces the earlier copy in place; a `gemini` message that calls tools is written twice, the second copy with `toolCalls`
- `user`: `content` is a part list of `{text}` or `{functionResponse: {id, name, response}}`; the first `user` record is the CLI's `<session_context>` block, not a prompt
- `gemini`: adds `model`, `thoughts` (`subject`, `description`, `timestamp`), `tokens`, `toolCalls`; `content` is a string or a part list in which `{text, thought: true}` is reasoning and `{functionCall}` a call
- `toolCalls[]`: `id`, `name`, `args`, `status` (`success` or `error`), `timestamp`, `result` (a part list of `{functionResponse: {id, name, response: {output} or {error}}}`), `resultDisplay` (a string, an object or a list), `description`, `displayName`, `renderOutputAsMarkdown`
- Any other `type` is a notice; a copy opens with an `info` record `import-<epoch ms>` naming the source chat
- `{"$set": {...}}` merges metadata: `lastUpdated` after each message record a turn adds and after each `$patch`; the `<id>_response` records a `--session-file` import adds get none; `summary` once, together with `memoryScratchpad`, after the turns; `messages` replaces the whole list
- `{"$patch": {...}}`: `updates` replace `content`, or a tool call's `result`, by id; `removeIds` drops records (a copy drops its `info` record); `orderIds` moves the listed ids to the end in that order
- `summary` is the CLI's display name; a conversation has none before that `$set`
- A same-id rewrite, the `summary` `$set` and a panel switch move the file mtime, not `lastUpdated`
- Subagents: `kind` `subagent`, or a per-parent subdirectory of `chats/`
- `tmp/<short id>/logs.json` - array of typed prompts (`sessionId`, `messageId` counting from 0 per session, `type` `user`, `message`, `timestamp`); it keeps the prompts of sessions whose chat file is gone, without replies
- Format confirmed against chat files written by `@google/gemini-cli` 0.64.0

```bash
GM="$HOME/.gemini"
# Short ids of this project: registry, then markers
{ jq -r --arg r "$REAL" '.projects // {} | to_entries[] | select(.key == $r or (.key | startswith($r + "/"))) | .value' "$GM/projects.json" 2>/dev/null
  for d in "$GM"/tmp/*/; do under "$(cat "$d.project_root" 2>/dev/null)" && basename "$d"; done; } | sort -u
# Chat files of one short id, newest first
find "$GM/tmp/<short id>/chats" -maxdepth 1 -type f \( -name 'session-*.jsonl' -o -name 'session-*.json' \) -printf '%T@ %p\n' | sort -rn
```

Per chat file `F`. `gem` drops a torn final line from a `.jsonl`; every command then slurps, so one filter reads both shapes:

```bash
gem() { case "$1" in *.jsonl) jq -cR 'fromjson?' "$1" ;; *) cat -- "$1" ;; esac; }
# msgs: the message list after same-id replacement, $set and $patch; txt: plain text, reasoning parts skipped
G='def msgs: reduce .[] as $r ([]; if ($r["$patch"]|type)=="object" then $r["$patch"] as $p | reduce ([$p | select((.id|type)=="string")] + ($p.updates // []))[] as $u (.; (map(.id) | index($u.id)) as $i | if $i == null then . else (if $u.content != null then .[$i].content = $u.content else . end) | (if ($u.toolCalls|type)=="array" and (.[$i].toolCalls|type)=="array" then .[$i].toolCalls |= map(.id as $t | ([$u.toolCalls[] | select(.id == $t and has("result"))] | last) as $c | if $c then .result = $c.result else . end) else . end) end) | ($p.removeIds // []) as $x | map(select(.id as $d | $x | index($d) | not)) | if ($p.orderIds|type)=="array" then $p.orderIds as $o | [.[] | select(.id as $d | $o | index($d) | not)] + [$o[] as $d | .[] | select(.id == $d)] else . end elif ($r["$set"]|type)=="object" then (if ($r["$set"].messages|type)=="array" then $r["$set"].messages else . end) elif ($r.id|type)=="string" then ((map(.id) | index($r.id)) as $i | if $i != null then .[$i] = $r else . + [$r] end) elif ($r.messages|type)=="array" then $r.messages else . end) | .[]; def txt: .content | if type=="string" then . elif type=="array" then ([.[] | if type=="string" then . elif .thought == true then empty else (.text? // empty) end] | join("")) else (.text? // "") end;'
# Id, start, last metadata update, kind
gem "$F" | jq -rs '[.[] | (.["$set"] // .)] | [(map(.sessionId // empty) | last), (map(.startTime // empty) | first), (map(.lastUpdated // empty) | last), (map(.kind // empty) | last // "main")] | @tsv'
# Title: the latest summary
gem "$F" | jq -rs '[.[] | (.["$set"] // .) | .summary // empty] | last // ""'
# Models
gem "$F" | jq -rs "$G"' msgs | select(.type=="gemini") | .model // empty' | sort | uniq -c
# Last message timestamp
gem "$F" | jq -rs "$G"' [msgs | .timestamp // empty] | last // ""'
# User prompts (tool responses and the <session_context> block skipped)
gem "$F" | jq -rs "$G"' msgs | select(.type=="user") | txt as $x | select($x != "" and ($x | test("^\\s*<session_context>") | not)) | "### " + (.timestamp // "") + "\n" + $x'
# Assistant text
gem "$F" | jq -rs "$G"' msgs | select(.type=="gemini") | txt as $x | select($x != "") | "### " + (.timestamp // "") + "\n" + $x'
# Tool calls
gem "$F" | jq -rs "$G"' msgs | .toolCalls[]? | "### " + (.timestamp // "") + " | " + .name + " | " + (.status // "") + " | " + ((.args|tostring)|gsub("\n";" "))[0:180]'
# Tool results: the output the model received, else the display text
gem "$F" | jq -rs "$G"' msgs | .toolCalls[]? | .id as $c | "### " + .name + " | " + (.status // "") + "\n" + (([.result[]?.functionResponse | select(.id == $c or .id == null) | .response | (.output // .error // empty) | if type=="string" then . else tostring end] | join("\n")) as $o | if $o != "" then $o else ((.resultDisplay // "") | if type=="string" then . else tostring end) end)[0:400]'
# Notices: record types other than user and gemini
gem "$F" | jq -rs "$G"' msgs | select(.type != "user" and .type != "gemini") | "### " + (.timestamp // "") + " | " + .type + "\n" + txt'
# Import source: the chat a --session-file launch copied; empty for an original
gem "$F" | jq -rs '[.[] | select(.type=="info" and ((.id // "") | startswith("import-"))) | .content] | first // ""'
# Last answer
gem "$F" | jq -rs "$G"' [msgs | select(.type=="gemini") | txt | select(. != "")] | last // ""'
```

## DeepSeek and dsh

- One project: `$DSH_HOME/sessions/--<key>--/`, default `~/.dsh/sessions`
- The key is the project path with separators collapsed to `-`, safe characters kept and every other character escaped as `~XXXX`; a key matches `--[A-Za-z0-9._~-]+--`
- Conversations without a working directory sit in `_no-cwd`
- The key is lossy; match the project by the header `cwd`
- One conversation: `--<key>--/session-<uuid>/session.v<N>.jsonl.zstd`; read the highest `N`; the first generation has no `.v<N>`; an uncompressed root holds `session.v<N>.jsonl`
- `.zstd` log: concatenated Zstandard frames, the header line alone in the first frame
- Header line: `type` `session`, `version`, `id`, `createdAt` (epoch ms), `cwd`, `origin`; `origin` `subagent` marks a subagent conversation stored beside its parent
- Event lines: `type`, `seq`, `time` (epoch ms), `data`; types include `user/message`, `assistant/message`, `tool/call` and `session/title`
- Title: the newest `session/title` event, `data.title`; the harness re-titles as the conversation grows
- The extension reads only event types, never message text; inspect `data` before extracting text from it

Per log `F`:

```bash
# Header
rd "$F" | head -n 1 | jq -c .
# Title
rd "$F" | jq -rR 'fromjson? | select(.type=="session/title") | .data.title' | tail -n 1
# First and last event time, epoch ms
rd "$F" | jq -rR 'fromjson? | .time // empty' | sed -n '1p;$p'
# Event types
rd "$F" | jq -rR 'fromjson? | .type' | sort | uniq -c
# User messages
rd "$F" | jq -cR 'fromjson? | select(.type=="user/message") | [.seq, .time, .data]' | cut -c1-400
# Assistant messages
rd "$F" | jq -cR 'fromjson? | select(.type=="assistant/message") | [.seq, .time, .data]' | cut -c1-400
# Tool events
rd "$F" | jq -cR 'fromjson? | select(.type | startswith("tool/")) | [.seq, .time, .type, .data]' | cut -c1-200
# Last answer
rd "$F" | jq -cR 'fromjson? | select(.type=="assistant/message") | .data' | tail -n 1
```

Metadata the TUI keeps outside the log; the extension reads none of it:

```bash
# Session lists: updatedAt (epoch ms), id, cwd, title, model, size
jq -r --arg r "$REAL" '.rows[] | select(.cwd==$r or (.cwd|startswith($r+"/"))) | [.updatedAt, .id, .cwd, .title.text, (.model // ""), (.bytes // 0)] | @tsv' ~/.dsh-tui/session-lists/*.json | sort -rn
# Projection: created, cwd, title, first prompt, last narrated activity
jq -r '[.record.identity.createdAt, .record.identity.cwd, (.record.rows.title.val // ""), (.record.rows.titleInput.val.first.text // ""), (.record.rows.workingActivity.val.tracker.narratedText // "")] | @tsv' ~/.dsh/storages/session_projcache/sessions/<id>.json
```

- The log can be empty when the TUI closed before flushing while the projection still names the session; report the title, the last prompt and `narratedText`, and state that the message text is missing
- `~/.dsh-tui/history.jsonl` - typed prompts as `{"text", "ts", "project"}`; the last prompt, no replies

## Inventory across all five

Each block appends `<epoch s> <agent> <id> <path>` rows for this project to one file; run all five after [Setup](#setup).

```bash
: > "$OUT/inventory.tsv"
CL="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
for f in "$CL"/projects/*/*.jsonl; do
  grep -qE '"type": ?"(user|assistant)"' "$f" || continue
  { head -n 50 "$f"; tail -c 131072 "$f"; } | jq -rR --arg r "$REAL" 'fromjson? | .cwd? | strings | select(. == $r or startswith($r + "/"))' | grep -q . || continue
  t=$(tail -c 131072 "$f" | jq -rR 'fromjson? | .timestamp? // empty' | tail -n 1)
  a=claude; jq -rR 'fromjson? | select(.type=="assistant") | .message.model? // empty' "$f" | grep -q '^deepseek' && a=claude-deepseek
  printf '%s\t%s\t%s\t%s\n' "$( { [ -n "$t" ] && date -d "$t" +%s; } || stat -c %Y "$f")" "$a" "$(basename "$f" .jsonl)" "$f"
done >> "$OUT/inventory.tsv"

CX="${CODEX_HOME:-$HOME/.codex}"
find "$CX/sessions" "$CX/archived_sessions" -type f \( -name 'rollout-*.jsonl' -o -name 'rollout-*.jsonl.zst' \) 2>/dev/null | while read -r f; do
  id=$(rd "$f" | head -n 10 | jq -rR --arg r "$REAL" 'fromjson? | (., .payload?) | objects | select((.id|type)=="string" and (.cwd|type)=="string") | select(.cwd == $r or (.cwd | startswith($r + "/"))) | .id' | head -n 1)
  [ -n "$id" ] && printf '%s\tcodex\t%s\t%s\n' "$(stat -c %Y "$f")" "$id" "$f"
done >> "$OUT/inventory.tsv"

KM="${KIMI_CODE_HOME:-$HOME/.kimi-code}"
jq -r --arg r "$REAL" '(.deleted_workspace_ids // []) as $d | .workspaces // {} | to_entries[] | select(.key | IN($d[]) | not) | select((.value.root // "") as $p | $p == $r or ($p | startswith($r + "/"))) | .key' "$KM/workspaces.json" 2>/dev/null | while read -r wd; do
  for s in "$KM/sessions/$wd"/session_*; do
    [ -f "$s/state.json" ] || continue
    m=$(stat -c %Y "$s/state.json"); u=$(date -d "$(jq -r '.updatedAt // "@0"' "$s/state.json")" +%s 2>/dev/null || echo 0)
    printf '%s\tkimi\t%s\t%s\n' "$(( u > m ? u : m ))" "$(basename "$s")" "$s"
  done
done >> "$OUT/inventory.tsv"

GM="$HOME/.gemini"
{ jq -r --arg r "$REAL" '.projects // {} | to_entries[] | select(.key == $r or (.key | startswith($r + "/"))) | .value' "$GM/projects.json" 2>/dev/null
  for d in "$GM"/tmp/*/; do under "$(cat "$d.project_root" 2>/dev/null)" && basename "$d"; done; } | sort -u | while read -r sid; do
  for f in "$GM/tmp/$sid/chats"/session-*.json "$GM/tmp/$sid/chats"/session-*.jsonl; do
    [ -f "$f" ] || continue
    { case "$f" in *.jsonl) jq -cR 'fromjson?' "$f" ;; *) cat -- "$f" ;; esac; } | jq -rs '[.[] | (.["$set"] // .)] | [(map(.sessionId // empty) | last // ""), (map(.kind // empty) | last // "main")] | @tsv' | {
      IFS=$'\t' read -r id kind; [ -n "$id" ] && [ "$kind" != subagent ] && printf '%s\tgemini\t%s\t%s\n' "$(stat -c %Y "$f")" "$id" "$f"; }
  done
done >> "$OUT/inventory.tsv"

DS="${DSH_HOME:-$HOME/.dsh}"
for d in "$DS"/sessions/--*--/session-*/; do
  f=$(ls "$d" | grep -E '^session(\.v[0-9]+)?\.jsonl(\.zstd)?$' | sort -V | tail -n 1)
  [ -n "$f" ] || continue
  rd "$d$f" | head -n 1 | jq -e --arg r "$REAL" 'select(.type == "session" and .origin != "subagent") | .cwd | strings | select(. == $r or startswith($r + "/"))' >/dev/null || continue
  printf '%s\tdeepseek\t%s\t%s\n' "$(stat -c %Y "$d$f")" "$(basename "$d")" "$d$f"
done >> "$OUT/inventory.tsv"

# Newest first
sort -rn "$OUT/inventory.tsv" | while IFS=$'\t' read -r t a id p; do printf '%s\t%s\t%s\t%s\n' "$(date -d "@$t" '+%F %T')" "$a" "$id" "$p"; done
```

- Report `none` for an assistant with no row; check its store exists first; never substitute another project's session
- Exclude the current session while this agent is still writing it
- For each row record assistant, id, title, model, path, first and last timestamp, line count and size (`wc -l -c`, after `rd` for a compressed file)
- Rows carry no title; add it with the per-assistant commands; for Codex join the index query by id
- Codex rows use the rollout mtime; the index `recency_at_ms` is the panel's order

## Take over another assistant's work

1. Live state first; it is ground truth, and a transcript explains how it was reached without overriding it

   ```bash
   git -C "$REAL" status --short
   git -C "$REAL" log --oneline -10
   ```

   - Read any handoff document the last agent left

2. Inventory every store, newest first ([Inventory across all five](#inventory-across-all-five))

3. Read oldest to newest so decisions accumulate in the order they were made; read the newest session end to end, not sampled. In full means:

   - every human prompt, including local-command output and task notifications that changed the work
   - every assistant text message, including compaction summaries
   - every tool call: name plus a one-line input summary
   - every tool output that carries a decision, a test result, an error, a diff or the final state
   - the final turn, including any usage-limit notice and the last action the agent was taking
   - skip directory listings, file reads and routine command output once known to be mechanical

4. Verify the stop point against the live state; a transcript claim is not proof

   - `git status --short` and `git log` again; compare with what the last agent said it left
   - background work the transcript names: `pgrep -af '<pid or command>'`, its output file, its log
   - assistant processes: list candidates with `pgrep -af 'claude|codex|kimi|gemini|dsh'`, then confirm each by the rules below
   - Claude processes: a `~/.claude/sessions/<pid>.json` whose `pid` is alive names the `sessionId` it runs; `claude agents --json` lists live background workers
   - Codex writes no per-process record; a live `codex` process whose `/proc/<pid>/cwd` is the project is the only signal
   - Kimi: process name `kimi` or `kimi-code`; argv `-S <id>` or `--session <id>` names the conversation
   - Gemini: a node process with an argv element whose last path segment is `gemini` or `gemini.js`; argv `--resume <id>` or `--session-id <id>` names the conversation; each launch shows two, the CLI relaunched under `--max-old-space-size`; a `--session-file <path>` process runs a copy under an id the CLI minted, which no argument carries, and writes its turns to that copy, not to `<path>`
   - DeepSeek: a node process with an argv element `dsh` or ending `/dsh/lib/bin.js`; argv `--resume <id>`
   - Claude task records: `~/.claude/tasks/<session-id>/*.json`
   - the newest files under the project's `logs/`, and the trackers the project keeps
   - report anything that died, anything that finished after the transcript's last line, anything changed since

5. Report, in this order, then stop; do not resume the pending work in the same turn; ask how to proceed

   | Field           | Content                                                        |
   | --------------- | -------------------------------------------------------------- |
   | Last agent      | assistant, session id, model, start and end time               |
   | Why it ended    | usage limit, crash, handoff, or still open                     |
   | Last request    | the last human prompt, quoted                                  |
   | Completed       | what the agent finished, with evidence paths                   |
   | Stop point      | the exact action or decision it was on                         |
   | Live state      | uncommitted files, running or dead background work, open tasks |
   | Pending         | remaining work and the single next action                      |
   | Decision needed | anything that needs the user's word                            |

Large sessions:

- Extract three streams to `$OUT/<agent>-<id>/`: `user.txt`, `assistant.txt`, `tools.txt`; `wc -l -c` each before reading
- Read in chronological pages; past the context, keep a note per chunk with decisions, paths, numbers and the exact stop point
- Never skip the opening compaction summary or the final 10 percent

Common shapes:

- The first user message is a compaction summary: read it first, then the messages after it
- Two sessions with the same title and summary are branches: prefer the later last activity with more lines; do not double count
- A panel branch copies the parent's history under a fresh id: Kimi copies the session directory, Gemini the chat file, DeepSeek the log; Claude and Codex fork through their own CLI
- A Kimi, Gemini or DeepSeek branch made without a name is titled `Fork of <title>`
- A Gemini chat holding an `info` record `import-<epoch ms>` is a `--session-file` copy of the chat that record names
- Ended on a usage limit: the work state is the turn before the limit notice plus any background task notification
- Subagent transcripts: list them; read only those the main transcript cites as carrying a result

## Reading rules

- Read only during a takeover: no edits, builds, tests or commits
- Never write into any assistant's store, the reading assistant's own included
- Never modify a transcript, index, task record or tracker
- Never attribute a motive to the last agent; report what it did and what the record shows
- Never print raw JSONL or raw tool results into context; pull the line that carries the decision, the error or the number
- Decompress to stdout (`rd`), never in place: Codex `rollout-*.jsonl.zst`, DeepSeek `session.v<N>.jsonl.zstd`
- A torn final frame of a DeepSeek log (crash mid-append) yields the whole blocks before it; the harness rewrites the tail on its next write
- A final line without a newline is a record torn mid-write; skip it (`jq -R 'fromjson?'`)
- Split records on `\n` only: Claude Code writes U+2028 unescaped inside strings, Gemini also U+2029 and U+0085; Python `str.splitlines()` breaks a record there
- Codex index: `mode=ro` reads through the write-ahead log but creates `-shm` and `-wal` beside the database when the directory is writable; `mode=ro&immutable=1` creates nothing and misses rows still only in the log
