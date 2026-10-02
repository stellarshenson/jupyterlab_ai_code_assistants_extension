"""The callback route, over a live jupyter_server and a real loopback listener.

A CLI login listens on the server's own loopback for its OAuth redirect; the
route makes the requests the user's browser could not. What is asserted is what
the listener received, because that is the whole effect of the route.
"""
from __future__ import annotations

import json
import logging
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

import pytest
import tornado

from jupyterlab_ai_code_assistants_extension.core import routes


URL = "jupyterlab-ai-code-assistants-extension"

#: Stands in for the one-time login code a real link carries.
SECRET = "code=one-time-login-code"

#: Stands in for the token a login puts in the address it redirects to.
TOKEN = "id_token=one-time-id-token"


@pytest.fixture
def listener():
    """A login listener on the loopback, shaped like the Codex one.

    Records each GET. A path in ``redirects`` is answered 302 to the address
    stored for it, any other path 200: the callback redirects to the closing
    page, and the closing page ends the login.
    """
    seen: list[str] = []
    redirects = {"/auth/callback": f"/success?{TOKEN}"}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - the name http.server dispatches on
            seen.append(self.path)
            location = redirects.get(self.path.partition("?")[0])
            self.send_response(302 if location else 200)
            if location:
                self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server.server_address[1], seen, redirects
    server.shutdown()
    server.server_close()


@pytest.fixture
def requested(monkeypatch):
    """Every address this process asks its HTTP client for.

    An address that is not loopback ``http`` is recorded and then refused, so
    a route that wrongly follows one is caught and no test reaches another
    host.
    """
    urls: list[str] = []
    original = tornado.httpclient.AsyncHTTPClient.fetch

    def fetch(self, request, *args, **kwargs):
        url = request if isinstance(request, str) else request.url
        urls.append(url)
        parts = urlsplit(url)
        if parts.scheme != "http" or parts.hostname not in ("127.0.0.1", "localhost"):
            raise OSError("not loopback http")
        return original(self, request, *args, **kwargs)

    monkeypatch.setattr(tornado.httpclient.AsyncHTTPClient, "fetch", fetch)
    return urls


def deliver(jp_fetch, url):
    return jp_fetch(URL, "callback", method="POST", body=json.dumps({"url": url}))


async def test_a_loopback_link_is_requested_and_its_loopback_redirect_followed(
    jp_fetch, listener
):
    port, seen, _redirects = listener
    response = await deliver(
        jp_fetch, f"http://127.0.0.1:{port}/auth/callback?{SECRET}&state=s"
    )
    assert json.loads(response.body) == {"status": 200}
    # The path and the query as pasted, then the closing page it redirects to.
    # Each once.
    assert seen == [f"/auth/callback?{SECRET}&state=s", f"/success?{TOKEN}"]


@pytest.mark.parametrize(
    "target",
    [
        "http://listener.invalid/success",
        "https://127.0.0.1:{port}/success",
        "//listener.invalid/success",
    ],
)
async def test_a_redirect_that_leaves_the_loopback_is_not_followed(
    jp_fetch, listener, requested, target
):
    port, seen, redirects = listener
    redirects["/auth/callback"] = target.format(port=port)
    response = await deliver(jp_fetch, f"http://127.0.0.1:{port}/auth/callback?{SECRET}")
    # The listener's own answer to the link is the result.
    assert json.loads(response.body) == {"status": 302}
    assert seen == [f"/auth/callback?{SECRET}"]
    # Not asked for at all, which a refused or failed request would still be.
    assert not [url for url in requested if "/success" in url]


async def test_a_redirect_to_a_listener_that_has_closed_keeps_the_first_answer(
    jp_fetch, listener
):
    port, seen, redirects = listener
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        closed = probe.getsockname()[1]
    redirects["/auth/callback"] = f"http://127.0.0.1:{closed}/success"
    response = await deliver(jp_fetch, f"http://127.0.0.1:{port}/auth/callback?{SECRET}")
    # The login answered the link; that its closing page is gone is no failure.
    assert json.loads(response.body) == {"status": 302}
    assert seen == [f"/auth/callback?{SECRET}"]


async def test_a_listener_that_redirects_without_end_is_left_after_a_fixed_count(
    jp_fetch, listener
):
    port, seen, redirects = listener
    redirects["/auth/callback"] = "/auth/callback?again"
    response = await deliver(jp_fetch, f"http://127.0.0.1:{port}/auth/callback?{SECRET}")
    assert json.loads(response.body) == {"status": 302}
    assert len(seen) == 1 + routes.CALLBACK_MAX_REDIRECTS


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


async def test_neither_the_link_nor_its_redirect_is_logged(
    jp_fetch, jp_serverapp, listener
):
    port, seen, _redirects = listener
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
    # The redirect was followed, so its address was in hand to be logged.
    assert seen[-1] == f"/success?{TOKEN}"
    assert not any(SECRET in line or TOKEN in line for line in lines)
