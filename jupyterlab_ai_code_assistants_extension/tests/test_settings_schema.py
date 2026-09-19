"""The shipped settings schema against the provider registry.

``schema/plugin.json`` is generated from the compiled barrel by
``scripts/generate-schema.mjs``, so nothing here runs that generator - it
WRITES the tree, and a test that rewrites its own input proves only that the
generator is deterministic. The schema on disk is the artefact JupyterLab
actually loads, so that is what is compared against the registry.

The generator reads the TypeScript descriptors and this reads the Python ones,
which is the point: the two runtimes are bound by ``test_descriptor_parity``,
so a schema that matches the Python registry matches the barrel it was built
from, and a provider added to one runtime only fails here as well as there.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from jupyterlab_ai_code_assistants_extension.core import registry


SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schema" / "plugin.json"

#: Keys that apply to every panel from one value, rather than per provider.
SHARED_KEYS = {"presentationMode", "recentLimit", "sidebar", "colouredTabs"}


@pytest.fixture(scope="module")
def schema() -> dict:
    if not SCHEMA_PATH.is_file():
        pytest.skip(f"{SCHEMA_PATH} not present (sdist test run)")
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def properties(schema) -> dict:
    return schema["properties"]


def provider_keys(properties: dict) -> dict[str, list[str]]:
    """``{provider id: [key suffix, ...]}`` for every ``providers.<id>.<x>`` key."""
    found: dict[str, list[str]] = {}
    for key in properties:
        parts = key.split(".")
        if len(parts) == 3 and parts[0] == "providers":
            found.setdefault(parts[1], []).append(parts[2])
    return found


def test_the_settings_page_is_one_section(schema):
    """One "AI Code Assistants" entry, not one per assistant."""
    assert schema["title"] == "AI Code Assistants"
    assert schema["jupyter.lab.setting-icon-label"] == "AI Code Assistants"
    # One schema file is what makes it one section; a second plugin id would be
    # a second entry in the settings list.
    assert sorted(p.name for p in SCHEMA_PATH.parent.glob("*.json")) == ["plugin.json"]


def test_every_registered_provider_has_an_enable_key(properties):
    declared = {
        key.split(".")[1] for key in properties if key.endswith(".enabled")
    }
    assert declared == set(registry.providers())
    for provider_id in registry.providers():
        entry = properties[f"providers.{provider_id}.enabled"]
        assert entry["type"] == "boolean"
        # Absent reads as enabled, and the default says so where the user looks.
        assert entry["default"] is True


def test_the_schema_names_no_provider_the_registry_does_not(properties):
    """Adding a provider adds its toggle; removing one takes the toggle with it."""
    assert set(provider_keys(properties)) == set(registry.providers())


def test_every_declared_launch_mode_has_a_key_under_its_own_name(properties):
    """Each assistant's approval control keeps that assistant's own terminology."""
    for provider_id, provider in registry.providers().items():
        for mode in provider.descriptor.capabilities.launch_modes:
            key = f"providers.{provider_id}.{mode}"
            assert key in properties, f"{key} missing from the schema"
            entry = properties[key]
            assert entry["type"] == "boolean"
            # Off by default: an approval bypass is never the resting state.
            assert entry["default"] is False


def test_a_provider_exposes_exactly_the_controls_it_declares(properties):
    """No second approval switch, and no key for a mode the store will refuse."""
    for provider_id, suffixes in provider_keys(properties).items():
        declared = set(
            registry.get(provider_id).descriptor.capabilities.launch_modes
        )
        assert set(suffixes) - {"enabled"} == declared


def test_at_most_one_approval_control_per_provider(properties):
    for provider_id, suffixes in provider_keys(properties).items():
        assert len(set(suffixes) - {"enabled"}) <= 1, provider_id


def test_the_shared_keys_are_present_and_not_per_provider(properties):
    assert SHARED_KEYS <= set(properties)
    for key in SHARED_KEYS:
        assert not key.startswith("providers.")
    assert properties["presentationMode"]["default"] == "name"
    assert properties["sidebar"]["default"] == "right"
    assert properties["recentLimit"]["type"] == "integer"


def test_the_recent_limit_default_sits_inside_its_own_bounds(properties):
    entry = properties["recentLimit"]
    assert entry["minimum"] <= entry["default"] <= entry["maximum"]


def test_the_enable_key_the_schema_declares_is_the_one_the_server_gates_on(properties):
    """The server's gate and the shipped schema name the same key.

    A gate reading a key the schema never declares is a gate that never fires -
    the shape mismatch behind docs/defects.md DEF-5.
    """
    from jupyterlab_ai_code_assistants_extension.core import routes

    for provider_id in registry.providers():
        assert routes.enabled_setting_key(provider_id) in properties
