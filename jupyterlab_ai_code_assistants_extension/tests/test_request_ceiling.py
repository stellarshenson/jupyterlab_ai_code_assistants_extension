"""DEF-84: the client's request ceiling has to sit above the server's CLI wait.

``REQUEST_TIMEOUT_MS`` (``src/core/request.ts``) bounds every single-shot
route from the browser. ``_CLI_TIMEOUT_S`` (``providers/codex.py``) is how long
one ``codex archive`` / ``codex delete`` invocation may run before the server
gives up on it. A Codex disposal legitimately holds the server for one full CLI
timeout - that is the slow path working as designed, not a hang - so the client
must sit a FULL timeout above it: one timeout for the invocation the server is
waiting on, one for the request to travel and the handler to finish. Anything
less and the panel raises a timeout toast over a disposal that then succeeds,
which reads to the user as a failure that left the store changed anyway.

The two constants live in different runtimes and were bound by prose alone -
a comment in ``request.ts`` naming the 30s figure. This test is the binding.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from jupyterlab_ai_code_assistants_extension.providers.codex import _CLI_TIMEOUT_S

REPO = Path(__file__).resolve().parents[2]
REQUEST_TS = REPO / "src" / "core" / "request.ts"

#: ``export const REQUEST_TIMEOUT_MS = 60_000;`` - numeric separators included,
#: since that is how the constant is actually written.
_TIMEOUT_RE = re.compile(r"REQUEST_TIMEOUT_MS\s*=\s*([\d_]+)\s*;")

#: How many CLI timeouts the client must clear. See the module docstring.
TIMEOUT_RATIO = 2


def _request_timeout_ms() -> int:
    """The client's ceiling, read out of the TypeScript source.

    Fails loudly rather than skipping when the constant cannot be found: a
    guard that quietly passes when its subject moved or was renamed is worth
    less than no guard, because it goes on reporting green.
    """
    if not REQUEST_TS.is_file():
        pytest.fail(f"{REQUEST_TS} is missing - the guard has nothing to read")
    match = _TIMEOUT_RE.search(REQUEST_TS.read_text(encoding="utf-8"))
    if match is None:
        pytest.fail(
            f"REQUEST_TIMEOUT_MS not found in {REQUEST_TS}. It was renamed or "
            "moved; repoint this guard rather than deleting it."
        )
    return int(match.group(1).replace("_", ""))


def test_client_ceiling_clears_two_codex_cli_timeouts():
    """The browser waits at least two full CLI timeouts before giving up."""
    request_timeout_ms = _request_timeout_ms()
    assert request_timeout_ms >= TIMEOUT_RATIO * _CLI_TIMEOUT_S * 1000, (
        f"REQUEST_TIMEOUT_MS={request_timeout_ms}ms is below "
        f"{TIMEOUT_RATIO} x _CLI_TIMEOUT_S={_CLI_TIMEOUT_S}s. A Codex disposal "
        "can legitimately hold the server one full CLI timeout, so the client "
        "would toast a timeout over a request that succeeds."
    )


def test_the_constants_are_real_numbers_not_a_vacuous_read():
    """Both sides parsed to something a comparison can actually fail on."""
    assert _request_timeout_ms() > 0
    assert _CLI_TIMEOUT_S > 0
