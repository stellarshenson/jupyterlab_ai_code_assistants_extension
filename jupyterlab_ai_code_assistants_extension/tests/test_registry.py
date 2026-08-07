"""Provider discovery and the descriptor contract.

Guards the acc-crit "pytest: registry" row - every module in ``providers/`` is
discovered, exposes a unique id and satisfies the contract - plus the two
deliberately different failure modes of ``core.registry``: a module that raises
on import is skipped, two modules claiming one id raise at registration.
"""
from __future__ import annotations

import importlib
import itertools
import sys

import pytest

from jupyterlab_ai_code_assistants_extension.core import registry
from jupyterlab_ai_code_assistants_extension.core.store import SessionStore


# Every provider module shipped today. Listed here so a provider added without
# its module reaching discovery - a barrel line missed, a rename - fails a test
# rather than silently costing the user a panel.
EXPECTED_IDS = {"claude", "codex", "gemini", "kimi"}

# The same vocabulary the frontend descriptor's ``forkStrategy`` uses - the two
# registries describe one assistant, so a strategy named differently on each
# side is a divergence waiting to be branched on.
FORK_STRATEGIES = {"native-flag", "native-command", "server-copy", "none"}
COLOUR_SOURCES = {"native", "derived", "none"}

_counter = itertools.count()


def install_fake_providers(tmp_path, monkeypatch, modules: dict[str, str]):
    """Swap the providers package for one built from ``{name: source}``.

    Discovery reads ``jupyterlab_ai_code_assistants_extension.providers`` by
    attribute, so pointing that attribute at a scratch package is enough to
    exercise it against any provider set - including ones that cannot exist in
    the real package, like two modules claiming a single id.
    """
    package = f"fake_providers_{next(_counter)}"
    package_dir = tmp_path / package
    package_dir.mkdir()
    (package_dir / "__init__.py").write_text("", encoding="utf-8")
    for name, source in modules.items():
        (package_dir / f"{name}.py").write_text(source, encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))
    module = importlib.import_module(package)
    monkeypatch.setattr(
        importlib.import_module("jupyterlab_ai_code_assistants_extension"),
        "providers",
        module,
    )
    for key in [k for k in sys.modules if k == package or k.startswith(package + ".")]:
        monkeypatch.delitem(sys.modules, key, raising=False)
    sys.modules[package] = module
    return module


PROVIDER_TEMPLATE = '''
from jupyterlab_ai_code_assistants_extension.core.registry import (
    Capabilities,
    ProviderDescriptor,
)
from jupyterlab_ai_code_assistants_extension.core.store import SessionStore


class _Store(SessionStore):
    def list_sessions(self, root_dir=None):
        return []

    def list_branches(self, encoded_path, include_extras=False):
        return None

    def resolve_current(self, encoded_path):
        return None

    def switch(self, encoded_path, session_id):
        return None

    def remove(self, encoded_path, to_trash=False):
        return None

    def delete_branches(self, encoded_path, session_ids, to_trash=False):
        return None

    def launch_argv(self, cli_path, **kwargs):
        return [cli_path]


DESCRIPTOR = ProviderDescriptor(
    id="{id}", label="{id}", cli_binary="{id}", capabilities=Capabilities()
)
STORE = _Store()
'''


# ------------------------------------------------------------- real registry


def test_every_provider_module_is_discovered():
    assert set(registry.providers()) == EXPECTED_IDS


def test_ids_are_unique_and_url_safe():
    ids = [p.descriptor.id for p in registry.providers().values()]
    assert len(ids) == len(set(ids))
    for provider_id in ids:
        assert provider_id
        assert set(provider_id) <= registry._ID_CHARS


@pytest.mark.parametrize("provider_id", sorted(EXPECTED_IDS))
def test_descriptor_contract(provider_id):
    """One descriptor, one store, capability flags from the declared vocabulary."""
    provider = registry.get(provider_id)
    assert provider is not None
    descriptor = provider.descriptor
    assert isinstance(descriptor, registry.ProviderDescriptor)
    assert descriptor.id == provider_id
    assert descriptor.label.strip()
    assert descriptor.cli_binary.strip()

    caps = descriptor.capabilities
    assert caps.fork_strategy in FORK_STRATEGIES
    assert caps.colour_source in COLOUR_SOURCES
    assert isinstance(caps.launch_modes, tuple)
    assert all(isinstance(mode, str) and mode for mode in caps.launch_modes)

    store = provider.store
    assert isinstance(store, SessionStore)
    # The registry binds the id, so a store reaches its own favourites, pins
    # and colours without naming itself.
    assert store.provider_id == provider_id
    assert isinstance(store.comm_name, str)


@pytest.mark.parametrize("provider_id", sorted(EXPECTED_IDS))
def test_capability_flags_match_the_store(provider_id):
    """A flag the core reads must be backed by an implementation.

    ``colour_source: derived`` promises a ``default_colour``, and each fork
    strategy promises the surface the core reaches it through: the two
    server-minted ones (``native-flag`` mints the id, ``server-copy`` writes the
    copy) promise ``fork``, while ``native-command`` promises a ``launch_argv``
    that takes the parent as ``fork_from``, since its id is minted by the CLI
    inside the terminal. A descriptor claiming one without the other is the
    shape of docs/defects.md DEF-1 - a 400 ``fork_failed`` on every branch.
    """
    provider = registry.get(provider_id)
    caps = provider.descriptor.capabilities
    store_type = type(provider.store)
    if caps.colour_source == "derived":
        assert store_type.default_colour is not SessionStore.default_colour
    if caps.fork_strategy in registry.SERVER_MINTED_FORKS:
        assert store_type.fork is not SessionStore.fork
    elif caps.fork_strategy == "native-command":
        parent = "11111111-2222-3333-4444-555555555555"
        argv = provider.store.launch_argv(f"/usr/bin/{provider_id}", fork_from=parent)
        assert parent in argv


def test_every_store_accepts_the_whole_launch_contract():
    """The core calls ``launch_argv`` with every id by keyword, always.

    A store that omitted one of them would raise ``TypeError`` inside the
    launch handler - past the point where the caller can still be told, since
    the argv is built off the IOLoop just before the pty is created.
    """
    for provider_id, provider in registry.providers().items():
        argv = provider.store.launch_argv(
            f"/usr/bin/{provider_id}",
            session_id=None,
            new_session_id=None,
            fork_session_id=None,
            fork_from=None,
            mode=None,
            name=None,
        )
        assert argv[0] == f"/usr/bin/{provider_id}"


@pytest.mark.parametrize("provider_id", sorted(EXPECTED_IDS))
def test_legacy_source_maps_onto_this_extension_keys(provider_id):
    """Migration targets stay inside the provider's own settings namespace."""
    legacy = registry.get(provider_id).descriptor.legacy
    if legacy is None:
        return
    assert legacy.plugin_id
    assert legacy.state_file
    for old, new in legacy.settings_map.items():
        assert old
        assert new.startswith(f"providers.{provider_id}.")


def test_cli_path_is_probed_per_call(monkeypatch):
    """A binary installed while the server runs must surface without a reload."""
    provider = registry.get("claude")
    monkeypatch.setattr(registry.shutil, "which", lambda name: None)
    assert provider.cli_path() is None
    monkeypatch.setattr(registry.shutil, "which", lambda name: f"/usr/bin/{name}")
    assert provider.cli_path() == "/usr/bin/claude"


# ------------------------------------------------------------ swapped package


def test_discovery_reads_whatever_is_in_the_package(tmp_path, monkeypatch):
    install_fake_providers(
        tmp_path,
        monkeypatch,
        {
            "alpha": PROVIDER_TEMPLATE.format(id="alpha"),
            "beta": PROVIDER_TEMPLATE.format(id="beta"),
        },
    )
    found = registry.reload()
    assert sorted(found) == ["alpha", "beta"]
    assert found["alpha"].store.provider_id == "alpha"


def test_duplicate_provider_id_fails_at_registration(tmp_path, monkeypatch):
    """Two descriptors sharing an id raise here, not at render time."""
    install_fake_providers(
        tmp_path,
        monkeypatch,
        {
            "first": PROVIDER_TEMPLATE.format(id="twin"),
            "second": PROVIDER_TEMPLATE.format(id="twin"),
        },
    )
    with pytest.raises(registry.ProviderError) as excinfo:
        registry.reload()
    assert "twin" in str(excinfo.value)


def test_broken_module_is_skipped_and_the_rest_survive(tmp_path, monkeypatch):
    """One provider failing to import leaves the others working."""
    install_fake_providers(
        tmp_path,
        monkeypatch,
        {
            "good": PROVIDER_TEMPLATE.format(id="good"),
            "bad": "raise RuntimeError('provider is broken')\n",
        },
    )
    assert sorted(registry.reload()) == ["good"]


def test_module_without_the_two_names_is_not_a_provider(tmp_path, monkeypatch):
    install_fake_providers(
        tmp_path,
        monkeypatch,
        {
            "good": PROVIDER_TEMPLATE.format(id="good"),
            "helpers": "VALUE = 1\n",
        },
    )
    assert sorted(registry.reload()) == ["good"]


def test_wrong_descriptor_type_is_refused(tmp_path, monkeypatch):
    install_fake_providers(
        tmp_path,
        monkeypatch,
        {"rogue": "DESCRIPTOR = {'id': 'rogue'}\nSTORE = object()\n"},
    )
    with pytest.raises(registry.ProviderError):
        registry.reload()


def test_illegal_id_charset_is_refused(tmp_path, monkeypatch):
    """An id becomes a URL segment, a filename and a settings key."""
    install_fake_providers(
        tmp_path, monkeypatch, {"rogue": PROVIDER_TEMPLATE.format(id="Bad/Id")}
    )
    with pytest.raises(registry.ProviderError):
        registry.reload()
