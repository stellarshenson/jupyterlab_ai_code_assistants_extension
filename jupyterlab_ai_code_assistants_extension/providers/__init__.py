"""One module per assistant, discovered by ``core.registry``.

Each module in this package exposes exactly two module-level names:

* ``DESCRIPTOR`` - a ``core.registry.ProviderDescriptor``
* ``STORE`` - a ``core.store.SessionStore`` instance

Nothing else is imported from a provider module, and no core file lists them:
dropping a file in here registers an assistant, deleting it retires one.
"""
