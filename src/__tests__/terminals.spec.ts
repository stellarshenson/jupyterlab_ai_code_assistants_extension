/**
 * Terminal reuse. A terminal is reused only when the server reads the wanted
 * conversation id off its running process.
 */

jest.mock('@jupyter/react-components', () => ({}));
jest.mock('@jupyter/web-components', () => ({
  addJupyterLabThemeChangeListener: () => undefined,
  applyJupyterTheme: () => undefined,
  jpButton: () => undefined,
  jpToolbar: () => undefined,
  provideJupyterDesignSystem: () => ({ register: () => undefined })
}));

jest.mock('../core/request', () => ({ requestProvider: jest.fn() }));

import { Dialog } from '@jupyterlab/apputils';
import { nullTranslator } from '@jupyterlab/translation';

import { ColourStore } from '../core/colour';
import { requestProvider } from '../core/request';
import { TerminalManager, beginSpinner, endSpinner } from '../core/terminals';
import {
  IProviderDescriptor,
  ISession,
  ITerminalProbeResponse
} from '../core/types';

const request = requestProvider as jest.MockedFunction<typeof requestProvider>;

const PROJECT = '/home/user/proj';
const OTHER_PROJECT = '/home/user/other';
const CURRENT = 'session-11111111-1111-4111-8111-111111111111';

const DESCRIPTOR: IProviderDescriptor = {
  id: 'testbed',
  label: 'Testbed',
  panelTitle: 'Testbed Sessions',
  iconName: 'testbed-terminals-spec',
  iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>',
  cliBinary: 'testbed',
  forkStrategy: 'server-copy',
  colourSource: 'none',
  canRename: true,
  mintsNewSessionId: false,
  launchModes: [],
  hasRemoteControl: false,
  hasBgAgents: false,
  hasLiveProcess: false
};

function session(over: Partial<ISession> = {}): ISession {
  return {
    project_path: PROJECT,
    encoded_path: '--home-user-proj--',
    session_id: CURRENT,
    name: 'proj',
    name_source: 'basename',
    message_count: 3,
    file_mtime: 1,
    git_branch: null,
    favourite: false,
    extra_sessions: 1,
    ...over
  };
}

let widgetSeq = 0;
function terminal(name: string): any {
  widgetSeq += 1;
  return {
    id: `id-${String(widgetSeq).padStart(4, '0')}`,
    isDisposed: false,
    content: { session: { name } }
  };
}

/** What the server answers for a running process whose conversation it
 * cannot read: the assistant confirmed, no conversation id, the cwd inside
 * the project. */
const RUNNING_PROBE: ITerminalProbeResponse = {
  terminal_name: 'running',
  running: true,
  cwds: [PROJECT],
  session_id: null,
  colour: null
};

let terminals: any[];
let launches: any[];
let manager: TerminalManager;
/** Per-terminal probe answers a test wants instead of the defaults below. */
let probes: Record<string, ITerminalProbeResponse>;

function makeManager(): TerminalManager {
  return new TerminalManager({
    app: {
      shell: { activateById: () => undefined },
      commands: {
        execute: jest.fn(async (_cmd: string, args: any) => {
          const opened = terminal(args.name);
          terminals.push(opened);
          return opened;
        })
      }
    } as any,
    descriptor: DESCRIPTOR,
    colourStore: new ColourStore('testbed', {} as any),
    terminalTracker: {
      forEach: (fn: (widget: any) => void) => terminals.forEach(fn)
    } as any,
    colourfulTabs: null,
    serverSettings: {} as any
  });
}

beforeEach(() => {
  terminals = [];
  launches = [];
  probes = {};
  request.mockReset();
  request.mockImplementation((async (
    _providerId: string,
    path: string,
    _settings: unknown,
    init: RequestInit = {}
  ) => {
    if (path.startsWith('terminal/')) {
      const name = decodeURIComponent(path.slice('terminal/'.length));
      if (probes[name]) {
        return probes[name];
      }
      return name === 'running'
        ? RUNNING_PROBE
        : { ...RUNNING_PROBE, terminal_name: name, running: false, cwds: [] };
    }
    if (path === 'launch') {
      launches.push(JSON.parse(String(init.body)));
      return { terminal_name: `launched-${launches.length}` };
    }
    if (path === 'colours') {
      return { colours: {}, overrides: [] };
    }
    throw new Error(`unexpected route ${path}`);
  }) as any);
});

afterEach(() => {
  manager?.dispose();
});

describe('terminal reuse', () => {
  const READABLE: ITerminalProbeResponse = {
    terminal_name: 'running',
    running: true,
    session_id: CURRENT,
    cwds: [PROJECT],
    colour: null
  };

  it('never reuses a terminal whose conversation the server cannot read', async () => {
    manager = makeManager();
    manager.setSessions([session()]);
    terminals.push(terminal('running'));

    await manager.openSession(session(), undefined, CURRENT);

    expect(launches).toHaveLength(1);
    expect(await manager.findForSession(CURRENT, PROJECT)).toBeNull();
  });

  it('reuses a terminal running this conversation in this project', async () => {
    manager = makeManager();
    manager.setSessions([session()]);
    terminals.push(terminal('running'));
    probes.running = READABLE;

    await manager.openSession(session(), undefined, CURRENT);

    expect(launches).toHaveLength(0);
    expect(await manager.findForSession(CURRENT, PROJECT)).not.toBeNull();
  });

  it('starts a terminal here when the conversation runs in another project', async () => {
    manager = makeManager();
    manager.setSessions([session()]);
    terminals.push(terminal('running'));
    // Same conversation id, different tree: Claude re-homed a copy of the
    // transcript into another project, which is DEF-PANE-319's report.
    probes.running = { ...READABLE, cwds: [OTHER_PROJECT] };

    await manager.openSession(session(), undefined, CURRENT);

    expect(launches).toHaveLength(1);
    expect(launches[0].project_path).toBe(PROJECT);
  });

  it('reuses a terminal that changed directory inside the project', async () => {
    manager = makeManager();
    manager.setSessions([session()]);
    terminals.push(terminal('running'));
    probes.running = { ...READABLE, cwds: [PROJECT, `${PROJECT}/sub`] };

    await manager.openSession(session(), undefined, CURRENT);

    expect(launches).toHaveLength(0);
  });
});

describe('one spinner dialog (DEF-PANE-327-BUSY-MODAL-1)', () => {
  const trans = nullTranslator.load('jupyterlab_ai_code_assistants_extension');
  /** `Dialog.launch` attaches behind a launch-queue promise. */
  const flush = (): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, 0));
  const spinners = (): HTMLElement[] =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '.jp-Dialog.jp-AiAssistantsPanel-spinnerDialog'
      )
    );
  const title = (): string =>
    spinners()[0]?.querySelector('.jp-Dialog-header')?.textContent ?? '';
  // Every dialog constructed and launched, including one queued behind the
  // dialog on screen, which the document does not show yet.
  let launched: jest.SpyInstance;

  beforeEach(() => {
    launched = jest.spyOn(Dialog.prototype, 'launch');
  });

  afterEach(() => {
    launched.mockRestore();
  });

  it('drives one dialog from overlapping actions and closes it with the last', async () => {
    const opening = beginSpinner('Opening Testbed', trans);
    const branching = beginSpinner('Branching Testbed session', trans);
    try {
      await flush();
      expect(launched).toHaveBeenCalledTimes(1);
      expect(spinners()).toHaveLength(1);

      endSpinner(branching);
      await flush();
      expect(spinners()).toHaveLength(1);

      endSpinner(opening);
      await flush();
      expect(spinners()).toHaveLength(0);
    } finally {
      endSpinner(branching);
      endSpinner(opening);
    }
  });

  it('names the newest action still running', async () => {
    const opening = beginSpinner('Opening Testbed', trans);
    let branching: number | undefined;
    try {
      await flush();
      expect(title()).toBe('Opening Testbed');

      branching = beginSpinner('Branching Testbed session', trans);
      expect(title()).toBe('Branching Testbed session');
      expect(spinners()[0].getAttribute('aria-label')).toBe(
        'Branching Testbed session'
      );

      // The later action ends first: the dialog returns to the one still
      // running rather than keep naming the one that ended.
      endSpinner(branching);
      expect(title()).toBe('Opening Testbed');
      expect(spinners()[0].getAttribute('aria-label')).toBe('Opening Testbed');
    } finally {
      if (branching !== undefined) {
        endSpinner(branching);
      }
      endSpinner(opening);
    }
  });

  it('lets a launch join the click-time dialog instead of raising a second', async () => {
    manager = makeManager();
    const click = beginSpinner('Branching Testbed session', trans);
    try {
      await manager.launch(
        { project_path: PROJECT, session_id: CURRENT },
        CURRENT
      );
      expect(launches).toHaveLength(1);
      expect(launched).toHaveBeenCalledTimes(1);
      await flush();
      // The click's action has not ended, so its dialog stays up.
      expect(spinners()).toHaveLength(1);
    } finally {
      endSpinner(click);
    }
    await flush();
    expect(spinners()).toHaveLength(0);
  });

  it('raises the launch dialog for a launch with no click-time dialog up', async () => {
    manager = makeManager();
    const answer = request.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    request.mockImplementation(((...args: Parameters<typeof answer>) =>
      args[1] === 'launch'
        ? held.then(() => answer(...args))
        : answer(...args)) as any);
    const call = manager.launch(
      { project_path: PROJECT, session_id: CURRENT },
      CURRENT
    );
    try {
      await flush();
      expect(spinners()).toHaveLength(1);
      expect(title()).toBe('Opening Testbed');
    } finally {
      release();
      await call;
    }
    await flush();
    expect(spinners()).toHaveLength(0);
  });

  it('raises a fresh dialog for an action begun after Hide and keeps the hidden launch hidden', async () => {
    manager = makeManager();
    const answer = request.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    request.mockImplementation(((...args: Parameters<typeof answer>) =>
      args[1] === 'launch'
        ? held.then(() => answer(...args))
        : answer(...args)) as any);
    const hidden = beginSpinner('Opening Testbed', trans);
    let branching: number | undefined;
    let call: Promise<any> | undefined;
    try {
      await flush();
      spinners()[0]
        .querySelector<HTMLElement>('.jp-Dialog-footer .jp-Dialog-button')!
        .click();
      expect(spinners()).toHaveLength(0);

      // A click while the hidden action still runs shows its own dialog, and
      // closes it when it ends.
      branching = beginSpinner('Branching Testbed session', trans);
      await flush();
      expect(spinners()).toHaveLength(1);
      expect(title()).toBe('Branching Testbed session');
      endSpinner(branching);
      await flush();
      expect(spinners()).toHaveLength(0);

      // The hidden action's own launch joins its token and raises nothing.
      call = manager.openSession(session(), undefined, CURRENT, hidden);
      await flush();
      expect(request.mock.calls.some(([, path]) => path === 'launch')).toBe(
        true
      );
      expect(spinners()).toHaveLength(0);
    } finally {
      release();
      await call;
      if (branching !== undefined) {
        endSpinner(branching);
      }
      endSpinner(hidden);
    }
  });
});
