import {
  ILabShell,
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { Notification } from '@jupyterlab/apputils';
import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITerminalTracker } from '@jupyterlab/terminal';
import { IColourfulTabs } from 'jupyterlab_colourful_tab_extension';
import { IDisposable } from '@lumino/disposable';

import { DEFAULT_RECENT_LIMIT } from './core/limits';
import {
  AssistantSessionsPanel,
  DEFAULT_PRESENTATION_MODE,
  PresentationMode,
  commandId,
  panelWidgetId
} from './core/panel';
import { LOG_PREFIX, ProviderRegistry } from './core/registry';
import { requestAPI } from './core/request';
import {
  IMigrateResponse,
  IProviderStatus,
  IStatusResponse
} from './core/types';
import { PROVIDERS } from './providers';

/** Which sidebar the panels dock into unless the user says otherwise. */
const DEFAULT_SIDEBAR = 'right';

const PLUGIN_ID = 'jupyterlab_ai_code_assistants_extension:plugin';
/** Sidebar rank, shared by every panel so they dock together. */
const PANEL_RANK = 600;
/** How often the server is re-asked which assistants are available, so a CLI
 * installed while JupyterLab runs surfaces without a reload. */
const STATUS_INTERVAL_MS = 60_000;

type Sidebar = 'left' | 'right';

/** One live provider: its panel and the command that refreshes it. */
interface ILivePanel {
  panel: AssistantSessionsPanel;
  command: IDisposable;
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
    IColourfulTabs
  ],
  activate: async (
    app: JupyterFrontEnd,
    labShell: ILabShell,
    restorer: ILayoutRestorer | null,
    settingRegistry: ISettingRegistry | null,
    terminalTracker: ITerminalTracker | null,
    fileBrowser: IDefaultFileBrowser | null,
    colourfulTabs: IColourfulTabs | null
  ) => {
    console.log(
      'JupyterLab extension jupyterlab_ai_code_assistants_extension is activated!'
    );

    // A duplicate id throws here, at registration, rather than surfacing later
    // as two panels quietly fighting over one widget id.
    const registry = new ProviderRegistry(PROVIDERS);

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

    /** Ask the server which providers exist and which of their binaries are on
     * PATH. A failure leaves the extension activated with no panels - never a
     * dialog, and never a thrown activation. */
    const probeStatus = async (): Promise<void> => {
      try {
        status = await requestAPI<IStatusResponse>('status', serverSettings, {
          cache: 'no-store'
        });
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} status probe failed; no assistant panels will be docked.`,
          err
        );
        status = null;
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
    const modesFor = (id: string): Record<string, boolean | string> => {
      const descriptor = registry.get(id)?.descriptor;
      const modes: Record<string, boolean | string> = {};
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
          deleteToTrash: status?.delete_to_trash !== false,
          terminalTracker,
          fileBrowser,
          colourfulTabs
        });
        applySharedSettings(panel);
        dock(panel);
        // Each panel registers under its own name, so its open/closed state
        // survives a reload independently of the others.
        restorer?.add(panel, panelWidgetId(id));
        const command = app.commands.addCommand(commandId(id, 'refresh'), {
          label: `Refresh ${module.descriptor.panelTitle}`,
          execute: () => panel.refresh()
        });
        live.set(id, { panel, command });
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
        const available = probe ? probe.available !== false : false;
        // Enabled but binary absent must not be a silent state: the user sees
        // a missing panel with no clue that PATH under the Jupyter server
        // differs from their shell. Once per id, not per reconcile.
        // Only when the probe SUCCEEDED and this provider is the one missing.
        // A failed probe sets every provider unavailable, and blaming PATH for
        // a server the frontend never reached names the wrong cause; and every
        // provider defaults to enabled, so a machine with one assistant
        // installed would otherwise raise three toasts about assistants the
        // user has never heard of. The console line stays for that case.
        const chosen =
          settings?.get(`providers.${id}.enabled`).user !== undefined;
        if (
          probe !== null &&
          probe.available === false &&
          enabled &&
          chosen &&
          !warnedUnavailable.has(id)
        ) {
          warnedUnavailable.add(id);
          const binary = registry.get(id)?.descriptor.cliBinary ?? id;
          const label = registry.get(id)?.descriptor.label ?? id;
          console.info(
            `${LOG_PREFIX} "${id}" is enabled but its \`${binary}\` binary was not found on the server's PATH; panel not shown.`
          );
          // And say it where the user is looking. A console line satisfies the
          // comment above only for someone who already suspects the cause; the
          // symptom is a panel that never appears, which reads as a broken
          // install rather than a PATH difference between the Jupyter server
          // and the user's shell. The retired-extension case next door already
          // gets a notification, so the COMMON failure was the quiet one.
          Notification.warning(
            `${label} is enabled but \`${binary}\` was not found on the Jupyter server's PATH, so its panel is not shown.`,
            { autoClose: 8000 }
          );
        }
        if (enabled && available) {
          if (live.has(id)) {
            applySharedSettings(live.get(id)!.panel);
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
            // Per key. The server marks EVERY provider migrated before it
            // answers, so one rejection aborting the loop used to drop the
            // remaining providers' values with no retry ever offered again -
            // the same blast radius DEF-13 closed for a missing registry, one
            // level down.
            try {
              await settings?.set(key, value as any);
            } catch (err) {
              console.warn(
                `${LOG_PREFIX} could not carry over "${key}" from the retired extension.`,
                err
              );
            }
          }
        }
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} migration from the retired extensions failed; nothing was carried over.`,
          err
        );
      }
    };

    const applySidebar = (): void => {
      const next = setting<string>('sidebar', DEFAULT_SIDEBAR);
      if ((next === 'left' || next === 'right') && next !== sidebar) {
        sidebar = next;
        live.forEach(entry => dock(entry.panel));
      }
    };

    await probeStatus();

    if (settingRegistry) {
      try {
        settings = await settingRegistry.load(PLUGIN_ID);
        sidebar =
          setting<string>('sidebar', DEFAULT_SIDEBAR) === 'left'
            ? 'left'
            : 'right';
        settings.changed.connect(() => {
          applySidebar();
          reconcile();
        });
      } catch (err) {
        // Defaults apply: every provider enabled, right sidebar.
        console.warn(
          `${LOG_PREFIX} failed to load settings; using defaults.`,
          err
        );
        settings = null;
      }
    }

    await migrate();

    reconcile();

    // Re-probe on a slow cadence so a binary installed (or removed) while
    // JupyterLab runs takes effect on the next refresh, without a reload.
    window.setInterval(() => {
      void probeStatus().then(reconcile);
    }, STATUS_INTERVAL_MS);

    console.log(
      `${LOG_PREFIX} ${live.size} of ${registry.ids.length} assistant panel(s) docked.`
    );
  }
};

export default plugin;
