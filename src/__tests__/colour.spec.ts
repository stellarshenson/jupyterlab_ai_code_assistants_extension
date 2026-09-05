/**
 * The colour ladder, and the write-back store under it.
 *
 * The hazard every `ColourStore` case below turns on: a claimed tab is the one
 * store the user's choice has, because the companion extension persists
 * nothing for a tab this extension has claimed. So the answer these
 * cases assert is what decides whether a choice survives at all -
 * `TerminalManager` gates its repaint on it, and `_captureColour` paints
 * nothing when the write is refused.
 *
 * Highest wins: a user-set colour, then the conversation's own colour for a
 * `native` assistant, then the derived hash, then nothing. Each step is a pure
 * function precisely so this can be asserted without a panel - the tint is the
 * part that regressed twice behind a green suite that never ran the logic.
 */

import {
  ColourStore,
  TAB_COLOUR_IDS,
  effectiveColour,
  fnv1aColour,
  sessionForCwds
} from '../core/colour';
import { readFileSync } from 'fs';
import { join } from 'path';

import { requestProvider } from '../core/request';
import { ISession } from '../core/types';

jest.mock('../core/request', () => ({ requestProvider: jest.fn() }));

const request = requestProvider as jest.MockedFunction<typeof requestProvider>;

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

function session(projectPath: string, id: string): ISession {
  return {
    project_path: projectPath,
    encoded_path: projectPath,
    session_id: id,
    name: projectPath,
    name_source: 'basename',
    message_count: 0,
    file_mtime: 0,
    git_branch: null,
    favourite: false,
    extra_sessions: 0
  };
}

describe('fnv1aColour', () => {
  it('answers one of the six tab colours', () => {
    expect(TAB_COLOUR_IDS).toHaveLength(6);
    expect(TAB_COLOUR_IDS).toContain(fnv1aColour(SESSION_A));
  });

  it('is stable for the same conversation', () => {
    expect(fnv1aColour(SESSION_A)).toEqual(fnv1aColour(SESSION_A));
  });

  it('spreads across the vocabulary rather than answering one colour', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(fnv1aColour(`session_${i}-abc`));
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('agrees with the server hash, id for id', () => {
    // Hard-coded from the Python `derived_colour` of the same ids: both sides
    // hash the same string over the same six-colour order, so a conversation
    // tints identically whichever one resolved it. A drift in either
    // implementation - or in the order below - fails here.
    expect(TAB_COLOUR_IDS).toEqual([
      'rose',
      'peach',
      'lemon',
      'mint',
      'sky',
      'lavender'
    ]);
    expect(fnv1aColour(SESSION_A)).toEqual('peach');
    expect(fnv1aColour(SESSION_B)).toEqual('lavender');
    expect(fnv1aColour('session_demo')).toEqual('peach');
  });
});

describe('effectiveColour', () => {
  it('lets a user-set colour beat every default', () => {
    expect(effectiveColour(SESSION_A, 'native', 'sky', 'peach')).toEqual('sky');
    expect(effectiveColour(SESSION_A, 'derived', 'sky', null)).toEqual('sky');
    expect(effectiveColour(SESSION_A, 'none', 'sky', null)).toEqual('sky');
  });

  it('takes the assistant own colour for a native source', () => {
    expect(effectiveColour(SESSION_A, 'native', null, 'peach')).toEqual(
      'peach'
    );
    // A native provider with no colour recorded stays untinted - it must never
    // fall through to the hash, which is another assistant's default.
    expect(effectiveColour(SESSION_A, 'native', null, null)).toBeNull();
  });

  it('derives from the conversation id for a derived source', () => {
    expect(effectiveColour(SESSION_A, 'derived', null, null)).toEqual(
      fnv1aColour(SESSION_A)
    );
  });

  it('answers nothing for a colourless source', () => {
    expect(effectiveColour(SESSION_A, 'none', null, null)).toBeNull();
  });

  it('answers nothing without a conversation', () => {
    expect(effectiveColour(null, 'derived', null, null)).toBeNull();
    expect(effectiveColour(null, 'none', null, null)).toBeNull();
  });
});

describe('ColourStore.set', () => {
  // The write-back is what a hand-set colour hangs on, and its answer decides
  // whether the tab is repainted.
  const store = () => new ColourStore('claude', {} as any);
  /** The store as the routes answer it - all three verbs return the whole
   * map plus the hand-set ids among them. */
  const answers = (
    colours: Record<string, string>,
    overrides = Object.keys(colours)
  ) => request.mockResolvedValue({ colours, overrides } as any);

  beforeEach(() => request.mockReset());

  it('reports the write and caches it', async () => {
    answers({ [SESSION_A]: 'sky' });
    const colours = store();
    expect(await colours.set(SESSION_A, 'sky')).toBe(true);
    expect(colours.get(SESSION_A)).toEqual('sky');
    expect(colours.isOverride(SESSION_A)).toBe(true);
  });

  it('treats an answer that does not hold the colour as a failed write', async () => {
    // The server took the request and could not persist it. "Did not throw" is
    const colours = store();
    answers({ [SESSION_A]: 'sky' });
    await colours.set(SESSION_A, 'sky');

    answers({});
    expect(await colours.set(SESSION_A, 'mint')).toBe(false);
    expect(colours.get(SESSION_A)).toEqual('sky');
  });

  it('keeps the last confirmed colour when the server refuses, and says so', async () => {
    const colours = store();
    answers({ [SESSION_A]: 'sky' });
    await colours.set(SESSION_A, 'sky');

    request.mockRejectedValue(new Error('refused'));
    expect(await colours.set(SESSION_A, 'mint')).toBe(false);
    // Not 'mint': a cache holding a value the server never took would report
    // "already stored" on the next pass and let the paint through.
    expect(colours.get(SESSION_A)).toEqual('sky');
  });

  it('leaves nothing behind when a first write fails', async () => {
    const colours = store();
    request.mockRejectedValue(new Error('refused'));
    expect(await colours.set(SESSION_A, 'sky')).toBe(false);
    expect(colours.get(SESSION_A)).toBeNull();
  });

  it('keeps a released colour when the release fails', async () => {
    const colours = store();
    answers({ [SESSION_A]: 'sky' });
    await colours.set(SESSION_A, 'sky');

    request.mockRejectedValue(new Error('refused'));
    expect(await colours.set(SESSION_A, null)).toBe(false);
    expect(colours.get(SESSION_A)).toEqual('sky');
    expect(colours.isOverride(SESSION_A)).toBe(true);
  });

  it('refuses a write with no conversation rather than guessing one', async () => {
    expect(await store().set('', 'sky')).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('ColourStore origins', () => {
  // A stored colour is either the user's own choice or one a fork inherited.
  // Both beat the default; only the first is offered for release, or one click
  // would scatter every branch of a project to an unrelated colour.
  const store = () => new ColourStore('claude', {} as any);

  beforeEach(() => request.mockReset());

  it('does not count an inherited tint as the user own', async () => {
    const colours = store();
    request.mockResolvedValue({
      colours: { [SESSION_B]: 'sky' },
      overrides: []
    } as any);
    await colours.inherit('sky', SESSION_B);
    expect(colours.get(SESSION_B)).toEqual('sky');
    expect(colours.isOverride(SESSION_B)).toBe(false);
  });

  it('treats a store with no origins recorded as holding none', async () => {
    // Both writers predate the marker, so a legacy entry could be either. The
    // wrong guesses are not symmetrical: offering an inherited tint for
    // release destroys a branch's colour with no undo, while withholding the
    // release costs one re-pick on the tab.
    const colours = store();
    request.mockResolvedValue({ colours: { [SESSION_A]: 'mint' } } as any);
    await colours.load();
    expect(colours.get(SESSION_A)).toEqual('mint');
    expect(colours.isOverride(SESSION_A)).toBe(false);
  });

  it('does not let one write take another answer whole', async () => {
    // Every answer carries the WHOLE store as of the moment the server handled
    // that one write - a moment this caller did not order. Taking it whole
    // would let a POST whose answer happens not to carry another
    // conversation's colour drop that colour from the cache while the server
    // still holds it, and the cache is what the next pass paints that
    // conversation's tab from.
    const colours = store();
    request.mockResolvedValueOnce({
      colours: { [SESSION_A]: 'sky' },
      overrides: [SESSION_A]
    } as any);
    expect(await colours.set(SESSION_A, 'sky')).toBe(true);

    request.mockResolvedValueOnce({
      colours: { [SESSION_B]: 'mint' },
      overrides: [SESSION_B]
    } as any);
    expect(await colours.set(SESSION_B, 'mint')).toBe(true);

    expect(colours.get(SESSION_A)).toEqual('sky');
    expect(colours.isOverride(SESSION_A)).toBe(true);
    expect(colours.get(SESSION_B)).toEqual('mint');
    expect(colours.isOverride(SESSION_B)).toBe(true);
  });

  it('does not roll a concurrent write back when one write fails', async () => {
    // Two terminals capture at once - one reconcile pass fans out per widget.
    // Both are queued now rather than in flight together (DEF-30), which makes
    // this the queue's own guard as well: the first link rejects, and the one
    // behind it must still run. A chain that carried the rejection forward
    // would stop every later colour request for the session.
    const colours = store();
    let failA = (_: any) => undefined as void;
    let landB = (_: any) => undefined as void;
    request.mockReturnValueOnce(
      new Promise((_resolve, reject) => (failA = reject)) as any
    );
    request.mockReturnValueOnce(
      new Promise(resolve => (landB = resolve)) as any
    );

    const first = colours.set(SESSION_A, 'sky');
    const second = colours.set(SESSION_B, 'mint');
    landB({
      colours: { [SESSION_A]: 'sky', [SESSION_B]: 'mint' },
      overrides: [SESSION_A, SESSION_B]
    });
    failA(new Error('refused'));
    expect(await Promise.all([first, second])).toEqual([false, true]);

    expect(colours.get(SESSION_A)).toBeNull();
    expect(colours.get(SESSION_B)).toEqual('mint');
    expect(colours.isOverride(SESSION_B)).toBe(true);
  });

  it('does not put a reload on the wire while a write is unanswered', async () => {
    // The one property every deleted stamp used to police (DEF-30): a GET can
    // no longer be answered from a snapshot that predates a write, because it
    // is not sent until that write has been answered and taken. Assert the
    // mechanism directly - the interleavings it rules out cannot be written as
    // tests any more, since the request they turn on never goes out.
    const colours = store();
    let land = (_: any) => undefined as void;
    request.mockReturnValueOnce(
      new Promise(resolve => (land = resolve)) as any
    );
    const writing = colours.set(SESSION_A, 'sky');
    const reloading = colours.load();
    // A macrotask, so every microtask the two calls queued has run.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(request).toHaveBeenCalledTimes(1);
    expect((request.mock.calls[0][3] as any).method).toEqual('POST');

    request.mockResolvedValueOnce({
      colours: { [SESSION_A]: 'sky' },
      overrides: [SESSION_A]
    } as any);
    land({ colours: { [SESSION_A]: 'sky' }, overrides: [SESSION_A] });
    expect(await writing).toBe(true);
    await reloading;

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][3]).toEqual({ cache: 'no-store' });
    expect(colours.get(SESSION_A)).toEqual('sky');
    expect(colours.isOverride(SESSION_A)).toBe(true);
  });

  it('puts nothing in the cache before the server has taken it', async () => {
    // The capture gate reads the cache to decide whether the store is holding
    // a colour, and paints on the strength of it - and this store is the only
    // record there is, because the companion extension persists nothing for a
    // tab this extension has claimed. An entry that is merely hoped for is
    // indistinguishable from a stored one to every reader.
    const colours = store();
    let land = (_: any) => undefined as void;
    request.mockReturnValueOnce(
      new Promise(resolve => (land = resolve)) as any
    );
    const writing = colours.set(SESSION_A, 'sky');

    expect(colours.get(SESSION_A)).toBeNull();
    expect(colours.isOverride(SESSION_A)).toBe(false);

    land({ colours: { [SESSION_A]: 'sky' }, overrides: [SESSION_A] });
    await writing;
    expect(colours.get(SESSION_A)).toEqual('sky');
    expect(colours.isOverride(SESSION_A)).toBe(true);
  });

  it('takes the later of two overlapping reloads', async () => {
    // Two polls overlapping. Nothing compares reload generations any more: the
    // second GET is not sent until the first has been answered and absorbed, so
    // the last answer to arrive is always the newest. Written the way that
    // FAILS without the queue - unserialised, both GETs go out at once, the
    // already-resolved second answer absorbs first and the empty first answer
    // lands on top of it.
    const colours = store();
    let answerFirst = (_: any) => undefined as void;
    request.mockReturnValueOnce(
      new Promise(resolve => (answerFirst = resolve)) as any
    );
    request.mockResolvedValueOnce({
      colours: { [SESSION_A]: 'sky' },
      overrides: [SESSION_A]
    } as any);

    const first = colours.load();
    const second = colours.load();
    answerFirst({ colours: {}, overrides: [] });
    await Promise.all([first, second]);

    expect(colours.get(SESSION_A)).toEqual('sky');
    expect(colours.isOverride(SESSION_A)).toBe(true);
  });

  it('reports a write as pending so the release is not offered under it', async () => {
    // `isOverride` answers from the last CONFIRMED colour, so a capture that
    // REPLACES one leaves it true. A release issued in that window is undone -
    // by the capture landing after it, or by the reconcile the release runs.
    const colours = store();
    request.mockResolvedValueOnce({
      colours: { [SESSION_A]: 'rose' },
      overrides: [SESSION_A]
    } as any);
    await colours.set(SESSION_A, 'rose');

    let land = (_: any) => undefined as void;
    request.mockReturnValueOnce(
      new Promise(resolve => (land = resolve)) as any
    );
    const capturing = colours.set(SESSION_A, 'sky');
    expect(colours.isOverride(SESSION_A)).toBe(true);
    expect(colours.isPending(SESSION_A)).toBe(true);

    land({ colours: { [SESSION_A]: 'sky' }, overrides: [SESSION_A] });
    await capturing;
    expect(colours.isPending(SESSION_A)).toBe(false);
  });

  it('reports a write as pending before it goes out', async () => {
    // A write is marked at the CALL, not when its request is sent, because
    // serialising the store put a queue in front of every write (DEF-30). A
    // release offered during that window is undone by the capture landing
    // after it, which is the whole reason the affordance consults this.
    const colours = store();
    let land = (_: any) => undefined as void;
    request.mockReturnValueOnce(
      new Promise(resolve => (land = resolve)) as any
    );
    const reloading = colours.load(); // holds the queue
    const capturing = colours.set(SESSION_A, 'sky');
    expect(colours.isPending(SESSION_A)).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(request).toHaveBeenCalledTimes(1); // the GET only
    expect(colours.isPending(SESSION_A)).toBe(true);

    request.mockResolvedValueOnce({
      colours: { [SESSION_A]: 'sky' },
      overrides: [SESSION_A]
    } as any);
    land({ colours: {}, overrides: [] });
    await reloading;
    expect(await capturing).toBe(true);
    expect(colours.isPending(SESSION_A)).toBe(false);
  });

  it('releases an id whose write is queued behind it', async () => {
    // A conversation deleted while a colour for it is being captured, with the
    // capture queued behind the release. Its id is in no cache the filter can
    // read, so `isPending` is the only thing that puts it in the request -
    // without it the release is a no-op and the capture lands a colour keyed to
    // a conversation that no longer exists.
    const colours = store();
    request.mockResolvedValueOnce({ colours: {}, overrides: [] } as any);
    request.mockResolvedValueOnce({
      colours: { [SESSION_B]: 'mint' },
      overrides: [SESSION_B]
    } as any);

    // Same synchronous block on purpose: no queued op runs before the next
    // statement, so the release is filtered while the capture is still waiting.
    const releasing = colours.forget([SESSION_B]);
    const capturing = colours.set(SESSION_B, 'mint');
    expect(await releasing).toBe(true);
    await capturing;

    expect(request).toHaveBeenCalledTimes(2);
    expect((request.mock.calls[0][3] as any).method).toEqual('DELETE');
    expect(JSON.parse((request.mock.calls[0][3] as any).body)).toEqual({
      session_ids: [SESSION_B]
    });
  });

  it('releases a colour a reload queued ahead of it is about to bring in', async () => {
    // The panel deletes conversations while the poll is reloading the store.
    // The release is filtered INSIDE its own queued op, so it sees the cache
    // the reload ahead of it left. Filtering at the CALL would read the cache
    // one request too early - nothing held, nothing pending - and send no
    // DELETE at all, leaving a colour keyed to a conversation that is gone.
    const colours = store();
    request.mockResolvedValueOnce({
      colours: { [SESSION_B]: 'mint' },
      overrides: [SESSION_B]
    } as any);
    request.mockResolvedValueOnce({ colours: {}, overrides: [] } as any);

    const reloading = colours.load();
    const releasing = colours.forget([SESSION_B]);
    await reloading;
    expect(await releasing).toBe(true);

    expect(request).toHaveBeenCalledTimes(2);
    expect((request.mock.calls[1][3] as any).method).toEqual('DELETE');
    expect(colours.get(SESSION_B)).toBeNull();
  });

  it('releases a whole set in one request, or none of it', async () => {
    const colours = store();
    request.mockResolvedValue({
      colours: { [SESSION_A]: 'sky', [SESSION_B]: 'mint' },
      overrides: [SESSION_A, SESSION_B]
    } as any);
    await colours.load();

    request.mockReset();
    request.mockResolvedValue({ colours: {}, overrides: [] } as any);
    expect(await colours.forget([SESSION_A, SESSION_B])).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(colours.get(SESSION_A)).toBeNull();
    expect(colours.get(SESSION_B)).toBeNull();
  });

  it('keeps every colour when a release is not carried out', async () => {
    const colours = store();
    request.mockResolvedValue({
      colours: { [SESSION_A]: 'sky', [SESSION_B]: 'mint' },
      overrides: [SESSION_A, SESSION_B]
    } as any);
    await colours.load();

    // The answer still holds one of them: a half-applied release must not be
    // reported as done, or the panel refreshes over its own error.
    request.mockResolvedValue({
      colours: { [SESSION_B]: 'mint' },
      overrides: [SESSION_B]
    } as any);
    expect(await colours.forget([SESSION_A, SESSION_B])).toBe(false);
    expect(colours.get(SESSION_A)).toEqual('sky');
    expect(colours.get(SESSION_B)).toEqual('mint');
  });
});

describe('sessionForCwds', () => {
  const parent = session('/home/lab/projects', SESSION_A);
  const nested = session('/home/lab/projects/demo', SESSION_B);

  it('lets the nested project win over its parent', () => {
    expect(
      sessionForCwds(['/home/lab/projects/demo'], [parent, nested])
    ).toEqual(nested);
  });

  it('matches a subdirectory of a project', () => {
    expect(
      sessionForCwds(['/home/lab/projects/demo/src'], [parent, nested])
    ).toEqual(nested);
  });

  it('does not match a sibling that merely shares a prefix', () => {
    expect(sessionForCwds(['/home/lab/projects-old'], [parent])).toBeNull();
  });

  it('answers null when no project contains the cwd', () => {
    expect(sessionForCwds(['/tmp'], [parent, nested])).toBeNull();
    expect(sessionForCwds([], [parent])).toBeNull();
  });
});

/**
 * The one invariant the serialisation created and nothing enforces at run time.
 *
 * `_run` queues each request behind the last, so an op that itself called
 * `load`, `set` or `forget` would await a chain that is waiting on it - a
 * silent, permanent hang rather than an error. It cannot be caught by a
 * runtime guard: at the moment the inner call is made, "an op is executing"
 * is equally true of a legitimate call from the panel, and JavaScript gives
 * the store no way to tell the two apart.
 *
 * So it is enforced the way this repository already enforces its other
 * unrunnable invariant (see `core-neutrality.spec.ts`): by reading the source.
 * `inherit` is deliberately absent from the queued set - it delegates to `set`
 * from OUTSIDE the queue, which is the whole reason it is not queued itself,
 * and a future edit that queues it would deadlock.
 */
describe('ColourStore queue re-entrancy', () => {
  const QUEUED = ['load', 'set', 'forget'];

  /** The body of one method, by brace matching from its declaration. */
  const bodyOf = (source: string, name: string): string => {
    const start = source.indexOf(`async ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') {
        depth++;
      } else if (source[i] === '}') {
        depth--;
        if (depth === 0) {
          return source.slice(open, i + 1);
        }
      }
    }
    throw new Error(`unbalanced braces reading ${name}`);
  };

  const source = readFileSync(
    join(__dirname, '..', 'core', 'colour.ts'),
    'utf8'
  );

  it.each(QUEUED)('%s does not call back into the queue', name => {
    const body = bodyOf(source, name);
    for (const other of QUEUED) {
      expect(body).not.toContain(`this.${other}(`);
    }
  });

  it('reads a body big enough to be worth scanning, so the scan is not vacuous', () => {
    // Without this, a rename that made `bodyOf` return `{}` would leave every
    // assertion above trivially true.
    for (const name of QUEUED) {
      expect(bodyOf(source, name).length).toBeGreaterThan(200);
    }
    // ...and the scan finds what it is looking for when it IS there: `inherit`
    // calls `set`, from outside the queue, which is exactly the shape that
    // would deadlock inside one.
    expect(bodyOf(source, 'inherit')).toContain('this.set(');
  });
});
