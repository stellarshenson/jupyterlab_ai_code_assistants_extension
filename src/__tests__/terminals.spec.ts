/**
 * Terminal reuse for a project-scoped assistant.
 *
 * A `terminalScope: 'project'` assistant runs one process that serves every
 * conversation of the project, and the server's probe answers `running: true`
 * with no conversation id for it. The manager must then reuse the project's
 * running terminal for every open - whatever conversation the click named,
 * and whatever the microcache tagged - rather than starting a second server.
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

import { ColourStore } from '../core/colour';
import { requestProvider } from '../core/request';
import { TerminalManager } from '../core/terminals';
import {
  IProviderDescriptor,
  ISession,
  ITerminalProbeResponse,
  TerminalScope
} from '../core/types';

const request = requestProvider as jest.MockedFunction<typeof requestProvider>;

const PROJECT = '/home/user/proj';
const CURRENT = 'session-11111111-1111-4111-8111-111111111111';
const OTHER = 'session-22222222-2222-4222-8222-222222222222';

function descriptor(terminalScope: TerminalScope): IProviderDescriptor {
  return {
    id: 'testbed',
    label: 'Testbed',
    panelTitle: 'Testbed Sessions',
    iconName: 'testbed-terminals-spec',
    iconSvg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>',
    cliBinary: 'testbed',
    forkStrategy: 'server-copy',
    colourSource: 'none',
    terminalScope,
    promptsForBranchName: true,
    canRename: true,
    mintsNewSessionId: false,
    launchModes: [],
    hasRemoteControl: false,
    hasBgAgents: false,
    hasLiveProcess: false
  };
}

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

/** What the server answers for a running project-scoped process: the
 * assistant confirmed, no conversation id, the cwd inside the project. */
const RUNNING_PROBE: ITerminalProbeResponse = {
  terminal_name: 'running',
  running: true,
  cwds: [PROJECT],
  session_id: null,
  colour: null
};

let terminals: any[];
let launches: any[];
let argvPosts: any[];
/** Terminal names whose process has since exited: the probe answers
 * `running: false` for them. */
let stopped: Set<string>;
let activated: string[];
let manager: TerminalManager;

function makeManager(scope: TerminalScope): TerminalManager {
  return new TerminalManager({
    app: {
      shell: { activateById: (id: string) => activated.push(id) },
      commands: {
        execute: jest.fn(async (_cmd: string, args: any) => {
          const opened = terminal(args.name);
          terminals.push(opened);
          return opened;
        })
      }
    } as any,
    descriptor: descriptor(scope),
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
  argvPosts = [];
  stopped = new Set();
  activated = [];
  request.mockReset();
  request.mockImplementation((async (
    _providerId: string,
    path: string,
    _settings: unknown,
    init: RequestInit = {}
  ) => {
    if (path.startsWith('terminal/')) {
      const name = decodeURIComponent(path.slice('terminal/'.length));
      return name === 'running' && !stopped.has(name)
        ? RUNNING_PROBE
        : { ...RUNNING_PROBE, terminal_name: name, running: false, cwds: [] };
    }
    if (path === 'launch') {
      launches.push(JSON.parse(String(init.body)));
      return { terminal_name: `launched-${launches.length}` };
    }
    if (path === 'launch-argv') {
      argvPosts.push(JSON.parse(String(init.body)));
      return { argv: [] };
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

describe('project-scoped terminal reuse', () => {
  it('focuses the running terminal the server confirms, whatever conversation was asked for', async () => {
    manager = makeManager('project');
    manager.setSessions([session()]);
    const running = terminal('running');
    terminals.push(terminal('other'), running);

    await manager.openSession(session(), undefined, OTHER);

    expect(launches).toEqual([]);
    expect(activated).toEqual([running.id]);
  });

  it('reuses the microcache entry after the row moved to another conversation', async () => {
    manager = makeManager('project');
    manager.setSessions([session()]);

    // The first open starts the server and tags the terminal with CURRENT.
    await manager.openSession(session(), undefined, CURRENT);
    expect(launches).toHaveLength(1);
    const started = terminals[terminals.length - 1];

    // A switch, a fork or the poll re-pointing the row asks for OTHER; a
    // conversation-keyed cache would miss and start a second server. The
    // launched terminal's probe answers `running: false` throughout (its
    // process is still starting), and that alone never evicts it.
    await manager.openSession(session({ session_id: OTHER }), undefined, OTHER);
    expect(launches).toHaveLength(1);
    expect(activated[activated.length - 1]).toEqual(started.id);
  });

  it('relaunches once the server it confirmed has stopped', async () => {
    manager = makeManager('project');
    manager.setSessions([session()]);
    const running = terminal('running');
    terminals.push(running);

    await manager.openSession(session(), undefined, CURRENT);
    expect(activated).toEqual([running.id]);
    expect(launches).toHaveLength(0);

    // The user stopped the server in that terminal; the shell is still open.
    stopped.add('running');
    await manager.openSession(session(), undefined, CURRENT);

    expect(launches).toHaveLength(1);
    const relaunched = terminals[terminals.length - 1];
    expect(relaunched).not.toBe(running);
    expect(activated[activated.length - 1]).toEqual(relaunched.id);
  });

  it('settles the pin for `+` on a running project without opening anything', async () => {
    manager = makeManager('project');
    manager.setSessions([session()]);
    const running = terminal('running');
    terminals.push(running);

    await manager.launch({ project_path: PROJECT, encoded_path: 'enc' });

    expect(launches).toEqual([]);
    expect(argvPosts).toEqual([{ project_path: PROJECT, encoded_path: 'enc' }]);
    expect(activated).toEqual([running.id]);

    // A row click names its conversation and moves no pin.
    await manager.openSession(session({ session_id: OTHER }), undefined, OTHER);
    expect(argvPosts).toHaveLength(1);
    expect(launches).toEqual([]);
  });

  it('launches once when nothing runs the project, and gates `+` and forks the same way', async () => {
    manager = makeManager('project');
    manager.setSessions([session()]);

    await manager.launch({ project_path: PROJECT, encoded_path: 'enc' });
    await manager.launch({ project_path: PROJECT, session_id: OTHER }, OTHER);

    expect(launches).toHaveLength(1);
  });

  it('answers the Launcher path from the project, not the row id', async () => {
    manager = makeManager('project');
    manager.setSessions([session()]);
    const running = terminal('running');
    terminals.push(running);

    const found = await manager.findForSession(OTHER, PROJECT);
    expect(found?.widget).toBe(running);
    expect(await manager.findForSession(OTHER)).toBeNull();
  });
});

describe('conversation-scoped reuse is unchanged', () => {
  it('never reuses a terminal whose conversation the server cannot read', async () => {
    manager = makeManager('conversation');
    manager.setSessions([session()]);
    terminals.push(terminal('running'));

    await manager.openSession(session(), undefined, CURRENT);

    expect(launches).toHaveLength(1);
    expect(await manager.findForSession(CURRENT, PROJECT)).toBeNull();
  });
});
