import { expect, test } from '@jupyterlab/galata';

import {
  ABSENT,
  AVAILABLE,
  PLUGIN_ID,
  STATUS_URL,
  openPanelTab,
  panelId,
  setProviderEnabled,
  waitForApplication
} from './shared';

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

test('DEF-88 - the background-agent chip renders inside its row', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  // The seeded roster owns exactly this project's current conversation, so the
  // chip belongs to this row and to no other.
  const row = page
    .locator(PANEL)
    .locator('.jp-AiAssistantsPanel-row', { hasText: WIDE_NAME })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });

  const chip = row.locator('.jp-AiAssistantsPanel-bgBadge');
  await expect(chip).toHaveText('bg');
  await expect(chip).toBeVisible();

  // Same box comparison as DEF-41 above, and for the same reason: the chip is
  // the SECOND badge on the name line, so it is the one an ellipsising name
  // pushes out of the row first.
  const chipBox = await chip.boundingBox();
  const rowBox = await row.boundingBox();
  expect(chipBox).not.toBeNull();
  expect(rowBox).not.toBeNull();
  expect(chipBox!.width).toBeGreaterThan(0);
  expect(chipBox!.x).toBeGreaterThanOrEqual(rowBox!.x);
  expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(
    rowBox!.x + rowBox!.width + 1
  );
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

test('DEF-54 and DEF-112 - an approval-bypassing new-session button still wears +', async ({
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

  // Neutral before the mode is armed: the add glyph's plus path.
  await expect(newButton.locator('svg')).toHaveCount(1);
  const plus = 'svg path[d^="M19 13h-6"]';
  await expect(newButton.locator(plus)).toHaveCount(1);

  await setLaunchMode(page, 'claude', 'dangerouslySkipPermissions', true);

  // DEF-112: arming a mode repaints the TITLE (DEF-36) but never the glyph -
  // the shield marks the menu entries that skip approval, not the button
  // that offers or launches. The mode is still named on the button.
  await expect(newButton).toHaveAttribute('title', /Skip Permissions/, {
    timeout: 10000
  });
  await expect(newButton.locator('svg')).toHaveCount(1);
  await expect(newButton.locator(plus)).toHaveCount(1);

  await setLaunchMode(page, 'claude', 'dangerouslySkipPermissions', false);
});

test('DEF-115 - an armed launch mode leaves the + with no menu at all', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  const newButton = page
    .locator(`${PANEL} .jp-AiAssistantsPanel-header`)
    .locator('.jp-AiAssistantsPanel-iconButton')
    .first();

  // Unarmed, the same click drops the two-entry menu - which is what makes the
  // assertion below able to fail rather than pass by construction.
  await newButton.click();
  await expect(page.locator(MENU)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(MENU)).toBeHidden();

  await setLaunchMode(page, 'claude', 'dangerouslySkipPermissions', true);
  // The title is the panel's own acknowledgement that the setting arrived, so
  // the click below cannot race the settings round-trip.
  await expect(newButton).toHaveAttribute('title', /Skip Permissions/, {
    timeout: 10000
  });

  await newButton.click();

  // With the mode on, both menu entries build the same launch, so the menu is
  // one choice pretending to be two - the button launches instead. Lumino
  // attaches an opened menu synchronously inside the click handler, so a menu
  // that is not in the DOM here was never opened.
  await expect(page.locator(MENU)).toHaveCount(0);
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });

  await setLaunchMode(page, 'claude', 'dangerouslySkipPermissions', false);
});

test('DEF-40 and DEF-112 - the shield marks the skip-permissions menu entry', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  // The shield's rendered home is the menu entry, at its siblings' size -
  // identified by its path data ("M12 1L3 5..." - the Material shield)
  // because it paints in the same neutral `jp-icon3` as every other icon.
  const menu = await openRowMenu(page, 'branchy');
  const item = menu
    .locator('.lm-Menu-item', { hasText: 'Resume (Skip Permissions)' })
    .first();
  await expect(item).toBeVisible();
  const shield = item.locator('.lm-Menu-itemIcon svg path[d^="M12 1L3 5"]');
  await expect(shield).toHaveCount(1);

  // ...and at the size of its siblings, not smaller (DEF-40's size half).
  // Measured against a LIVE sibling in the same menu rather than a constant:
  // an absolute pixel floor is satisfied by the very 13x13 glyph this defect
  // was about, and the assertion could not fail.
  const glyphBox = await item.locator('.lm-Menu-itemIcon svg').boundingBox();
  const siblingBox = await menu
    .locator('.lm-Menu-item', { hasText: 'Open Terminal' })
    .first()
    .locator('.lm-Menu-itemIcon svg')
    .boundingBox();
  expect(glyphBox).not.toBeNull();
  expect(siblingBox).not.toBeNull();
  expect(glyphBox!.width).toBeGreaterThanOrEqual(siblingBox!.width);
  expect(glyphBox!.height).toBeGreaterThanOrEqual(siblingBox!.height);

  await page.keyboard.press('Escape');
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

test('DEF-117 - each wake event re-probes status on its own', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  // Counted only from here, after the panel is up, so the probes the page load
  // already made are not mistaken for a wake's.
  let probes = 0;
  page.on('request', (request: any) => {
    if (request.url().includes(STATUS_URL)) {
      probes += 1;
    }
  });

  // Separately, and this is the whole point: dispatched together, ONE listener
  // answering satisfies "something probed", so deleting the other would leave
  // this test green. Each dispatch is measured against the count taken
  // immediately before it, and each is asserted before the next goes out.
  const beforeVisible = probes;
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // The headless page is already `visible`, so the listener's state guard
  // passes rather than returning early.
  await expect
    .poll(() => probes, { timeout: 5000 })
    .toBeGreaterThan(beforeVisible);

  const beforeOnline = probes;
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
  });
  await expect
    .poll(() => probes, { timeout: 5000 })
    .toBeGreaterThan(beforeOnline);

  // How this fails: before the fix neither listener existed, so the next probe
  // was the 60s timer's and both polls ran out their five seconds. Polled
  // rather than slept because arriving in seconds instead of a minute IS the
  // fix. Each poll returns on the first request it sees, so the window in
  // which the 60s timer could satisfy an assertion by itself is the poll's own
  // few hundred milliseconds (DEF-120, logged).
});

test('DEF-121 - a stale failed probe cannot discard a newer roster', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  const warnings: string[] = [];
  page.on('console', (message: any) => {
    if (message.text().includes('status probe failed')) {
      warnings.push(message.text());
    }
  });

  // The first probe from here on is held open, never answered. This is the
  // wedged wake probe: a probe can outlive one issued after it, so verdicts do
  // not arrive in the order they were asked for.
  let held: any = null;
  let seen = 0;
  await page.route(`**${STATUS_URL}*`, async (route: any) => {
    seen += 1;
    if (seen === 1) {
      held = route; // deliberately unanswered - released at the end
      return;
    }
    await route.continue();
  });

  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
  });
  await expect.poll(() => seen, { timeout: 5000 }).toBeGreaterThan(0);

  // A second probe, issued later, answers normally with the real roster.
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => seen, { timeout: 5000 }).toBeGreaterThan(1);

  const tab = page.locator(`.lm-TabBar-tab[data-id="${panelId('claude')}"]`);
  await expect(tab).toBeVisible();

  // Now the wedged probe fails - the shape a client timeout takes. A failure
  // writes nothing, so there is no verdict to discard.
  await held.abort('failed');
  await expect
    .poll(() => warnings.length, { timeout: 10000 })
    .toBeGreaterThan(0);
  // The catch always warns before `reconcile` runs, which is what makes it
  // usable as a settle signal here.
  await page.waitForTimeout(1000);

  await expect(tab).toBeVisible();
  await expect(page.locator(PANEL)).toBeVisible();

  // How this fails: let a failed probe write `status = null` again and
  // `reconcile` reads that as every provider unavailable - both assertions
  // above find nothing, panels undocked while the server is healthy and
  // answered fifteen seconds ago. A failure writes nothing (DEF-132), so
  // there is no verdict to order against the roster.
});

test('DEF-132 - a failed activation probe does not cost the sidebar its panel', async ({
  page
}) => {
  // The first status probe of the page load fails - the shape a reload takes
  // while the server is still coming back. JupyterLab waits for activation
  // and then restores the sidebar tab it had open, but it does not wait for
  // a later probe: a panel that docks a minute late is one the layout has
  // already given up on, and the sidebar stays shut.
  let seen = 0;
  await page.route(`**${STATUS_URL}*`, async (route: any) => {
    seen += 1;
    if (seen === 1) {
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  await page.goto();
  await expect.poll(() => seen).toBeGreaterThan(0);

  // Unknown is not absent: with no roster yet, every enabled assistant is
  // docked at activation, well inside the 60 s the old code waited.
  for (const id of AVAILABLE) {
    await expect(
      page.locator(`.lm-TabBar-tab[data-id="${panelId(id)}"]`)
    ).toBeAttached({ timeout: 5000 });
  }
  // The honest cost, stated: an enabled assistant with no binary is docked
  // too, until the next probe answers and removes it.
  for (const id of ABSENT) {
    await expect(
      page.locator(`.lm-TabBar-tab[data-id="${panelId(id)}"]`)
    ).toBeAttached({ timeout: 5000 });
  }

  // How this fails: read a failed probe as "nothing installed" and nothing
  // docks - `0 of 4 assistant panel(s) docked`. The `waitForApplication`
  // fixture then reds inside `page.goto()` at 30 s waiting for the claude
  // tab; the ABSENT loop above is the only assertion the fixture does not
  // already make.
});

test('DEF-125 - the PATH warning re-arms once the binary comes back', async ({
  page
}) => {
  const id = ABSENT[0]; // gemini: no stub binary in jupyter_server_test_config.py
  const infos: string[] = [];
  page.on('console', (message: any) => {
    if (
      message.text().includes('was not found on the') &&
      message.text().includes(`"${id}"`)
    ) {
      infos.push(message.text());
    }
  });

  // The roster served to the page: the real one, with this provider's
  // availability under the test's control.
  let present = false;
  await page.route(`**${STATUS_URL}*`, async (route: any) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const provider of body.providers) {
      if (provider.id === id) {
        provider.available = present;
      }
    }
    await route.fulfill({ response, json: body });
  });

  await page.goto();

  // The warning only fires for a provider the user CHOSE to enable, so make
  // that choice explicitly - this is the `chosen` gate in reconcile.
  await setProviderEnabled(page, id, true);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => infos.length, { timeout: 10000 }).toBe(1);

  // The CLI is installed: the next roster reports it present, the panel docks.
  present = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(
    page.locator(`.lm-TabBar-tab[data-id="${panelId(id)}"]`)
  ).toBeAttached({ timeout: 10000 });

  // And it is removed again. This is a NEW absence and must warn on its own.
  present = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => infos.length, { timeout: 10000 }).toBe(2);

  // How this fails: delete the `warnedUnavailable.delete(id)` line in
  // `reconcile` and the set still holds the id from the first absence, so the
  // last poll runs its full ten seconds at infos=1 - which is the user
  // silently losing the only signal that a panel went because its binary did.
});
