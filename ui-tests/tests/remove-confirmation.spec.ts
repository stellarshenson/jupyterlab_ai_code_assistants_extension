import { expect, test } from '@jupyterlab/galata';
import * as path from 'path';

import { openPanelTab, panelId, waitForApplication } from './shared';

/**
 * The Remove-from-assistant confirmation, rendered in a browser.
 *
 * The unit tier asserts the same strings in jsdom, where no CSS is laid out
 * and the caution is never seen. This file renders the shortened body against
 * the seeded `branchy` project, captures the whole dialog for the DEF-PANE-371
 * close evidence, and cancels so the fixture stays for every other spec.
 */
test.use({ autoGoto: false, waitForApplication });

const PANEL = `#${panelId('claude')}`;
const MENU = '.lm-Menu.jp-AiAssistantsContextMenu';
const SHOT = path.join(
  __dirname,
  '..',
  '..',
  'tmp',
  'workflows',
  'cleanup-evidence',
  'screenshots',
  'remove-confirm.png'
);

test('DEF-PANE-371 - the Remove confirmation names the project and the trash outcome', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  const row = page
    .locator(PANEL)
    .locator('.jp-AiAssistantsPanel-row', { hasText: 'branchy' })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click({ button: 'right' });

  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();
  await menu
    .locator('.lm-Menu-item', { hasText: 'Remove from Claude Code' })
    .first()
    .click();

  const dialog = page.locator('.jp-Dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });

  // Two lines: the question with the project name and the trash outcome,
  // then the permanent-deletion caution on its own line. The trash is on by
  // default in this server, as `session-delete.spec.ts` relies on.
  await expect(
    dialog.locator('.jp-AiAssistantsPanel-removeConfirm p').nth(0)
  ).toHaveText('Remove "branchy"? Every conversation in it goes to the trash.');
  const caution = dialog.locator('.jp-AiAssistantsPanel-removeCaution');
  await expect(caution).toBeVisible();
  await expect(caution).toHaveText('A refused move deletes permanently.');

  // The whole dialog - title, body, caution and buttons - for the close
  // evidence.
  await dialog.screenshot({ path: SHOT });

  // Cancel: nothing is removed and the row stays for the other specs.
  await dialog.locator('.jp-Dialog-button.jp-mod-reject').click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeVisible();
});
