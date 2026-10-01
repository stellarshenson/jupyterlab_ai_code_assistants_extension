"""The callback route, over a live jupyter_server and a real loopback listener.

A CLI login listens on the server's own loopback for its OAuth redirect; the
route makes the request the user's browser could not. What is asserted is what
the listener received, because that is the whole effect of the route.
"""
from __future__ import annotations

import json
import logging
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
import tornado


URL = "jupyterlab-ai-code-assistants-extension"

#: Stands in for the one-time login code a real link carries.
SECRET = "code=one-time-login-code"


@pytest.fixture
def listener():
    """A login listener on the loopback: records each GET and answers 302."""
    seen: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - the name http.server dispatches on
            seen.append(self.path)
            self.send_response(302)
            self.send_header("Location", "/success")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server.server_address[1], seen
    server.shutdown()
    server.server_close()


def deliver(jp_fetch, url):
    return jp_fetch(URL, "callback", method="POST", body=json.dumps({"url": url}))


async def test_a_loopback_link_is_requested_once_and_its_redirect_is_not_followed(
    jp_fetch, listener
):
    port, seen = listener
    response = await deliver(
        jp_fetch, f"http://127.0.0.1:{port}/auth/callback?{SECRET}&state=s"
    )
    assert json.loads(response.body) == {"status": 302}
    # The path and the query as pasted, and no second request to /success.
    assert seen == [f"/auth/callback?{SECRET}&state=s"]


@pytest.mark.parametrize(
    "url",
    [
        "http://listener.invalid/auth/callback?code=x",
        "https://127.0.0.1:1455/auth/callback?code=x",
        "http://127.0.0.1:1455@listener.invalid/auth/callback?code=x",
        "http://localhost.listener.invalid:1455/auth/callback?code=x",
        "ftp://127.0.0.1/auth/callback",
        "not a link",
        "",
        None,
        5,
    ],
)
async def test_a_link_that_is_not_loopback_http_is_refused(jp_fetch, url):
    with pytest.raises(tornado.httpclient.HTTPClientError) as refused:
        await deliver(jp_fetch, url)
    assert refused.value.code == 400
    assert json.loads(refused.value.response.body) == {
        "error": "callback_not_loopback"
    }


async def test_a_link_nothing_listens_on_is_reported_unreachable(jp_fetch):
    # A port the kernel just handed out and that is closed again.
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    with pytest.raises(tornado.httpclient.HTTPClientError) as refused:
        await deliver(jp_fetch, f"http://127.0.0.1:{port}/auth/callback?{SECRET}")
    assert refused.value.code == 502
    # The answer names the failure and never the link.
    assert json.loads(refused.value.response.body) == {
        "error": "callback_unreachable"
    }


async def test_the_link_is_never_logged(jp_fetch, jp_serverapp, listener):
    port, _seen = listener
    lines: list[str] = []

    class Capture(logging.Handler):
        def emit(self, record):
            lines.append(record.getMessage())

    capture = Capture(level=logging.DEBUG)
    loggers = [
        jp_serverapp.log,
        *(logging.getLogger(f"tornado.{name}") for name in ("access", "application", "general")),
    ]
    levels = [logger.level for logger in loggers]
    for logger in loggers:
        logger.addHandler(capture)
        logger.setLevel(logging.DEBUG)
    try:
        await deliver(jp_fetch, f"http://127.0.0.1:{port}/auth/callback?{SECRET}")
    finally:
        for logger, level in zip(loggers, levels):
            logger.removeHandler(capture)
            logger.setLevel(level)

    # The request itself is logged, which proves the capture is live.
    assert any("/callback" in line for line in lines)
    assert not any(SECRET in line for line in lines)
