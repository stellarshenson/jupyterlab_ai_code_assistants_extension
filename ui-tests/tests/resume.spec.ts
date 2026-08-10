import { expect, test } from '@jupyterlab/galata';

import { openPanelTab, panelId, waitForApplication } from './shared';

test.use({ autoGoto: false, waitForApplication });

/**
 * The seeded "branchy" project is a real directory under the served root with
 * three conversations in the scratch Claude store, so a row click drives the
 * whole launch path - panel to launch route to a pty running the stub binary
 * to JupyterLab's terminal widget. Nothing is mocked on either side; that is
 * the point of this tier.
 */
test('clicking a seeded session row opens a terminal', async ({ page }) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  const panel = page.locator('#' + panelId('claude'));
  await expect(panel).toBeVisible();

  const row = panel
    .locator('.jp-AiAssistantsPanel-row', { hasText: 'branchy' })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });

  const before = (
    (await (await page.request.get('/api/terminals')).json()) as unknown[]
  ).length;

  await row.click();

  // xterm paints to a canvas, so the stub's output is not assertable through
  // the DOM; the terminal widget plus a new server-side terminal session is
  // the observable proof that the launch route ran.
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });

  const after = (
    (await (await page.request.get('/api/terminals')).json()) as unknown[]
  ).length;
  expect(after).toBeGreaterThan(before);
});
