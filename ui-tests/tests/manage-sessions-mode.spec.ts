import { expect, test } from '@jupyterlab/galata';

import {
  openPanelTab,
  panelId,
  terminalCount,
  waitForApplication
} from './shared';

test.use({ autoGoto: false, waitForApplication });

/**
 * DEF-PANE-326: the Manage Sessions popup's row action follows the submenu
 * that opened it.
 *
 * Both branch submenus carry a `Manage Sessions...` item. The popup used to be
 * built with one fixed action, Open, whichever submenu invoked it, so the
 * switch submenu's copy launched a terminal instead of making the clicked
 * conversation current. Each entry point is driven here on the seeded
 * `branchy` project through the menu a user clicks:
 *
 * 1. Through `Switch and Manage Sessions` every non-current row offers
 *    `Switch`, the current row offers no action at all, and one click makes
 *    that conversation the project's current one with no terminal opened.
 * 2. Through `Open Branched Conversation` every row - the current one
 *    included - offers `Open`, and one click starts exactly one new terminal
 *    whose process answers the clicked conversation id.
 */

const PANEL = `#${panelId('claude')}`;
const MENU = '.lm-Menu.jp-AiAssistantsContextMenu';
const POPUP = '.jp-AiAssistantsPanel-branchPopup';
const DIALOG = '.jp-Dialog.jp-AiAssistantsPanel-branchDialog';
const ROW = '.jp-AiAssistantsPanel-branchRow';
const CURRENT_ROW = `${ROW}.jp-mod-current`;
// Every row button except the copy button: the action the invoking submenu
// chose. Deliberately not the `branchOpen` class, so the fix may rename that
// class without moving this spec off the button it means.
const ACTION = 'button:not(.jp-AiAssistantsPanel-branchCopy)';

const BASE = '/jupyterlab-ai-code-assistants-extension/providers/claude';
const SESSIONS = `${BASE}/sessions`;
const BRANCHES = `${BASE}/branches`;
const SWITCH = `${BASE}/switch`;
const TERMINAL = `${BASE}/terminal/`;

interface IBranchListing {
  current: string;
  branches: Array<{ session_id: string }>;
}

/** The project's pre-test current conversation, restored after the test. The
 * branchy fixture is shared with other spec files, which expect its seeded
 * conversation to still be the current one - a switch leaves a pin and a
 * future mtime behind. */
let branchy: { encoded_path: string; current: string } | null = null;

/** The branchy project's row, as the panel's own listing route reports it. */
async function branchySession(page: any): Promise<Record<string, any> | null> {
  const response = await page.request.get(SESSIONS);
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  const row = (payload.sessions as Array<Record<string, any>>).find(entry =>
    String(entry.project_path).endsWith('/branchy')
  );
  return row ?? null;
}

/** One project's conversations, newest first, with its current id. */
async function branchList(
  page: any,
  encodedPath: string
): Promise<IBranchListing> {
  const response = await page.request.get(
    `${BRANCHES}?encoded_path=${encodeURIComponent(encodedPath)}`
  );
  expect(response.ok()).toBe(true);
  const payload = (await response.json()) as IBranchListing;
  expect(payload.current).toBeTruthy();
  return payload;
}

/** The branchy project's row in the panel. */
function panelRow(page: any) {
  return page
    .locator(PANEL)
    .locator('.jp-AiAssistantsPanel-row', { hasText: 'branchy' })
    .first();
}

/** Right-click the branchy row and return its context menu. */
async function openBranchyMenu(page: any) {
  const row = panelRow(page);
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click({ button: 'right' });
  const menu = page.locator(MENU).first();
  await expect(menu).toBeVisible({ timeout: 15000 });
  return menu;
}

/**
 * Right-click the branchy row, hover the named branch submenu and click ITS
 * `Manage Sessions...` item. The two submenus hold items with the same label,
 * so the submenu is chosen by its parent's label and the item is then taken
 * from that submenu alone - never by scanning every menu on screen.
 */
async function openManageSessions(page: any, parent: RegExp) {
  const menu = await openBranchyMenu(page);
  await menu.locator('.lm-Menu-itemLabel', { hasText: parent }).hover();
  const submenu = page.locator('.lm-Menu').last();
  const item = submenu.locator('.lm-Menu-item[data-type="command"]', {
    hasText: /^Manage Sessions\.\.\./
  });
  await expect(item).toBeVisible({ timeout: 10000 });
  await item.click();
  const popup = page.locator(POPUP);
  await expect(popup).toBeVisible({ timeout: 15000 });
  return popup;
}

/** Close the popup if it is still on screen. A successful row action disposes
 * it already; making the state explicit keeps the second flow independent of
 * what the first one left behind. */
async function closePopup(page: any): Promise<void> {
  const dialog = page.locator(DIALOG);
  if ((await dialog.count()) === 0) {
    return;
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0, { timeout: 10000 });
}

/** One popup row, identified by the session id its tooltip carries. */
function popupRow(popup: any, sessionId: string) {
  return popup.locator(`${ROW}[title="Session id: ${sessionId}"]`);
}

/**
 * Assert the popup's whole row set and every row's action label.
 *
 * `currentAction` null means the current row must offer no action at all;
 * otherwise every row, the current one included, must carry that label.
 */
async function expectPopupRows(
  popup: any,
  current: string,
  branches: string[],
  action: string,
  currentAction: string | null
): Promise<void> {
  await expect(popup.locator(ROW)).toHaveCount(branches.length + 1);
  await expect(popup.locator(`${ROW}:not(.jp-mod-current)`)).toHaveCount(
    branches.length
  );

  const currentRow = popup.locator(CURRENT_ROW);
  await expect(currentRow).toHaveCount(1);
  await expect(currentRow).toHaveAttribute('title', `Session id: ${current}`);
  if (currentAction === null) {
    await expect(currentRow.locator(ACTION)).toHaveCount(0);
  } else {
    await expect(currentRow.locator(ACTION)).toHaveText(currentAction);
  }

  for (const id of branches) {
    const row = popupRow(popup, id);
    await expect(row).toHaveCount(1);
    await expect(row.locator(ACTION)).toHaveText(action);
  }

  // No row may hide behind a missing or extra button: every branch row has
  // one action, and the current row has one only in open mode.
  await expect(popup.locator(ACTION)).toHaveCount(
    branches.length + (currentAction === null ? 0 : 1)
  );
}

/** The names of the terminals the server is running. */
async function terminalNames(page: any): Promise<string[]> {
  const response = await page.request.get('/api/terminals');
  expect(response.ok()).toBe(true);
  const running = (await response.json()) as Array<Record<string, any>>;
  return running.map(entry => String(entry.name));
}

/** Whether a terminal that was not running before the click answers with
 * `sessionId` - the conversation its process actually holds. */
async function probeAnswers(
  page: any,
  sessionId: string,
  known: string[]
): Promise<boolean> {
  for (const name of await terminalNames(page)) {
    if (known.includes(name)) {
      continue;
    }
    const response = await page.request.get(
      TERMINAL + encodeURIComponent(name)
    );
    if (!response.ok()) {
      continue;
    }
    const payload = await response.json();
    if (payload.running === true && payload.session_id === sessionId) {
      return true;
    }
  }
  return false;
}

test.afterEach(async ({ page }) => {
  const fixture = branchy;
  branchy = null;
  if (!fixture) {
    return;
  }
  const now = await branchySession(page);
  if (!now || now.session_id === fixture.current) {
    return;
  }
  const response = await page.request.post(SWITCH, {
    data: {
      encoded_path: fixture.encoded_path,
      session_id: fixture.current
    }
  });
  expect(response.ok()).toBe(true);
});

test('Manage Sessions offers the action of the submenu that opened it', async ({
  page
}) => {
  test.setTimeout(120000);

  await page.goto();
  await openPanelTab(page, 'claude');

  const seeded = await branchySession(page);
  expect(seeded).toBeTruthy();
  const encodedPath = String(seeded!.encoded_path);
  const before = await branchList(page, encodedPath);
  branchy = { encoded_path: encodedPath, current: before.current };

  // Flow 1 - the switch submenu. Every non-current row offers Switch; the
  // row that is already current offers nothing to click.
  const switchBranches = before.branches.map(branch => branch.session_id);
  expect(switchBranches.length).toBeGreaterThan(0);
  const switchPopup = await openManageSessions(
    page,
    /^Switch and Manage Sessions/
  );
  await expectPopupRows(
    switchPopup,
    before.current,
    switchBranches,
    'Switch',
    null
  );

  const switchedTo = switchBranches[switchBranches.length - 1];
  const terminalsBefore = await terminalCount(page);
  await popupRow(switchPopup, switchedTo).locator(ACTION).click();

  // The popup closes and the project's current conversation is the clicked
  // one, as the listing route the panel renders reports it.
  await expect(page.locator(DIALOG)).toHaveCount(0, { timeout: 15000 });
  await expect
    .poll(async () => (await branchySession(page))?.session_id, {
      timeout: 30000
    })
    .toBe(switchedTo);
  // A switch moves the project's pointer and opens nothing: the terminal
  // count is exactly what it was.
  expect(await terminalCount(page)).toBe(terminalsBefore);

  // Flow 2 - the open submenu, on the same row and after closing any popup.
  await closePopup(page);
  const after = await branchList(page, encodedPath);
  expect(after.current).toBe(switchedTo);
  const openBranches = after.branches.map(branch => branch.session_id);
  expect(openBranches.length).toBeGreaterThan(0);
  const openPopup = await openManageSessions(
    page,
    /^Open Branched Conversation/
  );
  await expectPopupRows(openPopup, after.current, openBranches, 'Open', 'Open');

  const opened = openBranches[0];
  const knownNames = await terminalNames(page);
  const countBefore = await terminalCount(page);
  await popupRow(openPopup, opened).locator(ACTION).click();

  // The open launches one terminal - and only one - whose process answers
  // the conversation the row named.
  await expect(page.locator(DIALOG)).toHaveCount(0, { timeout: 15000 });
  await expect
    .poll(() => terminalCount(page), { timeout: 45000 })
    .toBe(countBefore + 1);
  await expect
    .poll(() => probeAnswers(page, opened, knownNames), { timeout: 45000 })
    .toBe(true);
});
