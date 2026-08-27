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

import { providerIcon } from '../core/icons';
import { AssistantSessionsPanel, commandId } from '../core/panel';
import { requestAPI } from '../core/request';
import plugin from '../index';
import { PROVIDERS } from '../providers';

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

describe('ACC-LNCH-143..146 - the Launcher tile has the panel lifecycle', () => {
  /** A roster in which every assistant is present, or every one but `absent`. */
  const roster = (absent?: string): unknown => ({
    root_dir: '/srv/lab',
    delete_to_trash: true,
    providers: PROVIDERS.map(module => ({
      id: module.descriptor.id,
      available: module.descriptor.id !== absent
    }))
  });

  interface IActivation {
    app: any;
    docked: AssistantSessionsPanel[];
    /** Every `ILauncher.add` call, in order. */
    added: any[];
    /** Commands whose tile has been disposed. */
    disposed: string[];
    /** Replace the roster the next probe answers with. */
    setRoster: (next: unknown) => void;
  }

  /** Activate the plugin with no settings registry - every assistant enabled
   * by default - against a launcher double, or none at all. */
  async function activate(withLauncher = true): Promise<IActivation> {
    let current = roster();
    request.mockImplementation((path: string) =>
      path === 'status'
        ? Promise.resolve(current)
        : Promise.reject(new Error('no other route'))
    );
    const added: any[] = [];
    const disposed: string[] = [];
    const docked: AssistantSessionsPanel[] = [];
    const launcher = withLauncher
      ? ({
          add: (options: any) => {
            added.push(options);
            return { dispose: () => disposed.push(options.command) };
          }
        } as any)
      : null;
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
    return {
      app,
      docked,
      added,
      disposed,
      setRoster: (next: unknown) => {
        current = next;
      }
    };
  }

  it('adds one tile per docked assistant, labelled and iconed from its descriptor', async () => {
    const live = await activate();
    expect(live.added).toHaveLength(PROVIDERS.length);
    for (const module of PROVIDERS) {
      const id = commandId(module.descriptor.id, 'launch-here');
      const tile = live.added.find(item => item.command === id);
      expect(tile).toBeDefined();
      expect(tile.category).toBe('AI Assistants');
      expect(live.app.commands.label(id)).toBe(module.descriptor.label);
      expect(live.app.commands.icon(id)).toBe(
        providerIcon(module.descriptor.iconName, module.descriptor.iconSvg)
      );
    }
    live.docked.forEach(widget => widget.dispose());
  });

  it('disposes the tile and its command when the panel stops', async () => {
    const live = await activate();
    const id = commandId(PROVIDERS[0].descriptor.id, 'launch-here');
    expect(live.app.commands.hasCommand(id)).toBe(true);

    // The server now reports that assistant's binary gone, which is the same
    // decision that undocks its panel - there is no second one for the tile.
    live.setRoster(roster(PROVIDERS[0].descriptor.id));
    window.dispatchEvent(new Event('online'));
    await flush();

    expect(live.disposed).toEqual([id]);
    expect(live.app.commands.hasCommand(id)).toBe(false);
    expect(live.docked[0].isDisposed).toBe(true);
    live.docked.forEach(widget => widget.dispose());
  });

  it('gives an assistant whose binary is absent neither a panel nor a tile', async () => {
    const absent = PROVIDERS[1].descriptor.id;
    request.mockImplementation((path: string) =>
      path === 'status'
        ? Promise.resolve(roster(absent))
        : Promise.reject(new Error('no other route'))
    );
    const added: any[] = [];
    const docked: AssistantSessionsPanel[] = [];
    await (plugin.activate as any)(
      {
        serviceManager: { serverSettings: {} },
        commands: new CommandRegistry(),
        hasPlugin: () => false
      } as any,
      { add: (widget: AssistantSessionsPanel) => docked.push(widget) } as any,
      null,
      null,
      null,
      null,
      null,
      {
        add: (options: any) => {
          added.push(options);
          return { dispose: () => undefined };
        }
      } as any
    );
    await flush();

    expect(docked.map(widget => widget.node.dataset.provider)).not.toContain(
      absent
    );
    expect(added.map(item => item.command)).not.toContain(
      commandId(absent, 'launch-here')
    );
    expect(added).toHaveLength(PROVIDERS.length - 1);
    docked.forEach(widget => widget.dispose());
  });

  it('docks the panels and adds nothing when JupyterLab has no launcher', async () => {
    // `start` swallows what a provider throws, so "nothing threw" is read off
    // the line it logs rather than off the activation resolving.
    const logged = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const live = await activate(false);
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
    expect(live.docked).toHaveLength(PROVIDERS.length);
    expect(live.added).toEqual([]);
    // The command is still registered - only the tile depends on the launcher.
    expect(
      live.app.commands.hasCommand(
        commandId(PROVIDERS[0].descriptor.id, 'launch-here')
      )
    ).toBe(true);
    live.docked.forEach(widget => widget.dispose());
  });
});
