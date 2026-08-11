"""Migration end to end, over the route, against a real retired-plugin tree.

``test_migrate.py`` calls :func:`migrate.migrate` directly, so it says nothing
about the two ends the route joins: the retired plugin's own settings layout on
one side, and the settings folder THIS server writes to on the other. Both are
asserted here through the HTTP layer, with a claude tree in the shape the
retired ``jupyterlab_claude_code_extension`` actually left behind.

The folder is the point. ``user_settings_dir`` is configurable, and the retired
extension's saved settings sit beside this one's - so a route that read the
default while the server wrote elsewhere would migrate nothing and mark the
provider done forever (docs/defects.md DEF-87). The second test puts opposite
values in the two folders, which is what makes reading the wrong one visible.
"""
from __future__ import annotations

import json
from pathlib import Path

from jupyterlab_ai_code_assistants_extension.core import migrate, routes, state


URL = "jupyterlab-ai-code-assistants-extension"
# The retired extension's own settings folder name and favourites sidecar, as
# ``providers/claude.py`` declares them on its ``LegacySource``.
LEGACY_PLUGIN_ID = "jupyterlab_claude_code_extension"
LEGACY_SIDECAR = "~/.claude/jupyterlab_claude_code_extension.json"
MAPPED_KEY = "providers.claude.dangerouslySkipPermissions"


class _FakeLabApp:
    """Stands in for JupyterLab's own extension app in the server settings."""

    def __init__(self, user_settings_dir: str) -> None:
        self.user_settings_dir = user_settings_dir


def _write_legacy_settings(root: Path, payload: dict) -> None:
    """The retired plugin's saved settings, in JupyterLab's own layout.

    JupyterLab seeds the file with a commented copy of the schema, so what the
    retired extension left is JSON-with-comments in practice.
    """
    folder = root / LEGACY_PLUGIN_ID
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "plugin.jupyterlab-settings").write_text(
        "// saved by the retired extension\n" + json.dumps(payload),
        encoding="utf-8",
    )


def _write_legacy_favourites(favourites: list[str]) -> Path:
    path = Path(LEGACY_SIDECAR).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"favourites": favourites}), encoding="utf-8")
    return path


def _entry(body: dict, provider_id: str) -> dict:
    return next(e for e in body["migrated"] if e["provider_id"] == provider_id)


def _default_config_dir(monkeypatch, tmp_path) -> Path:
    """Point the default settings location at a scratch root.

    Both modules resolve it: the route hands its own answer down, and
    ``migrate`` keeps a default for a direct caller - which is the location a
    route that stopped passing the folder would fall back to.
    """
    root = tmp_path / "jupyter-config"
    monkeypatch.setattr(migrate, "jupyter_config_dir", lambda: str(root))
    monkeypatch.setattr(routes, "jupyter_config_dir", lambda: str(root))
    return root


async def test_the_route_carries_a_retired_install_over(
    jp_fetch, tmp_path, monkeypatch
):
    """One POST, and the mapped key and the favourites come back."""
    config_root = _default_config_dir(monkeypatch, tmp_path)
    _write_legacy_settings(
        config_root / "lab" / "user-settings",
        {"dangerouslySkipPermissions": True, "recentLimit": 25},
    )
    sidecar = _write_legacy_favourites(["/home/lab/projects/demo"])

    body = json.loads(
        (await jp_fetch(URL, "migrate", method="POST", body="")).body
    )

    # Only the mapped key travels - ``recentLimit`` has no target here, and a
    # value carried to a key nothing reads is lost silently.
    assert _entry(body, "claude") == {
        "provider_id": "claude",
        "keys": {MAPPED_KEY: True},
        "favourites": ["/home/lab/projects/demo"],
    }
    assert state.load_favourites("claude") == ["/home/lab/projects/demo"]
    # The retired extension's sidecar is read in place, never rewritten.
    assert json.loads(sidecar.read_text()) == {
        "favourites": ["/home/lab/projects/demo"]
    }


async def test_the_route_reads_the_configured_settings_dir(
    jp_fetch, jp_serverapp, tmp_path, monkeypatch
):
    """The server's own settings folder, not the default one.

    The default location holds the opposite value for the same key, so the two
    answers are distinguishable: a route that stops handing its settings
    directory to :func:`migrate.migrate` reports ``False`` here.
    """
    config_root = _default_config_dir(monkeypatch, tmp_path)
    _write_legacy_settings(
        config_root / "lab" / "user-settings",
        {"dangerouslySkipPermissions": False},
    )
    configured = tmp_path / "configured-user-settings"
    _write_legacy_settings(configured, {"dangerouslySkipPermissions": True})
    monkeypatch.setitem(
        jp_serverapp.web_app.settings, "lab", _FakeLabApp(str(configured))
    )

    body = json.loads(
        (await jp_fetch(URL, "migrate", method="POST", body="")).body
    )

    assert _entry(body, "claude")["keys"] == {MAPPED_KEY: True}
