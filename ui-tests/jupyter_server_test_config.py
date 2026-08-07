"""Server configuration for integration tests.

!! Never use this configuration in production because it
opens the server to the world and provide access to JupyterLab
JavaScript objects through the global window variable.

Everything the suite touches is redirected into ``ui-tests/.scratch``: the
HOME the providers resolve their stores from, this extension's own state
directory, Jupyter's config/data/runtime directories, and a directory of stub
assistant binaries placed at the front of PATH. No test reads or writes a
developer's real assistant history, and no inherited JupyterHub credential
reaches the spawned server.

``.scratch`` is swept by ``webServer.command`` before this file runs and again
in ``global-teardown.js`` afterwards.
"""
import json
import os
import stat
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent.resolve()
SCRATCH = HERE / ".scratch"

# Providers whose binary is stubbed onto PATH, and so appear in the shell. The
# specs assert against the same split (`tests/shared.ts`), and cross-check it
# against the server's own status roster so config and specs cannot drift
# apart silently.
STUBBED = ("claude", "codex", "kimi")

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
os.environ["HOME"] = str(_home)
os.environ["JUPYTER_CONFIG_DIR"] = str(_home / ".jupyter")
os.environ["JUPYTER_DATA_DIR"] = str(SCRATCH / "jupyter-data")
os.environ["JUPYTER_RUNTIME_DIR"] = str(SCRATCH / "runtime")
# The per-provider store overrides. Set explicitly rather than left to HOME so
# an inherited value cannot point a provider back at the real history.
os.environ["CLAUDE_CONFIG_DIR"] = str(_home / ".claude")
os.environ["CODEX_HOME"] = str(_home / ".codex")
os.environ["KIMI_CODE_HOME"] = str(_home / ".kimi-code")
# Favourites and pins this extension writes itself.
os.environ["JUPYTERLAB_AI_CODE_ASSISTANTS_STATE_DIR"] = str(SCRATCH / "state")
# The directory Jupyter serves, so seeded projects sit inside the served root
# and the launch route accepts them.
os.environ["JUPYTERLAB_GALATA_ROOT_DIR"] = str(_root)

# Stub binaries, so the providers register without any real assistant CLI
# installed and a launch spawns a pty that stays open long enough to observe.
# ``agents`` is answered because the Claude provider probes it on every
# listing; left to the sleeping branch it would stall each poll for the
# subprocess timeout.
_STUB = """#!/bin/sh
case "$1" in
  agents) echo '[]'; exit 0 ;;
esac
echo "stub $0 running"
sleep 120
"""
for _name in STUBBED:
    _path = _stub_bin / _name
    _path.write_text(_STUB, encoding="utf-8")
    _path.chmod(_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
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
    _jsonl.write_text(json.dumps({"cwd": str(_project_cwd)}) + "\n", encoding="utf-8")
    # Ascending mtimes, all recent so the row lands in the (expanded) Recent
    # section; the newest is the project's current conversation.
    os.utime(_jsonl, (_now - 30 + _i, _now - 30 + _i))

from jupyterlab.galata import configure_jupyter_server  # noqa: E402

configure_jupyter_server(c)

# After `configure_jupyter_server`, which hard-codes 8888. Read with `or` and
# not a `get()` default, so an exported-but-empty variable still yields a port
# rather than raising on `int("")`.
c.ServerApp.port = int(os.environ.get("JLAB_TEST_PORT") or "8888")
c.ServerApp.port_retries = 0

# Uncomment to set server log level to debug level
# c.ServerApp.log_level = "DEBUG"
