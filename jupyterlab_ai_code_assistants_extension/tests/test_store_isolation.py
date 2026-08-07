"""One provider never reaches another provider's history.

The panels share a core, a state directory and - when a folder is worked in by
two assistants - a project path, so the isolation that keeps a bug in one store
away from another's files is worth asserting directly: a handler handed the
wrong provider's project key must refuse rather than resolve.
"""
from __future__ import annotations

import json

import pytest

from jupyterlab_ai_code_assistants_extension.core import colour_store, state
from jupyterlab_ai_code_assistants_extension.providers.claude import ClaudeStore
from jupyterlab_ai_code_assistants_extension.providers.gemini import GeminiStore
from jupyterlab_ai_code_assistants_extension.providers.kimi import KimiStore

from .conftest import (
    CLAUDE_ENCODED,
    PROJECT_PATH,
    new_uuid,
    write_claude_tree,
    write_gemini_tree,
    write_kimi_tree,
)


KIMI_WD = "wd-1a2b3c"
GEMINI_SHORT_ID = "demo-9f8e7d"


@pytest.fixture
def stores(scratch_stores):
    """One project, three assistants, each with its own store on disk."""
    claude_session = new_uuid()
    kimi_session = f"session_{new_uuid()}"
    gemini_session = new_uuid()
    write_claude_tree(
        scratch_stores / "claude", [{"id": claude_session, "cwd": PROJECT_PATH}]
    )
    write_kimi_tree(scratch_stores / "kimi", KIMI_WD, [{"id": kimi_session}])
    write_gemini_tree(
        scratch_stores / "home" / ".gemini",
        GEMINI_SHORT_ID,
        [{"id": gemini_session}],
    )
    claude = ClaudeStore()
    claude.provider_id = "claude"
    kimi = KimiStore(scratch_stores / "kimi")
    kimi.provider_id = "kimi"
    gemini = GeminiStore()
    gemini.provider_id = "gemini"
    return {
        "claude": (claude, CLAUDE_ENCODED, claude_session),
        "kimi": (kimi, KIMI_WD, kimi_session),
        "gemini": (gemini, GEMINI_SHORT_ID, gemini_session),
    }


def test_each_store_resolves_only_its_own_project_key(stores):
    for name, (store, encoded, session_id) in stores.items():
        assert store.resolve_current(encoded) == session_id, name


@pytest.mark.parametrize(
    "owner,intruder", [("claude", "kimi"), ("kimi", "gemini"), ("gemini", "claude")]
)
def test_another_providers_project_key_resolves_to_nothing(stores, owner, intruder):
    """A key from the wrong store is refused, never resolved across stores."""
    store = stores[owner][0]
    foreign_key = stores[intruder][1]
    assert store.resolve_current(foreign_key) is None
    assert store.list_branches(foreign_key) is None
    assert store.delete_branches(foreign_key, [stores[intruder][2]]) is None


@pytest.mark.parametrize(
    "hostile",
    [
        "..",
        ".",
        "../kimi",
        "../../kimi/sessions",
        "/etc",
        "",
        "a/b",
        "sessions\0",
    ],
)
def test_path_traversal_is_refused_by_every_store(stores, hostile):
    """An ``encoded_path`` arrives from the client and is joined onto a path."""
    for name, (store, _encoded, _session) in stores.items():
        assert store.resolve_current(hostile) is None, f"{name}:{hostile!r}"
        assert store.remove(hostile) is None, f"{name}:{hostile!r}"


def test_a_symlink_out_of_the_store_is_refused(scratch_stores, stores):
    """Resolution happens after symlinks, so a link cannot smuggle a path out."""
    claude, _encoded, _session = stores["claude"]
    projects = scratch_stores / "claude" / "projects"
    (projects / "escape").symlink_to(scratch_stores / "kimi" / "sessions" / KIMI_WD)
    assert claude.resolve_current("escape") is None
    assert claude.remove("escape") is None
    # And the target survived the refusal.
    assert (scratch_stores / "kimi" / "sessions" / KIMI_WD).is_dir()


def test_deleting_through_one_store_leaves_the_others_untouched(stores):
    claude, claude_key, _ = stores["claude"]
    kimi, kimi_key, kimi_session = stores["kimi"]
    assert claude.remove(claude_key) is not None
    assert claude.resolve_current(claude_key) is None
    assert kimi.resolve_current(kimi_key) == kimi_session


def test_favourites_and_pins_are_keyed_by_provider(stores):
    """Two assistants used in one folder keep independent row state."""
    state.toggle_favourite("claude", PROJECT_PATH, True)
    assert state.load_favourites("claude") == [PROJECT_PATH]
    assert state.load_favourites("kimi") == []

    state.write_pin("claude", CLAUDE_ENCODED, "aaaa-1111")
    assert state.read_pin("claude", CLAUDE_ENCODED) == "aaaa-1111"
    assert state.read_pin("kimi", CLAUDE_ENCODED) is None


def test_colours_are_keyed_by_provider(stores):
    session_id = stores["kimi"][2]
    colour_store.set_colour("kimi", session_id, "mint")
    assert colour_store.get_colour("kimi", session_id) == "mint"
    assert colour_store.get_colour("gemini", session_id) is None


def test_state_files_live_outside_every_assistant_store(scratch_stores, stores):
    """Migration reads the assistants' own directories; nothing writes back."""
    state.toggle_favourite("claude", PROJECT_PATH, True)
    colour_store.set_colour("kimi", stores["kimi"][2], "sky")
    written = {p.name for p in (scratch_stores / "state").glob("*.json")}
    assert {"claude.json", "kimi-colours.json"} <= written
    for assistant_root in ("claude", "kimi", "home/.gemini"):
        root = scratch_stores / assistant_root
        assert not list(root.rglob("*claude.json"))
        assert not list(root.rglob("*-colours.json"))


def test_kimi_index_prune_only_touches_its_own_index(scratch_stores, stores):
    """The one index a store rewrites is the assistant's own."""
    kimi, kimi_key, kimi_session = stores["kimi"]
    index = scratch_stores / "kimi" / "session_index.jsonl"
    before = index.read_text(encoding="utf-8")
    assert kimi_session in before
    assert kimi.remove(kimi_key) is not None
    after = index.read_text(encoding="utf-8")
    assert kimi_session not in after
    # Claude's store is untouched by a kimi disposal.
    assert stores["claude"][0].resolve_current(CLAUDE_ENCODED) is not None


def test_a_corrupt_store_file_costs_rows_not_the_panel(scratch_stores, stores):
    """A broken workspaces.json degrades to an empty listing, never an error."""
    (scratch_stores / "kimi" / "workspaces.json").write_text("{ broken", "utf-8")
    assert stores["kimi"][0].list_sessions() == []
    assert stores["claude"][0].list_sessions()


def test_gemini_registry_and_marker_agree_on_one_row(scratch_stores, stores):
    """A project listed by both the registry and its ownership marker is one row.

    The CLI re-points a slug through the markers while migrating legacy hash
    directories, so both maps have to be read - and both being keyed by project
    root is what keeps that from doubling the project up.
    """
    rows = stores["gemini"][0].list_sessions()
    assert [row["project_path"] for row in rows] == [PROJECT_PATH]
    registry_file = scratch_stores / "home" / ".gemini" / "projects.json"
    registry_file.write_text(json.dumps({"projects": {}}), encoding="utf-8")
    # Registry entry gone, marker left: still exactly one row.
    rows = stores["gemini"][0].list_sessions()
    assert [row["encoded_path"] for row in rows] == [GEMINI_SHORT_ID]
