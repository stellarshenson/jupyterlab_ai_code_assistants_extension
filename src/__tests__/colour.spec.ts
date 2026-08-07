/**
 * The colour ladder.
 *
 * Highest wins: a user-set colour, then the conversation's own colour for a
 * `native` assistant, then the derived hash, then nothing. Each step is a pure
 * function precisely so this can be asserted without a panel - the tint is the
 * part that regressed twice behind a green suite that never ran the logic.
 */

import {
  TAB_COLOUR_IDS,
  effectiveColour,
  fnv1aColour,
  readUserSetTabColour,
  sessionForCwds
} from '../core/colour';
import { ISession } from '../core/types';

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

describe('readUserSetTabColour', () => {
  afterEach(() => window.localStorage.clear());

  it('reads the colourful-tab extension menu choice', () => {
    window.localStorage.setItem(
      'jupyterlab-colourful-tab-colours',
      JSON.stringify({ 'terminal:1': 3 })
    );
    expect(readUserSetTabColour('1')).toEqual('mint');
  });

  it('answers null for a terminal with no choice, and never throws', () => {
    expect(readUserSetTabColour('1')).toBeNull();
    window.localStorage.setItem('jupyterlab-colourful-tab-colours', 'not json');
    expect(readUserSetTabColour('1')).toBeNull();
    window.localStorage.setItem(
      'jupyterlab-colourful-tab-colours',
      JSON.stringify({ 'terminal:1': 99 })
    );
    expect(readUserSetTabColour('1')).toBeNull();
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
