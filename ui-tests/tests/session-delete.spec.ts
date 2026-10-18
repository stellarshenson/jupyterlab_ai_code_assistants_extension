import * as fs from 'fs';
import * as path from 'path';

import { expect, test } from '@jupyterlab/galata';

import {
  openPanelTab,
  panelId,
  STATUS_URL,
  waitForApplication
} from './shared';

/**
 * Session deletion against the real stores, driven through the Manage
 * Sessions popup.
 *
 * `dispose_path` sends a conversation to the desktop trash when JupyterLab's
 * move-to-trash setting is on, and removes it permanently when the trash
 * refuses the move. The unit tier covers both branches with a stubbed
 * `send2trash`; these two scenarios prove the server, the route and the panel
 * agree end to end, and that the file really lands where the setting says.
 *
 * Each scenario owns its seeded project (`trash-fixture`, `fallback-fixture`)
 * so the mutated store cannot disturb another spec. The suite's scratch HOME
 * is the trash location: `send2trash` resolves `~/.local/share/Trash` there,
 * and blocking that path is how the fallback is forced without touching a
 * developer's trash.
 */
test.use({ autoGoto: false, waitForApplication });

const PORT = process.env.JLAB_TEST_PORT || '8888';
const SCRATCH =
  process.env.JLAB_TEST_SCRATCH || path.join(__dirname, '..', '.scratch', PORT);
const HOME = path.join(SCRATCH, 'home');
const PROJECTS = path.join(HOME, '.claude', 'projects');
const TRASH = path.join(HOME, '.local', 'share', 'Trash');

/** The Claude project directory holding one seeded fixture's transcripts. */
function projectDir(fixture: string): string {
  for (const name of fs.readdirSync(PROJECTS)) {
    const directory = path.join(PROJECTS, name);
    if (fs.existsSync(path.join(directory, `${fixture}-0.jsonl`))) {
      return directory;
    }
  }
  throw new Error(`seeded project ${fixture} not found under ${PROJECTS}`);
}

/** The trashinfo file whose Path names `target`, or null. */
function trashInfoFor(target: string): string | null {
  const info = path.join(TRASH, 'info');
  if (!fs.existsSync(info)) {
    return null;
  }
  for (const name of fs.readdirSync(info)) {
    const body = fs.readFileSync(path.join(info, name), 'utf8');
    if (body.split('\n').includes(`Path=${target}`)) {
      return name;
    }
  }
  return null;
}

/**
 * Put a regular file where the trash directory belongs, so send2trash raises,
 * and return the restore function. This is the no-usable-trash case the
 * fallback exists for, forced without touching any real trash.
 */
function blockTrash(): () => void {
  const existed = fs.existsSync(TRASH);
  if (existed) {
    fs.rmSync(TRASH, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(TRASH), { recursive: true });
  fs.writeFileSync(TRASH, 'not a directory');
  return () => {
    fs.rmSync(TRASH, { force: true });
    if (existed) {
      fs.mkdirSync(path.join(TRASH, 'files'), { recursive: true });
      fs.mkdirSync(path.join(TRASH, 'info'), { recursive: true });
    }
  };
}

/** Open the Manage Sessions popup for one seeded project's row. */
async function openManageSessions(page: any, fixture: string) {
  await page.goto();
  await openPanelTab(page, 'claude');
  const panel = page.locator(`#${panelId('claude')}`);
  const row = panel
    .locator('.jp-AiAssistantsPanel-row', { hasText: fixture })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click({ button: 'right' });
  const menu = page.locator('.lm-Menu.jp-AiAssistantsContextMenu').first();
  await expect(menu).toBeVisible({ timeout: 15000 });
  await menu
    .locator('.lm-Menu-itemLabel', { hasText: 'Open Branched Conversation' })
    .hover();
  const submenu = page.locator('.lm-Menu').last();
  await expect(
    submenu.locator('.lm-Menu-item[data-type="command"]').first()
  ).toBeVisible({ timeout: 10000 });
  await submenu
    .locator('.lm-Menu-item[data-type="command"]', {
      hasText: 'Manage Sessions'
    })
    .click();
  const popup = page.locator('.jp-AiAssistantsPanel-branchPopup');
  await expect(popup).toBeVisible({ timeout: 15000 });
  return popup;
}

/** Select the single deletable branch, arm Delete, and confirm it. */
async function deleteTheBranch(page: any, popup: any): Promise<void> {
  // Scoped to a branch row: the select-all checkbox sits outside one, and the
  // current row carries no checkbox at all.
  await popup
    .locator('.jp-AiAssistantsPanel-branchRow input[type="checkbox"]')
    .first()
    .check();
  const dialog = page.locator('.jp-Dialog');
  const del = dialog
    .locator('.jp-Dialog-footer')
    .locator('.jp-AiAssistantsPanel-branchDelete');
  await expect(del).toBeEnabled();
  // Every delete arms first: the trash setting does not promise the system
  // will accept the move, and a fallback removal is permanent.
  await del.click();
  await expect(del).toHaveText('Confirm delete 1');
  await del.click();
  // The completed request re-renders the list and reports the count in one
  // wording for both outcomes, because the client cannot know whether the
  // trash accepted the move. The filesystem assertions in each scenario
  // decide which outcome happened. Not a bare "1": updateControls writes
  // "1 selected" as soon as the checkbox is ticked, so that would match
  // while the delete is still in flight.
  await expect(
    dialog.locator('.jp-AiAssistantsPanel-branchSelCount')
  ).toHaveText('1 deleted', { timeout: 15000 });
}

test('delete moves the conversation to the desktop trash when the setting is on', async ({
  page
}) => {
  const status = await (await page.request.get(STATUS_URL)).json();
  expect(status.delete_to_trash).toBe(true);

  const directory = projectDir('trash-fixture');
  const transcript = path.join(directory, 'trash-fixture-0.jsonl');
  expect(fs.existsSync(transcript)).toBe(true);

  const popup = await openManageSessions(page, 'trash-fixture');
  await deleteTheBranch(page, popup);

  // Gone from the store, present in the trash, and the trash records where it
  // came from.
  expect(fs.existsSync(transcript)).toBe(false);
  expect(trashInfoFor(transcript)).not.toBeNull();
  // The current conversation is untouched.
  expect(fs.existsSync(path.join(directory, 'trash-fixture-1.jsonl'))).toBe(
    true
  );
});

test('delete removes the conversation when the trash refuses the move', async ({
  page
}) => {
  const status = await (await page.request.get(STATUS_URL)).json();
  expect(status.delete_to_trash).toBe(true);

  const directory = projectDir('fallback-fixture');
  const transcript = path.join(directory, 'fallback-fixture-0.jsonl');
  expect(fs.existsSync(transcript)).toBe(true);

  const restore = blockTrash();
  try {
    const popup = await openManageSessions(page, 'fallback-fixture');
    await deleteTheBranch(page, popup);

    expect(fs.existsSync(transcript)).toBe(false);
    expect(trashInfoFor(transcript)).toBeNull();
    expect(
      fs.existsSync(path.join(directory, 'fallback-fixture-1.jsonl'))
    ).toBe(true);
  } finally {
    restore();
  }
});
