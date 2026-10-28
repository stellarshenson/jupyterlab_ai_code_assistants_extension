"""The ``jupyterlab-ai-code-assistants`` command (ACC-CLI-223 to 228).

Discovery reads a scratch runtime directory only (``no_owner_server``), and
the ambient Jupyter variables are removed, so no test can find or address the
developer's own server. The subcommands run against the pytest-jupyter server
over scratch stores, through its real HTTP port, in a worker thread so the
server on the test's loop can answer them.
"""
from __future__ import annotations

import asyncio
import http.server
import json
import os
import re
import socket
import threading
from datetime import datetime, timezone

import pytest

from jupyterlab_ai_code_assistants_extension import cli
from jupyterlab_ai_code_assistants_extension.core import registry, routes

from .conftest import PROJECT_PATH, new_uuid, write_kimi_tree
from .test_routes import URL, present  # noqa: F401

HEADER = "ASSISTANT\tSESSION ID\tLAST ACTIVITY\tCURRENT\tPROJECT\tTITLE"


@pytest.fixture(autouse=True)
def no_owner_server(monkeypatch, tmp_path):
    """A scratch runtime directory and none of this host's Jupyter variables.

    The server fixtures move ``JUPYTER_RUNTIME_DIR`` to their own scratch
    directory afterwards, which holds only the test server's record.
    """
    for name in ("JUPYTERHUB_SERVICE_PREFIX", *cli.AMBIENT_TOKEN_ENVS, cli.TOKEN_ENV):
        monkeypatch.delenv(name, raising=False)
    runtime = tmp_path / "cli-runtime"
    runtime.mkdir()
    monkeypatch.setenv("JUPYTER_RUNTIME_DIR", str(runtime))
    return runtime


def write_record(runtime, name, port, token, base_url="/", hostname="localhost") -> dict:
    """A runtime record as ``ServerApp.write_server_info_file`` writes it, for
    a process that is alive (this one)."""
    info = {
        "hostname": hostname, "port": port, "secure": False, "base_url": base_url,
        "token": token, "pid": os.getpid(), "root_dir": "/srv",
    }
    (runtime / f"jpserver-{name}.json").write_text(json.dumps(info))
    return info


# ----------------------------------------------------------------- parsing


def test_the_grammar_reads_every_option():
    parse = cli._parser().parse_args
    args = parse(["--url", "http://h:1", "--json", "sessions", "move", "S",
                  "--to", "t", "-a", "kimi", "-p", "p"])
    assert (args.url, args.json, args.command, args.action, args.session,
            args.to, args.assistant, args.project) == (
        "http://h:1", True, "sessions", "move", "S", "t", "kimi", "p")
    assert parse(["sessions", "rename", "S", "N", "-a", "x"]).name == "N"
    assert parse(["sessions", "branch", "S", "-a", "x", "--name", "B"]).name == "B"
    assert parse(["sessions", "list"]).assistant is None
    # No subcommand runs status.
    assert parse([]).command is None


@pytest.mark.parametrize("argv", [
    ["sessions", "rename", "S", "N"],
    ["sessions", "delete", "S"],
    ["sessions", "branch", "S"],
    ["sessions", "switch", "S"],
    ["sessions", "move", "S", "--to", "/t"],
    ["sessions", "move", "S", "-a", "x"],
    ["sessions", "rename", "S", "-a", "x"],
    ["sessions"],
    ["status", "--json"],
    ["--url", "localhost:8888", "status"],
])
def test_a_command_it_cannot_use_exits_2(argv, capsys):
    """-a is required for every change, --to for a move, NAME for a rename;
    global options come before the subcommand; --url needs a scheme."""
    assert cli.main(argv) == cli.EXIT_USAGE
    assert capsys.readouterr().err


# --------------------------------------------------------------- discovery


def test_discovery_picks_the_only_listed_server(no_owner_server):
    record = write_record(no_owner_server, "a", 8001, "tok-a")
    assert cli._target(None) == ("http://127.0.0.1:8001", record)


def test_no_listed_server_exits_3_with_a_plain_line(capsys):
    assert cli.main(["status"]) == cli.EXIT_NO_SERVER
    assert capsys.readouterr().err == (
        "No running Jupyter server found. Start JupyterLab or pass --url.\n"
    )


def test_several_listed_servers_and_no_prefix_exit_2(no_owner_server, capsys):
    write_record(no_owner_server, "a", 8001, "tok-a")
    write_record(no_owner_server, "b", 8002, "tok-b", base_url="/user/b/")
    assert cli.main(["status"]) == cli.EXIT_USAGE
    err = capsys.readouterr().err
    assert err.count("\n") == 1
    assert "http://127.0.0.1:8001" in err and "http://127.0.0.1:8002/user/b" in err


def test_the_service_prefix_picks_its_own_server(no_owner_server, monkeypatch):
    write_record(no_owner_server, "a", 8001, "tok-a", base_url="/user/a/")
    record = write_record(no_owner_server, "b", 8002, "tok-b", base_url="/user/b/")
    monkeypatch.setenv("JUPYTERHUB_SERVICE_PREFIX", "/user/b")
    assert cli._target(None) == ("http://127.0.0.1:8002/user/b", record)


# ------------------------------------------------------- a stub HTTP server

ROSTER = {
    "root_dir": "/srv",
    "providers": [{"id": "alpha", "label": "Alpha", "enabled": True,
                   "cli_path": "/bin/alpha", "available": True}],
    "delete_to_trash": True,
}
ROW = {"project_path": "/srv/p", "encoded_path": "e", "session_id": "S",
       "name": "Plan", "file_mtime": 0}


class Stub:
    """A loopback HTTP server that records every request and answers from
    ``answers``, keyed by ``(method, path after the namespace)``."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.answers: dict[tuple[str, str], tuple[int, bytes]] = {
            ("GET", "status"): (200, json.dumps(ROSTER).encode()),
            ("GET", "providers/alpha/sessions"): (200, json.dumps({"sessions": [ROW]}).encode()),
        }
        stub = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def answer(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                stub.requests.append({
                    "method": self.command, "path": self.path,
                    "authorization": self.headers.get("Authorization"),
                    "body": self.rfile.read(length) if length else b"",
                })
                route = self.path.partition("?")[0].partition(f"/{URL}/")[2]
                status, payload = stub.answers.get(
                    (self.command, route), (404, b"<html>Not Found</html>"))
                self.send_response(status)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_POST = do_DELETE = answer

            def log_message(self, *_args) -> None:
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def answer(self, method: str, route: str, status: int, body) -> None:
        payload = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.answers[(method, route)] = (status, payload)


@pytest.fixture
def stub():
    server = Stub()
    yield server
    server.server.shutdown()
    server.server.server_close()


# ------------------------------------------------------------------ tokens


def test_a_listed_token_never_reaches_a_url_that_matches_no_record(
    no_owner_server, stub, capsys
):
    """The record names another port, so the --url matches nothing: no token
    goes, and the browser's own ?token= pasted with the URL is dropped."""
    write_record(no_owner_server, "a", stub.port + 1, "listed-secret")
    assert cli.main(["--url", f"{stub.url}/?token=pasted", "status"]) == 0
    assert stub.requests[0]["authorization"] is None
    assert stub.requests[0]["path"] == f"/{URL}/status"


def test_a_matched_record_lends_its_token_at_its_own_address(no_owner_server, stub):
    write_record(no_owner_server, "a", stub.port, "listed-secret")
    assert cli.main(["--url", f"http://localhost:{stub.port}/", "status"]) == 0
    assert stub.requests[0]["authorization"] == "token listed-secret"


def test_ambient_tokens_go_to_loopback_only(monkeypatch, stub):
    monkeypatch.setenv("JUPYTER_TOKEN", "ambient")
    assert cli._token("http://remote.example:8888", None) is None
    assert cli.main(["--url", stub.url, "status"]) == 0
    assert stub.requests[0]["authorization"] == "token ambient"


def test_the_command_s_own_variable_goes_to_any_target(monkeypatch):
    monkeypatch.setenv(cli.TOKEN_ENV, "mine")
    assert cli._token("http://remote.example:8888", None) == "mine"


# -------------------------------------------------------------- exit codes


MOVE = ["sessions", "move", "S", "--to", "/srv/q", "-a", "alpha"]


@pytest.mark.parametrize("status,body,code,line", [
    (404, {"error": "provider_unknown"}, 5, "The server has no assistant alpha."),
    (404, {"error": "provider_disabled"}, 5, "Alpha is turned off in the settings."),
    (503, {"error": "cli_not_found"}, 5, "Alpha is not installed on the server."),
    (404, {"error": "session_not_found"}, 5, "Alpha has no session S."),
    (409, {"error": "session_live"}, 4,
     "Alpha session S is open in a running terminal; close it first."),
    (400, {"error": "move_unsupported"}, 4, "Alpha does not offer move."),
    (400, {"error": "move_same_project"}, 4, "Alpha session S is already in that project."),
    (400, {"error": "invalid_target_path"}, 4, "--to is not a directory on the server."),
    (409, {"message": "the target project already holds this conversation"}, 4,
     "Alpha: the target project already holds this conversation"),
    (400, {"error": "move_failed"}, 1, "The server at {url} answered HTTP 400 move_failed."),
    (500, {"message": "Internal Server Error"}, 1, "The server at {url} answered HTTP 500."),
])
def test_each_answer_has_its_exit_code_and_one_line(stub, capsys, status, body, code, line):
    stub.answer("POST", "providers/alpha/move", status, body)
    assert cli.main(["--url", stub.url, *MOVE]) == code
    assert capsys.readouterr().err == line.format(url=stub.url) + "\n"


def test_a_403_exits_1(stub, capsys):
    stub.answer("GET", "status", 403, {"message": "Forbidden"})
    assert cli.main(["--url", stub.url, "status"]) == cli.EXIT_FAILED
    assert "HTTP 403" in capsys.readouterr().err


def test_a_namespace_that_does_not_answer_exits_1(stub, capsys):
    del stub.answers[("GET", "status")]
    assert cli.main(["--url", stub.url, "status"]) == cli.EXIT_FAILED
    assert capsys.readouterr().err == (
        f"The extension does not answer at {stub.url}; is it enabled on that server?\n"
    )


def test_an_answer_that_is_not_json_exits_1(stub, capsys):
    stub.answer("GET", "status", 200, b"<html>lab</html>")
    assert cli.main(["--url", stub.url, "status"]) == cli.EXIT_FAILED
    assert "is not JSON" in capsys.readouterr().err


def test_no_server_at_the_url_exits_3(capsys):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    assert cli.main(["--url", f"http://127.0.0.1:{port}", "status"]) == cli.EXIT_NO_SERVER
    assert capsys.readouterr().err == f"No Jupyter server answers at http://127.0.0.1:{port}.\n"


def test_a_switch_the_server_did_not_carry_out_exits_1(stub, capsys):
    stub.answer("POST", "providers/alpha/switch", 200, {"requested": "S", "current": "T"})
    assert cli.main(["--url", stub.url, "sessions", "switch", "S", "-a", "alpha"]) == 1
    assert capsys.readouterr().err == "Alpha session S could not be made current.\n"


def test_to_and_project_are_made_absolute_on_the_client(stub, monkeypatch, tmp_path, capsys):
    """The server realpaths --to against ITS working directory, not the
    caller's. The line names the id after the move, which a copying store
    changes."""
    monkeypatch.chdir(tmp_path)
    stub.answer("POST", "providers/alpha/move", 200,
                {"session_id": "S2", "encoded_path": "q", "project_path": "/srv/q"})
    row_here = {**ROW, "project_path": str(tmp_path / "p")}
    stub.answer("GET", "providers/alpha/sessions", 200, {"sessions": [row_here]})
    assert cli.main(["--url", stub.url, "sessions", "move", "S", "--to", "q",
                     "-a", "alpha", "-p", "p"]) == 0
    assert json.loads(stub.requests[-1]["body"])["target_path"] == str(tmp_path / "q")
    assert capsys.readouterr().out == "Alpha: moved S to /srv/q as S2\n"


def test_a_delete_the_server_did_not_carry_out_exits_1(stub, capsys):
    stub.answer("GET", "providers/alpha/branches", 200,
                {"current": "S", "total": 2, "branches": [{"session_id": "T", "label": "t"}]})
    stub.answer("DELETE", "providers/alpha/sessions", 200,
                {"removed_count": 0, "removed_ids": [], "live_ids": []})
    assert cli.main(["--url", stub.url, "sessions", "delete", "T", "-a", "alpha"]) == 1
    assert capsys.readouterr().err == "Alpha session T was not deleted.\n"


# ------------------------------------------- every subcommand, real server

WD = "wd_demo_000000000000"


@pytest.fixture
def kimi(scratch_stores, present):  # noqa: F811
    """Three Kimi conversations in one project; ``cur`` newest, so current."""
    ids = {role: f"session_{new_uuid()}" for role in ("cur", "other", "third")}
    wd = write_kimi_tree(scratch_stores / "kimi", WD, [
        {"id": ids[role], "title": f"Kimi {role}", "custom_title": True} for role in ids
    ])
    for age, role in enumerate(ids):
        stamp = 1_790_000_000 - age * 600
        os.utime(wd / ids[role] / "state.json", (stamp, stamp))
    return ids


async def run(*argv: str) -> int:
    """The command in a worker thread, so the server on this loop answers."""
    return await asyncio.to_thread(cli.main, list(argv))


async def branch_ids(jp_fetch) -> dict[str, str]:
    response = await jp_fetch(URL, "providers", "kimi", "branches",
                              params={"encoded_path": WD})
    listing = json.loads(response.body)
    return {b["session_id"]: b["label"] for b in listing["branches"]} | {
        listing["current"]: "*current*"
    }


async def test_status_finds_the_scratch_server_and_prints_the_roster(
    jp_fetch, jp_http_port, present, capsys  # noqa: F811
):
    assert await run() == 0
    out = capsys.readouterr().out.splitlines()
    assert out[0] == f"Server: http://127.0.0.1:{jp_http_port}/a%40b"
    assert out[1:] == [
        f"{pid}\t{p.descriptor.label}\tenabled\t/usr/bin/{pid}"
        for pid, p in registry.providers().items()
    ]
    assert await run("--json", "status") == 0
    answer = json.loads(capsys.readouterr().out)
    assert answer["url"] == f"http://127.0.0.1:{jp_http_port}/a%40b"
    assert [p["id"] for p in answer["providers"]] == list(registry.providers())


async def test_list_matches_the_sessions_route_row_for_row(jp_fetch, kimi, capsys):
    response = await jp_fetch(URL, "providers", "kimi", "sessions")
    rows = json.loads(response.body)["sessions"]
    assert await run("--json", "sessions", "list", "-a", "kimi") == 0
    listed = json.loads(capsys.readouterr().out)
    assert [
        (e["assistant"], e["session_id"], e["project"], e["encoded_path"], e["title"], e["current"])
        for e in listed
    ] == [("kimi", r["session_id"], r["project_path"], r["encoded_path"], r["name"], True)
          for r in rows]
    assert listed[0]["last_activity"] == datetime.fromtimestamp(
        rows[0]["file_mtime"] / 1000, timezone.utc
    ).strftime("%Y-%m-%dT%H:%M:%SZ")

    assert await run("sessions", "list") == 0
    lines = capsys.readouterr().out.splitlines()
    assert lines == [HEADER, "\t".join([
        "kimi", kimi["cur"],
        datetime.fromtimestamp(rows[0]["file_mtime"] / 1000).strftime("%Y-%m-%d %H:%M"),
        "*", PROJECT_PATH, "Kimi cur",
    ])]


async def test_list_of_one_project_shows_its_other_sessions(jp_fetch, kimi, capsys):
    assert await run("sessions", "list", "-a", "kimi", "-p", PROJECT_PATH) == 0
    lines = capsys.readouterr().out.splitlines()
    assert lines[0] == HEADER
    cells = [line.split("\t") for line in lines[1:]]
    assert [(c[1], c[3], c[4], c[5]) for c in cells] == [
        (kimi["cur"], "*", PROJECT_PATH, "Kimi cur"),
        (kimi["other"], "-", PROJECT_PATH, "Kimi other"),
        (kimi["third"], "-", PROJECT_PATH, "Kimi third"),
    ]
    assert all(re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d", c[2]) for c in cells)
    assert await run("sessions", "list", "-a", "kimi", "-p", "/nowhere/else") == 5
    assert capsys.readouterr().err == "No sessions in /nowhere/else.\n"


async def test_rename_goes_through_the_route_and_reaches_every_window(
    jp_fetch, jp_ws_fetch, kimi, capsys
):
    ws = await jp_ws_fetch(URL, "events")
    assert await run("sessions", "rename", kimi["other"], "Renamed here", "-a", "kimi") == 0
    assert capsys.readouterr().out == f'Kimi: renamed {kimi["other"]} to "Renamed here"\n'
    message = json.loads(await asyncio.wait_for(ws.read_message(), 5))
    assert message == {"type": "sessions-changed", "provider": "kimi"}
    assert (await branch_ids(jp_fetch))[kimi["other"]] == "Renamed here"
    ws.close()


async def test_delete_removes_a_session_that_is_not_current(jp_fetch, kimi, capsys):
    assert await run("--json", "sessions", "delete", kimi["third"], "-a", "kimi",
                     "-p", PROJECT_PATH) == 0
    answer = json.loads(capsys.readouterr().out)
    assert answer["assistant"] == "kimi" and answer["removed_ids"] == [kimi["third"]]
    assert kimi["third"] not in await branch_ids(jp_fetch)


async def test_delete_refuses_the_project_s_current_session(
    jp_fetch, kimi, capsys, monkeypatch
):
    asked: list = []
    monkeypatch.setattr(registry.get("kimi").store, "delete_branches",
                        lambda *a, **k: asked.append(a) or [])
    assert await run("sessions", "delete", kimi["cur"], "-a", "kimi") == 4
    assert capsys.readouterr().err == (
        f"Kimi session {kimi['cur']} is the current session of {PROJECT_PATH}; "
        f"make another session current first with `sessions switch`.\n"
    )
    assert asked == []


async def test_delete_of_a_session_a_terminal_runs_exits_4(
    jp_fetch, kimi, capsys, monkeypatch
):
    store = registry.get("kimi").store
    monkeypatch.setattr(routes, "_proc_pids", lambda: [4242])
    monkeypatch.setattr(routes, "_process_cwd_link", lambda pid: "/nowhere")
    monkeypatch.setattr(store, "owns_pid", lambda pid: pid == 4242)
    monkeypatch.setattr(store, "session_id_for_pid", lambda pid: kimi["other"])
    assert await run("sessions", "delete", kimi["other"], "-a", "kimi") == 4
    assert capsys.readouterr().err == (
        f"Kimi session {kimi['other']} is open in a running terminal; close it first.\n"
    )
    assert kimi["other"] in await branch_ids(jp_fetch)


async def test_a_session_nobody_holds_exits_5(jp_fetch, kimi, capsys):
    assert await run("sessions", "switch", "session_gone", "-a", "kimi") == 5
    assert capsys.readouterr().err == "Kimi has no session session_gone.\n"


async def test_branch_numbers_after_the_title_and_becomes_current(jp_fetch, kimi, capsys):
    assert await run("sessions", "branch", kimi["other"], "-a", "kimi") == 0
    out = capsys.readouterr().out
    match = re.fullmatch(rf"Kimi: branched {kimi['other']} into (session_\S+)\n", out)
    assert match
    ids = await branch_ids(jp_fetch)
    assert ids[match[1]] == "*current*"
    assert await run("--json", "sessions", "list", "-a", "kimi", "-p", PROJECT_PATH) == 0
    titles = {e["session_id"]: e["title"] for e in json.loads(capsys.readouterr().out)}
    assert titles[match[1]] == "Kimi other_1"


async def test_switch_makes_a_session_current(jp_fetch, kimi, capsys):
    assert await run("sessions", "switch", kimi["third"], "-a", "kimi") == 0
    assert capsys.readouterr().out == (
        f"Kimi: {kimi['third']} is now the current session of {PROJECT_PATH}\n"
    )
    assert (await branch_ids(jp_fetch))[kimi["third"]] == "*current*"


async def test_move_lists_the_session_under_the_target_only(jp_fetch, kimi, capsys, tmp_path):
    target = tmp_path / "Moved Here"
    target.mkdir()
    assert await run("--json", "sessions", "move", kimi["other"], "--to", str(target),
                     "-a", "kimi") == 0
    answer = json.loads(capsys.readouterr().out)
    assert answer["assistant"] == "kimi"
    assert answer["session_id"] == kimi["other"]
    assert answer["project_path"] == str(target)
    assert await run("--json", "sessions", "list", "-a", "kimi") == 0
    rows = {e["session_id"]: e["project"] for e in json.loads(capsys.readouterr().out)}
    assert rows[kimi["other"]] == str(target)
    assert kimi["other"] not in await branch_ids(jp_fetch)


async def test_refresh_pushes_to_every_open_window(jp_fetch, jp_ws_fetch, present, capsys):  # noqa: F811
    ws = await jp_ws_fetch(URL, "events")
    assert await run("refresh") == 0
    lines = capsys.readouterr().out.splitlines()
    assert lines[-1] == "pushed to 1 open windows"
    assert len(lines) == len(registry.providers()) + 1
    message = json.loads(await asyncio.wait_for(ws.read_message(), 5))
    assert message["type"] == "refresh"
    assert [p["id"] for p in message["status"]["providers"]] == list(registry.providers())
    ws.close()
