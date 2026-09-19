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

import { Notification } from '@jupyterlab/apputils';
import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';

import { providerIcon } from '../core/icons';
import {
  AssistantSessionsPanel,
  commandId,
  panelWidgetId
} from '../core/panel';
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

describe('ACC-PROV - the activation contract', () => {
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
    const serverSettings = {};
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
    const settingRegistry = composite
      ? ({
          load: async () => ({
            composite,
            get: (key: string) => ({
              composite: composite[key],
              user: userSet.has(key) ? composite[key] : undefined
            }),
            set: async () => undefined,
            changed: new Signal<unknown, void>({})
          })
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
    return { app, docked, restored, probes: () => call };
  }

  /** Every assistant, turned off. */
  const allDisabled = (): Record<string, unknown> =>
    Object.fromEntries(
      PROVIDERS.map(module => [
        `providers.${module.descriptor.id}.enabled`,
        false
      ])
    );

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
    // No cadence it cannot honour at that moment (DEF-122): the same line
    // prints from the activation probe, before any interval is armed.
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

  it('ACC-PROV-19 - the roster is whichever probe answers last, and a failure writes nothing', async () => {
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
        // Issued first, answers last.
        () =>
          new Promise(resolve => {
            settle = resolve;
          }),
        // Issued second, fails immediately.
        () => Promise.reject(new Error('server down'))
      ]
    });
    expect(dockedIds(live)).not.toContain(absent);

    window.dispatchEvent(new Event('online')); // slow probe, still in flight
    window.dispatchEvent(new Event('online')); // fails while it is in flight
    await flush();

    // The failure wrote nothing, so the roster it overtook still stands and
    // the missing binary is still missing.
    expect(dockedIds(live)).not.toContain(absent);
    expect(dockedIds(live)).toHaveLength(PROVIDERS.length - 1);

    settle!(roster());
    await flush();

    // The answer that landed last is the roster, whatever order it was issued in.
    expect(dockedIds(live)).toContain(absent);

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

  interface ISettingsHarness {
    app: any;
    /** Every `labShell.add` call, as `[widget, area]`, in order. */
    docks: [AssistantSessionsPanel, string][];
    /** Widgets currently docked and not disposed. */
    liveIds: () => string[];
    /** Write a settings value and fire `changed`, as the settings editor does. */
    set: (key: string, value: unknown) => void;
    terminal: { disposed: boolean; closed: boolean };
  }

  /** Activate against a settings registry whose values can be changed live. */
  async function activate(
    composite: Record<string, unknown> = {},
    options: { loadThrows?: boolean } = {}
  ): Promise<ISettingsHarness> {
    const serverSettings = {};
    request.mockImplementation((path: string, settings: unknown) =>
      path === 'status' && settings === serverSettings
        ? Promise.resolve(roster())
        : Promise.reject(new Error('not this activation'))
    );

    const docks: [AssistantSessionsPanel, string][] = [];
    const labShell = {
      add: (widget: AssistantSessionsPanel, area: string) => {
        docks.push([widget, area]);
      }
    } as any;
    const app = {
      serviceManager: { serverSettings },
      commands: new CommandRegistry(),
      hasPlugin: () => false
    } as any;

    const changed = new Signal<unknown, void>({});
    const settings = {
      composite,
      get: (key: string) => ({
        composite: composite[key],
        user: key in composite ? composite[key] : undefined
      }),
      set: async () => undefined,
      changed
    };
    const settingRegistry = {
      load: async () => {
        if (options.loadThrows) {
          throw new Error('settings registry unavailable');
        }
        return settings;
      }
    } as any;

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
      terminal
    };
  }

  const dispose = (live: ISettingsHarness): void =>
    live.docks.forEach(([widget]) => widget.dispose());

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
    const serverSettings = {};
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
