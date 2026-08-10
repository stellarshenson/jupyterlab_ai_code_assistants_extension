import { expect, test } from '@jupyterlab/galata';

import { openPanelTab, panelId, waitForApplication } from './shared';

/**
 * A tab colour the user sets by hand outranks the assistant's own colour, and
 * can be handed back.
 *
 * Claude is the one seeded assistant that HAS a colour concept of its own
 * (`/color`), and its colours used to be read-only here: the store refused
 * every write, so a colour set on the tab was painted over on the next
 * reconcile. Making the override win closes a door as well as opening one -
 * the companion extension's own Clear strips the tab's classes but not the
 * stored colour, which the next tab re-render puts back - so the release path
 * is a panel item, and it is driven here through the menu a user actually
 * clicks rather than through the route behind it.
 *
 * The seeded conversation carries an assistant-chosen colour, so "back to what
 * the assistant chose" is asserted against a real tint rather than against the
 * absence of one.
 */

test.use({ autoGoto: false, waitForApplication });

const PANEL = `#${panelId('claude')}`;
const MENU = '.lm-Menu.jp-AiAssistantsContextMenu';
const RESET = 'Reset Tab Colour';

/** The seeded project's `/color` tint, as claude's store maps it. */
const ASSISTANTS_OWN = 'sky';

const coloursUrl =
  '/jupyterlab-ai-code-assistants-extension/providers/claude/colours';
const sessionsUrl =
  '/jupyterlab-ai-code-assistants-extension/providers/claude/sessions';

/** The seeded conversation the panel shows as claude's current one. */
async function seededSession(page: any): Promise<{
  session_id: string;
  colour: string | null;
  encoded_path: string;
}> {
  const response = await page.request.get(sessionsUrl);
  expect(response.ok()).toBe(true);
  const rows = ((await response.json()) as any).sessions as any[];
  const row = rows.find(r => typeof r.session_id === 'string' && r.session_id);
  if (!row) {
    throw new Error('no seeded claude conversation to colour');
  }
  return {
    session_id: row.session_id,
    colour: row.colour ?? null,
    encoded_path: row.encoded_path
  };
}

/** A conversation of the same project that is NOT the current one - what
 * "Open Branched Conversation" launches a terminal for. */
async function otherBranch(page: any, encodedPath: string, current: string) {
  const response = await page.request.get(
    `${sessionsUrl.replace(/sessions$/, 'branches')}?encoded_path=${encodeURIComponent(encodedPath)}`
  );
  expect(response.ok()).toBe(true);
  const branches = ((await response.json()) as any).branches as any[];
  const other = branches.find(b => b.session_id && b.session_id !== current);
  if (!other) {
    throw new Error('seeded project has no second conversation');
  }
  return other.session_id as string;
}

/** The whole stored colour map, as all three verbs answer it. */
async function storedColours(page: any): Promise<Record<string, string>> {
  const response = await page.request.get(coloursUrl);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as any).colours;
}

/** Put a colour in the store the way the panel's write-back does, or with
 * `handSet` false the way a fork's inheritance does. Setup only - the
 * assertions below drive the UI. */
async function seedColour(
  page: any,
  sessionId: string,
  colour: string | null,
  handSet = true
): Promise<void> {
  const response = await page.request.post(coloursUrl, {
    data: { session_id: sessionId, colour, hand_set: handSet }
  });
  expect(response.ok()).toBe(true);
}

/** Right-click the seeded "branchy" row and return its context menu. */
async function openBranchyMenu(page: any) {
  await page.goto();
  await openPanelTab(page, 'claude');
  const panel = page.locator(PANEL);
  await expect(panel).toBeVisible();
  const row = panel
    .locator('.jp-AiAssistantsPanel-row', { hasText: 'branchy' })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click({ button: 'right' });
  const menu = page.locator(MENU).first();
  await expect(menu).toBeVisible({ timeout: 15000 });
  return menu;
}

test.afterEach(async ({ page }) => {
  // Never leave a conversation wearing an override - the next spec would see a
  // seeded project whose colour is not the assistant's.
  for (const id of Object.keys(await storedColours(page))) {
    await seedColour(page, id, null);
  }
  expect(await storedColours(page)).toEqual({});
});

test('Reset Tab Colour appears only once a colour has been set', async ({
  page
}) => {
  const { session_id } = await seededSession(page);

  const item = (await openBranchyMenu(page)).locator('.lm-Menu-itemLabel', {
    hasText: RESET
  });
  await expect(item).toBeHidden();

  await seedColour(page, session_id, 'mint');
  await expect(
    (await openBranchyMenu(page)).locator('.lm-Menu-itemLabel', {
      hasText: RESET
    })
  ).toBeVisible();
});

test('Reset Tab Colour hands the conversation back to the assistant', async ({
  page
}) => {
  const { session_id, colour } = await seededSession(page);
  // The row wears the assistant's own `/color` before anything is overridden.
  expect(colour).toEqual(ASSISTANTS_OWN);

  await seedColour(page, session_id, 'lavender');
  expect((await seededSession(page)).colour).toEqual('lavender');

  const menu = await openBranchyMenu(page);
  await menu.locator('.lm-Menu-itemLabel', { hasText: RESET }).click();

  // The stored override is gone and the row is back on `/color`, so the
  // release is reachable by pointer and not only over HTTP.
  await expect
    .poll(async () => (await storedColours(page))[session_id], {
      timeout: 15000
    })
    .toBeUndefined();
  expect((await seededSession(page)).colour).toEqual(ASSISTANTS_OWN);
});

test('a tint a branch inherited is left alone by the release', async ({
  page
}) => {
  // A fork is born wearing its parent's colour, written to the same store the
  // user's own colours live in. That tint is the branch's identity, not a
  // preference to take back: offering it here would let one click scatter
  // every fork of the project to an unrelated colour, permanently.
  const { session_id, encoded_path } = await seededSession(page);
  const branch = await otherBranch(page, encoded_path, session_id);
  await seedColour(page, branch, 'peach', false);

  const item = (await openBranchyMenu(page)).locator('.lm-Menu-itemLabel', {
    hasText: RESET
  });
  await expect(item).toBeHidden();

  // With a hand-set colour alongside it, the release names one target and the
  // inherited tint survives the click.
  await seedColour(page, session_id, 'lavender');
  const menu = await openBranchyMenu(page);
  await expect(
    menu.locator('.lm-Menu-itemLabel', { hasText: RESET })
  ).toHaveText('Reset Tab Colour (1)');
  await menu.locator('.lm-Menu-itemLabel', { hasText: RESET }).click();

  await expect
    .poll(async () => (await storedColours(page))[session_id], {
      timeout: 15000
    })
    .toBeUndefined();
  expect((await storedColours(page))[branch]).toEqual('peach');
});

test('the release names how many conversations it reaches', async ({
  page
}) => {
  const { session_id, encoded_path } = await seededSession(page);
  const branch = await otherBranch(page, encoded_path, session_id);
  await seedColour(page, session_id, 'lavender');
  await seedColour(page, branch, 'peach');

  const menu = await openBranchyMenu(page);
  // The conversations it reaches are not all on the row, so the count is the
  // only thing telling the user what one click will change.
  await expect(
    menu.locator('.lm-Menu-itemLabel', { hasText: RESET })
  ).toHaveText('Reset Tab Colours (2)');
  await menu.locator('.lm-Menu-itemLabel', { hasText: RESET }).click();

  await expect
    .poll(async () => Object.keys(await storedColours(page)).length, {
      timeout: 15000
    })
    .toEqual(0);
});

test('the release reaches a colour set on a branch, not just the current one', async ({
  page
}) => {
  // A terminal opened on a branch files its colour under THAT conversation,
  // while the row still represents the project's current one. Keying the item
  // on the row alone would leave the branch's colour unreachable - a one-way
  // door on an assistant whose `/color` would then never show again.
  const { session_id, encoded_path } = await seededSession(page);
  const branch = await otherBranch(page, encoded_path, session_id);
  await seedColour(page, branch, 'peach');

  const menu = await openBranchyMenu(page);
  await menu.locator('.lm-Menu-itemLabel', { hasText: RESET }).click();

  await expect
    .poll(async () => (await storedColours(page))[branch], { timeout: 15000 })
    .toBeUndefined();
});
