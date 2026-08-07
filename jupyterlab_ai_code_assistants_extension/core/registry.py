"""Provider discovery: one module per assistant, found by import.

A provider module lives in the ``providers`` package and exposes exactly two
module-level names - ``DESCRIPTOR`` (a :class:`ProviderDescriptor`) and
``STORE`` (a :class:`~.store.SessionStore` instance). Adding an assistant is
therefore one new file with no core edit, and deleting that file removes it
completely (acc-crit "Add a provider" / "Remove a provider").

Two failure modes, deliberately different:

* a module that raises on import is logged and skipped - one broken provider
  must not take the others down (acc-crit "Independent failure")
* two descriptors sharing an id raise, here at registration, rather than
  silently shadowing each other at render time (acc-crit "Edge: duplicate
  provider id")
"""
from __future__ import annotations

import importlib
import logging
import pkgutil
import shutil
from dataclasses import dataclass, field
from typing import Mapping

from .store import SessionStore


_log = logging.getLogger(__name__)

# Charset gate for a provider id: it becomes a URL segment, a state filename
# and a settings key, so keep it to the intersection all three tolerate.
_ID_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789-")


class ProviderError(ValueError):
    """A provider module violates the registration contract."""


#: Fork strategies whose new conversation id is known to the SERVER, so
#: ``POST providers/<id>/branch`` can create the branch and answer with its id:
#: ``server-copy`` has the store copy the conversation on disk.
#: The other two mint their id elsewhere and never reach this route.
#: ``native-flag`` has the FRONTEND mint the id and carry it on the launch, so
#: a server-side mint would be a second, competing id for one branch;
#: ``native-command`` has the CLI own the fork verb AND the id, minted inside
#: the launched terminal, so its branch is created by a ``fork_from`` LAUNCH
#: and the id is discovered afterwards by the frontend's branch watcher. The
#: vocabulary is shared verbatim with the frontend descriptor's
#: ``forkStrategy``.
SERVER_MINTED_FORKS = frozenset({"server-copy"})


@dataclass(frozen=True)
class Capabilities:
    """The divergences between assistants, as flags rather than branches.

    Core code reads these; it never reads a provider id to decide behaviour.

    * ``fork_strategy`` - ``native-flag`` (the CLI forks from a flag pair and
      the store mints the id), ``native-command`` (the CLI owns both the fork
      verb and the id, reached through a ``fork_from`` launch),
      ``server-copy`` (the store copies the conversation itself) or ``none``
    * ``colour_source`` - ``native`` (the assistant owns the conversation's
      colour), ``derived`` (the store computes one from the id) or ``none``
    * ``launch_modes`` - the mode tokens ``launch_argv`` accepts; anything else
      is rejected by the core with 400 ``mode_unsupported``
    """

    fork_strategy: str = "none"
    colour_source: str = "none"
    launch_modes: tuple[str, ...] = ()


@dataclass(frozen=True)
class LegacySource:
    """Where a retired standalone extension kept its state, for migration.

    Assistant-specific data, so it lives on the descriptor and
    ``core.migrate`` stays neutral.

    * ``plugin_id`` - the retired package's JupyterLab settings directory name
    * ``state_file`` - its favourites sidecar, as a home-relative path
    * ``settings_map`` - old settings key to the key it becomes here, e.g.
      ``{"dangerouslySkipPermissions": "providers.<id>.skipPermissions"}``
    """

    plugin_id: str
    state_file: str
    settings_map: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class ProviderDescriptor:
    """One assistant, declared once."""

    id: str
    label: str
    cli_binary: str
    capabilities: Capabilities = field(default_factory=Capabilities)
    legacy: LegacySource | None = None


class Provider:
    """A descriptor bound to its store, plus the live CLI probe."""

    def __init__(self, descriptor: ProviderDescriptor, store: SessionStore) -> None:
        self.descriptor = descriptor
        self.store = store

    @property
    def id(self) -> str:
        return self.descriptor.id

    def cli_path(self) -> str | None:
        """Resolved path of the assistant's binary, or None.

        Probed on every call rather than cached: a binary installed while
        JupyterLab runs must enable its panel on the next status refresh
        without a reload (acc-crit "Edge: CLI appears after start").
        """
        return shutil.which(self.descriptor.cli_binary)


_cache: dict[str, Provider] | None = None


def _validate(descriptor: object, store: object, module_name: str) -> None:
    if not isinstance(descriptor, ProviderDescriptor):
        raise ProviderError(f"{module_name}.DESCRIPTOR is not a ProviderDescriptor")
    if not isinstance(store, SessionStore):
        raise ProviderError(f"{module_name}.STORE is not a SessionStore")
    if not descriptor.id or not set(descriptor.id) <= _ID_CHARS:
        raise ProviderError(
            f"{module_name}.DESCRIPTOR.id {descriptor.id!r} is not lowercase "
            "alphanumeric-with-hyphens"
        )


def _discover() -> dict[str, Provider]:
    from .. import providers as providers_pkg

    found: dict[str, Provider] = {}
    for info in pkgutil.iter_modules(providers_pkg.__path__):
        if info.name.startswith("_"):
            continue
        module_name = f"{providers_pkg.__name__}.{info.name}"
        try:
            module = importlib.import_module(module_name)
        except Exception:
            # One provider failing to import leaves the rest working.
            _log.exception("provider module %s failed to import", module_name)
            continue
        descriptor = getattr(module, "DESCRIPTOR", None)
        store = getattr(module, "STORE", None)
        if descriptor is None and store is None:
            continue
        _validate(descriptor, store, module_name)
        if descriptor.id in found:
            raise ProviderError(
                f"duplicate provider id {descriptor.id!r}: {module_name} and "
                f"{type(found[descriptor.id].store).__module__}"
            )
        # The store reaches its own favourites, pins and colours by id; binding
        # it here keeps the id declared in exactly one place.
        store.provider_id = descriptor.id
        found[descriptor.id] = Provider(descriptor, store)
    return dict(sorted(found.items()))


def providers() -> dict[str, Provider]:
    """Every registered provider by id, discovered once per process."""
    global _cache
    if _cache is None:
        _cache = _discover()
    return _cache


def get(provider_id: str) -> Provider | None:
    """One provider by id, or None when nothing is registered under it."""
    return providers().get(provider_id)


def reload() -> dict[str, Provider]:
    """Re-run discovery, dropping the cache. For tests."""
    global _cache
    _cache = None
    return providers()
