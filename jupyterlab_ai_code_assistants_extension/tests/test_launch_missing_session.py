"""A resume whose conversation is gone, over a live jupyter_server.

The launch route pre-flights a named conversation against the project's known
ids, but a store answers that question from the project's own history
directory - and when that directory has gone there is nothing to miss against,
so the check passes. Gemini then dropped the flag and launched bare, which
starts a BRAND-NEW conversation in the clicked row's place: the terminal looks
like the resume that was asked for and the old history is simply not in it.
The launch has to fail with the 404 the panel already renders instead.
"""
from __future__ import annotations

import json
import shutil

import pytest
import tornado

from jupyterlab_ai_code_assistants_extension.core import registry, routes
from jupyterlab_ai_code_assistants_extension.providers.gemini import gemini_home

from .conftest import new_uuid, write_gemini_tree


URL = "jupyterlab-ai-code-assistants-extension"
SHORT_ID = "demo-4c5d"


class _RecordingTerminalManager:
    """Records launches instead of spawning a pty - and proves none happened."""

    def __init__(self) -> None:
        self.created: list[dict] = []
        self.terminals: dict[str, object] = {}

    def create(self, shell_command=None, cwd=None):
        self.created.append({"shell_command": shell_command, "cwd": cwd})
        return {"name": "term-1"}


@pytest.fixture
def launcher(jp_serverapp, monkeypatch):
    """A server whose gemini binary is present and whose terminals are fake.

    The root comes from ``gemini_home`` rather than from the package's own
    scratch fixture: the live-server fixtures re-point ``HOME`` at their own
    temporary tree, and a fixture tree written anywhere else is invisible to
    the store - which would make every launch here 404 for the wrong reason.
    """
    manager = _RecordingTerminalManager()
    monkeypatch.setitem(jp_serverapp.web_app.settings, "terminal_manager", manager)
    monkeypatch.setattr(registry.Provider, "cli_path", lambda self: "/usr/bin/gemini")
    monkeypatch.setattr(routes, "_user_settings", lambda: {})
    return manager, gemini_home()


async def test_resuming_a_conversation_whose_history_is_gone_is_a_404(
    jp_fetch, launcher, tmp_path
):
    """The whole ``chats/`` directory removed - the case the pre-flight misses.

    Nothing is left to enumerate, so the project's known ids come back empty
    and the pre-flight has nothing to compare against.
    """
    manager, gemini_root = launcher
    session = new_uuid()
    chats = write_gemini_tree(gemini_root, SHORT_ID, [{"id": session}])
    shutil.rmtree(chats)

    with pytest.raises(tornado.httpclient.HTTPClientError) as excinfo:
        await jp_fetch(
            URL,
            "providers",
            "gemini",
            "launch",
            method="POST",
            body=json.dumps({
                "project_path": str(tmp_path),
                "encoded_path": SHORT_ID,
                "session_id": session,
            }),
        )
    assert excinfo.value.code == 404
    assert json.loads(excinfo.value.response.body)["error"] == "session_not_found"
    # A refused launch must leave no terminal behind: one spawned here is a tab
    # the frontend never attaches, running a conversation nobody asked for.
    assert manager.created == []


async def test_a_resumable_conversation_still_launches(jp_fetch, launcher, tmp_path):
    """The guard above is about a MISSING conversation, not about resuming."""
    manager, gemini_root = launcher
    session = new_uuid()
    write_gemini_tree(gemini_root, SHORT_ID, [{"id": session}])

    response = await jp_fetch(
        URL,
        "providers",
        "gemini",
        "launch",
        method="POST",
        body=json.dumps({
            "project_path": str(tmp_path),
            "encoded_path": SHORT_ID,
            "session_id": session,
        }),
    )
    assert json.loads(response.body)["terminal_name"] == "term-1"
    argv = manager.created[0]["shell_command"]
    assert "--session-file" in argv
    assert manager.created[0]["cwd"] == str(tmp_path)
