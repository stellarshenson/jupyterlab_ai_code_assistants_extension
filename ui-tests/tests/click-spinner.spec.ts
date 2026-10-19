import { expect, test } from '@jupyterlab/galata';

import {
  openPanelTab,
  panelId,
  terminalCount,
  waitForApplication
} from './shared';

test.use({ autoGoto: false, waitForApplication });

/**
 * The click's own feedback (DEF-PANE-318, DEF-PANE-318-1, DEF-PANE-324).
 *
 * A Branch Session click and a row click used to show nothing for seconds: the
 * branch spinner was raised only after the branch route answered, and the open
 * spinner only after the server had been asked about every live terminal. Both
 * routes are held open here, so only a spinner raised ON the click can be seen
 * before the answer arrives.
 *
 * The spinner must sit in the MAIN WORKING AREA, on the lab shell, the way the
 * launch spinner does - not inside the panel, where a hidden or scrolled panel
 * keeps it out of sight. Every scenario therefore asserts the overlay is not a
 * descendant of the panel, covers the viewport and takes no focus.
 *
 * The ring must show activity under both motion preferences: it turns
 * normally, and under prefers-reduced-motion it still turns, while the overlay
 * names the action in visible text, so the click still reads as busy
 * (DEF-PANE-324).
 */

const PANEL = `#${panelId('claude')}`;
const MENU = '.lm-Menu.jp-AiAssistantsContextMenu';
const SESSIONS =
  '/jupyterlab-ai-code-assistants-extension/providers/claude/sessions';
const BUSY = '.jp-AiAssistants-busyOverlay:not([hidden])';
// Every panel builds its own overlay at startup and leaves it hidden, so the
// spinner class alone matches one per provider. Scope it to the visible one.
const SPINNER = `${BUSY} .jp-AiAssistants-busySpinner`;

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

/** The overlay is on the shell, not inside the panel, and covers the window;
 * its ring and action label are centred as one group. Returns once all of
 * that holds. */
async function expectMainAreaOverlay(page: any): Promise<void> {
  // The panel does not contain it: this is the placement defect itself.
  await expect(page.locator(`${PANEL} ${BUSY}`)).toHaveCount(0);

  const viewport = page.viewportSize()!;
  const box = await page.locator(BUSY).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeLessThanOrEqual(1);
  expect(box!.y).toBeLessThanOrEqual(1);
  expect(box!.width).toBeGreaterThanOrEqual(viewport.width - 2);
  expect(box!.height).toBeGreaterThanOrEqual(viewport.height - 2);

  // The ring and its visible action label are one centred group; the ring
  // alone sits left of centre by half the label's width.
  const spinner = await page.locator(SPINNER).boundingBox();
  const label = await page
    .locator(`${BUSY} .jp-AiAssistants-busyLabel`)
    .boundingBox();
  expect(spinner).not.toBeNull();
  expect(label).not.toBeNull();
  const left = Math.min(spinner!.x, label!.x);
  const top = Math.min(spinner!.y, label!.y);
  const right = Math.max(spinner!.x + spinner!.width, label!.x + label!.width);
  const bottom = Math.max(
    spinner!.y + spinner!.height,
    label!.y + label!.height
  );
  expect(Math.abs((left + right) / 2 - viewport.width / 2)).toBeLessThan(8);
  expect(Math.abs((top + bottom) / 2 - viewport.height / 2)).toBeLessThan(8);

  // It never takes focus: the context menu that launched the action, and the
  // element the user was working in, must keep it.
  const focusedInside = await page.evaluate(
    () =>
      !!(
        document.activeElement &&
        (document.activeElement as HTMLElement).closest(
          '.jp-AiAssistants-busyOverlay'
        )
      )
  );
  expect(focusedInside).toBe(false);
  // And it is not a modal: no dialog is raised on the click.
  await expect(page.locator('.jp-Dialog')).toHaveCount(0);
}

test('a branch click shows the main-area spinner before the branch route answers', async ({
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
  await expect(page.locator(BUSY)).toBeVisible({ timeout: SEEN_MS });
  await expectMainAreaOverlay(page);
  // The panel stays clickable while the action runs.
  await expect(page.locator(BUSY)).toHaveCSS('pointer-events', 'none');
  // The overlay box alone would pass visibility with nothing painted inside.
  const spinner = page.locator(SPINNER);
  await expect(spinner).toBeVisible({ timeout: SEEN_MS });
  await expect(spinner).toHaveCSS('border-top-style', 'solid');
  await expect(spinner).toHaveCSS('border-top-width', '3px');
  await expect(spinner).toHaveCSS('animation-name', 'jp-ai-assistants-spin');
  // The action is named in sight, so the ring is never the only cue.
  await expect(page.locator(`${BUSY} .jp-AiAssistants-busyLabel`)).toHaveText(
    'Branching conversation'
  );

  // And the branch still lands once the route answers, with the overlay gone.
  await expect
    .poll(() => currentName(page, 'spinner-fixture'), { timeout: 30000 })
    .not.toBe(parent);
  await expect(page.locator(BUSY)).toHaveCount(0, { timeout: 30000 });
});

test('a row click shows the main-area spinner before the terminal probe answers', async ({
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
  await expect(page.locator(BUSY)).toBeVisible({ timeout: SEEN_MS });
  await expectMainAreaOverlay(page);

  // The probe answers with the other project's conversation, so the launch
  // runs and its terminal appears; the spinner is gone with it.
  await expect
    .poll(() => terminalCount(page), { timeout: 30000 })
    .toBe(before + 2);
  await expect(page.locator(BUSY)).toHaveCount(0);
});

test('a refused branch clears the main-area spinner and says what happened', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  await page.route(BRANCH_ROUTE, async (route: any) => {
    await new Promise(resolve => setTimeout(resolve, HOLD_MS));
    // A failed request, not an invented answer: the branch route is never
    // called, so nothing is minted and the panel reports the failure.
    await route.abort();
  });

  const parent = await currentName(page, 'spinner-fixture');
  const before = await terminalCount(page);
  await branchRow(page, parent);

  await expect(page.locator(BUSY)).toBeVisible({ timeout: SEEN_MS });
  await expectMainAreaOverlay(page);

  // The refusal clears the click's feedback, opens no terminal, and tells the
  // user in the panel's own banner.
  await expect(page.locator(BUSY)).toHaveCount(0, { timeout: 15000 });
  await expect.poll(() => terminalCount(page), { timeout: 15000 }).toBe(before);
  const banner = page.locator(PANEL).locator('.jp-AiAssistantsPanel-error');
  await expect(banner).toBeVisible({ timeout: 15000 });
  await expect(banner).toContainText('Could not branch this session');
});

test('a reduced-motion click still turns the ring and names the action in sight', async ({
  page
}) => {
  // What the browser reports for an OS with animation effects off. The
  // extension does not honour the preference: the ring turns regardless.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto();
  await openPanelTab(page, 'claude');

  await page.route(BRANCH_ROUTE, async (route: any) => {
    await new Promise(resolve => setTimeout(resolve, HOLD_MS));
    await route.abort();
  });

  const parent = await currentName(page, 'spinner-fixture');
  await branchRow(page, parent);

  await expect(page.locator(BUSY)).toBeVisible({ timeout: SEEN_MS });
  await expectMainAreaOverlay(page);
  const spinner = page.locator(SPINNER);
  await expect(spinner).toBeVisible({ timeout: SEEN_MS });

  // The ring turns under the emulated preference: no reduced-motion rule
  // stops the spin, and the arc keeps full opacity above the 3:1 non-text
  // minimum while it turns.
  await expect(spinner).toHaveCSS('animation-name', 'jp-ai-assistants-spin');
  const transform = await spinner.evaluate(
    (element: Element) => getComputedStyle(element).transform
  );
  expect(transform).not.toBe('none');
  await expect(spinner).toHaveCSS('opacity', '1');
  // The visible label carries the busy state alongside the motion.
  const label = page.locator(`${BUSY} .jp-AiAssistants-busyLabel`);
  await expect(label).toBeVisible({ timeout: SEEN_MS });
  await expect(label).toHaveText('Branching conversation');
  // Its own surface, so the theme's text colour stays readable over whatever
  // the main area shows - a dark terminal included.
  const background = await label.evaluate(
    (element: Element) => getComputedStyle(element).backgroundColor
  );
  expect(background).not.toBe('rgba(0, 0, 0, 0)');

  // And the overlay still clears when the request is refused.
  await expect(page.locator(BUSY)).toHaveCount(0, { timeout: 15000 });
  const banner = page.locator(PANEL).locator('.jp-AiAssistantsPanel-error');
  await expect(banner).toBeVisible({ timeout: 15000 });
});
