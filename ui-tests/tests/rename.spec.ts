import { expect, test } from '@jupyterlab/galata';

import { openPanelTab, panelId, waitForApplication } from './shared';

/**
 * Rendered proof for Rename Session (ACC-SESS-173, ACC-SESS-174).
 *
 * Two claims the DOM tier cannot settle. The first is that the item is really
 * on the menu a user opens, with a glyph like its siblings - `panel.spec.ts`
 * asserts the command registry, not the painted menu. The second is the whole
 * round trip: dialog to route to the assistant's own store and back onto the
 * row, with nothing mocked anywhere along it. The provider that CANNOT rename
 * stays at the unit tier, which drives the same Lumino menu and needs no
 * seeded Codex project to right-click.
 *
 * The rename works on the `renamable` project, which exists for this file
 * alone: the suite runs one worker against one server, so a rename lands in a
 * store every later spec reads. The new name CONTAINS the old one so this
 * file's own locators keep matching after it, which is what makes a Playwright
 * retry find the row it already renamed.
 */
test.use({ autoGoto: false, waitForApplication });

const MENU = '.lm-Menu.jp-AiAssistantsContextMenu';
const ITEM = 'Rename Session';
const RENAMED = 'renamable-renamed';

async function openRowMenu(page: any, providerId: string, rowText: string) {
  const row = page
    .locator(`#${panelId(providerId)}`)
    .locator('.jp-AiAssistantsPanel-row', { hasText: rowText })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click({ button: 'right' });
  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();
  return menu;
}

test('ACC-SESS-174 - the item is really on the menu, with a glyph', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  const menu = await openRowMenu(page, 'claude', 'branchy');
  const item = menu.locator('.lm-Menu-item', { hasText: ITEM }).first();
  await expect(item).toBeVisible();
  // A glyph like its siblings, not a bare label in a menu where every other
  // entry carries one.
  const glyph = item.locator('.lm-Menu-itemIcon svg');
  await expect(glyph).toHaveCount(1);
  expect((await glyph.boundingBox())!.width).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
});

test('ACC-SESS-173 - a rename reaches the store and comes back on the row', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  const menu = await openRowMenu(page, 'claude', 'renamable');
  await menu.locator('.lm-Menu-item', { hasText: ITEM }).first().click();

  const dialog = page.locator('.jp-Dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('input').fill(RENAMED);
  await dialog.locator('.jp-Dialog-button.jp-mod-accept').click();
  await expect(dialog).toHaveCount(0);

  // The row carries the name the assistant's own store now holds - no reload,
  // and read back from disk rather than echoed from the dialog.
  const row = page
    .locator(`#${panelId('claude')}`)
    .locator('.jp-AiAssistantsPanel-row', { hasText: RENAMED })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });

  // And it is a `custom-title` record in the transcript, which is what the
  // CLI's own `/rename` writes - asserted through the panel's own listing.
  const payload = await (
    await page.request.get(
      '/jupyterlab-ai-code-assistants-extension/providers/claude/sessions'
    )
  ).json();
  const found = payload.sessions.find((s: any) =>
    s.project_path.endsWith('/renamable')
  );
  expect([found?.name, found?.name_source]).toEqual([RENAMED, 'session']);
});
