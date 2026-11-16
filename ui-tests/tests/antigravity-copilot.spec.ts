import * as fs from 'fs';
import * as path from 'path';

import { expect, test } from '@jupyterlab/galata';

import {
  fetchStatus,
  openPanelTab,
  panelId,
  shutdownTerminals,
  waitForApplication
} from './shared';

/**
 * Browser proof for the two assistants no standalone extension preceded:
 * Antigravity (`agy`) and Copilot (`copilot`). Neither CLI is installed where
 * this suite runs. `jupyter_server_test_config.py` puts a fake of each on PATH
 * (`native_cli_stub.py`), which appends its argv to
 * `$JLAB_TEST_SCRATCH/native-cli.jsonl` and writes the store entry the real
 * CLI writes, and seeds named conversations: one for Copilot, two for
 * Antigravity in agy 1.5.9's layout.
 *
 * What only a browser answers: which glyph the sidebar tab and the Launcher
 * tile draw in each theme, that a row click or the + button reaches a pty
 * running the assistant with the argv the criteria name, in the project
 * folder, and which label the Antigravity row draws. The
 * argv grammar and the store layout are pinned at the store tier.
 */
test.use({ autoGoto: false, waitForApplication });
// A launch answers a terminal already on the conversation (DEF-SERV-388), so
// each test starts with none and every click spawns the fake CLI afresh.
test.beforeEach(({ page }) => shutdownTerminals(page));

const PROVIDERS = {
  antigravity: {
    label: 'Antigravity',
    binary: 'agy',
    folder: 'agy-demo',
    row: 'Antigravity demo',
    session: '44444444-4444-4444-8444-444444444444',
    // The opening of the arch in antigravity.google/favicon.svg. Pinned here
    // rather than read from the descriptor, so a descriptor that drew other
    // art - the Gemini spark it was first proposed with - fails.
    mark: 'M89.6992 93.695C94.3659 97.195'
  },
  copilot: {
    label: 'Copilot',
    binary: 'copilot',
    folder: 'copilot-demo',
    row: 'Copilot demo',
    session: '33333333-3333-4333-8333-333333333333',
    // The opening of Primer Octicons `copilot-16`.
    mark: 'M7.998 15.035c-4.562 0-7.873-2.914-7.998-3.749'
  }
};
type ProviderId = keyof typeof PROVIDERS;

const CARDS = '.jp-LauncherCard[data-category="AI Assistants"]';
const NEW_BUTTON = 'button[title="New session in current folder"]';
const MENU = '.lm-Menu.jp-AiAssistantsContextMenu';
const ROUTE = '/jupyterlab-ai-code-assistants-extension/providers';
/** The panel lists sessions on a 30 s poll; a new row is due by the next. */
const NEXT_POLL = 40000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Gemini has no binary in the harness, so its glyph is copied in beside
 * Antigravity's from the provider source the build bundles. */
const GEMINI_SVG = /`(<svg[\s\S]*?<\/svg>)`/.exec(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'providers', 'gemini.ts'),
    'utf8'
  )
)![1];

const SCRATCH = String(process.env.JLAB_TEST_SCRATCH);
const CLI_LOG = path.join(SCRATCH, 'native-cli.jsonl');

const shotPath = (name: string): string =>
  path.join(test.info().project.outputDir, 'screenshots', `${name}.png`);

/** Every argv one fake binary has recorded, oldest first. */
function cliCalls(binary: string): string[][] {
  if (!fs.existsSync(CLI_LOG)) {
    return [];
  }
  return fs
    .readFileSync(CLI_LOG, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(entry => entry.assistant === binary && Array.isArray(entry.args))
    .map(entry => entry.args);
}

/** The terminal name of the current main-area widget, or null. */
async function currentTerminalName(page: any): Promise<string | null> {
  return page.evaluate(() => {
    const widget: any = (window as any).jupyterapp.shell.currentWidget;
    if (!widget || !widget.node.querySelector('.jp-Terminal')) {
      return null;
    }
    return widget.content?.session?.name ?? null;
  });
}

/** Ask the extension's own probe what one terminal is running: xterm paints
 * to a canvas, so the pty's process and cwd are read from /proc instead. */
async function probe(
  page: any,
  id: ProviderId,
  terminalName: string
): Promise<{ running: boolean; session_id: string | null; cwds: string[] }> {
  const response = await page.request.get(
    `${ROUTE}/${id}/terminal/${encodeURIComponent(terminalName)}`
  );
  expect(response.status()).toBe(200);
  return response.json();
}

/** The Antigravity row of one seeded folder, found by its path rather than its
 * name, which the rename and branch tests change. */
async function agyRow(page: any, folder: string): Promise<any> {
  const { root_dir } = await fetchStatus(page);
  return page.locator(
    `#${panelId('antigravity')} .jp-AiAssistantsPanel-row[data-encoded-path="${root_dir}/${folder}"]`
  );
}

/** What the sessions route lists for one Antigravity project. */
async function agyListed(
  page: any,
  folder: string
): Promise<Record<string, any> | undefined> {
  const { root_dir } = await fetchStatus(page);
  const listing = await page.request.get(`${ROUTE}/antigravity/sessions`);
  expect(listing.ok()).toBe(true);
  return ((await listing.json()).sessions as Array<Record<string, any>>).find(
    s => s.project_path === `${root_dir}/${folder}`
  );
}

/** The main-area tab of the terminal in front, once one is. */
async function terminalTab(page: any): Promise<any> {
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  await expect
    .poll(() => currentTerminalName(page), { timeout: 30000 })
    .not.toBeNull();
  const id = await page.evaluate(
    () => (window as any).jupyterapp.shell.currentWidget.id
  );
  return page.locator(`.lm-TabBar-tab[data-id="${id}"]`);
}

/** Empty the main area; JupyterLab opens its own Launcher in its place. */
async function resetToLauncher(page: any): Promise<void> {
  await page.evaluate(() => {
    const app = (window as any).jupyterapp;
    for (const widget of Array.from(app.shell.widgets('main')) as any[]) {
      widget.dispose();
    }
  });
  await page.locator('.jp-Launcher').waitFor({ state: 'visible' });
}

/**
 * The tab and the tile draw the assistant's own mark as one `jp-icon3` path,
 * in the light and the dark theme, with screenshots of tab, panel header and
 * tile in each. `besideGemini` copies the Gemini spark in next to the tab and
 * the tile before the screenshots, so the two can be told apart at 16px.
 */
async function checkGlyph(
  page: any,
  id: ProviderId,
  besideGemini: boolean
): Promise<void> {
  const { label, mark } = PROVIDERS[id];
  const tab = `.lm-TabBar-tab[data-id="${panelId(id)}"]`;
  const tabIcon = page.locator(`${tab} .lm-TabBar-tabIcon`);
  const tileIcon = page
    .locator(CARDS)
    .filter({ hasText: label })
    .locator('.jp-LauncherCard-icon');
  const paths = (
    scope: any
  ): Promise<Array<{ d: string; cls: string; fill: string }>> =>
    scope.locator('svg path').evaluateAll((nodes: Element[]) =>
      nodes.map(node => ({
        d: node.getAttribute('d') ?? '',
        cls: node.getAttribute('class') ?? '',
        fill: getComputedStyle(node).fill
      }))
    );

  await page.goto();
  const tileFills: string[] = [];
  for (const theme of ['Light', 'Dark']) {
    await page.theme.setTheme(`JupyterLab ${theme}`);
    await openPanelTab(page, id);
    await resetToLauncher(page);

    for (const icon of [tabIcon, tileIcon]) {
      const drawn = await paths(icon);
      expect(drawn).toHaveLength(1);
      expect(drawn[0].d.startsWith(mark), `${id} ${theme}: ${drawn[0].d}`).toBe(
        true
      );
      expect(drawn[0].cls).toBe('jp-icon3');
    }
    tileFills.push((await paths(tileIcon))[0].fill);

    if (besideGemini) {
      await page.evaluate(
        (args: { tab: string; label: string; svgstr: string }) => {
          const gemini = new DOMParser().parseFromString(
            args.svgstr,
            'image/svg+xml'
          ).documentElement;
          const tile = Array.from(
            document.querySelectorAll('.jp-LauncherCard')
          ).find(
            card =>
              card.querySelector('.jp-LauncherCard-label p')?.textContent ===
              args.label
          )!;
          for (const live of [document.querySelector(args.tab)!, tile]) {
            const copy = live.cloneNode(true) as HTMLElement;
            copy.classList.add('galata-gemini-copy');
            copy.classList.remove('lm-mod-current');
            copy.removeAttribute('data-id');
            const svg = copy.querySelector('svg')!;
            svg.setAttribute('viewBox', gemini.getAttribute('viewBox')!);
            svg.innerHTML = gemini.innerHTML;
            const name = copy.querySelector('.jp-LauncherCard-label p');
            if (name) {
              name.textContent = 'Gemini';
            }
            live.after(copy);
          }
        },
        {
          tab,
          label,
          svgstr: GEMINI_SVG
        }
      );
    }

    const shot = (part: string) => shotPath(`${id}-${part}-${theme}`);
    await page
      .locator('.jp-SideBar', { has: page.locator(tab) })
      .screenshot({ path: shot('tab') });
    await page
      .locator(`#${panelId(id)} .jp-AiAssistantsPanel-header`)
      .screenshot({ path: shot('header') });
    await page
      .locator('.jp-Launcher-section', {
        has: page.locator('.jp-Launcher-sectionTitle', {
          hasText: 'AI Assistants'
        })
      })
      .screenshot({ path: shot('tile') });

    await page.evaluate(() =>
      document.querySelectorAll('.galata-gemini-copy').forEach(n => n.remove())
    );
  }
  // `jp-icon3` hands the fill to the theme; a fixed colour reads the same in
  // both.
  expect(tileFills[0]).not.toBe(tileFills[1]);
}

/** Click the seeded row and answer with the argv the fake binary recorded and
 * what the probe reads off the terminal it runs in. */
async function resumeRow(page: any, id: ProviderId): Promise<string[][]> {
  const { binary, folder, row: rowName, session } = PROVIDERS[id];
  await page.goto();
  const status = await fetchStatus(page);
  await openPanelTab(page, id);
  const row = page.locator(`#${panelId(id)} .jp-AiAssistantsPanel-row`, {
    has: page.locator('.jp-AiAssistantsPanel-nameText', {
      hasText: new RegExp(`^${rowName}$`)
    })
  });
  await expect(row).toBeVisible({ timeout: 15000 });

  const seen = cliCalls(binary).length;
  await row.click();
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  await expect
    .poll(() => cliCalls(binary).length, { timeout: 30000 })
    .toBe(seen + 1);

  const name = (await currentTerminalName(page))!;
  await expect
    .poll(async () => (await probe(page, id, name)).session_id, {
      timeout: 30000
    })
    .toBe(session);
  expect((await probe(page, id, name)).cwds).toContain(
    `${status.root_dir}/${folder}`
  );
  return cliCalls(binary).slice(seen);
}

/** Start a new session with the + button in a folder with no conversation,
 * and answer with the argv the fake binary recorded once the probe reads its
 * process, and the locator of the folder's row. */
async function newSession(
  page: any,
  id: ProviderId,
  folder: string
): Promise<{
  argv: string[];
  projectPath: string;
  terminal: string;
  row: any;
}> {
  const { binary } = PROVIDERS[id];
  await page.goto();
  const status = await fetchStatus(page);
  await page.contents.createDirectory(folder);
  await page.filebrowser.openDirectory(folder);
  await openPanelTab(page, id);
  const panel = page.locator(`#${panelId(id)}`);
  const projectPath = `${status.root_dir}/${folder}`;
  const row = panel.locator(
    `.jp-AiAssistantsPanel-row[data-encoded-path="${projectPath}"]`
  );
  await expect(row).toHaveCount(0);

  const seen = cliCalls(binary).length;
  // One launch mode is on offer, so + drops the menu rather than launching.
  await panel.locator(NEW_BUTTON).click();
  await page
    .locator(MENU)
    .locator('.lm-Menu-itemLabel', { hasText: /^New session$/ })
    .click();
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  await expect
    .poll(() => cliCalls(binary).length, { timeout: 30000 })
    .toBe(seen + 1);

  const terminal = (await currentTerminalName(page))!;
  await expect
    .poll(async () => (await probe(page, id, terminal)).running, {
      timeout: 30000
    })
    .toBe(true);
  expect((await probe(page, id, terminal)).cwds).toContain(projectPath);
  return { argv: cliCalls(binary)[seen], projectPath, terminal, row };
}

/** The listing row of one project, or undefined. */
async function listed(
  page: any,
  id: ProviderId,
  projectPath: string
): Promise<Record<string, any> | undefined> {
  const listing = await page.request.get(`${ROUTE}/${id}/sessions`);
  expect(listing.ok()).toBe(true);
  return ((await listing.json()).sessions as Array<Record<string, any>>).find(
    s => s.project_path === projectPath
  );
}

test('ACC-AGY-243-GLYPH - the tab and the tile draw the Antigravity arch in light and dark, beside the Gemini spark', async ({
  page
}) => {
  await checkGlyph(page, 'antigravity', true);
});

test('ACC-COPIL-251-GLYPH - the tab and the tile draw the Copilot mark in light and dark', async ({
  page
}) => {
  await checkGlyph(page, 'copilot', false);
});

test('ACC-AGY-245-RESUME - a row click runs agy --conversation <id> in the project folder', async ({
  page
}) => {
  const argv = await resumeRow(page, 'antigravity');
  // Exactly this argv: never --continue, which picks the most recent.
  expect(argv).toEqual([['--conversation', PROVIDERS.antigravity.session]]);
});

test('ACC-AGY-246-NEW-SESSION - + runs plain agy in the folder, and its conversation lists as a row', async ({
  page
}) => {
  test.setTimeout(120000);
  const { argv, row } = await newSession(page, 'antigravity', 'agy-new');
  expect(argv).toEqual([]);
  await expect(row).toBeVisible({ timeout: NEXT_POLL });
  await page.screenshot({ path: shotPath('antigravity-new-session-row') });
});

test('ACC-AGY-244-STORE-SCAN - the row reads the title agy stored, never the <USER_REQUEST> its transcript wraps a prompt in', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'antigravity');
  const row = await agyRow(page, 'agy-demo');
  await expect(row.locator('.jp-AiAssistantsPanel-nameText')).toHaveText(
    PROVIDERS.antigravity.row,
    { timeout: 15000 }
  );
  await expect(
    page
      .locator(`#${panelId('antigravity')} .jp-AiAssistantsPanel-row`)
      .filter({ hasText: 'USER_REQUEST' })
  ).toHaveCount(0);
  await row.screenshot({ path: shotPath('antigravity-row') });
});

test('ACC-AGY-247-FORK - Branch lists the copy as the row, and opens it with agy --conversation <copy>', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'antigravity');
  const row = await agyRow(page, 'agy-branchable');
  await expect(row).toBeVisible({ timeout: 15000 });
  const parent = (await agyListed(page, 'agy-branchable'))!;
  const branchName = `${parent.name}_1`;

  const seen = cliCalls('agy').length;
  await row.click({ button: 'right' });
  await page
    .locator(MENU)
    .locator('.lm-Menu-itemLabel', { hasText: /^Branch Session$/ })
    .hover();
  await page
    .locator('.lm-Menu')
    .last()
    .locator('.lm-Menu-item[data-type="command"]', { hasText: /^Normal$/ })
    .click();
  await terminalTab(page);
  await expect
    .poll(() => cliCalls('agy').length, { timeout: 30000 })
    .toBe(seen + 1);
  const [flag, copy] = cliCalls('agy')[seen];
  expect(flag).toBe('--conversation');
  expect(copy).toMatch(UUID);
  expect(copy).not.toBe(parent.session_id);

  // agy writes no summaries row for the copy until it runs a turn, so the
  // copy is listed from the extension's own record of it.
  const listed = (await agyListed(page, 'agy-branchable'))!;
  expect([listed.session_id, listed.name, listed.extra_sessions]).toEqual([
    copy,
    branchName,
    parent.extra_sessions + 1
  ]);
  await expect(row.locator('.jp-AiAssistantsPanel-nameText')).toHaveText(
    branchName,
    { timeout: 15000 }
  );
  await page.screenshot({ path: shotPath('antigravity-branched') });
});

test('ACC-COPIL-254-RESUME - a row click runs copilot --session-id <uuid> in the project folder', async ({
  page
}) => {
  const argv = await resumeRow(page, 'copilot');
  // Exactly this argv: never --resume or --continue, which match by prefix,
  // name or recency.
  expect(argv).toEqual([['--session-id', PROVIDERS.copilot.session]]);
});

test('ACC-COPIL-255-NEW-SESSION - + runs copilot under a fresh --session-id, and the row carries that id', async ({
  page
}) => {
  test.setTimeout(120000);
  const { argv, projectPath, terminal, row } = await newSession(
    page,
    'copilot',
    'copilot-new'
  );
  expect(argv).toHaveLength(2);
  expect(argv[0]).toBe('--session-id');
  expect(argv[1]).toMatch(UUID);
  expect(argv[1]).not.toBe(PROVIDERS.copilot.session);
  expect((await probe(page, 'copilot', terminal)).session_id).toBe(argv[1]);

  // copilot hides an unnamed session until it has a message, and so does the
  // panel (DEF-PROV-399): the start wrote workspace.yaml and no events.
  const folder = path.join(
    SCRATCH,
    'home',
    '.copilot',
    'session-state',
    argv[1]
  );
  expect(fs.readdirSync(folder)).not.toContain('events.jsonl');
  expect(await listed(page, 'copilot', projectPath)).toBeUndefined();

  // The events a first prompt persists.
  fs.writeFileSync(
    path.join(folder, 'events.jsonl'),
    [
      {
        type: 'session.start',
        data: { sessionId: argv[1], context: { cwd: projectPath } }
      },
      { type: 'user.message', data: { content: 'first ask' } }
    ]
      .map(event => JSON.stringify(event) + '\n')
      .join('')
  );
  await expect(row).toBeVisible({ timeout: NEXT_POLL });
  await page.screenshot({ path: shotPath('copilot-new-session-row') });
  expect((await listed(page, 'copilot', projectPath))?.session_id).toBe(
    argv[1]
  );
});

test('ACC-COPIL-265-RUNNING - copilot --resume in a terminal the panel did not open is found by its in-use lock, and the row click focuses it', async ({
  page
}) => {
  const { folder, row: rowName, session } = PROVIDERS.copilot;
  await page.goto();
  const { root_dir } = await fetchStatus(page);
  await openPanelTab(page, 'copilot');
  const row = page.locator(`#${panelId('copilot')} .jp-AiAssistantsPanel-row`, {
    has: page.locator('.jp-AiAssistantsPanel-nameText', {
      hasText: new RegExp(`^${rowName}$`)
    })
  });
  await expect(row).toBeVisible({ timeout: 15000 });

  // No --session-id on this argv, so only the lock copilot writes names the
  // session (DEF-PROV-400).
  const seen = cliCalls('copilot').length;
  await page.evaluate(
    (args: { argv: string[]; cwd: string }) =>
      (window as any).jupyterapp.commands.execute(
        'basic-terminal:launch',
        args
      ),
    {
      argv: [path.join(SCRATCH, 'bin', 'copilot'), `--resume=${session}`],
      cwd: `${root_dir}/${folder}`
    }
  );
  await terminalTab(page);
  const name = (await currentTerminalName(page))!;
  await expect
    .poll(async () => (await probe(page, 'copilot', name)).session_id, {
      timeout: 30000
    })
    .toBe(session);
  expect(cliCalls('copilot').slice(seen)).toEqual([[`--resume=${session}`]]);

  await page.evaluate(() =>
    (window as any).jupyterapp.commands.execute('launcher:create')
  );
  await expect.poll(() => currentTerminalName(page)).toBeNull();
  await row.click();
  await expect
    .poll(() => currentTerminalName(page), { timeout: 30000 })
    .toBe(name);
  expect(cliCalls('copilot')).toHaveLength(seen + 1);
});
