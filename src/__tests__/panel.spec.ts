/**
 * Regression guard for the sessions panel itself - the two destructive
 * dialogs, the launch-mode wording on the surfaces that launch, and the danger
 * glyphs.
 *
 * Everything here drives a real `AssistantSessionsPanel` under jsdom against
 * the real JupyterLab `Dialog` and a real `CommandRegistry`. Nothing about the
 * panel is stubbed: the only doubles are the provider request layer (so no test
 * reaches the network) and three web-component packages the panel never touches
 * but `@jupyterlab/apputils` pulls in on import - see the mocks below.
 *
 * Why this file exists at all: six panel defects were fixed and closed with no
 * suite able to redden any of them, so each fix was verified by rendering it
 * once and never again. The most expensive of those is DEF-51 - without a test,
 * one careless edit silently re-arms an Enter key that destroys project
 * history.
 */

// `@jupyterlab/apputils`' barrel reaches `ui-components/toolbar`, which imports
// these two ESM-only packages. The repo jest config's `esModules` allowlist
// does not carry them, so the CommonJS runtime chokes on their `export`
// statement before a single line of panel code runs. The panel uses no toolbar
// and no web component, so stubbing the two at their module boundary costs
// nothing and keeps this spec runnable from the committed config. Drop both if
// `@jupyter/` is ever added to that allowlist.
jest.mock('@jupyter/react-components', () => ({}));
jest.mock('@jupyter/web-components', () => ({
  addJupyterLabThemeChangeListener: () => undefined,
  applyJupyterTheme: () => undefined,
  jpButton: () => undefined,
  jpToolbar: () => undefined,
  provideJupyterDesignSystem: () => ({ register: () => undefined })
}));

// No route in this spec is allowed to reach the server. The panel's colour
// store loads through the same module, which is why the counter is cleared
// before each act rather than asserted from construction.
jest.mock('../core/request', () => ({
  requestProvider: jest.fn(() => Promise.resolve({})),
  isResponseStatus: () => false,
  withQuery: (path: string) => path
}));

import { TAB_COLOUR_IDS, fnv1aColour } from '../core/colour';
import { addIcon, branchIcon, cleanupIcon, shieldIcon } from '../core/icons';
import { AssistantSessionsPanel, commandId } from '../core/panel';
import { requestProvider } from '../core/request';
import { IProviderDescriptor, ISession } from '../core/types';

const request = requestProvider as jest.Mock;

/** A provider with exactly one approval-skipping boolean mode. */
const DESCRIPTOR: IProviderDescriptor = {
  id: 'testbed',
  label: 'Testbed',
  panelTitle: 'Testbed Sessions',
  iconName: 'testbed-panel-spec',
  iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>',
  cliBinary: 'testbed',
  forkStrategy: 'native-flag',
  colourSource: 'derived',
  promptsForBranchName: true,
  mintsNewSessionId: true,
  launchModes: [
    {
      id: 'skip',
      title: 'Skip approvals',
      description: 'Run without asking.',
      default: false,
      menuLabel: 'Skip Permissions'
    }
  ],
  hasRemoteControl: false,
  hasBgAgents: true,
  hasLiveProcess: false
};

/** The same provider with no launch modes - the case where the branch entry's
 * neutral glyph is the right answer rather than the fallback nobody reaches. */
const PLAIN_DESCRIPTOR: IProviderDescriptor = {
  ...DESCRIPTOR,
  iconName: 'testbed-plain-panel-spec',
  launchModes: []
};

function session(over: Partial<ISession> = {}): ISession {
  const name = over.name ?? 'proj';
  return {
    project_path: `/home/user/${name}`,
    encoded_path: `enc-${name}`,
    session_id: `sid-${name}`,
    name,
    name_source: 'basename',
    message_count: 3,
    file_mtime: Date.now() - 3_600_000,
    git_branch: null,
    favourite: false,
    extra_sessions: 0,
    ...over
  };
}

function makePanel(
  descriptor: IProviderDescriptor = DESCRIPTOR
): AssistantSessionsPanel {
  return new AssistantSessionsPanel({
    app: {
      serviceManager: { serverSettings: {} },
      commands: { execute: jest.fn() }
    } as any,
    descriptor,
    rootDir: '/home/user'
  });
}

function render(panel: AssistantSessionsPanel, rows: ISession[]): void {
  (panel as any)._sessions = rows;
  (panel as any)._render();
}

/** Let the dialog's promise chain settle. */
const flush = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 0));

let panel: AssistantSessionsPanel;

beforeEach(async () => {
  window.localStorage.clear();
  panel = makePanel();
  // The colour store's startup reload leaves the constructor a microtask
  // behind the panel: every one of its requests is queued behind the last
  // (DEF-30), so the GET goes out after the call rather than during it.
  // Cleared once it has, or it counts against the first test to look.
  await flush();
  request.mockClear();
});

afterEach(async () => {
  // A dialog left behind by a failing assertion has to be DISMISSED, not just
  // detached: its promise sits in the module-global launch queue that every
  // later `Dialog.launch` waits on, so ripping the node out turns one failure
  // into a whole file of them and hides which assertion actually broke.
  // Escape is the dismissal the dialog itself offers.
  document
    .querySelectorAll('.jp-Dialog')
    .forEach(node =>
      node.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    );
  await flush();
  panel.dispose();
  jest.restoreAllMocks();
});

// --------------------------------------------------------------- DEF-51

describe('DEF-51 - the destructive dialogs open with Cancel under the keyboard', () => {
  // `Dialog.launch` attaches behind a launch-queue promise, so the dialog is
  // in the document a microtask after the call, not on return from it.
  const openButtons = async (): Promise<HTMLButtonElement[]> => {
    await flush();
    const dialog = document.querySelector('.jp-Dialog');
    expect(dialog).not.toBeNull();
    return Array.from(
      dialog!.querySelectorAll<HTMLButtonElement>('.jp-Dialog-button')
    );
  };

  const pressEnter = (): void => {
    const dialog = document.querySelector('.jp-Dialog')!;
    dialog.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
  };

  it('Remove from Testbed: Enter on the fresh dialog cancels', async () => {
    const done = (panel as any)._removeProject(session()) as Promise<void>;
    const buttons = await openButtons();

    // Cancel first, Remove second - `defaultButton: 0` is the first.
    expect(buttons.map(b => b.textContent)).toEqual(['Cancel', 'Remove']);
    expect(document.activeElement).toBe(buttons[0]);

    pressEnter();
    await done;

    // The DELETE is the only request this path makes; not making it is the
    // whole point of the fix.
    expect(request).not.toHaveBeenCalled();
  });

  it('Remove from Testbed: Enter on the Remove button still removes', async () => {
    // Guards the assertion above from being vacuous - the harness can see a
    // removal happen, so "not called" means the keyboard landed elsewhere and
    // not that the probe is blind.
    const done = (panel as any)._removeProject(session()) as Promise<void>;
    (await openButtons())[1].focus();
    pressEnter();
    await done;

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][3]).toMatchObject({ method: 'DELETE' });
  });

  it('Clean Up Parallel Sessions: Enter on the fresh dialog cancels', async () => {
    const done = (panel as any)._cleanupParallel(
      session({ extra_sessions: 3 })
    ) as Promise<void>;
    const buttons = await openButtons();

    expect(buttons.map(b => b.textContent)).toEqual(['Cancel', 'Remove']);
    expect(document.activeElement).toBe(buttons[0]);

    pressEnter();
    await done;

    // Cancelling stops before the branch fetch, so nothing is requested and no
    // progress dialog is raised.
    expect(request).not.toHaveBeenCalled();
    expect(
      document.querySelector('.jp-AiAssistantsPanel-cleanupBody')
    ).toBeNull();
  });

  it('Clean Up Parallel Sessions: Enter on the Remove button still cleans up', async () => {
    // Same non-vacuity guard as above.
    request.mockImplementation(() => Promise.resolve({ branches: [] }));
    void ((panel as any)._cleanupParallel(
      session({ extra_sessions: 3 })
    ) as Promise<void>);
    (await openButtons())[1].focus();
    pressEnter();
    await flush();

    expect(request).toHaveBeenCalled();
    expect(
      document.querySelector('.jp-AiAssistantsPanel-cleanupBody')
    ).not.toBeNull();
  });
});

// --------------------------------------------------- DEF-36 / DEF-38 / DEF-35

describe('the + button names and marks the launch it performs', () => {
  const newBtn = (): HTMLButtonElement =>
    panel.node.querySelector<HTMLButtonElement>(
      '.jp-AiAssistantsPanel-iconButton[title^="New "]'
    )!;

  const glyphs = (): string[] =>
    Array.from(newBtn().querySelectorAll('svg')).map(
      svg => svg.dataset.icon ?? ''
    );

  it('DEF-36 - the title carries the mode suffix', () => {
    panel.setModes({ skip: true });
    // Hover, so this holds the TEMPLATE to account and nothing else - the
    // title is rewritten on every pointerenter regardless of what `setModes`
    // does. DEF-38 below is the other half.
    newBtn().dispatchEvent(new Event('pointerenter'));
    expect(newBtn().title).toEqual(
      'New session in current folder (Skip Permissions)'
    );
  });

  it('DEF-38 - settings retitle it without a hover or a focus', () => {
    // The shell is built before settings arrive, so the build-time title can
    // only ever read "no mode in force". No pointerenter and no focus is
    // dispatched anywhere in this test - the only thing that may rewrite the
    // title is `setModes` itself.
    expect(newBtn().title).toEqual('New session in current folder');
    panel.setModes({ skip: true });
    expect(newBtn().title).toContain('(Skip Permissions)');
    panel.setModes({ skip: false });
    expect(newBtn().title).not.toContain('(Skip Permissions)');
  });

  it('DEF-112 - the glyph is always +, one svg at a time', () => {
    // The shield marks the menu entries that skip approval; the button that
    // offers or launches stays neutral in every mode state. The mode is still
    // named in the title, per DEF-36 above.
    expect(glyphs()).toEqual([addIcon.name]);
    panel.setModes({ skip: true });
    expect((panel as any)._visibleVariantCount()).toEqual(0);
    expect(glyphs()).toEqual([addIcon.name]);
    panel.setModes({ skip: false });
    expect(glyphs()).toEqual([addIcon.name]);
  });
});

// ------------------------------------------------------- DEF-35 / DEF-39

describe('DEF-35 / DEF-39 - the branch entry with no visible variants', () => {
  const cmds = (p: AssistantSessionsPanel): any => (p as any)._commands;
  const id = (p: AssistantSessionsPanel, action: string): string =>
    commandId(p.descriptor.id, action);

  it('names the verb and the mode once it is flattened to the top level', () => {
    panel.setModes({ skip: true });
    const command = id(panel, 'branch-session');
    // Inside the submenu the title says Branch Session and the item only names
    // the launch; flattened, that title is gone with it and a bare `Default
    // (Skip Permissions)` names no verb at all.
    expect(cmds(panel).label(command, {})).toEqual(
      'Branch Session (Skip Permissions)'
    );
  });

  it('lets the mode glyph beat the neutral branch icon', () => {
    panel.setModes({ skip: true });
    // The suffix names the mode in words, but the icon slot is what marks
    // danger everywhere else in this menu.
    expect(cmds(panel).icon(id(panel, 'branch-session'), {})).toBe(shieldIcon);
  });

  it('goes back to naming the launch alone while the variants render', () => {
    panel.setModes({ skip: false });
    expect((panel as any)._visibleVariantCount()).toEqual(1);
    expect(cmds(panel).label(id(panel, 'branch-session'), {})).toEqual(
      'Normal'
    );
    expect(cmds(panel).icon(id(panel, 'branch-session'), {})).toBeUndefined();
  });

  it('keeps the branch glyph where no mode is in play at all', () => {
    // A provider with no launch modes flattens the entry permanently, and the
    // branch glyph is the right answer there rather than a fallback nothing
    // reaches - so "always warn" is not a passing mutation.
    const plain = makePanel(PLAIN_DESCRIPTOR);
    try {
      expect(cmds(plain).label(id(plain, 'branch-session'), {})).toEqual(
        'Branch Session'
      );
      expect(cmds(plain).icon(id(plain, 'branch-session'), {})).toBe(
        branchIcon
      );
    } finally {
      plain.dispose();
    }
  });
});

// --------------------------------------------------------------- DEF-40

describe('DEF-40 - the shield glyph matches its siblings in size and colour', () => {
  const svg = (svgstr: string): SVGElement =>
    new DOMParser().parseFromString(svgstr, 'image/svg+xml')
      .documentElement as unknown as SVGElement;

  it('renders at 16x16, like its neutral siblings', () => {
    // Authored at 13x13 it rendered SMALLER than every icon beside it - the one
    // glyph whose job is to say "this differs" was also the least visible.
    for (const icon of [shieldIcon, addIcon, branchIcon]) {
      const el = svg(icon.svgstr);
      expect([
        icon.name,
        el.getAttribute('width'),
        el.getAttribute('height')
      ]).toEqual([icon.name, '16', '16']);
    }
  });

  it('paints in the standard jp-icon3, like its siblings', () => {
    // DEF-40's orange (`jp-icon-warn0`) was reversed by user ruling
    // 2026-08-11: the shield SHAPE alone marks the difference, the colour
    // stays the theme's neutral like every other icon in the menu.
    const path = svg(shieldIcon.svgstr).querySelector('path')!;
    expect(path.getAttribute('class')).toEqual('jp-icon3');
    expect(shieldIcon.svgstr).not.toContain('jp-icon-warn0');
  });
});

// ------------------------------------------------- DEF-45 / DEF-46 (lane A)

describe('DEF-45 - both destructive menu entries are marked alike', () => {
  it('gives Clean Up Parallel Sessions the sweep variant of the trash glyph', () => {
    // Same family as Remove's plain trash - marked alike, per DEF-45 - but
    // the bulk variant, because this one deletes several at once (user
    // direction 2026-08-11; it no longer shares the unsafe-launch shield).
    const commands = (panel as any)._commands;
    expect(
      commands.icon(commandId(DESCRIPTOR.id, 'cleanup-parallel'), {})
    ).toBe(cleanupIcon);
    expect(commands.icon(commandId(DESCRIPTOR.id, 'remove'), {})).toBeDefined();
  });
});

// --------------------------------------------------------------- DEF-31

describe('DEF-31 - a fork started inside the parent capture window', () => {
  /** The parent's conversation and the colour ladder around it. `picked` is
   * deliberately NOT the colour the parent's id hashes to, so "inherited the
   * new colour" can never be satisfied by the derived fallback. */
  const parent = session();
  const derived = fnv1aColour(parent.session_id);
  const picked = TAB_COLOUR_IDS.find(c => c !== derived)!;

  /** The same provider with the assistant's own colour at the top of the
   * ladder - the branch of `_inheritColour` that copies only what this
   * extension's store holds, and never the parent's native tint. */
  const NATIVE_DESCRIPTOR: IProviderDescriptor = {
    ...DESCRIPTOR,
    iconName: 'testbed-native-panel-spec',
    colourSource: 'native'
  };

  /** A promise the test answers by hand, to hold one request unanswered. */
  const deferred = <T>(): { promise: Promise<T>; settle: (v: T) => void } => {
    let settle!: (v: T) => void;
    const promise = new Promise<T>(resolve => {
      settle = resolve;
    });
    return { promise, settle };
  };

  /** What the server's colour store holds. Empty until a write is answered,
   * which is what lets a panel built INSIDE a test start with a cache that does
   * not already know the colour the fork is meant to wait for. */
  let stored: Record<string, string>;
  /** Colour writes for anything other than the parent - i.e. the fork's
   * inherited colour, which is what every assertion here is about. */
  let childWrites: Array<Record<string, unknown>>;
  let capture: { promise: Promise<unknown>; settle: (v: unknown) => void };
  let launch: jest.Mock;
  let reloads: number;

  beforeEach(() => {
    stored = {};
    childWrites = [];
    reloads = 0;
    capture = deferred<unknown>();
    launch = jest.fn(() => Promise.resolve());
    request.mockImplementation(
      (_id: string, path: string, _settings: unknown, init: any) => {
        if (path !== 'colours') {
          return Promise.resolve({ branches: [] });
        }
        if (init?.method !== 'POST') {
          reloads += 1;
          return Promise.resolve({
            colours: { ...stored },
            overrides: Object.keys(stored)
          });
        }
        const body = JSON.parse(init.body);
        if (body.session_id === parent.session_id) {
          // The parent's capture - held open until `answerCapture` below.
          return capture.promise;
        }
        childWrites.push(body);
        return Promise.resolve({ colours: { [body.session_id]: body.colour } });
      }
    );
    arm(panel);
  });

  afterEach(() => {
    // Put the inert default back. The NEXT test's panel loads its colour store
    // from its constructor, and the outer `beforeEach` flushes that load before
    // this one replaces the implementation - so a routing mock left installed
    // here hands that panel a cache that already holds the parent's new colour,
    // and the assertions below pass for the wrong reason. Measured, not feared:
    // without this line the no-capture test inherits `picked` rather than the
    // hash, which is the one case where the hash is the right answer.
    request.mockImplementation(() => Promise.resolve({}));
  });

  /** Point a panel at the parent row and stub the launch. The terminal is not
   * what is under test - each panel is driven to the point where it writes the
   * fork's colour, and no further. */
  const arm = (target: AssistantSessionsPanel): void => {
    (target as any)._terminals.launch = launch;
    (target as any)._activeSession = parent;
  };

  /** Answer the parent's capture, the way the server would: it persists first,
   * so a reload issued after it sees the new colour too. */
  const answerCapture = (): void => {
    stored[parent.session_id] = picked;
    capture.settle({ colours: { ...stored } });
  };

  /** Answer the name dialog `_branchSession` raises, so the fork proceeds. */
  const acceptName = async (): Promise<void> => {
    await flush();
    const dialog = document.querySelector('.jp-Dialog');
    expect(dialog).not.toBeNull();
    dialog!.querySelector<HTMLInputElement>('input')!.value = 'fork';
    const buttons = Array.from(
      dialog!.querySelectorAll<HTMLButtonElement>('.jp-Dialog-button')
    );
    // Cancel first, Ok second - `InputDialog.getText`'s own button order.
    buttons[buttons.length - 1].click();
    await flush();
  };

  /** The single write the fork made, with the minted id folded back in from
   * the launch so the assertion does not have to know the UUID. */
  const forkWrite = (colour: string | null): Record<string, unknown>[] =>
    colour === null
      ? []
      : [{ session_id: launch.mock.calls[0][1], colour, hand_set: false }];

  it('inherits the colour of a capture that is still unanswered', async () => {
    // The user picks a colour on the parent's tab; the write goes out and hangs.
    void (panel as any)._colours.set(parent.session_id, picked);
    expect((panel as any)._colours.isPending(parent.session_id)).toBe(true);

    const branched = (panel as any)._branchSession() as Promise<void>;
    await acceptName();
    expect(launch).toHaveBeenCalledTimes(1);
    // Still unanswered here, so the colour is in no cache the fork can read -
    // it has to wait for it rather than settle for the hash.
    expect(childWrites).toEqual([]);

    answerCapture();
    await branched;

    expect(childWrites).toEqual(forkWrite(picked));
  });

  it('inherits a capture that landed while the name dialog was open', async () => {
    // The other half of the window, and the half a pending-write check alone
    // misses: nothing is pending by the time the fork writes, and the colour
    // read at click time is stale all the same.
    void (panel as any)._colours.set(parent.session_id, picked);
    const branched = (panel as any)._branchSession() as Promise<void>;
    await flush();
    answerCapture();
    await flush();
    expect((panel as any)._colours.isPending(parent.session_id)).toBe(false);

    await acceptName();
    await branched;

    expect(childWrites).toEqual(forkWrite(picked));
    // No reload was needed to answer it - the cache already held the capture.
    expect(reloads).toBe(0);
  });

  it('costs no reload, and still inherits the derived tint, with no capture in flight', async () => {
    // The ordinary fork. Holds the two above to account for their cost, and
    // holds the click-time value to account as the fallback: a conversation the
    // store has no colour for inherits the tint its id hashes to, which is the
    // only tint it has.
    const branched = (panel as any)._branchSession() as Promise<void>;
    await acceptName();
    await branched;

    expect(childWrites).toEqual(forkWrite(derived));
    expect(reloads).toBe(0);
  });

  it('waits for the capture on a native-colour provider too', async () => {
    // Named in the defect as the second site: there the fork copies only what
    // this extension's store holds, so an unanswered capture left it copying
    // NOTHING - a fork with no inherited entry at all, not merely a stale one.
    const native = makePanel(NATIVE_DESCRIPTOR);
    try {
      arm(native);
      await flush();
      void (native as any)._colours.set(parent.session_id, picked);

      const branched = (native as any)._branchSession() as Promise<void>;
      await acceptName();
      expect(childWrites).toEqual([]);

      answerCapture();
      await branched;

      expect(childWrites).toEqual(forkWrite(picked));
    } finally {
      native.dispose();
    }
  });

  it('never copies the parent native tint onto a native-colour fork', async () => {
    // The other half of that branch, and why it cannot simply fall back to the
    // click-time value: the parent's own tint belongs to the parent. Copying it
    // would pin the fork to it and shadow the fork's own colour command for
    // good, so a parent this extension holds no colour for hands its fork
    // nothing.
    const native = makePanel(NATIVE_DESCRIPTOR);
    try {
      arm(native);
      (native as any)._activeSession = { ...parent, colour: 'sky' };
      await flush();

      const branched = (native as any)._branchSession() as Promise<void>;
      await acceptName();
      await branched;

      // The fork happened - "no colour was written" is the finding, not a
      // dialog that was never answered.
      expect(launch).toHaveBeenCalledTimes(1);
      expect(childWrites).toEqual([]);
    } finally {
      native.dispose();
    }
  });
});

describe('DEF-46 - the row tooltip names only a mode the row launches with', () => {
  const tooltip = (rows: ISession[]): string => {
    render(panel, rows);
    return panel.node.querySelector<HTMLElement>('.jp-AiAssistantsPanel-row')!
      .title;
  };

  it('names the mode on a dormant row', () => {
    panel.setModes({ skip: true });
    expect(tooltip([session()])).toContain('Launch mode: Skip Permissions');
  });

  it('says nothing about a mode on a row a live worker already holds', () => {
    panel.setModes({ skip: true });
    // An attach is issued before the flag is appended, deliberately, so the
    // tooltip would otherwise promise something the assistant never receives.
    const text = tooltip([session({ bg_id: 'abcd1234' })]);
    expect(text).toContain('Background agent: abcd1234 (click attaches to it)');
    expect(text).not.toContain('Launch mode');
  });
});
