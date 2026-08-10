/**
 * Shared fixtures for the Galata suite.
 *
 * The provider split mirrors `jupyter_server_test_config.py`: three assistants
 * have a stub binary on PATH, one deliberately has none. Specs assert against
 * these constants AND cross-check them against the server's own status
 * roster, so a change to the server config that the specs did not follow
 * fails loudly instead of quietly weakening an assertion.
 */

/** Providers whose stub binary is on PATH, so a panel is expected. */
export const AVAILABLE = ['claude', 'codex', 'kimi'];

/** Providers with no binary on PATH, so no panel is expected. */
export const ABSENT = ['gemini'];

export const PLUGIN_ID = 'jupyterlab_ai_code_assistants_extension:plugin';

export const STATUS_URL = '/jupyterlab-ai-code-assistants-extension/status';

/** Widget id of one provider's panel - also its sidebar tab id. */
export const panelId = (providerId: string): string =>
  `jupyterlab-ai-code-assistants-${providerId}`;

/** The left-sidebar tab that docks with one provider's panel. */
const tabSelector = (providerId: string): string =>
  `.lm-TabBar-tab[data-id="${panelId(providerId)}"]`;

/** How long a panel is given to dock. Generous: the first reconcile waits on
 * the server's status probe, which shells out to `which` per provider. */
const DOCK_TIMEOUT = 30000;

/**
 * Build-agnostic readiness check that also waits for this extension's panels.
 *
 * Galata's default `waitForApplication` calls `isInSimpleMode()`, which waits
 * on the status-bar single-document-mode toggle (`getByRole('switch', { name:
 * 'Simple' })`). Some JupyterLab builds do not render that toggle, so the
 * default check hangs and every test times out at `page.goto()`. Wait on the
 * splash teardown plus the lab shell instead - present in every build - so the
 * suite is robust to the toggle's absence.
 *
 * Neither check knows anything about panels, and the shell is up well before
 * the extension has docked any: activation fetches the provider status and
 * only then reconciles. Every spec that follows was therefore racing the dock
 * (DEF-48) - `openTab` threw when it lost, and a "no panel for this provider"
 * assertion PASSED when it lost, which is the worse half. Waiting for the
 * server's own roster to be on screen removes both.
 *
 * The expected set is the providers the server reports as available, i.e. with
 * a binary on PATH - the server-side half of the dock condition. The frontend
 * half is the per-provider `enabled` setting, which is true by default and so
 * holds for every provider on a freshly loaded page.
 */
export const waitForApplication = async (
  { baseURL }: { baseURL?: string },
  use: (ready: (page: any) => Promise<void>) => Promise<void>
): Promise<void> => {
  void baseURL;
  const waitIsReady = async (page: any): Promise<void> => {
    await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
    await page.locator('.jp-LabShell').first().waitFor({ state: 'visible' });
    const status = await fetchStatus(page);
    for (const provider of status.providers.filter(p => p.available)) {
      await page
        .locator(tabSelector(provider.id))
        .waitFor({ state: 'attached', timeout: DOCK_TIMEOUT });
    }
  };
  await use(waitIsReady);
};

/**
 * Open one provider's sidebar tab and wait until its panel is on screen.
 *
 * Galata's `sidebar.openTab` reads the tab count ONCE - `Locator.count()` is a
 * single shot with no retry - and throws "Unable to find the tab" if the tab
 * is not there yet. Panels dock asynchronously, so that read races the
 * extension (DEF-48). Wait for the tab to attach before handing over, and for
 * the panel body afterwards, so a spec's first assertion is never made against
 * a panel that is still arriving.
 */
export async function openPanelTab(
  page: any,
  providerId: string
): Promise<void> {
  const id = panelId(providerId);
  await page
    .locator(tabSelector(providerId))
    .waitFor({ state: 'attached', timeout: DOCK_TIMEOUT });
  await page.sidebar.openTab(id);
  await page.locator(`#${id}`).waitFor({
    state: 'visible',
    timeout: DOCK_TIMEOUT
  });
}

/**
 * Turn one provider on or off the way a user does - through the settings
 * registry - so the extension's own `settings.changed` path is what docks or
 * undocks the panel, not a reload.
 */
export async function setProviderEnabled(
  page: any,
  providerId: string,
  enabled: boolean
): Promise<void> {
  await page.evaluate(
    async (args: { pluginId: string; key: string; value: boolean }) => {
      const registry = await (window as any).galata.getPlugin(
        '@jupyterlab/apputils-extension:settings'
      );
      await registry.set(args.pluginId, args.key, args.value);
    },
    {
      pluginId: PLUGIN_ID,
      key: `providers.${providerId}.enabled`,
      value: enabled
    }
  );
}

/** The server's provider roster: which assistants it knows and which of their
 * binaries it can see. */
export async function fetchStatus(page: any): Promise<{
  root_dir: string;
  providers: Array<{
    id: string;
    label: string;
    enabled: boolean;
    cli_path: string | null;
    available: boolean;
  }>;
}> {
  const response = await page.request.get(STATUS_URL);
  if (!response.ok()) {
    throw new Error(`status probe failed: ${response.status()}`);
  }
  return response.json();
}
