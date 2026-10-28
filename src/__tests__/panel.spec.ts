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

import { Clipboard, Dialog, Notification } from '@jupyterlab/apputils';
import { copyIcon } from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';

import { readFileSync } from 'fs';
import { join } from 'path';

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
      commands: { execute: jest.fn() },
      shell: { activateById: jest.fn() }
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
  // Every case starts from the module factory's empty answer; `mockClear`
  // alone left the previous case's implementation in place for the next one.
  request.mockReset();
  request.mockImplementation(() => Promise.resolve({}));
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

  it('says a deletion may be permanent when the trash might refuse', async () => {
    // Default: trash is on, but the server falls back to a permanent removal
    // when no trash accepts the move.
    let done = (panel as any)._removeProject(session()) as Promise<void>;
    await openButtons();
    let body = document.querySelector('.jp-Dialog-body')!.textContent ?? '';
    expect(body).toContain(
      'moved to the trash when the system accepts them; a refused move may remove them permanently or leave them in place'
    );
    expect(body).toContain('A permanent removal cannot be undone');
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

    // The DELETE, then the listing refetched after it (DEF-PANE-351).
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][3]).toMatchObject({ method: 'DELETE' });
    expect(request.mock.calls[1][1]).toBe('sessions');
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

    // The question's own branches fetch has run; cancelling stops before the
    // removal, so no DELETE is sent and no progress dialog is raised.
    expect(
      request.mock.calls.filter(call => call[3]?.method === 'DELETE')
    ).toHaveLength(0);
    expect(
      document.querySelector('.jp-AiAssistantsPanel-cleanupBody')
    ).toBeNull();
  });

  it('Clean Up Parallel Sessions: Enter on the Remove button still cleans up', async () => {
    // Same non-vacuity guard as above: the harness can see the removal, so
    // "no DELETE" above means the keyboard landed elsewhere and not that the
    // probe is blind.
    request.mockImplementation(() =>
      Promise.resolve({
        current: 'sid-proj',
        total: 2,
        branches: [
          { session_id: 'sid-branch', file_mtime: 1, label: 'Branch' }
        ],
        removed_count: 1
      })
    );
    const done = (panel as any)._cleanupParallel(
      session({ name: 'proj', extra_sessions: 3 })
    ) as Promise<void>;
    (await openButtons())[1].focus();
    pressEnter();
    await flush();

    const deletes = request.mock.calls.filter(
      call => call[3]?.method === 'DELETE'
    );
    expect(deletes).toHaveLength(1);
    expect(JSON.parse(deletes[0][3].body).session_ids).toEqual(['sid-branch']);
    expect(
      document.querySelector('.jp-AiAssistantsPanel-cleanupBody')
    ).not.toBeNull();
    // The progress dialog's body is a Widget, which leaves showDialog no
    // string to name it from, so the panel names it from the title.
    expect(
      document.querySelector('.jp-Dialog')!.getAttribute('aria-label')
    ).toContain('Clean Up Parallel Sessions');
    // Let the removal finish before the dialog is dismissed below.
    await done;
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

describe('ACC-PANE-218 - the history-deleting entries carry the danger class', () => {
  it('paints the label and the icon with the error colour and leaves the background alone', () => {
    // jsdom applies no stylesheet, so the rule that makes the class visible is
    // read as text. The label inherits the item's color; JupyterLab's selected
    // rule sets only the background, so nothing here may set one, nor the
    // inverse text colour the superseded filled row used.
    const css = readFileSync(
      join(__dirname, '..', '..', 'style', 'base.css'),
      'utf8'
    );
    expect(css).toMatch(
      /\.jp-AiAssistantsContextMenu-danger\s*\{[^}]*color:\s*var\(--jp-error-color1\)/
    );
    expect(css).toMatch(
      /\.jp-AiAssistantsContextMenu-danger \.jp-icon3\[fill\]\s*\{[^}]*fill:\s*var\(--jp-error-color1\)/
    );
    const rules = [
      ...css.matchAll(
        /([^{}]*\.jp-AiAssistantsContextMenu-danger[^{}]*)\{([^}]*)\}/g
      )
    ];
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const [, selector, body] of rules) {
      expect(selector).not.toContain('.lm-mod-active');
      expect(body).not.toMatch(/\bbackground\b/);
      expect(body).not.toContain('--jp-ui-inverse-font-color1');
    }
  });

  it('puts the class on cleanup-parallel and remove, and on no other entry', () => {
    // base.css draws the icon of this class in --jp-error-color1; the menu
    // item takes the class from the command options.
    const commands = (panel as any)._commands as CommandRegistry;
    const marked = commands
      .listCommands()
      .filter(id => commands.className(id, {}) !== '');
    expect(marked.sort()).toEqual(
      [
        commandId(DESCRIPTOR.id, 'cleanup-parallel'),
        commandId(DESCRIPTOR.id, 'remove')
      ].sort()
    );
    for (const id of marked) {
      expect(commands.className(id, {})).toBe(
        'jp-AiAssistantsContextMenu-danger'
      );
    }
  });
});

describe('ACC-PANE-219 - the copy entries carry the copy icon', () => {
  it('gives Copy Path and Copy Session ID copyIcon', () => {
    const commands = (panel as any)._commands as CommandRegistry;
    for (const action of ['copy-path', 'copy-session-id']) {
      expect(commands.icon(commandId(DESCRIPTOR.id, action), {})).toBe(
        copyIcon
      );
    }
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
          'child',
          expect.any(Number)
        );
      } finally {
        target.dispose();
        request.mockImplementation(() => Promise.resolve({}));
      }
    }
  );
});

describe('click-time spinner dialog (DEF-PANE-318, DEF-PANE-327-BUSY-MODAL-1)', () => {
  /** The spinner dialogs on screen. `Dialog.launch` attaches behind a
   * launch-queue promise, so callers flush first. */
  const spinners = (): HTMLElement[] =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '.jp-Dialog.jp-AiAssistantsPanel-spinnerDialog'
      )
    );
  const title = (): string =>
    spinners()[0]?.querySelector('.jp-Dialog-header')?.textContent ?? '';

  it('raises the launch title on the click, before the open settles', async () => {
    const target = makePanel(DESCRIPTOR);
    let release!: () => void;
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    const open = jest.fn((..._args: unknown[]) => pending);
    (target as any)._terminals.openSession = open;
    (target as any)._fetch = jest.fn().mockResolvedValue(undefined);
    let call: Promise<void> | undefined;
    try {
      call = (target as any)._openSession(session());
      await flush();
      // The title the launch itself uses, so a launch that joins this dialog
      // changes nothing the user can see.
      expect(spinners()).toHaveLength(1);
      expect(title()).toBe('Opening Testbed');
      // The click's token, which the launch joins.
      expect(open.mock.calls[0][3]).toEqual(expect.any(Number));

      release();
      await call;
      await flush();
      expect(spinners()).toHaveLength(0);
    } finally {
      release();
      await call?.catch(() => undefined);
      target.dispose();
    }
  });

  it('names the branch for the assistant session while the request is pending', async () => {
    const target = makePanel(DESCRIPTOR);
    const parent = session({ name: 'analysis', name_source: 'session' });
    (target as any)._terminals.launch = jest.fn().mockResolvedValue({});
    (target as any)._activeSession = parent;
    (target as any)._fetch = jest.fn().mockResolvedValue(undefined);
    let release!: (value: unknown) => void;
    const pending = new Promise(resolve => {
      release = resolve;
    });
    request.mockImplementation((_provider, path) =>
      path === 'branch' ? pending : Promise.resolve({})
    );
    let call: Promise<void> | undefined;
    try {
      call = (target as any)._branchSession();
      await flush();
      expect(spinners()).toHaveLength(1);
      // The assistant's own label, never "conversation".
      expect(title()).toBe('Branching Testbed session');
      expect(spinners()[0].getAttribute('aria-label')).toBe(
        'Branching Testbed session'
      );

      release({ session_id: 'child' });
      await call;
      await flush();
      expect(spinners()).toHaveLength(0);
    } finally {
      // A failed assertion must not leave the mock unresolved for the next
      // test; resolving twice is harmless.
      release({ session_id: 'child' });
      await call?.catch(() => undefined);
      target.dispose();
      request.mockImplementation(() => Promise.resolve({}));
    }
  });

  it('keeps one dialog for overlapping opens and closes it with the last', async () => {
    const target = makePanel(DESCRIPTOR);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const second = new Promise<void>(resolve => {
      releaseSecond = resolve;
    });
    const requests = [first, second];
    (target as any)._terminals.openSession = jest.fn(() => requests.shift());
    (target as any)._fetch = jest.fn().mockResolvedValue(undefined);
    const launched = jest.spyOn(Dialog.prototype, 'launch');
    const callOne = (target as any)._openSession(
      session({ session_id: 'one' })
    );
    const callTwo = (target as any)._openSession(
      session({ session_id: 'two' })
    );
    try {
      await flush();
      expect(launched).toHaveBeenCalledTimes(1);
      expect(spinners()).toHaveLength(1);

      releaseFirst();
      await callOne;
      await flush();
      expect(spinners()).toHaveLength(1);

      releaseSecond();
      await callTwo;
      await flush();
      expect(spinners()).toHaveLength(0);
    } finally {
      releaseFirst();
      releaseSecond();
      await Promise.all([callOne, callTwo]).catch(() => undefined);
      target.dispose();
    }
  });
});

describe('a branch whose terminal launch was refused after the mint', () => {
  it.each<[number, string]>([
    [
      409,
      'the TUI profile is not mounted; run dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui'
    ],
    // DEF-PANE-337: the launch preflight's 400 for a project folder that is
    // gone is not the branch POST's 400, and must not read as one.
    [400, 'invalid_project_path']
  ])(
    'says the branch was created and still lists it when the launch is refused with %i',
    async (status, refusal) => {
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
      (target as any)._terminals.launch = jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error(refusal), { response: { status } })
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

        // The refused launch still closes the click-time spinner dialog.
        await flush();
        expect(document.querySelector('.jp-Dialog')).toBeNull();

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
    }
  );
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
        commands: { execute: jest.fn() },
        shell: { activateById: jest.fn() }
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

describe('DEF-PANE-321 - a successful switch stays quiet', () => {
  it('issues the switch and raises no notification', async () => {
    const success = jest
      .spyOn(Notification, 'success')
      .mockReturnValue('' as any);
    const target = session({ name: 'proj' });
    request.mockImplementation((_id: string, route: string) =>
      Promise.resolve(
        route === 'switch'
          ? { requested: 'sid-other', current: 'sid-other' }
          : { sessions: [] }
      )
    );
    await (panel as any)._switchBranch(target, 'sid-other');
    // The row's own re-render is the only signal a switch earns.
    expect(request.mock.calls.map(call => call[1])).toContain('switch');
    expect(success).not.toHaveBeenCalled();
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

describe('DEF-PANE-349 - a row click makes the clicked session the project current', () => {
  // A row click opens or reuses a terminal, and it must also post the switch
  // that writes the pin and the SWITCH_MTIME_LEAD_S stamp, or plain
  // `claude -c` in the project can resolve to another conversation. Only the
  // row's own controls do that: a launch from a menu leaves `claude -c`.
  it('posts the switch for the row it opens', async () => {
    const row = session({ name: 'proj' });
    const open = jest.fn(() => Promise.resolve());
    (panel as any)._terminals.openSession = open;
    (panel as any)._fetch = jest.fn().mockResolvedValue(undefined);
    request.mockImplementation((_id: string, route: string) =>
      Promise.resolve(
        route === 'switch'
          ? { requested: row.session_id, current: row.session_id }
          : { sessions: [] }
      )
    );

    render(panel, [row]);
    panel.node.querySelector<HTMLElement>('.jp-AiAssistantsPanel-row')!.click();
    await flush();

    expect(open).toHaveBeenCalledTimes(1);
    const switchCall = request.mock.calls.find(call => call[1] === 'switch');
    expect(switchCall).toBeDefined();
    expect(JSON.parse((switchCall![3] as any).body)).toMatchObject({
      encoded_path: row.encoded_path,
      session_id: row.session_id
    });
  });

  it('posts the switch again when the open only reuses the running terminal', async () => {
    // This test uses the real terminal manager: the first click launches a
    // terminal and the second finds it, and a reuse must make the
    // conversation current exactly as a launch does.
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
      descriptor: { ...DESCRIPTOR, iconName: 'testbed-reuse-349-spec' },
      rootDir: '/home/user'
    });
    try {
      await flush();
      request.mockClear();
      const row = session();
      request.mockImplementation((_id: string, route: string) =>
        Promise.resolve(
          route === 'launch'
            ? { terminal_name: 'term-1' }
            : route === 'switch'
              ? { requested: row.session_id, current: row.session_id }
              : {}
        )
      );
      (p as any)._fetch = jest.fn().mockResolvedValue(undefined);
      render(p, [row]);

      p.node.querySelector<HTMLElement>('.jp-AiAssistantsPanel-row')!.click();
      await flush();
      p.node.querySelector<HTMLElement>('.jp-AiAssistantsPanel-row')!.click();
      await flush();

      // One launch for two clicks, so the second click reused the terminal.
      expect(
        request.mock.calls.filter(([, route]) => route === 'launch')
      ).toHaveLength(1);
      // Both clicks made it current, the reuse included.
      const switches = request.mock.calls.filter(
        ([, route]) => route === 'switch'
      );
      expect(switches).toHaveLength(2);
      expect(JSON.parse((switches[1][3] as any).body)).toMatchObject({
        encoded_path: row.encoded_path,
        session_id: row.session_id
      });
    } finally {
      request.mockImplementation(() => Promise.resolve({}));
      p.dispose();
    }
  });

  it('posts the same switch for Enter and Space on a row', async () => {
    for (const key of ['Enter', ' ']) {
      request.mockClear();
      const open = jest.fn(() => Promise.resolve());
      (panel as any)._terminals.openSession = open;
      (panel as any)._fetch = jest.fn().mockResolvedValue(undefined);
      const row = session({ name: key === 'Enter' ? 'enter' : 'space' });
      request.mockImplementation((_id: string, route: string) =>
        Promise.resolve(
          route === 'switch'
            ? { requested: row.session_id, current: row.session_id }
            : { sessions: [] }
        )
      );

      render(panel, [row]);
      panel.node
        .querySelector<HTMLElement>('.jp-AiAssistantsPanel-row')!
        .dispatchEvent(new KeyboardEvent('keydown', { key }));
      await flush();

      expect(open).toHaveBeenCalledTimes(1);
      const switchCall = request.mock.calls.find(call => call[1] === 'switch');
      expect(switchCall).toBeDefined();
      expect(JSON.parse((switchCall![3] as any).body)).toMatchObject({
        encoded_path: row.encoded_path,
        session_id: row.session_id
      });
    }
  });

  it('posts no switch for a launch that is not from a row', async () => {
    // Resume in the context menu opens the same conversation, but only the
    // row's own controls make it current - a launch must not move `claude -c`.
    const row = session({ name: 'proj' });
    const open = jest.fn(() => Promise.resolve());
    (panel as any)._terminals.openSession = open;
    (panel as any)._fetch = jest.fn().mockResolvedValue(undefined);
    (panel as any)._activeSession = row;

    await (panel as any)._commands.execute(commandId('testbed', 'resume'));
    await flush();

    expect(open).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map(call => call[1])).not.toContain('switch');
  });

  it('posts only the newest switch when two row opens finish out of order', async () => {
    // The pin is a per-project value, and the server writes it when each
    // switch request runs. A row click only takes its switch after its open
    // resolves, so without an order token the click that finishes last pins
    // the project, whatever the user clicked last (DEF-PANE-349).
    const first = session({
      name: 'first',
      project_path: '/home/user/shared',
      encoded_path: 'enc-shared'
    });
    const second = session({
      name: 'second',
      project_path: '/home/user/shared',
      encoded_path: 'enc-shared',
      session_id: 'sid-second'
    });
    let releaseFirst!: () => void;
    const firstOpen = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    (panel as any)._terminals.openSession = jest.fn((s: ISession) =>
      s.session_id === first.session_id ? firstOpen : Promise.resolve()
    );
    (panel as any)._fetch = jest.fn().mockResolvedValue(undefined);
    request.mockImplementation(
      (_id: string, route: string, _settings: unknown, init: any) => {
        if (route === 'switch') {
          const body = JSON.parse(init.body);
          return Promise.resolve({
            requested: body.session_id,
            current: body.session_id
          });
        }
        return Promise.resolve({ sessions: [] });
      }
    );
    try {
      render(panel, [first, second]);
      const rows = panel.node.querySelectorAll<HTMLElement>(
        '.jp-AiAssistantsPanel-row'
      );
      expect(rows).toHaveLength(2);
      rows[0].click();
      await flush();
      rows[1].click();
      await flush();

      const switches = (): any[] =>
        request.mock.calls.filter(([, route]) => route === 'switch');
      // The second click resolved first and pinned its conversation.
      expect(switches()).toHaveLength(1);
      expect(JSON.parse((switches()[0][3] as any).body).session_id).toBe(
        'sid-second'
      );

      // The first click resolved after it; its older switch is dropped.
      releaseFirst();
      await flush();
      expect(switches()).toHaveLength(1);
      expect(JSON.parse((switches()[0][3] as any).body).session_id).toBe(
        'sid-second'
      );
    } finally {
      releaseFirst();
      await flush();
    }
  });

  it('drops a pending row switch when an explicit switch lands first', async () => {
    const row = session({ name: 'proj' });
    let releaseOpen!: () => void;
    const pending = new Promise<void>(resolve => {
      releaseOpen = resolve;
    });
    (panel as any)._terminals.openSession = jest.fn(() => pending);
    (panel as any)._fetch = jest.fn().mockResolvedValue(undefined);
    request.mockImplementation(
      (_id: string, route: string, _settings: unknown, init: any) => {
        if (route === 'switch') {
          const body = JSON.parse(init.body);
          return Promise.resolve({
            requested: body.session_id,
            current: body.session_id
          });
        }
        return Promise.resolve({ sessions: [] });
      }
    );
    try {
      render(panel, [row]);
      panel.node
        .querySelector<HTMLElement>('.jp-AiAssistantsPanel-row')!
        .click();
      await flush();

      // The user picked another conversation before the open resolved.
      await (panel as any)._switchBranch(row, 'sid-explicit');
      await flush();

      releaseOpen();
      await flush();

      const switches = request.mock.calls.filter(
        ([, route]) => route === 'switch'
      );
      expect(switches).toHaveLength(1);
      expect(JSON.parse((switches[0][3] as any).body).session_id).toBe(
        'sid-explicit'
      );
    } finally {
      releaseOpen();
      await flush();
    }
  });

  it('drops a pending row switch after a fork wrote the child pin', async () => {
    // The fork route pins the minted conversation server-side. A row click
    // still opening when the fork returns must not pin the parent back.
    const row = session({ name: 'proj' });
    let releaseOpen!: () => void;
    const pending = new Promise<void>(resolve => {
      releaseOpen = resolve;
    });
    (panel as any)._terminals.openSession = jest.fn(() => pending);
    (panel as any)._terminals.launch = jest
      .fn()
      .mockResolvedValue({ id: 'term-fork' });
    (panel as any)._fetch = jest.fn().mockResolvedValue(undefined);
    request.mockImplementation((_id: string, route: string) =>
      Promise.resolve(
        route === 'branch'
          ? { session_id: 'sid-fork' }
          : route === 'switch'
            ? { requested: 'sid-fork', current: 'sid-fork' }
            : { sessions: [] }
      )
    );
    try {
      render(panel, [row]);
      panel.node
        .querySelector<HTMLElement>('.jp-AiAssistantsPanel-row')!
        .click();
      await flush();

      await (panel as any)._branchByServerCopy(row, undefined, undefined, 0);
      await flush();

      releaseOpen();
      await flush();

      // The fork is written again on the project's chain, but the held row
      // click never posts: the parent is not pinned back.
      const switches = request.mock.calls.filter(
        ([, route]) => route === 'switch'
      );
      expect(switches).toHaveLength(1);
      expect(JSON.parse((switches[0][3] as any).body).session_id).toBe(
        'sid-fork'
      );
    } finally {
      releaseOpen();
      await flush();
    }
  });

  it('drops a pending row switch after New Session (+) in the same project', async () => {
    // + starts a new conversation and the launch route clears the pin. A row
    // click still opening must not pin the old conversation over it
    // (DEF-PANE-355).
    const row = session({ name: 'proj' });
    let releaseOpen!: () => void;
    const pending = new Promise<void>(resolve => {
      releaseOpen = resolve;
    });
    (panel as any)._terminals.openSession = jest.fn(() => pending);
    const launch = jest.fn().mockResolvedValue({ id: 'term-new' });
    (panel as any)._terminals.launch = launch;
    (panel as any)._currentFolder = () => row.project_path;
    (panel as any)._fetch = jest.fn().mockResolvedValue(undefined);
    request.mockImplementation((_id: string, route: string) =>
      Promise.resolve(
        route === 'switch'
          ? { requested: row.session_id, current: row.session_id }
          : { sessions: [] }
      )
    );
    try {
      render(panel, [row]);
      panel.node
        .querySelector<HTMLElement>('.jp-AiAssistantsPanel-row')!
        .click();
      await flush();

      await (panel as any)._newSession();
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0][0]).toMatchObject({
        encoded_path: row.encoded_path
      });

      releaseOpen();
      await flush();

      expect(request.mock.calls.map(call => call[1])).not.toContain('switch');
    } finally {
      releaseOpen();
      await flush();
    }
  });

  it('posts no queued row switch once New Session (+) is the newest decision', async () => {
    // A row switch queued behind a post in flight reads the newest decision
    // when it runs; a + made meanwhile has no id to post (DEF-PANE-355).
    const first = session({
      name: 'first',
      project_path: '/home/user/shared',
      encoded_path: 'enc-shared'
    });
    const second = session({
      name: 'second',
      project_path: '/home/user/shared',
      encoded_path: 'enc-shared',
      session_id: 'sid-second'
    });
    let releasePost!: () => void;
    const heldPost = new Promise<void>(resolve => {
      releasePost = resolve;
    });
    (panel as any)._terminals.openSession = jest.fn(() => Promise.resolve());
    (panel as any)._terminals.launch = jest
      .fn()
      .mockResolvedValue({ id: 'term-new' });
    (panel as any)._currentFolder = () => first.project_path;
    (panel as any)._fetch = jest.fn().mockResolvedValue(undefined);
    request.mockImplementation(
      async (_id: string, route: string, _settings: unknown, init: any) => {
        if (route !== 'switch') {
          return { sessions: [] };
        }
        const body = JSON.parse(init.body);
        if (body.session_id === first.session_id) {
          await heldPost;
        }
        return { requested: body.session_id, current: body.session_id };
      }
    );
    try {
      render(panel, [first, second]);
      const rows = panel.node.querySelectorAll<HTMLElement>(
        '.jp-AiAssistantsPanel-row'
      );
      rows[0].click();
      await flush();
      rows[1].click();
      await flush();

      await (panel as any)._newSession();
      releasePost();
      await flush();

      const switches = request.mock.calls.filter(
        ([, route]) => route === 'switch'
      );
      expect(switches).toHaveLength(1);
      expect(JSON.parse((switches[0][3] as any).body).session_id).toBe(
        first.session_id
      );
    } finally {
      releasePost();
      await flush();
    }
  });

  it('posts the row switch when a held Branch answers before a later row open', async () => {
    // The fork's number is the Branch click's, so a row clicked after it wins
    // even when the fork route answers first (DEF-PANE-349).
    const row = session({ name: 'proj' });
    let releaseFork!: () => void;
    const forkPending = new Promise<{ session_id: string }>(resolve => {
      releaseFork = () => resolve({ session_id: 'sid-fork' });
    });
    let releaseOpen!: () => void;
    const openPending = new Promise<void>(resolve => {
      releaseOpen = resolve;
    });
    (panel as any)._activeSession = row;
    (panel as any)._terminals.openSession = jest.fn(() => openPending);
    (panel as any)._terminals.launch = jest
      .fn()
      .mockResolvedValue({ id: 'term-fork' });
    (panel as any)._fetch = jest.fn().mockResolvedValue(undefined);
    request.mockImplementation(
      (_id: string, route: string, _settings: unknown, init: any) => {
        if (route === 'branch') {
          return forkPending;
        }
        if (route === 'switch') {
          const body = JSON.parse(init.body);
          return Promise.resolve({
            requested: body.session_id,
            current: body.session_id
          });
        }
        return Promise.resolve({ sessions: [] });
      }
    );
    try {
      render(panel, [row]);
      const branched = (panel as any)._branchSession();
      await flush();

      panel.node
        .querySelector<HTMLElement>('.jp-AiAssistantsPanel-row')!
        .click();
      await flush();

      releaseFork();
      await flush();

      releaseOpen();
      await flush();
      await branched;

      const switches = request.mock.calls.filter(
        ([, route]) => route === 'switch'
      );
      // The fork's own re-post goes first; the later row click outranks it
      // and is the last write.
      expect(
        switches.map(call => JSON.parse((call[3] as any).body).session_id)
      ).toEqual(['sid-fork', row.session_id]);
    } finally {
      releaseFork();
      releaseOpen();
      await flush();
    }
  });

  it('a fork answer does not lower the number of a newer row switch', async () => {
    // Row B posts its switch while the fork and row A are held. The fork's
    // older number must not let row A's later answer through (DEF-PANE-349).
    const first = session({
      name: 'first',
      project_path: '/home/user/shared',
      encoded_path: 'enc-shared'
    });
    const second = session({
      name: 'second',
      project_path: '/home/user/shared',
      encoded_path: 'enc-shared',
      session_id: 'sid-second'
    });
    let releaseFork!: () => void;
    const forkPending = new Promise<{ session_id: string }>(resolve => {
      releaseFork = () => resolve({ session_id: 'sid-fork' });
    });
    let releaseFirst!: () => void;
    const firstOpen = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    (panel as any)._activeSession = first;
    (panel as any)._terminals.openSession = jest.fn((s: ISession) =>
      s.session_id === first.session_id ? firstOpen : Promise.resolve()
    );
    (panel as any)._terminals.launch = jest
      .fn()
      .mockResolvedValue({ id: 'term-fork' });
    (panel as any)._fetch = jest.fn().mockResolvedValue(undefined);
    request.mockImplementation(
      (_id: string, route: string, _settings: unknown, init: any) => {
        if (route === 'branch') {
          return forkPending;
        }
        if (route === 'switch') {
          const body = JSON.parse(init.body);
          return Promise.resolve({
            requested: body.session_id,
            current: body.session_id
          });
        }
        return Promise.resolve({ sessions: [] });
      }
    );
    try {
      render(panel, [first, second]);
      const branched = (panel as any)._branchSession();
      await flush();

      const rows = panel.node.querySelectorAll<HTMLElement>(
        '.jp-AiAssistantsPanel-row'
      );
      expect(rows).toHaveLength(2);
      rows[0].click();
      await flush();
      // Row B opens at once and posts its switch while row A and the fork
      // are still held.
      rows[1].click();
      await flush();

      const switches = (): any[] =>
        request.mock.calls.filter(([, route]) => route === 'switch');
      expect(switches()).toHaveLength(1);
      expect(JSON.parse((switches()[0][3] as any).body).session_id).toBe(
        'sid-second'
      );

      releaseFork();
      await flush();
      releaseFirst();
      await flush();
      await branched;

      // Row B's newer decision stands: the fork's late answer re-posts it
      // after the fork's own pin write, and row A's older click stays
      // suppressed.
      expect(switches()).toHaveLength(2);
      for (const call of switches()) {
        expect(JSON.parse((call[3] as any).body).session_id).toBe('sid-second');
      }
    } finally {
      releaseFork();
      releaseFirst();
      await flush();
    }
  });

  it('a correction re-post that resolves late leaves the newest row switch as the last write', async () => {
    // Round-8 MAJOR. Row B's switch is held, the fork answer queues the
    // correction, and row C is clicked while B's write is still in flight.
    // The correction and row C's click both wait on the project's chain, so
    // the correction runs after B's write and carries the newest decision, C.
    // Without the chain the correction is sent alongside C and its slower
    // answer lands last, leaving the pin and the mtime lead on B while the
    // panel records C as its newest decision.
    const first = session({
      name: 'first',
      project_path: '/home/user/shared',
      encoded_path: 'enc-shared'
    });
    const second = session({
      name: 'second',
      project_path: '/home/user/shared',
      encoded_path: 'enc-shared',
      session_id: 'sid-second'
    });
    const third = session({
      name: 'third',
      project_path: '/home/user/shared',
      encoded_path: 'enc-shared',
      session_id: 'sid-third'
    });
    let releaseFork!: () => void;
    const forkPending = new Promise<{ session_id: string }>(resolve => {
      releaseFork = () => resolve({ session_id: 'sid-fork' });
    });
    // The switch answers the test holds, in dispatch order: row B's click,
    // then the correction, which runs only after B's write answers and posts
    // the newest decision, C. Any later request answers at once.
    const held: Array<{ sessionId: string; release: () => void }> = [];
    // Session ids in the order the server answers each switch - the order its
    // writes land, which is what decides the pin.
    const completed: string[] = [];
    (panel as any)._activeSession = first;
    (panel as any)._terminals.openSession = jest
      .fn()
      .mockResolvedValue(undefined);
    (panel as any)._terminals.launch = jest
      .fn()
      .mockResolvedValue({ id: 'term-fork' });
    (panel as any)._fetch = jest.fn().mockResolvedValue(undefined);
    request.mockImplementation(
      (_id: string, route: string, _settings: unknown, init: any) => {
        if (route === 'branch') {
          return forkPending;
        }
        if (route !== 'switch') {
          return Promise.resolve({ sessions: [] });
        }
        const body = JSON.parse(init.body);
        if (held.length >= 2) {
          completed.push(body.session_id);
          return Promise.resolve({
            requested: body.session_id,
            current: body.session_id
          });
        }
        let release!: () => void;
        const answer = new Promise<unknown>(resolve => {
          release = () => {
            completed.push(body.session_id);
            resolve({ requested: body.session_id, current: body.session_id });
          };
        });
        held.push({ sessionId: body.session_id, release });
        return answer;
      }
    );
    try {
      render(panel, [first, second, third]);
      const branched = (panel as any)._branchSession();
      await flush();

      const rows = panel.node.querySelectorAll<HTMLElement>(
        '.jp-AiAssistantsPanel-row'
      );
      expect(rows).toHaveLength(3);

      // Row B's click takes the project current and holds its write.
      rows[1].click();
      await flush();
      // The fork answers while row B's write is in flight, so the correction
      // is queued behind it.
      releaseFork();
      await flush();
      // Row C is clicked while B's write is still in flight; its switch is
      // queued behind the correction rather than sent alongside it.
      rows[2].click();
      await flush();

      const switchIds = (): string[] =>
        request.mock.calls
          .filter(([, route]) => route === 'switch')
          .map(call => JSON.parse((call[3] as any).body).session_id);
      expect(switchIds()).toEqual(['sid-second']);
      expect(held).toHaveLength(1);

      // Row B's write answers, so the correction runs, posts the newest
      // decision, C, and holds its own write.
      held[0].release();
      await flush();
      expect(switchIds()).toEqual(['sid-second', 'sid-third']);
      expect(held).toHaveLength(2);
      expect(completed).toEqual(['sid-second']);
      held[1].release();
      await flush();
      await branched;

      // The newest decision, C, is the project's last write; row C's own
      // queued task finds it already posted and sends nothing.
      expect(completed).toEqual(['sid-second', 'sid-third']);
      expect((panel as any)._currentTokens.get('enc-shared')).toEqual({
        click: expect.any(Number),
        sessionId: 'sid-third'
      });
    } finally {
      releaseFork();
      await flush();
    }
  });

  it('re-posts the fork after a row switch that was in flight when the Branch answered', async () => {
    // Mirror of the round-8 sequence. Row B's switch is already in flight when
    // the Branch is pressed, so the fork route's pin write can land before
    // row B's write. The fork is recorded as the newest decision and queued on
    // the project's chain behind row B, so it is written again last; without
    // the queue row B's late write leaves the pin on row B while the panel
    // records the fork.
    const first = session({
      name: 'first',
      project_path: '/home/user/shared',
      encoded_path: 'enc-shared'
    });
    const second = session({
      name: 'second',
      project_path: '/home/user/shared',
      encoded_path: 'enc-shared',
      session_id: 'sid-second'
    });
    let releaseFork!: () => void;
    const forkPending = new Promise<{ session_id: string }>(resolve => {
      releaseFork = () => resolve({ session_id: 'sid-fork' });
    });
    // The first switch request is held - row B's - and any later one answers
    // at once.
    let releaseSwitch: (() => void) | undefined;
    const completed: string[] = [];
    (panel as any)._activeSession = first;
    (panel as any)._terminals.openSession = jest
      .fn()
      .mockResolvedValue(undefined);
    (panel as any)._terminals.launch = jest
      .fn()
      .mockResolvedValue({ id: 'term-fork' });
    (panel as any)._fetch = jest.fn().mockResolvedValue(undefined);
    request.mockImplementation(
      (_id: string, route: string, _settings: unknown, init: any) => {
        if (route === 'branch') {
          return forkPending;
        }
        if (route !== 'switch') {
          return Promise.resolve({ sessions: [] });
        }
        const body = JSON.parse(init.body);
        if (releaseSwitch) {
          completed.push(body.session_id);
          return Promise.resolve({
            requested: body.session_id,
            current: body.session_id
          });
        }
        const answer = new Promise<unknown>(resolve => {
          releaseSwitch = () => {
            completed.push(body.session_id);
            resolve({ requested: body.session_id, current: body.session_id });
          };
        });
        return answer;
      }
    );
    try {
      render(panel, [first, second]);
      const rows = panel.node.querySelectorAll<HTMLElement>(
        '.jp-AiAssistantsPanel-row'
      );
      expect(rows).toHaveLength(2);

      // Row B's click takes the project current and holds its write.
      rows[1].click();
      await flush();
      // The Branch is pressed after it; the fork answers while row B's write
      // is still in flight.
      const branched = (panel as any)._branchSession();
      await flush();
      releaseFork();
      await flush();
      await branched;

      const switchIds = (): string[] =>
        request.mock.calls
          .filter(([, route]) => route === 'switch')
          .map(call => JSON.parse((call[3] as any).body).session_id);
      // The fork's re-post waits behind row B's held write.
      expect(switchIds()).toEqual(['sid-second']);
      expect(completed).toEqual([]);

      releaseSwitch!();
      await flush();

      // It lands last, with the fork id, and the fork stays the newest
      // recorded decision.
      expect(switchIds()).toEqual(['sid-second', 'sid-fork']);
      expect(completed).toEqual(['sid-second', 'sid-fork']);
      expect((panel as any)._currentTokens.get('enc-shared')).toEqual({
        click: expect.any(Number),
        sessionId: 'sid-fork'
      });
    } finally {
      releaseFork();
      releaseSwitch?.();
      await flush();
    }
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
      (p as any)._openManagePopup('switch');
      const calls = (showManageSessionsPopup as jest.Mock).mock.calls;
      const [options] = calls[calls.length - 1];
      // A front-slice would read `proj (session_)` on every conversation.
      expect(options.currentName).toEqual('proj (9f8e7d6c)');
      expect(options.mode).toEqual('switch');
    } finally {
      p.dispose();
    }
  });
});

describe('Manage Sessions popup mode follows the invoking submenu (DEF-PANE-326)', () => {
  const lastOptions = (): any => {
    const calls = (showManageSessionsPopup as jest.Mock).mock.calls;
    return calls[calls.length - 1][0];
  };

  it('the switch submenu opens the popup in switch mode', () => {
    (panel as any)._activeSession = session({ name: 'proj' });
    (panel as any)._fillBranchSubmenus([]);
    const item = (panel as any)._switchSubmenu.items.at(-1);
    (panel as any)._commands.execute(item.command, item.args);

    expect(lastOptions().mode).toBe('switch');
  });

  it('the open submenu opens the popup in open mode', () => {
    (panel as any)._activeSession = session({ name: 'proj' });
    (panel as any)._fillBranchSubmenus([]);
    const item = (panel as any)._openBranchSubmenu.items.at(-1);
    (panel as any)._commands.execute(item.command, item.args);

    expect(lastOptions().mode).toBe('open');
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
    // The fetched list is what the question counts: three branches despite a
    // row that claims nine. It also gives Cancel a DELETE to withhold.
    request.mockImplementationOnce(() =>
      Promise.resolve({
        current: 'sid-ledger-tools',
        total: 4,
        branches: [0, 1, 2].map(index => ({
          session_id: `sid-branch-${index}`,
          file_mtime: 1,
          label: `Branch ${index}`
        }))
      })
    );
    const row = session({ name: 'ledger-tools', extra_sessions: 9 });
    const done = (panel as any)._cleanupParallel(row) as Promise<void>;
    await openButtons();
    const body = document.querySelector('.jp-Dialog-body')!.textContent ?? '';

    expect(body).toContain('3 parallel sessions');
    expect(body).toContain('ledger-tools');
    expect(body).toContain('current conversation is kept');
    pressEnter();
    await done;
    // Cancelling after the question's branches fetch sends no DELETE.
    expect(
      request.mock.calls.filter(call => call[3]?.method === 'DELETE')
    ).toHaveLength(0);
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

describe('ACC-PANE-221, ACC-PANE-222 - the cleanup confirmation warning and hint', () => {
  const HOUR = 3_600_000;

  const openButtons = async (): Promise<HTMLButtonElement[]> => {
    await flush();
    const dialog = document.querySelector('.jp-Dialog');
    expect(dialog).not.toBeNull();
    return Array.from(
      dialog!.querySelectorAll<HTMLButtonElement>('.jp-Dialog-button')
    );
  };

  const pressEnter = (): void => {
    document
      .querySelector('.jp-Dialog')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
  };

  /** The branch list a provider answers with: the kept conversation is not in
   * it, exactly as `list_branches` returns it. */
  const branches = (mtimes: number[]): any => ({
    current: 'sid-kept',
    total: mtimes.length + 1,
    branches: mtimes.map((file_mtime, index) => ({
      session_id: `sid-branch-${index}`,
      file_mtime,
      label: `Branch ${index}`
    }))
  });

  it('opens at once and warns when the branch list lands later', async () => {
    const now = Date.now();
    let release: ((value: any) => void) | undefined;
    // The request layer allows 60 s: the question must not wait for it.
    request.mockImplementationOnce(
      () => new Promise(resolve => (release = resolve))
    );
    const row = session({
      name: 'ledger-tools',
      extra_sessions: 2,
      file_mtime: now - 2 * HOUR
    });

    const done = (panel as any)._cleanupParallel(row) as Promise<void>;
    await openButtons();
    // Up already, on the row's own count.
    expect(document.querySelector('.jp-Dialog-body')!.textContent).toContain(
      '2 parallel sessions'
    );
    // The restated question is announced politely.
    expect(
      document.querySelector('.jp-Dialog-body p')!.getAttribute('role')
    ).toBe('status');
    // The Widget body leaves showDialog no string to name the dialog from, so
    // the name is set here and carries the question on screen.
    expect(
      document.querySelector('.jp-Dialog')!.getAttribute('aria-label')
    ).toContain('Remove 2 parallel sessions from "ledger-tools"?');

    // The list lands while the dialog is open: the count becomes the list's
    // and the newer conversation adds the warning.
    release!(branches([now - HOUR]));
    await flush();
    expect(document.querySelector('.jp-Dialog-body')!.textContent).toContain(
      'Remove 1 parallel session from'
    );
    const warning = document.querySelector(
      '.jp-AiAssistantsPanel-cleanupWarning'
    )!;
    expect(warning.textContent).toBe(
      '1 parallel session was active after the one kept.'
    );
    // The warning is announced, and the dialog's name follows the restated
    // question and the warning.
    expect(warning.getAttribute('role')).toBe('alert');
    const label = document
      .querySelector('.jp-Dialog')!
      .getAttribute('aria-label');
    expect(label).toContain('Remove 1 parallel session from "ledger-tools"?');
    expect(label).toContain(warning.textContent!);

    pressEnter();
    await done;
  });

  it('states the empty outcome and refreshes the list when the fetched list is empty', async () => {
    const now = Date.now();
    let release: ((value: any) => void) | undefined;
    request.mockImplementationOnce(
      () => new Promise(resolve => (release = resolve))
    );
    const row = session({
      name: 'ledger-tools',
      extra_sessions: 2,
      file_mtime: now - 2 * HOUR
    });

    const done = (panel as any)._cleanupParallel(row) as Promise<void>;
    await openButtons();
    // The row is a poll old and a second client cleaned the project: the
    // confirmation ends through the accept path, whose zero-id guard states
    // the empty outcome, instead of restating "Remove 0 parallel sessions"
    // with the red Remove still offered (DEF-PANE-364, DEF-PANE-365).
    release!(branches([]));
    await done;
    await flush();

    // The outcome dialog, not a bare dismissal: the user is told why.
    expect(document.querySelector('.jp-Dialog-body')!.textContent).toContain(
      'Nothing left to clean up.'
    );
    expect(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('.jp-Dialog-button')
      ).map(button => button.textContent)
    ).toEqual(['Close']);
    // The dialog's name carries the outcome statement, so a screen reader
    // hears why the confirmation closed, and the message is a status region
    // for an outcome that lands after the dialog has been read
    // (DEF-PANE-366-EMPTY-OUTCOME).
    expect(
      document.querySelector('.jp-Dialog')!.getAttribute('aria-label')
    ).toContain('Nothing left to clean up.');
    expect(
      document
        .querySelector('.jp-AiAssistantsPanel-cleanupMessage')!
        .getAttribute('role')
    ).toBe('status');
    // The branches fetch only: nothing was deleted.
    expect(
      request.mock.calls.filter(call => call[3]?.method === 'DELETE')
    ).toHaveLength(0);
    // The guard refreshed the list once, after the fetch it answered.
    const paths = request.mock.calls.map(call => call[1]);
    expect(paths.filter(path => path === 'branches')).toHaveLength(1);
    expect(paths.filter(path => path === 'sessions')).toHaveLength(1);
    expect(paths.indexOf('sessions')).toBeGreaterThan(
      paths.indexOf('branches')
    );
  });

  it('warns when a conversation it removes was active after the one kept', async () => {
    const now = Date.now();
    const row = session({
      name: 'ledger-tools',
      extra_sessions: 2,
      file_mtime: now - 2 * HOUR
    });
    request.mockResolvedValueOnce(branches([now - HOUR, now - 3 * HOUR]));

    const done = (panel as any)._cleanupParallel(row) as Promise<void>;
    await openButtons();

    const warning = document.querySelector(
      '.jp-AiAssistantsPanel-cleanupWarning'
    );
    expect(warning).not.toBeNull();
    // It names the one conversation that was newer, not the whole list.
    expect(warning!.textContent).toContain('1 parallel session was');
    // The question counts the fetched list, which is the list the removal
    // deletes - not the row's count from an older poll.
    expect(document.querySelector('.jp-Dialog-body')!.textContent).toContain(
      '2 parallel sessions'
    );
    pressEnter();
    await done;
  });

  it('does not warn when every conversation it removes is older or equal', async () => {
    const now = Date.now();
    const row = session({
      name: 'ledger-tools',
      extra_sessions: 2,
      file_mtime: now - 2 * HOUR
    });
    // Equal is the boundary: only a LATER activity is a warning.
    request.mockResolvedValueOnce(branches([now - 2 * HOUR, now - 3 * HOUR]));

    const done = (panel as any)._cleanupParallel(row) as Promise<void>;
    await openButtons();

    expect(
      document.querySelector('.jp-AiAssistantsPanel-cleanupWarning')
    ).toBeNull();
    pressEnter();
    await done;
  });

  it('states its hint in at most twelve words, in both disposal settings', async () => {
    const now = Date.now();
    const row = session({ name: 'ledger-tools', extra_sessions: 1 });
    request.mockResolvedValueOnce(branches([now - 3 * HOUR]));

    let done = (panel as any)._cleanupParallel(row) as Promise<void>;
    await openButtons();
    let hint = document.querySelector(
      '.jp-AiAssistantsPanel-cleanupHint'
    )!.textContent!;
    expect(hint.trim().split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(hint).toContain('go to the trash');
    // The hint promises the trash; the caution names the refusal that deletes
    // permanently.
    expect(
      document.querySelector('.jp-AiAssistantsPanel-cleanupCaution')!
        .textContent
    ).toContain('A refused trash move deletes permanently');
    pressEnter();
    await done;

    (panel as any)._deleteToTrash = false;
    request.mockResolvedValueOnce(branches([now - 3 * HOUR]));
    done = (panel as any)._cleanupParallel(row) as Promise<void>;
    await openButtons();
    hint = document.querySelector(
      '.jp-AiAssistantsPanel-cleanupHint'
    )!.textContent!;
    expect(hint.trim().split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(hint).toContain('deleted permanently');
    // The caution is not the hint: it stays visible on its own.
    expect(
      document.querySelector('.jp-AiAssistantsPanel-cleanupCaution')!
        .textContent
    ).toContain('cannot be undone');
    pressEnter();
    await done;
  });

  it('shows the question without a warning when the fetch fails', async () => {
    request.mockRejectedValueOnce(new Error('offline'));
    const row = session({ name: 'ledger-tools', extra_sessions: 3 });

    const done = (panel as any)._cleanupParallel(row) as Promise<void>;
    await openButtons();

    expect(
      document.querySelector('.jp-AiAssistantsPanel-cleanupWarning')
    ).toBeNull();
    expect(document.querySelector('.jp-Dialog-body')!.textContent).toContain(
      '3 parallel sessions'
    );
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
        (p as any)._openManagePopup('open');
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
        commands: { execute: jest.fn() },
        shell: { activateById: jest.fn() }
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
    // The failed open closes the click-time spinner dialog.
    expect(document.querySelector('.jp-Dialog')).toBeNull();
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

  it('DEF-PANE-343 - an open that finishes after the open of a later click does not move the file browser', async () => {
    // The first click's open (hidden, in the real panel) finishes last.
    let finishFirst!: () => void;
    stubOpen(panel).mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishFirst = resolve;
        })
    );
    const first = (panel as any)._openSession(nested());
    const second = (panel as any)._openSession(session({ name: 'notes' }));
    await second;
    await flush();
    const MOVE_TO_NOTES = [
      GO_TO_PATH,
      { path: 'notes', dontShowBrowser: true }
    ];
    expect(moves(panel)).toEqual([MOVE_TO_NOTES]);

    finishFirst();
    await first;
    await flush();
    expect(moves(panel)).toEqual([MOVE_TO_NOTES]);
  });
});

describe('DEF-PANE-344 - the session list', () => {
  it('drops a listing answer older than the one already drawn', async () => {
    let answerFirst!: (answer: unknown) => void;
    request
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            answerFirst = resolve;
          })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ sessions: [session({ name: 'newer' })] })
      );
    const first = (panel as any)._fetch();
    await (panel as any)._fetch();
    answerFirst({ sessions: [session({ name: 'older' })] });
    await first;
    expect((panel as any)._sessions.map((s: ISession) => s.name)).toEqual([
      'newer'
    ]);
  });

  /** Hold every listing request, in the order sent; other routes answer
   * `answer`. */
  const holdListings = (answer: unknown): Array<(v: unknown) => void> => {
    const held: Array<(v: unknown) => void> = [];
    request.mockImplementation((_id: string, path: string, _s, init?: any) =>
      path === 'sessions' && !init?.method
        ? new Promise(resolve => held.push(resolve))
        : Promise.resolve(answer)
    );
    return held;
  };

  it('DEF-PANE-351 - a listing sent before Remove gives way to the one after it', async () => {
    const alpha = session({ name: 'alpha' });
    const beta = session({ name: 'beta' });
    render(panel, [alpha, beta]);
    const held = holdListings({});
    const poll = (panel as any)._fetch();
    const removing = (panel as any)._removeProject(alpha);
    await flush();
    Array.from(
      document.querySelectorAll<HTMLButtonElement>('.jp-Dialog-button')
    )
      .find(b => b.textContent === 'Remove')!
      .click();
    await removing;
    // The listing sent before the delete answers first, then every one sent
    // after it answers with what the server holds now.
    held[0]({ sessions: [alpha, beta] });
    await poll;
    held.slice(1).forEach(answer => answer({ sessions: [beta] }));
    await flush();
    expect((panel as any)._sessions.map((s: ISession) => s.name)).toEqual([
      'beta'
    ]);
  });

  it('DEF-PANE-351-WRITE-ORDER - a listing sent before Remove never draws the removed project again', async () => {
    const alpha = session({ name: 'alpha' });
    const beta = session({ name: 'beta' });
    render(panel, [alpha, beta]);
    const held = holdListings({});
    const poll = (panel as any)._fetch();
    const removing = (panel as any)._removeProject(alpha);
    await flush();
    Array.from(
      document.querySelectorAll<HTMLButtonElement>('.jp-Dialog-button')
    )
      .find(b => b.textContent === 'Remove')!
      .click();
    await removing;
    // The listing sent before the delete answers with the project still in
    // it, and the refetch after the delete is still held.
    held[0]({ sessions: [alpha, beta] });
    await poll;
    expect((panel as any)._sessions.map((s: ISession) => s.name)).toEqual([
      'beta'
    ]);
    held.slice(1).forEach(answer => answer({ sessions: [beta] }));
    await flush();
  });

  it('DEF-PANE-351 - a listing sent before a favourite toggle gives way to the one after it', async () => {
    const alpha = session({ name: 'alpha' });
    render(panel, [alpha]);
    const held = holdListings({ favourite: true });
    const poll = (panel as any)._fetch();
    await (panel as any)._toggleFavourite(alpha);
    held[0]({ sessions: [session({ name: 'alpha', favourite: false })] });
    await poll;
    held
      .slice(1)
      .forEach(answer =>
        answer({ sessions: [session({ name: 'alpha', favourite: true })] })
      );
    await flush();
    expect((panel as any)._sessions[0].favourite).toBe(true);
  });

  it('DEF-PANE-351 - the star a toggle wrote on a row a poll had since replaced is drawn', async () => {
    // The context menu holds the row it opened on; a poll drawn while it is
    // open replaces every row object.
    const opened = session({ name: 'alpha' });
    render(panel, [opened]);
    request.mockResolvedValueOnce({ sessions: [session({ name: 'alpha' })] });
    await (panel as any)._fetch();
    const held = holdListings({ favourite: true });
    await (panel as any)._toggleFavourite(opened);
    held.forEach(answer =>
      answer({ sessions: [session({ name: 'alpha', favourite: true })] })
    );
    await flush();
    expect((panel as any)._sessions[0].favourite).toBe(true);
  });

  it('DEF-PANE-370 - the read after a star keeps the rows the star drew when it answers the same, and draws an answer that differs', async () => {
    const rows = (): Element[] =>
      Array.from(panel.node.querySelectorAll('.jp-AiAssistantsPanel-row'));
    const alpha = session({ name: 'alpha' });
    render(panel, [alpha]);
    const held = holdListings({ favourite: true });
    await (panel as any)._toggleFavourite(alpha);
    const starred = rows();
    expect(panel.node.querySelector('.jp-AiAssistantsPanel-favStar')).not.toBe(
      null
    );

    // The server holds what the star drew: no second redraw, so the row a
    // click is on stays in the list.
    held[0]({ sessions: [{ ...alpha }] });
    await flush();
    expect(rows()).toHaveLength(starred.length);
    rows().forEach((row, i) => expect(row).toBe(starred[i]));

    // Unstarred, and the answer differs from what that drew: it is drawn.
    await (panel as any)._toggleFavourite((panel as any)._sessions[0]);
    const unstarred = rows();
    held[1]({ sessions: [{ ...alpha, favourite: false, message_count: 4 }] });
    await flush();
    expect(rows()[0]).not.toBe(unstarred[0]);
    expect((panel as any)._sessions[0].message_count).toBe(4);
  });

  it('DEF-PANE-351 - a favourite toggle keeps the listing a Launcher tile click asked for', async () => {
    const alpha = session({ name: 'alpha' });
    render(panel, [
      alpha,
      session({ name: 'beta', session_id: 'sid-beta-old' })
    ]);
    const held = holdListings({ favourite: true, argv: ['testbed'] });
    const tile = (panel as any)._launchIn('/home/user/beta');
    await (panel as any)._toggleFavourite(alpha);
    held[0]({
      sessions: [alpha, session({ name: 'beta', session_id: 'sid-beta-new' })]
    });
    await tile;
    const call = request.mock.calls.find(c => c[1] === 'launch-argv')!;
    expect(JSON.parse(call[3].body).session_id).toBe('sid-beta-new');
  });

  it('DEF-PANE-346 - waits with a redraw while a button is pressed in the list, until the click has been sent', async () => {
    const names = (): string[] =>
      Array.from(
        panel.node.querySelectorAll('.jp-AiAssistantsPanel-nameText')
      ).map(el => el.textContent ?? '');
    const firstRow = (): HTMLElement =>
      panel.node.querySelector<HTMLElement>('.jp-AiAssistantsPanel-row')!;
    render(panel, [session({ name: 'alpha' })]);
    const row = firstRow();
    row.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    // A listing answer lands between the press and the release.
    render(panel, [session({ name: 'alpha' }), session({ name: 'beta' })]);
    expect(firstRow()).toBe(row);
    // The release, and the click it sends in the same task, still find the
    // row the press was on.
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(firstRow()).toBe(row);
    await flush();
    expect(firstRow()).not.toBe(row);
    expect(names()).toContain('beta');
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
      app: {
        serviceManager: { serverSettings: {} },
        commands,
        shell: { activateById: jest.fn() }
      } as any,
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

// ------------------------------------------------------------ ACC-CLI-227

describe('ACC-CLI-227 - a change the server pushes', () => {
  /** Sessions reads the panel has sent since the last `mockClear`. */
  const sessionsReads = (): number =>
    request.mock.calls.filter(
      ([, path, , init]) => path === 'sessions' && !init?.method
    ).length;

  it('waits for the row context menu to close, then reads once', async () => {
    request.mockImplementation(() => Promise.resolve({ sessions: [] }));
    const menu = (panel as any)._contextMenu;
    menu.open(0, 0);
    expect(menu.isAttached).toBe(true);
    request.mockClear();

    panel.sessionsChanged();
    await flush();
    // Rows are not reshuffled under an open menu.
    expect(sessionsReads()).toBe(0);

    menu.close();
    await flush();
    // Deferred, not dropped: without this read the change waits for the
    // 30 s poll.
    expect(sessionsReads()).toBe(1);
  });

  it('pushed during a read in flight, reads exactly once more after it', async () => {
    const held: Array<(answer: unknown) => void> = [];
    request.mockImplementation(
      (_id: string, path: string, _s: unknown, init?: any) =>
        path === 'sessions' && !init?.method
          ? new Promise(resolve => held.push(resolve))
          : Promise.resolve({})
    );

    panel.sessionsChanged();
    await flush();
    expect(sessionsReads()).toBe(1);
    // Two more changes land while the first read is unanswered: that read may
    // have been answered before them, so one more read follows it.
    panel.sessionsChanged();
    panel.sessionsChanged();
    await flush();
    expect(sessionsReads()).toBe(1);

    held[0]({ sessions: [] });
    await flush();
    expect(sessionsReads()).toBe(2);
    held[1]({ sessions: [] });
    await flush();
    expect(sessionsReads()).toBe(2);
  });
});

// -------------------------------------------------------------- ACC-SESS-57

describe('ACC-SESS-57 - a conversation a live terminal runs is kept', () => {
  it('the delete says so only when the server kept one', async () => {
    const info = jest.spyOn(Notification, 'info').mockImplementation(() => '');
    jest.spyOn(panel as any, '_fetch').mockResolvedValue(undefined);
    const rows = [session({ name: 'proj' })];
    render(panel, rows);
    const remove = async (answer: unknown): Promise<void> => {
      request.mockResolvedValueOnce(answer);
      await (panel as any)._deleteBranches(rows[0], ['sid-a', 'sid-b']);
    };

    await remove({
      removed_count: 2,
      removed_ids: ['sid-a', 'sid-b'],
      live_ids: []
    });
    expect(info).not.toHaveBeenCalled();

    await remove({
      removed_count: 1,
      removed_ids: ['sid-a'],
      live_ids: ['sid-b']
    });
    expect(info.mock.calls.map(call => call[0])).toEqual([
      'One conversation was kept, because a live terminal runs it.'
    ]);

    info.mockClear();
    await remove({
      removed_count: 0,
      removed_ids: [],
      live_ids: ['sid-a', 'sid-b']
    });
    expect(info.mock.calls.map(call => call[0])).toEqual([
      '2 conversations were kept, because live terminals run them.'
    ]);
  });

  it('Clean Up says so in its outcome', async () => {
    jest.spyOn(panel as any, '_fetch').mockResolvedValue(undefined);
    request.mockImplementation(
      (_id: string, path: string, _s: unknown, init?: any) =>
        Promise.resolve(
          init?.method === 'DELETE'
            ? {
                removed_count: 1,
                removed_ids: ['sid-branch-0'],
                live_ids: ['sid-branch-1']
              }
            : path === 'branches'
              ? {
                  current: 'sid-kept',
                  total: 3,
                  branches: [0, 1].map(index => ({
                    session_id: `sid-branch-${index}`,
                    file_mtime: 0,
                    label: `Branch ${index}`
                  }))
                }
              : {}
        )
    );

    const done = (panel as any)._cleanupParallel(
      session({ name: 'proj', extra_sessions: 2 })
    ) as Promise<void>;
    await flush();
    Array.from(
      document.querySelectorAll<HTMLButtonElement>('.jp-Dialog-button')
    )
      .find(button => button.textContent === 'Remove')!
      .click();
    await done;

    expect(
      document.querySelector('.jp-AiAssistantsPanel-cleanupMessage')!
        .textContent
    ).toBe(
      'Removed 1 parallel session. One conversation was kept, because a live terminal runs it.'
    );
  });
});
