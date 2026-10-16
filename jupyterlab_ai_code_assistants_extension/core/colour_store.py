"""User-set terminal tab colours, per provider, keyed by conversation id.

The descriptor's ``colour_source`` flag decides only the DEFAULT tint - read
from the assistant, derived from the id, or absent. This store is what makes a
tab colour settable at all: a tab recoloured in JupyterLab writes back here,
and the write-back beats the default for EVERY provider. A ``native`` one is
the exception in time only: its assistant has a colour command of its own, so
two channels set the colour and the NEWER one wins (docs/defects.md
DEF-COLO-306). Every entry therefore records when it was written, and
``judge`` sets an entry aside once the assistant reports a colour choice made
after it.

A stored colour has two possible origins, and they are recorded apart because
only one of them is the user's to take back. A HAND-SET colour came from the
tab; an INHERITED one was written at fork time so a branch keeps the colour it
was born with (acc-crit "Branch colour inheritance"). Both outrank the default
identically, so ``load_colours`` answers them together - but the release
affordance offers only the hand-set ones, or clicking it would silently
un-inherit every branch of the project.

One file per provider in the extension's own state directory, so a colour set
against one assistant can never surface on another's row.
"""
from __future__ import annotations

import logging
import time
from collections.abc import Callable, Iterable
from pathlib import Path

from .state import state_dir
from .store import load_json, write_json_atomic


# A colour that could not be persisted is otherwise invisible from the server
# side: the route answers 500 and the panel reports it, but the reason - the
# state directory is unwritable, full, or read-only - only exists in the errno
# swallowed below, which is where an admin looks first.
_log = logging.getLogger(__name__)


# A colour is a token the frontend maps to a tab class; unknown names are
# ignored there rather than rejected here, so a new vocabulary needs no server
# change. The cap only keeps a malformed write from bloating the file.
_MAX_COLOUR_LEN = 64


def _colours_path(provider_id: str) -> Path:
    return state_dir() / f"{provider_id}-colours.json"


def _read(provider_id: str) -> tuple[dict[str, str], set[str], dict[str, int]]:
    """The file's three parts: every colour, the hand-set ids among them, and
    when each was written (epoch ms).

    A file written before origins were recorded has no ``overrides`` key, and
    NOTHING in it counts as hand-set. Both writers predate the distinction -
    ``inherit_colour`` has written fork tints through this same file since the
    first shipped version - so the two are indistinguishable there, and the
    two ways of guessing are not symmetrical: calling an inherited tint
    hand-set offers it for release and destroys a branch's colour with no undo,
    while calling a hand-set one inherited merely withholds the release until
    the user picks a colour on that tab again.

    A file written before times were recorded has no ``stamps`` key, and an
    entry with no time counts as older than any colour choice the assistant
    reports (``judge``) - every such entry predates this field, and the
    alternative keeps a stale pick over a ``/color`` the user ran after it.
    """
    data = load_json(_colours_path(provider_id))
    if not isinstance(data, dict):
        return {}, set(), {}
    raw = data.get("colours")
    if not isinstance(raw, dict):
        return {}, set(), {}
    colours = {
        key: value
        for key, value in raw.items()
        if isinstance(key, str) and key and is_colour(value)
    }
    raw_stamps = data.get("stamps")
    stamps = (
        {
            key: value
            for key, value in raw_stamps.items()
            if key in colours
            and isinstance(value, int)
            and not isinstance(value, bool)
        }
        if isinstance(raw_stamps, dict)
        else {}
    )
    stored = data.get("overrides")
    if not isinstance(stored, list):
        return colours, set(), stamps
    return (
        colours,
        {sid for sid in stored if isinstance(sid, str) and sid in colours},
        stamps,
    )


def load_store(provider_id: str) -> tuple[dict[str, str], list[str]]:
    """Both halves from ONE read - the colours, and the hand-set ids.

    Answered together because two reads of the same file can straddle another
    process's write and answer halves that never coexisted.
    """
    colours, overrides, _stamps = _read(provider_id)
    return colours, sorted(overrides)


def load_colours(provider_id: str) -> dict[str, str]:
    """``{session_id: colour}`` for one provider; empty when unreadable."""
    return _read(provider_id)[0]


def _save(
    provider_id: str,
    colours: dict[str, str],
    overrides: set[str],
    stamps: dict[str, int],
) -> bool:
    """Persist all three parts in one atomic write. Answers whether it landed.

    Callers for whom the colour IS the action report the failure; the ones for
    which it is a side effect of something larger (a fork, a removal) ignore it
    rather than fail the action that triggered the write.
    """
    try:
        write_json_atomic(
            _colours_path(provider_id),
            {
                "colours": colours,
                "overrides": sorted(overrides),
                "stamps": {sid: stamps[sid] for sid in colours if sid in stamps},
            },
        )
    except OSError as err:
        _log.warning(
            "cannot write %s colours to %s: %s",
            provider_id,
            _colours_path(provider_id),
            err,
        )
        return False
    return True


def is_colour(value: object) -> bool:
    """Whether a value is a storable colour token. Public so the route can
    answer a malformed colour with 400 rather than a storage failure."""
    return isinstance(value, str) and bool(value.strip()) and len(value) <= _MAX_COLOUR_LEN


def get_colour(provider_id: str, session_id: str | None) -> str | None:
    """The user-set colour for a conversation, or None."""
    if not session_id:
        return None
    return load_colours(provider_id).get(session_id)


def set_colour(
    provider_id: str, session_id: str, colour: str | None, hand_set: bool = True
) -> bool:
    """Record (or with ``colour`` None, drop) a conversation's colour.

    ``hand_set`` False marks the colour as inherited - written on the
    conversation's behalf at fork time rather than chosen on its tab. Both
    record the time of the write, which is what ``judge`` holds against the
    assistant's own colour choices. Answers whether the store now holds what
    was asked of it.
    """
    if not session_id:
        return False
    colours, overrides, stamps = _read(provider_id)
    if colour is None:
        if colours.pop(session_id, None) is None:
            return True
        overrides.discard(session_id)
        stamps.pop(session_id, None)
    else:
        if not is_colour(colour):
            return False
        colours[session_id] = colour.strip().lower()
        stamps[session_id] = int(time.time() * 1000)
        if hand_set:
            overrides.add(session_id)
        else:
            overrides.discard(session_id)
    return _save(provider_id, colours, overrides, stamps)


def drop_colours(provider_id: str, session_ids: list[str]) -> bool:
    """Forget the colours of deleted conversations, leaving no orphan keys."""
    colours, overrides, stamps = _read(provider_id)
    removed = [sid for sid in session_ids if colours.pop(sid, None) is not None]
    if not removed:
        return True
    overrides.difference_update(removed)
    for sid in removed:
        stamps.pop(sid, None)
    return _save(provider_id, colours, overrides, stamps)


def judge(
    provider_id: str,
    session_ids: Iterable[str | None],
    colour_choice_ms: Callable[[str], int | None],
) -> tuple[dict[str, str], dict[str, int | None]]:
    """The colours that still stand, and the entries a newer choice overtook.

    Two channels set a ``native`` assistant's colour - its own colour command
    and a pick on the tab - and the newer one wins (DEF-COLO-306).
    ``colour_choice_ms`` is the store's ``SessionStore.colour_choice_ms``: when
    the conversation's newest colour command ran, or None. An entry written
    before that time, or with no time at all, is stale; one with no command
    found stands, because a command that left the transcript's readable tail
    is not evidence that none ran - the release is permanent, so it is never
    made on missing evidence.

    Only ``session_ids`` are judged, since each costs the store a transcript
    read. The stale map carries the time each entry was judged with, so
    ``release_stale`` drops only an entry that was not rewritten meanwhile. One
    file read for both answers, so they describe the same moment.
    """
    colours, _overrides, stamps = _read(provider_id)
    stale: dict[str, int | None] = {}
    for sid in dict.fromkeys(session_ids):
        if not sid or sid not in colours:
            continue
        chosen = colour_choice_ms(sid)
        if chosen is None:
            continue
        stamp = stamps.get(sid)
        if stamp is None or stamp < chosen:
            stale[sid] = stamp
    live = {sid: colour for sid, colour in colours.items() if sid not in stale}
    return live, stale


def release_stale(provider_id: str, stale: dict[str, int | None]) -> bool:
    """Drop the entries ``judge`` found stale, unless rewritten since.

    The judgement runs in the executor and this write on the IOLoop, so a pick
    can land between the two; it carries a newer time than the one judged, and
    dropping it would discard the newest choice. Compared entry by entry,
    against the time recorded when it was judged.
    """
    colours, overrides, stamps = _read(provider_id)
    removed = [
        sid
        for sid, judged in stale.items()
        if sid in colours and stamps.get(sid) == judged
    ]
    if not removed:
        return True
    for sid in removed:
        colours.pop(sid, None)
        overrides.discard(sid)
        stamps.pop(sid, None)
    return _save(provider_id, colours, overrides, stamps)


def inherit_colour(
    provider_id: str, parent_id: str, child_id: str, parent_default: str | None
) -> str | None:
    """Give a fresh branch its parent's effective colour, and return it.

    Written at fork time rather than resolved at read time, so the branch keeps
    the colour it was born with even after the parent is recoloured or deleted.
    ``parent_default`` is the parent's tint from its own source (the assistant's
    colour, or the hash of its id); the parent's user-set colour wins over it,
    which is what makes a branch of a branch inherit the override rather than
    the hash (acc-crit "Edge: branch of a branch").
    """
    effective = get_colour(provider_id, parent_id) or parent_default
    if not effective or not child_id:
        return None
    set_colour(provider_id, child_id, effective, hand_set=False)
    return effective
