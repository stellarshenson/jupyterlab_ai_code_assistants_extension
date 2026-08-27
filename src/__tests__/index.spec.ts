/**
 * The plugin's own activation path - the only tier that reaches it.
 *
 * `src/index.ts` carried no Jest coverage at all (0 of 151 lines), and the
 * Galata DEF-132 spec stops at the panels docking, before the first probe ever
 * answers. The branch below is what makes a panel docked without a roster
 * usable once one arrives: `reconcile` pushes the late `root_dir` and trash
 * flag into the already-live panel (DEF-GUARD-139).
 *
 * Nothing here waits on a timer. The activation probe fails, the roster is
 * delivered by dispatching `online`, and the promise chain is drained through
 * the microtask queue.
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
  isRequestTimeout: () => false,
  isResponseStatus: () => false,
  withQuery: (path: string) => path
}));

import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';

import { AssistantSessionsPanel } from '../core/panel';
import { requestAPI } from '../core/request';
import plugin from '../index';

const request = requestAPI as jest.Mock;

/** Drain the microtask queue - `probeStatus().then(reconcile)` and nothing
 * longer-lived, so no timer is involved. */
async function flush(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

describe('DEF-GUARD-139 - reconcile hands a late roster to a docked panel', () => {
  it('a panel docked before the first roster gains the root and the trash flag', async () => {
    let roster: unknown = null;
    request.mockImplementation((path: string) =>
      path === 'status' && roster
        ? Promise.resolve(roster)
        : Promise.reject(new Error('server down'))
    );

    const docked: AssistantSessionsPanel[] = [];
    const labShell = {
      add: (w: AssistantSessionsPanel) => {
        docked.push(w);
      }
    } as any;
    const app = {
      serviceManager: { serverSettings: {} },
      commands: new CommandRegistry(),
      hasPlugin: () => false
    } as any;
    const settings = {
      composite: {},
      get: () => ({ composite: undefined, user: undefined }),
      set: async () => undefined,
      changed: new Signal<unknown, void>({})
    };
    const settingRegistry = { load: async () => settings } as any;
    const fileBrowser = { model: { path: 'data/raw' } } as any;

    await (plugin.activate as any)(
      app,
      labShell,
      null,
      settingRegistry,
      null,
      fileBrowser,
      null
    );

    // The activation probe failed, so every enabled assistant docked with no
    // root and, with the roster unknown, with trash treated as unavailable.
    const panel = docked.find(w => w.node.dataset.provider === 'claude')!;
    expect(panel).toBeDefined();
    expect((panel as any)._rootDir).toBe('');
    expect((panel as any)._deleteToTrash).toBe(false);

    // A later probe answers. The panel is already live, so `start` is not the
    // path that carries the root to it - `reconcile` is.
    roster = {
      providers: [
        { id: 'claude', available: true },
        { id: 'codex', available: true },
        { id: 'kimi', available: true },
        { id: 'gemini', available: true }
      ],
      root_dir: '/srv/lab',
      delete_to_trash: true
    };
    window.dispatchEvent(new Event('online'));
    await flush();

    // How this fails: drop the `panel.setRoot(...)` call in `reconcile` and
    // the root stays empty forever - the + button never arms and every path
    // resolution answers "outside the JupyterLab root".
    expect((panel as any)._rootDir).toBe('/srv/lab');
    expect((panel as any)._deleteToTrash).toBe(true);
    expect((panel as any)._currentFolder()).toBe('/srv/lab/data/raw');

    docked.forEach(w => w.dispose());
  });
});
