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
import { CommandRegistry } from '@lumino/commands';
import { addIcon, branchIcon, cleanupIcon, shieldIcon } from '../core/icons';
import {
  AssistantSessionsPanel,
  MOVE_PANELS_COMMAND,
  SYNC_FILE_BROWSER_COMMAND,
  commandId
} from '../core/panel';
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
  forkStrategy: 'server-native',
  colourSource: 'derived',
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

describe('ACC-SESS-203 - automatic branch names', () => {
  it.each(['server-copy', 'server-native'] as const)(
    '%s requests a numbered name and resumes the returned child without a dialog',
    async forkStrategy => {
      const target = makePanel({ ...DESCRIPTOR, forkStrategy });
      const parent = session({ name: 'analysis', name_source: 'session' });
      const launch = jest.fn().mockResolvedValue({});
      (target as any)._terminals.launch = launch;
      (target as any)._activeSession = parent;
      (target as any)._fetch = jest.fn().mockResolvedValue(undefined);
      request.mockImplementation((_provider, path) =>
        Promise.resolve(path === 'branch' ? { session_id: 'child' } : {})
      );
      try {
        await (target as any)._branchSession();
        const branch = request.mock.calls.find(call => call[1] === 'branch')!;
        expect(JSON.parse(branch[3]!.body as string)).toEqual({
          encoded_path: parent.encoded_path,
          session_id: parent.session_id,
          base_name: 'analysis'
        });
        expect(document.querySelector('.jp-Dialog')).toBeNull();
        expect(launch).toHaveBeenCalledWith(
          expect.objectContaining({ session_id: 'child' }),
          'child'
        );
      } finally {
        target.dispose();
        request.mockImplementation(() => Promise.resolve({}));
      }
    }
  );
});

describe('a branch whose terminal launch was refused after the mint', () => {
  it('says the branch was created and still lists it when the launch is refused', async () => {
    // The DeepSeek preflight refuses the follow-up launch with a 409 whose
    // body is words, but by then the branch POST has already returned 200 with
    // the minted id - the row exists server-side. The user is told that, and
    // the refresh that surfaces the row still runs; "Could not branch this
    // session" would report the whole action as failed and leave the branch
    // invisible until the next poll.
    const target = makePanel({ ...DESCRIPTOR, forkStrategy: 'server-copy' });
    const parent = session({ name: 'analysis', name_source: 'session' });
    const child = session({
      name: 'analysis_1',
      session_id: 'child',
      encoded_path: 'enc-child'
    });
    const refusal =
      'the TUI profile is not mounted; run dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui';
    (target as any)._terminals.launch = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error(refusal), { response: { status: 409 } })
      );
    (target as any)._activeSession = parent;
    request.mockImplementation((_id: string, path: string) =>
      Promise.resolve(
        path === 'branch'
          ? { session_id: 'child' }
          : path === 'sessions'
            ? { sessions: [parent, child] }
            : {}
      )
    );
    const errored = jest
      .spyOn(Notification, 'error')
      .mockImplementation(() => '');
    try {
      await (target as any)._branchSession();

      // What the user is told: the branch was created, its terminal did not
      // open, and the refusal's own words - neither sentence that blames the
      // branch itself.
      expect(errored).toHaveBeenCalledTimes(1);
      const told = String(errored.mock.calls[0][0]);
      expect(told).toContain('Branch created; its terminal did not open');
      expect(told).toContain(refusal);
      expect(told).not.toContain('cannot branch this conversation');
      expect(told).not.toContain('Could not branch this session');

      // The toast budget, by arithmetic rather than by eye: JupyterLab shows
      // a toast's first 140 characters and clips the rest, and a store may
      // raise a message of up to 97 (tests/test_provider_stores.py holds the
      // DeepSeek refusal to that), so the panel's copy plus ": " gets
      // 140 - 2 - 97 = 41 characters. This reddens when a reworded copy
      // grows past the budget - the 55-character "The branch was created,
      // but its terminal could not open" only showed the cut in a browser
      // toast, with the store's command sliced mid-name.
      const copy = told.slice(0, told.indexOf(refusal) - 2);
      expect(copy.length + 2 + 97).toBeLessThanOrEqual(140);

      // The list was re-read, so the new branch is on screen rather than
      // waiting for the next poll.
      expect(
        (target as any)._sessions.map((s: ISession) => s.session_id)
      ).toContain('child');
      const names = Array.from(
        target.node.querySelectorAll('.jp-AiAssistantsPanel-nameText')
      ).map(node => node.textContent);
      expect(names).toContain('analysis_1');
    } finally {
      errored.mockRestore();
      target.dispose();
      request.mockImplementation(() => Promise.resolve({}));
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

  it('names the mode on a row a live worker holds, which is resumed too', () => {
    panel.setModes({ skip: true });
    // The click stops the worker and resumes the conversation, and a resume
    // carries the mode (DEF-PROV-272).
    const text = tooltip([session({ bg_id: 'abcd1234' })]);
    expect(text).toContain(
      'Background agent: abcd1234 (click stops it and resumes here)'
    );
    expect(text).toContain('Launch mode: Skip Permissions');
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

describe('per-conversation open surfaces', () => {
  function submenuLabels(p: AssistantSessionsPanel): string[] {
    (p as any)._rebuildContextMenu(true);
    const menu = (p as any)._contextMenu;
    return Array.from({ length: menu.items.length }, (_, i) => menu.items.at(i))
      .filter((item: any) => item.type === 'submenu')
      .map((item: any) => item.submenu.title.label);
  }

  it('offers the Open Branched Conversation submenu', () => {
    expect(submenuLabels(panel)).toContain('Open Branched Conversation');
  });

  it('titles the popup Open button as a terminal of its own', () => {
    expect((panel as any)._openBranchTitle()).toContain('in its own terminal');
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

// ------------------------------------------------------- ACC-SESS-190..192

describe('ACC-SESS-190..192 - opening a session moves the file browser', () => {
  const GO_TO_PATH = 'filebrowser:go-to-path';

  /** A project two folders under the panel's root, so the path the file
   * browser is given can only be the one relative to that root. */
  const nested = (): ISession =>
    session({
      name: 'ledger-tools',
      project_path: '/home/user/work/ledger-tools'
    });
  const MOVE_TO_NESTED = [
    GO_TO_PATH,
    { path: 'work/ledger-tools', dontShowBrowser: true }
  ];

  /** Every command a panel ran on the application registry. */
  const appCalls = (p: AssistantSessionsPanel): unknown[][] =>
    ((p as any)._app.commands.execute as jest.Mock).mock.calls;

  /** The calls among them that move the file browser. */
  const moves = (p: AssistantSessionsPanel): unknown[][] =>
    appCalls(p).filter(([id]) => id === GO_TO_PATH);

  /** Replace the terminal open, which is not under test here. The open
   * resolves or rejects as the test decides, and no launch request is sent. */
  const stubOpen = (
    p: AssistantSessionsPanel,
    outcome: () => Promise<void> = () => Promise.resolve()
  ): jest.Mock => {
    const open = jest.fn(outcome);
    (p as any)._terminals.openSession = open;
    return open;
  };

  const rowEl = (p: AssistantSessionsPanel): HTMLElement =>
    p.node.querySelector<HTMLElement>('.jp-AiAssistantsPanel-row')!;

  /** The messages of the notifications on screen. Read from the notification
   * manager, so a notification of any type is included. */
  const notified = (): string[] =>
    Notification.manager.notifications.map(n => n.message);

  beforeEach(() => {
    Notification.manager.dismiss();
  });

  afterEach(() => {
    Notification.manager.dismiss();
  });

  /** Each way a user opens a session, started from the control the user
   * uses for it. */
  const routes: Array<
    [string, (p: AssistantSessionsPanel, row: ISession) => void]
  > = [
    ['a row click', p => rowEl(p).click()],
    [
      'Enter on a row',
      p =>
        rowEl(p).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    ],
    [
      'Space on a row',
      p => rowEl(p).dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))
    ],
    [
      'Resume',
      (p, row) => {
        (p as any)._activeSession = row;
        (p as any)._commands.execute(commandId('testbed', 'resume'));
      }
    ],
    [
      'Resume in a launch mode',
      (p, row) => {
        (p as any)._activeSession = row;
        (p as any)._commands.execute(commandId('testbed', 'resume-skip'));
      }
    ],
    [
      'an Open Branched Conversation item',
      (p, row) => {
        (p as any)._activeSession = row;
        (p as any)._fillBranchSubmenus([
          { session_id: 'sid-branch', label: 'Second thoughts', file_mtime: 1 }
        ]);
        const item = (p as any)._openBranchSubmenu.items[0];
        (p as any)._commands.execute(item.command, item.args);
      }
    ],
    [
      'the Manage Sessions Open button',
      (p, row) => {
        (p as any)._activeSession = row;
        (p as any)._openManagePopup();
        const calls = (showManageSessionsPopup as jest.Mock).mock.calls;
        calls[calls.length - 1][0].onOpen('sid-branch');
      }
    ]
  ];

  it.each(routes)(
    'ACC-SESS-190 - %s moves the file browser to the row folder under the root',
    async (_route, open) => {
      const opened = stubOpen(panel);
      const row = nested();
      render(panel, [row]);

      open(panel, row);
      await flush();

      expect(opened).toHaveBeenCalledTimes(1);
      expect(moves(panel)).toEqual([MOVE_TO_NESTED]);
    }
  );

  it('ACC-SESS-190 - a project at the root itself gives the empty path', async () => {
    stubOpen(panel);
    render(panel, [session({ project_path: '/home/user' })]);

    rowEl(panel).click();
    await flush();

    expect(moves(panel)).toEqual([
      [GO_TO_PATH, { path: '', dontShowBrowser: true }]
    ]);
  });

  it('ACC-SESS-190 - the file browser moves only once the open has resolved', async () => {
    let finishOpen!: () => void;
    stubOpen(
      panel,
      () =>
        new Promise<void>(resolve => {
          finishOpen = resolve;
        })
    );
    render(panel, [nested()]);

    rowEl(panel).click();
    await flush();
    // The open has not resolved yet, so no session is open.
    expect(moves(panel)).toEqual([]);

    finishOpen();
    await flush();
    expect(moves(panel)).toEqual([MOVE_TO_NESTED]);
  });

  it('ACC-SESS-190 - an open that reuses the running terminal moves the file browser again', async () => {
    // This test alone uses the real terminal manager: the first open launches
    // a terminal, and the second open finds that terminal and focuses it.
    const p = new AssistantSessionsPanel({
      app: {
        serviceManager: { serverSettings: {} },
        shell: { activateById: jest.fn() },
        commands: {
          execute: jest.fn(async (id: string) =>
            id === 'terminal:open'
              ? { id: 'terminal-1', isDisposed: false }
              : undefined
          )
        }
      } as any,
      descriptor: { ...DESCRIPTOR, iconName: 'testbed-reuse-panel-spec' },
      rootDir: '/home/user'
    });
    try {
      await flush();
      request.mockClear();
      request.mockImplementation((_id: string, route: string) =>
        Promise.resolve(route === 'launch' ? { terminal_name: 'term-1' } : {})
      );
      const row = nested();

      await (p as any)._openSession(row);
      await flush();
      await (p as any)._openSession(row);
      await flush();

      // One launch for two opens, so the second open reused the terminal.
      expect(
        request.mock.calls.filter(([, route]) => route === 'launch')
      ).toHaveLength(1);
      expect(moves(p)).toEqual([MOVE_TO_NESTED, MOVE_TO_NESTED]);
    } finally {
      // Restore the default answer.
      request.mockImplementation(() => Promise.resolve({}));
      p.dispose();
    }
  });

  it('ACC-SESS-191 - the move carries dontShowBrowser: true and is the only application command', async () => {
    stubOpen(panel);
    render(panel, [nested()]);

    rowEl(panel).click();
    await flush();

    // Without the flag JupyterLab activates the file browser tab, which hides
    // an assistant panel docked in the same sidebar.
    expect(moves(panel)).toHaveLength(1);
    expect((moves(panel)[0][1] as any).dontShowBrowser).toBe(true);
    // The move is also the only application command the open ran, so no
    // second command activates the file browser.
    expect(appCalls(panel)).toHaveLength(1);
  });

  it('ACC-SESS-192 - with the setting off nothing moves and no notification appears', async () => {
    const opened = stubOpen(panel);
    panel.setSyncFileBrowser(false);
    render(panel, [nested()]);

    rowEl(panel).click();
    await flush();

    // The session was opened. Only the file browser move was skipped.
    expect(opened).toHaveBeenCalledTimes(1);
    expect(moves(panel)).toEqual([]);
    expect(notified()).toEqual([]);
  });

  it('ACC-SESS-192 - a project folder outside the server root moves nothing and no notification appears', async () => {
    const opened = stubOpen(panel);
    render(panel, [session({ project_path: '/elsewhere/proj' })]);

    rowEl(panel).click();
    await flush();

    expect(opened).toHaveBeenCalledTimes(1);
    expect(moves(panel)).toEqual([]);
    expect(notified()).toEqual([]);
  });

  it('ACC-SESS-192 - an unknown server root moves nothing and no notification appears', async () => {
    // A panel docked before the first status roster has no root yet.
    const p = new AssistantSessionsPanel({
      app: {
        serviceManager: { serverSettings: {} },
        commands: { execute: jest.fn() }
      } as any,
      descriptor: { ...DESCRIPTOR, iconName: 'testbed-rootless-sync-spec' },
      rootDir: ''
    });
    try {
      await flush();
      const opened = stubOpen(p);
      render(p, [nested()]);

      rowEl(p).click();
      await flush();

      expect(opened).toHaveBeenCalledTimes(1);
      expect(moves(p)).toEqual([]);
      expect(notified()).toEqual([]);
    } finally {
      p.dispose();
    }
  });

  it('ACC-SESS-192 - a failed open moves nothing, and the only notification is the failed open', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const opened = stubOpen(panel, () =>
      Promise.reject(new Error('launch refused'))
    );
    render(panel, [nested()]);

    rowEl(panel).click();
    await flush();

    expect(opened).toHaveBeenCalledTimes(1);
    expect(moves(panel)).toEqual([]);
    // One notification, and it is the one the failed open raises itself.
    expect(notified()).toHaveLength(1);
    expect(notified()[0]).toContain('Could not open that conversation');
  });

  it('ACC-SESS-192 - a rejected file browser move is never reported as a failed open', async () => {
    const logged = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const opened = stubOpen(panel);
    ((panel as any)._app.commands.execute as jest.Mock).mockRejectedValue(
      new Error('no such folder')
    );
    render(panel, [nested()]);

    rowEl(panel).click();
    await flush();

    // The session was opened and the move was requested.
    expect(opened).toHaveBeenCalledTimes(1);
    expect(moves(panel)).toHaveLength(1);
    // The rejection is one console line and no notification.
    expect(notified()).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0].join(' ')).toContain('no such folder');
  });

  it('DEF-PANE-298 - a move waits for the move of an earlier open, also one of another panel', async () => {
    // The first panel's move stays unfinished until the test finishes it.
    let finishFirstMove: () => void = () => undefined;
    ((panel as any)._app.commands.execute as jest.Mock).mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishFirstMove = resolve;
        })
    );
    stubOpen(panel);
    render(panel, [nested()]);
    const other = makePanel();
    await flush();
    try {
      stubOpen(other);
      render(other, [session({ name: 'notes' })]);

      rowEl(panel).click();
      await flush();
      rowEl(other).click();
      await flush();
      // Both opens are done. The second move has not started.
      expect(moves(panel)).toEqual([MOVE_TO_NESTED]);
      expect(moves(other)).toEqual([]);

      finishFirstMove();
      await flush();
      expect(moves(other)).toEqual([
        [GO_TO_PATH, { path: 'notes', dontShowBrowser: true }]
      ]);
    } finally {
      // An unfinished move would hold back the moves of every later test.
      finishFirstMove();
      await flush();
      other.dispose();
    }
  });
});

// ------------------------------------------------------------ ACC-PANE-193

describe('ACC-PANE-193 - the panel header has a context menu of its own', () => {
  const SYNC_LABEL = 'Sync File Browser';
  const MOVE_LABEL = 'Move Panel Left';

  /** A panel on a real application registry that holds the two commands the
   * plugin registers there. */
  let p: AssistantSessionsPanel;
  /** The arguments of every run of the Move command. */
  let moveArgs: unknown[];

  beforeEach(() => {
    moveArgs = [];
    const commands = new CommandRegistry();
    commands.addCommand(SYNC_FILE_BROWSER_COMMAND, {
      label: SYNC_LABEL,
      execute: () => undefined
    });
    commands.addCommand(MOVE_PANELS_COMMAND, {
      label: MOVE_LABEL,
      execute: args => {
        moveArgs.push(args);
      }
    });
    p = new AssistantSessionsPanel({
      app: { serviceManager: { serverSettings: {} }, commands } as any,
      descriptor: { ...DESCRIPTOR, iconName: 'testbed-header-menu-spec' },
      rootDir: '/home/user'
    });
  });

  afterEach(() => {
    // A pointer press outside a menu closes it and detaches it from the
    // document, so a menu one test opened is not on screen in the next test.
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    p.dispose();
  });

  const rightClickHeader = (): MouseEvent => {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 12,
      clientY: 34
    });
    p.node.querySelector('.jp-AiAssistantsPanel-header')!.dispatchEvent(event);
    return event;
  };

  /** One entry per menu on screen: the items it draws, in order. */
  const menusOnScreen = (): Array<{ command: string; label: string }[]> =>
    Array.from(document.querySelectorAll<HTMLElement>('.lm-Menu')).map(menu =>
      Array.from(menu.querySelectorAll<HTMLElement>('.lm-Menu-item')).map(
        item => ({
          command: item.dataset.command ?? '',
          label: item.querySelector('.lm-Menu-itemLabel')?.textContent ?? ''
        })
      )
    );

  it('ACC-PANE-193 - a right-click on the header opens one menu: Sync, then Move', async () => {
    render(p, [session()]);
    expect(menusOnScreen()).toEqual([]);

    rightClickHeader();
    // The row menu opens asynchronously after a right-click, so wait before
    // counting the menus.
    await flush();

    // The labels come from the application registry. A menu built on the
    // panel's own registry would draw the two items with no text.
    expect(menusOnScreen()).toEqual([
      [
        { command: SYNC_FILE_BROWSER_COMMAND, label: SYNC_LABEL },
        { command: MOVE_PANELS_COMMAND, label: MOVE_LABEL }
      ]
    ]);
  });

  it('ACC-PANE-193 - a right-click on the header prevents the browser menu', () => {
    expect(rightClickHeader().defaultPrevented).toBe(true);
  });

  it('ACC-PANE-200 - the Move item tells the command which panel its menu belongs to', async () => {
    rightClickHeader();
    await flush();
    const menu = document.querySelector<HTMLElement>('.lm-Menu')!;
    const press = (keyCode: number): void => {
      menu.dispatchEvent(
        new KeyboardEvent('keydown', { keyCode, bubbles: true })
      );
    };

    press(40); // Down Arrow: Sync File Browser
    press(40); // Down Arrow: Move Panel
    press(13); // Enter

    expect(moveArgs).toEqual([{ panel: p.id }]);
    expect(p.id).not.toBe('');
  });

  it('DEF-PANE-290 - a header right-click stands down a row menu that is still loading', async () => {
    // The row has other conversations, so its menu waits for their listing.
    let arrive: () => void = () => undefined;
    const arrived = new Promise<void>(resolve => {
      arrive = resolve;
    });
    request.mockImplementation(() =>
      arrived.then(() => ({ branches: [], current: '' }))
    );
    render(p, [session({ extra_sessions: 2 })]);
    const row = p.node.querySelector<HTMLElement>('.jp-AiAssistantsPanel-row')!;
    row.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );
    // The row is highlighted while its menu loads.
    expect(row.classList.contains('jp-mod-active')).toBe(true);
    rightClickHeader();

    // The listing arrives after the header menu has opened.
    arrive();
    await flush();

    expect(menusOnScreen()).toEqual([
      [
        { command: SYNC_FILE_BROWSER_COMMAND, label: SYNC_LABEL },
        { command: MOVE_PANELS_COMMAND, label: MOVE_LABEL }
      ]
    ]);
    // The row whose menu stood down is no longer highlighted.
    expect(p.node.querySelectorAll('.jp-mod-active')).toHaveLength(0);
  });
});
