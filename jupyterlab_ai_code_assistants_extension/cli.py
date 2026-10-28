"""The ``jupyterlab-ai-code-assistants`` command, for people and agents.

Lists, renames, deletes, branches, makes current and moves the sessions of
every assistant, and refreshes the panels. Every change goes through the
running server's routes, never the stores, so the server pushes it to every
open window (ACC-CLI-227). No assistant is named here: ids and labels come
from ``GET status``, so a new provider needs no change to this module.

Server discovery and token handling copy the mechanism of ``jupyterlab-notify``
(jupyterlab_notifications_extension/cli.py): the runtime records
``jupyter server list`` reads, the server ``JUPYTERHUB_SERVICE_PREFIX`` names,
and a token lent only to the address of the record it came from.

Until ``make install`` puts the script on PATH:
``python -m jupyterlab_ai_code_assistants_extension.cli ...``
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.client import HTTPException
from urllib.parse import quote, urlencode, urlparse, urlunparse

from jupyter_server.serverapp import list_running_servers

from .core.routes import URL_PREFIX

#: This command's own token variable, used for any target.
TOKEN_ENV = "JUPYTERLAB_AI_CODE_ASSISTANTS_TOKEN"
#: This host's credentials, lent to a loopback target only.
AMBIENT_TOKEN_ENVS = ("JUPYTERHUB_API_TOKEN", "JPY_API_TOKEN", "JUPYTER_TOKEN")
#: Branch and move can run an assistant's own CLI for up to 30 s per call.
REQUEST_TIMEOUT_S = 120

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_NO_SERVER = 3
EXIT_REFUSED = 4
EXIT_NOT_FOUND = 5
EXIT_INTERRUPTED = 130

NO_SERVER = "No running Jupyter server found. Start JupyterLab or pass --url."


class CommandError(Exception):
    """One plain line for stderr, and the exit code it ends the command with."""

    def __init__(self, message: str, code: int = EXIT_FAILED) -> None:
        super().__init__(message)
        self.code = code


class ApiError(Exception):
    """A non-2xx answer: its status, ``error`` token and ``message``."""

    def __init__(self, status: int, error: str | None, message: str | None) -> None:
        super().__init__(f"HTTP {status} {error or ''}")
        self.status, self.error, self.message = status, error, message


# ------------------------------------------------------------- discovery
# Copied in mechanism from the house cli.py; its comments carry the reasons.


def _select_server(servers: list[dict]) -> dict | None:
    """The record ``JUPYTERHUB_SERVICE_PREFIX`` names, else the only one."""
    prefix = os.environ.get("JUPYTERHUB_SERVICE_PREFIX")
    if prefix:
        wanted = prefix.rstrip("/") + "/"
        for server in servers:
            if server.get("base_url", "/") == wanted:
                return server
    return servers[0] if len(servers) == 1 else None


# A record's bind address → the loopback literals that reach it, preferred
# first. Tornado binds AF_INET6 with IPV6_V6ONLY, so the families do not mix.
_LOOPBACK_HOST_FOR = {
    "0.0.0.0": ("127.0.0.1",),
    "localhost": ("127.0.0.1", "[::1]"),
    "127.0.0.1": ("127.0.0.1",),
    "::": ("[::1]",),
    "::1": ("[::1]",),
}

# The hosts a URL can name that are loopback destinations. Not the keys above:
# a wildcard is a bind address, never a place to send a token.
_LOOPBACK_URL_HOSTS = {
    "127.0.0.1": ("127.0.0.1",),
    "localhost": ("127.0.0.1", "[::1]"),
    "::1": ("[::1]",),
}


def _loopback_literals_for(server: dict) -> tuple[str, ...]:
    return _LOOPBACK_HOST_FOR.get(server.get("hostname", ""), ())


def _is_loopback_url(url: str) -> bool:
    try:
        return urlparse(url).hostname in _LOOPBACK_URL_HOSTS
    except ValueError:
        return False


def _match_listed_server(url: str, servers: list[dict]) -> dict | None:
    """The listed record an explicit --url points at: loopback literal, port,
    scheme and base path all agree. A URL matching none lends no token."""
    try:
        if not _is_loopback_url(url):
            return None
        parsed = urlparse(url)
        port = parsed.port
    except ValueError:
        return None
    if port is None:
        port = 443 if parsed.scheme == "https" else 80
    path = parsed.path.rstrip("/")
    reachable = set(_LOOPBACK_URL_HOSTS[parsed.hostname])
    for server in servers:
        if not reachable & set(_loopback_literals_for(server)):
            continue
        if server.get("port") != port:
            continue
        if bool(server.get("secure")) != (parsed.scheme == "https"):
            continue
        if server.get("base_url", "/").rstrip("/") == path:
            return server
    return None


def _without_credentials(url: str) -> str:
    """Query, fragment and userinfo removed: a pasted address bar carries the
    browser's own ?token=, and the URL is echoed in every error line."""
    url = url.strip().partition("#")[0].partition("?")[0]
    try:
        parsed = urlparse(url)
    except ValueError:
        head, sep, rest = url.partition("//")
        authority, slash, tail = rest.partition("/")
        return f"{head}{sep}{authority.rpartition('@')[2]}{slash}{tail}"
    return urlunparse(parsed._replace(netloc=parsed.netloc.rpartition("@")[2]))


def _server_url(server: dict) -> str:
    """The base URL of one record, at the address its bind is reached at."""
    scheme = "https" if server.get("secure") else "http"
    hostname = server.get("hostname", "")
    literals = _loopback_literals_for(server)
    host = literals[0] if literals else (f"[{hostname}]" if ":" in hostname else hostname)
    base_url = server.get("base_url", "/").rstrip("/")
    return f"{scheme}://{host}:{server['port']}{base_url}"


def _target(url: str | None) -> tuple[str, dict | None]:
    """The base URL to address and the runtime record it belongs to, if any."""
    try:
        servers = list(list_running_servers())
    except OSError:
        servers = []
    if url is not None:
        url = _without_credentials(url)
        try:
            parsed = urlparse(url)
            parsed.port
        except ValueError as err:
            raise CommandError(f"--url {url!r} is not usable: {err}", EXIT_USAGE) from err
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise CommandError(
                f"--url {url!r} needs an http:// or https:// address", EXIT_USAGE
            )
        # Addressed at the record's own literal: `localhost` may resolve to
        # the other family, where that record's token does not belong.
        record = _match_listed_server(url, servers)
        return (_server_url(record), record) if record else (url.rstrip("/"), None)
    record = _select_server(servers)
    if record is not None:
        return _server_url(record), record
    if not servers:
        raise CommandError(NO_SERVER, EXIT_NO_SERVER)
    listed = ", ".join(_server_url(s) for s in servers)
    raise CommandError(
        f"Several Jupyter servers are running ({listed}); pass --url to choose one.",
        EXIT_USAGE,
    )


def _token(url: str, record: dict | None) -> str | None:
    """This command's variable for any target; else the record's own token;
    else this host's variables, for a loopback target only."""
    token = os.environ.get(TOKEN_ENV) or (record or {}).get("token") or None
    if token is None and _is_loopback_url(url):
        token = next(
            (os.environ[name] for name in AMBIENT_TOKEN_ENVS if os.environ.get(name)),
            None,
        )
    # http.client refuses CR and LF in a header but sends NUL.
    if token and any(c in token for c in "\r\n\0"):
        raise CommandError("The token holds a line break or a NUL character.")
    return token


# ---------------------------------------------------------------- client


class Client:
    """JSON over the extension's routes, the token in the Authorization header."""

    def __init__(self, base: str, token: str | None) -> None:
        self.base, self.token = base, token

    def call(self, method: str, path: str, body=None, query: dict | None = None):
        url = f"{self.base}/{URL_PREFIX}/{path}"
        if query:
            url += "?" + urlencode(query)
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"token {self.token}"
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as response:
                raw = response.read()
        except urllib.error.HTTPError as err:
            try:
                answer = json.loads(err.read())
            except (ValueError, OSError, HTTPException):
                answer = None
            answer = answer if isinstance(answer, dict) else {}
            error, message = answer.get("error"), answer.get("message")
            raise ApiError(
                err.code,
                error if isinstance(error, str) else None,
                message if isinstance(message, str) else None,
            ) from err
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            raise CommandError(
                f"No Jupyter server answers at {self.base}.", EXIT_NO_SERVER
            ) from err
        except (HTTPException, OSError) as err:
            raise CommandError(f"The connection to {self.base} failed: {err!r}") from err
        try:
            return json.loads(raw)
        except ValueError as err:
            raise CommandError(
                f"The answer from {self.base} is not JSON; "
                f"is this extension enabled on that server?"
            ) from err


def _provider_path(assistant: str, verb: str) -> str:
    return f"providers/{quote(assistant, safe='')}/{verb}"


# Error tokens the routes answer, each with its line and exit code.
_KNOWN_ERRORS = {
    "provider_unknown": ("The server has no assistant {assistant}.", EXIT_NOT_FOUND),
    "provider_disabled": ("{label} is turned off in the settings.", EXIT_NOT_FOUND),
    "cli_not_found": ("{label} is not installed on the server.", EXIT_NOT_FOUND),
    "session_not_found": ("{label} has no session {session}.", EXIT_NOT_FOUND),
    "branch_not_found": ("{label} has no session {session}.", EXIT_NOT_FOUND),
    "session_live": (
        "{label} session {session} is open in a running terminal; close it first.",
        EXIT_REFUSED,
    ),
    "move_same_project": (
        "{label} session {session} is already in that project.", EXIT_REFUSED,
    ),
    "invalid_target_path": ("--to is not a directory on the server.", EXIT_REFUSED),
    "name_invalid": (
        "{label} refused the name: it is empty or longer than 200 characters.",
        EXIT_REFUSED,
    ),
    "invalid_name": ("{label} refused the name: it is empty.", EXIT_REFUSED),
}


def _explain(err: ApiError, args: argparse.Namespace, base: str) -> CommandError:
    """The line and exit code for a refused request."""
    context = {
        "assistant": getattr(args, "assistant", None) or "",
        "label": getattr(args, "label", None) or getattr(args, "assistant", None) or "",
        "session": getattr(args, "session", None) or "",
    }
    if err.error in _KNOWN_ERRORS:
        line, code = _KNOWN_ERRORS[err.error]
        return CommandError(line.format(**context), code)
    if err.error and err.error.endswith("_unsupported"):
        operation = getattr(args, "action", None) or "this"
        return CommandError(f"{context['label']} does not offer {operation}.", EXIT_REFUSED)
    if err.status == 409 and err.message:
        return CommandError(f"{context['label']}: {err.message}", EXIT_REFUSED)
    if err.status == 404:
        return CommandError(
            f"The extension does not answer at {base}; is it enabled on that server?"
        )
    if err.status == 403:
        return CommandError(
            f"The server at {base} refused the request (HTTP 403): no valid token "
            f"reached it; set {TOKEN_ENV} or pass the URL of a listed server."
        )
    return CommandError(f"The server at {base} answered HTTP {err.status} {err.error or ''}".rstrip() + ".")


# --------------------------------------------------------------- output


def _print_json(value) -> None:
    print(json.dumps(value, indent=2))


def _provider_line(row: dict) -> str:
    state = "enabled" if row.get("enabled") else "disabled"
    return f"{row['id']}\t{row['label']}\t{state}\t{row.get('cli_path') or 'not installed'}"


def _local_time(ms) -> str:
    if not isinstance(ms, (int, float)):
        return "-"
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M")


def _utc_time(ms) -> str | None:
    if not isinstance(ms, (int, float)):
        return None
    stamp = datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="seconds")
    return stamp.replace("+00:00", "Z")


# ------------------------------------------------------------- sessions


def _same_project(path: str, project: str) -> bool:
    return os.path.realpath(path) == os.path.realpath(project)


def _rows(client: Client, assistant: str) -> list[dict]:
    return client.call("GET", _provider_path(assistant, "sessions"))["sessions"]


def _branches(client: Client, assistant: str, row: dict) -> list[dict]:
    """A project's other sessions; none when its current one does not resolve."""
    try:
        listing = client.call(
            "GET", _provider_path(assistant, "branches"),
            query={"encoded_path": row["encoded_path"]},
        )
    except ApiError as err:
        if err.error == "invalid_encoded_path":
            return []
        raise
    return listing.get("branches") or []


def _entry(assistant: str, row: dict, session_id: str, title, mtime, current: bool) -> dict:
    return {
        "assistant": assistant,
        "session_id": session_id,
        "title": title if isinstance(title, str) else "",
        "project": row["project_path"],
        "encoded_path": row["encoded_path"],
        "last_activity": mtime,
        "current": current,
    }


def _locate(client: Client, args: argparse.Namespace) -> tuple[dict, dict]:
    """The project row holding SESSION, and SESSION's own entry."""
    rows = _rows(client, args.assistant)
    if args.project:
        rows = [r for r in rows if _same_project(r["project_path"], args.project)]
        if not rows:
            raise CommandError(
                f"{args.label} has no sessions in {args.project}.", EXIT_NOT_FOUND
            )
    for row in rows:
        if row["session_id"] == args.session:
            return row, _entry(args.assistant, row, row["session_id"], row.get("name"),
                               row.get("file_mtime"), True)
    for row in rows:
        for branch in _branches(client, args.assistant, row):
            if branch.get("session_id") == args.session:
                return row, _entry(args.assistant, row, args.session, branch.get("label"),
                                   branch.get("file_mtime"), False)
    where = f" in {args.project}" if args.project else ""
    raise CommandError(f"{args.label} has no session {args.session}{where}.", EXIT_NOT_FOUND)


def _label(roster: dict, assistant: str) -> str:
    return next(
        (p["label"] for p in roster["providers"] if p["id"] == assistant), assistant
    )


def cmd_status(client: Client, args: argparse.Namespace) -> int:
    roster = client.call("GET", "status")
    if args.json:
        _print_json({"url": client.base, **roster})
        return EXIT_OK
    print(f"Server: {client.base}")
    for row in roster["providers"]:
        print(_provider_line(row))
    return EXIT_OK


def cmd_refresh(client: Client, args: argparse.Namespace) -> int:
    answer = client.call("POST", "refresh", {})
    if args.json:
        _print_json(answer)
        return EXIT_OK
    for row in answer["providers"]:
        print(_provider_line(row))
    print(f"pushed to {answer['windows']} open windows")
    return EXIT_OK


def cmd_list(client: Client, args: argparse.Namespace) -> int:
    roster = client.call("GET", "status")
    if args.assistant:
        assistants = [args.assistant]
    else:
        assistants = [p["id"] for p in roster["providers"] if p["enabled"] and p["available"]]
    entries: list[dict] = []
    matched = False
    for assistant in assistants:
        args.label = _label(roster, assistant)
        rows = _rows(client, assistant)
        if args.project:
            rows = [r for r in rows if _same_project(r["project_path"], args.project)]
        for row in rows:
            matched = True
            entries.append(_entry(assistant, row, row["session_id"], row.get("name"),
                                  row.get("file_mtime"), True))
            if args.project:
                entries.extend(
                    _entry(assistant, row, b["session_id"], b.get("label"),
                           b.get("file_mtime"), False)
                    for b in _branches(client, assistant, row)
                )
    if args.project and not matched:
        raise CommandError(f"No sessions in {args.project}.", EXIT_NOT_FOUND)
    if args.json:
        _print_json([{**e, "last_activity": _utc_time(e["last_activity"])} for e in entries])
        return EXIT_OK
    print("ASSISTANT\tSESSION ID\tLAST ACTIVITY\tCURRENT\tPROJECT\tTITLE")
    for e in entries:
        # Free text last, and kept on one line.
        title = e["title"].translate({9: " ", 10: " ", 13: " "})
        print(f"{e['assistant']}\t{e['session_id']}\t{_local_time(e['last_activity'])}\t"
              f"{'*' if e['current'] else '-'}\t{e['project']}\t{title}")
    return EXIT_OK


def cmd_change(client: Client, args: argparse.Namespace) -> int:
    """rename, delete, branch, switch and move: locate SESSION, then one route."""
    args.label = _label(client.call("GET", "status"), args.assistant)
    row, entry = _locate(client, args)
    sid, label = args.session, args.label
    target = {"encoded_path": row["encoded_path"], "session_id": sid}
    if args.action == "rename":
        answer = client.call("POST", _provider_path(args.assistant, "rename"),
                             {**target, "name": args.name})
        line = f'{label}: renamed {sid} to "{answer["name"]}"'
    elif args.action == "delete":
        if entry["current"]:
            raise CommandError(
                f"{label} session {sid} is the current session of {row['project_path']}; "
                f"make another session current first with `sessions switch`.",
                EXIT_REFUSED,
            )
        answer = client.call("DELETE", _provider_path(args.assistant, "sessions"),
                             {"encoded_path": row["encoded_path"], "session_ids": [sid]})
        if sid in (answer.get("live_ids") or []):
            raise _explain(ApiError(409, "session_live", None), args, client.base)
        if sid not in (answer.get("removed_ids") or []):
            raise CommandError(f"{label} session {sid} was not deleted.")
        line = f"{label}: deleted {sid}"
    elif args.action == "branch":
        body = dict(target)
        if args.name is not None:
            body["name"] = args.name
        elif entry["title"].strip():
            # As the panel sends it: the server numbers the branch after it.
            body["base_name"] = entry["title"]
        answer = client.call("POST", _provider_path(args.assistant, "branch"), body)
        line = f"{label}: branched {sid} into {answer['session_id']}"
    elif args.action == "switch":
        answer = client.call("POST", _provider_path(args.assistant, "switch"), target)
        if answer.get("current") != sid:
            raise CommandError(f"{label} session {sid} could not be made current.")
        line = f"{label}: {sid} is now the current session of {row['project_path']}"
    else:
        answer = client.call("POST", _provider_path(args.assistant, "move"),
                             {**target, "target_path": args.to})
        line = f"{label}: moved {sid} to {answer['project_path']} as {answer['session_id']}"
    if args.json:
        _print_json({**answer, "assistant": args.assistant})
    else:
        print(line)
    return EXIT_OK


# ---------------------------------------------------------------- parser

EPILOG = f"""\
SESSION is the full session id as `sessions list` prints it. -a takes the id
`status` prints. -p narrows to one project folder; without it SESSION is
looked up in every project of the assistant.

authentication:
  {TOKEN_ENV} is used for any --url, so the
  secret never reaches argv.
  Otherwise the token of the matched server record is used, at that record's
  own address; a --url matching no record gets none. JUPYTERHUB_API_TOKEN,
  JPY_API_TOKEN and JUPYTER_TOKEN are used only for a loopback --url
  (127.0.0.1, localhost, ::1). The token travels in the Authorization header.
  JUPYTERHUB_SERVICE_PREFIX picks this process's own server among several.

exit codes:
  0    success
  1    failed: the server could not do it, HTTP 403 or 5xx, the extension is
       not enabled at that URL, or the answer is not JSON
  2    usage error, or several servers are running and none was chosen
  3    no Jupyter server answers
  4    refused: the assistant does not offer the operation, the session is
       open in a running terminal, delete of a project's current session, the
       session is already in the --to project or --to is not a directory, or
       the name was refused
  5    not found: the assistant, its CLI, the session or the project
  130  interrupted
"""


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="jupyterlab-ai-code-assistants",
        description="List and change the sessions of the AI code assistants of a "
                    "running JupyterLab; every open window shows the change at once.",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--url", help="JupyterLab base URL, without /lab "
                                      "(default: the running server)")
    parser.add_argument("--json", action="store_true", help="print JSON")
    commands = parser.add_subparsers(dest="command", metavar="COMMAND")
    commands.add_parser("status", help="the server and every assistant (the default)")
    commands.add_parser("refresh", help="re-check the installed assistants and "
                                        "refresh every open window")
    sessions = commands.add_parser("sessions", help="list or change sessions")
    actions = sessions.add_subparsers(dest="action", metavar="ACTION", required=True)

    listing = actions.add_parser(
        "list", help="one line per project (its current session); with -p, that "
                     "project's current session and its other sessions")
    listing.add_argument("-a", "--assistant", help="one assistant (default: every "
                                                   "enabled and installed one)")
    listing.add_argument("-p", "--project", help="a project folder")

    def changing(name: str, text: str) -> argparse.ArgumentParser:
        action = actions.add_parser(name, help=text)
        action.add_argument("session", metavar="SESSION")
        action.add_argument("-a", "--assistant", required=True)
        action.add_argument("-p", "--project", help="the project folder holding SESSION")
        return action

    changing("rename", "name a session").add_argument("name", metavar="NAME")
    changing("delete", "delete a session that is not its project's current one")
    changing("branch", "branch a session; the branch becomes current").add_argument(
        "--name", help="the branch's name (default: numbered after SESSION's title)")
    changing("switch", "make SESSION its project's current session")
    changing("move", "move a session into another project folder").add_argument(
        "--to", required=True, metavar="PATH", help="the target project folder")
    return parser


def _run(argv: list[str] | None) -> int:
    parser = _parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exit_:
        return exit_.code if isinstance(exit_.code, int) else EXIT_USAGE
    for name in ("project", "to"):
        if getattr(args, name, None):
            setattr(args, name, os.path.abspath(os.path.expanduser(getattr(args, name))))
    base = args.url or ""
    try:
        base, record = _target(args.url)
        client = Client(base, _token(base, record))
        if args.command == "sessions":
            run = cmd_list if args.action == "list" else cmd_change
        else:
            run = cmd_refresh if args.command == "refresh" else cmd_status
        return run(client, args)
    except ApiError as err:
        error = _explain(err, args, base)
    except CommandError as err:
        error = err
    print(error, file=sys.stderr)
    return error.code


def main(argv: list[str] | None = None) -> int:
    try:
        return _run(argv)
    except KeyboardInterrupt:
        print("Interrupted", file=sys.stderr)
        return EXIT_INTERRUPTED


if __name__ == "__main__":
    sys.exit(main())
