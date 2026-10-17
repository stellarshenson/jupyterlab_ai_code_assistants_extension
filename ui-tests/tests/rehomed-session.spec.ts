import { expect, test } from '@jupyterlab/galata';

import {
  openPanelTab,
  panelId,
  terminalCount,
  waitForApplication
} from './shared';

test.use({ autoGoto: false, waitForApplication });

/**
 * A conversation re-homed into a second project (DEF-PANE-319).
 *
 * Claude copies a transcript into the project directory it is resumed from and
 * keeps the session id, so two rows can name the same conversation in two
 * folders. The terminal reuse walk must not stop at the id: a terminal running
 * that conversation from the OTHER folder belongs to that folder, and this
 * click opens a terminal here.
 */

const PANEL = `#${panelId('claude')}`;
const BASE = '/jupyterlab-ai-code-assistants-extension/providers/claude';
const LAUNCH_ROUTE = /\/providers\/[^/]+\/launch(\?|$)/;

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

async function listing(page: any): Promise<Array<Record<string, any>>> {
  const response = await page.request.get(`${BASE}/sessions`);
  expect(response.ok()).toBe(true);
  return (await response.json()).sessions;
}

/** What the server says every live terminal is running. */
async function probes(page: any): Promise<Array<Record<string, any>>> {
  const listed = await page.request.get('/api/terminals');
  if (!listed.ok()) {
    return [];
  }
  const out: Array<Record<string, any>> = [];
  for (const entry of await listed.json()) {
    const response = await page.request.get(
      `${BASE}/terminal/${encodeURIComponent(entry.name)}`
    );
    if (response.ok()) {
      out.push(await response.json());
    }
  }
  return out;
}

/** Whether a probed terminal runs `sessionId` from inside `projectPath`. */
function holds(
  answers: Array<Record<string, any>>,
  sessionId: string,
  projectPath: string
): boolean {
  const root = String(projectPath).replace(/\/+$/, '');
  return answers.some(
    probe =>
      probe.session_id === sessionId &&
      (probe.cwds ?? []).some((cwd: string) => {
        const path = String(cwd).replace(/\/+$/, '');
        return path === root || path.startsWith(`${root}/`);
      })
  );
}

test('a re-homed conversation opens a terminal in its own folder', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  const rows = await listing(page);
  const branchy = rows.find(entry =>
    String(entry.project_path).endsWith('/branchy')
  );
  const rehomed = rows.find(entry =>
    String(entry.project_path).endsWith('/rehomed-fixture')
  );
  expect(branchy).toBeTruthy();
  expect(rehomed).toBeTruthy();
  // The two rows name one conversation: that is the re-homed shape.
  expect(rehomed!.session_id).toBe(branchy!.session_id);

  // Precondition: a live terminal runs it from `branchy`. A terminal left by
  // an earlier spec satisfies this too; the check is on the conversation and
  // cwd, not on who launched it.
  if (!holds(await probes(page), branchy!.session_id, branchy!.project_path)) {
    await row(page, 'branchy').click();
    await expect
      .poll(
        async () =>
          holds(await probes(page), branchy!.session_id, branchy!.project_path),
        { timeout: 30000 }
      )
      .toBe(true);
  }

  const launches: Array<Record<string, any>> = [];
  await page.route(LAUNCH_ROUTE, async (route: any) => {
    if (route.request().method() === 'POST') {
      try {
        launches.push(route.request().postDataJSON());
      } catch {
        // A body the test does not need.
      }
    }
    await route.continue();
  });

  const before = await terminalCount(page);
  await row(page, 'rehomed-fixture').click();

  // The click launches for THIS folder. Reusing `branchy`'s terminal would
  // leave this at zero and the terminal count unchanged.
  await expect.poll(() => launches.length, { timeout: 30000 }).toBe(1);
  expect(String(launches[0].project_path)).toMatch(/\/rehomed-fixture$/);
  await expect
    .poll(() => terminalCount(page), { timeout: 30000 })
    .toBe(before + 1);
});
