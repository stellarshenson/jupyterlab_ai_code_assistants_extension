"""One-shot migration from the retired standalone extensions.

This extension replaces three standalone ones. A user upgrading must not lose
their favourites or their settings, and must not have their assistants' history
touched: migration READS the retired extensions' own sidecars and JupyterLab
settings files, writes favourites into this extension's per-provider state, and
hands the mapped settings keys back for the frontend to apply through the
settings registry (the server has no writable handle on it).

Idempotent by marker: each provider is recorded once in ``migration.json`` and
skipped forever after, so a second call migrates nothing and can never clobber
a value the user has since set here (acc-crit "Migration is idempotent").

Assistant-neutral: everything specific - which package, which sidecar, which
key becomes which - is on the descriptor's ``LegacySource``.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Iterable

from jupyter_core.paths import jupyter_config_dir

from . import state
from .registry import Provider
from .store import load_json, load_jsonc, write_json_atomic


_log = logging.getLogger(__name__)

MARKER_FILENAME = "migration.json"


def _legacy_settings(plugin_id: str, settings_dir: Path | None = None) -> dict:
    """The saved settings of a retired plugin, or empty when it has none.

    ``settings_dir`` is JupyterLab's user-settings folder on THIS server, which
    is a configurable trait - a server that moved it kept the retired
    extensions' saved settings there too, so migration must look where the
    running server actually writes rather than at the default. Only the route
    knows the running app, so it passes the folder down; the default keeps a
    direct caller (and the tests) working exactly as before.
    """
    root = settings_dir or Path(jupyter_config_dir()) / "lab" / "user-settings"
    folder = root / plugin_id
    if not folder.is_dir():
        return {}
    for path in sorted(folder.glob("*.jupyterlab-settings")):
        data = load_jsonc(path)
        if data:
            return data
        # Unreadable saved settings are skipped with a warning, defaults apply,
        # and the other providers still migrate (acc-crit "Edge: corrupt prior
        # settings").
        _log.warning("cannot parse legacy settings at %s - skipping", path)
    return {}


def _legacy_favourites(state_file: str) -> list[str]:
    """The favourites a retired extension recorded, read in place.

    Only read - the retired extension's sidecar and the assistant's history
    directories are never moved, copied or rewritten.
    """
    data = load_json(Path(state_file).expanduser())
    if not isinstance(data, dict):
        return []
    return [
        item
        for item in data.get("favourites") or []
        if isinstance(item, str) and item
    ]


def _marker_path() -> Path:
    return state.state_dir() / MARKER_FILENAME


def _load_marker() -> set[str]:
    data = load_json(_marker_path())
    if not isinstance(data, dict):
        return set()
    return {p for p in data.get("migrated") or [] if isinstance(p, str)}


def _save_marker(migrated: set[str]) -> None:
    write_json_atomic(_marker_path(), {"migrated": sorted(migrated)})


def migrate(
    providers: Iterable[Provider], settings_dir: Path | None = None
) -> list[dict]:
    """Migrate every provider not migrated before.

    Returns one entry per provider migrated in THIS call -
    ``{"provider_id", "keys", "favourites"}`` - so a second call returns an
    empty list. ``keys`` is the mapped settings for the frontend to apply;
    ``favourites`` are the project paths carried over. A provider with no
    legacy source, or one whose retired extension left nothing behind, is a
    silent no-op (acc-crit "Edge: nothing to migrate" / "Edge: partial prior
    install").

    ``settings_dir`` is passed through to :func:`_legacy_settings` - see there
    for why the caller supplies it rather than this module deriving it.
    """
    done = _load_marker()
    migrated: list[dict] = []
    for provider in providers:
        legacy = provider.descriptor.legacy
        if legacy is None or provider.id in done:
            continue

        keys = {
            legacy.settings_map[old]: value
            for old, value in _legacy_settings(
                legacy.plugin_id, settings_dir
            ).items()
            if old in legacy.settings_map
        }

        carried: list[str] = []
        existing = state.load_state(provider.id)
        favourites = existing["favourites"]
        for path in _legacy_favourites(legacy.state_file):
            if path not in favourites:
                favourites.append(path)
                carried.append(path)
        if carried:
            state.save_state(provider.id, existing)

        done.add(provider.id)
        migrated.append(
            {"provider_id": provider.id, "keys": keys, "favourites": carried}
        )

    if migrated:
        _save_marker(done)
    return migrated
