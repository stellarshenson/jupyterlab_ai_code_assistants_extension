"""Local CLI boundary fixture; real routes and stores stay in the test path."""
import ctypes
import json
import os
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

print(f"stub {assistant} running", flush=True)
while True:
    signal.pause()
