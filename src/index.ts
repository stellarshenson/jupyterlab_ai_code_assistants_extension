import {
  ILabShell,
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette, Notification } from '@jupyterlab/apputils';
import { URLExt } from '@jupyterlab/coreutils';
import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';
import { ILauncher } from '@jupyterlab/launcher';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITerminalTracker } from '@jupyterlab/terminal';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { IColourfulTabs } from 'jupyterlab_colourful_tab_extension';
import { IDisposable } from '@lumino/disposable';

import { addCallbackCommand } from './core/callback';
import { launcherTileIcon, providerIcon } from './core/icons';
import { DEFAULT_RECENT_LIMIT } from './core/limits';
import {
  AssistantSessionsPanel,
  DEFAULT_PRESENTATION_MODE,
  MOVE_PANELS_COMMAND,
  PresentationMode,
  SYNC_FILE_BROWSER_COMMAND,
  commandId,
  panelWidgetId
} from './core/panel';
import { LOG_PREFIX, ProviderRegistry } from './core/registry';
import { API_NAMESPACE, requestAPI, WINDOW_ID } from './core/request';
import {
  IMigrateResponse,
  IProviderStatus,
  IStatusResponse
} from './core/types';
import { PROVIDERS } from './providers';

/** Which sidebar the panels dock into unless the user says otherwise. */
const DEFAULT_SIDEBAR = 'right';

const PLUGIN_ID =
  '@stellarshenson/jupyterlab-ai-code-assistants-extension:plugin';
/** JupyterLab's own plugin, whose `layout` setting stores the sidebar a user
 * chose for a widget with "Switch Sidebar Side". */
const SHELL_PLUGIN_ID = '@jupyterlab/application-extension:shell';
/** Sidebar rank, shared by every panel so they dock together. */
const PANEL_RANK = 600;
/** The events socket reopens after a drop on a doubling delay, from the base
 * up to the cap (the house notifications stream's values). */
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;
/** Launcher section every assistant tile lands in. */
const LAUNCHER_CATEGORY = 'AI Assistants';
/** Where that section sits. The Launcher ranks Notebook 0, Console 20 and
 * Other 100, and the smallest rank among a category's items decides where the
 * category goes - so ONE value on every tile, above Other's, puts the
 * assistants after Other and keeps them there whichever tile is added first;
 * unranked third-party categories (rank Infinity) still follow (ACC-LNCH-156). */
const LAUNCHER_CATEGORY_RANK = 200;

type Sidebar = 'left' | 'right';

/** One live provider: its panel, the command that refreshes it, the command
 * its Launcher tile runs, and the tile itself - null when JupyterLab supplied
 * no launcher. All of them are created and disposed together, so a tile has
 * the panel's lifecycle and no enable decision of its own (ACC-LNCH-146). */
interface ILivePanel {
  panel: AssistantSessionsPanel;
  command: IDisposable;
  launchCommand: IDisposable;
  tile: IDisposable | null;
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'One side panel per AI code assistant, over a shared provider registry: sessions, favourites, branching and one-click resume in a terminal.',
  autoStart: true,
  requires: [ILabShell],
  optional: [
    ILayoutRestorer,
    ISettingRegistry,
    ITerminalTracker,
    IDefaultFileBrowser,
    IColourfulTabs,
    ILauncher,
    ITranslator,
    ICommandPalette
  ],
  activate: async (
    app: JupyterFrontEnd,
    labShell: ILabShell,
    restorer: ILayoutRestorer | null,
    settingRegistry: ISettingRegistry | null,
    terminalTracker: ITerminalTracker | null,
    fileBrowser: IDefaultFileBrowser | null,
    colourfulTabs: IColourfulTabs | null,
    launcher: ILauncher | null,
    translator: ITranslator | null,
    palette: ICommandPalette | null
  ) => {
    console.log(
      'JupyterLab extension jupyterlab_ai_code_assistants_extension is activated!'
    );

    // Every user-visible string in the panels goes through this bundle.
    // `ITranslator` is optional, and the null translator returns each string
    // unchanged, so an install without one behaves exactly as before.
    const trans = (translator ?? nullTranslator).load(
      'jupyterlab_ai_code_assistants_extension'
    );

    // A duplicate id throws here, at registration, rather than surfacing later
    // as two panels quietly fighting over one widget id.
    const registry = new ProviderRegistry(PROVIDERS);

    addCallbackCommand(app, palette ?? null, LAUNCHER_CATEGORY, trans);

    const serverSettings = app.serviceManager.serverSettings;
    const live = new Map<string, ILivePanel>();
    const warnedUnknown = new Set<string>();
    const warnedUnavailable = new Set<string>();

    // Assistants whose retired standalone extension is STILL installed. This
    // extension supersedes those three, and running both would give the user
    // two panels and two command sets for one assistant - so the duplicate is
    // resolved in favour of the standalone one already on screen and this
    // provider stays dark: never started, so it never polls and never registers
    // a command. Resolved once, at activation: a plugin cannot be installed
    // into a running JupyterLab.
    const suppressed = new Set<string>();
    for (const descriptor of registry.descriptors) {
      if (
        descriptor.legacyPluginId &&
        app.hasPlugin(`${descriptor.legacyPluginId}:plugin`)
      ) {
        suppressed.add(descriptor.id);
      }
    }
    if (suppressed.size > 0) {
      const packages = registry.descriptors
        .filter(d => suppressed.has(d.id))
        .map(d => d.legacyPluginId)
        .join(', ');
      console.warn(
        `${LOG_PREFIX} superseded extension(s) still installed: ${packages}. Their assistants are suppressed here.`
      );
      // Once, not on every refresh: this runs a single time per page load.
      Notification.warning(
        `AI Code Assistants: uninstall ${packages} - it is superseded by this extension, and until it goes its assistant has no panel here.`,
        { autoClose: false }
      );
    }

    let status: IStatusResponse | null = null;
    let settings: ISettingRegistry.ISettings | null = null;
    let sidebar: Sidebar = DEFAULT_SIDEBAR;
    /** The id of the panel whose header menu last asked for a move, until a
     * move is applied. */
    let moveAskedBy: string | null = null;

    /** Ask the server which providers exist and which of their binaries are on
     * PATH.
     *
     * `status` is the last roster the server gave, and null means it has never
     * given one - two different facts that used to share one value. A probe
     * that FAILS writes nothing: not answering is not an answer, and reading it
     * as "no assistant is installed" is what emptied the sidebar on every
     * reload whose first request landed before the server was listening
     * (DEF-132), and on every wake whose probe fired before the network was
     * back (DEF-119). No request is suppressed, and a failure never needs
     * ordering against a success, because it has nothing to write. */
    const probeStatus = async (): Promise<void> => {
      try {
        status = await requestAPI<IStatusResponse>('status', serverSettings, {
          cache: 'no-store'
        });
      } catch (err) {
        // No cadence named: there is none, and this also prints from the
        // activation probe, before the wake listeners are armed (DEF-122).
        console.warn(
          `${LOG_PREFIX} status probe failed; the last known roster stands (every enabled assistant, when there is none yet) until a later probe answers.`,
          err
        );
      }
    };

    const statusFor = (id: string): IProviderStatus | null =>
      status?.providers?.find(p => p.id === id) ?? null;

    /** Settings value, or the fallback when settings are unavailable or the
     * key is absent. An absent enable key reads as enabled - only an explicit
     * `false` turns a provider off. */
    const setting = <T>(key: string, fallback: T): T => {
      if (!settings) {
        return fallback;
      }
      const value = settings.get(key).composite;
      if (value === undefined || value === null) {
        return fallback;
      }
      return value as unknown as T;
    };

    /** Launch-mode values for one provider, keyed by the mode ids the
     * assistant itself uses. */
    const modesFor = (id: string): Record<string, boolean> => {
      const descriptor = registry.get(id)?.descriptor;
      const modes: Record<string, boolean> = {};
      for (const mode of descriptor?.launchModes ?? []) {
        modes[mode.id] = setting(`providers.${id}.${mode.id}`, mode.default);
      }
      return modes;
    };

    /** Push the shared settings into one panel. */
    const applySharedSettings = (panel: AssistantSessionsPanel): void => {
      // Any value other than `path` is treated as `name`, so an older saved
      // value still maps onto a live mode.
      const mode: PresentationMode =
        setting<string>('presentationMode', DEFAULT_PRESENTATION_MODE) ===
        'path'
          ? 'path'
          : DEFAULT_PRESENTATION_MODE;
      panel.setPresentationMode(mode);
      const limit = setting<number>('recentLimit', DEFAULT_RECENT_LIMIT);
      if (typeof limit === 'number') {
        panel.setRecentLimit(limit);
      }
      // Defaults ON, so only an explicit `false` turns it off.
      panel.setColouredTabs(setting<boolean>('colouredTabs', true) !== false);
      // Defaults ON as well: an absent key reads as on.
      panel.setSyncFileBrowser(
        setting<boolean>('syncFileBrowser', true) !== false
      );
      panel.setModes(modesFor(panel.descriptor.id));
    };

    const dock = (panel: AssistantSessionsPanel): void => {
      // Lumino re-parents cleanly when add() is called against a different
      // area, so the same call both docks and moves.
      labShell.add(panel, sidebar, { rank: PANEL_RANK });
    };

    const start = (id: string): void => {
      const module = registry.get(id);
      if (!module || live.has(id)) {
        return;
      }
      try {
        const panel = new AssistantSessionsPanel({
          app,
          descriptor: module.descriptor,
          hooks: module.hooks,
          rootDir: status?.root_dir ?? '',
          // Unknown reads as "not trash", so the dialogs and the popup
          // present the permanent-delete wording rather than promising a
          // recoverable move the server never confirmed (DEF-135).
          deleteToTrash: status ? status.delete_to_trash !== false : false,
          terminalTracker,
          fileBrowser,
          colourfulTabs,
          trans
        });
        applySharedSettings(panel);
        dock(panel);
        // Each panel registers under its own name, so its open/closed state
        // survives a reload independently of the others.
        restorer?.add(panel, panelWidgetId(id));
        const command = app.commands.addCommand(commandId(id, 'refresh'), {
          // The panel title is the assistant name alone (ACC-PANE-232); the
          // command still names what it refreshes.
          label: `Refresh ${module.descriptor.panelTitle} Sessions`,
          // Takes no arguments, which is what `null` says here.
          describedBy: { args: null },
          execute: () => panel.refresh()
        });
        // The Launcher tile's command. It is registered whether or not a
        // launcher exists, because the tile is the only caller but the command
        // is what carries the label, the icon and the click path.
        const launchCommandId = commandId(id, 'launch-here');
        const launchCommand = app.commands.addCommand(launchCommandId, {
          label: module.descriptor.label,
          caption: `Start or resume ${module.descriptor.label} in the current folder`,
          // The section header borrows this icon too; the view draws the
          // joint icon there and the provider's own on the tile.
          icon: launcherTileIcon(
            providerIcon(module.descriptor.iconName, module.descriptor.iconSvg)
          ),
          describedBy: {
            args: {
              type: 'object',
              properties: {
                cwd: {
                  type: 'string',
                  description:
                    'Folder to start the assistant in. The server root when absent.'
                }
              }
            }
          },
          // The Launcher puts the file browser's folder in `cwd` on every
          // click; the panel resolves it against the server root.
          execute: args => panel.launchHere(args.cwd as string | undefined)
        });
        // Tile order follows the barrel, so the Launcher section reads in the
        // sidebar's order (ACC-LNCH-158).
        const tile =
          launcher?.add({
            command: launchCommandId,
            category: LAUNCHER_CATEGORY,
            rank: registry.ids.indexOf(id),
            categoryRank: LAUNCHER_CATEGORY_RANK
          }) ?? null;
        live.set(id, { panel, command, launchCommand, tile });
      } catch (err) {
        // One provider failing to start must leave the others working.
        console.error(`${LOG_PREFIX} provider "${id}" failed to start.`, err);
      }
    };

    const stop = (id: string): void => {
      const entry = live.get(id);
      if (!entry) {
        return;
      }
      live.delete(id);
      // Disposing stops the polling and clears this provider's tab tints; the
      // terminals it launched keep running, untouched.
      entry.command.dispose();
      // Tile before the command it runs, so the Launcher never re-renders an
      // item whose command has already gone.
      entry.tile?.dispose();
      entry.launchCommand.dispose();
      entry.panel.dispose();
    };

    /** Bring the docked panels in line with settings and CLI availability.
     * Both must hold for a panel to be present. */
    const reconcile = (): void => {
      for (const descriptor of registry.descriptors) {
        const id = descriptor.id;
        if (suppressed.has(id)) {
          continue;
        }
        const enabled =
          setting<boolean>(`providers.${id}.enabled`, true) !== false;
        const probe = statusFor(id);
        // Unknown is not absent. With no roster yet, an enabled assistant is
        // docked: JupyterLab restores the sidebar tab it had open only if that
        // tab exists when activation ends, and it waits for activation but
        // not for a later probe - so a panel that arrives a minute late is one
        // the layout has already given up on (DEF-132). Once a roster exists
        // the server's word on each binary is final.
        const roster = status;
        const available =
          roster === null ? true : probe !== null && probe.available !== false;
        // Enabled but binary absent is logged to the console, never announced:
        // enabled means the extension supports the assistant, not that it is
        // installed, so a toast would name a tool the user never installed
        // (DEF-PANE-277). Only when the probe SUCCEEDED and this provider is
        // the one missing - blaming PATH for a server the frontend never
        // reached names the wrong cause. Once per id, not per reconcile.
        if (
          probe !== null &&
          probe.available === false &&
          enabled &&
          !warnedUnavailable.has(id)
        ) {
          warnedUnavailable.add(id);
          const binary = registry.get(id)?.descriptor.cliBinary ?? id;
          console.info(
            `${LOG_PREFIX} "${id}" is enabled but its \`${binary}\` binary was not found on the server's PATH; panel not shown.`
          );
        }
        // The latch is per ABSENCE, not per page load. Once the server reports
        // the binary present again, a later disappearance gets its own line:
        // without this, one transient absence - a CLI upgrade unlinking the
        // binary for a moment, or an obsolete roster from an overlapping probe -
        // permanently suppresses the real one (DEF-125). It cannot make the
        // line repeat while the state is unchanged, which is what the
        // once-per-id latch above exists to prevent: the two conditions are
        // mutually exclusive.
        if (probe !== null && probe.available !== false) {
          warnedUnavailable.delete(id);
        }
        if (enabled && available) {
          if (live.has(id)) {
            const panel = live.get(id)!.panel;
            applySharedSettings(panel);
            // A panel docked before the first roster was built without the
            // server root, and cannot resolve paths until it has one.
            if (roster !== null) {
              panel.setRoot(
                roster.root_dir ?? '',
                roster.delete_to_trash !== false
              );
            }
          } else {
            start(id);
          }
        } else {
          stop(id);
        }
      }
      // A provider still named in saved settings but no longer registered is
      // inert. Warned once per id, not once per reconcile - this runs on every
      // status poll, and a warning that repeats forever is noise.
      for (const key of settings ? Object.keys(settings.composite) : []) {
        const match = /^providers\.([^.]+)\.enabled$/.exec(key);
        if (match && !registry.has(match[1]) && !warnedUnknown.has(match[1])) {
          warnedUnknown.add(match[1]);
          console.warn(
            `${LOG_PREFIX} settings name unknown assistant "${match[1]}" - ignored.`
          );
        }
      }
    };

    /** Carry favourites and settings over from the retired standalone
     * extensions, once, before the first panel is docked.
     *
     * The server writes the favourites itself and hands back the mapped
     * settings keys, because it has no writable handle on the settings
     * registry. It is idempotent - a provider is marked migrated and skipped
     * forever after - so calling it on every activation costs one request and
     * migrates nothing the second time. A failure is a warning and nothing
     * more: losing a carried-over favourite must never cost the user a panel.
     *
     * Skipped entirely while the settings registry is unavailable: the server
     * marks a provider migrated in the same call that HANDS BACK its settings
     * keys, so migrating with nowhere to apply them would drop a carried-over
     * value permanently - the marker blocks every retry.
     */
    const migrate = async (): Promise<void> => {
      if (!settings) {
        return;
      }
      try {
        const result = await requestAPI<IMigrateResponse>(
          'migrate',
          serverSettings,
          { method: 'POST', body: '{}' }
        );
        for (const entry of result.migrated ?? []) {
          for (const [key, value] of Object.entries(entry.keys ?? {})) {
            // An old file can hold keys the extension has since dropped.
            if (!settings?.schema.properties?.[key]) {
              continue;
            }
            // A value already saved here is the user's newer choice and
            // stays. The marker that stops a second migration lives in the
            // Jupyter data folder, apart from these settings, so a server
            // that shares only the settings folder migrates again and would
            // put the retired extension's value back (DEF-RETI-299).
            if (settings?.get(key).user !== undefined) {
              continue;
            }
            // Per key. The server marks EVERY provider migrated before it
            // answers, so one rejection aborting the loop used to drop the
            // remaining providers' values with no retry ever offered again -
            // the same blast radius DEF-13 closed for a missing registry, one
            // level down.
            try {
              await settings?.set(key, value as any);
            } catch (err) {
              console.warn(`${LOG_PREFIX} could not carry over "${key}".`, err);
              // The registry keeps a rejected value in its copy of the file,
              // and that copy fails every later save until it is read again.
              await settingRegistry?.reload(PLUGIN_ID);
            }
          }
        }
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} migration failed; settings not yet saved were not carried over.`,
          err
        );
      }
    };

    const applySidebar = (): void => {
      const next = setting<string>('sidebar', DEFAULT_SIDEBAR);
      if ((next === 'left' || next === 'right') && next !== sidebar) {
        sidebar = next;
        // Re-docking hides a panel, so a panel on screen before the move is
        // activated again after it. Two can be on screen, one in each
        // sidebar: the one whose header menu asked for the move is the one
        // activated, else the first of them in `live`.
        const onScreen = Array.from(live.values()).filter(
          entry => entry.panel.isVisible
        );
        const shown =
          onScreen.find(entry => entry.panel.id === moveAskedBy) ?? onScreen[0];
        moveAskedBy = null;
        live.forEach(entry => dock(entry.panel));
        // A panel the user placed with JupyterLab's own "Switch Sidebar Side"
        // carries a placement that `add` obeys, so it is still in the other
        // sidebar. This change is the newer decision: it replaces that
        // placement, the way JupyterLab's own command does, and JupyterLab's
        // layout setting is saved so that the new side holds after a reload.
        const elsewhere = new Set(
          labShell.widgets(sidebar === 'left' ? 'right' : 'left')
        );
        let layout: ReturnType<ILabShell['move']> | null = null;
        for (const entry of live.values()) {
          if (elsewhere.has(entry.panel)) {
            layout = labShell.move(entry.panel, sidebar);
          }
        }
        if (layout && settingRegistry) {
          settingRegistry
            .set(
              SHELL_PLUGIN_ID,
              'layout',
              JSON.parse(
                JSON.stringify({
                  single: layout['single-document'],
                  multiple: layout['multiple-document']
                })
              )
            )
            .catch(err => {
              console.warn(
                `${LOG_PREFIX} could not save the panel placement.`,
                err
              );
            });
        }
        if (shown) {
          labShell.activateById(shown.panel.id);
        }
      }
    };

    // No timer checks which assistants are installed (ACC-PROV-230). The check
    // runs at activation, when the tab becomes visible, when the network comes
    // back and when the events socket reopens after a drop; a `refresh` push
    // carries its roster and needs no request. Triggers that arrive before the
    // request goes out - one macrotask - share it, and one request serves every
    // panel of the window (ACC-PROV-231). A trigger while a request is in
    // flight queues exactly one more after it: a wake is never answered by a
    // request sent before it (DEF-117).
    // Heard from here, before the first await: a wake before the listeners are
    // armed below is only remembered, because a reconcile before the settings
    // load reads the enabled-by-default fallback and docks assistants the user
    // disabled; one status check answers it once they are armed (DEF-GUARD-122).
    let armed = false;
    let wokeDuringActivation = false;
    /** A status request is queued or in flight. */
    let probing = false;
    /** A trigger arrived that the request in flight was sent before. */
    let wokeAgain = false;
    const reprobe = (): void => {
      if (!armed) {
        wokeDuringActivation = true;
        return;
      }
      wokeAgain = true;
      if (probing) {
        return;
      }
      probing = true;
      const send = (): void => {
        wokeAgain = false;
        void probeStatus()
          .then(reconcile)
          .finally(() => {
            if (wokeAgain) {
              send();
            } else {
              probing = false;
            }
          });
      };
      // Runs once per trigger burst, never on a cadence.
      window.setTimeout(send, 0);
    };
    window.addEventListener('online', reprobe);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        reprobe();
      }
    });

    await probeStatus();

    if (settingRegistry) {
      try {
        settings = await settingRegistry.load(PLUGIN_ID);
      } catch (err) {
        // Defaults apply: every provider enabled, right sidebar.
        console.warn(
          `${LOG_PREFIX} failed to load settings; using defaults.`,
          err
        );
        settings = null;
      }
    }

    /** Save one shared setting from a panel header's context menu. The
     * `changed` handler applies a saved value. A failed save does not
     * change the composite value the menu reads, so the menu keeps showing
     * the previous state. */
    const saveSetting = async (
      key: string,
      value: boolean | Sidebar
    ): Promise<void> => {
      try {
        await settings?.set(key, value);
      } catch (err) {
        console.warn(`${LOG_PREFIX} could not save setting "${key}".`, err);
        Notification.error(trans.__('The setting was not saved. Try again.'), {
          autoClose: 4000
        });
      }
    };

    // The two items of every panel header's context menu. Registered once,
    // here, because the settings they write are shared by every panel, and
    // before the first panel exists.
    app.commands.addCommand(SYNC_FILE_BROWSER_COMMAND, {
      label: trans.__('Sync File Browser'),
      // Takes no arguments, which is what `null` says here.
      describedBy: { args: null },
      isEnabled: () => settings !== null,
      isToggled: () => setting<boolean>('syncFileBrowser', true) !== false,
      execute: () =>
        saveSetting(
          'syncFileBrowser',
          setting<boolean>('syncFileBrowser', true) === false
        )
    });
    app.commands.addCommand(MOVE_PANELS_COMMAND, {
      // Names the sidebar the panels are not in.
      label: () =>
        sidebar === 'right'
          ? trans.__('Move Panel Left')
          : trans.__('Move Panel Right'),
      describedBy: {
        args: {
          type: 'object',
          properties: {
            panel: {
              type: 'string',
              description: 'Id of the panel whose header menu ran the command.'
            }
          }
        }
      },
      isEnabled: () => settings !== null,
      execute: args => {
        // `applySidebar` reads this when the change arrives. After a save
        // that fails it stays set: the sidebar can then only change to the
        // side this menu asked for.
        moveAskedBy = typeof args.panel === 'string' ? args.panel : null;
        return saveSetting('sidebar', sidebar === 'right' ? 'left' : 'right');
      }
    });

    await migrate();

    // Read and connected after the carry, so carried values are the state the
    // first dock reads. Heard as changes, each carried key docks panels before
    // the next key is saved, and a carried `sidebar` moves a panel the user
    // placed and saves that move in JupyterLab's layout.
    if (settings) {
      sidebar =
        setting<string>('sidebar', DEFAULT_SIDEBAR) === 'left'
          ? 'left'
          : 'right';
      settings.changed.connect(() => {
        applySidebar();
        reconcile();
      });
    }

    reconcile();

    armed = true;
    if (wokeDuringActivation) {
      reprobe();
    }

    // Each JupyterLab window keeps its own copy of the settings and never
    // reads them again, and every save writes that whole copy. So a window
    // loaded before another window changed a setting put the old value back
    // on its next save of any setting (DEF-PANE-282). A change in this window
    // tells the other windows of this browser, and a window also checks when
    // it gains focus, for a save from another browser or device. Either way
    // it reloads only when the server's copy differs from its own: a reload
    // replaces unsaved text in an open JSON settings editor, and the check
    // also ends the echo, because the window that saved already holds the
    // server's copy. Still open: another browser or device whose window saves
    // without gaining focus first, or whose focusing click is itself the
    // change - that needs a version check in JupyterLab's settings API
    // (DEF-PANE-283).
    if (settingRegistry && settings) {
      const current = settings;
      const channel = new BroadcastChannel(PLUGIN_ID);
      const reload = async (): Promise<void> => {
        try {
          const fetched = await settingRegistry.connector.fetch(PLUGIN_ID);
          if (fetched && fetched.raw !== current.raw) {
            await settingRegistry.reload(PLUGIN_ID);
          }
        } catch (err) {
          console.warn(`${LOG_PREFIX} could not reload settings.`, err);
        }
      };
      window.addEventListener('focus', () => void reload());
      channel.onmessage = () => void reload();
      current.changed.connect(() => {
        channel.postMessage('changed');
      });
    }

    // One events socket per window: the server pushes a message after every
    // change a route makes, whoever asked for it - the command line included
    // (ACC-CLI-227, ACC-CLI-228). Opened last, as the house notifications
    // stream is, so nothing it throws can take the panels down with it.
    let eventsUrl = URLExt.join(serverSettings.wsUrl, API_NAMESPACE, 'events');
    // Gated on appendToken, as @jupyterlab/services does for its own sockets:
    // a same-host session carries the handshake in its cookie.
    if (serverSettings.appendToken && serverSettings.token) {
      eventsUrl += `?token=${encodeURIComponent(serverSettings.token)}`;
    }
    let socket: WebSocket | null = null;
    /** Closes since the last open; non-zero means pushes may have been missed. */
    let drops = 0;
    let reopenTimer: number | undefined;
    const openEvents = (): void => {
      window.clearTimeout(reopenTimer);
      const ws = new serverSettings.WebSocket(eventsUrl);
      socket = ws;
      ws.onopen = () => {
        if (drops > 0) {
          // Whatever was pushed while the socket was closed: one status check
          // and one read per panel (the network-back trigger of ACC-PROV-230).
          drops = 0;
          reprobe();
          live.forEach(entry => entry.panel.sessionsChanged());
        }
      };
      ws.onmessage = (event: MessageEvent) => {
        const message = JSON.parse(event.data) as {
          type?: string;
          provider?: string;
          window?: string;
          status?: IStatusResponse;
        };
        if (message.type === 'sessions-changed') {
          // This window's own change: the panel that made it re-reads after
          // the write, and a second read redraws every row again
          // (DEF-PANE-370-OWN-PUSH).
          if (message.window !== WINDOW_ID) {
            live.get(message.provider ?? '')?.panel.sessionsChanged();
          }
        } else if (message.type === 'refresh' && message.status) {
          // The server probed for this push; its roster needs no request.
          status = message.status;
          reconcile();
          live.forEach(entry => entry.panel.sessionsChanged());
        }
      };
      ws.onclose = () => {
        socket = null;
        drops += 1;
        // This timer only reopens the socket; it checks nothing.
        reopenTimer = window.setTimeout(
          openEvents,
          Math.min(RECONNECT_BASE_MS * 2 ** (drops - 1), RECONNECT_MAX_MS)
        );
      };
      ws.onerror = () => ws.close();
    };
    // A closed socket reopens at once when the tab is back or the network is.
    const reopenEvents = (): void => {
      if (socket === null) {
        openEvents();
      }
    };
    window.addEventListener('online', reopenEvents);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        reopenEvents();
      }
    });
    openEvents();

    console.log(
      `${LOG_PREFIX} ${live.size} of ${registry.ids.length} assistant panel(s) docked.`
    );
  }
};

export default plugin;
