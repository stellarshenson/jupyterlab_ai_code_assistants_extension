/**
 * How a colour picked on a terminal tab reaches this extension's store.
 *
 * The defect this file guards: the capture used to be a READ of the companion
 * extension's browser storage, keyed by terminal session name. Terminado hands
 * a closed terminal's name to the next terminal created, so a dead terminal's
 * colour was read back for a live one and written into the per-conversation
 * store as hand-set - the top rung of the ladder, where it outranked the
 * conversation's own colour for good. Observed live: four `/color orange`
 * records rendered green.
 *
 * The capture is now the companion's `colourChanged` signal, so only a click
 * can produce one. The assertions that matter most are the two negative ones,
 * because they are the invariants a future edit would undo without failing
 * anything else: a paint pass reads no browser storage at all, and against a
 * companion that cannot report a choice this extension paints nothing whatever
 * rather than painting over choices it will never hear about.
 */

// The launch spinner pulls `@jupyterlab/apputils`, whose barrel reaches two
// ESM-only web-component packages the repo jest config does not transform. The
// same two stubs `panel.spec.ts` carries, for the same reason.
jest.mock('@jupyter/react-components', () => ({}));
jest.mock('@jupyter/web-components', () => ({
  addJupyterLabThemeChangeListener: () => undefined,
  applyJupyterTheme: () => undefined,
  jpButton: () => undefined,
  jpToolbar: () => undefined,
  provideJupyterDesignSystem: () => ({ register: () => undefined })
}));

jest.mock('../core/request', () => ({ requestProvider: jest.fn() }));

import { ColourStore, fnv1aColour } from '../core/colour';
import { requestProvider } from '../core/request';
import { TerminalManager } from '../core/terminals';
import {
  IColourChoice,
  IProviderDescriptor,
  ITerminalProbeResponse
} from '../core/types';

const request = requestProvider as jest.MockedFunction<typeof requestProvider>;

const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';

const DESCRIPTOR: IProviderDescriptor = {
  id: 'testbed',
  label: 'Testbed',
  panelTitle: 'Testbed Sessions',
  iconName: 'testbed-tab-colour-spec',
  iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>',
  cliBinary: 'testbed',
  forkStrategy: 'native-flag',
  colourSource: 'derived',
  promptsForBranchName: false,
  mintsNewSessionId: true,
  launchModes: [],
  hasRemoteControl: false,
  hasBgAgents: false,
  hasLiveProcess: false
};

/** The companion's signal, hand-rolled rather than taken from
 * `@lumino/signaling`: this package does not depend on it directly, and a slot
 * list is the whole of what the manager uses. Connected slots are counted so a
 * missing disconnect on dispose is visible. */
class FakeSignal {
  connect(
    slot: (sender: unknown, choice: IColourChoice) => void,
    thisArg?: unknown
  ): boolean {
    this._slots.push([slot, thisArg]);
    return true;
  }

  disconnect(
    slot: (sender: unknown, choice: IColourChoice) => void,
    thisArg?: unknown
  ): boolean {
    const before = this._slots.length;
    this._slots = this._slots.filter(
      ([fn, arg]) => fn !== slot || arg !== thisArg
    );
    return this._slots.length !== before;
  }

  emit(choice: IColourChoice): void {
    for (const [slot, thisArg] of [...this._slots]) {
      slot.call(thisArg, this, choice);
    }
  }

  get connections(): number {
    return this._slots.length;
  }

  private _slots: [
    (sender: unknown, choice: IColourChoice) => void,
    unknown
  ][] = [];
}

/** `jupyterlab_colourful_tab_extension` at the release that carries the
 * ownership API. */
class FakeColourfulTabs {
  readonly colourChanged = new FakeSignal();
  readonly setColour = jest.fn();
  readonly claims: { widget: any; disposed: boolean }[] = [];

  claim(widget: unknown): { dispose(): void } {
    const held = { widget, disposed: false };
    this.claims.push(held);
    return {
      dispose: () => {
        held.disposed = true;
      }
    };
  }
}

/** A terminal widget as the tracker hands it over.
 *
 * The two identities are deliberately independent here, because they are in
 * JupyterLab too: the widget id is `id-<uuid4>`, minted once per widget and
 * never handed to a second one (verified against 4.6.3 on 2026-09-04), while
 * the session NAME is the slot terminado recycles. A helper that derived the
 * id from the name would let a test assert a collision that cannot happen. */
let widgetSeq = 0;
function terminal(name: string): any {
  widgetSeq += 1;
  return {
    id: `id-f91250bd-5cbf-4c61-b774-${String(widgetSeq).padStart(12, '0')}`,
    isDisposed: false,
    content: { session: { name } }
  };
}

/** A widget id of the right shape that no open terminal wears. */
const ABSENT_WIDGET_ID = 'id-00000000-0000-4000-8000-000000000000';

/** The server both routes this spec touches answer from. */
interface IFakeServer {
  probes: Record<string, ITerminalProbeResponse>;
  colours: Record<string, string>;
  overrides: string[];
  /** The colour store's routes refuse every request. */
  refuseColours: boolean;
  /** While set, a terminal probe answers only once this settles - which is how
   * one pass is held long enough for a later one to overtake it. The answer is
   * read BEFORE the wait, so the held caller sees the state it started with. */
  holdProbes: Promise<void> | null;
}

/** A gate the test opens by hand, for holding a probe in flight. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>(resolve => {
    open = () => resolve();
  });
  return { promise, open: () => open() };
}

let server: IFakeServer;
let tabs: FakeColourfulTabs;
let terminals: any[];
let store: ColourStore;
let manager: TerminalManager;
let warn: jest.SpyInstance;

/** Let every queued promise settle - the capture chain is probe, then a
 * serialised store write, then a paint pass with a probe of its own. */
const flush = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 0));

function makeManager(
  over: Partial<TerminalManager.IOptions> = {}
): TerminalManager {
  return new TerminalManager({
    app: { shell: { activateById: jest.fn() }, commands: {} } as any,
    descriptor: DESCRIPTOR,
    colourStore: store,
    terminalTracker: {
      forEach: (fn: (widget: any) => void) => terminals.forEach(fn)
    } as any,
    colourfulTabs: tabs as any,
    serverSettings: {} as any,
    ...over
  });
}

/** Colours the manager painted on one widget, oldest first. */
function paints(widget: any): (string | null)[] {
  return tabs.setColour.mock.calls
    .filter(call => call[0] === widget)
    .map(call => call[1]);
}

/** Claims the companion is still holding. Counted rather than read off one
 * entry, because a claim left behind is only visible as a total. */
function held(): number {
  return tabs.claims.filter(one => !one.disposed).length;
}

/** Every write the colour store made. */
function colourWrites(): unknown[] {
  return request.mock.calls.filter(
    call => call[1] === 'colours' && (call[3] as RequestInit)?.method
  );
}

/** Choices the manager is still holding for a conversation it could not read.
 * Reached into rather than observed, because a record that outlives its
 * terminal has no surface: the widget id it is filed under is never handed to a
 * second widget, so nothing can ever ask for it again. */
function pendingChoices(): number {
  return ((manager as any)._pendingChoices as Map<string, unknown>).size;
}

beforeEach(() => {
  server = {
    probes: {
      '1': { terminal_name: '1', running: true, session_id: SESSION }
    },
    colours: {},
    overrides: [],
    refuseColours: false,
    holdProbes: null
  };
  tabs = new FakeColourfulTabs();
  terminals = [terminal('1')];
  request.mockReset();
  request.mockImplementation((async (
    _providerId: string,
    path: string,
    _settings: unknown,
    init: RequestInit = {}
  ) => {
    if (path.startsWith('terminal/')) {
      const name = decodeURIComponent(path.slice('terminal/'.length));
      // Read before the wait, so a held probe answers what the server said when
      // the call was made rather than what a later test line changed it to.
      const probe = server.probes[name];
      const wait = server.holdProbes;
      if (wait) {
        await wait;
      }
      if (!probe) {
        throw new Error(`no such terminal: ${name}`);
      }
      return probe;
    }
    if (path === 'colours') {
      if (server.refuseColours) {
        throw new Error('refused');
      }
      const body = init.body ? JSON.parse(init.body as string) : {};
      if (init.method === 'POST') {
        if (body.colour) {
          server.colours[body.session_id] = body.colour;
        } else {
          delete server.colours[body.session_id];
        }
        server.overrides = server.overrides.filter(
          id => id !== body.session_id
        );
        if (body.colour && body.hand_set) {
          server.overrides.push(body.session_id);
        }
      } else if (init.method === 'DELETE') {
        for (const id of body.session_ids ?? []) {
          delete server.colours[id];
          server.overrides = server.overrides.filter(held => held !== id);
        }
      }
      return {
        colours: { ...server.colours },
        overrides: [...server.overrides]
      };
    }
    throw new Error(`unexpected route: ${path}`);
  }) as any);
  store = new ColourStore(DESCRIPTOR.id, {} as any);
  manager = makeManager();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  manager.dispose();
  jest.restoreAllMocks();
});

describe('a colour picked on a tab', () => {
  it('is filed against the running conversation as the user own choice', async () => {
    tabs.colourChanged.emit({
      widgetId: terminals[0].id,
      colourId: 'sky'
    });
    await flush();

    expect(store.get(SESSION)).toEqual('sky');
    // Hand-set, not inherited: only a hand-set colour is offered for release,
    // and only a hand-set colour outranks the conversation own colour.
    expect(store.isOverride(SESSION)).toBe(true);
    expect(paints(terminals[0])).toContain('sky');
  });

  it('paints the choice rather than the colour the ladder would derive', async () => {
    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();

    expect(fnv1aColour(SESSION)).not.toEqual('sky');
    expect(paints(terminals[0]).pop()).toEqual('sky');
  });
});

describe('a colour cleared on a tab', () => {
  it('releases the conversation back to the ladder', async () => {
    server.colours[SESSION] = 'sky';
    server.overrides = [SESSION];
    await store.load();

    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: null });
    await flush();

    expect(store.get(SESSION)).toBeNull();
    expect(server.colours[SESSION]).toBeUndefined();
    // Back to the derived rung, which is this descriptor colour source.
    expect(paints(terminals[0]).pop()).toEqual(fnv1aColour(SESSION));
  });
});

describe('a tab that is not this assistant', () => {
  it('is ignored when the terminal runs something else', async () => {
    server.probes['1'] = { terminal_name: '1', running: false };

    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();

    expect(colourWrites()).toEqual([]);
    expect(store.get(SESSION)).toBeNull();
  });

  it('is ignored when no open terminal carries that widget id', async () => {
    tabs.colourChanged.emit({ widgetId: ABSENT_WIDGET_ID, colourId: 'sky' });
    await flush();

    expect(colourWrites()).toEqual([]);
    expect(tabs.setColour).not.toHaveBeenCalled();
  });
});

describe('a choice made while the probe cannot be read at all', () => {
  it('is recorded nowhere, so a later assistant never inherits it', async () => {
    // The server is briefly unreachable and the tab is a plain shell one. A
    // probe that failed says only that the server did not answer - it does not
    // say whose terminal it is, and every provider's manager sees the same
    // silence. Held on that basis, the choice is filed the day an assistant
    // starts in that terminal, against a conversation the user never coloured.
    delete server.probes['1'];

    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();

    expect(pendingChoices()).toBe(0);
    expect(colourWrites()).toEqual([]);

    // The user then starts the assistant in that same terminal.
    server.probes['1'] = {
      terminal_name: '1',
      running: true,
      session_id: SESSION
    };
    await manager.reconcileColours();

    expect(store.get(SESSION)).toBeNull();
    // And the conversation is tinted from the ladder, not from that choice.
    expect(paints(terminals[0]).pop()).toEqual(fnv1aColour(SESSION));
  });

  it('is named in the console, because nothing else records it', async () => {
    // The companion has deleted whatever it held for this tab and persisted
    // nothing new, so the pick survives only as a class Lumino rebuilds away at
    // the next tab switch. Dropping it silently leaves the user watching their
    // colour appear and then vanish with no account of it anywhere.
    delete server.probes['1'];

    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();

    expect(
      warn.mock.calls.filter(call =>
        String(call[0]).includes('could not be attributed to a conversation')
      )
    ).toHaveLength(1);
  });
});

describe('a store that refuses the write', () => {
  it('paints nothing, and says the choice did not stick', async () => {
    server.refuseColours = true;

    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();

    // The tab is claimed, so the companion kept no record of this choice, and
    // a refused write means the store holds none either - every colour left to
    // paint is the conversation's PREVIOUS one, which is what the pick was
    // meant to replace. Not painting does not save it either: what the tab
    // wears is a class the companion's menu put on the element, and Lumino
    // rebuilds that from the widget title at the next tab switch. The warning
    // is the durable part.
    expect(tabs.setColour).not.toHaveBeenCalled();
    expect(store.get(SESSION)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe('a choice whose conversation is not readable yet', () => {
  /** The window right after a launch: the process is this assistant's, and it
   * has not written the conversation the probe reads yet. The signal fires
   * once, so a choice dropped in this window is a choice the next pass paints
   * over - which is what the scrape used to survive by running every 30
   * seconds. */
  const UNREADABLE: ITerminalProbeResponse = {
    terminal_name: '1',
    running: true,
    session_id: null
  };
  const READABLE: ITerminalProbeResponse = {
    terminal_name: '1',
    running: true,
    session_id: SESSION
  };

  beforeEach(() => {
    server.probes['1'] = UNREADABLE;
  });

  it('is filed by the next pass, once the process reports the conversation', async () => {
    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();
    expect(store.get(SESSION)).toBeNull();

    server.probes['1'] = READABLE;
    await manager.reconcileColours();

    expect(store.get(SESSION)).toEqual('sky');
    // The user's own pick, on the top rung - a deferred capture is the same
    // choice, not a lesser one.
    expect(store.isOverride(SESSION)).toBe(true);
    expect(paints(terminals[0]).pop()).toEqual('sky');
  });

  it('shows the pick, and nothing else, until then', async () => {
    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();
    await manager.reconcileColours();

    // The pick is painted once and the pass adds nothing to it. Nothing else
    // holds this colour - the store has not got it, and the tab is claimed so
    // the companion deleted its own record - and a class on the tab element is
    // rebuilt away at the next tab switch, so without this paint the user's
    // colour appears, vanishes, and returns by itself once the pass files it.
    // What the pass must still not paint is the conversation's effective
    // colour, which is the one the pick was made to replace.
    expect(paints(terminals[0])).toEqual(['sky']);
  });

  it('is replaced by a later choice on the same tab', async () => {
    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();
    // The user changed their mind while the conversation was still unreadable.
    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'rose' });
    await flush();

    server.probes['1'] = READABLE;
    await manager.reconcileColours();

    expect(store.get(SESSION)).toEqual('rose');
  });

  it('is dropped by a later choice on the same tab that CAN be filed', async () => {
    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();

    // The CLI has written the conversation by the time the user picks again, so
    // this second choice files immediately - and the capture reconciles right
    // after writing it. Held past that write, the earlier pick is replayed by
    // that very reconcile, straight over the newer one.
    server.probes['1'] = READABLE;
    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'rose' });
    await flush();

    expect(pendingChoices()).toBe(0);
    expect(store.get(SESSION)).toEqual('rose');

    await manager.reconcileColours();
    expect(store.get(SESSION)).toEqual('rose');
  });

  it('does not outlive the assistant run it was picked in', async () => {
    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();
    expect(pendingChoices()).toBe(1);

    // The assistant exits. The terminal stays open as a plain shell, and the
    // server says so - which ends the conversation the pick was made under.
    server.probes['1'] = {
      terminal_name: '1',
      running: false,
      session_id: null
    };
    await manager.reconcileColours();
    expect(pendingChoices()).toBe(0);

    // It is started again in the same terminal, on a NEW conversation the user
    // has picked no colour for. The widget id never changed, so a choice kept
    // across the gap lands here, as hand-set, at the top of the ladder.
    server.probes['1'] = {
      terminal_name: '1',
      running: true,
      session_id: OTHER_SESSION
    };
    await manager.reconcileColours();

    expect(store.get(OTHER_SESSION)).toBeNull();
  });

  it('is dropped as soon as a pick on that tab is told the assistant is gone', async () => {
    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();
    expect(pendingChoices()).toBe(1);

    // The assistant exits and the user CLEARS the colour on the now-plain
    // shell tab. Their last action is "remove this". The capture is told
    // not-running and files nothing, correctly - but the earlier pick is held
    // by nothing else, and the pass that would drop it is up to 30 seconds
    // away, so a restart inside that window used to file the cleared colour as
    // hand-set against a conversation the user never coloured.
    server.probes['1'] = {
      terminal_name: '1',
      running: false,
      session_id: null
    };
    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: null });
    await flush();
    expect(pendingChoices()).toBe(0);

    server.probes['1'] = {
      terminal_name: '1',
      running: true,
      session_id: OTHER_SESSION
    };
    await manager.reconcileColours();

    expect(store.get(OTHER_SESSION)).toBeNull();
  });

  it('survives a probe that failed, which names no owner either way', async () => {
    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();

    // The server did not answer. That is not the terminal disowning the
    // assistant, and discarding the pick on it loses a colour chosen seconds
    // ago - the same asymmetry the capture path already keeps.
    delete server.probes['1'];
    await manager.reconcileColours();
    expect(pendingChoices()).toBe(1);

    server.probes['1'] = READABLE;
    await manager.reconcileColours();

    expect(store.get(SESSION)).toEqual('sky');
  });

  it('is filed once, not on every pass that follows', async () => {
    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();
    server.probes['1'] = READABLE;
    await manager.reconcileColours();
    await manager.reconcileColours();

    // Held past its filing, the record would re-impose that colour for the life
    // of the page, over every later choice made anywhere else.
    expect(colourWrites()).toHaveLength(1);
  });

  it('is never resolved from the folder the terminal sits in', async () => {
    // The rule the scrape already had, and the retry does not relax it: a
    // colour is never filed against a conversation guessed from the folder a
    // terminal happens to sit in, and a project holds many conversations.
    server.probes['1'] = { ...UNREADABLE, cwds: ['/home/user/proj'] };
    manager.setSessions([
      {
        project_path: '/home/user/proj',
        encoded_path: 'enc',
        session_id: OTHER_SESSION,
        name: 'proj',
        name_source: 'basename',
        message_count: 0,
        file_mtime: 0,
        git_branch: null,
        favourite: false,
        extra_sessions: 0
      }
    ]);

    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();
    await manager.reconcileColours();

    expect(colourWrites()).toEqual([]);
    expect(store.get(OTHER_SESSION)).toBeNull();
  });

  it('is dropped when tab colouring is switched off', async () => {
    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();

    manager.setColouredTabs(false);
    await flush();
    server.probes['1'] = READABLE;
    manager.setColouredTabs(true);
    await flush();

    // Filing it now would put a colour the user picked before the setting went
    // off on the top rung of the ladder, minutes or days later.
    expect(store.get(SESSION)).toBeNull();
  });

  it('is dropped when its terminal closes', async () => {
    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();
    expect(pendingChoices()).toBe(1);

    terminals[0].isDisposed = true;
    await manager.reconcileColours();

    // One entry per closed terminal otherwise, held for the life of the page.
    expect(pendingChoices()).toBe(0);
  });

  it('is dropped when the panel is disposed', async () => {
    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();
    manager.dispose();

    expect(pendingChoices()).toBe(0);
  });
});

describe('a choice made as colouring stops', () => {
  it('is not written by a capture whose probe was still in flight', async () => {
    const probe = gate();
    server.holdProbes = probe.promise;

    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    manager.setColouredTabs(false);
    probe.open();
    await flush();

    // Written here it would sit hand-set on the top rung of a ladder nothing is
    // drawing, and surface the day the setting is turned back on.
    expect(store.get(SESSION)).toBeNull();
    expect(server.colours[SESSION]).toBeUndefined();
  });

  it('is not written by a capture that outlived the panel', async () => {
    const probe = gate();
    server.holdProbes = probe.promise;

    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    manager.dispose();
    probe.open();
    await flush();

    expect(store.get(SESSION)).toBeNull();
    expect(server.colours[SESSION]).toBeUndefined();
  });
});

describe('a pass that a later one overtook', () => {
  it('does not release a claim the newer pass took', async () => {
    const probe = gate();
    server.holdProbes = probe.promise;
    // The older pass reads a terminal that is nobody's yet, and is held there.
    server.probes['1'] = { terminal_name: '1', running: false };
    const overtaken = manager.reconcileColours();

    server.holdProbes = null;
    server.probes['1'] = {
      terminal_name: '1',
      running: true,
      session_id: SESSION
    };
    await manager.reconcileColours();
    expect(held()).toBe(1);

    probe.open();
    await overtaken;

    // The older pass recognised nothing, so its sweep would release a claim the
    // newer pass legitimately took - leaving the companion persisting and
    // repainting a tab this extension is still drawing.
    expect(held()).toBe(1);
  });

  it('does not strip a tint that switching colouring back on has painted', async () => {
    await manager.reconcileColours();
    const probe = gate();
    server.holdProbes = probe.promise;

    // The clear is held mid-walk, and the setting goes back on behind it.
    manager.setColouredTabs(false);
    server.holdProbes = null;
    manager.setColouredTabs(true);
    await flush();
    probe.open();
    await flush();

    expect(paints(terminals[0]).pop()).toEqual(fnv1aColour(SESSION));
  });
});

describe('ownership of a recognised tab', () => {
  it('is claimed once, however many passes run', async () => {
    await manager.reconcileColours();
    await manager.reconcileColours();

    expect(tabs.claims).toHaveLength(1);
    expect(tabs.claims[0].widget).toBe(terminals[0]);
  });

  it('is released when the terminal stops running this assistant', async () => {
    await manager.reconcileColours();
    // The assistant exited, or another one took the pty. The tab is nobody's
    // now, and a colour picked on it would be persisted by nobody.
    server.probes['1'] = { terminal_name: '1', running: false };
    await manager.reconcileColours();

    expect(tabs.claims[0].disposed).toBe(true);
    expect(held()).toBe(0);
  });

  it('is released when the terminal is closed, and left behind by nothing', async () => {
    await manager.reconcileColours();
    terminals[0].isDisposed = true;
    await manager.reconcileColours();

    expect(tabs.claims[0].disposed).toBe(true);
    // The map is the leak half: one entry per closed terminal, held for the
    // life of the page, each one telling the companion a dead tab is owned.
    expect(held()).toBe(0);
  });

  it('is taken again when a terminal that came back probes as ours', async () => {
    await manager.reconcileColours();
    server.probes['1'] = { terminal_name: '1', running: false };
    await manager.reconcileColours();
    server.probes['1'] = {
      terminal_name: '1',
      running: true,
      session_id: SESSION
    };
    await manager.reconcileColours();

    expect(tabs.claims).toHaveLength(2);
    expect(tabs.claims[1].disposed).toBe(false);
  });

  it('is not taken by a pass that was in flight when colouring went off', async () => {
    // The pass is past its `_colouredTabs` check and awaiting a probe when the
    // setting flips. Its claim would be taken after the release that switching
    // off performs, and nothing would ever let it go.
    const pass = manager.reconcileColours();
    manager.setColouredTabs(false);
    await pass;
    await flush();

    expect(held()).toBe(0);
  });

  it('is not taken by a pass that was in flight when the panel went away', async () => {
    const pass = manager.reconcileColours();
    manager.dispose();
    await pass;
    await flush();

    expect(held()).toBe(0);
  });

  it('is released when the controller is disposed', async () => {
    await manager.reconcileColours();
    manager.dispose();

    expect(tabs.claims).toHaveLength(1);
    expect(tabs.claims[0].disposed).toBe(true);
    // And the signal is let go with it, or a disposed panel keeps capturing.
    expect(tabs.colourChanged.connections).toBe(0);
  });

  it('is released when tab colouring is turned off', async () => {
    await manager.reconcileColours();
    manager.setColouredTabs(false);
    await flush();

    // With colouring off this extension does not own the tab, and the
    // companion menu goes back to working on it as it does on any other.
    expect(tabs.claims[0].disposed).toBe(true);
  });

  it('takes no copy of a choice made while colouring is off', async () => {
    manager.setColouredTabs(false);
    await flush();

    tabs.colourChanged.emit({ widgetId: terminals[0].id, colourId: 'sky' });
    await flush();

    // The companion owns and keeps that choice. A copy here would sit on the
    // top rung of a ladder nothing is drawing, and surface the day the setting
    // is turned back on.
    expect(store.get(SESSION)).toBeNull();
    expect(server.colours[SESSION]).toBeUndefined();
  });
});

describe('an older companion', () => {
  it('is tolerated, and named once in the console', () => {
    const legacy = { setColour: jest.fn() };
    // Counted rather than read off the call total: re-importing the module
    // graph below re-evaluates `@jupyterlab/apputils`, which warns about the
    // clipboard on the way past.
    const named = (): number =>
      warn.mock.calls.filter(call =>
        /jupyterlab_colourful_tab_extension/.test(String(call[0]))
      ).length;
    // A fresh module, because the warning latch is module-level: one missing
    // upgrade must not print the same line once per assistant panel.
    jest.isolateModules(() => {
      const fresh = require('../core/terminals')
        .TerminalManager as typeof TerminalManager;
      const managers: TerminalManager[] = [];
      // No companion at all is not a stale companion, and says nothing.
      managers.push(new fresh(optionsFor(null)));
      expect(named()).toBe(0);
      managers.push(new fresh(optionsFor(legacy)));
      expect(named()).toBe(1);
      // The second panel of the same page adds nothing.
      managers.push(new fresh(optionsFor(legacy)));
      expect(named()).toBe(1);
      managers.forEach(one => one.dispose());
    });
  });

  it('is named where the user is looking, not only in the console', () => {
    const legacy = { setColour: jest.fn() };
    // A plain tab reads as a feature that was never switched on, so the console
    // reaches only someone who already suspects the cause. The toast is latched
    // with the console line, so one missing upgrade raises one notification
    // however many assistant panels the page docks.
    jest.isolateModules(() => {
      // Spied INSIDE the isolation: `isolateModules` gives the re-required
      // manager its own module registry, so a spy taken on the outer
      // `@jupyterlab/apputils` watches an object the fresh module never calls.
      const toast = jest
        .spyOn(require('@jupyterlab/apputils').Notification, 'warning')
        .mockImplementation(() => '');
      const fresh = require('../core/terminals')
        .TerminalManager as typeof TerminalManager;
      const managers: TerminalManager[] = [];
      managers.push(new fresh(optionsFor(null)));
      expect(toast).not.toHaveBeenCalled();
      managers.push(new fresh(optionsFor(legacy)));
      managers.push(new fresh(optionsFor(legacy)));
      expect(toast).toHaveBeenCalledTimes(1);
      // It does not close on its own, because the condition does not either.
      expect(toast.mock.calls[0][1]).toMatchObject({ autoClose: false });
      managers.forEach(one => one.dispose());
    });
  });

  it('keeps its tabs - this extension tints nothing at all', async () => {
    const legacy = { setColour: jest.fn() };
    manager.dispose();
    manager = makeManager({ colourfulTabs: legacy as any });

    await manager.reconcileColours();
    await manager.reconcileColours();

    // Not one tint, on any pass. A colour picked on a tab cannot be captured
    // from an older companion, so painting one would repaint the user's pick
    // away on the next pass - worse than the defect this design removes, and
    // silent apart from one console line. Leaving the tabs alone is what makes
    // the companion's own menu behave as it did before this extension was
    // installed.
    expect(legacy.setColour).not.toHaveBeenCalled();
    // And the pass stops before the walk, so no terminal is probed for a tint
    // that is never applied and no tab is claimed on the way past.
    expect(
      request.mock.calls.filter(call => String(call[1]).startsWith('terminal/'))
    ).toEqual([]);
  });
});

describe('the paint pass', () => {
  it('reads no browser storage at all', async () => {
    // The whole point of the change. The capture used to read the companion
    // localStorage here, keyed by a terminal name terminado recycles, and
    // promote whatever it found to the top of the ladder. Nothing in a paint
    // pass may read a store this extension does not own.
    const getItem = jest.spyOn(Storage.prototype, 'getItem');

    await manager.reconcileColours();

    // Not vacuous: the pass did run and did paint.
    expect(tabs.setColour).toHaveBeenCalledWith(
      terminals[0],
      fnv1aColour(SESSION)
    );
    expect(getItem).not.toHaveBeenCalled();
  });

  it('paints null on a claimed tab it holds no colour for', async () => {
    // The other half of the design's answer to a terminal that was coloured
    // before the assistant started: the companion restores its own stored
    // colour onto a claimed tab carrying no colour class, and painting null is
    // what takes that class off. Skipping the paint instead would leave
    // whatever the tab last wore, and the companion's guard could never fire.
    // The ordinary case for a `none` source provider, which holds a colour only
    // where the user picked one.
    manager.dispose();
    manager = makeManager({
      descriptor: { ...DESCRIPTOR, colourSource: 'none' }
    });

    await manager.reconcileColours();

    // Claimed, so the paint below deletes nothing the companion stored for
    // this tab - the null takes the colour class off and leaves that entry to
    // show through.
    expect(held()).toBe(1);
    expect(paints(terminals[0])).toEqual([null]);
  });
});

/** Manager options against one companion, for the isolated-module case that
 * cannot use `makeManager`. */
function optionsFor(colourfulTabs: unknown): TerminalManager.IOptions {
  return {
    app: { shell: { activateById: jest.fn() }, commands: {} } as any,
    descriptor: DESCRIPTOR,
    colourStore: store,
    terminalTracker: {
      forEach: (fn: (widget: any) => void) => terminals.forEach(fn)
    } as any,
    colourfulTabs: colourfulTabs as any,
    serverSettings: {} as any
  };
}
