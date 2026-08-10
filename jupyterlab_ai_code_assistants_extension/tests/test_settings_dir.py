"""Which folder the provider toggles are read from.

JupyterLab's user-settings directory is configurable
(``--LabApp.user_settings_dir``, ``JUPYTERLAB_SETTINGS_DIR``). Reading the
default path instead of the configured one means the saved toggles are never
found, and an absent key reads as ON - so every provider a user turned off
comes back, silently.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from jupyterlab_ai_code_assistants_extension.core import routes


class _FakeLabApp:
    """Stands in for JupyterLab's own extension app in the server settings."""

    def __init__(self, user_settings_dir: str) -> None:
        self.user_settings_dir = user_settings_dir


class _FakeWebApp:
    def __init__(self, settings: dict) -> None:
        self.settings = settings


def _write_toggle(folder: Path, provider_id: str, enabled: bool) -> None:
    """A saved settings file, in JupyterLab's own layout and flat key shape."""
    plugin = folder / routes.SETTINGS_PLUGIN_ID
    plugin.mkdir(parents=True, exist_ok=True)
    (plugin / "plugin.jupyterlab-settings").write_text(
        json.dumps({routes.enabled_setting_key(provider_id): enabled}),
        encoding="utf-8",
    )


@pytest.fixture
def config_dir(tmp_path, monkeypatch):
    """The default location, with no server captured."""
    root = tmp_path / "jupyter-config"
    monkeypatch.setattr(routes, "jupyter_config_dir", lambda: str(root))
    monkeypatch.setattr(routes, "_web_app", None)
    return root / "lab" / "user-settings"


def test_default_settings_dir_without_a_server(config_dir):
    """A server that exposes no JupyterLab app behaves as it always did."""
    assert routes._user_settings_dir() == config_dir
    _write_toggle(config_dir, "codex", False)
    assert routes._provider_enabled("codex") is False


def test_configured_settings_dir_wins_over_the_default(
    tmp_path, monkeypatch, config_dir
):
    """The running server's own directory is where the toggles are read.

    The default location holds a stale ``true`` for the same provider, so the
    two answers are distinguishable: reading the wrong folder reports the
    provider as enabled.
    """
    configured = tmp_path / "configured-user-settings"
    _write_toggle(config_dir, "codex", True)
    _write_toggle(configured, "codex", False)
    monkeypatch.setattr(
        routes,
        "_web_app",
        _FakeWebApp({"lab": _FakeLabApp(str(configured))}),
    )

    assert routes._user_settings_dir() == configured
    assert routes._provider_enabled("codex") is False


def test_unconfigured_lab_app_falls_back(config_dir, monkeypatch):
    """An app registered without a settings directory is not a path.

    ``user_settings_dir`` is an empty-string trait by default in
    ``jupyterlab_server``, and joining that onto a path would read the process's
    working directory.
    """
    monkeypatch.setattr(
        routes, "_web_app", _FakeWebApp({"lab": _FakeLabApp("")})
    )
    assert routes._user_settings_dir() == config_dir


def test_setup_route_handlers_captures_the_web_app(tmp_path, monkeypatch):
    """The capture is what makes the lookup above reach the running server."""
    # Through monkeypatch, so the capture is undone for every later test.
    monkeypatch.setattr(routes, "_web_app", None)
    web_app = _FakeWebApp({"base_url": "/", "lab": _FakeLabApp(str(tmp_path))})
    web_app.add_handlers = lambda *args, **kwargs: None
    routes.setup_route_handlers(web_app)
    assert routes._user_settings_dir() == tmp_path
