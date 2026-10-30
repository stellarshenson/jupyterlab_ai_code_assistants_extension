import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { expect, test } from '@jupyterlab/galata';

import {
  ABSENT,
  AVAILABLE,
  openPanelTab,
  panelId,
  waitForApplication
} from './shared';

/**
 * The `jupyterlab-ai-code-assistants` command line against the Galata server,
 * and what an open page shows of it: the server pushes every change a route
 * makes to every open window, so the page needs no reload and no poll.
 *
 * The command is the module the server package ships, run with the venv Python
 * the local gate recipe creates, or with the runner's own python3 under CI,
 * which creates no venv, and addressed by an explicit `--url`. Its runtime
 * directory is this server's own and no ambient token reaches it, so it can
 * address no other Jupyter server and carries no credential of the developer's.
 */
test.use({ autoGoto: false, waitForApplication });

const PORT = process.env.JLAB_TEST_PORT || '8888';
const SCRATCH =
  process.env.JLAB_TEST_SCRATCH || path.join(__dirname, '..', '.scratch', PORT);
const VENV_PYTHON = path.join(__dirname, '..', '.venv', 'bin', 'python');
const PYTHON =
  process.env.JLAB_TEST_PYTHON ||
  (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3');
const SHOTS = path.join(
  __dirname,
  '..',
  '..',
  'tmp',
  'workflows',
  'session-cli-client',
  'screenshots'
);
/** The project `jupyter_server_test_config.py` seeds for this file alone. */
const FIXTURE = 'cli-sync';
const ROW = '.jp-AiAssistantsPanel-row';
const MENU = '.lm-Menu.jp-AiAssistantsContextMenu';
const ALL = ".jp-AiAssistantsPanel-section[data-section='all']";
const EVENTS_PATH = '/jupyterlab-ai-code-assistants-extension/events';
const SESSIONS_PATH =
  '/jupyterlab-ai-code-assistants-extension/providers/claude/sessions';
const FAVOURITE_PATH =
  '/jupyterlab-ai-code-assistants-extension/providers/claude/favourite';

/** Run the command against the Galata server; answers its standard output. */
function cli(baseURL: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JUPYTER_RUNTIME_DIR: path.join(SCRATCH, 'runtime')
  };
  for (const name of [
    'JUPYTERLAB_AI_CODE_ASSISTANTS_TOKEN',
    'JUPYTERHUB_API_TOKEN',
    'JPY_API_TOKEN',
    'JUPYTER_TOKEN',
    'JUPYTERHUB_SERVICE_PREFIX'
  ]) {
    delete env[name];
  }
  return execFileSync(
    PYTHON,
    [
      '-m',
      'jupyterlab_ai_code_assistants_extension.cli',
      '--url',
      `${baseURL}/`,
      ...args
    ],
    { cwd: SCRATCH, env, encoding: 'utf-8', timeout: 60000 }
  );
}

/** Swallow the panels' 30 s sessions poll, counting each one armed. */
function swallowPolls(): void {
  const arm = window.setInterval.bind(window);
  (window as any).__polls = 0;
  (window as any).setInterval = (
    handler: TimerHandler,
    timeout?: number,
    ...args: any[]
  ) => {
    if (timeout === 30_000) {
      (window as any).__polls += 1;
      return 0;
    }
    return arm(handler, timeout, ...args);
  };
}

/** Mark the page, so a reload - which drops the mark - fails the test. */
const mark = (page: any): Promise<void> =>
  page.evaluate(() => {
    (window as any).__notReloaded = true;
  });
const marked = (page: any): Promise<boolean> =>
  page.evaluate(() => (window as any).__notReloaded === true);

test('ACC-CLI-227 - a rename made with the command shows in the open panel within a second, with no reload', async ({
  page,
  baseURL
}) => {
  // The panel's 30 s sessions poll is swallowed, so only the server's push
  // can bring the new name onto the page.
  await page.addInitScript(swallowPolls);
  const socket = page.waitForEvent('websocket', (ws: any) =>
    ws.url().includes('/jupyterlab-ai-code-assistants-extension/events')
  );
  await page.goto();
  await socket;
  await openPanelTab(page, 'claude');
  expect(await page.evaluate(() => (window as any).__polls)).toBeGreaterThan(0);
  const panel = page.locator(`#${panelId('claude')}`);
  await expect(panel.locator(ROW, { hasText: FIXTURE }).first()).toBeVisible({
    timeout: 15000
  });
  await mark(page);

  // New on every attempt, so a retry cannot pass on an earlier attempt's name.
  const renamed = `${FIXTURE} renamed ${Date.now()}`;
  cli(baseURL!, 'sessions', 'rename', `${FIXTURE}-0`, renamed, '-a', 'claude');

  const row = panel.locator(ROW, { hasText: renamed });
  await expect(row).toBeVisible({ timeout: 1000 });
  expect(await marked(page)).toBe(true);
  await row.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: path.join(SHOTS, 'acc-cli-227.png') });
});

test('ACC-CLI-228 - refresh docks the panel of a CLI installed after the page loaded and removes it again, with no reload', async ({
  page,
  baseURL
}) => {
  // No stub on the server's PATH, so no panel (`shared.ts`). Its binary is
  // named after its id, `gemini`.
  const [absent] = ABSENT;
  const stub = path.join(SCRATCH, 'bin', absent);
  const tab = page.locator(`.lm-TabBar-tab[data-id="${panelId(absent)}"]`);
  await page.goto();
  await expect(tab).toHaveCount(0);
  await mark(page);

  try {
    fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(cli(baseURL!, 'refresh')).toMatch(/pushed to [1-9]\d* open window/);

    await expect(tab).toBeAttached({ timeout: 5000 });
    await openPanelTab(page, absent);
    expect(await marked(page)).toBe(true);
    await page.screenshot({ path: path.join(SHOTS, 'acc-cli-228.png') });
  } finally {
    // Every later spec expects this assistant absent.
    fs.rmSync(stub, { force: true });
    cli(baseURL!, 'refresh');
  }

  await expect(tab).toHaveCount(0, { timeout: 5000 });
  expect(await marked(page)).toBe(true);
});

test('ACC-PANE-232 - each panel header reads the assistant name alone', async ({
  page
}) => {
  const names: Record<string, string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    deepseek: 'DeepSeek',
    kimi: 'Kimi Code'
  };
  expect(Object.keys(names).sort()).toEqual([...AVAILABLE].sort());
  await page.goto();

  for (const id of AVAILABLE) {
    await openPanelTab(page, id);
    const panel = page.locator(`#${panelId(id)}`);
    // `toHaveText` reads `textContent`, not the uppercase the header is drawn in.
    await expect(panel.locator('.jp-AiAssistantsPanel-title')).toHaveText(
      names[id]
    );
    // The sidebar tab's tooltip is the same caption.
    await expect(
      page.locator(`.lm-TabBar-tab[data-id="${panelId(id)}"]`)
    ).toHaveAttribute('title', names[id]);
    // A cold panel raises its loading veil over the header too, so the header
    // is read and captured once the veil has lifted.
    await expect(panel.locator('.jp-AiAssistantsPanel-loading')).toBeHidden();
    // Drawn in the light theme's text colour, at full opacity, with nothing
    // drawn over it: a faded or covered header fails here.
    expect(
      await panel.locator('.jp-AiAssistantsPanel-title').evaluate(el => {
        let opacity = 1;
        for (let node: Element | null = el; node; node = node.parentElement) {
          opacity *= Number(getComputedStyle(node).opacity);
        }
        const box = el.getBoundingClientRect();
        const top = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2
        );
        return {
          color: getComputedStyle(el).color,
          opacity,
          onTop: el.contains(top)
        };
      })
    ).toEqual({ color: 'rgba(0, 0, 0, 0.87)', opacity: 1, onTop: true });
    await panel
      .locator('.jp-AiAssistantsPanel-header')
      .screenshot({ path: path.join(SHOTS, `acc-pane-232-${id}.png`) });
  }
});

test('DEF-PANE-370 - a star set in one window re-reads that window once and reaches the other window', async ({
  page,
  baseURL
}) => {
  // No poll in either window, so every sessions read counted below is the
  // panel's own read after the write or a pushed change.
  await page.context().addInitScript(swallowPolls);
  const isRead = (request: any): boolean =>
    request.method() === 'GET' &&
    new URL(request.url()).pathname === SESSIONS_PATH;
  /** The sessions-changed pushes a page receives, in order. */
  const pushes = (target: any): any[] => {
    const seen: any[] = [];
    target.on('websocket', (ws: any) => {
      if (ws.url().includes(EVENTS_PATH)) {
        ws.on('framereceived', (frame: any) => {
          const message = JSON.parse(String(frame.payload));
          if (message.type === 'sessions-changed') {
            seen.push(message);
          }
        });
      }
    });
    return seen;
  };

  // The other window, loaded first so its socket is open before the star.
  const other = await page.context().newPage();
  const otherPushes = pushes(other);
  const otherSocket = other.waitForEvent('websocket', (ws: any) =>
    ws.url().includes(EVENTS_PATH)
  );
  // A workspace of its own: JupyterLab moves the second window to open the
  // default workspace to another one, which would navigate the page under test.
  await other.goto(`${baseURL}/lab/workspaces/def-pane-370`);
  await otherSocket;
  let otherReads = 0;
  other.on('request', (request: any) => {
    // Counted from its push on, so its own start-up reads cannot pass it.
    if (otherPushes.length > 0 && isRead(request)) {
      otherReads += 1;
    }
  });

  const ownPushes = pushes(page);
  await page.goto();
  await openPanelTab(page, 'claude');
  const panel = page.locator(`#${panelId('claude')}`);
  const row = panel.locator(ROW, { hasText: FIXTURE }).first();
  await expect(row).toBeVisible({ timeout: 15000 });

  let ownReads = 0;
  page.on('request', (request: any) => {
    if (isRead(request)) {
      ownReads += 1;
    }
  });
  const post = page.waitForRequest(
    (request: any) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === FAVOURITE_PATH
  );
  const answered = page.waitForResponse((response: any) =>
    isRead(response.request())
  );
  await row.click({ button: 'right' });
  await page
    .locator(`${MENU} .lm-Menu-item`, { hasText: 'Add to Favorites' })
    .first()
    .click();
  // The row the star is drawn on, marked before the read after the write
  // answers (the POST goes first).
  const starredRow = panel
    .locator(`${ALL} ${ROW}`, { hasText: FIXTURE })
    .first();
  await starredRow.evaluate((el: any) => {
    el.__starred = true;
  });
  try {
    const windowId = (await post).headers()['x-ai-assistants-window'];
    expect(windowId).toMatch(/^[0-9a-f-]{36}$/);

    // The push names the window that made the change, and both windows get it.
    const named = {
      type: 'sessions-changed',
      provider: 'claude',
      window: windowId
    };
    await expect.poll(() => ownPushes).toContainEqual(named);
    await expect.poll(() => otherPushes).toContainEqual(named);
    // The other window re-reads on it, with no reload.
    await expect.poll(() => otherReads).toBe(1);
    // This window reads once, after its write, and not again on its push.
    await expect.poll(() => ownReads).toBe(1);
    await answered;
    await page.waitForTimeout(500);
    expect(ownReads).toBe(1);
    // That read answered what the star drew, so the row was not redrawn.
    await expect(
      starredRow.locator('.jp-AiAssistantsPanel-favStar')
    ).toBeVisible();
    expect(await starredRow.evaluate((el: any) => el.__starred === true)).toBe(
      true
    );
  } finally {
    // One server serves the whole run; later specs expect no favourites.
    await row.click({ button: 'right' });
    await page
      .locator(`${MENU} .lm-Menu-item`, { hasText: 'Remove from Favorites' })
      .first()
      .click();
    await other.close();
  }
});
