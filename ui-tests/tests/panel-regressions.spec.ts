import { expect, test } from '@jupyterlab/galata';

import { PLUGIN_ID, openPanelTab, panelId, waitForApplication } from './shared';

/**
 * Rendered proof for the panel defects whose claims a DOM tier cannot settle.
 *
 * Every assertion here was previously made under jsdom, which performs no
 * layout and paints nothing - so "the badge is a sibling of the text span"
 * could be proven while "the badge is visible to a user" could not, and
 * "the icon's class is jp-icon-warn0" could be proven while "it is not the
 * same grey as its neighbours" could not. Three agents in the round-5 fix
 * wave declined to claim the visual half rather than assert it, and this file
 * is where that half gets settled: real layout, real computed styles, in a
 * real browser.
 *
 * The unit tier is not replaced by any of this. `src/__tests__/panel.spec.ts`
 * still owns the structural claims and runs in seconds on every commit; these
 * cost a browser and a server, and each one earns that cost by asserting
 * something a DOM alone cannot see.
 */
test.use({ autoGoto: false, waitForApplication });

const PANEL = `#${panelId('claude')}`;
const MENU = '.lm-Menu.jp-AiAssistantsContextMenu';
const WIDE_NAME =
  'a-deliberately-very-long-project-name-that-overflows-the-sidebar';

/** Arm a launch mode through the settings registry, the way a user does. */
async function setLaunchMode(
  page: any,
  providerId: string,
  modeId: string,
  value: boolean | string
): Promise<void> {
  await page.evaluate(
    async (args: {
      pluginId: string;
      key: string;
      value: boolean | string;
    }) => {
      const registry = await (window as any).galata.getPlugin(
        '@jupyterlab/apputils-extension:settings'
      );
      await registry.set(args.pluginId, args.key, args.value);
    },
    {
      pluginId: PLUGIN_ID,
      key: `providers.${providerId}.${modeId}`,
      value
    }
  );
}

/** Right-click a row by the text it carries and return its context menu. */
async function openRowMenu(page: any, rowText: string) {
  const row = page
    .locator(PANEL)
    .locator('.jp-AiAssistantsPanel-row', { hasText: rowText })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click({ button: 'right' });
  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();
  return menu;
}

test('DEF-41 - a name too wide for the sidebar does not clip its badges', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  const row = page
    .locator(PANEL)
    .locator('.jp-AiAssistantsPanel-row', { hasText: WIDE_NAME })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });

  const badge = row.locator('.jp-AiAssistantsPanel-branchBadge');
  await expect(badge).toBeVisible();

  // Visible is necessary and not sufficient: an element clipped by an
  // ancestor's `overflow: hidden` still reports visible to Playwright, which
  // is precisely how this defect survived review. Compare boxes instead.
  const nameBox = await row.locator('.jp-AiAssistantsPanel-name').boundingBox();
  const badgeBox = await badge.boundingBox();
  const rowBox = await row.boundingBox();
  expect(nameBox).not.toBeNull();
  expect(badgeBox).not.toBeNull();
  expect(rowBox).not.toBeNull();

  // The whole badge sits inside the row it belongs to - the clipped state had
  // its left edge beyond the row's right edge.
  expect(badgeBox!.x).toBeGreaterThanOrEqual(rowBox!.x);
  expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(
    rowBox!.x + rowBox!.width + 1
  );
  expect(badgeBox!.width).toBeGreaterThan(0);

  // ...and the name really is overflowing, so the test is not passing because
  // the fixture name happened to fit. Without this the assertion above is
  // vacuous on a wide sidebar.
  const overflowing = await row
    .locator('.jp-AiAssistantsPanel-nameText')
    .evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth);
  expect(overflowing).toBe(true);
});

test('DEF-42 - submenus draw a caret', async ({ page }) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  const menu = await openRowMenu(page, 'branchy');

  const submenuItem = menu
    .locator('.lm-Menu-item[data-type="submenu"]')
    .first();
  await expect(submenuItem).toBeVisible();

  // The marker cell exists in a plain Lumino Menu too - it is EMPTY there.
  // What MenuSvg adds is the glyph inside it, so assert the glyph and its box.
  const caret = submenuItem.locator('.lm-Menu-itemSubmenuIcon svg');
  await expect(caret).toHaveCount(1);
  const caretBox = await caret.boundingBox();
  expect(caretBox).not.toBeNull();
  expect(caretBox!.width).toBeGreaterThan(0);
  expect(caretBox!.height).toBeGreaterThan(0);

  await page.keyboard.press('Escape');
});

test('DEF-54 and DEF-40 - an approval-bypassing new-session button is marked, and the mark is not the neutral grey', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  // By position, not by title: the header builds "+", filter, refresh in that
  // order, and the "+" button's title is exactly what this test arms a mode to
  // change - so a title selector would stop matching at the moment it matters.
  const newButton = page
    .locator(`${PANEL} .jp-AiAssistantsPanel-header`)
    .locator('.jp-AiAssistantsPanel-iconButton')
    .first();

  // Neutral before the mode is armed.
  await expect(newButton.locator('svg')).toHaveCount(1);
  const neutralFill = await newButton
    .locator('svg path')
    .first()
    .evaluate((el: SVGPathElement) => getComputedStyle(el).fill);

  await setLaunchMode(page, 'claude', 'dangerouslySkipPermissions', true);

  // The glyph is repainted from `setModes`, with no hover and no reload -
  // DEF-38's lesson, applied to the icon.
  const warned = newButton.locator('svg .jp-icon-warn0');
  await expect(warned).toHaveCount(1, { timeout: 10000 });
  await expect(newButton.locator('svg')).toHaveCount(1);

  // DEF-40: the caution glyph rendered in the SAME grey as its neutral
  // siblings, measured rgb(97,97,97) light and rgb(189,189,189) dark, so the
  // one glyph whose job is to say "this differs" was the least conspicuous in
  // the menu. Assert the painted colour differs from the neutral one rather
  // than pinning a hex value the theme is entitled to change.
  const warnFill = await warned.evaluate(
    (el: SVGElement) => getComputedStyle(el).fill
  );
  expect(warnFill).not.toBe(neutralFill);

  // ...and at the size of its siblings, not smaller.
  const box = await newButton.locator('svg').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(14);
  expect(box!.height).toBeGreaterThanOrEqual(14);

  await setLaunchMode(page, 'claude', 'dangerouslySkipPermissions', false);
});

test('DEF-45 - both destructive context-menu entries carry a glyph', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  const menu = await openRowMenu(page, 'branchy');

  for (const label of ['Clean Up Parallel Sessions', 'Remove from']) {
    const item = menu.locator('.lm-Menu-item', { hasText: label }).first();
    await expect(item).toBeVisible();
    const glyph = item.locator('.lm-Menu-itemIcon svg');
    await expect(glyph).toHaveCount(1);
    const glyphBox = await glyph.boundingBox();
    expect(glyphBox).not.toBeNull();
    expect(glyphBox!.width).toBeGreaterThan(0);
  }

  await page.keyboard.press('Escape');
});

test('DEF-55 - the cleanup dialog keeps a way out while the request is in flight', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  // Hold the DELETE open so the dialog is observed mid-flight rather than
  // after it has finished, which is the only state the defect existed in.
  let release: (() => void) | null = null;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  await page.route('**/providers/claude/sessions', async (route: any) => {
    if (route.request().method() !== 'DELETE') {
      await route.continue();
      return;
    }
    await held;
    await route.continue();
  });

  const menu = await openRowMenu(page, 'branchy');
  await menu
    .locator('.lm-Menu-item', { hasText: 'Clean Up Parallel Sessions' })
    .first()
    .click();

  const dialog = page.locator('.jp-Dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });

  // The defect: the footer was hidden for the duration, so a request that
  // never returned left a modal with no keyboard or mouse way out.
  const close = dialog.locator('.jp-Dialog-footer button');
  await expect(close.first()).toBeVisible();
  await expect(close.first()).toBeEnabled();

  release!();

  // The dialog does NOT dismiss itself when the request lands - it swaps the
  // progress bar for the outcome and waits, which is why the button has to be
  // there. My first version of this test asserted it auto-hid; the run proved
  // otherwise, and the corrected assertion is the stronger one anyway: the way
  // out is only a way out if pressing it gets you out.
  await expect(dialog).toBeVisible();
  await close.first().click();
  await expect(dialog).toBeHidden({ timeout: 20000 });
});

test('DEF-57 - one tab stop per section, not one per row', async ({ page }) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  const panel = page.locator(PANEL);
  await expect(panel.locator('.jp-AiAssistantsPanel-row').first()).toBeVisible({
    timeout: 15000
  });

  const rows = await panel.locator('.jp-AiAssistantsPanel-row').count();
  const stops = await panel
    .locator('.jp-AiAssistantsPanel-row[tabindex="0"]')
    .count();
  // Sections that actually RENDER rows. A collapsed or empty section has no
  // row to be the stop, so counting every section would fail on a state that
  // is correct - and the point of this test is the ratio, not the total.
  const populated = await panel
    .locator('.jp-AiAssistantsPanel-section')
    .filter({ has: page.locator('.jp-AiAssistantsPanel-row') })
    .count();

  expect(rows).toBeGreaterThan(0);
  expect(populated).toBeGreaterThan(0);
  // Roving tabindex: the section is one stop, the arrows move within it. The
  // defect had every row a stop, so one project reachable in three sections
  // was three stops.
  expect(stops).toBe(populated);
  expect(stops).toBeLessThanOrEqual(rows);
});
