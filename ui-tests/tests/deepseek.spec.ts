import { expect, test } from '@jupyterlab/galata';

import {
  openPanelTab,
  panelId,
  terminalCount,
  waitForApplication
} from './shared';

test.use({ autoGoto: false, waitForApplication });

/**
 * The seeded "harness" project is a real directory under the served root with
 * one titled conversation in the scratch DeepSeek store, so the row drives the
 * whole launch path - panel to launch route to a pty running the `dsh` stub.
 * What is DeepSeek-specific and worth pinning in a browser: the row is named
 * by the log's title event, the open verb says the click serves the web UI
 * rather than resuming a conversation, and a second click on the row reuses
 * the terminal instead of starting a second server.
 *
 * Not pinned here: reuse across a reload, a switch or a fork. That path rests
 * on the server confirming the terminal's process as the harness
 * (`owns_pid`: a node `comm` plus `dsh` in the argv), and the stub is a
 * `/bin/sh` script the probe never confirms - so the second click below is
 * answered by the page's own microcache, and the confirmed-process rule is
 * proven in `src/__tests__/terminals.spec.ts` against a stubbed probe.
 *
 * The second test pins the launched terminal's own end: the launch route
 * `exec`s the harness as the pty root, so stopping it from the keyboard ends
 * the pty, JupyterLab closes the tab (`closeOnExit`, on by default), the
 * panel's reuse entry goes with the widget, and the next click starts the
 * harness afresh rather than focusing a dead shell (DEF-PANE-223).
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

  const before = await terminalCount(page);

  await row.click();
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => terminalCount(page)).toBe(before + 1);

  // The same row again focuses the terminal it already has.
  await openPanelTab(page, 'deepseek');
  await row.click();
  await expect(page.locator('.jp-Terminal')).toBeVisible();
  await page.waitForTimeout(1500);
  expect(await terminalCount(page)).toBe(before + 1);
});

test('stopping the harness closes its tab and the next click starts it again', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'deepseek');
  const panel = page.locator('#' + panelId('deepseek'));
  const row = panel
    .locator('.jp-AiAssistantsPanel-row', { hasText: 'Harness demo' })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });
  const before = await terminalCount(page);

  await row.click();
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => terminalCount(page)).toBe(before + 1);
  // The init waiter polls the pty size for up to 5 s before it execs the
  // harness; Ctrl+C before that would end the waiter, not the harness.
  await page.waitForTimeout(6000);

  await page.locator('.jp-Terminal').first().click();
  await page.keyboard.press('Control+C');

  await expect(page.locator('.jp-Terminal')).toHaveCount(0, { timeout: 15000 });
  await expect.poll(() => terminalCount(page)).toBe(before);

  await openPanelTab(page, 'deepseek');
  await row.click();
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => terminalCount(page)).toBe(before + 1);
});
