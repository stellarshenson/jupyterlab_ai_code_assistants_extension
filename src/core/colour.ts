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
 * yields the same colour, on every reload and in every browser.
 *
 * Hashed over the id's UTF-8 BYTES, which is what FNV-1a is defined over and
 * what the Python half hashes too. The natural idiom on each side disagrees:
 * `charCodeAt` walks UTF-16 units and Python's `ord` walks code points, so an
 * id outside the BMP hashed differently on the two runtimes - measured, "𝕏id"
 * tinted rose in the browser and peach on the server (DEF-52). Bytes are the
 * one reading both languages spell naturally, so the drift cannot come back
 * the next time somebody rewrites either loop. Every real conversation id is
 * ASCII, where all three readings coincide, so no existing tab changes colour. */
export function fnv1aColour(sessionId: string): string {
  let hash = 0x811c9dc5; // FNV offset basis
  for (const byte of new TextEncoder().encode(sessionId)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return TAB_COLOUR_IDS[(hash >>> 0) % TAB_COLOUR_IDS.length];
}

/** Colour the user set by hand on a terminal tab, or null.
 *
 * The colourful-tab extension stores its right-click menu choices as
 * `{ "terminal:<session name>": <index into TAB_COLOUR_IDS> }`. Reading it is
 * what makes "set the colour on the tab" register as the conversation's
 * colour - for every assistant, including one whose CLI has a colour concept
 * of its own. */
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
 *
 * Every request this store makes is queued behind the last - see `_run`. That
 * one rule is what keeps the class small: with only one of its requests ever on
 * the wire, no answer can be older than something the cache has already taken,
 * so none of the ordering questions this class used to carry can be asked.
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

  /** Whether this conversation's colour is the user's own choice rather than
   * one it inherited at fork time. Only a hand-set colour is offered for
   * release: dropping an inherited one would un-inherit the branch. */
  isOverride(sessionId: string | null | undefined): boolean {
    return !!sessionId && this._overrides.has(sessionId);
  }

  /** Whether a write against this conversation is still unanswered - queued
   * behind an earlier request of this store's, or on the wire.
   *
   * Read by the release affordance - see the filter in `_openContextMenu` for
   * why it must not offer a colour still being written. Counted from the CALL
   * rather than from the moment the request goes out: with the store
   * serialised (DEF-30) a capture can sit in the queue before it is sent, and a
   * release offered in that window is undone by the capture landing after it.
   *
   * Not consulted by the capture gate - the cache holds only confirmed values,
   * so reading it is already the confirmation. */
  isPending(sessionId: string | null | undefined): boolean {
    return !!sessionId && (this._pending.get(sessionId) ?? 0) > 0;
  }

  /** Reload the whole store. Failures leave the previous cache in place - a
   * momentarily unreachable server must not clear every user colour.
   *
   * The answer is taken whole. It is the only answer whose snapshot the caller
   * ordered, and nothing this store wrote can be missing from it: the GET is
   * not sent until every earlier write of this store's has been answered. */
  async load(): Promise<void> {
    return this._run(async () => {
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
        // A store with no hand-set ids named predates the distinction, and
        // nothing in it counts as hand-set - `colour_store._read` carries the
        // asymmetry argument for that choice.
        this._overrides = new Set(
          (data.overrides ?? []).filter(id => next.has(id))
        );
        this._colours = next;
      } catch (_err) {
        // Keep the cache; the next poll retries.
      }
    });
  }

  /** Queue one request behind every request this store has already issued, and
   * answer what it answers.
   *
   * This is the store's entire ordering discipline (DEF-30). Only one of its
   * requests is ever on the wire, so an answer can never describe a moment
   * older than one the cache has already taken. The monotonic write counter,
   * the per-id record of the latest write and the reload generation that used
   * to live here could only ever describe interleavings that are now
   * unconstructible.
   *
   * A failed request must not poison the queue - one refused write stopping
   * every later load, capture and release for the rest of the session is the
   * same defect this change removes, relocated. Two things hold that, and only
   * the first is reachable by test: each op catches its own failure and answers
   * false, so no link rejects today; and the tail waits for SETTLEMENT rather
   * than success, so `_chain` still cannot reject if a later edit puts throwing
   * code outside an op's own `try` - `forget`'s filter already sits there.
   *
   * `requestAPI` bounds every request at `REQUEST_TIMEOUT_MS` (DEF-72), so a
   * queued op waits a bounded time even against a server that never answers.
   * The ceiling is per request, so K ops queued behind a dead server wait K
   * times it, not it.
   *
   * An op must never call `load`, `set` or `forget` - it would wait on a chain
   * that is waiting on it. `inherit` delegates to `set` from OUTSIDE the queue,
   * which is why it is not itself queued. */
  private _run<T>(op: () => Promise<T>): Promise<T> {
    const result = this._chain.then(op);
    const settled = () => undefined;
    this._chain = result.then(settled, settled);
    return result;
  }

  /** Open a write against one or more ids. Counted, not flagged: two writes to
   * one id can be queued at once, and a flag would let the first to settle
   * clear the second's guard. */
  private _openWrite(ids: string[]): void {
    for (const id of ids) {
      this._pending.set(id, (this._pending.get(id) ?? 0) + 1);
    }
  }

  /** Close it. */
  private _closeWrite(ids: string[]): void {
    for (const id of ids) {
      const open = (this._pending.get(id) ?? 1) - 1;
      if (open > 0) {
        this._pending.set(id, open);
      } else {
        this._pending.delete(id);
      }
    }
  }

  /** Record a colour as this conversation's own. Passing null drops the entry,
   * which is also how a deleted conversation leaves no orphan key behind.
   * `handSet` false marks it inherited - written on a fork's behalf rather
   * than chosen on its tab.
   *
   * Answers whether the store now HOLDS the colour, which is what
   * `reconcileColours` gates its paint on.
   *
   * The cache is written only once the server has confirmed. Writing it
   * eagerly and undoing that on failure looks cheaper and is not: nothing here
   * reads the cache before this promise settles, while an unconfirmed entry is
   * indistinguishable from a stored one to every reader - which is exactly the
   * mistake the gate above exists to catch.
   *
   * "Did not throw" is not the test - the answer carries the whole store, so
   * it is checked for the value that was just written. A server that accepted
   * the request and then failed to persist it would otherwise be believed. */
  async set(
    sessionId: string,
    colour: string | null,
    handSet = true
  ): Promise<boolean> {
    if (!sessionId) {
      return false;
    }
    const ids = [sessionId];
    // Marked before the op is queued, not inside it - the queue window is part
    // of the window in which no release may be offered. See `isPending`.
    this._openWrite(ids);
    return this._run(async () => {
      try {
        const data = await requestProvider<IColourStoreResponse>(
          this._providerId,
          'colours',
          this._serverSettings,
          {
            method: 'POST',
            body: JSON.stringify({
              session_id: sessionId,
              colour,
              hand_set: handSet
            })
          }
        );
        if ((data.colours ?? {})[sessionId] !== (colour ?? undefined)) {
          return false;
        }
        // Only this conversation's entry is taken from the answer. The rest of
        // the map is a snapshot of a moment this caller did not order, and a
        // reload is how the caller orders one.
        if (colour) {
          this._colours.set(sessionId, colour);
        } else {
          this._colours.delete(sessionId);
        }
        this._overrides.delete(sessionId);
        if (colour && handSet) {
          this._overrides.add(sessionId);
        }
        return true;
      } catch (_err) {
        return false;
      } finally {
        this._closeWrite(ids);
      }
    });
  }

  /** Drop stored colours - conversations that no longer exist, or overrides
   * the user released. One request for the whole list, so a release is never
   * left half applied. Same contract as `set`: the answer is checked for the
   * absence of every id, and the cache is touched only once it agrees. */
  async forget(sessionIds: string[]): Promise<boolean> {
    return this._run(async () => {
      // Filtered INSIDE the op, not at the call: a capture queued ahead of this
      // release has landed by the time this runs, so the cache is the current
      // answer to "does the store hold one". `isPending` still counts, but only
      // for a write queued BEHIND this release - that id is in no cache yet and
      // would otherwise be left out of a request that is going out anyway.
      const present = sessionIds.filter(
        id => this._colours.has(id) || this.isPending(id)
      );
      if (present.length === 0) {
        return true;
      }
      this._openWrite(present);
      try {
        const data = await requestProvider<IColourStoreResponse>(
          this._providerId,
          'colours',
          this._serverSettings,
          {
            method: 'DELETE',
            body: JSON.stringify({ session_ids: present })
          }
        );
        if (present.some(id => (data.colours ?? {})[id] !== undefined)) {
          return false;
        }
        for (const id of present) {
          this._colours.delete(id);
          this._overrides.delete(id);
        }
        return true;
      } catch (_err) {
        return false;
      } finally {
        this._closeWrite(present);
      }
    });
  }

  /** Copy the parent's EFFECTIVE colour onto a fresh branch, so a branch of a
   * branch inherits whatever its immediate parent actually shows, user-set
   * override included. Called at the fork sites, once the new id is known.
   */
  async inherit(parentColour: string | null, childId: string): Promise<void> {
    if (!parentColour || !childId) {
      return;
    }
    await this.set(childId, parentColour, false);
  }

  private readonly _providerId: string;
  private readonly _serverSettings: ServerConnection.ISettings;
  private _colours: Map<string, string> = new Map();
  private _overrides: Set<string> = new Set();
  /** Unanswered writes per id, counted from the call. Read by the release
   * affordance, which must not offer a colour still being written. */
  private _pending: Map<string, number> = new Map();
  /** Tail of this store's request queue - see `_run`. Never rejects. */
  private _chain: Promise<void> = Promise.resolve();
}
