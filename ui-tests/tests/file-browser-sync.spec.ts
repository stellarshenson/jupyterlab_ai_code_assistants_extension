import * as path from 'path';

import { expect, test } from '@jupyterlab/galata';

import {
  AVAILABLE,
  PLUGIN_ID,
  openPanelTab,
  panelId,
  waitForApplication
} from './shared';

test.use({ autoGoto: false, waitForApplication });

/**
 * The file browser sync and the panel header's context menu, in a running
 * JupyterLab. Nothing is mocked: the row opens a real terminal on the stub
 * binary, the file browser is JupyterLab's own, and the menu writes the
 * settings registry the settings page writes.
 *
 * "branchy" is the seeded project: a real folder under the served root that
 * holds three conversations.
 */

const PANEL = `#${panelId('claude')}`;
const HEADER = `${PANEL} .jp-AiAssistantsPanel-header`;
const MENU = '.lm-Menu.jp-AiAssistantsContextMenu';
const SEEDED_FOLDER = 'branchy';

const SYNC = 'Sync File Browser';
const TO_LEFT = 'Move Panel Left';
const TO_RIGHT = 'Move Panel Right';

/** Screenshots land beside the run's other artefacts, in the port-keyed
 * `test-results/<port>` the config already owns and sweeps. */
const shotPath = (name: string): string =>
  path.join(test.info().project.outputDir, 'screenshots', `${name}.png`);

/** The folder the file browser shows, read from its model. Galata's own
 * `getCurrentDirectory` opens the file browser tab first, which is the one
 * thing these tests must not do. */
async function browserFolder(page: any): Promise<string> {
  return page.evaluate(async () => {
    const browser = await (window as any).galata.getPlugin(
      '@jupyterlab/filebrowser-extension:default-file-browser'
    );
    return browser.model.path as string;
  });
}

/** One of this extension's settings as the user saved it, or undefined. */
async function savedSetting(page: any, key: string): Promise<unknown> {
  return page.evaluate(
    async (args: { pluginId: string; key: string }) => {
      const registry = await (window as any).galata.getPlugin(
        '@jupyterlab/apputils-extension:settings'
      );
      return (await registry.get(args.pluginId, args.key)).user;
    },
    { pluginId: PLUGIN_ID, key }
  );
}

async function saveSetting(
  page: any,
  key: string,
  value: unknown
): Promise<void> {
  await page.evaluate(
    async (args: { pluginId: string; key: string; value: unknown }) => {
      const registry = await (window as any).galata.getPlugin(
        '@jupyterlab/apputils-extension:settings'
      );
      await registry.set(args.pluginId, args.key, args.value);
    },
    { pluginId: PLUGIN_ID, key, value }
  );
}

/** The sidebar placements JupyterLab itself has saved, or undefined. */
async function savedShellLayout(page: any): Promise<any> {
  return page.evaluate(async () => {
    const registry = await (window as any).galata.getPlugin(
      '@jupyterlab/apputils-extension:settings'
    );
    return (
      await registry.get('@jupyterlab/application-extension:shell', 'layout')
    ).user;
  });
}

const seededRow = (page: any): any =>
  page
    .locator(`${PANEL} .jp-AiAssistantsPanel-row`, { hasText: SEEDED_FOLDER })
    .first();

/** Right-click a panel header and return the menu that opens. */
async function openHeaderMenu(page: any, header = HEADER): Promise<any> {
  await page.locator(`${header} .jp-AiAssistantsPanel-title`).click({
    button: 'right'
  });
  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();
  return menu;
}

const itemLabels = (menu: any): Promise<string[]> =>
  menu
    .locator('.lm-Menu-item[data-type="command"] .lm-Menu-itemLabel')
    .allTextContents();

const item = (menu: any, label: string): any =>
  menu.locator('.lm-Menu-item[data-type="command"]', { hasText: label });

test('ACC-SESS-190, ACC-SESS-191 - a row click moves the file browser to the session folder and opens no sidebar', async ({
  page
}) => {
  await page.goto();
  // Shut, so a sync that activated the file browser would be seen opening it.
  await page.sidebar.close('left');
  await openPanelTab(page, 'claude');
  expect(await browserFolder(page)).toBe('');

  await expect(seededRow(page)).toBeVisible({ timeout: 15000 });
  await seededRow(page).click();
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });

  await expect.poll(() => browserFolder(page)).toBe(SEEDED_FOLDER);
  expect(await page.sidebar.isOpen('left')).toBe(false);
  await expect(page.locator(PANEL)).toBeVisible();
});

test('ACC-SESS-191 - beside the file browser, the panel stays on screen and the terminal keeps the focus', async ({
  page
}) => {
  await page.goto();
  await saveSetting(page, 'sidebar', 'left');
  await expect
    .poll(() => page.sidebar.getTabPosition(panelId('claude')))
    .toBe('left');
  await openPanelTab(page, 'claude');

  await expect(seededRow(page)).toBeVisible({ timeout: 15000 });
  await seededRow(page).click();
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => browserFolder(page)).toBe(SEEDED_FOLDER);

  // The file browser shares this sidebar: activating it would hide the panel.
  await expect(page.locator(PANEL)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.closest('.jp-Terminal') !== null
      )
    )
    .toBe(true);
  await page.screenshot({ path: shotPath('sync-panels-left') });
});

test('ACC-SESS-190 - an Open Branched Conversation item moves the file browser too', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');
  await expect(seededRow(page)).toBeVisible({ timeout: 15000 });
  await seededRow(page).click({ button: 'right' });
  const menu = page.locator(MENU).first();
  await expect(menu).toBeVisible({ timeout: 15000 });
  await menu
    .locator('.lm-Menu-itemLabel', { hasText: 'Open Branched Conversation' })
    .hover();
  const entries = page
    .locator('.lm-Menu')
    .last()
    .locator('.lm-Menu-item[data-type="command"]');
  await expect(entries.first()).toBeVisible({ timeout: 10000 });
  expect(await browserFolder(page)).toBe('');
  await entries.first().click();

  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => browserFolder(page)).toBe(SEEDED_FOLDER);
});

test('ACC-PANE-193 - a right-click on the header opens the two settings and nothing else', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');
  const menu = await openHeaderMenu(page);

  expect(await itemLabels(menu)).toEqual([SYNC, TO_LEFT]);
  // On by default, and the menu says so.
  await expect(item(menu, SYNC)).toHaveClass(/lm-mod-toggled/);
  await expect(item(menu, TO_LEFT)).not.toHaveClass(/lm-mod-toggled/);
  // One menu: neither JupyterLab's own context menu nor the row menu.
  await expect(page.locator('.lm-Menu')).toHaveCount(1);
  await page.screenshot({ path: shotPath('header-menu') });
});

test('ACC-PANE-194, ACC-SESS-192 - the header menu turns the sync off and on, and the next open follows it', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');
  await expect(seededRow(page)).toBeVisible({ timeout: 15000 });

  let menu = await openHeaderMenu(page);
  await item(menu, SYNC).click();
  await expect.poll(() => savedSetting(page, 'syncFileBrowser')).toBe(false);
  menu = await openHeaderMenu(page);
  await expect(item(menu, SYNC)).not.toHaveClass(/lm-mod-toggled/);
  await page.screenshot({ path: shotPath('header-menu-sync-off') });
  await page.keyboard.press('Escape');
  await expect(page.locator(MENU)).toHaveCount(0);

  // Off: the open happens and the file browser stays at the root.
  const terminals = page.locator('.jp-Terminal');
  await seededRow(page).click();
  await expect(terminals).toHaveCount(1, { timeout: 30000 });
  expect(await browserFolder(page)).toBe('');

  // On again: the same click now moves it. This is also what shows the
  // assertion above was not made before a slow sync could land.
  menu = await openHeaderMenu(page);
  await item(menu, SYNC).click();
  await expect.poll(() => savedSetting(page, 'syncFileBrowser')).toBe(true);
  await seededRow(page).click();
  await expect.poll(() => browserFolder(page)).toBe(SEEDED_FOLDER);
});

test('ACC-PANE-195, ACC-PANE-196 - Move Panel takes every panel to the other sidebar and keeps this one open', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');
  const sides = (): Promise<string[]> =>
    Promise.all(AVAILABLE.map(id => page.sidebar.getTabPosition(panelId(id))));
  expect(await sides()).toEqual(AVAILABLE.map(() => 'right'));

  let menu = await openHeaderMenu(page);
  await item(menu, TO_LEFT).click();
  await expect.poll(sides).toEqual(AVAILABLE.map(() => 'left'));
  expect(await savedSetting(page, 'sidebar')).toBe('left');
  // The panel the click was made in is on screen on the new side.
  await expect(page.locator(`#jp-left-stack ${PANEL}`)).toBeVisible();
  await page.screenshot({ path: shotPath('panels-moved-left') });

  menu = await openHeaderMenu(page);
  expect(await itemLabels(menu)).toEqual([SYNC, TO_RIGHT]);
  await item(menu, TO_RIGHT).click();
  await expect.poll(sides).toEqual(AVAILABLE.map(() => 'right'));
  expect(await savedSetting(page, 'sidebar')).toBe('right');
  await expect(page.locator(`#jp-right-stack ${PANEL}`)).toBeVisible();
});

test("ACC-PANE-199 - Move Panel also moves a panel placed with JupyterLab's Switch Sidebar Side, and it holds after a reload", async ({
  page
}) => {
  // The sidebar that the last workspace write of JupyterLab has the placed
  // panel in. JupyterLab writes its workspace about half a second after a
  // sidebar changed, and restores each sidebar from it when the page loads.
  let workspaceSide = '';
  page.on('response', (response: any) => {
    const request = response.request();
    if (
      request.method() === 'PUT' &&
      request.url().includes('/api/workspaces/')
    ) {
      const layout = request.postDataJSON()?.data?.['layout-restorer:data'];
      workspaceSide =
        ['left', 'right'].find(side =>
          (layout?.[side]?.widgets ?? []).includes(panelId('claude'))
        ) ?? '';
    }
  });
  await page.goto();
  await openPanelTab(page, 'claude');
  const sides = (): Promise<string[]> =>
    Promise.all(AVAILABLE.map(id => page.sidebar.getTabPosition(panelId(id))));

  // JupyterLab's own command, from the context menu of the sidebar tab.
  await page.sidebar.moveTabToLeft(panelId('claude'));
  await expect
    .poll(sides)
    .toEqual(AVAILABLE.map(id => (id === 'claude' ? 'left' : 'right')));

  // The setting still says right, so the item offers the left.
  let menu = await openHeaderMenu(page);
  await item(menu, TO_LEFT).click();
  await expect.poll(sides).toEqual(AVAILABLE.map(() => 'left'));

  // Back to the right: every panel goes, the placed one included.
  menu = await openHeaderMenu(page);
  await item(menu, TO_RIGHT).click();
  await expect.poll(sides).toEqual(AVAILABLE.map(() => 'right'));
  await expect(page.locator(`#jp-right-stack ${PANEL}`)).toBeVisible();

  // The new side is in JupyterLab's own layout setting, so a reload keeps it.
  await expect
    .poll(
      async () =>
        (await savedShellLayout(page))?.multiple?.[panelId('claude')]?.area
    )
    .toBe('right');
  // A reload before the workspace write that follows the move would restore
  // the sides of an earlier write, as it does after JupyterLab's own command.
  await expect.poll(() => workspaceSide).toBe('right');
  await page.reload();
  await expect.poll(sides).toEqual(AVAILABLE.map(() => 'right'));
});

test('ACC-PANE-200 - with a panel on screen in each sidebar, Move Panel keeps the panel its menu belongs to on screen', async ({
  page
}) => {
  await page.goto();
  const [first, later] = AVAILABLE.map(id => `#${panelId(id)}`);

  // JupyterLab's own command puts the first panel on the left. The setting
  // keeps the others on the right, so one panel can be open on each side.
  await openPanelTab(page, AVAILABLE[0]);
  await page.sidebar.moveTabToLeft(panelId(AVAILABLE[0]));
  await openPanelTab(page, AVAILABLE[0]);
  await openPanelTab(page, AVAILABLE[1]);
  await expect(page.locator(`#jp-left-stack ${first}`)).toBeVisible();
  await expect(page.locator(`#jp-right-stack ${later}`)).toBeVisible();

  const menu = await openHeaderMenu(
    page,
    `${later} .jp-AiAssistantsPanel-header`
  );
  await item(menu, TO_LEFT).click();

  // Both are in the left sidebar now, which shows one panel at a time.
  await expect(page.locator(`#jp-left-stack ${later}`)).toBeVisible();
  await expect(page.locator(first)).toBeHidden();
  await page.screenshot({ path: shotPath('move-keeps-own-panel') });
});
