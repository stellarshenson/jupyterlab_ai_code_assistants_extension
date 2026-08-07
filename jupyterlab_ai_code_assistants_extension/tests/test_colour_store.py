"""The write-back colour store and the precedence the core resolves it with.

``colourSource`` decides only the DEFAULT tint. What makes a tab colour
settable on an assistant whose CLI has no colour concept - and durable across a
reload - is this store, so its persistence, its precedence and the inheritance
a branch is born with are asserted here rather than left to the UI tier.
"""
from __future__ import annotations

import dataclasses
import json

import pytest
import tornado

from jupyterlab_ai_code_assistants_extension.core import colour_store, registry
from jupyterlab_ai_code_assistants_extension.core.routes import _effective_colour
from jupyterlab_ai_code_assistants_extension.core.store import SessionStore
from jupyterlab_ai_code_assistants_extension.providers import codex as codex_provider

from .conftest import PROJECT_PATH, new_uuid, write_codex_db


PARENT = "11111111-1111-4111-8111-111111111111"
CHILD = "22222222-2222-4222-8222-222222222222"
GRANDCHILD = "33333333-3333-4333-8333-333333333333"


class _Store(SessionStore):
    """A store whose only interesting behaviour is its default tint."""

    def __init__(self, default: str | None = None) -> None:
        self._default = default

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

    def default_colour(self, session_id):
        return self._default


def provider(colour_source: str, default: str | None = None) -> registry.Provider:
    descriptor = registry.ProviderDescriptor(
        id=f"p-{colour_source}",
        label=colour_source,
        cli_binary="x",
        capabilities=registry.Capabilities(colour_source=colour_source),
    )
    store = _Store(default)
    store.provider_id = descriptor.id
    return registry.Provider(descriptor, store)


def effective(provider: registry.Provider, session_id: str | None) -> str | None:
    """The precedence ladder as the routes run it.

    The conversation's own default now reaches ``_effective_colour`` from the
    caller - a row carries it from the store's own listing, a terminal probe
    asks the store for that one conversation - so the tests hand it over the
    same way rather than having the core re-derive it per call.
    """
    default = provider.store.default_colour(session_id) if session_id else None
    return _effective_colour(provider, session_id, default)


# ------------------------------------------------------------- persistence


def test_a_colour_survives_a_reload():
    """The store is on disk, so a set colour outlives the browser."""
    colour_store.set_colour("kimi", PARENT, "mint")
    # Nothing is cached in the module - a fresh read is the reload.
    assert colour_store.load_colours("kimi") == {PARENT: "mint"}
    assert colour_store.get_colour("kimi", PARENT) == "mint"


def test_colours_are_normalised_and_bounded():
    colour_store.set_colour("kimi", PARENT, "  Mint  ")
    assert colour_store.get_colour("kimi", PARENT) == "mint"
    # A malformed write is ignored rather than bloating the file.
    colour_store.set_colour("kimi", PARENT, "x" * 200)
    assert colour_store.get_colour("kimi", PARENT) == "mint"
    colour_store.set_colour("kimi", PARENT, "   ")
    assert colour_store.get_colour("kimi", PARENT) == "mint"


def test_setting_none_drops_the_entry():
    colour_store.set_colour("kimi", PARENT, "mint")
    colour_store.set_colour("kimi", PARENT, None)
    assert colour_store.load_colours("kimi") == {}


def test_dropping_deleted_conversations_leaves_no_orphan_keys():
    colour_store.set_colour("kimi", PARENT, "mint")
    colour_store.set_colour("kimi", CHILD, "sky")
    colour_store.drop_colours("kimi", [CHILD, "never-stored"])
    assert colour_store.load_colours("kimi") == {PARENT: "mint"}


def test_a_corrupt_colour_file_costs_the_tint_not_the_panel(scratch_stores):
    path = scratch_stores / "state" / "kimi-colours.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ not json", encoding="utf-8")
    assert colour_store.load_colours("kimi") == {}
    colour_store.set_colour("kimi", PARENT, "mint")
    assert colour_store.get_colour("kimi", PARENT) == "mint"


# ------------------------------------------------------------- precedence


def test_user_set_colour_beats_the_derived_hash():
    derived = provider("derived", "lemon")
    assert effective(derived, PARENT) == "lemon"
    colour_store.set_colour(derived.id, PARENT, "sky")
    assert effective(derived, PARENT) == "sky"


def test_user_set_colour_supplies_the_tint_where_there_is_none():
    plain = provider("none")
    assert effective(plain, PARENT) is None
    colour_store.set_colour(plain.id, PARENT, "rose")
    assert effective(plain, PARENT) == "rose"


def test_a_native_colour_stays_owned_by_the_assistant():
    """A write-back against a native provider must never win over ``/color``."""
    native = provider("native", "peach")
    colour_store.set_colour(native.id, PARENT, "sky")
    assert effective(native, PARENT) == "peach"


def test_no_conversation_means_no_colour():
    assert effective(provider("derived", "lemon"), None) is None


# ------------------------------------------------------------ inheritance


def test_a_branch_inherits_the_parents_default():
    inherited = colour_store.inherit_colour("kimi", PARENT, CHILD, "lemon")
    assert inherited == "lemon"
    assert colour_store.get_colour("kimi", CHILD) == "lemon"


def test_a_branch_inherits_the_parents_override_not_its_default():
    colour_store.set_colour("kimi", PARENT, "sky")
    assert colour_store.inherit_colour("kimi", PARENT, CHILD, "lemon") == "sky"
    assert colour_store.get_colour("kimi", CHILD) == "sky"


def test_a_branch_of_a_branch_inherits_the_override():
    colour_store.set_colour("kimi", PARENT, "sky")
    colour_store.inherit_colour("kimi", PARENT, CHILD, "lemon")
    # The grandchild's own hash would be something else entirely; it must take
    # what its immediate parent actually shows.
    colour_store.inherit_colour("kimi", CHILD, GRANDCHILD, "rose")
    assert colour_store.get_colour("kimi", GRANDCHILD) == "sky"


def test_inheritance_is_written_at_fork_time_not_resolved_later():
    """Recolouring or deleting the parent must not change the branch."""
    colour_store.set_colour("kimi", PARENT, "sky")
    colour_store.inherit_colour("kimi", PARENT, CHILD, None)
    colour_store.drop_colours("kimi", [PARENT])
    assert colour_store.get_colour("kimi", CHILD) == "sky"


def test_a_colourless_parent_gives_the_branch_nothing():
    assert colour_store.inherit_colour("kimi", PARENT, CHILD, None) is None
    assert colour_store.load_colours("kimi") == {}


# --------------------------------------------------------------- the route


@pytest.mark.parametrize("colour_source", ["derived", "none"])
async def test_the_colour_route_writes_back_and_answers_the_effective_tint(
    jp_fetch, monkeypatch, colour_source
):
    """The write-back endpoint is what makes a tab colour stick.

    It answers the whole store rather than the one entry, because the panel's
    cache is reconciled from the payload whichever of the three verbs it called.
    """
    target = registry.get("kimi")
    capabilities = dataclasses.replace(
        target.descriptor.capabilities, colour_source=colour_source
    )
    monkeypatch.setattr(
        target,
        "descriptor",
        dataclasses.replace(target.descriptor, capabilities=capabilities),
    )
    monkeypatch.setattr(registry.Provider, "cli_path", lambda self: "/usr/bin/x")

    response = await jp_fetch(
        "jupyterlab-ai-code-assistants-extension",
        "providers",
        "kimi",
        "colours",
        method="POST",
        body=json.dumps({"session_id": PARENT, "colour": "rose"}),
    )
    assert json.loads(response.body) == {"colours": {PARENT: "rose"}}
    assert colour_store.get_colour("kimi", PARENT) == "rose"


async def test_the_colour_route_refuses_a_native_provider(jp_fetch, monkeypatch):
    """Claude owns its conversations' colours; a shadow value would never win."""
    monkeypatch.setattr(registry.Provider, "cli_path", lambda self: "/usr/bin/x")
    with pytest.raises(tornado.httpclient.HTTPClientError) as excinfo:
        await jp_fetch(
            "jupyterlab-ai-code-assistants-extension",
            "providers",
            "claude",
            "colours",
            method="POST",
            body=json.dumps({"session_id": PARENT, "colour": "rose"}),
        )
    assert excinfo.value.code == 400
    assert (
        json.loads(excinfo.value.response.body)["error"] == "colour_owned_by_assistant"
    )
    assert colour_store.get_colour("claude", PARENT) is None


async def test_a_refused_thread_keeps_its_colour_when_the_project_goes(
    jp_fetch, monkeypatch, scratch_stores
):
    """Removing a whole project must not cost a SURVIVOR its tint.

    Codex disposes of a project thread by thread through its CLI, so the one
    the CLI refuses is still there afterwards - and it re-lists on the next
    poll. Its colour therefore has to survive the removal, which it only does
    if the answer names the ids that actually went.
    """
    kept, gone = new_uuid(), new_uuid()
    write_codex_db(
        scratch_stores / "codex",
        [{"id": kept, "recency_ms": 3000}, {"id": gone, "recency_ms": 2000}],
    )
    monkeypatch.setattr(registry.Provider, "cli_path", lambda self: "/usr/bin/x")
    real_which = codex_provider.shutil.which
    monkeypatch.setattr(
        codex_provider.shutil,
        "which",
        lambda cmd, *a, **kw: "/usr/bin/codex"
        if cmd == codex_provider.CLI_BINARY
        else real_which(cmd, *a, **kw),
    )

    class _Refused:
        """One thread the CLI will not part with; the other goes."""

        def __init__(self, argv):
            self.returncode = 1 if kept in argv else 0
            self.stderr = b"thread is running"

    monkeypatch.setattr(
        codex_provider.subprocess, "run", lambda argv, **kwargs: _Refused(argv)
    )
    colour_store.set_colour("codex", kept, "mint")
    colour_store.set_colour("codex", gone, "sky")

    response = await jp_fetch(
        "jupyterlab-ai-code-assistants-extension",
        "providers",
        "codex",
        "sessions",
        method="DELETE",
        body=json.dumps({"encoded_path": PROJECT_PATH}),
        allow_nonstandard_methods=True,
    )
    payload = json.loads(response.body)
    assert payload["removed_ids"] == [gone]
    assert colour_store.get_colour("codex", kept) == "mint"
    assert colour_store.get_colour("codex", gone) is None
