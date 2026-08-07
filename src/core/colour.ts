// Terminal tab tint per conversation.
//
// Effective colour, highest wins:
//   1. user-set     - the write-back store this module keeps, per provider
//   2. native       - the conversation's own colour, when the assistant has one
//   3. derived      - a stable hash of the conversation id
//   4. none         - no tint
//
// Every step of that ladder is pure and exported on its own, because the tint
// is the part of this panel that regressed twice behind a green suite that
// never ran the logic.

import { ServerConnection } from '@jupyterlab/services';

import { requestProvider } from './request';
import { ColourSource, IColourStoreResponse, ISession } from './types';

/** The colour vocabulary of `jupyterlab_colourful_tab_extension`, in its own
 * order - that extension owns the tab CSS and these six ids; this module only
 * feeds it one of them. The order is load-bearing: its localStorage records a
 * user's menu choice as an INDEX into this list. */
export const TAB_COLOUR_IDS: readonly string[] = [
  'rose',
  'peach',
  'lemon',
  'mint',
  'sky',
  'lavender'
];

/** Key `jupyterlab_colourful_tab_extension` persists menu-set tab colours
 * under, and the `terminal:<session name>` shape of its entries. Read only -
 * this module never writes into another extension's storage. */
const TAB_COLOUR_STORAGE_KEY = 'jupyterlab-colourful-tab-colours';

/** Map a conversation id onto one of the six colour ids. FNV-1a (32-bit) - a
 * stable string hash with good avalanche on short hex-ish ids; `Math.imul`
 * keeps the multiplication in 32-bit integer semantics. The same id always
 * yields the same colour, on every reload and in every browser. */
export function fnv1aColour(sessionId: string): string {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return TAB_COLOUR_IDS[(hash >>> 0) % TAB_COLOUR_IDS.length];
}

/** Colour the user set by hand on a terminal tab, or null.
 *
 * The colourful-tab extension stores its right-click menu choices as
 * `{ "terminal:<session name>": <index into TAB_COLOUR_IDS> }`. Reading it is
 * what makes "set the colour on the tab" register as the conversation's
 * colour for assistants whose CLI has no colour concept at all. */
export function readUserSetTabColour(terminalName: string): string | null {
  try {
    const raw = window.localStorage.getItem(TAB_COLOUR_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Record<string, number>;
    const index = parsed[`terminal:${terminalName}`];
    if (typeof index !== 'number') {
      return null;
    }
    return TAB_COLOUR_IDS[index] ?? null;
  } catch (_err) {
    // localStorage unavailable, or another extension's schema changed under
    // us - no user colour is a valid answer, a thrown error is not.
    return null;
  }
}

/** Resolve the ladder for one conversation. `userSet` is this extension's own
 * store, `native` the conversation's own colour (only ever populated by a
 * `native` provider). */
export function effectiveColour(
  sessionId: string | null,
  source: ColourSource,
  userSet: string | null,
  native: string | null | undefined
): string | null {
  if (userSet) {
    return userSet;
  }
  if (source === 'native') {
    return native ?? null;
  }
  if (source === 'derived' && sessionId) {
    return fnv1aColour(sessionId);
  }
  return null;
}

/** Fall back from an unreadable conversation to the project a terminal sits
 * in: longest matching path wins, so a nested project beats its parent.
 * Never the first resort - a row carries only its representative
 * conversation, so resolving colour by row tints every terminal of a project
 * with the representative's colour. */
export function sessionForCwds(
  cwds: string[],
  sessions: ISession[]
): ISession | null {
  let best: ISession | null = null;
  let bestLen = -1;
  for (const raw of cwds) {
    const cwd = raw.replace(/\/+$/, '');
    for (const s of sessions) {
      const p = s.project_path.replace(/\/+$/, '');
      if ((cwd === p || cwd.startsWith(p + '/')) && p.length > bestLen) {
        best = s;
        bestLen = p.length;
      }
    }
  }
  return best;
}

/**
 * Client for one provider's user-set colour store.
 *
 * The store is server-side and per provider (`providers/<id>/colours`), so
 * colours survive a reload and one assistant's colours can never be read or
 * written through another's routes. Reads are cached in memory and refreshed
 * with the session poll; writes go straight through and update the cache.
 */
export class ColourStore {
  constructor(providerId: string, serverSettings: ServerConnection.ISettings) {
    this._providerId = providerId;
    this._serverSettings = serverSettings;
  }

  /** User-set colour for a conversation, from the in-memory cache. */
  get(sessionId: string | null | undefined): string | null {
    if (!sessionId) {
      return null;
    }
    return this._colours.get(sessionId) ?? null;
  }

  /** Reload the whole store. Failures leave the previous cache in place - a
   * momentarily unreachable server must not clear every user colour. */
  async load(): Promise<void> {
    try {
      const data = await requestProvider<IColourStoreResponse>(
        this._providerId,
        'colours',
        this._serverSettings,
        { cache: 'no-store' }
      );
      const next = new Map<string, string>();
      for (const [id, colour] of Object.entries(data.colours ?? {})) {
        if (typeof colour === 'string' && colour) {
          next.set(id, colour);
        }
      }
      this._colours = next;
    } catch (_err) {
      // Keep the cache; the next poll retries.
    }
  }

  /** Record a colour as this conversation's own. Passing null drops the entry,
   * which is also how a deleted conversation leaves no orphan key behind. */
  async set(sessionId: string, colour: string | null): Promise<void> {
    if (!sessionId) {
      return;
    }
    if (colour) {
      this._colours.set(sessionId, colour);
    } else {
      this._colours.delete(sessionId);
    }
    try {
      await requestProvider<IColourStoreResponse>(
        this._providerId,
        'colours',
        this._serverSettings,
        {
          method: 'POST',
          body: JSON.stringify({ session_id: sessionId, colour })
        }
      );
    } catch (_err) {
      // The cache already reflects the intent; the next load reconciles.
    }
  }

  /** Drop stored colours for conversations that no longer exist. */
  async forget(sessionIds: string[]): Promise<void> {
    const present = sessionIds.filter(id => this._colours.has(id));
    if (present.length === 0) {
      return;
    }
    present.forEach(id => this._colours.delete(id));
    try {
      await requestProvider<IColourStoreResponse>(
        this._providerId,
        'colours',
        this._serverSettings,
        {
          method: 'DELETE',
          body: JSON.stringify({ session_ids: present })
        }
      );
    } catch (_err) {
      // Same as `set`: the cache is authoritative until the next load.
    }
  }

  /** Copy the parent's EFFECTIVE colour onto a fresh branch, so a branch of a
   * branch inherits whatever its immediate parent actually shows, user-set
   * override included. Called at the fork sites, once the new id is known. */
  async inherit(parentColour: string | null, childId: string): Promise<void> {
    if (!parentColour || !childId) {
      return;
    }
    await this.set(childId, parentColour);
  }

  private readonly _providerId: string;
  private readonly _serverSettings: ServerConnection.ISettings;
  private _colours: Map<string, string> = new Map();
}
