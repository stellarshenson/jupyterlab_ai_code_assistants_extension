/**
 * The Launcher tile: the click path behind `ai-code-assistants:<id>:launch-here`
 * and the ranks the tiles are added with (ACC-TEST-161).
 *
 * The click path is driven through a real `AssistantSessionsPanel` - the tile
 * command is a one-line delegate to `panel.launchHere`, so testing it anywhere
 * else would test the delegate rather than the decision. The only doubles are
 * the provider request layer, the sibling extension's command, the file
 * browser's Contents manager and the terminal tracker.
 *
 * Nothing here waits on a timer: every branch settles through the microtask
 * queue, because the click path schedules nothing and retries nothing.
 */

// `@jupyterlab/apputils`' barrel reaches two ESM-only packages the repo jest
// config's `esModules` allowlist does not carry - the same two `panel.spec.ts`
// stubs, for the same reason.
jest.mock('@jupyter/react-components', () => ({}));
jest.mock('@jupyter/web-components', () => ({
  addJupyterLabThemeChangeListener: () => undefined,
  applyJupyterTheme: () => undefined,
  jpButton: () => undefined,
  jpToolbar: () => undefined,
  provideJupyterDesignSystem: () => ({ register: () => undefined })
}));
// Both tokens are named in the plugin's `optional:` list, so both packages
// load for real; `@jupyterlab/terminal` pulls the ESM-only `color` package and
// the tab extension ships untransformed ESM. Neither token is used here.
jest.mock('@jupyterlab/terminal', () => ({ ITerminalTracker: {} }));
jest.mock('jupyterlab_colourful_tab_extension', () => ({ IColourfulTabs: {} }));
// No route in this spec reaches the server.
jest.mock('../core/request', () => ({
  requestAPI: jest.fn(),
  requestProvider: jest.fn(() => Promise.resolve({})),
  // Shape-based rather than `instanceof`, so a test can hand the panel the
  // refusal a route answers with without building a real `Response`.
  isRequestTimeout: (err: any) => err?.name === 'RequestTimeoutError',
  isResponseStatus: (err: any, status: number) =>
    err?.response?.status === status,
  withQuery: (path: string) => path
}));

import { Notification } from '@jupyterlab/apputils';
import { CommandRegistry } from '@lumino/commands';

import { AssistantSessionsPanel, commandId } from '../core/panel';
import { requestAPI, requestProvider } from '../core/request';
import { IProviderDescriptor, ISession } from '../core/types';
import plugin from '../index';
import { PROVIDERS } from '../providers';

const request = requestProvider as jest.Mock;
const statusRequest = requestAPI as jest.Mock;

/** The contract with the sibling extension is this string and its args - it
 * exports no token, so the spec spells it out rather than importing it. */
const BASIC_TERMINAL_LAUNCH = 'basic-terminal:launch';

/** What the sibling's command resolves to. The tile command must hand it
 * straight back, or the Launcher has nothing to replace its tab with. */
const LAUNCHED_WIDGET = { id: 'terminal-new-1' };

/** A terminal already open, as the tracker hands it over. */
const OPEN_TERMINAL: any = {
  id: 'terminal-open-1',
  isDisposed: false,
  content: { session: { name: 'term-1' } },
  disposed: { connect: () => undefined }
};

const DESCRIPTOR: IProviderDescriptor = {
  id: 'testbed',
  label: 'Testbed',
  panelTitle: 'Testbed Sessions',
  iconName: 'testbed-launcher-spec',
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
  hasBgAgents: false,
  hasLiveProcess: false
};

/** The same provider for an assistant whose CLI mints its own ids. */
const NO_MINT_DESCRIPTOR: IProviderDescriptor = {
  ...DESCRIPTOR,
  iconName: 'testbed-nomint-launcher-spec',
  mintsNewSessionId: false
};

function session(over: Partial<ISession> = {}): ISession {
  return {
    project_path: '/srv/lab/proj',
    encoded_path: 'enc-proj',
    session_id: 'sid-proj',
    name: 'proj',
    name_source: 'basename',
    message_count: 3,
    file_mtime: Date.now(),
    git_branch: null,
    favourite: false,
    extra_sessions: 0,
    ...over
  };
}

/** Drain the microtask queue. */
async function flush(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

/** Answer the provider routes this spec names, and `{}` for the rest - the
 * colour store's startup load is the one that always fires. A value that is an
 * `Error` is the refusal that route answers with. */
function routes(map: Record<string, unknown>): void {
  request.mockImplementation((_id: string, path: string) => {
    const answer = path in map ? map[path] : {};
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  });
}

/** Every call the spec made to one route. */
function callsTo(path: string): any[] {
  return request.mock.calls.filter(call => call[1] === path);
}

/** The body one POST carried. */
function bodyOf(path: string): any {
  return JSON.parse(callsTo(path)[0][3].body);
}

interface IHarness {
  panel: AssistantSessionsPanel;
  /** Args every `basic-terminal:launch` execute was given. */
  launches: any[];
  /** Widget ids handed to the shell. */
  activated: string[];
}

const built: AssistantSessionsPanel[] = [];

function harness(
  options: {
    descriptor?: IProviderDescriptor;
    rootDir?: string;
    /** Register the sibling extension's command (default: yes). */
    sibling?: boolean;
    /** Register it, and have it refuse the launch. */
    siblingFails?: boolean;
    /** Hand the panel a tracker holding one open terminal. */
    tracker?: boolean;
  } = {}
): IHarness {
  const launches: any[] = [];
  const activated: string[] = [];
  const commands = new CommandRegistry();
  if (options.sibling !== false) {
    commands.addCommand(BASIC_TERMINAL_LAUNCH, {
      execute: args => {
        launches.push(args);
        if (options.siblingFails) {
          throw new Error('no terminal service');
        }
        return LAUNCHED_WIDGET;
      }
    });
  }
  const app = {
    serviceManager: {
      serverSettings: {},
      // The real Contents manager answers with the drive part of a path that
      // names a registered drive, and '' for the server's own.
      contents: {
        driveName: (path: string) =>
          path.includes(':') ? path.slice(0, path.indexOf(':')) : ''
      }
    },
    commands,
    shell: { activateById: (id: string) => activated.push(id) }
  } as any;
  const panel = new AssistantSessionsPanel({
    app,
    descriptor: options.descriptor ?? DESCRIPTOR,
    rootDir: options.rootDir ?? '/srv/lab',
    terminalTracker: options.tracker
      ? ({ forEach: (fn: any) => fn(OPEN_TERMINAL) } as any)
      : null
  });
  built.push(panel);
  return { panel, launches, activated };
}

let warn: jest.SpyInstance;
let error: jest.SpyInstance;

beforeEach(() => {
  window.localStorage.clear();
  routes({});
  // `callsTo` reads the whole call log, so it has to start empty per test.
  request.mockClear();
  warn = jest.spyOn(Notification, 'warning').mockReturnValue('' as any);
  error = jest.spyOn(Notification, 'error').mockReturnValue('' as any);
});

afterEach(async () => {
  await flush();
  built.splice(0).forEach(panel => panel.dispose());
  jest.restoreAllMocks();
});

describe('the tile click path refuses before it launches', () => {
  it('waits for the server root rather than joining onto an empty one', async () => {
    // ACC-LNCH-148. Without the guard the folder is `/data/raw` - a directory
    // at the filesystem root, which the server accepts whenever it exists.
    const h = harness({ rootDir: '' });
    await flush();
    request.mockClear();

    expect(await h.panel.launchHere('data/raw')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Waiting for the server root');
    expect(h.launches).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a folder on a drive that is not the server filesystem', async () => {
    // ACC-LNCH-149. `S3:data` would resolve against the server's own root as
    // `data` - an unrelated directory of the same name.
    const h = harness();
    await flush();
    request.mockClear();

    expect(await h.panel.launchHere('S3:data')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('drive');
    expect(h.launches).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it('names the sibling extension when its command is not registered', async () => {
    // ACC-LNCH-155. The coupling is a command id, so its absence can only be
    // discovered at click time.
    const h = harness({ sibling: false });
    await flush();
    request.mockClear();

    expect(await h.panel.launchHere('proj')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(
      'jupyterlab_basic_terminal_extension'
    );
    expect(h.launches).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('the tile click path resumes a folder that has a conversation', () => {
  it('focuses the open terminal already running it, and launches nothing', async () => {
    // ACC-LNCH-152. A second process on one history is never what the click
    // meant.
    routes({
      sessions: { sessions: [session()] },
      'terminal/term-1': {
        terminal_name: 'term-1',
        running: true,
        session_id: 'sid-proj'
      }
    });
    const h = harness({ tracker: true });
    await flush();

    expect(await h.panel.launchHere('proj')).toBe(OPEN_TERMINAL);
    expect(h.activated).toEqual(['terminal-open-1']);
    expect(h.launches).toEqual([]);
    expect(callsTo('launch-argv')).toHaveLength(0);
  });

  it('asks for resume argv when no terminal holds it, and launches that', async () => {
    // ACC-LNCH-151 / ACC-LNCH-154: the row's own conversation, resumed through
    // the sibling's terminal.
    routes({
      sessions: { sessions: [session()] },
      'launch-argv': { argv: ['/bin/testbed', '--resume', 'sid-proj'] }
    });
    const h = harness();
    await flush();

    expect(await h.panel.launchHere('proj')).toBe(LAUNCHED_WIDGET);
    expect(bodyOf('launch-argv')).toEqual({
      project_path: '/srv/lab/proj',
      encoded_path: 'enc-proj',
      session_id: 'sid-proj'
    });
    expect(h.launches).toEqual([
      {
        argv: ['/bin/testbed', '--resume', 'sid-proj'],
        cwd: '/srv/lab/proj'
      }
    ]);
  });

  it('asks the server on every click, and the fresh listing beats the cache', async () => {
    // ACC-LNCH-151. `_sessions` is written by `_fetch` (and the optimistic
    // remove in `_removeProject`), and the poll that
    // calls `_fetch` stops while the panel is hidden - so the cache a click
    // reads can be older than the folder's real conversation. Here it is empty
    // and the server has the row: reading the cache would have started a
    // second conversation in a folder that already had one.
    routes({
      sessions: { sessions: [session()] },
      'launch-argv': { argv: ['/bin/testbed'] }
    });
    const h = harness();
    await flush();
    request.mockClear();
    (h.panel as any)._sessions = [];

    await h.panel.launchHere('proj');
    expect(callsTo('sessions')).toHaveLength(1);
    const body = bodyOf('launch-argv');
    expect(body.session_id).toBe('sid-proj');
    expect(body.new_session_id).toBeUndefined();
  });

  it('resumes on the second click what the first click started', async () => {
    // The panel need never have polled between the two clicks - the tile is
    // clickable with the panel hidden - so only the click's own listing can
    // tell the second one that the folder now has a conversation.
    let listing: ISession[] = [];
    request.mockImplementation((_id: string, path: string) =>
      Promise.resolve(
        path === 'sessions'
          ? { sessions: listing }
          : path === 'launch-argv'
            ? { argv: ['/bin/testbed'] }
            : {}
      )
    );
    const h = harness();
    await flush();
    request.mockClear();
    (h.panel as any)._sessions = [];

    await h.panel.launchHere('proj');
    const first = bodyOf('launch-argv');
    expect(typeof first.new_session_id).toBe('string');
    expect(first.session_id).toBeUndefined();

    listing = [session({ session_id: first.new_session_id })];
    request.mockClear();

    await h.panel.launchHere('proj');
    const second = bodyOf('launch-argv');
    expect(second.session_id).toBe(first.new_session_id);
    expect(second.new_session_id).toBeUndefined();
  });
});

describe('the tile click path starts a new session in an unknown folder', () => {
  it('mints the conversation id when the CLI takes one', async () => {
    // ACC-LNCH-153, and ACC-LNCH-147 for the mode: settings decide it, with
    // nothing forced.
    routes({
      sessions: { sessions: [session({ project_path: '/srv/lab/other' })] },
      'launch-argv': { argv: ['/bin/testbed'] }
    });
    const h = harness();
    h.panel.setModes({ skip: true });
    await flush();

    expect(await h.panel.launchHere('proj')).toBe(LAUNCHED_WIDGET);
    const body = bodyOf('launch-argv');
    expect(body.project_path).toBe('/srv/lab/proj');
    expect(body.session_id).toBeUndefined();
    expect(body.encoded_path).toBeUndefined();
    expect(body.mode).toBe('skip');
    expect(typeof body.new_session_id).toBe('string');
    expect(body.new_session_id.length).toBeGreaterThan(0);
  });

  it('leaves the id to the CLI when the descriptor does not mint one', async () => {
    routes({
      sessions: { sessions: [] },
      'launch-argv': { argv: ['/bin/testbed'] }
    });
    const h = harness({ descriptor: NO_MINT_DESCRIPTOR });
    await flush();

    await h.panel.launchHere('');
    const body = bodyOf('launch-argv');
    // The empty cwd is the server root, not a missing folder.
    expect(body.project_path).toBe('/srv/lab');
    expect(body.new_session_id).toBeUndefined();
    expect(h.launches[0].cwd).toBe('/srv/lab');
  });
});

describe('the tile click path reports a refusal and stops', () => {
  it('names the binary when the argv route answers 503 cli_not_found', async () => {
    const refusal = new Error('cli_not_found');
    (refusal as any).response = { status: 503 };
    routes({ sessions: { sessions: [] }, 'launch-argv': refusal });
    const h = harness();
    await flush();

    expect(await h.panel.launchHere('proj')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('`testbed`');
    expect(error).not.toHaveBeenCalled();
    expect(h.launches).toEqual([]);
  });

  it('shows the message on any other failure, and does not retry', async () => {
    routes({
      sessions: { sessions: [] },
      'launch-argv': new Error('project root is gone')
    });
    const h = harness();
    await flush();

    expect(await h.panel.launchHere('proj')).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('project root is gone');
    expect(h.launches).toEqual([]);
    expect(callsTo('launch-argv')).toHaveLength(1);
  });

  it('reports a refusal from the sibling command and keeps the Launcher tab', async () => {
    // The Launcher shows a modal "Launcher Error" for any rejection that
    // escapes the command it ran, so a refused spawn is answered here with one
    // notification and an undefined result instead.
    routes({
      sessions: { sessions: [] },
      'launch-argv': { argv: ['/bin/testbed'] }
    });
    const h = harness({ siblingFails: true });
    await flush();

    await expect(h.panel.launchHere('proj')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('Could not open a terminal');
    expect(error.mock.calls[0][0]).toContain('no terminal service');
  });
});

describe('the tiles the plugin adds to the Launcher', () => {
  /** Activate the plugin against a launcher double, with every assistant
   * present. */
  async function activate(): Promise<{
    added: any[];
    docked: AssistantSessionsPanel[];
  }> {
    statusRequest.mockImplementation((path: string) =>
      path === 'status'
        ? Promise.resolve({
            root_dir: '/srv/lab',
            delete_to_trash: true,
            providers: PROVIDERS.map(module => ({
              id: module.descriptor.id,
              available: true
            }))
          })
        : Promise.reject(new Error('no other route'))
    );
    const added: any[] = [];
    const docked: AssistantSessionsPanel[] = [];
    const launcher = {
      add: (options: any) => {
        added.push(options);
        return { dispose: () => undefined };
      }
    } as any;
    const app = {
      serviceManager: { serverSettings: {} },
      commands: new CommandRegistry(),
      hasPlugin: () => false
    } as any;
    const labShell = {
      add: (widget: AssistantSessionsPanel) => docked.push(widget)
    } as any;
    await (plugin.activate as any)(
      app,
      labShell,
      null,
      null,
      null,
      null,
      null,
      launcher
    );
    await flush();
    docked.forEach(panel => built.push(panel));
    return { added, docked };
  }

  it('ranks each tile by its provider position in the registry barrel', async () => {
    // ACC-LNCH-158. A shared constant here would order the section
    // alphabetically instead of like the sidebar.
    const { added } = await activate();
    expect(added).toHaveLength(PROVIDERS.length);
    expect(added.map(item => item.command)).toEqual(
      PROVIDERS.map(module => commandId(module.descriptor.id, 'launch-here'))
    );
    expect(added.map(item => item.rank)).toEqual(
      PROVIDERS.map((_module, index) => index)
    );
  });

  it('gives every tile the one categoryRank that seats the section', async () => {
    // ACC-LNCH-156. The Launcher ranks Notebook 0, Console 20 and Other 100,
    // and the smallest rank among a category's items decides the category - so
    // a per-tile value would move the section with whichever tile is added.
    const { added } = await activate();
    const ranks = new Set(added.map(item => item.categoryRank));
    expect(ranks.size).toBe(1);
    const rank = [...ranks][0];
    // Above Other's 100, finite so unranked categories still come last.
    expect(rank).toBeGreaterThan(100);
    expect(Number.isFinite(rank)).toBe(true);
  });
});
