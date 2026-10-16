import * as fs from 'fs';
import * as path from 'path';

import { expect, test } from '@jupyterlab/galata';

import { openPanelTab, panelId, waitForApplication } from './shared';

test.use({ autoGoto: false, waitForApplication });

/** The one conversation `jupyter_server_test_config.py` seeds for this spec
 * alone - a second Codex thread in `$CODEX_HOME/state_5.sqlite` whose cwd is a
 * real directory under the served root - and the row the panel draws for it.
 * The new name CONTAINS the seeded one, so this file's own locators keep
 * matching after a Playwright retry. */
const SEEDED_ROW = 'Codex renamable';
const SEEDED_SESSION = '22222222-2222-4222-8222-222222222222';
const RENAMED = 'Codex renamable renamed';

const ROUTE = '/jupyterlab-ai-code-assistants-extension/providers/codex';
const SESSIONS = `${ROUTE}/sessions`;
const RENAME = `${ROUTE}/rename`;

const MENU = '.lm-Menu.jp-AiAssistantsContextMenu';
const ITEM = 'Rename Session';

const shotPath = (name: string): string =>
  path.join(test.info().project.outputDir, 'screenshots', `${name}.png`);

/**
 * The Codex click path for Rename Session (DEF-PROV-301, ACC-CODE-206), with
 * nothing mockable between the dialog and the assistant's own store: the item
 * is really on a Codex row's context menu, the dialog's answer goes out as the
 * row's encoded path, conversation id and typed name, the panel redraws the
 * row under the new name with no reload, and the sessions route - a read of
 * `$CODEX_HOME/state_5.sqlite`, not an echo of the dialog - reports the same
 * name with `name_source` `session`.
 *
 * The store's write travels as the app-server method `thread/name/set`, so the
 * fixture's own transcript of that stdio channel (`native_cli_stub.py`
 * appends every request to `$JLAB_TEST_SCRATCH/native-cli.jsonl`) is asserted
 * too: it names the method ACC-CODE-206 is about, carrying this conversation
 * id and this name. Two things no assertion here can answer, stated plainly
 * rather than wished: the stub is not the real binary, so nothing below says
 * what the CLI's own interface would display on top of that sqlite write, and
 * the stub answers no read-back call at all - the transcript and the sessions
 * route are the two observable answers it does give. That fork speaks the
 * same channel is the store's own structure (one `_app_server` helper for
 * both verbs), pinned at the store tier, not a browser fact. The negative
 * clauses of ACC-CODE-206 - an empty name, an id outside the project, an
 * app-server refusal - stay at the route and store tiers that drive them
 * without a browser.
 */
test('a Codex row is renamed through its context menu and the new name lands in the store', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'codex');

  const panel = page.locator('#' + panelId('codex'));
  await expect(panel).toBeVisible();

  // The fixture, asserted rather than assumed: the row below claims the id
  // and the starting name the POST must carry.
  const listing = await page.request.get(SESSIONS);
  expect(listing.ok()).toBe(true);
  const seeded = (
    (await listing.json()).sessions as Array<Record<string, any>>
  ).find(row => String(row.project_path).endsWith('codex-renamable'));
  expect(seeded?.name).toBe(SEEDED_ROW);
  expect(seeded?.session_id).toBe(SEEDED_SESSION);

  // The click's own request, captured rather than assumed. The URL is matched
  // with the query string dropped: `ServerConnection` appends a cache-buster
  // timestamp to every call it makes (`.../rename?<ms>`), so matching the
  // full URL captures nothing (the same capture as `codex-reuse.spec.ts`).
  const renames: Array<Record<string, any>> = [];
  page.on('request', (request: any) => {
    if (
      request.method() === 'POST' &&
      request.url().split('?')[0].endsWith(RENAME)
    ) {
      renames.push(JSON.parse(request.postData() ?? '{}'));
    }
  });

  const seededRow = panel.locator('.jp-AiAssistantsPanel-row', {
    has: page.locator('.jp-AiAssistantsPanel-nameText', {
      hasText: new RegExp(`^${SEEDED_ROW}$`)
    })
  });
  await expect(seededRow.first()).toBeVisible({ timeout: 15000 });

  // The whole reason this spec exists: the Rename item renders on a CODEX
  // row. The menu builds it only while the descriptor says `canRename`, so a
  // timeout here is the defect this spec was written for - or a stale
  // installed frontend, never a locator to go hunting for.
  await seededRow.first().click({ button: 'right' });
  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();
  const item = menu.locator('.lm-Menu-item', { hasText: ITEM }).first();
  await expect(item).toBeVisible();
  await page.screenshot({ path: shotPath('codex-rename-menu') });

  await item.click();

  const dialog = page.locator('.jp-Dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('input').fill(RENAMED);
  await dialog.locator('.jp-Dialog-button.jp-mod-accept').click();
  await expect(dialog).toHaveCount(0);

  // What went out on the wire: the row's encoded project path, the seeded
  // conversation id, and the typed name - the exact body `RenameHandler`
  // validates before the store sees it.
  expect(renames).toHaveLength(1);
  expect(renames[0].session_id).toBe(SEEDED_SESSION);
  expect(renames[0].name).toBe(RENAMED);
  expect(String(renames[0].encoded_path)).toContain('codex-renamable');

  // The row carries the name the store now holds - no reload - and the seeded
  // name is drawn nowhere: the same row, re-labelled, not a second one.
  const renamedRow = panel
    .locator('.jp-AiAssistantsPanel-row', {
      has: page.locator('.jp-AiAssistantsPanel-nameText', {
        hasText: new RegExp(`^${RENAMED}$`)
      })
    })
    .first();
  await expect(renamedRow).toBeVisible({ timeout: 15000 });
  await expect(seededRow).toHaveCount(0);

  // And the sessions route reports the same pair: the name read back off
  // disk, with the source that says it came from the store's name field.
  const readBack = await (await page.request.get(SESSIONS)).json();
  const found = (readBack.sessions as Array<Record<string, any>>).find(
    (session: Record<string, any>) =>
      String(session.project_path).endsWith('codex-renamable')
  );
  expect([found?.name, found?.name_source]).toEqual([RENAMED, 'session']);

  // The transcript is written before the stub answers the request, so by the
  // time the route above has answered a fresh listing, the entry is on disk.
  const transcript = fs
    .readFileSync(
      path.join(String(process.env.JLAB_TEST_SCRATCH), 'native-cli.jsonl'),
      'utf-8'
    )
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, any>);
  const call = transcript
    .filter(
      entry =>
        entry.method === 'thread/name/set' &&
        entry.params?.threadId === SEEDED_SESSION
    )
    .pop();
  expect(call?.assistant).toBe('codex');
  expect(call?.params.name).toBe(RENAMED);

  await page.screenshot({ path: shotPath('codex-renamed') });
});
