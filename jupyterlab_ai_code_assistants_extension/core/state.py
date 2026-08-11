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


def load_state(provider_id: str) -> dict:
    """``{"favourites": [<project_path>], "pins": {<encoded_path>: <id>}}``.

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
        if isinstance(raw_pins, dict):
            for key, value in raw_pins.items():
                if isinstance(key, str) and _is_pin(value):
                    pins[key] = value
    return {"favourites": favourites, "pins": pins}


def save_state(provider_id: str, state: dict) -> None:
    """Atomically write a provider's state file."""
    write_json_atomic(
        _state_path(provider_id),
        {
            "favourites": state.get("favourites") or [],
            "pins": state.get("pins") or {},
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


def read_pin(provider_id: str, encoded_path: str) -> str | None:
    """The conversation pinned as this project's current one, or None."""
    return load_state(provider_id)["pins"].get(encoded_path)


def write_pin(provider_id: str, encoded_path: str, session_id: str) -> None:
    """Pin ``session_id`` as a project's current conversation.

    Best-effort: pins are written after an irreversible action (a fork, a
    spawned terminal), so a failure must leave resolution to fall back to
    recency rather than surface as an error.
    """
    if not encoded_path or not _is_pin(session_id):
        return
    state = load_state(provider_id)
    state["pins"][encoded_path] = session_id
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
