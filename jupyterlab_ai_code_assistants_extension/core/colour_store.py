"""User-set terminal tab colours, per provider, keyed by conversation id.

The descriptor's ``colour_source`` flag decides only the DEFAULT tint - read
from the assistant, derived from the id, or absent. This store is what makes a
colour settable at all on an assistant whose CLI has no colour concept: a tab
recoloured in JupyterLab writes back here, and the write-back beats the default
everywhere except a ``native`` provider, where the assistant owns its own
colour (acc-crit "Override precedence").

One file per provider in the extension's own state directory, so a colour set
against one assistant can never surface on another's row.
"""
from __future__ import annotations

from pathlib import Path

from .state import state_dir
from .store import load_json, write_json_atomic


# A colour is a token the frontend maps to a tab class; unknown names are
# ignored there rather than rejected here, so a new vocabulary needs no server
# change. The cap only keeps a malformed write from bloating the file.
_MAX_COLOUR_LEN = 64


def _colours_path(provider_id: str) -> Path:
    return state_dir() / f"{provider_id}-colours.json"


def load_colours(provider_id: str) -> dict[str, str]:
    """``{session_id: colour}`` for one provider; empty when unreadable."""
    data = load_json(_colours_path(provider_id))
    if not isinstance(data, dict):
        return {}
    raw = data.get("colours")
    if not isinstance(raw, dict):
        return {}
    return {
        key: value
        for key, value in raw.items()
        if isinstance(key, str) and key and _is_colour(value)
    }


def _save(provider_id: str, colours: dict[str, str]) -> None:
    try:
        write_json_atomic(_colours_path(provider_id), {"colours": colours})
    except OSError:
        # Colour is decoration: a state directory that cannot be written must
        # cost the tint, never the action that triggered the write.
        pass


def _is_colour(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= _MAX_COLOUR_LEN


def get_colour(provider_id: str, session_id: str | None) -> str | None:
    """The user-set colour for a conversation, or None."""
    if not session_id:
        return None
    return load_colours(provider_id).get(session_id)


def set_colour(provider_id: str, session_id: str, colour: str | None) -> None:
    """Record (or with ``colour`` None, drop) a conversation's colour."""
    if not session_id:
        return
    colours = load_colours(provider_id)
    if colour is None:
        if colours.pop(session_id, None) is None:
            return
    else:
        if not _is_colour(colour):
            return
        colours[session_id] = colour.strip().lower()
    _save(provider_id, colours)


def drop_colours(provider_id: str, session_ids: list[str]) -> None:
    """Forget the colours of deleted conversations, leaving no orphan keys."""
    colours = load_colours(provider_id)
    removed = [sid for sid in session_ids if colours.pop(sid, None) is not None]
    if removed:
        _save(provider_id, colours)


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
    set_colour(provider_id, child_id, effective)
    return effective
