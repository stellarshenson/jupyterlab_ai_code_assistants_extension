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

import { ColourStore } from '../core/colour';
import { requestProvider } from '../core/request';
import { TerminalManager } from '../core/terminals';
import {
  IProviderDescriptor,
  ISession,
  ITerminalProbeResponse
} from '../core/types';

const request = requestProvider as jest.MockedFunction<typeof requestProvider>;

const PROJECT = '/home/user/proj';
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
  request.mockReset();
  request.mockImplementation((async (
    _providerId: string,
    path: string,
    _settings: unknown,
    init: RequestInit = {}
  ) => {
    if (path.startsWith('terminal/')) {
      const name = decodeURIComponent(path.slice('terminal/'.length));
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
  it('never reuses a terminal whose conversation the server cannot read', async () => {
    manager = makeManager();
    manager.setSessions([session()]);
    terminals.push(terminal('running'));

    await manager.openSession(session(), undefined, CURRENT);

    expect(launches).toHaveLength(1);
    expect(await manager.findForSession(CURRENT)).toBeNull();
  });
});
