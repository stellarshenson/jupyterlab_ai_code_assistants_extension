import * as fs from 'fs';
import * as path from 'path';

import { expect, test } from '@jupyterlab/galata';

import { openPanelTab, panelId, waitForApplication } from './shared';

test.use({ autoGoto: false, waitForApplication });

const shotPath = (name: string): string =>
  path.join(test.info().project.outputDir, 'screenshots', `${name}.png`);

const PANEL = `#${panelId('claude')}`;
const SESSIONS =
  '/jupyterlab-ai-code-assistants-extension/providers/claude/sessions';
const COLOURS =
  '/jupyterlab-ai-code-assistants-extension/providers/claude/colours';
const SWITCH =
  '/jupyterlab-ai-code-assistants-extension/providers/claude/switch';
const TERMINAL =
  '/jupyterlab-ai-code-assistants-extension/providers/claude/terminal/';
const CURRENT_TAB = '#jp-main-dock-panel .lm-TabBar-tab.lm-mod-current';

/**
 * The branchy project's transcript directory name, once this test has read the
 * seeded listing. `/clear` gives the replacement a transcript of its own, and
 * this test switches the project to it for the reopening below; the hook
 * removes that transcript again, so the pin is dangling and recency keeps the
 * seeded conversation current for every later spec file whose fixtures compare
 * against it.
 */
let branchyEncoding: string | null = null;

test.afterEach(async ({ page }) => {
  const encoding = branchyEncoding;
  branchyEncoding = null;
  if (!encoding) {
    return;
  }
  const directory = path.join(
    String(process.env.JLAB_TEST_SCRATCH),
    'home',
    '.claude',
    'projects',
    encoding
  );
  for (const file of fs.readdirSync(directory)) {
    if (!file.endsWith('.jsonl')) {
      continue;
    }
    const id = path.basename(file, '.jsonl');
    if (/^branch-[012]$/.test(id)) {
      continue;
    }
    await page.request
      .post(COLOURS, {
        data: { session_id: id, colour: null, hand_set: false }
      })
      .catch(() => undefined);
    fs.rmSync(path.join(directory, file), { force: true });
  }
});

/**
 * ACC-COLO-213: `/clear` keeps the conversation's effective colour.
 *
 * The pty survives `/clear`; only the conversation id it reports changes. The
 * colour pass sees the new id on the same terminal widget and records the
 * colour the widget was wearing as an inherited entry on the replacement - the
 * tab keeps painting it, the store maps the replacement to it, and reopening
 * the conversation the project now lists (the replacement) shows it.
 *
 * The fixture seeds the branchy project's current conversation with Claude's
 * own `/color blue`, which this extension reports as `sky`, and the stub moves
 * its pid file to a fresh id on `/clear` while writing a transcript for it.
 * The store only gains the colour on the colour loop's 30 s pass and the panel
 * row only moves on its own 30 s poll, so every step is polled and an explicit
 * refresh brings the row up to date before it is clicked.
 */
test('a /clear replacement inherits the cleared conversation colour', async ({
  page
}) => {
  // Two 30 s cadences (colour pass, panel poll) plus terminal startup and the
  // polls below. The default 60 s is shorter than one wait.
  test.setTimeout(300000);

  await page.goto();
  await openPanelTab(page, 'claude');
  const panel = page.locator(PANEL);
  await expect(panel).toBeVisible();

  // The branchy project's current conversation: its newest transcript, the
  // one seeded with the assistant's `/color blue`.
  const parent = await branchySession(page);
  expect(parent?.colour).toBe('sky');
  expect(parent?.session_id).toBeTruthy();
  expect(parent?.encoded_path).toBeTruthy();
  branchyEncoding = String(parent?.encoded_path);
  const parentId = String(parent?.session_id);

  const row = panel
    .locator('.jp-AiAssistantsPanel-row', { hasText: 'branchy' })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();

  // The widget the click focused, and the pty it runs: the probe reads the
  // pid file the stub writes, so this names the conversation the terminal
  // actually holds rather than the one the row asked for.
  await expect
    .poll(() => currentTerminalName(page), { timeout: 30000 })
    .not.toBeNull();
  const terminalName = (await currentTerminalName(page)) as string;
  await expect
    .poll(() => probeId(page, terminalName), { timeout: 30000 })
    .toBe(parentId);

  // The assistant's tint on the terminal's own tab. Waiting for the class also
  // guarantees the colour pass has recorded this widget's id and colour, which
  // is what the `/clear` inheritance reads.
  await expect(page.locator(CURRENT_TAB)).toHaveClass(/jp-colourful-tab-sky/, {
    timeout: 45000
  });
  const parentTabColour = await currentTabColour(page);
  expect(parentTabColour).toBe('sky');

  // Focus the terminal's own xterm input, then type the command. The hidden
  // helper textarea has no box, so it is focused directly rather than clicked;
  // Enter reaches the stub as a line because the pty is in canonical mode.
  await page.evaluate(() => {
    const widget: any = (window as any).jupyterapp.shell.currentWidget;
    const textarea = widget?.node?.querySelector('.xterm-helper-textarea');
    if (textarea instanceof HTMLElement) {
      textarea.focus();
    }
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.activeElement?.classList.contains('xterm-helper-textarea') ??
          false
      )
    )
    .toBe(true);
  await page.keyboard.type('/clear');
  await page.keyboard.press('Enter');

  // The stub rewrites its pid file; the same pty now answers a different id.
  await expect
    .poll(
      async () => {
        const id = await probeId(page, terminalName);
        return id && id !== parentId ? id : null;
      },
      { timeout: 45000 }
    )
    .not.toBeNull();
  const answered = await probeId(page, terminalName);
  expect(answered).not.toBeNull();
  expect(answered).not.toBe(parentId);
  const childId = answered as string;

  // One colour pass later, the replacement is mapped to the old tint. It is an
  // inherited entry, so the route's overrides list does not name it - there is
  // no hand-set choice to release.
  await expect
    .poll(async () => (await coloursPayload(page)).colours[childId] ?? null, {
      timeout: 45000
    })
    .toBe('sky');
  const after = await coloursPayload(page);
  expect(after.colours[childId]).toBe('sky');
  expect(after.overrides).not.toContain(childId);

  // Same widget, same tint: the tab never lost the colour across `/clear`.
  expect(await currentTabColour(page)).toBe(parentTabColour);

  // The click made the cleared conversation the project's current one
  // (DEF-PANE-349), so the replacement does not overtake it by recency: switch
  // to the replacement, as the panel's switch action does, so the row that
  // reopens the project names it. The row's own colour field is Claude's
  // transcript-recorded `/color`, which the replacement does not carry; its
  // colour is the store entry proved above.
  const switched = await page.request.post(SWITCH, {
    data: { encoded_path: branchyEncoding, session_id: childId }
  });
  expect(switched.ok()).toBe(true);
  expect((await switched.json()).current).toBe(childId);
  await expect
    .poll(() => branchySession(page).then(session => session?.session_id), {
      timeout: 30000
    })
    .toBe(childId);

  // Bring the panel's row onto that conversation before clicking it: the panel
  // polls every 30 s, and an explicit refresh is the deterministic path.
  const refresh = panel
    .locator('.jp-AiAssistantsPanel-header .jp-AiAssistantsPanel-iconButton')
    .last();
  await refresh.click();
  await expect(refresh).toHaveClass(/jp-mod-spinning/);
  await expect(refresh).not.toHaveClass(/jp-mod-spinning/, { timeout: 15000 });

  // Reopening focuses the terminal already running the replacement - not a
  // second launch - and that pty still answers the replacement's id.
  await row.click();
  await expect
    .poll(() => currentTerminalName(page), { timeout: 30000 })
    .toBe(terminalName);
  await expect
    .poll(() => probeId(page, terminalName), { timeout: 30000 })
    .toBe(childId);
  const reopened = await probe(page, terminalName);
  expect(reopened.session_id).toBe(childId);
  expect(reopened.colour).toBe('sky');

  await expect(page.locator(CURRENT_TAB)).toHaveClass(/jp-colourful-tab-sky/, {
    timeout: 45000
  });
  expect(await currentTabColour(page)).toBe(parentTabColour);
  await page.screenshot({ path: shotPath('clear-colour-inherited') });
});

/** The branchy project's listing row, as the panel's own route reports it. */
async function branchySession(
  page: any
): Promise<Record<string, any> | undefined> {
  const response = await page.request.get(SESSIONS);
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  return (payload.sessions as Array<Record<string, any>>).find(session =>
    String(session.project_path).endsWith('/branchy')
  );
}

/** The colours route's whole answer: stored entries and hand-set ids. */
async function coloursPayload(
  page: any
): Promise<{ colours: Record<string, string>; overrides: string[] }> {
  const response = await page.request.get(COLOURS);
  expect(response.ok()).toBe(true);
  return response.json();
}

/** The conversation id the pty behind `name` answers, or null while it does
 * not answer at all. */
async function probeId(page: any, name: string): Promise<string | null> {
  const response = await page.request.get(TERMINAL + encodeURIComponent(name));
  if (!response.ok()) {
    return null;
  }
  const payload = await response.json();
  if (!payload.running) {
    return null;
  }
  return payload.session_id ?? null;
}

/** The full terminal probe answer for `name`. */
async function probe(page: any, name: string): Promise<Record<string, any>> {
  const response = await page.request.get(TERMINAL + encodeURIComponent(name));
  expect(response.ok()).toBe(true);
  return response.json();
}

/** The session name of the current main-area terminal, or null when the
 * current widget is not a terminal. */
async function currentTerminalName(page: any): Promise<string | null> {
  return page.evaluate(() => {
    const widget: any = (window as any).jupyterapp.shell.currentWidget;
    const name = widget?.content?.session?.name;
    return typeof name === 'string' ? name : null;
  });
}

/** The colour token on the current main-area tab, or null when it carries
 * none. */
async function currentTabColour(page: any): Promise<string | null> {
  const className =
    (await page.locator(CURRENT_TAB).getAttribute('class')) ?? '';
  const match = className.match(/jp-colourful-tab-([a-z]+)/);
  return match ? match[1] : null;
}
