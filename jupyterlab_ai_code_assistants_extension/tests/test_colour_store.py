"""The write-back colour store and the precedence the core resolves it with.

``colourSource`` decides only the DEFAULT tint. What makes a tab colour
settable for EVERY provider - and durable across a reload - is this store, so its persistence, its precedence and the inheritance
a branch is born with are asserted here rather than left to the UI tier.
"""
from __future__ import annotations

import dataclasses
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from jupyterlab_ai_code_assistants_extension.core import colour_store, registry
from jupyterlab_ai_code_assistants_extension.core.routes import (
    _effective_colour,
    _live_colours,
)
from jupyterlab_ai_code_assistants_extension.core.store import SessionStore
from jupyterlab_ai_code_assistants_extension.providers import claude as claude_provider
from jupyterlab_ai_code_assistants_extension.providers import codex as codex_provider

from .conftest import CLAUDE_ENCODED, PROJECT_PATH, new_uuid, write_codex_db


PARENT = "11111111-1111-4111-8111-111111111111"
CHILD = "22222222-2222-4222-8222-222222222222"
GRANDCHILD = "33333333-3333-4333-8333-333333333333"


class _Store(SessionStore):
    """A store whose only interesting behaviour is its default tint, and when
    its assistant last chose a colour itself."""

    def __init__(
        self, default: str | None = None, choice_ms: int | None = None
    ) -> None:
        self._default = default
        self._choice_ms = choice_ms

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

    def colour_choice_ms(self, session_id):
        return self._choice_ms


def provider(
    colour_source: str, default: str | None = None, choice_ms: int | None = None
) -> registry.Provider:
    descriptor = registry.ProviderDescriptor(
        id=f"p-{colour_source}",
        label=colour_source,
        cli_binary="x",
        capabilities=registry.Capabilities(colour_source=colour_source),
    )
    store = _Store(default, choice_ms)
    store.provider_id = descriptor.id
    return registry.Provider(descriptor, store)


def effective(provider: registry.Provider, session_id: str | None) -> str | None:
    """The precedence ladder as the routes run it.

    Both the conversation's own default and the override map reach
    ``_effective_colour`` from the caller - a row carries the default from the
    store's own listing and the map from one read per listing, a terminal probe
    asks for that one conversation - so the tests hand them over the same way
    rather than having the core re-derive either per call. The map is the
    JUDGED one, as both routes build it: an entry the assistant's own later
    colour choice overtook is not in it.
    """
    default = provider.store.default_colour(session_id) if session_id else None
    live, _stale = _live_colours(provider, [session_id])
    return _effective_colour(session_id, default, live)


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
    """The tab is a control surface even where the CLI has ``/color``.

    Setting a colour on the tab diverges from what the assistant chose on
    purpose. With no later colour choice reported by the assistant, that
    preference is the one kept, and it keeps winning on every subsequent read
    - the newest-wins half for a ``/color`` run after the pick is asserted
    under "newest wins" below.
    """
    native = provider("native", "peach")
    assert effective(native, PARENT) == "peach"
    colour_store.set_colour(native.id, PARENT, "sky")
    assert effective(native, PARENT) == "sky"
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

    This store is the only record of the user's choice, because the companion
    extension persists nothing for a tab another extension has claimed, so a
    write reported as stored but absent from disk destroys the colour.
    Everywhere else a colour is decoration and a failed write costs only the
    tint - here the colour IS the request.
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


# -------------------------------------------------------------- newest wins
#
# Two channels set a Claude tab's colour - ``/color`` in the conversation and a
# pick on the terminal tab - and the newer one wins (DEF-COLO-306). The store
# records when each entry was written; the provider's store reports when
# ``/color`` last ran; the routes release a stored entry the later ``/color``
# overtook.

T0 = 1_790_000_000_000  # 2026-09-21, epoch ms - every time below is relative


def iso(ms: int) -> str:
    """A record ``timestamp`` as Claude writes it."""
    return (
        datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def write_at(monkeypatch, ms: int, session_id: str, colour: str, hand_set=True):
    """A store write made at ``ms``, with no other clock in the process moved."""
    with monkeypatch.context() as patch:
        patch.setattr(colour_store, "time", SimpleNamespace(time=lambda: ms / 1000))
        assert colour_store.set_colour("claude", session_id, colour, hand_set)


def _color_command(ms: int, arg: str, stdout: str) -> list[dict]:
    """The two ``local_command`` records an interactive ``/color <arg>`` writes:
    the command, then its stdout naming the command's ``uuid`` as parent -
    the shape measured with Claude 2.1.301 in a scratch config dir."""
    command_uuid = f"cmd-{ms}-{arg}"
    return [
        {
            "type": "system",
            "subtype": "local_command",
            "uuid": command_uuid,
            "level": "info",
            "timestamp": iso(ms),
            "content": (
                "<command-name>/color</command-name>\n"
                "            <command-message>color</command-message>\n"
                f"            <command-args>{arg}</command-args>"
            ),
        },
        {
            "type": "system",
            "subtype": "local_command",
            "uuid": f"out-{ms}-{arg}",
            "parentUuid": command_uuid,
            "level": "info",
            "timestamp": iso(ms),
            "content": f"<local-command-stdout>{stdout}</local-command-stdout>",
        },
    ]


def color_run(ms: int, colour: str) -> list[dict]:
    """What one accepted ``/color <colour>`` appends, in the order Claude
    appends it: ``agent-color`` first, then the command and its stdout."""
    stdout = (
        "Session color reset to default"
        if colour == "default"
        else f"Session color set to: {colour}"
    )
    return [
        {"type": "agent-color", "agentColor": colour, "sessionId": PARENT},
        *_color_command(ms, colour, stdout),
    ]


def rejected_color_run(ms: int, arg: str) -> list[dict]:
    """What a ``/color`` Claude rejects appends: the same command record and a
    stdout naming the error, and no ``agent-color`` - the colour is unchanged."""
    return _color_command(
        ms,
        arg,
        f'Invalid color "{arg}". Available colors: red, blue, green, yellow, '
        "purple, orange, pink, cyan, default",
    )


def restamp(colour: str) -> dict:
    """The ``agent-color`` record Claude re-appends on later turns - no time."""
    return {"type": "agent-color", "agentColor": colour, "sessionId": PARENT}


def turn(ms: int) -> dict:
    return {"type": "assistant", "cwd": PROJECT_PATH, "timestamp": iso(ms)}


def claude_transcript(scratch, session_id: str, records: list[dict]) -> None:
    folder = scratch / "claude" / claude_provider.PROJECTS_DIRNAME / CLAUDE_ENCODED
    folder.mkdir(parents=True, exist_ok=True)
    lines = [{"type": "user", "cwd": PROJECT_PATH, "timestamp": iso(T0 - 600_000)}]
    lines += records
    (folder / f"{session_id}.jsonl").write_text(
        "".join(json.dumps(line) + "\n" for line in lines), encoding="utf-8"
    )


async def listed_colour(jp_fetch, monkeypatch) -> str | None:
    """The one Claude row's colour, as the sessions listing answers it."""
    monkeypatch.setattr(registry.Provider, "cli_path", lambda self: "/usr/bin/x")
    response = await jp_fetch(
        "jupyterlab-ai-code-assistants-extension", "providers", "claude", "sessions"
    )
    (row,) = json.loads(response.body)["sessions"]
    return row["colour"]


def test_every_write_records_when_it_was_made(monkeypatch, scratch_stores):
    """A hand pick and an inherited entry both carry their time, in the same
    file and the same save as the colour itself."""
    write_at(monkeypatch, T0, PARENT, "sky")
    write_at(monkeypatch, T0 + 5, CHILD, "sky", hand_set=False)
    on_disk = json.loads(
        (scratch_stores / "state" / "claude-colours.json").read_text("utf-8")
    )
    assert on_disk == {
        "colours": {PARENT: "sky", CHILD: "sky"},
        "overrides": [PARENT],
        "stamps": {PARENT: T0, CHILD: T0 + 5},
    }
    # Dropping an entry drops its time too - no orphan keys.
    colour_store.drop_colours("claude", [CHILD])
    colour_store.set_colour("claude", PARENT, None)
    on_disk = json.loads(
        (scratch_stores / "state" / "claude-colours.json").read_text("utf-8")
    )
    assert on_disk["stamps"] == {}


def test_a_file_written_before_times_loads_and_its_entries_count_as_older(
    scratch_stores,
):
    """The old shape - no ``stamps`` - still loads whole, and an entry with no
    time is older than any colour choice the assistant reports (every such
    entry predates the field)."""
    path = scratch_stores / "state" / "claude-colours.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"colours": {PARENT: "sky"}, "overrides": [PARENT]}),
        encoding="utf-8",
    )
    assert colour_store.load_store("claude") == ({PARENT: "sky"}, [PARENT])
    live, stale = colour_store.judge("claude", [PARENT], lambda sid: T0)
    assert live == {}
    assert stale == {PARENT: None}
    # And with no choice reported, the untimed entry stands.
    assert colour_store.judge("claude", [PARENT], lambda sid: None) == (
        {PARENT: "sky"},
        {},
    )


def test_a_pick_rewritten_after_the_judgement_is_not_released(monkeypatch):
    """The judgement runs in the executor and the release on the IOLoop; a pick
    landing between them is the newest choice and must survive the release."""
    write_at(monkeypatch, T0, PARENT, "sky")
    _live, stale = colour_store.judge("claude", [PARENT], lambda sid: T0 + 1000)
    assert stale == {PARENT: T0}
    write_at(monkeypatch, T0 + 2000, PARENT, "rose")
    assert colour_store.release_stale("claude", stale)
    assert colour_store.get_colour("claude", PARENT) == "rose"


def test_claude_reads_when_color_last_ran_from_the_tail(scratch_stores):
    """The newest explicit ``/color`` run's own timestamp."""
    claude_transcript(
        scratch_stores,
        PARENT,
        [turn(T0), *color_run(T0 + 1000, "green"), turn(T0 + 2000),
         *color_run(T0 + 3000, "orange"), turn(T0 + 4000)],
    )
    store = registry.get("claude").store
    assert store.colour_choice_ms(PARENT) == T0 + 3000
    # A conversation with no transcript, and one that never ran ``/color``,
    # report no choice at all.
    assert store.colour_choice_ms(CHILD) is None
    claude_transcript(scratch_stores, CHILD, [turn(T0), restamp("blue")])
    assert store.colour_choice_ms(CHILD) is None


def test_agent_color_restamps_do_not_move_the_choice_time(scratch_stores):
    """Claude re-appends ``agent-color`` on later turns with no time of its own;
    those say what the colour is, never when it was chosen."""
    claude_transcript(
        scratch_stores,
        PARENT,
        [*color_run(T0, "orange"), turn(T0 + 60_000), restamp("orange"),
         turn(T0 + 120_000), restamp("orange")],
    )
    assert registry.get("claude").store.colour_choice_ms(PARENT) == T0


async def test_a_color_run_after_a_pick_takes_over_and_releases_it(
    jp_fetch, monkeypatch, scratch_stores
):
    """The Star Colonel's case: Sky picked on the tab, then ``/color orange``."""
    write_at(monkeypatch, T0, PARENT, "sky")
    claude_transcript(scratch_stores, PARENT, color_run(T0 + 1000, "orange"))
    assert await listed_colour(jp_fetch, monkeypatch) == "peach"
    # Released, not merely outranked: it stays gone once the ``/color`` record
    # has left the readable tail.
    assert colour_store.load_colours("claude") == {}
    claude_transcript(scratch_stores, PARENT, [restamp("orange")])
    assert await listed_colour(jp_fetch, monkeypatch) == "peach"


async def test_the_same_colour_run_again_still_takes_over(
    jp_fetch, monkeypatch, scratch_stores
):
    """``/color`` of the colour the tab wore before the pick is still the newer
    choice - it is the run that counts, not whether the colour changed."""
    claude_transcript(scratch_stores, PARENT, color_run(T0 - 1000, "orange"))
    write_at(monkeypatch, T0, PARENT, "sky")
    claude_transcript(
        scratch_stores,
        PARENT,
        [*color_run(T0 - 1000, "orange"), *color_run(T0 + 1000, "orange")],
    )
    assert await listed_colour(jp_fetch, monkeypatch) == "peach"
    assert colour_store.load_colours("claude") == {}


async def test_a_color_reset_after_a_pick_releases_it(
    jp_fetch, monkeypatch, scratch_stores
):
    """An accepted reset counts; the tab then shows what ``/color`` recorded.
    ``/color default`` records ``agent-color`` ``default`` and answers
    ``Session color reset to default`` (measured in a scratch config dir), and
    ``default`` maps to no tint."""
    write_at(monkeypatch, T0, PARENT, "sky")
    claude_transcript(scratch_stores, PARENT, color_run(T0 + 1000, "default"))
    assert await listed_colour(jp_fetch, monkeypatch) is None
    assert colour_store.load_colours("claude") == {}


async def test_a_rejected_color_run_does_not_release_a_pick(
    jp_fetch, monkeypatch, scratch_stores
):
    """Sky picked on the tab, then ``/color sky`` - a palette name Claude does
    not know. Claude answers ``Invalid color`` and keeps orange, so the pick
    is still the newest colour choice and stands."""
    claude_transcript(scratch_stores, PARENT, color_run(T0 - 1000, "orange"))
    write_at(monkeypatch, T0, PARENT, "sky")
    claude_transcript(
        scratch_stores,
        PARENT,
        [*color_run(T0 - 1000, "orange"), *rejected_color_run(T0 + 1000, "sky")],
    )
    assert registry.get("claude").store.colour_choice_ms(PARENT) == T0 - 1000
    assert await listed_colour(jp_fetch, monkeypatch) == "sky"
    assert colour_store.load_colours("claude") == {PARENT: "sky"}


async def test_an_accepted_color_run_after_a_rejected_one_releases_the_pick(
    jp_fetch, monkeypatch, scratch_stores
):
    """The rejected run is skipped, not a stop: the accepted ``/color blue``
    that follows it is the newest choice and takes over."""
    write_at(monkeypatch, T0, PARENT, "lavender")
    claude_transcript(
        scratch_stores,
        PARENT,
        [*rejected_color_run(T0 + 1000, "sky"), *color_run(T0 + 2000, "blue")],
    )
    assert registry.get("claude").store.colour_choice_ms(PARENT) == T0 + 2000
    assert await listed_colour(jp_fetch, monkeypatch) == "sky"
    assert colour_store.load_colours("claude") == {}


def test_a_stdout_not_answering_a_color_command_is_no_choice(scratch_stores):
    """The acceptance text counts only as the stdout of a ``/color`` command
    record. A print-mode run - what ``fork`` runs in a branch, after the
    parent's interactive runs ``--fork-session`` copied - records its command
    as a ``user`` record, so its stdout answers no ``local_command`` and the
    choice time stays at the copied interactive run."""
    agent_color, command, stdout = color_run(T0 + 1000, "blue")
    print_mode_command = {
        "type": "user",
        "uuid": command["uuid"],
        "timestamp": command["timestamp"],
        "message": {"role": "user", "content": command["content"]},
    }
    claude_transcript(
        scratch_stores,
        PARENT,
        [*color_run(T0, "green"), agent_color, print_mode_command, stdout],
    )
    assert registry.get("claude").store.colour_choice_ms(PARENT) == T0


@pytest.mark.parametrize(
    ("claude_colour", "tab_colour"), [("pink", "rose"), ("cyan", "sky")]
)
async def test_pink_and_cyan_show_their_nearest_palette_colour(
    jp_fetch, monkeypatch, scratch_stores, claude_colour, tab_colour
):
    """Claude accepts pink and cyan; the six-colour palette has neither, so
    they show as rose and sky - on the row and on the terminal probe."""
    write_at(monkeypatch, T0, PARENT, "lemon")
    claude_transcript(scratch_stores, PARENT, color_run(T0 + 1000, claude_colour))
    assert await listed_colour(jp_fetch, monkeypatch) == tab_colour
    assert registry.get("claude").store.default_colour(PARENT) == tab_colour
    assert colour_store.load_colours("claude") == {}


def test_a_fork_maps_rose_and_sky_back_to_red_and_blue():
    """``fork`` runs ``/color`` with the first Claude colour that carries the
    parent's tab id, so pink and cyan must not displace red and blue."""
    first = {}
    for name, tab_id in claude_provider._TAB_COLOUR_ID.items():
        first.setdefault(tab_id, name)
    assert first["rose"] == "red"
    assert first["sky"] == "blue"


async def test_a_pick_after_color_stands(jp_fetch, monkeypatch, scratch_stores):
    claude_transcript(scratch_stores, PARENT, color_run(T0, "orange"))
    write_at(monkeypatch, T0 + 1000, PARENT, "sky")
    assert await listed_colour(jp_fetch, monkeypatch) == "sky"
    assert colour_store.load_colours("claude") == {PARENT: "sky"}


async def test_an_untimed_pick_loses_to_a_color_in_the_tail(
    jp_fetch, monkeypatch, scratch_stores
):
    """The three live Sky entries: written before times were recorded, and
    confirmed to predate their ``/color``."""
    path = scratch_stores / "state" / "claude-colours.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"colours": {PARENT: "sky"}, "overrides": [PARENT]}),
        encoding="utf-8",
    )
    claude_transcript(scratch_stores, PARENT, color_run(T0, "orange"))
    assert await listed_colour(jp_fetch, monkeypatch) == "peach"
    assert colour_store.load_colours("claude") == {}


async def test_a_pick_with_no_color_in_the_tail_stands(
    jp_fetch, monkeypatch, scratch_stores
):
    """No evidence, no release: the ``agent-color`` re-stamp alone says nothing
    about when the colour was chosen."""
    write_at(monkeypatch, T0, PARENT, "sky")
    claude_transcript(
        scratch_stores, PARENT, [restamp("orange"), turn(T0 + 60_000)]
    )
    assert await listed_colour(jp_fetch, monkeypatch) == "sky"
    assert colour_store.load_colours("claude") == {PARENT: "sky"}


async def test_an_inherited_entry_yields_only_to_a_color_run_in_the_branch(
    jp_fetch, monkeypatch, scratch_stores
):
    """An inherited entry is judged like a hand pick: a ``/color`` older than it
    leaves it standing, one run after it wins.

    No provider exercises this today - Claude forks natively and its branch gets
    no store entry at all - so the Claude transcript here only supplies the
    evidence. It pins the store rule for a provider that both inherits entries
    and reports choice times."""
    copied = color_run(T0 - 5000, "green")
    write_at(monkeypatch, T0, PARENT, "sky", hand_set=False)
    claude_transcript(scratch_stores, PARENT, copied)
    assert await listed_colour(jp_fetch, monkeypatch) == "sky"
    claude_transcript(
        scratch_stores, PARENT, [*copied, *color_run(T0 + 1000, "orange")]
    )
    assert await listed_colour(jp_fetch, monkeypatch) == "peach"
    assert colour_store.load_colours("claude") == {}


async def test_the_terminal_probe_judges_its_conversation_too(
    jp_fetch, jp_serverapp, monkeypatch, scratch_stores
):
    """The probe tints a terminal on ANY conversation of a project, including
    one no row represents - so it releases an overtaken pick itself rather
    than wait for a listing that may never judge that conversation."""
    from .test_routes import UNUSED_PID, _FakePty, _FakeTerminalManager

    write_at(monkeypatch, T0, PARENT, "sky")
    claude_transcript(scratch_stores, PARENT, color_run(T0 + 1000, "orange"))
    manager = _FakeTerminalManager()
    manager.terminals["term-known"] = _FakePty(pid=UNUSED_PID)
    monkeypatch.setitem(jp_serverapp.web_app.settings, "terminal_manager", manager)
    monkeypatch.setattr(registry.Provider, "cli_path", lambda self: "/usr/bin/x")
    monkeypatch.setattr(
        claude_provider.ClaudeStore, "owns_pid", lambda self, pid: pid == UNUSED_PID
    )
    monkeypatch.setattr(
        claude_provider.ClaudeStore, "session_id_for_pid", lambda self, pid: PARENT
    )
    answer = json.loads(
        (
            await jp_fetch(
                "jupyterlab-ai-code-assistants-extension",
                "providers",
                "claude",
                "terminal",
                "term-known",
            )
        ).body
    )
    assert answer["colour"] == "peach"
    assert colour_store.load_colours("claude") == {}
