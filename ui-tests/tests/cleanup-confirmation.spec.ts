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

/** Right-click one project's row, open Clean Up, and return the modal with the
 * branch list its own fetch answered - the list its removal deletes. */
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
  const response = await listed;
  await response.finished();
  const fetched = (await response.json()) as {
    branches?: Array<{ session_id: string }>;
  };

  const dialog = page.locator('.jp-Dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });
  return { dialog, branches: fetched.branches ?? [] };
}

/** The hint is one sentence of at most twelve words. */
async function expectShortHint(dialog: any): Promise<void> {
  const hint = dialog.locator(HINT);
  await expect(hint).toBeVisible();
  const words = (await hint.textContent())!.trim().split(/\s+/);
  expect(words.length).toBeLessThanOrEqual(12);
}

test('ACC-PANE-221, ACC-PANE-222, ACC-PANE-233 and ACC-PANE-236 - Clean Up warns of a newer removed conversation, keeps its hint short, and arms Remove', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  // A conversation the removal deletes was active after the one kept: the
  // warning box is in the modal.
  const newer = await openCleanup(page, 'cleanup-newer');
  const dialog = newer.dialog;
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

  // The warning means one activation never removes: the first click arms the
  // button to its error-coloured confirming label and the dialog stays up.
  const remove = dialog.locator('.jp-Dialog-button.jp-mod-accept');
  await expect(remove).toHaveText('Remove (1)');
  await remove.click();
  await expect(dialog).toBeVisible();
  await expect(remove).toHaveText('Confirm remove 1');
  await expect(remove).toHaveClass(/jp-mod-armed/);

  // Cancel that arm, so the same project's branches are still there for the
  // keyboard proof below.
  await dialog.locator('.jp-Dialog-button.jp-mod-reject').click();
  await expect(dialog).toHaveCount(0);

  // A real Enter press, not a JS dispatch: the browser fires the focused
  // button's default activation click after the keydown unless the capture
  // handler consumes it, and that click would confirm in one press. The first
  // Enter must only arm.
  const reopened = await openCleanup(page, 'cleanup-newer');
  const keyboardRemove = reopened.dialog.locator(
    '.jp-Dialog-button.jp-mod-accept'
  );
  await expect(keyboardRemove).toHaveText('Remove (1)');
  await keyboardRemove.focus();
  await page.keyboard.press('Enter');
  await expect(reopened.dialog).toBeVisible();
  await expect(keyboardRemove).toHaveText('Confirm remove 1');
  await expect(keyboardRemove).toHaveClass(/jp-mod-armed/);

  // The second Enter confirms and issues the DELETE for the fetched ids.
  const deleting = page.waitForRequest(
    (request: any) =>
      request.method() === 'DELETE' && request.url().includes('/sessions')
  );
  await page.keyboard.press('Enter');
  const sent = JSON.parse((await deleting).postData() ?? '{}');
  expect(sent.session_ids).toEqual(
    reopened.branches.map(branch => branch.session_id)
  );
  // The confirmation closes and the progress dialog reports the removal; close
  // it so the next project's confirmation is the only dialog.
  const progress = page.locator('.jp-Dialog');
  await expect(progress).toContainText('Removed', { timeout: 15000 });
  await progress.locator('.jp-Dialog-button', { hasText: 'Close' }).click();
  await expect(progress).toHaveCount(0);

  // Every conversation it removes is older than the one kept: no warning box,
  // and one click still removes with today's label.
  const older = await openCleanup(page, 'cleanup-older');
  await expect(older.dialog.locator(WARNING)).toHaveCount(0);
  await expectShortHint(older.dialog);
  const removeOlder = older.dialog.locator('.jp-Dialog-button.jp-mod-accept');
  await expect(removeOlder).toHaveText('Remove');
  const deletingOlder = page.waitForRequest(
    (request: any) =>
      request.method() === 'DELETE' && request.url().includes('/sessions')
  );
  await removeOlder.click();
  const sentOlder = JSON.parse((await deletingOlder).postData() ?? '{}');
  expect(sentOlder.session_ids).toEqual(
    older.branches.map(branch => branch.session_id)
  );
  await expect(page.locator('.jp-Dialog')).toContainText('Removed', {
    timeout: 15000
  });
});
