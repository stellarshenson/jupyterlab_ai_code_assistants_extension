import * as path from 'path';

import { expect, test } from '@jupyterlab/galata';

import { openPanelTab, panelId, waitForApplication } from './shared';

test.use({ autoGoto: false, waitForApplication });

const shotPath = (name: string): string =>
  path.join(test.info().project.outputDir, 'screenshots', `${name}.png`);

const PANEL = `#${panelId('claude')}`;
const MENU = '.lm-Menu.jp-AiAssistantsContextMenu';
const SESSIONS =
  '/jupyterlab-ai-code-assistants-extension/providers/claude/sessions';
const TERMINAL =
  '/jupyterlab-ai-code-assistants-extension/providers/claude/terminal/';

/**
 * Branching a named conversation through the browser, on the native path.
 *
 * The server mints the branch (Claude's own `/rename` plus `/color` against a
 * forked session id), so unlike the `server-copy` strategies the flow asks the
 * user for nothing - the child is named `<parent>_<next free suffix>` from the
 * parent's name alone. What only a real browser can answer, and what this spec
 * pins: the row ends up wearing that server-minted name, the suffix allocator
 * skips names the project already uses, the second branch moves past the
 * first's suffix instead of reusing it, and the terminal the panel opens
 * resumes the child the server returned rather than the parent or nothing.
 *
 * The fixtures own both projects (`native-branch`, `manual-branch` in
 * `jupyter_server_test_config.py`), each holding three conversations titled
 * `_1`, `_3` and unsuffixed. The unsuffixed one is newest, so it is the row
 * the branch starts from, and the seeded `_1` makes a correct first branch
 * `_2` - an allocator that always numbered from one would collide with a
 * conversation that already exists.
 *
 * Not pinned here: what the two native CLI invocations carry (argv, the
 * `/color` name, the transcript rewrite) - those are unit contracts in
 * `tests/test_native_branch.py`; and the branch's tab tint as painted by the
 * colourful-tab extension, which is read from the server's own probe colour
 * below rather than from a canvas.
 */
test('a branch takes the parent name with the next free suffix, and twice gives successive ones', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  // The row that must be branched: the project's current conversation, titled
  // without a suffix. `sky` is its seeded `/color blue` as this extension
  // reports a tab tint.
  const parent = await sessionRow(page, '/native-branch');
  expect(parent?.name).toBe('Native branch');
  expect(parent?.colour).toBe('sky');

  await branchRow(page, 'Native branch');

  // `_2`, never `_1`: the allocator skips the suffix the project already has.
  await expect(row(page, 'Native branch_2')).toBeVisible({ timeout: 30000 });
  await expect
    .poll(() => sessionRow(page, '/native-branch').then(row => row?.name))
    .toBe('Native branch_2');

  // The row wearing the server-minted name. One row per project, so the
  // parent is not a second row beside it; the switch submenu (shot from
  // `switchTo` below) is where both names are on screen at once.
  await page.screenshot({ path: shotPath('panel-row-native-branch_2') });

  // The branch pins the child as the project's current conversation, so the
  // parent is reached through the switch submenu, which lists branches - and
  // the parent IS one now that the child is current.
  await switchTo(page, 'Native branch_2', /^Native branch \(/);
  await expect(row(page, 'Native branch')).toBeVisible({ timeout: 30000 });

  await branchRow(page, 'Native branch');

  // `_4`: `_2` is taken by the first branch. A suffix reused rather than
  // advanced would land back on `_2`, and on `_1` before either.
  await expect(row(page, 'Native branch_4')).toBeVisible({ timeout: 30000 });
  await expect
    .poll(() => sessionRow(page, '/native-branch').then(row => row?.name))
    .toBe('Native branch_4');
});

test('the branch opens a terminal on the returned child, carrying the parent colour', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  await branchRow(page, 'Manual branch');
  await expect(row(page, 'Manual branch_2')).toBeVisible({ timeout: 30000 });
  await expect
    .poll(() => sessionRow(page, '/manual-branch').then(row => row?.name))
    .toBe('Manual branch_2');

  const child = await sessionRow(page, '/manual-branch');
  expect(child?.session_id).toBeTruthy();
  // The child's own `/color`, written server-side from the parent's native
  // tint before the terminal opened - the same id the parent row carries.
  expect(child?.colour).toBe('sky');

  // The launched terminal resumes the child. Started as it is by the panel,
  // with no assertion on which terminal the user would see first: the probe
  // below is the extension's own way of asking which conversation a pty runs,
  // so a terminal answering the child's id is the proof the launch landed on
  // the id the branch route returned - not on the parent, and not on a new
  // conversation. It is polled because the pty's stub takes a moment to exec.
  await expect
    .poll(() => probeChild(page, child?.session_id), { timeout: 30000 })
    .not.toBeNull();
  const probe = await probeChild(page, child?.session_id);
  expect(probe.colour).toBe('sky');

  // The inherited tint on the terminal's own tab, as the colourful-tab
  // extension paints it. Opening the row's menu runs the panel's colour pass
  // (the menu build reconciles), which paints the tint now rather than at the
  // loop's next 30 s tick; the class is waited for, not assumed from the
  // probe above - the probe speaks for the server's record, not the tab.
  await row(page, 'Manual branch_2').click({ button: 'right' });
  await expect(page.locator(MENU).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.locator('.lm-TabBar-tab.jp-colourful-tab-sky').first()
  ).toBeVisible({ timeout: 45000 });
  await page.screenshot({ path: shotPath('branch-terminal-tab-sky') });
});

/** The row whose name LINE reads exactly `name`. The name node carries the
 * name alone - badges are siblings - and the anchor keeps "Native branch" from
 * also selecting "Native branch_2". */
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

/** One project's row off the listing route the panel itself reads. */
async function sessionRow(
  page: any,
  suffix: string
): Promise<Record<string, any> | undefined> {
  const response = await page.request.get(SESSIONS);
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  return (payload.sessions as Array<Record<string, any>>).find(row =>
    String(row.project_path).endsWith(suffix)
  );
}

/** Branch the named row through its context menu, and refuse a dialog.
 *
 * The branch item has two positions. Claude renders one launch mode (`Skip
 * Permissions`), so the item normally sits in the "Branch Session" submenu,
 * where the parent's title names the verb and the item names the mode - with
 * no mode in force, "Normal". A mode left on in settings is applied to the
 * plain item too, which suppresses the variant and flattens the item to the
 * top level wearing the full title; both layouts are handled.
 *
 * The dialog check is the "no name is typed" claim: the strategies that ask
 * open an `InputDialog` and wait, so the row would never rename - asserting no
 * dialog renders says the same thing at the moment it would have appeared. */
async function branchRow(page: any, name: string) {
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
  } else {
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

  await expect(page.locator('.jp-Dialog')).toHaveCount(0);
}

/** Point the named row back at another conversation, by the label prefix its
 * switch-submenu entry wears: the branch's own display name, which for the
 * seeded parent is `Native branch (native-b) - <time ago>`. */
async function switchTo(page: any, name: string, label: RegExp) {
  const target = row(page, name);
  await expect(target).toBeVisible({ timeout: 15000 });
  await target.click({ button: 'right' });

  const menu = page.locator(MENU).first();
  await expect(menu).toBeVisible({ timeout: 15000 });
  await menu
    .locator('.lm-Menu-itemLabel', { hasText: /^Switch and Manage Sessions/ })
    .hover();

  const item = page
    .locator('.lm-Menu')
    .last()
    .locator('.lm-Menu-item[data-type="command"]', { hasText: label });
  await expect(item.first()).toBeVisible({ timeout: 10000 });
  // Both names at once: the child is the row the menu was opened on, the
  // parent is this entry.
  await page.screenshot({ path: shotPath('switch-menu-parent-entry') });
  await item.first().click();
}

/** The live terminal whose pty runs `sessionId`, as the panel's own probe
 * answers it, or null while the pty's assistant has not exec'd yet. */
async function probeChild(
  page: any,
  sessionId: string | undefined
): Promise<Record<string, any> | null> {
  if (!sessionId) {
    return null;
  }
  const response = await page.request.get('/api/terminals');
  if (!response.ok()) {
    return null;
  }
  for (const terminal of (await response.json()) as Array<{ name: string }>) {
    const probed = await page.request.get(TERMINAL + terminal.name);
    if (!probed.ok()) {
      continue;
    }
    const payload = await probed.json();
    if (payload.running && payload.session_id === sessionId) {
      return payload;
    }
  }
  return null;
}
