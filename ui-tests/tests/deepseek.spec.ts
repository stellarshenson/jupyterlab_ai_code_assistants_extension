import { expect, test } from '@jupyterlab/galata';

import { openPanelTab, panelId, waitForApplication } from './shared';

test.use({ autoGoto: false, waitForApplication });

/**
 * The seeded "harness" project is a real directory under the served root with
 * one titled conversation in the scratch DeepSeek store, so the row drives the
 * whole launch path - panel to launch route to a pty running the `dsh` stub.
 * What is DeepSeek-specific and worth pinning in a browser: the row is named
 * by the log's title event, the open verb says the click serves the web UI
 * rather than resuming a conversation, and a second click on the row reuses
 * the terminal instead of starting a second server.
 */
test('a DeepSeek row opens the web UI terminal once', async ({ page }) => {
  await page.goto();
  await openPanelTab(page, 'deepseek');

  const panel = page.locator('#' + panelId('deepseek'));
  await expect(panel).toBeVisible();

  const row = panel
    .locator('.jp-AiAssistantsPanel-row', { hasText: 'Harness demo' })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });

  // The provider's own verb on the context menu.
  await row.click({ button: 'right' });
  await expect(
    page.locator('.lm-Menu-itemLabel', { hasText: 'Open Web UI' })
  ).toBeVisible();
  await page.keyboard.press('Escape');

  const terminals = async (): Promise<number> =>
    ((await (await page.request.get('/api/terminals')).json()) as unknown[])
      .length;
  const before = await terminals();

  await row.click();
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  await expect.poll(terminals).toBe(before + 1);

  // The same row again focuses the terminal it already has.
  await openPanelTab(page, 'deepseek');
  await row.click();
  await expect(page.locator('.jp-Terminal')).toBeVisible();
  await page.waitForTimeout(1500);
  expect(await terminals()).toBe(before + 1);
});
