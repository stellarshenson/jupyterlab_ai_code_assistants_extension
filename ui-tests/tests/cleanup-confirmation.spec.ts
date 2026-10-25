import { expect, test } from '@jupyterlab/galata';

import { openPanelTab, panelId, waitForApplication } from './shared';

/**
 * The Clean Up Parallel Sessions confirmation, against the real stores.
 *
 * `jupyter_server_test_config.py` seeds two Claude projects for this spec
 * alone: `cleanup-newer` pins an older conversation as current while a newer
 * transcript sits beside it, so the confirmation must warn that a conversation
 * it removes was active after the one it keeps; `cleanup-older` holds an older
 * extra only, so it must not warn. Both use the suite's scratch HOME - no real
 * assistant store is read or written.
 *
 * The unit tier proves the same rule from a mocked provider; this file proves
 * the rendered modal - the warning box is a distinct element, its colour is the
 * theme's warning token, and the hint a user reads is twelve words at most.
 */
test.use({ autoGoto: false, waitForApplication });

const PANEL = `#${panelId('claude')}`;
const MENU = '.lm-Menu.jp-AiAssistantsContextMenu';
const WARNING = '.jp-AiAssistantsPanel-cleanupWarning';
const HINT = '.jp-AiAssistantsPanel-cleanupHint';
const CAUTION = '.jp-AiAssistantsPanel-cleanupCaution';

/** Right-click one project's row, open Clean Up, and return the modal. */
async function openCleanup(page: any, project: string) {
  const row = page
    .locator(PANEL)
    .locator('.jp-AiAssistantsPanel-row', { hasText: project })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click({ button: 'right' });

  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();
  // The menu fetches the branch list itself. Wait for that fetch to land, so
  // the `/branches` response awaited below is the confirmation's own: the
  // warning, or its absence, is decided from that response, and asserting
  // "no warning" before it arrives would pass whatever the rule.
  await expect(
    menu.locator('.lm-Menu-item', { hasText: 'Switch and Manage Sessions' })
  ).toBeVisible();

  const listed = page.waitForResponse((response: any) =>
    response.url().includes('/branches')
  );
  await menu
    .locator('.lm-Menu-item', { hasText: 'Clean Up Parallel Sessions' })
    .first()
    .click();
  await (await listed).finished();

  const dialog = page.locator('.jp-Dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });
  return dialog;
}

async function cancel(dialog: any): Promise<void> {
  await dialog.locator('.jp-Dialog-button', { hasText: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
}

/** The hint is one sentence of at most twelve words. */
async function expectShortHint(dialog: any): Promise<void> {
  const hint = dialog.locator(HINT);
  await expect(hint).toBeVisible();
  const words = (await hint.textContent())!.trim().split(/\s+/);
  expect(words.length).toBeLessThanOrEqual(12);
}

test('ACC-PANE-221 and ACC-PANE-222 - Clean Up warns of a newer removed conversation and keeps its hint short', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  // A conversation the removal deletes was active after the one kept: the
  // warning box is in the modal.
  let dialog = await openCleanup(page, 'cleanup-newer');
  const warning = dialog.locator(WARNING);
  await expect(warning).toBeVisible();

  // Drawn with the theme's warning colour, not the body text colour.
  const colours = await warning.evaluate((el: HTMLElement) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--jp-warn-color1)';
    document.body.appendChild(probe);
    const token = getComputedStyle(probe).color;
    probe.remove();
    return { border: getComputedStyle(el).borderLeftColor, token };
  });
  expect(colours.border).toBe(colours.token);

  await expectShortHint(dialog);
  // The permanent-deletion caution is a separate statement, so the hint can
  // stay short without losing the safety warning.
  await expect(dialog.locator(CAUTION)).toContainText('cannot be undone');
  await cancel(dialog);

  // Every conversation it removes is older than the one kept: no warning box.
  dialog = await openCleanup(page, 'cleanup-older');
  await expect(dialog.locator(WARNING)).toHaveCount(0);
  await expectShortHint(dialog);
  await cancel(dialog);
});
