"""Carrying state over from the retired standalone extensions.

Migration is the one path that reads files this extension does not own, so the
assertions are about restraint as much as about mapping: it must read the
retired sidecars in place, write nothing back into them, and - run twice -
change nothing the second time and never clobber a value the user has since set
here.
"""
from __future__ import annotations

import json

import pytest

from jupyterlab_ai_code_assistants_extension.core import migrate, state
from jupyterlab_ai_code_assistants_extension.core.registry import (
    Capabilities,
    LegacySource,
    Provider,
    ProviderDescriptor,
)


@pytest.fixture
def config_dir(tmp_path, monkeypatch):
    """A scratch Jupyter config root holding the retired plugins' settings."""
    root = tmp_path / "config"
    monkeypatch.setattr(migrate, "jupyter_config_dir", lambda: str(root))
    return root


def write_legacy_settings(config_dir, plugin_id: str, payload: dict) -> None:
    folder = config_dir / "lab" / "user-settings" / plugin_id
    folder.mkdir(parents=True, exist_ok=True)
    # JupyterLab seeds a saved settings file with a commented copy of the
    # schema, so the retired plugin's file is JSON-with-comments in practice.
    (folder / "plugin.jupyterlab-settings").write_text(
        "// saved by the retired extension\n" + json.dumps(payload), encoding="utf-8"
    )


def write_legacy_favourites(path, favourites: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"favourites": favourites}), encoding="utf-8")


def fake_provider(provider_id: str, state_file, plugin_id: str | None = None):
    legacy = LegacySource(
        plugin_id=plugin_id or f"jupyterlab_{provider_id}_extension",
        state_file=str(state_file),
        settings_map={"unsafeMode": f"providers.{provider_id}.unsafeMode"},
    )
    descriptor = ProviderDescriptor(
        id=provider_id,
        label=provider_id,
        cli_binary=provider_id,
        capabilities=Capabilities(),
        legacy=legacy,
    )
    return Provider(descriptor, None)


def test_settings_and_favourites_are_carried_over(config_dir, tmp_path):
    sidecar = tmp_path / "legacy" / "alpha.json"
    provider = fake_provider("alpha", sidecar)
    write_legacy_settings(
        config_dir,
        provider.descriptor.legacy.plugin_id,
        {"unsafeMode": True, "recentLimit": 25},
    )
    write_legacy_favourites(sidecar, ["/home/lab/one", "/home/lab/two"])

    migrated = migrate.migrate([provider])
    assert migrated == [
        {
            "provider_id": "alpha",
            # Only the mapped key travels; shared settings are this extension's
            # own, so one assistant's value must not decide them for all.
            "keys": {"providers.alpha.unsafeMode": True},
            "favourites": ["/home/lab/one", "/home/lab/two"],
        }
    ]
    assert state.load_favourites("alpha") == ["/home/lab/one", "/home/lab/two"]


def test_running_twice_changes_nothing_and_writes_nothing(config_dir, tmp_path):
    sidecar = tmp_path / "legacy" / "alpha.json"
    provider = fake_provider("alpha", sidecar)
    write_legacy_settings(config_dir, provider.descriptor.legacy.plugin_id, {"unsafeMode": True})
    write_legacy_favourites(sidecar, ["/home/lab/one"])

    assert migrate.migrate([provider])
    marker = migrate._marker_path()
    state_file = state.state_dir() / "alpha.json"
    stamps = (marker.stat().st_mtime_ns, state_file.stat().st_mtime_ns)
    before = (marker.read_bytes(), state_file.read_bytes())

    assert migrate.migrate([provider]) == []
    # Identical result AND no second write - the marker is what makes the
    # second run a no-op instead of a re-import.
    assert (marker.stat().st_mtime_ns, state_file.stat().st_mtime_ns) == stamps
    assert (marker.read_bytes(), state_file.read_bytes()) == before


def test_a_value_set_here_is_never_clobbered(config_dir, tmp_path):
    sidecar = tmp_path / "legacy" / "alpha.json"
    provider = fake_provider("alpha", sidecar)
    write_legacy_favourites(sidecar, ["/home/lab/one"])
    migrate.migrate([provider])

    # The user unstars it here, then migration runs again.
    state.toggle_favourite("alpha", "/home/lab/one", False)
    assert migrate.migrate([provider]) == []
    assert state.load_favourites("alpha") == []


def test_the_retired_sidecar_is_only_ever_read(config_dir, tmp_path):
    sidecar = tmp_path / "legacy" / "alpha.json"
    provider = fake_provider("alpha", sidecar)
    write_legacy_favourites(sidecar, ["/home/lab/one"])
    before = (sidecar.read_bytes(), sidecar.stat().st_mtime_ns)
    migrate.migrate([provider])
    assert (sidecar.read_bytes(), sidecar.stat().st_mtime_ns) == before
    settings_dir = config_dir / "lab" / "user-settings"
    assert not (settings_dir / provider.descriptor.legacy.plugin_id).exists()


def test_nothing_to_migrate_is_a_silent_no_op(config_dir, tmp_path):
    """A fresh install with no prior extension records the visit and stops."""
    provider = fake_provider("alpha", tmp_path / "absent.json")
    assert migrate.migrate([provider]) == [
        {"provider_id": "alpha", "keys": {}, "favourites": []}
    ]
    assert migrate.migrate([provider]) == []
    assert state.load_favourites("alpha") == []


def test_a_provider_with_no_legacy_source_is_skipped(config_dir):
    descriptor = ProviderDescriptor(
        id="fresh", label="Fresh", cli_binary="fresh", capabilities=Capabilities()
    )
    assert migrate.migrate([Provider(descriptor, None)]) == []


def test_one_prior_install_migrates_and_the_others_are_skipped(config_dir, tmp_path):
    """Partial prior install - one standalone present, one absent."""
    present = fake_provider("alpha", tmp_path / "legacy" / "alpha.json")
    absent = fake_provider("beta", tmp_path / "legacy" / "beta.json")
    write_legacy_favourites(tmp_path / "legacy" / "alpha.json", ["/home/lab/one"])

    migrated = {entry["provider_id"]: entry for entry in migrate.migrate([present, absent])}
    assert migrated["alpha"]["favourites"] == ["/home/lab/one"]
    assert migrated["beta"]["favourites"] == []


def test_corrupt_prior_settings_are_skipped_and_the_rest_continue(config_dir, tmp_path):
    broken = fake_provider("alpha", tmp_path / "legacy" / "alpha.json")
    good = fake_provider("beta", tmp_path / "legacy" / "beta.json")
    folder = config_dir / "lab" / "user-settings" / broken.descriptor.legacy.plugin_id
    folder.mkdir(parents=True)
    (folder / "plugin.jupyterlab-settings").write_text("{ not json", encoding="utf-8")
    write_legacy_settings(config_dir, good.descriptor.legacy.plugin_id, {"unsafeMode": True})

    migrated = {entry["provider_id"]: entry for entry in migrate.migrate([broken, good])}
    assert migrated["alpha"]["keys"] == {}
    assert migrated["beta"]["keys"] == {"providers.beta.unsafeMode": True}


def test_migration_state_lives_outside_every_assistant_store(config_dir, tmp_path):
    provider = fake_provider("alpha", tmp_path / "legacy" / "alpha.json")
    write_legacy_favourites(tmp_path / "legacy" / "alpha.json", ["/home/lab/one"])
    migrate.migrate([provider])
    assert migrate._marker_path().parent == state.state_dir()
    assert (tmp_path / "legacy").is_dir()
    assert [p.name for p in (tmp_path / "legacy").iterdir()] == ["alpha.json"]
