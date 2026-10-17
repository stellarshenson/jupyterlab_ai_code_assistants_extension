import { expect, test } from '@jupyterlab/galata';

import {
  openPanelTab,
  panelId,
  terminalCount,
  waitForApplication
} from './shared';

test.use({ autoGoto: false, waitForApplication });

/**
 * The click's own feedback (DEF-PANE-318).
 *
 * A Branch Session click and a row click used to show nothing for seconds: the
 * branch spinner was raised only after the branch route answered, and the open
 * spinner only after the server had been asked about every live terminal. Both
 * routes are held open here, so only a spinner raised ON the click can be seen
 * before the answer arrives.
 */

const PANEL = `#${panelId('claude')}`;
const MENU = '.lm-Menu.jp-AiAssistantsContextMenu';
const SESSIONS =
  '/jupyterlab-ai-code-assistants-extension/providers/claude/sessions';
const BUSY = '.jp-AiAssistantsPanel-busyOverlay:not([hidden])';

/** Longer than the assertion deadline, so a spinner raised only when the
 * delayed route answers cannot pass. */
const HOLD_MS = 4000;
const SEEN_MS = 1500;

const BRANCH_ROUTE = /\/providers\/[^/]+\/branch(\?|$)/;
const PROBE_ROUTE = /\/providers\/[^/]+\/terminal\//;

/** The row whose name LINE reads exactly `name`. */
function row(page: any, name: string) {
  return page
    .locator(PANEL)
    .locator('.jp-AiAssistantsPanel-row', {
      has: page.locator('.jp-AiAssistantsPanel-nameText', {
        hasText: new RegExp(`^${name}$`)
      })
    })
    .first();
}

/** The current conversation's display name for the project ending in
 * `suffix`, off the listing route the panel itself reads. */
async function currentName(page: any, suffix: string): Promise<string> {
  const response = await page.request.get(SESSIONS);
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  const found = (payload.sessions as Array<Record<string, any>>).find(entry =>
    String(entry.project_path).endsWith(suffix)
  );
  expect(found).toBeTruthy();
  return found!.name;
}

/** Click Branch Session on the named row, flat or in its mode submenu. */
async function branchRow(page: any, name: string): Promise<void> {
  const target = row(page, name);
  await expect(target).toBeVisible({ timeout: 15000 });
  await target.click({ button: 'right' });

  const menu = page.locator(MENU).first();
  await expect(menu).toBeVisible({ timeout: 15000 });
  const flat = menu.locator('.lm-Menu-item[data-type="command"]', {
    hasText: /^Branch Session$/
  });
  if (await flat.count()) {
    await flat.click();
    return;
  }
  await menu
    .locator('.lm-Menu-itemLabel', { hasText: /^Branch Session$/ })
    .hover();
  const item = page
    .locator('.lm-Menu')
    .last()
    .locator('.lm-Menu-item[data-type="command"]', { hasText: /^Normal$/ });
  await expect(item).toBeVisible({ timeout: 10000 });
  await item.click();
}

test('a branch click shows the spinner before the branch route answers', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  // The announcement must not be painted: the shared sr-only rule is the only
  // thing hiding it, and jsdom applies no stylesheet.
  const live = page.locator(PANEL).locator('.jp-AiAssistantsPanel-srOnly');
  await expect(live).toHaveCSS('position', 'absolute');
  await expect(live).toHaveCSS('width', '1px');
  await expect(live).toHaveCSS('overflow', 'hidden');

  await page.route(BRANCH_ROUTE, async (route: any) => {
    await new Promise(resolve => setTimeout(resolve, HOLD_MS));
    await route.continue();
  });

  const parent = await currentName(page, 'spinner-fixture');
  await branchRow(page, parent);

  // While the branch route is unanswered. The old code raised nothing here.
  await expect(page.locator(PANEL).locator(BUSY)).toBeVisible({
    timeout: SEEN_MS
  });
  // The panel stays clickable while the action runs.
  await expect(
    page.locator(PANEL).locator('.jp-AiAssistantsPanel-busyOverlay')
  ).toHaveCSS('pointer-events', 'none');
  // The overlay box alone would pass visibility with nothing painted inside.
  const spinner = page
    .locator(PANEL)
    .locator('.jp-AiAssistantsPanel-busySpinner');
  await expect(spinner).toBeVisible({ timeout: SEEN_MS });
  await expect(spinner).toHaveCSS('border-top-style', 'solid');
  await expect(spinner).toHaveCSS('border-top-width', '3px');

  // And the branch still lands once the route answers, with the overlay gone.
  await expect
    .poll(() => currentName(page, 'spinner-fixture'), { timeout: 30000 })
    .not.toBe(parent);
  await expect(page.locator(PANEL).locator(BUSY)).toHaveCount(0, {
    timeout: 30000
  });
});

test('a row click shows the spinner before the terminal probe answers', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  // One live terminal for the probe to walk: open another project's row
  // first. The fixture's own row is clicked second, on a cold microcache.
  const first = await currentName(page, '/branchy');
  const before = await terminalCount(page);
  await row(page, first).click();
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => terminalCount(page)).toBe(before + 1);

  await page.route(PROBE_ROUTE, async (route: any) => {
    await new Promise(resolve => setTimeout(resolve, HOLD_MS));
    await route.continue();
  });

  const second = await currentName(page, 'spinner-fixture');
  await row(page, second).click();

  // While the probe of the live terminal is unanswered.
  await expect(page.locator(PANEL).locator(BUSY)).toBeVisible({
    timeout: SEEN_MS
  });

  // The probe answers with the other project's conversation, so the launch
  // runs and its terminal appears; the spinner is gone with it.
  await expect
    .poll(() => terminalCount(page), { timeout: 30000 })
    .toBe(before + 2);
  await expect(page.locator(PANEL).locator(BUSY)).toHaveCount(0);
});
