"""Server configuration for integration tests.

!! Never use this configuration in production because it
opens the server to the world and provide access to JupyterLab
JavaScript objects through the global window variable.

Everything the suite touches is redirected into ``ui-tests/.scratch/<port>``:
the HOME the providers resolve their stores from, this extension's own state
directory, Jupyter's config/data/runtime directories, and a directory of stub
assistant binaries placed at the front of PATH. No test reads or writes a
developer's real assistant history, and no inherited JupyterHub credential
reaches the spawned server.

The scratch tree is keyed by the run's port so two suites cannot alias
(DEF-49). It is swept by ``webServer.command`` before this file runs and again
in ``global-teardown.js`` afterwards.

The ``HOME`` set below is a BACKSTOP, not the isolation itself. Jupyter has
already resolved its config search path - and loaded any
``~/.jupyter/jupyter_lab_config.py`` it found there - by the time this file
executes, so the environment the process STARTS with is what decides whether
the developer's live config reaches the run. ``playwright.config.js`` sets it
in ``webServer.env``, and the ``start`` script in ``package.json`` sets the
same value for a hand-launched server.
"""
import json
import os
import stat
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent.resolve()
# Read with ``or`` and not a ``get()`` default, so an exported-but-empty
# variable still yields a port rather than an empty path segment.
PORT = os.environ.get("JLAB_TEST_PORT") or "8888"
SCRATCH = Path(os.environ.get("JLAB_TEST_SCRATCH") or (HERE / ".scratch" / PORT))

# Binaries stubbed onto PATH, so their providers appear in the shell: the
# claude, codex, kimi and deepseek (``dsh``) assistants; gemini has none. The
# specs assert against the same split (`tests/shared.ts`), and cross-check it
# against the server's own status roster so config and specs cannot drift
# apart silently.
STUBBED = ("claude", "codex", "kimi", "dsh")

# The ONE background agent the stubbed roster answers with, and the
# conversation it owns (DEF-88). Without it the roster was empty, so the "bg"
# chip - the second badge the name line has to keep unclipped - was never
# rendered in a browser at all.
#
# It owns the WIDE project's newest conversation, seeded below under this id,
# and deliberately not one of "branchy"'s: opening a conversation a live worker
# holds stops that worker first, and every spec that clicks, launches or
# right-clicks works on "branchy", which stays unowned.
_BG_SESSION_ID = "wide-1"
_BG_AGENT_ID = "bg-wide"

# A JupyterHub-spawned shell exports credentials for the developer's live
# server. Inherited into the test server they would let it - and any test -
# talk to that server; dropped here they cannot.
for _var in (
    "JUPYTERHUB_API_TOKEN",
    "JUPYTERHUB_API_URL",
    "JUPYTERHUB_CLIENT_ID",
    "JUPYTERHUB_OAUTH_ACCESS_SCOPES",
    "JUPYTERHUB_OAUTH_CALLBACK_URL",
    "JUPYTERHUB_SERVICE_PREFIX",
    "JUPYTERHUB_SERVER_NAME",
    "JUPYTERHUB_USER",
    "JPY_API_TOKEN",
    "JUPYTER_TOKEN",
):
    os.environ.pop(_var, None)

_home = SCRATCH / "home"
_root = SCRATCH / "root"
_stub_bin = SCRATCH / "bin"
for _dir in (_home, _root, _stub_bin):
    _dir.mkdir(parents=True, exist_ok=True)

# HOME first: every other default below is derived from it, and the Gemini
# provider resolves its store from ``Path.home()`` with no override of its own.
# Jupyter's own search paths are NOT covered from here - see the module
# docstring; this keeps the providers honest when the launcher forgot to.
os.environ["HOME"] = str(_home)
os.environ["JUPYTER_CONFIG_DIR"] = str(_home / ".jupyter")
os.environ["JUPYTER_DATA_DIR"] = str(SCRATCH / "jupyter-data")
os.environ["JUPYTER_RUNTIME_DIR"] = str(SCRATCH / "runtime")
# The per-provider store overrides. Set explicitly rather than left to HOME so
# an inherited value cannot point a provider back at the real history.
os.environ["CLAUDE_CONFIG_DIR"] = str(_home / ".claude")
os.environ["CODEX_HOME"] = str(_home / ".codex")
os.environ["KIMI_CODE_HOME"] = str(_home / ".kimi-code")
os.environ["DSH_HOME"] = str(_home / ".dsh")
# Favourites and pins this extension writes itself.
os.environ["JUPYTERLAB_AI_CODE_ASSISTANTS_STATE_DIR"] = str(SCRATCH / "state")
# The directory Jupyter serves, so seeded projects sit inside the served root
# and the launch route accepts them.
os.environ["JUPYTERLAB_GALATA_ROOT_DIR"] = str(_root)

# Stub binaries, so the providers register without any real assistant CLI
# installed and a launch spawns a pty that stays open until the server stops.
# A stub that ended on its own after 120 s closed an earlier test's terminal
# between a later test's two terminal counts (DEF-GUARD-281).
# ``agents`` is answered because the Claude provider probes it on every
# listing; left to the sleeping branch it would stall each poll for the
# subprocess timeout. ``stop`` succeeds only on a terminal and only for the
# roster's agent, as Claude's own does: without a TTY the CLI never sees the
# subcommand (DEF-PROV-272).
#
# The roster carries one live background agent. ``pid`` is this server's own
# process: the provider trusts an entry only while it can verify the worker
# alive, so a made-up pid would be filtered out and the answer would be empty
# again.
_STUB = """#!/bin/sh
case "$1" in
  agents) echo '%s'; exit 0 ;;
  stop) [ -t 0 ] && [ -t 1 ] && [ "$2" = %s ] && exit 0; exit 3 ;;
esac
echo "stub $0 running"
sleep infinity
""" % (
    json.dumps(
        [
            {
                "id": _BG_AGENT_ID,
                "kind": "background",
                "pid": os.getpid(),
                "sessionId": _BG_SESSION_ID,
            }
        ]
    ),
    _BG_AGENT_ID,
)
for _name in STUBBED:
    _path = _stub_bin / _name
    if _name in ("claude", "codex"):
        _path.write_text(
            f"#!{sys.executable}\n" + (HERE / "native_cli_stub.py").read_text(),
            encoding="utf-8",
        )
    else:
        _path.write_text(_STUB, encoding="utf-8")
    _path.chmod(_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
os.environ["JLAB_TEST_AGENT_ROSTER"] = json.dumps([
    {"id": _BG_AGENT_ID, "kind": "background", "pid": os.getpid(), "sessionId": _BG_SESSION_ID}
])
# PATH is REPLACED, not prefixed. A developer with a real assistant CLI on
# their PATH would otherwise make the "absent binary" provider available, and
# the suite would silently stop testing the case it exists for. What remains is
# the stubs, the venv the server runs from, and the system directories.
os.environ["PATH"] = os.pathsep.join(
    [str(_stub_bin), str(Path(sys.executable).parent), "/usr/local/bin", "/usr/bin", "/bin"]
)

# Seed one Claude project ("branchy") holding three parallel conversations, so
# the row, the branch submenus and the manage-sessions popup all have
# something real to act on. The cwd is a real directory under the served root
# so the launch route accepts it, and the project directory name is the
# provider's own encoding of that path so resolution matches.
from jupyterlab_ai_code_assistants_extension.providers.claude import (  # noqa: E402
    _encode_path,
)

_project_cwd = _root / "branchy"
_project_cwd.mkdir(parents=True, exist_ok=True)
_pdir = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / _encode_path(str(_project_cwd))
_pdir.mkdir(parents=True, exist_ok=True)
_now = time.time()
for _i in range(3):
    _jsonl = _pdir / f"branch-{_i}.jsonl"
    _records = [{"cwd": str(_project_cwd)}]
    if _i == 2:
        # The newest conversation carries an assistant-chosen colour (`/color`),
        # so a test comparing a hand-set colour against "what the assistant
        # chose" measures against a real tint rather than against nothing.
        _records.append({"type": "agent-color", "agentColor": "blue"})
    _jsonl.write_text(
        "".join(json.dumps(r) + "\n" for r in _records), encoding="utf-8"
    )
    # Ascending mtimes; the newest is the project's current conversation, and
    # all three are recent so this project sorts to the top of the list.
    os.utime(_jsonl, (_now - 30 + _i, _now - 30 + _i))

# A remote-control record for the branchy project, so one row draws the live
# status dot. The panel draws it only for a session Claude reports as
# remote-controlled, which the provider reads as a live pid plus a non-null
# bridge id on a record inside its one-hour freshness window - a launched stub
# can never satisfy it, because the stub is a shell script and its pid file is
# Claude's to write, not ours. The server's own pid is the one pid guaranteed
# alive for the length of the run.
_sessions_dir = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "sessions"
_sessions_dir.mkdir(parents=True, exist_ok=True)
(_sessions_dir / "remote-controlled.json").write_text(
    json.dumps(
        {
            "cwd": str(_project_cwd),
            "pid": os.getpid(),
            "updatedAt": int(_now * 1000),
            "bridgeSessionId": "galata-bridge",
        }
    ),
    encoding="utf-8",
)

# A second Claude project whose NAME is far wider than the sidebar, holding two
# conversations so it carries a branch badge. DEF-41 was a clipping defect -
# the name's ellipsis ate the badges that followed it - and clipping is a
# layout fact that only a real browser can answer, so the suite needs a row
# whose name genuinely overflows rather than one that merely looks long.
#
# Its mtimes are DELIBERATELY much older than branchy's. Rows sort newest
# first, and two existing specs resolve their subject as "the first listed
# conversation" rather than by name; a newer second project would silently
# move them onto this row.
_wide_cwd = _root / "a-deliberately-very-long-project-name-that-overflows-the-sidebar"
_wide_cwd.mkdir(parents=True, exist_ok=True)
_wdir = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / _encode_path(str(_wide_cwd))
_wdir.mkdir(parents=True, exist_ok=True)
# Newest last, so the bg-owned conversation is the project's current one and
# the chip lands on the row rather than only in the branch submenus.
for _i, _wide_id in enumerate(("wide-0", _BG_SESSION_ID)):
    _jsonl = _wdir / f"{_wide_id}.jsonl"
    _jsonl.write_text(json.dumps({"cwd": str(_wide_cwd)}) + "\n", encoding="utf-8")
    os.utime(_jsonl, (_now - 600 + _i, _now - 600 + _i))

# A third Claude project, owned by the rename spec alone. Renaming mutates the
# store for the rest of the run - the suite runs one worker against one server
# - so the spec that does it gets a project no other spec looks at, rather than
# leaving `branchy` under a name its own locators no longer match.
#
# Oldest mtimes of the three, for the reason the wide project has them: two
# specs resolve their subject as "the first listed conversation".
_rename_cwd = _root / "renamable"
_rename_cwd.mkdir(parents=True, exist_ok=True)
_rdir = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / _encode_path(str(_rename_cwd))
_rdir.mkdir(parents=True, exist_ok=True)
_jsonl = _rdir / "rename-0.jsonl"
_jsonl.write_text(json.dumps({"cwd": str(_rename_cwd)}) + "\n", encoding="utf-8")
os.utime(_jsonl, (_now - 900, _now - 900))

# Native branch tests own their projects and cannot rename another spec's row.
for _project, _title in (("native-branch", "Native branch"), ("manual-branch", "Manual branch")):
    _cwd = _root / _project
    _cwd.mkdir()
    _directory = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / _encode_path(str(_cwd))
    _directory.mkdir(parents=True)
    for _index, _suffix in enumerate(("_1", "_3", "")):
        _file = _directory / f"{_project}-{_index}.jsonl"
        _file.write_text("".join(json.dumps(record) + "\n" for record in (
            {"cwd": str(_cwd)},
            {"type": "custom-title", "customTitle": _title + _suffix},
            {"type": "agent-color", "agentColor": "blue"},
        )))
        os.utime(_file, (_now - 1200 + _index, _now - 1200 + _index))

# A Claude project owned by `click-spinner.spec.ts` alone: one conversation,
# second newest so it stays alongside `branchy` at the top of the list, and
# touched by no other spec, so that spec can hold the branch and probe routes
# open without disturbing another spec's row history.
_spinner_cwd = _root / "spinner-fixture"
_spinner_cwd.mkdir()
_spinner_dir = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / _encode_path(str(_spinner_cwd))
_spinner_dir.mkdir(parents=True)
_spinner_file = _spinner_dir / "spinner-fixture.jsonl"
_spinner_file.write_text("".join(json.dumps(record) + "\n" for record in (
    {"cwd": str(_spinner_cwd)},
    {"type": "custom-title", "customTitle": "Spinner fixture"},
    {"type": "agent-color", "agentColor": "blue"},
)))
os.utime(_spinner_file, (_now - 300, _now - 300))

# A Claude project owned by `colour-newest-wins.spec.ts` alone: it stores a pick
# against this conversation and appends a `/color` run to this transcript, then
# puts the transcript back. Seeded with Claude's own colour already set and no
# `/color` run in its tail, so a pick made on it stands until the spec runs
# `/color` after it. Old mtime, for the reason the wide and rename projects have
# them: two specs resolve their subject as "the first listed conversation".
_newest_cwd = _root / "colour-newest"
_newest_cwd.mkdir()
_newest_dir = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / _encode_path(str(_newest_cwd))
_newest_dir.mkdir(parents=True)
_jsonl = _newest_dir / "colour-newest-0.jsonl"
_jsonl.write_text("".join(json.dumps(record) + "\n" for record in (
    {"cwd": str(_newest_cwd)},
    {"type": "agent-color", "agentColor": "orange"},
)), encoding="utf-8")
os.utime(_jsonl, (_now - 1800, _now - 1800))

_codex_root = Path(os.environ["CODEX_HOME"])
_codex_root.mkdir(parents=True)
_codex_cwd = _root / "codex-branch"
_codex_cwd.mkdir()
# A second Codex project, owned by `codex-rename.spec.ts` alone: a rename
# mutates the store for the rest of the run - the suite runs one worker against
# one server - so the spec that does it gets a thread no other spec looks at,
# rather than leaving `codex-branch` under a name `codex-reuse.spec.ts` no
# longer matches (the same shape as the Claude side's `renamable` above). Older
# `updated_at_ms` than the reuse thread, for the reason the wide and rename
# Claude projects have old mtimes: newest-first row order is not part of any
# Codex locator today, and keeping this one older leaves `Codex branch` the
# newest Codex row.
_codex_rename_cwd = _root / "codex-renamable"
_codex_rename_cwd.mkdir()
with sqlite3.connect(_codex_root / "state_5.sqlite") as _connection:
    _connection.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, name TEXT, updated_at_ms INTEGER, has_user_event INTEGER)")
    _connection.execute("INSERT INTO threads VALUES (?, ?, ?, ?, 1)", (
        "11111111-1111-4111-8111-111111111111", str(_codex_cwd), "Codex branch", int((_now - 1200) * 1000),
    ))
    _connection.execute("INSERT INTO threads VALUES (?, ?, ?, ?, 1)", (
        "22222222-2222-4222-8222-222222222222", str(_codex_rename_cwd), "Codex renamable", int((_now - 1500) * 1000),
    ))

# One DeepSeek project with a titled conversation, so its panel has a row to
# open. The harness keys the project directory by the cwd with its separators
# collapsed to "-" (an ASCII path under the scratch root never reaches the
# escape branch of that rule), and the log is the raw-text form of its
# session file - the same lines a ``compression: 'none'`` root holds.
_dsh_cwd = _root / "harness"
_dsh_cwd.mkdir(parents=True, exist_ok=True)
_dsh_key = "--" + str(_dsh_cwd).strip("/").replace("/", "-") + "--"
_dsh_session = Path(os.environ["DSH_HOME"]) / "sessions" / _dsh_key / "session-1a2b3c4d-0000-4000-8000-000000000001"
_dsh_session.mkdir(parents=True, exist_ok=True)
(_dsh_session / "session.v3.jsonl").write_text(
    "".join(
        json.dumps(r, separators=(",", ":")) + "\n"
        for r in (
            {
                "type": "session",
                "version": 3,
                "id": "session-1a2b3c4d-0000-4000-8000-000000000001",
                "createdAt": int(_now * 1000),
                "cwd": str(_dsh_cwd),
                "isSeeded": False,
                "delegationDepth": 0,
            },
            {"type": "user/message", "seq": 0, "time": int(_now * 1000), "data": {}},
            {
                "type": "session/title",
                "seq": 1,
                "time": int(_now * 1000),
                "data": {"title": "Harness demo", "messageSeqs": [0], "source": {"kind": "llm"}},
            },
        )
    ),
    encoding="utf-8",
)
# The TUI bundle, mounted as a directory, exactly as `dsh plugin --profile tui
# add @deepseek-harness-tui/dsh-tui` leaves it: the DeepSeek launch preflights
# ``$DSH_HOME/profiles/tui`` before a terminal opens and refuses launches
# without it, so every DeepSeek spec that clicks a row runs against the mounted
# shape. `deepseek.spec.ts`'s missing-profile test unmounts this directory for
# its own run and makes it again in a `finally`, restoring the fixture for any
# spec that runs after it.
(Path(os.environ["DSH_HOME"]) / "profiles" / "tui").mkdir(parents=True, exist_ok=True)

from jupyterlab.galata import configure_jupyter_server  # noqa: E402

configure_jupyter_server(c)

# After `configure_jupyter_server`, which hard-codes 8888.
c.ServerApp.port = int(PORT)
c.ServerApp.port_retries = 0

# Uncomment to set server log level to debug level
# c.ServerApp.log_level = "DEBUG"
