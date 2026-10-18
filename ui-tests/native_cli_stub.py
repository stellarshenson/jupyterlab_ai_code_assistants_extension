"""Local CLI boundary fixture; real routes and stores stay in the test path."""
import ctypes
import json
import os
import select
import signal
import sqlite3
import sys
import time
import uuid
from pathlib import Path


assistant = Path(sys.argv[0]).name
args = sys.argv[1:]
ctypes.CDLL(None).prctl(15, assistant.encode(), 0, 0, 0)
scratch = Path(os.environ["JLAB_TEST_SCRATCH"])
with (scratch / "native-cli.jsonl").open("a") as log:
    log.write(json.dumps({"assistant": assistant, "args": args}) + "\n")

if args and args[0] == "agents":
    print(os.environ["JLAB_TEST_AGENT_ROSTER"])
    sys.exit(0)
if args and args[0] == "stop":
    sys.exit(0 if os.isatty(0) and os.isatty(1) and args[1] == "bg-wide" else 3)

if assistant == "claude" and "-p" in args:
    parent = args[args.index("--resume") + 1]
    projects = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects"
    source = next(projects.glob(f"*/{parent}.jsonl"))
    target = source
    if "--fork-session" in args:
        child = args[args.index("--session-id") + 1]
        target = source.with_name(child + ".jsonl")
        target.write_bytes(source.read_bytes())
    command = args[-1]
    if command.startswith("/rename "):
        record = {"type": "custom-title", "customTitle": command[8:]}
    elif command.startswith("/color "):
        record = {"type": "agent-color", "agentColor": command[7:]}
    else:
        raise ValueError(command)
    with target.open("a") as stream:
        stream.write(json.dumps(record) + "\n")
    sys.exit(0)

if assistant == "codex" and args[:1] == ["app-server"]:
    root = Path(os.environ["CODEX_HOME"])
    root.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(root / "state_5.sqlite")
    connection.execute("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, cwd TEXT, name TEXT, updated_at_ms INTEGER, has_user_event INTEGER)")
    for line in sys.stdin:
        request = json.loads(line)
        if "id" not in request:
            continue
        method = request["method"]
        params = request.get("params", {})
        with (scratch / "native-cli.jsonl").open("a") as log:
            log.write(json.dumps({"assistant": assistant, "method": method, "params": params}) + "\n")
        if method == "initialize":
            result = {}
        elif method in ("thread/start", "thread/fork"):
            child = str(uuid.uuid4())
            cwd = params.get("cwd")
            if method == "thread/fork":
                cwd = connection.execute("SELECT cwd FROM threads WHERE id = ?", (params["threadId"],)).fetchone()[0]
            connection.execute("INSERT INTO threads VALUES (?, ?, ?, ?, 1)", (child, cwd, None, int(time.time() * 1000)))
            connection.commit()
            result = {"thread": {"id": child}}
        elif method == "thread/name/set":
            connection.execute("UPDATE threads SET name = ? WHERE id = ?", (params["name"], params["threadId"]))
            connection.commit()
            result = {}
        else:
            raise ValueError(method)
        print(json.dumps({"id": request["id"], "result": result}), flush=True)
    sys.exit(0)

def _flag_value(argv, flag):
    """The value a `--flag value` or `--flag=value` argument carries."""
    for index, item in enumerate(argv):
        if item == flag and index + 1 < len(argv):
            return argv[index + 1]
        if item.startswith(flag + "="):
            return item[len(flag) + 1 :]
    return None


print(f"stub {assistant} running", flush=True)
if assistant != "claude":
    while True:
        signal.pause()

# An interactive Claude session names its conversation in its own pid file, and
# moves that name to a NEW id when `/clear` runs, while the same process keeps
# going. The probe reads the pid file, so the stub writes it the way the CLI
# does - the startup id, then the replacement - and gives the replacement a
# transcript in the parent's project directory so the panel can list it.
config = Path(os.environ["CLAUDE_CONFIG_DIR"])
sessions = config / "sessions"
sessions.mkdir(parents=True, exist_ok=True)
current = _flag_value(args, "--session-id") or _flag_value(args, "--resume")
if current:
    (sessions / f"{os.getpid()}.json").write_text(
        json.dumps({"sessionId": current}), encoding="utf-8"
    )
while True:
    select.select([sys.stdin], [], [])
    line = sys.stdin.readline()
    if not line:
        break
    if line.strip() != "/clear" or not current:
        continue
    parent = current
    # The process runs in its project folder, and Claude names that folder's
    # transcript directory by encoding `/`, `_` and `.` as `-`. Ask that
    # directory first: another project can hold a re-homed copy of the same
    # conversation id, and the global glob would otherwise pick either.
    encoded = "".join("-" if ch in "/_." else ch for ch in os.getcwd())
    source = config / "projects" / encoded / f"{parent}.jsonl"
    if not source.is_file():
        source = next((config / "projects").glob(f"*/{parent}.jsonl"), None)
    if source is None:
        continue
    replacement = str(uuid.uuid4())
    (sessions / f"{os.getpid()}.json").write_text(
        json.dumps({"sessionId": replacement}), encoding="utf-8"
    )
    (source.parent / f"{replacement}.jsonl").write_text(
        json.dumps({"type": "user", "sessionId": replacement, "cwd": os.getcwd()})
        + "\n",
        encoding="utf-8",
    )
    current = replacement
    print(f"cleared to {replacement}", flush=True)
