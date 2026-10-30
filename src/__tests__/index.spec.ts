/**
 * The plugin's own activation path - the only tier that reaches it.
 *
 * `src/index.ts` carried no Jest coverage at all (0 of 151 lines), and the
 * Galata DEF-132 spec stops at the panels docking, before the first probe ever
 * answers. The branch below is what makes a panel docked without a roster
 * usable once one arrives: `reconcile` pushes the late `root_dir` and trash
 * flag into the already-live panel (DEF-GUARD-139).
 *
 * Nothing here waits on a timer longer than one macrotask. The activation
 * probe fails, the roster is delivered by dispatching `online`, and `flush`
 * lets the wake's status check go out and drains its promise chain.
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
  API_NAMESPACE: 'jupyterlab-ai-code-assistants-extension',
  WINDOW_ID: 'this-window',
  requestAPI: jest.fn(),
  requestProvider: jest.fn(() => Promise.resolve({})),
  isRequestTimeout: () => false,
  isResponseStatus: () => false,
  withQuery: (path: string) => path
}));

import * as fs from 'fs';
import * as path from 'path';

import { Notification } from '@jupyterlab/apputils';
import { SettingRegistry } from '@jupyterlab/settingregistry';
import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';

import { providerIcon } from '../core/icons';
import {
  AssistantSessionsPanel,
  MOVE_PANELS_COMMAND,
  SYNC_FILE_BROWSER_COMMAND,
  commandId,
  panelWidgetId
} from '../core/panel';
import { requestAPI, requestProvider } from '../core/request';
import plugin from '../index';
import { PROVIDERS } from '../providers';

const request = requestAPI as jest.Mock;
const provider = requestProvider as jest.Mock;

/** Let a wake's status check run: the one macrotask in which coinciding
 * triggers share a request, then `probeStatus().then(reconcile)` through the
 * microtask queue. No longer timer is involved. */
async function flush(turns = 8): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

/** jsdom has no BroadcastChannel. This one joins every window of the test
 * process and delivers as a microtask, so `flush` settles it and, as in a
 * browser, a sender never hears its own message. Two windows reloading each
 * other would post forever and starve every timer, jest's own included, so
 * past a cap no legitimate run reaches it throws instead of hanging. */
class TestBroadcastChannel {
  private static _open: TestBroadcastChannel[] = [];
  private static _posted = 0;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly name: string) {
    TestBroadcastChannel._open.push(this);
  }

  postMessage(data: unknown): void {
    TestBroadcastChannel._posted += 1;
    if (TestBroadcastChannel._posted > 1000) {
      throw new Error('windows are reloading each other without end');
    }
    for (const other of TestBroadcastChannel._open) {
      if (other !== this && other.name === this.name) {
        queueMicrotask(() => other.onmessage?.({ data }));
      }
    }
  }
}
(globalThis as any).BroadcastChannel = TestBroadcastChannel;

/** The events socket a window opens at the end of activation. jsdom's own
 * WebSocket would dial a server; this one is recorded, so a test opens it,
 * pushes a message through it and drops it by hand. */
class FakeSocket {
  static sockets: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.sockets.push(this);
  }

  close(): void {
    this.onclose?.();
  }

  push(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

/** Server settings an activation can open its events socket with. Each call
 * is a new object, because a probe tells its activation by this identity. */
const socketSettings = (): any => ({ WebSocket: FakeSocket });

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
      serviceManager: { serverSettings: socketSettings() },
      commands: new CommandRegistry(),
      hasPlugin: () => false
    } as any;
    const settings = {
      raw: '{}',
      composite: {},
      get: () => ({ composite: undefined, user: undefined }),
      set: async () => undefined,
      changed: new Signal<unknown, void>({})
    };
    const settingRegistry = {
      connector: { fetch: async () => ({ raw: settings.raw }) },
      load: async () => settings
    } as any;
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

describe('DEF-GUARD-122 - a wake during activation', () => {
  it('is remembered, reconciles nothing before the settings load, and is answered by one status check once the listeners are armed', async () => {
    // Identity of this activation's probes; earlier activations' listeners
    // reach the same mock (see the activation-contract harness below).
    const serverSettings = socketSettings();
    let probes = 0;
    request.mockImplementation((path: string, settings: unknown) => {
      if (path !== 'status' || settings !== serverSettings) {
        return Promise.reject(new Error('not this activation'));
      }
      probes += 1;
      return Promise.resolve({
        root_dir: '/srv/lab',
        delete_to_trash: true,
        providers: PROVIDERS.map(m => ({
          id: m.descriptor.id,
          available: true
        }))
      });
    });
    const docked: AssistantSessionsPanel[] = [];
    const labShell = {
      add: (w: AssistantSessionsPanel) => {
        docked.push(w);
      }
    } as any;
    const app = {
      serviceManager: { serverSettings },
      commands: new CommandRegistry(),
      hasPlugin: () => false
    } as any;
    // Every assistant off, so a reconcile on the enabled-by-default fallback
    // would show as a docked panel.
    const composite: Record<string, unknown> = Object.fromEntries(
      PROVIDERS.map(m => [`providers.${m.descriptor.id}.enabled`, false])
    );
    const settings = {
      raw: '{}',
      composite,
      get: (key: string) => ({
        composite: composite[key],
        user: composite[key]
      }),
      set: async () => undefined,
      changed: new Signal<unknown, void>({})
    };
    let finishLoad!: () => void;
    const loading = new Promise<void>(resolve => {
      finishLoad = resolve;
    });
    const settingRegistry = {
      connector: { fetch: async () => ({ raw: settings.raw }) },
      load: async () => {
        await loading;
        return settings;
      }
    } as any;

    const activation = (plugin.activate as any)(
      app,
      labShell,
      null,
      settingRegistry,
      null,
      null,
      null
    );
    await flush();
    expect(probes).toBe(1); // the activation probe; the settings still load

    window.dispatchEvent(new Event('online'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible'
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(probes).toBe(1);
    expect(docked).toHaveLength(0);

    finishLoad();
    await activation;
    await flush();
    // How this fails: without the remembered wake the count stays 1 until the
    // next trigger, for no timer checks again; a listener that probes before
    // the settings load docks every assistant above, and one probe per wake
    // makes it 3.
    expect(probes).toBe(2);
    expect(docked).toHaveLength(0);
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
      serviceManager: { serverSettings: socketSettings() },
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
      // A `launcherTileIcon` view of the provider's own icon - the header
      // draws the joint icon through it (launcher-icon.spec.ts).
      expect(Object.getPrototypeOf(live.app.commands.icon(id))).toBe(
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
        serviceManager: { serverSettings: socketSettings() },
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

describe('ACC-PROV - the activation contract', () => {
  /** The settings file on the server, shared by every window activated here. */
  let serverRaw = '{}';
  let saves = 0;

  /** A roster in which every assistant is present, or every one but `absent`. */
  const roster = (absent?: string): unknown => ({
    root_dir: '/srv/lab',
    delete_to_trash: true,
    providers: PROVIDERS.map(module => ({
      id: module.descriptor.id,
      available: module.descriptor.id !== absent
    }))
  });

  interface IHarness {
    app: any;
    docked: AssistantSessionsPanel[];
    /** Every `ILayoutRestorer.add` call, as `[widget, id]`. */
    restored: [AssistantSessionsPanel, string][];
    /** How many times the status route has been asked. */
    probes: () => number;
    /** Plugin ids passed to `ISettingRegistry.reload`, in order. */
    reloaded: string[];
    /** Save from this window: the server and this window hold the new copy,
     * and `changed` fires. */
    save: () => void;
  }

  interface IOptions {
    /** Saved settings, as the composite object the registry exposes. */
    composite?: Record<string, unknown>;
    /** Keys the user has set explicitly, rather than inherited from the schema. */
    userSet?: string[];
    /** What the status route answers, call by call. The last entry repeats. */
    answers?: (() => Promise<unknown>)[];
    /** Provider ids whose `labShell.add` throws. */
    failsToDock?: string[];
  }

  async function activate(options: IOptions = {}): Promise<IHarness> {
    const answers = options.answers ?? [() => Promise.resolve(roster())];
    let call = 0;
    // Every activation in this file leaves its own `online` listener on the
    // window, and they all reach the one shared `requestAPI` mock - so a probe
    // counted here would count the previous describes' probes too, and an
    // `answers` queue would be drained by them. `serverSettings` is passed
    // through by identity, so it is the one thing that tells this activation's
    // probes from theirs.
    const serverSettings = socketSettings();
    request.mockImplementation((path: string, settings: unknown) => {
      if (path !== 'status' || settings !== serverSettings) {
        return Promise.reject(new Error('not this activation'));
      }
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return answer();
    });

    const docked: AssistantSessionsPanel[] = [];
    const restored: [AssistantSessionsPanel, string][] = [];
    const failsToDock = new Set(options.failsToDock ?? []);
    const labShell = {
      add: (widget: AssistantSessionsPanel) => {
        if (failsToDock.has(widget.descriptor.id)) {
          throw new Error(`cannot dock ${widget.descriptor.id}`);
        }
        if (!docked.includes(widget)) {
          docked.push(widget);
        }
      }
    } as any;
    const restorer = {
      add: (widget: AssistantSessionsPanel, id: string) => {
        restored.push([widget, id]);
      }
    } as any;
    const app = {
      serviceManager: { serverSettings },
      commands: new CommandRegistry(),
      hasPlugin: () => false
    } as any;

    const composite = options.composite;
    const userSet = new Set(options.userSet ?? Object.keys(composite ?? {}));
    const reloaded: string[] = [];
    const changed = new Signal<unknown, void>({});
    const loaded = composite && {
      raw: serverRaw,
      composite,
      get: (key: string) => ({
        composite: composite[key],
        user: userSet.has(key) ? composite[key] : undefined
      }),
      set: async () => undefined,
      changed
    };
    const settingRegistry = loaded
      ? ({
          connector: { fetch: async () => ({ raw: serverRaw }) },
          // JupyterLab's reload takes the server's copy and fires `changed`
          // before it resolves.
          reload: async (id: string) => {
            reloaded.push(id);
            loaded.raw = serverRaw;
            changed.emit(undefined);
          },
          load: async () => loaded
        } as any)
      : null;

    await (plugin.activate as any)(
      app,
      labShell,
      restorer,
      settingRegistry,
      null,
      null,
      null
    );
    await flush();
    return {
      app,
      docked,
      restored,
      probes: () => call,
      reloaded,
      save: () => {
        saves += 1;
        serverRaw = `{"saves": ${saves}}`;
        if (loaded) {
          loaded.raw = serverRaw;
        }
        changed.emit(undefined);
      }
    };
  }

  /** Every assistant, turned off. */
  const allDisabled = (): Record<string, unknown> =>
    Object.fromEntries(
      PROVIDERS.map(module => [
        `providers.${module.descriptor.id}.enabled`,
        false
      ])
    );

  it('registers the Open Callback command at activation', async () => {
    const live = await activate();
    expect(live.app.commands.hasCommand('open:callback')).toBe(true);
    live.docked.forEach(widget => widget.dispose());
  });

  it('ACC-PROV-10, ACC-PROV-11 - each panel carries its own widget id and registers it for restore', async () => {
    const live = await activate();
    // How this fails: pass a constant to `restorer.add` and two panels claim
    // one id, so JupyterLab restores whichever was registered last and the
    // others come back closed.
    const ids = live.restored.map(([, id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [widget, id] of live.restored) {
      expect(id).toBe(panelWidgetId(widget.descriptor.id));
      expect(widget.id).toBe(id);
    }
    expect(ids).toHaveLength(PROVIDERS.length);
    live.docked.forEach(widget => widget.dispose());
  });

  it('ACC-PROV-9 - commands are namespaced per provider, so two never collide', async () => {
    const live = await activate();
    const registered: string[] = [];
    for (const module of PROVIDERS) {
      for (const action of ['refresh', 'launch-here']) {
        const id = commandId(module.descriptor.id, action);
        expect(live.app.commands.hasCommand(id)).toBe(true);
        expect(id).toBe(`ai-code-assistants:${module.descriptor.id}:${action}`);
        registered.push(id);
      }
    }
    expect(new Set(registered).size).toBe(registered.length);
    live.docked.forEach(widget => widget.dispose());
  });

  it('ACC-PROV-13 - every assistant disabled activates with no panel and no dialog', async () => {
    const warned = jest
      .spyOn(Notification, 'warning')
      .mockImplementation(() => '');
    const errored = jest
      .spyOn(Notification, 'error')
      .mockImplementation(() => '');
    const logged = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const live = await activate({ composite: allDisabled() });

    // Ids, not the widgets themselves: jest deep-copies both sides to build a
    // diff, and copying a live Lumino widget graph exhausts the heap before
    // the failure is printed - the assertion is right and unreadable.
    expect(live.docked.map(widget => widget.descriptor.id)).toEqual([]);
    expect(live.restored.map(([, id]) => id)).toEqual([]);
    expect(warned).not.toHaveBeenCalled();
    expect(errored).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
    warned.mockRestore();
    errored.mockRestore();
    logged.mockRestore();
  });

  it('ACC-PROV-14 - an unknown assistant in saved settings is ignored with one warning', async () => {
    const warned = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const live = await activate({
      composite: { 'providers.nimbus.enabled': true },
      answers: [() => Promise.resolve(roster())]
    });

    // Activation did not fail: every real assistant still docked.
    expect(live.docked).toHaveLength(PROVIDERS.length);
    const about = warned.mock.calls
      .map(args => String(args[0]))
      .filter(line => line.includes('nimbus'));
    expect(about).toHaveLength(1);
    expect(about[0]).toContain('unknown assistant');

    // Once per id, not once per reconcile - this path runs on every probe.
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(
      warned.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes('nimbus'))
    ).toHaveLength(1);

    warned.mockRestore();
    live.docked.forEach(widget => widget.dispose());
  });

  it('DEF-PANE-277 - an enabled assistant whose binary is absent gets no panel and no toast', async () => {
    const toasted = jest
      .spyOn(Notification, 'warning')
      .mockImplementation(() => '');
    const logged = jest
      .spyOn(console, 'info')
      .mockImplementation(() => undefined);
    const absent = PROVIDERS[1].descriptor.id;

    // Saved explicitly, as the settings editor writes it. Enabled means the
    // extension supports the assistant, not that it is installed.
    const live = await activate({
      composite: { [`providers.${absent}.enabled`]: true },
      answers: [() => Promise.resolve(roster(absent))]
    });

    expect(
      live.docked
        .filter(widget => !widget.isDisposed)
        .map(widget => widget.descriptor.id)
    ).not.toContain(absent);
    expect(toasted).not.toHaveBeenCalled();
    // The reason stays in the browser console, once.
    expect(
      logged.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes(`"${absent}"`))
    ).toHaveLength(1);

    toasted.mockRestore();
    logged.mockRestore();
    live.docked.forEach(widget => widget.dispose());
  });

  it('DEF-PANE-282 - a focus with no newer save leaves the settings alone', async () => {
    const live = await activate({ composite: {} });

    // A reload fires `changed`, and an open JSON settings editor then drops
    // its unsaved text - so a focus that brings nothing newer must not reload.
    window.dispatchEvent(new Event('focus'));
    await flush(32);
    expect(live.reloaded).toEqual([]);

    live.docked.forEach(widget => widget.dispose());
  });

  it('DEF-PANE-282 - a focus after another device saved reloads the settings', async () => {
    const live = await activate({ composite: {} });

    // Saved elsewhere since this window loaded; this window's next save
    // would write the old copy back.
    serverRaw = '{"savedElsewhere": true}';
    window.dispatchEvent(new Event('focus'));
    await flush(32);
    expect(live.reloaded).toEqual([
      '@stellarshenson/jupyterlab-ai-code-assistants-extension:plugin'
    ]);

    live.docked.forEach(widget => widget.dispose());
  });

  it('DEF-PANE-282 - a change in one window makes the other windows of the browser reload', async () => {
    const one = await activate({ composite: {} });
    const other = await activate({ composite: {} });

    one.save();
    await flush(32);
    expect(other.reloaded).toEqual([
      '@stellarshenson/jupyterlab-ai-code-assistants-extension:plugin'
    ]);
    // The other window's reload fires `changed` and posts in turn; the window
    // that saved already holds the server's copy, so the echo stops there.
    expect(one.reloaded).toEqual([]);

    one.docked.forEach(widget => widget.dispose());
    other.docked.forEach(widget => widget.dispose());
  });

  it('ACC-PROV-16 - a binary installed after start gains its panel on the next probe', async () => {
    const late = PROVIDERS[2].descriptor.id;
    let present = false;
    const live = await activate({
      answers: [() => Promise.resolve(present ? roster() : roster(late))]
    });

    expect(live.docked.map(w => w.descriptor.id)).not.toContain(late);

    present = true;
    window.dispatchEvent(new Event('online'));
    await flush();

    // No reload: the same activation, one probe later.
    expect(live.docked.map(w => w.descriptor.id)).toContain(late);
    live.docked.forEach(widget => widget.dispose());
  });

  it('ACC-PROV-17 - a failed probe leaves the last roster standing and names no cadence', async () => {
    const warned = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    let fail = false;
    const live = await activate({
      answers: [
        () =>
          fail
            ? Promise.reject(new Error('server down'))
            : Promise.resolve(roster())
      ]
    });
    expect(live.docked).toHaveLength(PROVIDERS.length);

    fail = true;
    window.dispatchEvent(new Event('online'));
    await flush();

    // The roster the server last gave is still the roster in force.
    expect(live.docked.filter(w => !w.isDisposed)).toHaveLength(
      PROVIDERS.length
    );
    const line = warned.mock.calls
      .map(args => String(args[0]))
      .find(text => text.includes('status probe failed'));
    expect(line).toBeDefined();
    expect(line).toContain('until a later probe answers');
    // No cadence (DEF-122): there is none to name (ACC-PROV-230), and the same
    // line prints from the activation probe.
    expect(line).not.toMatch(/\b(60|minute|second|sec\b)/i);

    warned.mockRestore();
    live.docked.forEach(widget => widget.dispose());
  });

  it('ACC-PROV-18 - coming back online and the tab becoming visible each re-probe at once', async () => {
    const live = await activate();
    const afterActivation = live.probes();

    window.dispatchEvent(new Event('online'));
    await flush();
    expect(live.probes()).toBe(afterActivation + 1);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible'
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(live.probes()).toBe(afterActivation + 2);

    // Hidden is not a wake.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden'
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(live.probes()).toBe(afterActivation + 2);

    live.docked.forEach(widget => widget.dispose());
  });

  it('ACC-PROV-19 - a trigger during a probe is answered by one probe after it, and a failure writes nothing', async () => {
    // The starting roster is missing one binary, and that absence is what the
    // failure must not undo. Asserting only that the panels survive cannot
    // tell "the failure wrote nothing" from "the failure wrote null", because
    // a null roster reads as unknown, and unknown docks every enabled
    // assistant - so the two outcomes look identical from a full roster.
    const absent = PROVIDERS[3].descriptor.id;
    const dockedIds = (live: IHarness): string[] =>
      live.docked
        .filter(widget => !widget.isDisposed)
        .map(w => w.descriptor.id);

    let settle: ((value: unknown) => void) | null = null;
    const live = await activate({
      answers: [
        () => Promise.resolve(roster(absent)),
        // The wake's probe, held in flight.
        () =>
          new Promise(resolve => {
            settle = resolve;
          }),
        // The probe queued behind it, which fails.
        () => Promise.reject(new Error('server down'))
      ]
    });
    expect(dockedIds(live)).not.toContain(absent);
    const before = live.probes();

    window.dispatchEvent(new Event('online')); // probe, held in flight
    await flush();
    window.dispatchEvent(new Event('online')); // lands while it is in flight
    window.dispatchEvent(new Event('online'));
    await flush();
    // Queued, not sent: two probes in flight could answer out of order.
    expect(live.probes()).toBe(before + 1);

    settle!(roster(absent));
    await flush();
    // Exactly one probe after the answer, for the wakes it was sent before
    // (DEF-117) - not one per wake.
    expect(live.probes()).toBe(before + 2);
    // That probe failed and wrote nothing, so the roster still stands and the
    // missing binary is still missing.
    expect(dockedIds(live)).not.toContain(absent);
    expect(dockedIds(live)).toHaveLength(PROVIDERS.length - 1);

    live.docked.forEach(widget => widget.dispose());
  });

  it('ACC-PROV-12 - one provider failing to start leaves the others docked', async () => {
    const broken = PROVIDERS[0].descriptor.id;
    const logged = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const live = await activate({ failsToDock: [broken] });

    expect(live.docked.map(w => w.descriptor.id)).not.toContain(broken);
    expect(live.docked).toHaveLength(PROVIDERS.length - 1);
    expect(logged.mock.calls.map(args => String(args[0])).join('\n')).toContain(
      `provider "${broken}" failed to start`
    );

    logged.mockRestore();
    live.docked.forEach(widget => widget.dispose());
  });

  describe('the status triggers and the events socket', () => {
    const latestSocket = (): FakeSocket =>
      FakeSocket.sockets[FakeSocket.sockets.length - 1];

    /** Sessions reads sent by each assistant's panel in one activation. */
    const reads = (live: IHarness): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (const [id, path, settings] of provider.mock.calls) {
        if (
          path === 'sessions' &&
          settings === live.app.serviceManager.serverSettings
        ) {
          counts[id] = (counts[id] ?? 0) + 1;
        }
      }
      return counts;
    };

    const dockedIds = (live: IHarness): string[] =>
      live.docked
        .filter(widget => !widget.isDisposed)
        .map(widget => widget.descriptor.id);

    const setVisibility = (state: string): void => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => state
      });
    };

    it('ACC-PROV-230 - activation arms no interval for the status check', async () => {
      const intervals = jest.spyOn(window, 'setInterval');
      const live = await activate();

      // How this fails: arm the old 60 s re-probe again.
      expect(intervals).not.toHaveBeenCalled();

      intervals.mockRestore();
      live.docked.forEach(widget => widget.dispose());
    });

    it('ACC-PROV-231 - triggers that coincide issue one status request for every panel', async () => {
      const live = await activate();
      const before = live.probes();

      window.dispatchEvent(new Event('online'));
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();

      // One request for the network and the tab together, and one roster
      // serves every docked panel.
      expect(live.probes()).toBe(before + 1);
      expect(dockedIds(live)).toHaveLength(PROVIDERS.length);

      live.docked.forEach(widget => widget.dispose());
    });

    it('ACC-CLI-227 - a sessions-changed push re-reads only its own panel, with no status request', async () => {
      const live = await activate();
      const [target, ...others] = dockedIds(live);
      const before = reads(live);
      const probes = live.probes();

      latestSocket().push({ type: 'sessions-changed', provider: target });
      await flush();

      const after = reads(live);
      expect((after[target] ?? 0) - (before[target] ?? 0)).toBe(1);
      for (const id of others) {
        expect((after[id] ?? 0) - (before[id] ?? 0)).toBe(0);
      }
      expect(live.probes()).toBe(probes);

      live.docked.forEach(widget => widget.dispose());
    });

    it('DEF-PANE-370 - a sessions-changed push naming this window re-reads no panel, and one naming another window re-reads its panel', async () => {
      const live = await activate();
      const [target] = dockedIds(live);
      const before = reads(live);

      // This window's own change: its panel re-read after the write already.
      latestSocket().push({
        type: 'sessions-changed',
        provider: target,
        window: 'this-window'
      });
      await flush();
      expect(reads(live)[target] ?? 0).toBe(before[target] ?? 0);

      // Another window's change still reaches this one (ACC-CLI-227).
      latestSocket().push({
        type: 'sessions-changed',
        provider: target,
        window: 'other-window'
      });
      await flush();
      expect((reads(live)[target] ?? 0) - (before[target] ?? 0)).toBe(1);

      live.docked.forEach(widget => widget.dispose());
    });

    it('ACC-CLI-228 - a refresh push docks a newly available assistant and re-reads every panel, with no status request', async () => {
      const late = PROVIDERS[2].descriptor.id;
      const live = await activate({
        answers: [() => Promise.resolve(roster(late))]
      });
      expect(dockedIds(live)).not.toContain(late);
      const before = reads(live);
      const probes = live.probes();

      latestSocket().push({ type: 'refresh', status: roster() });
      await flush();

      // Docked from the roster the push carried, with no reload and no
      // request of its own.
      expect(dockedIds(live)).toContain(late);
      expect(live.probes()).toBe(probes);
      const after = reads(live);
      for (const id of dockedIds(live)) {
        expect((after[id] ?? 0) - (before[id] ?? 0)).toBe(1);
      }

      live.docked.forEach(widget => widget.dispose());
    });

    it('ACC-PROV-230 - after a drop the reopen timer checks nothing, and the open runs one status check and one read per panel', async () => {
      const live = await activate();
      const first = latestSocket();
      first.onopen!();
      await flush();
      const probes = live.probes();
      const before = reads(live);

      const timers = jest.spyOn(window, 'setTimeout');
      first.close();
      const reopen = timers.mock.calls.find(
        ([, delay]) => delay === 5000
      )?.[0] as () => void;
      timers.mockRestore();
      expect(reopen).toBeDefined();

      // The backoff timer fires: it only opens a socket.
      reopen();
      await flush();
      const second = latestSocket();
      expect(second).not.toBe(first);
      expect(live.probes()).toBe(probes);

      // The open after the drop answers what may have been pushed meanwhile.
      second.onopen!();
      await flush();
      expect(live.probes()).toBe(probes + 1);
      const after = reads(live);
      for (const id of dockedIds(live)) {
        expect((after[id] ?? 0) - (before[id] ?? 0)).toBe(1);
      }

      live.docked.forEach(widget => widget.dispose());
    });

    it('ACC-PROV-230 - a closed socket reopens at once when the network or the tab comes back', async () => {
      const live = await activate();
      latestSocket().onopen!();
      const opened = FakeSocket.sockets.length;

      latestSocket().close();
      window.dispatchEvent(new Event('online'));
      expect(FakeSocket.sockets.length).toBe(opened + 1);
      // A socket that is not closed is left alone.
      window.dispatchEvent(new Event('online'));
      expect(FakeSocket.sockets.length).toBe(opened + 1);

      latestSocket().close();
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(FakeSocket.sockets.length).toBe(opened + 2);

      await flush();
      live.docked.forEach(widget => widget.dispose());
    });

    it('ACC-PANE-232 - each panel is titled by its assistant name alone, and its Refresh command keeps Sessions', async () => {
      const names: Record<string, string> = {
        claude: 'Claude Code',
        codex: 'Codex',
        deepseek: 'DeepSeek',
        gemini: 'Gemini',
        kimi: 'Kimi Code'
      };
      const live = await activate();
      expect(dockedIds(live).sort()).toEqual(Object.keys(names).sort());

      for (const panel of live.docked) {
        const name = names[panel.descriptor.id];
        expect(panel.title.caption).toBe(name);
        expect(
          panel.node.querySelector('.jp-AiAssistantsPanel-title')!.textContent
        ).toBe(name);
        expect(
          live.app.commands.label(commandId(panel.descriptor.id, 'refresh'))
        ).toBe(`Refresh ${name} Sessions`);
      }

      live.docked.forEach(widget => widget.dispose());
    });
  });
});

describe('ACC-SETT - settings drive the panels', () => {
  const roster = (absent?: string): unknown => ({
    root_dir: '/srv/lab',
    delete_to_trash: true,
    providers: PROVIDERS.map(module => ({
      id: module.descriptor.id,
      available: module.descriptor.id !== absent
    }))
  });

  /** The shipped schema, as the registry hands it to the plugin. */
  const SHIPPED_SCHEMA = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', '..', 'schema', 'plugin.json'),
      'utf8'
    )
  );

  interface ISettingsHarness {
    app: any;
    /** Every `labShell.add` call, as `[widget, area]`, in order. */
    docks: [AssistantSessionsPanel, string][];
    /** Widgets currently docked and not disposed. */
    liveIds: () => string[];
    /** Write a settings value and fire `changed`, as the settings editor does. */
    set: (key: string, value: unknown) => void;
    terminal: { disposed: boolean; closed: boolean };
    /** Every value the plugin saved through `settings.set`, as `[key, value]`. */
    saved: [string, unknown][];
    /** Every `labShell.activateById` call, with the number of `labShell.add`
     * calls made before it. */
    activated: { id: string; afterDocks: number }[];
    /** The arguments of every `filebrowser:go-to-path` a panel ran. */
    moves: unknown[];
    /** The sidebar each live panel is in, by provider id. */
    areas: () => Record<string, string>;
    /** Place one panel as JupyterLab's own "Switch Sidebar Side" does: the
     * panel goes to that sidebar, and `labShell.add` obeys the placement from
     * then on. */
    placeWithJupyterLab: (providerId: string, area: string) => void;
    /** Every `labShell.move` call, as `[provider id, area]`. */
    shellMoves: [string, string][];
    /** Every save to another plugin's settings, as `[plugin, key, value]`. */
    layoutSaves: [string, string, unknown][];
    /** The `labShell` calls in order: `add:<id>`, `move:<id>`, `activate:<id>`. */
    sequence: string[];
  }

  /** Activate against a settings registry whose values can be changed live,
   * against no registry, or against a registry that rejects every save. */
  async function activate(
    composite: Record<string, unknown> = {},
    options: {
      loadThrows?: boolean;
      noRegistry?: boolean;
      saveRejects?: boolean;
      layoutSaveRejects?: boolean;
      shellNotRestored?: boolean;
      /** The `migrated` list `POST migrate` answers with; without it the
       * request fails, as with nothing to carry over. */
      migrated?: unknown[];
      /** JupyterLab's own registry, in place of the fake one below. */
      registry?: SettingRegistry;
      /** Sidebars the user chose in an earlier load, by provider id. The shell
       * has them before the panel exists. */
      placed?: Record<string, string>;
    } = {}
  ): Promise<ISettingsHarness> {
    const serverSettings = socketSettings();
    request.mockImplementation((path: string, settings: unknown) => {
      if (settings === serverSettings && path === 'status') {
        return Promise.resolve(roster());
      }
      if (
        settings === serverSettings &&
        path === 'migrate' &&
        options.migrated
      ) {
        return Promise.resolve({ migrated: options.migrated });
      }
      return Promise.reject(new Error('not this activation'));
    });

    const docks: [AssistantSessionsPanel, string][] = [];
    const activated: { id: string; afterDocks: number }[] = [];
    const areaOf = new Map<AssistantSessionsPanel, string>();
    const placements = new Map<AssistantSessionsPanel, string>();
    const shellMoves: [string, string][] = [];
    const sequence: string[] = [];
    const labShell = {
      // As the real sidebar does: a widget is hidden when it is added, and a
      // placement the user made with JupyterLab's own command overrides the
      // area the caller asks for.
      add: (widget: AssistantSessionsPanel, area: string) => {
        docks.push([widget, area]);
        sequence.push(`add:${widget.descriptor.id}`);
        // Before JupyterLab has restored its layout the shell only queues the
        // widget: it is in no area yet.
        if (options.shellNotRestored) {
          return;
        }
        areaOf.set(
          widget,
          placements.get(widget) ??
            options.placed?.[widget.descriptor.id] ??
            area
        );
        widget.hide();
      },
      widgets: (area: string) =>
        Array.from(areaOf)
          .filter(([widget, at]) => at === area && !widget.isDisposed)
          .map(([widget]) => widget)
          [Symbol.iterator](),
      // As the real shell does: the placement is replaced, the widget goes to
      // the area, and the whole placement record is returned.
      move: (widget: AssistantSessionsPanel, area: string) => {
        shellMoves.push([widget.descriptor.id, area]);
        sequence.push(`move:${widget.descriptor.id}`);
        if (options.shellNotRestored) {
          // As the real shell: its placement record does not exist yet.
          throw new TypeError('Cannot read properties of undefined');
        }
        placements.set(widget, area);
        areaOf.set(widget, area);
        widget.hide();
        const record = Object.fromEntries(
          Array.from(placements).map(([placed, at]) => [
            placed.id,
            { area: at }
          ])
        );
        return { 'single-document': record, 'multiple-document': record };
      },
      activateById: (id: string) => {
        activated.push({ id, afterDocks: docks.length });
        sequence.push(`activate:${id}`);
      }
    } as any;
    // A recorder in place of the file browser's own command. The tests below
    // read the arguments the panels passed to it.
    const moves: unknown[] = [];
    const commands = new CommandRegistry();
    commands.addCommand('filebrowser:go-to-path', {
      execute: args => {
        moves.push(args);
      }
    });
    const app = {
      serviceManager: { serverSettings },
      commands,
      hasPlugin: () => false
    } as any;

    const changed = new Signal<unknown, void>({});
    const saved: [string, unknown][] = [];
    const settings = {
      composite,
      get: (key: string) => ({
        composite: composite[key],
        user: key in composite ? composite[key] : undefined
      }),
      // As the real registry does: a successful save changes the value and
      // emits `changed`; a failed save does neither.
      set: async (key: string, value: unknown) => {
        if (options.saveRejects) {
          throw new Error('the settings were not written');
        }
        saved.push([key, value]);
        composite[key] = value;
        changed.emit(undefined);
      },
      changed,
      raw: '{}',
      schema: SHIPPED_SCHEMA
    };
    const layoutSaves: [string, string, unknown][] = [];
    const settingRegistry = options.noRegistry
      ? null
      : (options.registry ??
        ({
          connector: { fetch: async () => ({ raw: settings.raw }) },
          // A save to another plugin's settings, by plugin id.
          set: async (pluginId: string, key: string, value: unknown) => {
            if (options.layoutSaveRejects) {
              throw new Error('the layout was not written');
            }
            layoutSaves.push([pluginId, key, value]);
          },
          load: async () => {
            if (options.loadThrows) {
              throw new Error('settings registry unavailable');
            }
            return settings;
          }
        } as any));

    // A running terminal, to prove a disable never reaches it. Both ways of
    // ending a terminal are wired to a flag, so the assertion is on the panel
    // calling NEITHER - a contract the panel keeps today and a future change
    // would break silently, since a closed terminal costs the user their work
    // rather than a failing request.
    const terminal = {
      disposed: false,
      closed: false,
      dispose(): void {
        terminal.disposed = true;
      },
      close(): void {
        terminal.closed = true;
      }
    };
    const terminalTracker = {
      currentWidget: null,
      widgets: [terminal],
      find: () => undefined,
      forEach: (fn: (w: unknown) => void) => [terminal].forEach(fn)
    } as any;

    await (plugin.activate as any)(
      app,
      labShell,
      null,
      settingRegistry,
      terminalTracker,
      null,
      null
    );
    await flush();

    return {
      app,
      docks,
      liveIds: () =>
        docks
          .map(([widget]) => widget)
          .filter((widget, index, all) => all.indexOf(widget) === index)
          .filter(widget => !widget.isDisposed)
          .map(widget => widget.descriptor.id),
      set: (key: string, value: unknown) => {
        composite[key] = value;
        changed.emit(undefined);
      },
      terminal,
      saved,
      activated,
      moves,
      areas: () =>
        Object.fromEntries(
          Array.from(areaOf)
            .filter(([widget]) => !widget.isDisposed)
            .map(([widget, at]) => [widget.descriptor.id, at])
        ),
      placeWithJupyterLab: (providerId: string, area: string) => {
        const widget = Array.from(areaOf.keys()).find(
          w => w.descriptor.id === providerId && !w.isDisposed
        )!;
        placements.set(widget, area);
        areaOf.set(widget, area);
      },
      shellMoves,
      layoutSaves,
      sequence
    };
  }

  const dispose = (live: ISettingsHarness): void =>
    live.docks.forEach(([widget]) => widget.dispose());

  /** Open one conversation whose project folder is `proj` under the roster's
   * root, from a docked panel, and return the file browser moves that open
   * made. The terminal open is replaced, so no launch request is sent. */
  async function movesOnOpen(
    live: ISettingsHarness,
    panel: AssistantSessionsPanel
  ): Promise<unknown[]> {
    (panel as any)._terminals.openSession = jest.fn(() => Promise.resolve());
    const before = live.moves.length;
    await (panel as any)._openSession({
      project_path: '/srv/lab/proj',
      encoded_path: 'enc-proj',
      session_id: 'sid-proj',
      name: 'proj',
      name_source: 'basename',
      message_count: 1,
      file_mtime: 1,
      git_branch: null,
      favourite: false,
      extra_sessions: 0
    });
    await flush();
    return live.moves.slice(before);
  }

  it('ACC-SETT-22, ACC-SETT-23 - no saved settings enables every assistant whose CLI is present', async () => {
    const live = await activate({});
    // Every key absent: absent reads as enabled, so every provider docks.
    expect(live.liveIds().sort()).toEqual(
      PROVIDERS.map(module => module.descriptor.id).sort()
    );
    dispose(live);
  });

  it('ACC-SETT-25 - switching a provider on docks it and registers its commands, with no reload', async () => {
    const id = PROVIDERS[0].descriptor.id;
    const live = await activate({ [`providers.${id}.enabled`]: false });
    expect(live.liveIds()).not.toContain(id);
    expect(live.app.commands.hasCommand(commandId(id, 'refresh'))).toBe(false);

    live.set(`providers.${id}.enabled`, true);
    await flush();

    // Same activation, no second `plugin.activate` call.
    expect(live.liveIds()).toContain(id);
    expect(live.app.commands.hasCommand(commandId(id, 'refresh'))).toBe(true);
    expect(live.app.commands.hasCommand(commandId(id, 'launch-here'))).toBe(
      true
    );
    dispose(live);
  });

  it('ACC-SETT-26 - switching a provider off disposes its widget and removes its commands', async () => {
    const id = PROVIDERS[0].descriptor.id;
    const live = await activate({});
    expect(live.liveIds()).toContain(id);

    live.set(`providers.${id}.enabled`, false);
    await flush();

    expect(live.liveIds()).not.toContain(id);
    expect(live.app.commands.hasCommand(commandId(id, 'refresh'))).toBe(false);
    expect(live.app.commands.hasCommand(commandId(id, 'launch-here'))).toBe(
      false
    );
    const panel = live.docks.find(([w]) => w.descriptor.id === id)![0];
    expect(panel.isDisposed).toBe(true);
    dispose(live);
  });

  it('ACC-SETT-31 - disabling a provider leaves its running terminals alive', async () => {
    const id = PROVIDERS[0].descriptor.id;
    const live = await activate({});

    live.set(`providers.${id}.enabled`, false);
    await flush();

    // The panel went; the terminal it launched did not.
    expect(live.liveIds()).not.toContain(id);
    expect(live.terminal.disposed).toBe(false);
    expect(live.terminal.closed).toBe(false);
    dispose(live);
  });

  it('ACC-SETT-32 - disabling the last enabled provider leaves zero panels and no error', async () => {
    const logged = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const live = await activate({});

    for (const module of PROVIDERS) {
      live.set(`providers.${module.descriptor.id}.enabled`, false);
      await flush();
    }

    expect(live.liveIds()).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
    dispose(live);
  });

  it('ACC-SETT-33 - toggling a provider repeatedly leaves one widget and one command set', async () => {
    const id = PROVIDERS[0].descriptor.id;
    const live = await activate({});

    for (let turn = 0; turn < 4; turn += 1) {
      live.set(`providers.${id}.enabled`, false);
      await flush();
      live.set(`providers.${id}.enabled`, true);
      await flush();
    }

    // Counted over EVERY provider, not just the toggled one. Two guards stop a
    // second panel - reconcile only calls `start` when the id is not already
    // live, and `start` checks again - so removing either alone changes
    // nothing, and an assertion that watched only the toggled id would miss
    // the case that does bite: the providers left enabled are reconciled on
    // every one of these turns, and a lost guard re-docks each of them on each
    // turn, every copy still polling.
    expect(live.liveIds().sort()).toEqual(
      PROVIDERS.map(module => module.descriptor.id).sort()
    );
    expect(live.liveIds().filter(each => each === id)).toHaveLength(1);
    expect(live.app.commands.hasCommand(commandId(id, 'refresh'))).toBe(true);
    dispose(live);
  });

  it('ACC-SETT-27 - one key each carries the shared settings into every panel', async () => {
    const live = await activate({
      presentationMode: 'path',
      recentLimit: 25,
      colouredTabs: false
    });

    const panels = live.docks.map(([widget]) => widget);
    expect(panels).toHaveLength(PROVIDERS.length);
    for (const panel of panels) {
      expect((panel as any)._presentationMode).toBe('path');
      expect((panel as any)._recentLimit).toBe(25);
      expect((panel as any)._colouredTabs).toBe(false);
    }

    // And a later change reaches every panel too, from the same one key.
    live.set('presentationMode', 'name');
    await flush();
    for (const panel of panels) {
      expect((panel as any)._presentationMode).toBe('name');
    }
    dispose(live);
  });

  it('ACC-SETT-30 - changing the sidebar re-docks every enabled panel', async () => {
    const live = await activate({ sidebar: 'right' });
    const first = live.docks.length;
    expect(first).toBe(PROVIDERS.length);
    expect(live.docks.every(([, area]) => area === 'right')).toBe(true);

    live.set('sidebar', 'left');
    await flush();

    const moved = live.docks.slice(first);
    expect(moved).toHaveLength(PROVIDERS.length);
    expect(moved.every(([, area]) => area === 'left')).toBe(true);
    expect(new Set(moved.map(([widget]) => widget.descriptor.id)).size).toBe(
      PROVIDERS.length
    );
    dispose(live);
  });

  it('ACC-SETT-34 - a settings registry that throws falls back to every provider enabled', async () => {
    const warned = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const live = await activate({}, { loadThrows: true });

    expect(live.liveIds().sort()).toEqual(
      PROVIDERS.map(module => module.descriptor.id).sort()
    );
    expect(
      warned.mock.calls
        .map(args => String(args[0]))
        .some(line => line.includes('failed to load settings'))
    ).toBe(true);
    warned.mockRestore();
    dispose(live);
  });

  // ------------------------------------------------------- DEF-RETI-299

  const SKIP_KEY = 'providers.claude.dangerouslySkipPermissions';
  const migratedSkip = (value: boolean): unknown[] => [
    { provider_id: 'claude', keys: { [SKIP_KEY]: value }, favourites: [] }
  ];

  it('DEF-RETI-299 - a migration run again keeps the value the user saved here', async () => {
    const live = await activate(
      { [SKIP_KEY]: true },
      { migrated: migratedSkip(false) }
    );
    expect(live.saved).toEqual([]);
    dispose(live);
  });

  it('ACC-RETI-85 - a migrated key with nothing saved here is carried over', async () => {
    const live = await activate({}, { migrated: migratedSkip(true) });
    expect(live.saved).toEqual([[SKIP_KEY, true]]);
    dispose(live);
  });

  it('ACC-RETI-237 - a migrated key the schema does not declare is not set, and a declared key is', async () => {
    const live = await activate(
      {},
      {
        migrated: [
          {
            provider_id: 'settings-folder',
            keys: { 'providers.gemini.approvalMode': 'yolo', [SKIP_KEY]: true },
            favourites: []
          }
        ]
      }
    );
    expect(live.saved).toEqual([[SKIP_KEY, true]]);
    dispose(live);
  });

  it('ACC-RETI-237 - a carried value the schema rejects costs only that key', async () => {
    const warned = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    // JupyterLab's own registry, because it keeps a rejected value in its copy
    // of the file and the fake registry does not.
    let file = '{}';
    const registry = new SettingRegistry({
      connector: {
        fetch: async (id: string) => ({
          id,
          schema: SHIPPED_SCHEMA,
          raw: file,
          version: 'test',
          data: { composite: {}, user: {} }
        }),
        list: async () => ({ ids: [], values: [] }),
        save: async (_id: string, raw: string) => {
          file = raw;
        },
        remove: async () => undefined
      } as any
    });

    const live = await activate(
      {},
      {
        registry,
        migrated: [
          {
            provider_id: 'settings-folder',
            keys: {
              'providers.claude.enabled': false,
              recentLimit: 1000,
              'providers.codex.enabled': false,
              'providers.kimi.enabled': false,
              sidebar: 'left'
            },
            favourites: []
          }
        ]
      }
    );

    const saved = await registry.load(plugin.id);
    expect(saved.user).toEqual({
      'providers.claude.enabled': false,
      'providers.codex.enabled': false,
      'providers.kimi.enabled': false,
      sidebar: 'left'
    });
    // A save after the carry, in the same window, is accepted too.
    await saved.set('recentLimit', 25);
    expect(saved.user.recentLimit).toBe(25);
    warned.mockRestore();
    dispose(live);
  });

  it('ACC-RETI-237 - carried values are the first state: no panel moves or undocks, and no layout is saved', async () => {
    const enabled = PROVIDERS.map(module => module.descriptor.id).filter(
      id => id !== 'kimi'
    );
    const live = await activate(
      {},
      {
        placed: { claude: 'right' },
        migrated: [
          {
            provider_id: 'settings-folder',
            keys: {
              recentLimit: 25,
              'providers.kimi.enabled': false,
              sidebar: 'left'
            },
            favourites: []
          }
        ]
      }
    );

    // Each enabled panel was docked once, on the carried side, and kimi never.
    expect(live.docks.map(([, area]) => area)).toEqual(
      enabled.map(() => 'left')
    );
    expect(live.areas()).toEqual({
      ...Object.fromEntries(enabled.map(id => [id, 'left'])),
      claude: 'right'
    });
    expect(live.shellMoves).toEqual([]);
    expect(live.layoutSaves).toEqual([]);
    dispose(live);
  });

  // ------------------------------------------------------- ACC-SETT-189

  const MOVE_TO_PROJ = { path: 'proj', dontShowBrowser: true };

  it('ACC-SETT-189 - with the key absent, an open from every panel moves the file browser', async () => {
    const live = await activate({});
    expect(live.docks).toHaveLength(PROVIDERS.length);
    for (const [panel] of live.docks) {
      expect(await movesOnOpen(live, panel)).toEqual([MOVE_TO_PROJ]);
    }
    dispose(live);
  });

  it('ACC-SETT-189 - a saved false leaves the file browser where it is, for every panel', async () => {
    const live = await activate({ syncFileBrowser: false });
    expect(live.docks).toHaveLength(PROVIDERS.length);
    for (const [panel] of live.docks) {
      expect(await movesOnOpen(live, panel)).toEqual([]);
    }
    dispose(live);
  });

  it('ACC-SETT-189 - a change reaches every docked panel, with no reload and no new panel', async () => {
    const live = await activate({});
    const panels = live.docks.map(([widget]) => widget);
    expect(panels).toHaveLength(PROVIDERS.length);

    live.set('syncFileBrowser', false);
    await flush();
    for (const panel of panels) {
      expect(await movesOnOpen(live, panel)).toEqual([]);
    }

    live.set('syncFileBrowser', true);
    await flush();
    for (const panel of panels) {
      expect(await movesOnOpen(live, panel)).toEqual([MOVE_TO_PROJ]);
    }

    // The same panels from start to end: none was docked again, none replaced.
    expect(live.docks).toHaveLength(PROVIDERS.length);
    expect(panels.every(panel => !panel.isDisposed)).toBe(true);
    dispose(live);
  });

  // -------------------------------------------------- ACC-PANE-194..198

  it('ACC-PANE-194 - the Sync item is checked while the setting is on or absent, and not while it is off', async () => {
    const live = await activate({});
    const checked = (): boolean =>
      live.app.commands.isToggled(SYNC_FILE_BROWSER_COMMAND);

    // Absent.
    expect(checked()).toBe(true);
    live.set('syncFileBrowser', false);
    expect(checked()).toBe(false);
    live.set('syncFileBrowser', true);
    expect(checked()).toBe(true);
    dispose(live);
  });

  it('ACC-PANE-194 - a click on the Sync item saves the opposite value, once', async () => {
    const live = await activate({});

    await live.app.commands.execute(SYNC_FILE_BROWSER_COMMAND);
    expect(live.saved).toEqual([['syncFileBrowser', false]]);

    await live.app.commands.execute(SYNC_FILE_BROWSER_COMMAND);
    expect(live.saved).toEqual([
      ['syncFileBrowser', false],
      ['syncFileBrowser', true]
    ]);
    dispose(live);
  });

  it('ACC-PANE-194 - the next open follows the value the Sync item saved', async () => {
    const live = await activate({});
    const [panel] = live.docks[0];

    await live.app.commands.execute(SYNC_FILE_BROWSER_COMMAND);
    await flush();
    expect(await movesOnOpen(live, panel)).toEqual([]);

    await live.app.commands.execute(SYNC_FILE_BROWSER_COMMAND);
    await flush();
    expect(await movesOnOpen(live, panel)).toEqual([MOVE_TO_PROJ]);
    dispose(live);
  });

  it('ACC-PANE-195 - the Move item names the sidebar the panels are not in', async () => {
    // With no saved value the panels dock on the right.
    const right = await activate({});
    expect(right.docks.every(([, area]) => area === 'right')).toBe(true);
    expect(right.app.commands.label(MOVE_PANELS_COMMAND)).toBe(
      'Move Panel Left'
    );
    dispose(right);

    const left = await activate({ sidebar: 'left' });
    expect(left.docks.every(([, area]) => area === 'left')).toBe(true);
    expect(left.app.commands.label(MOVE_PANELS_COMMAND)).toBe(
      'Move Panel Right'
    );
    dispose(left);
  });

  it('ACC-PANE-195 - a click on the Move item saves the other side, once', async () => {
    const live = await activate({ sidebar: 'right' });

    await live.app.commands.execute(MOVE_PANELS_COMMAND);
    await flush();
    expect(live.saved).toEqual([['sidebar', 'left']]);

    await live.app.commands.execute(MOVE_PANELS_COMMAND);
    await flush();
    expect(live.saved).toEqual([
      ['sidebar', 'left'],
      ['sidebar', 'right']
    ]);
    dispose(live);
  });

  it('ACC-PANE-195 - after the click every panel is docked on that side and the item names the first side', async () => {
    const live = await activate({ sidebar: 'right' });
    const panels = live.docks.map(([widget]) => widget);
    const first = live.docks.length;

    await live.app.commands.execute(MOVE_PANELS_COMMAND);
    await flush();

    const moved = live.docks.slice(first);
    expect(moved.map(([, area]) => area)).toEqual(panels.map(() => 'left'));
    // Each panel once, and they are the panels that were already docked.
    expect(new Set(moved.map(([widget]) => widget))).toEqual(new Set(panels));
    expect(live.app.commands.label(MOVE_PANELS_COMMAND)).toBe(
      'Move Panel Right'
    );
    dispose(live);
  });

  it.each<[string, (live: ISettingsHarness) => unknown]>([
    ['the settings page', live => live.set('sidebar', 'left')],
    ['the header menu', live => live.app.commands.execute(MOVE_PANELS_COMMAND)]
  ])(
    'ACC-PANE-196 - a panel on screen is activated again after a move from %s',
    async (_from, move) => {
      const live = await activate({ sidebar: 'right' });
      // Shown and attached, so `isVisible` is true without a spy. It is not
      // the first panel, so code that activates the first panel fails.
      const shown = live.docks[live.docks.length - 1][0];
      shown.show();
      Widget.attach(shown, document.body);
      expect(shown.isVisible).toBe(true);
      const first = live.docks.length;

      await move(live);
      await flush();

      // Once, by id, and only after every panel was docked again, because
      // docking a panel again hides it.
      expect(live.activated).toEqual([
        { id: shown.id, afterDocks: first + PROVIDERS.length }
      ]);
      dispose(live);
    }
  );

  it('ACC-PANE-196 - with no panel on screen a move activates nothing', async () => {
    const live = await activate({ sidebar: 'right' });
    const first = live.docks.length;

    live.set('sidebar', 'left');
    await flush();

    // Every panel was docked again, so the sidebar change did run.
    expect(live.docks.slice(first)).toHaveLength(PROVIDERS.length);
    expect(live.activated).toEqual([]);
    dispose(live);
  });

  describe('ACC-PANE-199 - a sidebar change overrides a JupyterLab placement', () => {
    const SHELL_PLUGIN = '@jupyterlab/application-extension:shell';
    const placed = PROVIDERS[0].descriptor.id;
    const everyArea = (live: ISettingsHarness): string[] =>
      Array.from(new Set(Object.values(live.areas())));

    it('ACC-PANE-199 - a panel placed with Switch Sidebar Side moves with the others, and the new side is saved', async () => {
      const live = await activate({ sidebar: 'right' });
      live.placeWithJupyterLab(placed, 'left');
      expect(live.areas()[placed]).toBe('left');

      live.set('sidebar', 'left');
      await flush();
      // The placed panel was on the left already, so nothing was overridden.
      expect(everyArea(live)).toEqual(['left']);
      expect(live.shellMoves).toEqual([]);
      expect(live.layoutSaves).toEqual([]);

      live.set('sidebar', 'right');
      await flush();
      // `add` left the placed panel on the left. The move took it along.
      expect(everyArea(live)).toEqual(['right']);
      expect(live.shellMoves).toEqual([[placed, 'right']]);
      const record = { [panelWidgetId(placed)]: { area: 'right' } };
      expect(live.layoutSaves).toEqual([
        [SHELL_PLUGIN, 'layout', { single: record, multiple: record }]
      ]);
      dispose(live);
    });

    it('ACC-PANE-199 - with no JupyterLab placement the layout of JupyterLab is not written', async () => {
      const live = await activate({ sidebar: 'right' });

      live.set('sidebar', 'left');
      await flush();

      expect(everyArea(live)).toEqual(['left']);
      expect(live.shellMoves).toEqual([]);
      expect(live.layoutSaves).toEqual([]);
      dispose(live);
    });

    it('ACC-PANE-199 - a placed panel that was on screen is activated after it was moved', async () => {
      const live = await activate({ sidebar: 'left' });
      live.placeWithJupyterLab(placed, 'right');
      const shown = live.docks.find(
        ([widget]) => widget.descriptor.id === placed
      )![0];
      shown.show();
      Widget.attach(shown, document.body);
      expect(shown.isVisible).toBe(true);
      // The setting says left and the panel is on the right, where JupyterLab
      // put it. A change to right and back to left must bring it along.
      live.set('sidebar', 'right');
      await flush();
      shown.show();
      const before = live.sequence.length;

      live.set('sidebar', 'left');
      await flush();

      expect(live.areas()[placed]).toBe('left');
      expect(live.sequence.slice(before + PROVIDERS.length)).toEqual([
        `move:${placed}`,
        `activate:${shown.id}`
      ]);
      dispose(live);
    });

    it('ACC-PANE-199 - a placement that cannot be saved is one console line, and the panel still moves', async () => {
      const live = await activate(
        { sidebar: 'right' },
        { layoutSaveRejects: true }
      );
      live.placeWithJupyterLab(placed, 'left');
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      live.set('sidebar', 'left');
      live.set('sidebar', 'right');
      await flush();

      expect(everyArea(live)).toEqual(['right']);
      expect(live.layoutSaves).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(
        'could not save the panel placement'
      );
      dispose(live);
    });

    it('DEF-PANE-297 - a sidebar change before JupyterLab restored its layout moves no panel', async () => {
      const live = await activate(
        { sidebar: 'right' },
        { shellNotRestored: true }
      );
      const first = live.docks.length;

      live.set('sidebar', 'left');
      await flush();

      // Every panel was handed to the shell again for the new side, and no
      // panel was moved: the shell holds them in no sidebar yet.
      expect(live.docks.slice(first).map(([, area]) => area)).toEqual(
        PROVIDERS.map(() => 'left')
      );
      expect(live.shellMoves).toEqual([]);
      expect(live.layoutSaves).toEqual([]);
      expect(live.app.commands.label(MOVE_PANELS_COMMAND)).toBe(
        'Move Panel Right'
      );
      dispose(live);
    });
  });

  describe('ACC-PANE-200 - Move Panel keeps its own panel on screen', () => {
    /** The first two panels, one on screen in each sidebar: the first where
     * JupyterLab's own command put it, the other where the setting says. */
    const onePerSidebar = (
      live: ISettingsHarness,
      setting: string
    ): AssistantSessionsPanel[] => {
      const [first, later] = PROVIDERS.slice(0, 2).map(
        provider =>
          live.docks.find(
            ([widget]) => widget.descriptor.id === provider.descriptor.id
          )![0]
      );
      live.placeWithJupyterLab(
        first.descriptor.id,
        setting === 'right' ? 'left' : 'right'
      );
      for (const panel of [first, later]) {
        panel.show();
        if (!panel.isAttached) {
          Widget.attach(panel, document.body);
        }
      }
      expect([first.isVisible, later.isVisible]).toEqual([true, true]);
      return [first, later];
    };
    const activations = (live: ISettingsHarness): string[] =>
      live.activated.map(entry => entry.id);

    it('ACC-PANE-200 - with a panel on screen in each sidebar, the one whose header menu ran the move is activated', async () => {
      const live = await activate({ sidebar: 'right' });
      const [, later] = onePerSidebar(live, 'right');

      await live.app.commands.execute(MOVE_PANELS_COMMAND, { panel: later.id });

      expect(Array.from(new Set(Object.values(live.areas())))).toEqual([
        'left'
      ]);
      expect(activations(live)).toEqual([later.id]);
      dispose(live);
    });

    it('ACC-PANE-200 - the next move from the settings page activates the first panel on screen again', async () => {
      const live = await activate({ sidebar: 'right' });
      const [first, later] = onePerSidebar(live, 'right');
      await live.app.commands.execute(MOVE_PANELS_COMMAND, { panel: later.id });
      expect(activations(live)).toEqual([later.id]);

      // Both are on the left now. One per sidebar again, then a change that
      // no header menu asked for.
      onePerSidebar(live, 'left');
      live.set('sidebar', 'right');
      await flush();

      expect(activations(live)).toEqual([later.id, first.id]);
      dispose(live);
    });

    it('ACC-PANE-200 - a failed Move save activates nothing, and the move that arrives later keeps that panel on screen', async () => {
      const warned = jest
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const errored = jest
        .spyOn(Notification, 'error')
        .mockImplementation(() => '');
      try {
        const live = await activate(
          { sidebar: 'right' },
          { saveRejects: true }
        );
        const [, later] = onePerSidebar(live, 'right');

        await live.app.commands.execute(MOVE_PANELS_COMMAND, {
          panel: later.id
        });
        await flush();
        expect(errored).toHaveBeenCalledTimes(1);
        expect(activations(live)).toEqual([]);

        // The same change, applied later by another route.
        live.set('sidebar', 'left');
        await flush();

        expect(activations(live)).toEqual([later.id]);
        dispose(live);
      } finally {
        errored.mockRestore();
        warned.mockRestore();
      }
    });
  });

  it('ACC-PANE-197 - both header menu items are disabled with no settings registry, and enabled with one', async () => {
    const without = await activate({}, { noRegistry: true });
    // Both are registered. This is checked first because an unregistered
    // command also reports that it is not enabled.
    expect(without.app.commands.hasCommand(SYNC_FILE_BROWSER_COMMAND)).toBe(
      true
    );
    expect(without.app.commands.hasCommand(MOVE_PANELS_COMMAND)).toBe(true);
    expect(without.app.commands.isEnabled(SYNC_FILE_BROWSER_COMMAND)).toBe(
      false
    );
    expect(without.app.commands.isEnabled(MOVE_PANELS_COMMAND)).toBe(false);
    dispose(without);

    const withOne = await activate({});
    expect(withOne.app.commands.isEnabled(SYNC_FILE_BROWSER_COMMAND)).toBe(
      true
    );
    expect(withOne.app.commands.isEnabled(MOVE_PANELS_COMMAND)).toBe(true);
    dispose(withOne);
  });

  it('ACC-PANE-198 - a failed Sync save raises one error notification, and the item keeps its state', async () => {
    const warned = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const errored = jest
      .spyOn(Notification, 'error')
      .mockImplementation(() => '');
    // The spies are restored even when an assertion fails. Otherwise the next
    // test would count the calls this test made.
    try {
      const live = await activate({}, { saveRejects: true });
      const [panel] = live.docks[0];

      await live.app.commands.execute(SYNC_FILE_BROWSER_COMMAND);
      await flush();

      expect(errored).toHaveBeenCalledTimes(1);
      expect(String(errored.mock.calls[0][0])).toContain(
        'The setting was not saved'
      );
      // Still checked, and the next open still moves the file browser.
      expect(live.app.commands.isToggled(SYNC_FILE_BROWSER_COMMAND)).toBe(true);
      expect(await movesOnOpen(live, panel)).toEqual([MOVE_TO_PROJ]);
      dispose(live);
    } finally {
      errored.mockRestore();
      warned.mockRestore();
    }
  });

  it('ACC-PANE-198 - a failed Move save raises one error notification, and the panels stay where they are', async () => {
    const warned = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const errored = jest
      .spyOn(Notification, 'error')
      .mockImplementation(() => '');
    try {
      const live = await activate({ sidebar: 'right' }, { saveRejects: true });
      const first = live.docks.length;

      await live.app.commands.execute(MOVE_PANELS_COMMAND);
      await flush();

      expect(errored).toHaveBeenCalledTimes(1);
      expect(String(errored.mock.calls[0][0])).toContain(
        'The setting was not saved'
      );
      // The item still names the side the panels are not in, and no panel
      // moved.
      expect(live.app.commands.label(MOVE_PANELS_COMMAND)).toBe(
        'Move Panel Left'
      );
      expect(live.docks).toHaveLength(first);
      dispose(live);
    } finally {
      errored.mockRestore();
      warned.mockRestore();
    }
  });
});

describe('ACC-RETI-82..84 - a retired standalone extension still installed', () => {
  const roster = (): unknown => ({
    root_dir: '/srv/lab',
    delete_to_trash: true,
    providers: PROVIDERS.map(module => ({
      id: module.descriptor.id,
      available: true
    }))
  });

  /** The first assistant that has a retired standalone package at all. */
  const retired = PROVIDERS.find(module => module.descriptor.legacyPluginId)!;

  async function activate(installed: string[]): Promise<{
    docked: AssistantSessionsPanel[];
    app: any;
    probe: () => void;
  }> {
    const serverSettings = socketSettings();
    request.mockImplementation((path: string, settings: unknown) =>
      path === 'status' && settings === serverSettings
        ? Promise.resolve(roster())
        : Promise.reject(new Error('not this activation'))
    );
    const docked: AssistantSessionsPanel[] = [];
    const app = {
      serviceManager: { serverSettings },
      commands: new CommandRegistry(),
      hasPlugin: (id: string) => installed.includes(id)
    } as any;
    await (plugin.activate as any)(
      app,
      { add: (widget: AssistantSessionsPanel) => docked.push(widget) } as any,
      null,
      null,
      null,
      null,
      null
    );
    await flush();
    return {
      docked,
      app,
      probe: () => window.dispatchEvent(new Event('online'))
    };
  }

  it('ACC-RETI-82, ACC-RETI-83 - the duplicate is resolved in favour of the standalone panel', async () => {
    const warned = jest
      .spyOn(Notification, 'warning')
      .mockImplementation(() => '');
    const logged = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const id = retired.descriptor.id;
    const live = await activate([
      `${retired.descriptor.legacyPluginId}:plugin`
    ]);

    // Detected at activation, and this extension's panel for that assistant
    // never starts - so the user sees one panel, not two.
    expect(live.docked.map(widget => widget.descriptor.id)).not.toContain(id);
    expect(live.docked).toHaveLength(PROVIDERS.length - 1);
    expect(live.app.commands.hasCommand(commandId(id, 'refresh'))).toBe(false);

    warned.mockRestore();
    logged.mockRestore();
    live.docked.forEach(widget => widget.dispose());
  });

  it('ACC-RETI-84 - the notice names the package to uninstall, once', async () => {
    const warned = jest
      .spyOn(Notification, 'warning')
      .mockImplementation(() => '');
    const logged = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const live = await activate([
      `${retired.descriptor.legacyPluginId}:plugin`
    ]);

    expect(warned).toHaveBeenCalledTimes(1);
    const [message, options] = warned.mock.calls[0];
    expect(String(message)).toContain(retired.descriptor.legacyPluginId);
    expect(String(message)).toContain('uninstall');
    // The user has to act on it, so it does not time out from under them.
    expect((options as any)?.autoClose).toBe(false);

    // Resolved once per page load: a plugin cannot be installed into a running
    // JupyterLab, and a notice that repeats on every poll is noise.
    live.probe();
    await flush();
    expect(warned).toHaveBeenCalledTimes(1);

    warned.mockRestore();
    logged.mockRestore();
    live.docked.forEach(widget => widget.dispose());
  });

  it('ACC-RETI-83 - with nothing retired installed, every assistant keeps its panel', async () => {
    const warned = jest
      .spyOn(Notification, 'warning')
      .mockImplementation(() => '');
    const live = await activate([]);
    expect(live.docked).toHaveLength(PROVIDERS.length);
    expect(warned).not.toHaveBeenCalled();
    warned.mockRestore();
    live.docked.forEach(widget => widget.dispose());
  });
});
