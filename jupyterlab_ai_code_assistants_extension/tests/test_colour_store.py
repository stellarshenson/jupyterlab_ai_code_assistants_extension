"""The write-back colour store and the precedence the core resolves it with.

``colourSource`` decides only the DEFAULT tint. What makes a tab colour
settable for EVERY provider - and durable across a reload - is this store, so its persistence, its precedence and the inheritance
a branch is born with are asserted here rather than left to the UI tier.
"""
from __future__ import annotations

import dataclasses
import json

import pytest

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

    Both the conversation's own default and the override map reach
    ``_effective_colour`` from the caller - a row carries the default from the
    store's own listing and the map from one read per listing, a terminal probe
    asks for that one conversation - so the tests hand them over the same way
    rather than having the core re-derive either per call.
    """
    default = provider.store.default_colour(session_id) if session_id else None
    return _effective_colour(
        session_id, default, colour_store.load_colours(provider.id)
    )


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


def test_a_hand_set_colour_beats_the_assistants_own():
    """The tab is the control surface even where the CLI has ``/color``.

    Setting a colour on the tab diverges from what the assistant chose on
    purpose; that later preference is the one kept, and it keeps winning on
    every subsequent read.
    """
    native = provider("native", "peach")
    assert effective(native, PARENT) == "peach"
    colour_store.set_colour(native.id, PARENT, "sky")
    assert effective(native, PARENT) == "sky"


def test_dropping_the_override_hands_a_native_conversation_back_to_the_assistant():
    """The override is releasable - it is a preference, not a one-way door."""
    native = provider("native", "peach")
    colour_store.set_colour(native.id, PARENT, "sky")
    colour_store.set_colour(native.id, PARENT, None)
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


@pytest.mark.parametrize("colour_source", ["derived", "none", "native"])
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
    assert json.loads(response.body) == {
        "colours": {PARENT: "rose"},
        "overrides": [PARENT],
    }
    assert colour_store.get_colour("kimi", PARENT) == "rose"


async def test_the_colour_route_accepts_a_native_provider(jp_fetch, monkeypatch):
    """Claude's tab colour is settable and remembered, `/color` notwithstanding.

    The route is what carries the divergence to disk; without it the choice
    would live only in the tab and die with the next poll.
    """
    monkeypatch.setattr(registry.Provider, "cli_path", lambda self: "/usr/bin/x")
    response = await jp_fetch(
        "jupyterlab-ai-code-assistants-extension",
        "providers",
        "claude",
        "colours",
        method="POST",
        body=json.dumps({"session_id": PARENT, "colour": "rose"}),
    )
    assert json.loads(response.body) == {
        "colours": {PARENT: "rose"},
        "overrides": [PARENT],
    }
    assert colour_store.get_colour("claude", PARENT) == "rose"


# ------------------------------------------------------------------- origin


def test_an_inherited_tint_is_not_a_hand_set_one():
    """The two are stored together and released apart.

    Both outrank the default identically - a branch must show the colour it was
    born with. Only the hand-set one is the user's to take back: dropping an
    inherited tint would scatter every fork of a project to an unrelated
    colour on a provider whose default is a hash of the id.
    """
    colour_store.set_colour("kimi", PARENT, "sky")
    colour_store.inherit_colour("kimi", PARENT, CHILD, "lemon")
    assert colour_store.load_colours("kimi") == {PARENT: "sky", CHILD: "sky"}
    assert colour_store.load_store("kimi")[1] == [PARENT]


def test_colouring_an_inherited_conversation_by_hand_makes_it_the_users():
    colour_store.inherit_colour("kimi", PARENT, CHILD, "lemon")
    assert colour_store.load_store("kimi")[1] == []
    colour_store.set_colour("kimi", CHILD, "rose")
    assert colour_store.load_store("kimi")[1] == [CHILD]


def test_releasing_an_override_forgets_that_it_was_one():
    colour_store.set_colour("kimi", PARENT, "sky")
    colour_store.set_colour("kimi", PARENT, None)
    assert colour_store.load_store("kimi")[1] == []


def test_a_file_written_before_origins_holds_nothing_hand_set(scratch_stores):
    """An upgrade must not offer an inherited tint for release.

    Both writers predate the marker - the shipped 0.6.x wrote fork tints
    through this same file - so a legacy entry could be either. Guessing
    "hand-set" offers a branch's colour for release and destroys it with no
    undo; guessing "inherited" costs a re-pick on the tab, which the capture
    then records as the user's own.
    """
    path = scratch_stores / "state" / "kimi-colours.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"colours": {PARENT: "sky", CHILD: "sky"}}), encoding="utf-8"
    )
    assert colour_store.load_colours("kimi") == {PARENT: "sky", CHILD: "sky"}
    assert colour_store.load_store("kimi")[1] == []
    # Re-picking the colour on the tab is the way back.
    colour_store.set_colour("kimi", PARENT, "sky")
    assert colour_store.load_store("kimi")[1] == [PARENT]


def test_dropping_a_conversation_drops_its_override_marker():
    colour_store.set_colour("kimi", PARENT, "sky")
    colour_store.drop_colours("kimi", [PARENT])
    assert colour_store.load_store("kimi")[1] == []


# ------------------------------------------------------ an unwritable store


def test_a_colour_that_cannot_be_persisted_is_not_reported_as_stored(monkeypatch):
    """The write-back's answer is what the frontend trusts before it paints.

    Painting a tab makes the companion extension release its own record of the
    user's choice, so a write reported as stored but absent from disk destroys
    the colour. Everywhere else a colour is decoration and a failed write costs
    only the tint - here the colour IS the request.
    """
    monkeypatch.setattr(
        colour_store,
        "write_json_atomic",
        lambda *a, **kw: (_ for _ in ()).throw(OSError("no space")),
    )
    assert colour_store.set_colour("kimi", PARENT, "sky") is False


def test_a_refused_write_says_so_in_the_server_log(monkeypatch, caplog):
    """The errno is the only thing that names the cause.

    The route answers 500 and the panel reports "could not be saved", which is
    true of a full disk, a read-only state directory and a permissions problem
    alike. Swallowed, the one fact that tells them apart never leaves the
    process - and the server log is where an admin looks first.
    """
    monkeypatch.setattr(
        colour_store,
        "write_json_atomic",
        lambda *a, **kw: (_ for _ in ()).throw(OSError("no space")),
    )
    with caplog.at_level("WARNING", logger=colour_store.__name__):
        assert colour_store.set_colour("kimi", PARENT, "sky") is False
    assert "no space" in caplog.text
    # The provider and the file, so a log line identifies which store failed.
    assert "kimi" in caplog.text


@pytest.mark.parametrize("verb", ["POST", "DELETE"])
async def test_the_colour_route_answers_500_when_the_store_cannot_be_written(
    jp_fetch, monkeypatch, verb
):
    """Both writing verbs, since the release trusts the same answer."""
    monkeypatch.setattr(registry.Provider, "cli_path", lambda self: "/usr/bin/x")
    colour_store.set_colour("kimi", PARENT, "mint")
    monkeypatch.setattr(
        colour_store,
        "write_json_atomic",
        lambda *a, **kw: (_ for _ in ()).throw(OSError("no space")),
    )
    body = (
        {"session_id": PARENT, "colour": "rose"}
        if verb == "POST"
        else {"session_ids": [PARENT]}
    )
    with pytest.raises(Exception) as excinfo:
        await jp_fetch(
            "jupyterlab-ai-code-assistants-extension",
            "providers",
            "kimi",
            "colours",
            method=verb,
            body=json.dumps(body),
            allow_nonstandard_methods=True,
        )
    assert excinfo.value.code == 500


async def test_a_malformed_colour_is_a_bad_request_not_a_storage_failure(
    jp_fetch, monkeypatch
):
    """500 means the state dir could not be written - never "you sent junk"."""
    monkeypatch.setattr(registry.Provider, "cli_path", lambda self: "/usr/bin/x")
    with pytest.raises(Exception) as excinfo:
        await jp_fetch(
            "jupyterlab-ai-code-assistants-extension",
            "providers",
            "kimi",
            "colours",
            method="POST",
            body=json.dumps({"session_id": PARENT, "colour": "x" * 200}),
        )
    assert excinfo.value.code == 400


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
