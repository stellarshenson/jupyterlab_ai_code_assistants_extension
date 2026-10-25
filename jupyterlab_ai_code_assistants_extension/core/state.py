"""Extension-owned per-provider state: favourites and current-conversation pins.

The base extension kept favourites in the assistant's own config root and pins
in the assistant's project directories. Here both live in the extension's own
state directory instead, one file per provider - so migration can read the
assistants' stores without ever writing to them (acc-crit "Session stores
untouched"), and a provider's state is keyed by its id, which is what keeps two
providers sharing a project folder independent (acc-crit "Edge: same project in
two providers").

A pin is the durable answer to "which conversation is this project's current
one". Recency alone is not enough: continuing to work in another conversation
bumps its mtime and would silently drag the row back to it, and a fresh fork is
shadowed by the actively-written parent it branched from. The pin outlives both.
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path

from jupyter_core.paths import jupyter_data_dir

from .store import load_json, write_json_atomic


# A pin that could not be persisted is otherwise invisible: the action that
# triggered the write succeeded, the panel shows the switch, and the only trace
# of why the row snaps back to recency is the errno swallowed below.
_log = logging.getLogger(__name__)


STATE_DIRNAME = "ai-code-assistants"
STATE_DIR_ENV = "JUPYTERLAB_AI_CODE_ASSISTANTS_STATE_DIR"


def state_dir() -> Path:
    """Directory holding the extension's own state files.

    The environment override is what lets the UI suite point every provider at
    a scratch directory, so no test reads or writes a developer's real
    favourites (acc-crit "Isolated session stores").
    """
    override = os.environ.get(STATE_DIR_ENV)
    if override:
        return Path(override).expanduser()
    return Path(jupyter_data_dir()) / STATE_DIRNAME


def _state_path(provider_id: str) -> Path:
    return state_dir() / f"{provider_id}.json"


class Pin(str):
    """A pinned conversation id. ``known`` is every conversation id its
    project held when the pin was written, and ``at`` that time in epoch
    seconds; both are None on a pin an earlier version wrote."""

    known: frozenset[str] | None = None
    at: float | None = None


def load_state(provider_id: str) -> dict:
    """``{"favourites": [<project_path>], "pins": {<encoded_path>: Pin}}``.

    On disk a pin stays a plain id under ``pins``, and its ``known`` and ``at``
    sit under ``pin_snapshots``, so a file an earlier version wrote still loads.
    Unknown or malformed content degrades to empty rather than raising: a
    corrupt sidecar must cost the user their favourites, not their panel.
    """
    data = load_json(_state_path(provider_id))
    favourites: list[str] = []
    pins: dict[str, str] = {}
    if isinstance(data, dict):
        seen: set[str] = set()
        for item in data.get("favourites") or []:
            if isinstance(item, str) and item and item not in seen:
                seen.add(item)
                favourites.append(item)
        raw_pins = data.get("pins")
        snapshots = data.get("pin_snapshots")
        if not isinstance(snapshots, dict):
            snapshots = {}
        if isinstance(raw_pins, dict):
            for key, value in raw_pins.items():
                if isinstance(key, str) and _is_pin(value):
                    pin = pins[key] = Pin(value)
                    snap = snapshots.get(key)
                    if (
                        isinstance(snap, dict)
                        and isinstance(snap.get("ids"), list)
                        and isinstance(snap.get("at"), (int, float))
                    ):
                        pin.known = frozenset(
                            i for i in snap["ids"] if isinstance(i, str)
                        )
                        pin.at = float(snap["at"])
    return {"favourites": favourites, "pins": pins}


def save_state(provider_id: str, state: dict) -> None:
    """Atomically write a provider's state file, pin snapshots included."""
    pins = state.get("pins") or {}
    write_json_atomic(
        _state_path(provider_id),
        {
            "favourites": state.get("favourites") or [],
            "pins": pins,
            "pin_snapshots": {
                key: {"ids": sorted(pin.known), "at": pin.at}
                for key, pin in pins.items()
                if getattr(pin, "known", None) is not None
            },
        },
    )


def load_favourites(provider_id: str) -> list[str]:
    return load_state(provider_id)["favourites"]


def toggle_favourite(
    provider_id: str, project_path: str, favourite: bool
) -> list[str]:
    """Add or remove ``project_path``; returns the new list."""
    state = load_state(provider_id)
    favs = state["favourites"]
    if favourite and project_path not in favs:
        favs.append(project_path)
    elif not favourite and project_path in favs:
        favs.remove(project_path)
    save_state(provider_id, state)
    return favs


def _is_pin(value: object) -> bool:
    """True when ``value`` is safe to hand back as a session id.

    Session ids are alphanumeric with hyphens and underscores - UUID-shaped for
    most assistants, prefixed for the ones that namespace their ids - and a pin
    is read back from a file a store will join onto a path. Restricting the
    charset here - before any caller sees it - means a corrupt or tampered pin
    (a slash, ``..``, a control byte) is ignored and recency resumes, rather
    than reaching a path join. The underscore is part of the set because a
    provider whose ids carry one would otherwise lose every pin silently, and
    it cannot widen the traversal surface: ``/``, ``.`` and NUL stay out.
    """
    return (
        isinstance(value, str)
        and bool(value)
        and all(c.isalnum() or c in "-_" for c in value)
    )


def pick_current(pinned: str | None, activity: dict[str, int]) -> str | None:
    """The project's current conversation among ``activity`` (conversation
    id to ms-epoch of last activity): ``pinned`` when it is still one of
    them, otherwise the most recently active. None for an empty project.

    A conversation missing from the pin's ``known`` was created after the pin
    - a /clear, or one started by hand - and supersedes it (owner ruling
    2026-10-24): the pin stops deciding and the most recently active of ALL
    conversations wins, the meaning ``clear_pin`` gives "supersedes", so a
    return to the clicked conversation takes the row back. A pin without
    ``known`` is honoured as before. A dangling pin is ignored and recency
    resumes. A store whose assistant keeps its own notion of "current"
    resolves that instead and never calls this.
    """
    if not activity:
        return None
    known = getattr(pinned, "known", None)
    fresh = [sid for sid in activity if known is not None and sid not in known]
    if fresh:
        return max(activity, key=activity.__getitem__)
    if pinned in activity:
        return pinned
    return max(activity, key=activity.__getitem__)


def read_pin(provider_id: str, encoded_path: str) -> str | None:
    """The conversation pinned as this project's current one, or None."""
    return load_state(provider_id)["pins"].get(encoded_path)


def write_pin(
    provider_id: str,
    encoded_path: str,
    session_id: str,
    known: list[str] | None = None,
) -> None:
    """Pin ``session_id`` as a project's current conversation.

    ``known`` is every conversation id the project holds now; a conversation
    created later supersedes the pin (``pick_current``).

    Best-effort: pins are written after an irreversible action (a fork, a
    switch), so a failure must leave resolution to fall back to
    recency rather than surface as an error.
    """
    if not encoded_path or not _is_pin(session_id):
        return
    state = load_state(provider_id)
    pin = state["pins"][encoded_path] = Pin(session_id)
    if known is not None:
        pin.known = frozenset(known) | {session_id}
        pin.at = time.time()
    try:
        save_state(provider_id, state)
    except OSError as err:
        _log.warning(
            "cannot write %s pin to %s: %s",
            provider_id,
            _state_path(provider_id),
            err,
        )


def clear_pin(provider_id: str, encoded_path: str) -> None:
    """Drop a project's pin so recency resumes.

    Called when a new conversation starts: it supersedes a prior switch and
    becomes current by recency on its own once it writes. Clearing - rather
    than pinning an id that does not exist yet - avoids a permanently dangling
    pin if the user abandons the session before its first turn.
    """
    state = load_state(provider_id)
    if state["pins"].pop(encoded_path, None) is None:
        return
    try:
        save_state(provider_id, state)
    except OSError as err:
        _log.warning(
            "cannot clear %s pin in %s: %s",
            provider_id,
            _state_path(provider_id),
            err,
        )
