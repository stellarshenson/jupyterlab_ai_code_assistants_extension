import * as fs from 'fs';
import * as path from 'path';

import { expect, test } from '@jupyterlab/galata';

import { openPanelTab, panelId, waitForApplication } from './shared';

/**
 * Two channels set a Claude tab's colour - `/color` in the conversation and a
 * pick on the terminal tab - and the newer one wins (DEF-COLO-306).
 *
 * The defect: Sky was picked on the tab, `/color orange` was run after it, and
 * the tab and the row stayed Sky - the pick sat on the top rung of the ladder
 * for good. The server now releases a stored pick older than the
 * conversation's newest `/color` run, and the panel's cache, which held the
 * pick, must let go of it within the normal refresh rather than paint it back.
 * Only a browser runs the whole chain: the store write, the transcript the
 * server judges, the panel's poll and cache reload, and the colourful-tab
 * extension's class on the tab.
 *
 * The fixture (`colour-newest` in `jupyter_server_test_config.py`) is this
 * spec's alone. Appending a `/color` record gives the conversation a newer
 * activity time, which sorts its row first, and two specs resolve their
 * subject as the first listed conversation - so the transcript is put back
 * byte for byte, mtime included, however this test ends.
 */

test.use({ autoGoto: false, waitForApplication });

const shotPath = (name: string): string =>
  path.join(test.info().project.outputDir, 'screenshots', `${name}.png`);

const PANEL = `#${panelId('claude')}`;
const SESSION = 'colour-newest-0';
const coloursUrl =
  '/jupyterlab-ai-code-assistants-extension/providers/claude/colours';
const sessionsUrl =
  '/jupyterlab-ai-code-assistants-extension/providers/claude/sessions';
/** The terminal tab the panel just opened - the current one in the main area. */
const CURRENT_TAB = '#jp-main-dock-panel .lm-TabBar-tab.lm-mod-current';

/** The fixture transcript, in the run's scratch Claude store. */
function transcriptPath(): string {
  const projects = path.join(
    String(process.env.JLAB_TEST_SCRATCH),
    'home',
    '.claude',
    'projects'
  );
  for (const dir of fs.readdirSync(projects)) {
    const candidate = path.join(projects, dir, `${SESSION}.jsonl`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`no seeded transcript for ${SESSION}`);
}

/** What one accepted `/color orange` appends, in Claude's own record shapes:
 * the colour, the command record whose timestamp says when it ran, and the
 * stdout record naming that command as its parent. The stdout is what says
 * Claude accepted the colour - a command record alone is also what a rejected
 * `/color` writes, and the server counts no run without the answer. */
function colorRun(when: Date): string {
  const commandUuid = `cmd-${when.getTime()}-orange`;
  return [
    { type: 'agent-color', agentColor: 'orange', sessionId: SESSION },
    {
      type: 'system',
      subtype: 'local_command',
      uuid: commandUuid,
      level: 'info',
      timestamp: when.toISOString(),
      content:
        '<command-name>/color</command-name>\n' +
        '            <command-message>color</command-message>\n' +
        '            <command-args>orange</command-args>'
    },
    {
      type: 'system',
      subtype: 'local_command',
      uuid: `out-${when.getTime()}-orange`,
      parentUuid: commandUuid,
      level: 'info',
      timestamp: when.toISOString(),
      content:
        '<local-command-stdout>Session color set to: orange</local-command-stdout>'
    }
  ]
    .map(record => JSON.stringify(record) + '\n')
    .join('');
}

async function setColour(page: any, colour: string | null): Promise<void> {
  const response = await page.request.post(coloursUrl, {
    data: { session_id: SESSION, colour, hand_set: true }
  });
  expect(response.ok()).toBe(true);
}

async function storedColours(page: any): Promise<Record<string, string>> {
  const response = await page.request.get(coloursUrl);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as any).colours;
}

async function rowColour(page: any): Promise<string | null | undefined> {
  const response = await page.request.get(sessionsUrl);
  expect(response.ok()).toBe(true);
  const rows = ((await response.json()) as any).sessions as any[];
  return rows.find(row => row.session_id === SESSION)?.colour;
}

test('a /color run after a tab pick takes the tab and the row back', async ({
  page
}) => {
  // The release waits on the panel's 30 s poll, so the waits below can add up
  // past the 60 s galata default by design - the budget is set to cover them.
  test.setTimeout(150000);
  const transcript = transcriptPath();
  const original = fs.readFileSync(transcript);
  const { atime, mtime } = fs.statSync(transcript);
  try {
    // The pick on the tab, stamped by the server as it is stored. Claude's own
    // colour is orange (`peach` as a tab colour), so Sky is a real divergence.
    await setColour(page, 'sky');

    await page.goto();
    await openPanelTab(page, 'claude');
    const row = page
      .locator(PANEL)
      .locator('.jp-AiAssistantsPanel-row', { hasText: 'colour-newest' })
      .first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.click();
    await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });

    // The pick stands while no `/color` follows it - and the panel's cache now
    // holds it, which is the state the defect painted from. The row menu runs
    // a colour pass now rather than at the loop's next tick.
    await row.click({ button: 'right' });
    const menu = page.locator('.lm-Menu');
    await expect(menu).toBeVisible();
    // On the menu itself, as in panel-regressions.spec.ts (DEF-GUARD-284).
    await menu.press('Escape');
    await expect(menu).toBeHidden();
    await expect(page.locator(CURRENT_TAB)).toHaveClass(
      /jp-colourful-tab-sky/,
      { timeout: 45000 }
    );
    expect(await storedColours(page)).toHaveProperty(SESSION, 'sky');

    // `/color orange`, run after the pick.
    fs.appendFileSync(transcript, colorRun(new Date()));

    // Within the panel's own refresh - its 30 s poll judges the row, reloads
    // the cache and repaints - with no action from the test to hurry it.
    await expect(page.locator(CURRENT_TAB)).toHaveClass(
      /jp-colourful-tab-peach/,
      { timeout: 75000 }
    );
    await expect(page.locator(CURRENT_TAB)).not.toHaveClass(
      /jp-colourful-tab-sky/
    );
    expect(await rowColour(page)).toBe('peach');
    // Released, not outranked: the store no longer holds the pick.
    expect(await storedColours(page)).not.toHaveProperty(SESSION);
    await page.screenshot({ path: shotPath('colour-newest-wins-peach') });
  } finally {
    fs.writeFileSync(transcript, original);
    fs.utimesSync(transcript, atime, mtime);
    await setColour(page, null);
  }
});
