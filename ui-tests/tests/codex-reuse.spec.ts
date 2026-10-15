import * as path from 'path';

import { expect, test } from '@jupyterlab/galata';

import {
  openPanelTab,
  panelId,
  terminalCount,
  waitForApplication
} from './shared';

test.use({ autoGoto: false, waitForApplication });

/** The one conversation `jupyter_server_test_config.py` seeds for Codex - a
 * thread in `$CODEX_HOME/state_5.sqlite` whose cwd is a real directory under
 * the served root - and the row the panel draws for it. */
const SEEDED_ROW = 'Codex branch';
const SEEDED_SESSION = '11111111-1111-4111-8111-111111111111';

const ROUTE = '/jupyterlab-ai-code-assistants-extension/providers/codex';
const SESSIONS = `${ROUTE}/sessions`;
const LAUNCH = `${ROUTE}/launch`;
const PROBE = `${ROUTE}/terminal/`;

const shotPath = (name: string): string =>
  path.join(test.info().project.outputDir, 'screenshots', `${name}.png`);

/**
 * The Codex half of the duplicate-terminal defect (DEF-PROV-300): clicking a
 * panel row whose conversation is already open must focus that terminal, not
 * start a second one.
 *
 * What only a browser can answer, and what this spec pins end to end: the
 * click launches exactly one terminal whose command line carries the row's
 * conversation id - read back off the running process by this extension's own
 * probe, the fact every reuse decision rests on - and a second click on the
 * same row leaves the terminal count unchanged, with the same terminal tab
 * current and its keyboard focus restored.
 *
 * Two things are deliberately not pinned here:
 *
 * - The reuse the second click exercises is the page's own microcache, the
 *   path a same-page click takes (the same shape as `deepseek.spec.ts`). The
 *   ladder's next step - the server probe answering for a terminal this page
 *   did not launch - cannot be reached from a fresh page: with no terminal
 *   widget the panel correctly launches instead. What IS proven about that
 *   step here is its precondition: for a live Codex pty the probe answers the
 *   row's id (the DeepSeek stub is an sh script the probe never confirms as
 *   the assistant, and cannot answer this way).
 * - Launching with NO conversation id - the app-server mint that is the other
 *   half of DEF-PROV-300's fix - has no browser flow here; its argv contract
 *   is pinned in `tests/test_native_branch.py` and the store unit tests.
 */
test('a Codex row whose conversation is already open is focused, not opened twice', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'codex');

  const panel = page.locator('#' + panelId('codex'));
  await expect(panel).toBeVisible();

  // The fixture, asserted rather than assumed: the row below claims the id
  // this spec probes for, and the click sends it as the wanted conversation.
  const listing = await page.request.get(SESSIONS);
  expect(listing.ok()).toBe(true);
  const seeded = (
    (await listing.json()).sessions as Array<Record<string, any>>
  ).find(row => String(row.project_path).endsWith('codex-branch'));
  expect(seeded?.name).toBe(SEEDED_ROW);
  expect(seeded?.session_id).toBe(SEEDED_SESSION);

  const row = panel
    .locator('.jp-AiAssistantsPanel-row', {
      has: page.locator('.jp-AiAssistantsPanel-nameText', {
        hasText: new RegExp(`^${SEEDED_ROW}$`)
      })
    })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });

  // The click's own requests, captured rather than assumed: which
  // conversation the first click asks for, and that the second click issues
  // no launch at all. The URL is matched with the query string dropped:
  // `ServerConnection` appends a cache-buster timestamp to every call it
  // makes (its default `cache: 'no-store'`), so the route arrives as
  // `.../launch?<ms>` - matching the full URL captures nothing.
  const launches: Array<Record<string, any>> = [];
  page.on('request', (request: any) => {
    if (
      request.method() === 'POST' &&
      request.url().split('?')[0].endsWith(LAUNCH)
    ) {
      launches.push(JSON.parse(request.postData() ?? '{}'));
    }
  });

  const before = await terminalCount(page);

  await row.click();
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => terminalCount(page)).toBe(before + 1);
  expect(launches).toHaveLength(1);
  expect(launches[0].session_id).toBe(SEEDED_SESSION);

  const widgetId = await page.evaluate(
    () => (window as any).jupyterapp.shell.currentWidget.id
  );
  const name = await currentTerminalName(page);
  expect(name).not.toBeNull();

  // xterm paints to a canvas, so what the pty runs cannot be read off the
  // DOM - the extension's own probe reads it from /proc instead. This answer
  // (a running Codex process whose command line carries the row's id) is what
  // makes the terminal the right one to reuse rather than a lookalike, and it
  // is polled because the pty's init waiter takes a moment before it execs
  // the assistant.
  await expect
    .poll(async () => (await probeCodex(page, name as string)).session_id, {
      timeout: 30000
    })
    .toBe(SEEDED_SESSION);

  // A Launcher takes the tab front, so "focused" below is a claim about the
  // second click restoring the terminal as the current, keyboard-focused
  // widget - not about a tab that was never left.
  await putLauncherInFront(page);
  expect(await currentTerminalName(page)).toBeNull();

  const launchesBefore = launches.length;
  await openPanelTab(page, 'codex');
  await row.click();

  // Reuse: the same widget is current again, no launch went out, and the
  // focus lands inside the terminal (the panel's own `focus` activates the
  // tab and hands the xterm the keyboard).
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).jupyterapp.shell.currentWidget?.id)
    )
    .toBe(widgetId);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.closest('.jp-Terminal') !== null
      )
    )
    .toBe(true);

  // The waits matter: a duplicate launched in parallel would land a moment
  // after the click, so the count is read again once it would have arrived.
  await page.waitForTimeout(1500);
  expect(await terminalCount(page)).toBe(before + 1);
  expect(await currentTerminalName(page)).toBe(name);
  expect(launches).toHaveLength(launchesBefore);
  expect((await probeCodex(page, name as string)).session_id).toBe(
    SEEDED_SESSION
  );

  await page.screenshot({ path: shotPath('codex-row-reuse') });
});

/** The terminal name of the current main-area widget, or null when the
 * current widget is not a terminal. */
async function currentTerminalName(page: any): Promise<string | null> {
  return page.evaluate(() => {
    const widget: any = (window as any).jupyterapp.shell.currentWidget;
    if (!widget || !widget.node.querySelector('.jp-Terminal')) {
      return null;
    }
    return widget.content?.session?.name ?? null;
  });
}

/** Bring a Launcher tab to the front without disposing anything, so the
 * terminal widget stays open underneath with the panel's microcache entry for
 * it intact. The default workspace already holds one, so it is activated
 * rather than created - `launcher:create` would open a second. */
async function putLauncherInFront(page: any): Promise<void> {
  await page.evaluate(async () => {
    const app = (window as any).jupyterapp;
    let launcher: any = null;
    for (const widget of Array.from(app.shell.widgets('main')) as any[]) {
      if (widget.node.querySelector('.jp-Launcher')) {
        launcher = widget;
        break;
      }
    }
    if (!launcher) {
      launcher = await app.commands.execute('launcher:create');
    }
    app.shell.activateById(launcher.id);
    (document.activeElement as HTMLElement | null)?.blur?.();
  });
  await page.locator('.jp-Launcher').first().waitFor({ state: 'visible' });
}

/** Ask the extension's own probe what one terminal is running. */
async function probeCodex(
  page: any,
  terminalName: string
): Promise<{ running: boolean; session_id: string | null; cwds: string[] }> {
  const response = await page.request.get(
    PROBE + encodeURIComponent(terminalName)
  );
  expect(response.status()).toBe(200);
  return response.json();
}
