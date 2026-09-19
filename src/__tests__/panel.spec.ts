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
// The Manage Sessions popup is a separate module with its own DOM; the panel
// test asserts what the panel HANDS it, not what it draws.
jest.mock('../core/popup', () => ({
  showManageSessionsPopup: jest.fn()
}));
jest.mock('../core/request', () => ({
  requestProvider: jest.fn(() => Promise.resolve({})),
  // Shape-based rather than `instanceof`, so a test can hand the panel the
  // refusal a route answers with without building a real `Response`.
  isRequestTimeout: (err: any) => err?.name === 'RequestTimeoutError',
  isResponseStatus: (err: any, status: number) =>
    err?.response?.status === status,
  withQuery: (path: string) => path
}));

import { Clipboard, Notification } from '@jupyterlab/apputils';
import { TAB_COLOUR_IDS, fnv1aColour } from '../core/colour';
import { addIcon, branchIcon, cleanupIcon, shieldIcon } from '../core/icons';
import { AssistantSessionsPanel, commandId } from '../core/panel';
import { showManageSessionsPopup } from '../core/popup';
import { requestProvider } from '../core/request';
import { IBranch, IProviderDescriptor, ISession } from '../core/types';

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
  terminalScope: 'conversation',
  promptsForBranchName: true,
  canRename: true,
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

  it('says a deletion cannot be undone only when it is permanent', async () => {
    // Default: trash is on, and a trashed conversation is recoverable.
    let done = (panel as any)._removeProject(session()) as Promise<void>;
    await openButtons();
    let body = document.querySelector('.jp-Dialog-body')!.textContent ?? '';
    expect(body).toContain('moved to trash');
    expect(body).not.toContain('cannot be undone');
    pressEnter();
    await done;

    (panel as any)._deleteToTrash = false;
    done = (panel as any)._removeProject(session()) as Promise<void>;
    await openButtons();
    body = document.querySelector('.jp-Dialog-body')!.textContent ?? '';
    expect(body).toContain('deleted permanently. This cannot be undone.');
    pressEnter();
    await done;
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

describe('DEF-132 - a panel docked before the first roster has no root', () => {
  function rootless(): AssistantSessionsPanel {
    return new AssistantSessionsPanel({
      app: {
        serviceManager: { serverSettings: {} },
        commands: { execute: jest.fn() }
      } as any,
      descriptor: { ...DESCRIPTOR, iconName: 'testbed-rootless-panel-spec' },
      rootDir: '',
      fileBrowser: { model: { path: 'data/raw' } } as any
    });
  }

  it('the + button is inert until setRoot supplies the root', async () => {
    const p = rootless();
    await flush();
    request.mockClear();

    // Without the guard this is `/data/raw` - a folder at the filesystem
    // root, which the server accepts whenever it happens to exist.
    expect((p as any)._currentFolder()).toBe('');
    await (p as any)._newSession();
    expect(request).not.toHaveBeenCalled();
    // And the button says so, rather than looking live and doing nothing.
    const newBtn = p.node.querySelector<HTMLButtonElement>(
      '.jp-AiAssistantsPanel-iconButton'
    )!;
    expect(newBtn.disabled).toBe(true);
    expect(newBtn.title).toBe('Waiting for the server root');

    p.setRoot('/srv/lab/', true);
    expect((p as any)._currentFolder()).toBe('/srv/lab/data/raw');
    expect(newBtn.disabled).toBe(false);
    expect(newBtn.title).toMatch(/^New session in current folder/);
    p.setRoot('/', true);
    expect((p as any)._currentFolder()).toBe('/data/raw');
    p.dispose();
  });

  it('the path actions name the missing root, not a folder outside it', async () => {
    const p = rootless();
    await flush();
    const warn = jest.spyOn(Notification, 'warning').mockReturnValue('' as any);

    // The folder is INSIDE the root the server has not sent yet, so blaming
    // the root is the one diagnosis that cannot be acted on (DEF-134).
    (p as any)._activeSession = session({ project_path: '/srv/lab/proj' });
    await (p as any)._commands.execute(commandId('testbed', 'open-terminal'));
    await (p as any)._commands.execute(
      commandId('testbed', 'show-in-filebrowser')
    );
    expect(warn.mock.calls.map(c => String(c[0]))).toEqual([
      'Waiting for the server root - cannot open a terminal yet.',
      'Waiting for the server root - the file browser cannot show it yet.'
    ]);

    // And the outside case is still named, rather than deleted with it.
    warn.mockClear();
    p.setRoot('/srv/lab', true);
    (p as any)._activeSession = session({ project_path: '/elsewhere/proj' });
    await (p as any)._commands.execute(commandId('testbed', 'open-terminal'));
    expect(String(warn.mock.calls[0][0])).toContain(
      'outside the JupyterLab root'
    );
    p.dispose();
  });

  // DEF-136 - the root can land after the rows are already on screen.

  it('a root arriving after the rows redraws their tooltips', async () => {
    const p = rootless();
    await flush();
    render(p, [session()]);

    // Pre-roster the absolute path is the honest fallback.
    const row = p.node.querySelector<HTMLElement>('.jp-AiAssistantsPanel-row')!;
    expect(row.title).toContain('Path: /home/user/proj');

    p.setRoot('/home/user', true);
    expect(
      p.node.querySelector<HTMLElement>('.jp-AiAssistantsPanel-row')!.title
    ).toContain('Path: proj');
    p.dispose();
  });

  it('a root arriving after the rows redraws their labels in path mode', async () => {
    const p = rootless();
    await flush();
    p.setPresentationMode('path');
    render(p, [session()]);
    expect(
      p.node.querySelector('.jp-AiAssistantsPanel-nameText')!.textContent
    ).toBe('/home/user/proj');

    p.setRoot('/home/user', true);
    expect(
      p.node.querySelector('.jp-AiAssistantsPanel-nameText')!.textContent
    ).toBe('proj');
    p.dispose();
  });

  it('an unchanged root does not redraw - the reconcile tick repeats it', async () => {
    const p = rootless();
    await flush();
    render(p, [session()]);
    p.setRoot('/home/user', true);

    const spy = jest.spyOn(p as any, '_render');
    p.setRoot('/home/user', true);
    p.setRoot('/home/user/', true);
    expect(spy).not.toHaveBeenCalled();
    p.dispose();
  });
});

// --------------------------------------------------------------- DEF-138

describe('DEF-138 - a refused listing names the missing binary', () => {
  const banner = (): string =>
    panel.node.querySelector<HTMLElement>('.jp-AiAssistantsPanel-error')!
      .textContent ?? '';

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  /** What `requestAPI` throws for the server's `{"error": "cli_not_found"}` -
   * the only 503 a listing can be refused with. */
  const cliNotFound = (): Error =>
    Object.assign(new Error('cli_not_found'), {
      name: 'ResponseError',
      response: { status: 503 }
    });

  it('names the binary instead of blaming the server', () => {
    (panel as any)._showError(cliNotFound());
    expect(banner()).toContain('`testbed` was not found');
    expect(banner()).not.toContain('Could not reach the server');
  });

  it("leaves a 503 that is not this extension's own alone", () => {
    // What a hub proxy or a stopped single-user server answers: a 503 whose
    // body is HTML, so `requestAPI` hands the raw text through as the message.
    (panel as any)._showError(
      Object.assign(new Error('<html>503 Service Unavailable</html>'), {
        name: 'ResponseError',
        response: { status: 503 }
      })
    );
    expect(banner()).toContain('Could not reach the server');
    expect(banner()).not.toContain('was not found');
  });

  it('leaves the two unanswered-server verdicts alone', () => {
    (panel as any)._showError(
      Object.assign(new Error('timed out'), { name: 'RequestTimeoutError' })
    );
    expect(banner()).toContain('The server is not answering');

    (panel as any)._showError(new TypeError('Failed to fetch'));
    expect(banner()).toContain('Could not reach the server');
  });
});

describe('DEF-PANE-183 - the status dot follows the name in the DOM', () => {
  it('reads the project before its status sentence, and still leads visually', () => {
    const live: IProviderDescriptor = {
      ...DESCRIPTOR,
      iconName: 'testbed-live-panel-spec',
      hasLiveProcess: true
    };
    const livePanel = makePanel(live);
    try {
      render(livePanel, [session({ name: 'alpha', live: true })]);
      const row = livePanel.node.querySelector<HTMLElement>(
        '.jp-AiAssistantsPanel-row'
      )!;
      const order = Array.from(row.children).map(el => el.className);
      const dot = order.findIndex(c => c === 'jp-AiAssistantsPanel-dot');
      const name = order.findIndex(c => c === 'jp-AiAssistantsPanel-name');
      // The DOM order is the accessible order: the name comes first, the
      // dot's sentence after it.
      expect(dot).toBeGreaterThan(name);
      expect(
        row
          .querySelector('.jp-AiAssistantsPanel-dot')!
          .getAttribute('aria-label')
      ).toContain('active');
    } finally {
      livePanel.dispose();
    }
  });
});

describe('DEF-PANE-181 - a successful switch says so', () => {
  it('announces the conversation the project now sits on', async () => {
    const success = jest
      .spyOn(Notification, 'success')
      .mockReturnValue('' as any);
    const target = session({ name: 'proj' });
    (panel as any)._lastBranches = [
      { session_id: 'sid-other', file_mtime: 1, label: 'Second thoughts' }
    ];
    request.mockImplementation((_id: string, route: string) =>
      Promise.resolve(
        route === 'switch'
          ? { requested: 'sid-other', current: 'sid-other' }
          : { sessions: [] }
      )
    );
    await (panel as any)._switchBranch(target, 'sid-other');
    expect(success).toHaveBeenCalledTimes(1);
    expect(success.mock.calls[0][0]).toBe('proj: switched to Second thoughts');
  });

  it('stays quiet when the store could not make it current', async () => {
    const success = jest
      .spyOn(Notification, 'success')
      .mockReturnValue('' as any);
    const warn = jest.spyOn(Notification, 'warning').mockReturnValue('' as any);
    request.mockImplementation((_id: string, route: string) =>
      Promise.resolve(
        route === 'switch'
          ? { requested: 'sid-other', current: 'sid-proj' }
          : { sessions: [] }
      )
    );
    await (panel as any)._switchBranch(session(), 'sid-other');
    expect(success).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('the Manage Sessions popup is handed the current row name', () => {
  it('slices the short id past the provider prefix, as the branch rows do', () => {
    const prefixed: IProviderDescriptor = {
      ...DESCRIPTOR,
      iconName: 'testbed-prefixed-panel-spec',
      sessionIdPrefix: 'session_'
    };
    const p = makePanel(prefixed);
    try {
      (p as any)._activeSession = session({
        name: 'proj',
        session_id: 'session_9f8e7d6c-1111-2222-3333-444455556666'
      });
      (p as any)._openManagePopup();
      const calls = (showManageSessionsPopup as jest.Mock).mock.calls;
      const [options] = calls[calls.length - 1];
      // A front-slice would read `proj (session_)` on every conversation.
      expect(options.currentName).toEqual('proj (9f8e7d6c)');
    } finally {
      p.dispose();
    }
  });
});

describe('DEF-PANE-211 - per-conversation open surfaces on a project-scoped assistant', () => {
  const projectScoped: IProviderDescriptor = {
    ...DESCRIPTOR,
    iconName: 'testbed-project-scope-panel-spec',
    terminalScope: 'project'
  };

  function submenuLabels(p: AssistantSessionsPanel): string[] {
    (p as any)._rebuildContextMenu(true);
    const menu = (p as any)._contextMenu;
    return Array.from({ length: menu.items.length }, (_, i) => menu.items.at(i))
      .filter((item: any) => item.type === 'submenu')
      .map((item: any) => item.submenu.title.label);
  }

  it('offers no Open Branched Conversation submenu - one terminal serves every conversation', () => {
    const p = makePanel(projectScoped);
    try {
      expect(submenuLabels(p)).not.toContain('Open Branched Conversation');
      expect(submenuLabels(p)).toContain('Switch and Manage Sessions');
    } finally {
      p.dispose();
    }
  });

  it('keeps the submenu for a conversation-scoped assistant', () => {
    expect(submenuLabels(panel)).toContain('Open Branched Conversation');
  });

  it("titles the popup Open button with the provider's own verb, not a terminal of its own", () => {
    const p = new AssistantSessionsPanel({
      app: {
        serviceManager: { serverSettings: {} },
        commands: { execute: jest.fn() }
      } as any,
      descriptor: projectScoped,
      hooks: { resumeLabel: () => 'Open Web UI' },
      rootDir: '/home/user'
    });
    try {
      const s = session();
      expect((p as any)._openBranchTitle(s, s.session_id)).toEqual(
        'Open Web UI'
      );
      expect((panel as any)._openBranchTitle(s, s.session_id)).toContain(
        'in its own terminal'
      );
    } finally {
      p.dispose();
    }
  });
});

// ------------------------------------------------------- ACC-SESS-173..175

describe('Rename Session', () => {
  /** A provider whose names live somewhere this extension only reads - Codex's
   * case, and the reason the capability exists at all. */
  const NO_RENAME: IProviderDescriptor = {
    ...DESCRIPTOR,
    iconName: 'testbed-no-rename-panel-spec',
    canRename: false
  };

  function menuLabels(p: AssistantSessionsPanel): string[] {
    (p as any)._rebuildContextMenu(false);
    const menu = (p as any)._contextMenu;
    return Array.from({ length: menu.items.length }, (_, i) => menu.items.at(i))
      .filter((item: any) => item.isVisible !== false)
      .map((item: any) => String(item.label ?? ''));
  }

  /** Answer the rename dialog with `value`, or dismiss it. Returns what the
   * field was seeded with, which is half of what these tests are about. */
  async function answer(value: string | null): Promise<string> {
    await flush();
    const dialog = document.querySelector('.jp-Dialog');
    expect(dialog).not.toBeNull();
    const input = dialog!.querySelector<HTMLInputElement>('input')!;
    const seeded = input.value;
    if (value !== null) {
      input.value = value;
    }
    const buttons = Array.from(
      dialog!.querySelectorAll<HTMLButtonElement>('.jp-Dialog-button')
    );
    // Cancel first, Ok second - `InputDialog.getText`'s own button order.
    buttons[value === null ? 0 : buttons.length - 1].click();
    await flush();
    return seeded;
  }

  it('ACC-SESS-174 - offers the item only where the assistant keeps a writable name', () => {
    expect(menuLabels(panel)).toContain('Rename Session...');
    const p = makePanel(NO_RENAME);
    try {
      expect(menuLabels(p)).not.toContain('Rename Session...');
    } finally {
      p.dispose();
    }
  });

  it('ACC-SESS-173 - sends the trimmed name and reports the one the store kept', async () => {
    request.mockImplementation(() =>
      Promise.resolve({ session_id: 'sid-proj', name: 'Stored' })
    );
    const ok = jest.spyOn(Notification, 'success').mockReturnValue('' as any);
    const row = session({ name: 'Old', name_source: 'session' });
    (panel as any)._activeSession = row;

    const renamed = (panel as any)._renameSession(row) as Promise<void>;
    expect(await answer('  New  ')).toEqual('Old');
    await renamed;

    const call = request.mock.calls.find((c: any[]) => c[1] === 'rename');
    expect(call).toBeDefined();
    expect(JSON.parse(call[3].body)).toEqual({
      encoded_path: row.encoded_path,
      session_id: row.session_id,
      name: 'New'
    });
    // The STORED name, never the typed one.
    expect(String(ok.mock.calls[0][0])).toEqual('Renamed to Stored');
  });

  it('ACC-SESS-175 - an empty field renames nothing and says so', async () => {
    const warn = jest.spyOn(Notification, 'warning').mockReturnValue('' as any);
    const row = session({ name: 'Old', name_source: 'session' });

    const renamed = (panel as any)._renameSession(row) as Promise<void>;
    await answer('   ');
    await renamed;

    expect(request.mock.calls.some((c: any[]) => c[1] === 'rename')).toBe(
      false
    );
    expect(String(warn.mock.calls[0][0])).toEqual(
      'Enter a name - nothing was renamed.'
    );
  });

  it('sends nothing at all when the dialog is dismissed', async () => {
    const renamed = (panel as any)._renameSession(
      session({ name: 'Old', name_source: 'session' })
    ) as Promise<void>;
    await answer(null);
    await renamed;
    expect(request.mock.calls.some((c: any[]) => c[1] === 'rename')).toBe(
      false
    );
  });

  it('seeds the field from the conversation, never from the folder it sits in', async () => {
    // A row named after its directory has no conversation name yet, and
    // seeding the directory would have Ok quietly name it after the folder.
    const renamed = (panel as any)._renameSession(
      session({ name: 'proj', name_source: 'basename' })
    ) as Promise<void>;
    expect(await answer(null)).toEqual('');
    await renamed;
  });

  it('says what a refusal means instead of handing back the code', () => {
    const notFound = { response: { status: 404 } };
    expect(String((panel as any)._renameError(notFound))).toContain(
      'no longer exists'
    );
    expect(
      String((panel as any)._renameError(new Error('rename_failed')))
    ).toEqual('Testbed would not store a name for this conversation.');
    expect(String((panel as any)._renameError(new Error('boom')))).toContain(
      'Rename failed'
    );
  });
});

describe('ACC-CLAU-95, ACC-CLAU-96, ACC-CODE-101 - what the row indicators mean', () => {
  const REMOTE: IProviderDescriptor = {
    ...DESCRIPTOR,
    iconName: 'testbed-remote-panel-spec',
    hasRemoteControl: true,
    hasLiveProcess: true,
    hasBgAgents: false
  };
  const LIVE_ONLY: IProviderDescriptor = {
    ...DESCRIPTOR,
    iconName: 'testbed-liveonly-panel-spec',
    hasRemoteControl: false,
    hasLiveProcess: true,
    hasBgAgents: false
  };
  const NO_BG: IProviderDescriptor = {
    ...DESCRIPTOR,
    iconName: 'testbed-nobg-panel-spec',
    hasBgAgents: false
  };

  /** The indicator's aria-label for the one rendered row, or null when the
   * column holds only its placeholder. */
  function indicator(
    descriptor: IProviderDescriptor,
    row: Partial<ISession>
  ): string | null {
    const p = makePanel(descriptor);
    try {
      render(p, [session({ name: 'alpha', ...row })]);
      const dot = p.node.querySelector('.jp-AiAssistantsPanel-dot');
      if (dot) {
        return dot.getAttribute('aria-label');
      }
      expect(
        p.node.querySelector('.jp-AiAssistantsPanel-dotPlaceholder')
      ).not.toBeNull();
      return null;
    } finally {
      p.dispose();
    }
  }

  it('ACC-CLAU-95 - the dot marks remote control, and a running terminal alone does not', () => {
    expect(indicator(REMOTE, { remote_control: true })).toBe(
      'Remote control session is active'
    );
    // Same provider, same row, no remote control: a live process is a
    // different sentence, and neither is "a terminal is open".
    expect(indicator(REMOTE, { remote_control: false, live: true })).toBe(
      'A Testbed session is active in this project'
    );
    expect(
      indicator(REMOTE, { remote_control: false, live: false })
    ).toBeNull();
  });

  it('ACC-CLAU-95 - remote control outranks a live process on the same row', () => {
    expect(indicator(REMOTE, { remote_control: true, live: true })).toBe(
      'Remote control session is active'
    );
  });

  it('ACC-CLAU-95 - a provider without the capability never shows the remote sentence', () => {
    expect(
      indicator(LIVE_ONLY, { remote_control: true, live: false })
    ).toBeNull();
  });

  it('ACC-CODE-101 - the dot marks a project with the assistant running right now', () => {
    expect(indicator(LIVE_ONLY, { live: true })).toBe(
      'A Testbed session is active in this project'
    );
    expect(indicator(LIVE_ONLY, { live: false })).toBeNull();
  });

  /** The `bg` chip's text for the one rendered row, or null when absent. */
  function chip(
    descriptor: IProviderDescriptor,
    row: Partial<ISession>
  ): string | null {
    const p = makePanel(descriptor);
    try {
      render(p, [session({ name: 'alpha', ...row })]);
      return (
        p.node.querySelector('.jp-AiAssistantsPanel-bgBadge')?.textContent ??
        null
      );
    } finally {
      p.dispose();
    }
  }

  it('ACC-CLAU-96 - a conversation held by a background agent is chipped bg', () => {
    expect(chip(DESCRIPTOR, { bg_id: 'abcd1234' })).toBe('bg');
    expect(chip(DESCRIPTOR, { bg_id: null })).toBeNull();
  });

  it('ACC-CLAU-96 - the chip is a capability, not an assistant', () => {
    // Same row, a provider that declares no background agents.
    expect(chip(NO_BG, { bg_id: 'abcd1234' })).toBeNull();
  });
});

describe('ACC-SESS-55, ACC-SESS-60 - the switcher submenu and Copy Session ID', () => {
  /** One branch row, with the fields the submenu label reads. */
  function branch(over: Partial<IBranch> = {}): IBranch {
    return {
      session_id: 'sid-branch-one',
      label: 'Refactor the loader',
      file_mtime: Date.now() - 7_200_000,
      ...over
    };
  }

  /** The switcher submenu's item labels, excluding its separator and the
   * always-present Manage Sessions entry. */
  function switcherLabels(p: AssistantSessionsPanel): string[] {
    const menu = (p as any)._switchSubmenu;
    const manage = commandId('testbed', 'manage-sessions');
    return Array.from({ length: menu.items.length }, (_, i) => menu.items.at(i))
      .filter((item: any) => item.type === 'command' && item.command !== manage)
      .map((item: any) => String(item.label ?? ''));
  }

  it('ACC-SESS-55 - each entry carries the short id and the last activity', () => {
    const branches = [
      branch({ session_id: 'sid-alpha', label: 'Alpha work' }),
      branch({
        session_id: 'sid-bravo',
        label: 'Bravo work',
        file_mtime: Date.now() - 86_400_000
      })
    ];
    (panel as any)._fillBranchSubmenus(branches);

    const labels = switcherLabels(panel);
    expect(labels).toHaveLength(2);
    // The name, the short id in brackets, and a relative time after a dash.
    expect(labels[0]).toContain('Alpha work');
    expect(labels[0]).toContain('sid-alph');
    expect(labels[0]).toMatch(/ - .+$/);
    expect(labels[1]).toContain('Bravo work');
    // Two conversations of one project differ by id and by time, which is all
    // the submenu has to tell them apart.
    expect(labels[0]).not.toEqual(labels[1]);
    // The count travels with the title, so Manage Sessions is not the only
    // place the project's size is stated.
    expect((panel as any)._switchSubmenu.title.label).toContain('(2)');
  });

  it('ACC-SESS-55 - picking one makes it the row current conversation', () => {
    const rows = [session({ name: 'proj' })];
    render(panel, rows);
    (panel as any)._activeSession = rows[0];
    (panel as any)._fillBranchSubmenus([branch({ session_id: 'sid-alpha' })]);

    const switched = jest
      .spyOn(panel as any, '_switchBranch')
      .mockResolvedValue(undefined);
    const item = (panel as any)._switchSubmenu.items.at(0);
    (panel as any)._commands.execute(item.command, item.args);

    expect(switched).toHaveBeenCalledWith(rows[0], 'sid-alpha');
    switched.mockRestore();
  });

  it('ACC-SESS-60 - Copy Session ID copies the row current conversation id', () => {
    const copied = jest
      .spyOn(Clipboard, 'copyToSystem')
      .mockImplementation(() => undefined);
    try {
      const rows = [session({ name: 'proj' })];
      render(panel, rows);
      (panel as any)._activeSession = rows[0];

      (panel as any)._commands.execute(commandId('testbed', 'copy-session-id'));
      expect(copied).toHaveBeenCalledWith(rows[0].session_id);

      // No row under the pointer copies nothing, rather than an empty string.
      copied.mockClear();
      (panel as any)._activeSession = null;
      (panel as any)._commands.execute(commandId('testbed', 'copy-session-id'));
      expect(copied).not.toHaveBeenCalled();
    } finally {
      copied.mockRestore();
    }
  });
});

describe('ACC-SESS-67 - a conversation another panel deleted first', () => {
  it('reports the failure and refreshes, so no phantom row is left', async () => {
    const errored = jest
      .spyOn(Notification, 'error')
      .mockImplementation(() => '');
    const refreshed = jest
      .spyOn(panel as any, '_fetch')
      .mockResolvedValue(undefined);
    try {
      const rows = [session({ name: 'proj' })];
      render(panel, rows);
      request.mockRejectedValueOnce(
        Object.assign(new Error('remove_failed'), {
          response: { status: 400 }
        })
      );

      const count = await (panel as any)._deleteBranches(rows[0], ['sid-gone']);

      // Null, not zero: nothing is known to have been deleted.
      expect(count).toBeNull();
      expect(errored).toHaveBeenCalledTimes(1);
      expect(String(errored.mock.calls[0][0])).toContain('Delete failed');
      // The list is re-read whatever happened, so the row the other panel
      // removed cannot stay on screen.
      expect(refreshed).toHaveBeenCalled();
    } finally {
      errored.mockRestore();
      refreshed.mockRestore();
    }
  });

  it('forgets the colour of only the conversations the server says went', async () => {
    const refreshed = jest
      .spyOn(panel as any, '_fetch')
      .mockResolvedValue(undefined);
    const forgotten = jest
      .spyOn((panel as any)._colours, 'forget')
      .mockResolvedValue(undefined);
    try {
      const rows = [session({ name: 'proj' })];
      render(panel, rows);
      // Two asked for, one already gone by the time the request landed.
      request.mockResolvedValueOnce({
        removed_count: 1,
        removed_ids: ['sid-here']
      });

      const count = await (panel as any)._deleteBranches(rows[0], [
        'sid-here',
        'sid-gone'
      ]);

      expect(count).toBe(1);
      // A conversation the server did not remove keeps its tint - dropping it
      // would strip the colour of a conversation that is still there.
      expect(forgotten).toHaveBeenCalledWith(['sid-here']);
      expect(refreshed).toHaveBeenCalled();
    } finally {
      refreshed.mockRestore();
      forgotten.mockRestore();
    }
  });
});

describe('ACC-SESS-61, ACC-SESS-62 - what the destructive confirmations state', () => {
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

  it('ACC-SESS-61 - the removal confirmation names the project it drops', async () => {
    const row = session({ name: 'ledger-tools' });
    const done = (panel as any)._removeProject(row) as Promise<void>;
    await openButtons();
    const body = document.querySelector('.jp-Dialog-body')!.textContent ?? '';

    // The name, not just the word "project": two rows differ only by it, and
    // this dialog drops an entire history.
    expect(body).toContain('ledger-tools');
    expect(body).toContain('entire project history');
    pressEnter();
    await done;
    expect(request).not.toHaveBeenCalled();
  });

  it('ACC-SESS-62 - the cleanup confirmation states how many go and that one stays', async () => {
    const row = session({ name: 'ledger-tools', extra_sessions: 3 });
    const done = (panel as any)._cleanupParallel(row) as Promise<void>;
    await openButtons();
    const body = document.querySelector('.jp-Dialog-body')!.textContent ?? '';

    expect(body).toContain('3 parallel sessions');
    expect(body).toContain('ledger-tools');
    expect(body).toContain('current conversation is kept');
    pressEnter();
    await done;
    expect(request).not.toHaveBeenCalled();
  });

  it('ACC-SESS-62 - one parallel session is counted in the singular', async () => {
    const row = session({ name: 'ledger-tools', extra_sessions: 1 });
    const done = (panel as any)._cleanupParallel(row) as Promise<void>;
    await openButtons();
    const body = document.querySelector('.jp-Dialog-body')!.textContent ?? '';

    expect(body).toContain('1 parallel session from');
    pressEnter();
    await done;
  });
});

describe('ACC-PANE-35..45 - what a row and a section show', () => {
  const MINUTE = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  const rowEls = (p: AssistantSessionsPanel): HTMLElement[] =>
    Array.from(
      p.node.querySelectorAll<HTMLElement>('.jp-AiAssistantsPanel-row')
    );

  const sectionLabels = (p: AssistantSessionsPanel): string[] =>
    Array.from(
      p.node.querySelectorAll<HTMLElement>('.jp-AiAssistantsPanel-sectionLabel')
    ).map(el => el.textContent ?? '');

  it('ACC-PANE-35 - Favorites, Recent and All each get their own scrolling list', () => {
    // Recent earns a heading only above the limit, so the limit is lowered
    // rather than eleven rows built.
    panel.setRecentLimit(1);
    render(panel, [
      session({ name: 'alpha', favourite: true }),
      session({ name: 'bravo' })
    ]);

    const labels = sectionLabels(panel);
    expect(labels.some(l => l.startsWith('Favorites'))).toBe(true);
    expect(labels.some(l => l.startsWith('Recent'))).toBe(true);
    expect(labels.some(l => l.startsWith('All'))).toBe(true);
    // One list per section, each its own scroll container.
    expect(
      panel.node.querySelectorAll('.jp-AiAssistantsPanel-list')
    ).toHaveLength(3);
    // The heading states its own size.
    expect(labels.find(l => l.startsWith('Favorites'))).toContain('(1)');
  });

  it('ACC-PANE-37 - the activity column reads now, m, h and d ago', () => {
    const now = Date.now();
    render(panel, [
      session({ name: 'a', file_mtime: now - 10_000 }),
      session({ name: 'b', file_mtime: now - 5 * MINUTE }),
      session({ name: 'c', file_mtime: now - 2 * HOUR }),
      session({ name: 'd', file_mtime: now - 3 * DAY })
    ]);

    const times = rowEls(panel).map(
      row =>
        row.querySelector('.jp-AiAssistantsPanel-rowTime')?.textContent ?? ''
    );
    expect(times).toEqual(
      expect.arrayContaining(['now', '5m ago', '2h ago', '3d ago'])
    );
    // One column, one element per row - what makes it align.
    expect(times).toHaveLength(4);
  });

  it('ACC-PANE-38 - a row active this minute is marked, one idle over a week dims', () => {
    const now = Date.now();
    render(panel, [
      session({ name: 'fresh', file_mtime: now - 10_000 }),
      session({ name: 'middling', file_mtime: now - 2 * DAY }),
      session({ name: 'old', file_mtime: now - 8 * DAY })
    ]);

    const mods = new Map(
      rowEls(panel).map(row => [
        row.querySelector('.jp-AiAssistantsPanel-nameText')?.textContent ?? '',
        row.className
      ])
    );
    expect(mods.get('fresh')).toContain('jp-mod-recentlyActive');
    expect(mods.get('old')).toContain('jp-mod-stale');
    // In between takes neither, or the emphasis says nothing.
    expect(mods.get('middling')).not.toContain('jp-mod-recentlyActive');
    expect(mods.get('middling')).not.toContain('jp-mod-stale');
  });

  it('ACC-PANE-39 - the favourite entry names the direction it will move the row', () => {
    const plain = session({ name: 'alpha', favourite: false });
    const starred = session({ name: 'bravo', favourite: true });
    const cmds = (panel as any)._commands;
    const id = commandId('testbed', 'toggle-favourite');

    (panel as any)._activeSession = plain;
    expect(cmds.label(id)).toEqual('Add to Favorites');
    (panel as any)._activeSession = starred;
    expect(cmds.label(id)).toEqual('Remove from Favorites');

    const toggled = jest
      .spyOn(panel as any, '_toggleFavourite')
      .mockResolvedValue(undefined);
    cmds.execute(id);
    expect(toggled).toHaveBeenCalledWith(starred);
    toggled.mockRestore();
  });

  it('ACC-PANE-40 - the filter narrows the rows and clearing it restores them', () => {
    const rows = [
      session({ name: 'ledger-tools' }),
      session({ name: 'photo-pipeline' })
    ];
    render(panel, rows);
    expect(rowEls(panel)).toHaveLength(2);

    const shown = (): string[] =>
      rowEls(panel).map(
        row =>
          row.querySelector('.jp-AiAssistantsPanel-nameText')?.textContent ?? ''
      );

    (panel as any)._filter = 'ledger';
    (panel as any)._render();
    expect(shown()).toEqual(['ledger-tools']);

    // Fuzzy, not just a substring: the tolerance is 5 percent of the query, so
    // a long enough query survives one typo. A short one does not, and that is
    // deliberate - at four characters a one-edit window matches almost
    // anything.
    (panel as any)._filter = 'photo-pipelien';
    (panel as any)._render();
    expect(shown()).toEqual(['photo-pipeline']);

    (panel as any)._filter = '';
    (panel as any)._render();
    expect(rowEls(panel)).toHaveLength(2);
  });

  it('ACC-PANE-41 - presentation mode labels by session name or by path under the root', () => {
    const row = session({ name: 'ledger-tools' });
    row.project_path = '/home/user/work/ledger-tools';

    panel.setPresentationMode('name');
    render(panel, [row]);
    expect(
      panel.node.querySelector('.jp-AiAssistantsPanel-nameText')?.textContent
    ).toEqual('ledger-tools');

    // The panel's root is /home/user, so the path shows relative to it.
    panel.setPresentationMode('path');
    render(panel, [row]);
    expect(
      panel.node.querySelector('.jp-AiAssistantsPanel-nameText')?.textContent
    ).toEqual('work/ledger-tools');
  });

  it('ACC-PANE-42 - the row tooltip names path, activity, messages, conversations, branch and id', () => {
    const row = session({
      name: 'ledger-tools',
      message_count: 12,
      extra_sessions: 2,
      git_branch: 'feature/rename',
      file_mtime: Date.now() - 2 * HOUR
    });
    row.project_path = '/home/user/work/ledger-tools';

    const tip = (panel as any)._buildRowTooltip(row) as string;
    expect(tip).toContain('Path: work/ledger-tools');
    expect(tip).toContain('Last activity:');
    expect(tip).toContain('(2h ago)');
    expect(tip).toContain('Messages: 12');
    // The row's own conversation plus the extras.
    expect(tip).toContain('Conversations: 3');
    expect(tip).toContain('Branch: feature/rename');
    expect(tip).toContain(`Session id: ${row.session_id}`);
  });

  it('ACC-PANE-43 - the refresh command reloads this panel and no other', async () => {
    const other = makePanel({
      ...DESCRIPTOR,
      iconName: 'testbed-other-panel-spec'
    });
    try {
      const mine = jest
        .spyOn(panel as any, '_fetch')
        .mockResolvedValue(undefined);
      const theirs = jest
        .spyOn(other as any, '_fetch')
        .mockResolvedValue(undefined);

      panel.refresh();
      await flush();

      expect(mine).toHaveBeenCalled();
      expect(theirs).not.toHaveBeenCalled();
      mine.mockRestore();
      theirs.mockRestore();
    } finally {
      other.dispose();
    }
  });

  it('ACC-PANE-45 - a provider with no sessions says so and names the way out', () => {
    render(panel, []);
    const messages = Array.from(
      panel.node.querySelectorAll('.jp-AiAssistantsPanel-empty')
    ).map(el => el.textContent ?? '');

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual('No Testbed sessions found.');
    expect(messages[1]).toContain('Use + to start a session');
    // Not a blank panel: no rows, but the body is not empty either.
    expect(rowEls(panel)).toHaveLength(0);
  });
});

describe('ACC-PANE-46, ACC-PANE-48 - the header menu when unarmed, and a panel that cannot list', () => {
  it('ACC-PANE-48 - the menu reads exactly New session and New session (mode), with no provider name', () => {
    const menu = (panel as any)._newSessionMenu;
    const labels = Array.from({ length: menu.items.length }, (_, i) =>
      menu.items.at(i)
    )
      .filter((item: any) => item.isVisible !== false)
      .map((item: any) => String(item.label ?? ''));

    expect(labels).toEqual(['New session', 'New session (Skip Permissions)']);
    // The panel already carries the assistant's name in its title; repeating
    // it in every entry is what made the menu unreadable at sidebar width.
    for (const label of labels) {
      expect(label).not.toContain('Testbed');
    }
  });

  it('ACC-PANE-49 - with the mode armed the second entry withdraws, leaving one choice', () => {
    panel.setModes({ skip: true });
    const menu = (panel as any)._newSessionMenu;
    const visible = Array.from({ length: menu.items.length }, (_, i) =>
      menu.items.at(i)
    ).filter((item: any) => item.isVisible !== false);

    // Both entries would build the same launch, so a two-entry menu would be
    // one choice pretending to be two. The button launches instead, which
    // ui-tests/tests/panel-regressions.spec.ts DEF-115 asserts on screen.
    expect(visible).toHaveLength(1);
    expect((panel as any)._visibleVariantCount()).toBe(0);
    panel.setModes({ skip: false });
  });

  it('ACC-PANE-46 - an error in one panel leaves another panel listing', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const other = makePanel({
      ...DESCRIPTOR,
      iconName: 'testbed-unaffected-panel-spec'
    });
    try {
      render(other, [session({ name: 'still-here' })]);
      (panel as any)._showError(new TypeError('Failed to fetch'));

      // The failing panel says so, in its own body.
      expect(
        panel.node.querySelector('.jp-AiAssistantsPanel-error')?.textContent
      ).toContain('Could not reach the server');
      // The other panel is untouched: its rows and its error slot both.
      expect(
        other.node.querySelectorAll('.jp-AiAssistantsPanel-row')
      ).toHaveLength(1);
      const otherBanner = other.node.querySelector(
        '.jp-AiAssistantsPanel-error'
      ) as HTMLElement | null;
      expect(otherBanner?.textContent ?? '').toEqual('');
    } finally {
      other.dispose();
    }
  });

  it('ACC-PANE-46 - a failed listing does not stop the panel polling', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (panel as any)._showError(new TypeError('Failed to fetch'));

    // The next poll still runs and clears the banner once it answers.
    request.mockResolvedValueOnce({ sessions: [] });
    await (panel as any)._fetch();

    expect(
      panel.node.querySelector('.jp-AiAssistantsPanel-error')?.textContent ?? ''
    ).toEqual('');
  });
});
