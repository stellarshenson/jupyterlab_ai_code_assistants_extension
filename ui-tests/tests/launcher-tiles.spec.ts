import * as path from 'path';

import { expect, test } from '@jupyterlab/galata';

import {
  AVAILABLE,
  fetchStatus,
  setProviderEnabled,
  waitForApplication
} from './shared';

/**
 * Rendered proof for the Launcher tiles (ACC-LNCH-143..159, ACC-TEST-160).
 *
 * The unit tier already owns the click path's branches under jsdom, with the
 * launcher, the sessions listing and the sibling command all stubbed. What it
 * cannot answer is whether the real `@jupyterlab/launcher` builds the section
 * where the design says it does, whether a settings toggle repaints an open
 * Launcher, and - the half a mocked test can never reach - whether a click
 * actually reaches a pty and back through a terminal widget.
 *
 * So the click-through tests here mock nothing: the harness stubs the
 * assistant binaries onto PATH (`jupyter_server_test_config.py`), a click goes
 * panel -> `launch-argv` route -> `basic-terminal:launch` -> the sibling's own
 * route -> pty -> JupyterLab terminal widget, and the extension's own terminal
 * probe is then asked what that pty is running.
 */
/**
 * `terminals: null` turns OFF Galata's mock of the terminals API, and the
 * click-through tests cannot run without it. The mock answers an in-page
 * `GET /api/terminals` from a map it fills only from POSTs it saw to
 * `/api/terminals` itself - so a terminal born through a custom route
 * (`basic-terminal:launch` posts to the sibling's own endpoint) is invisible to
 * the page while being perfectly alive on the server. The sibling verifies its
 * new terminal is running before opening it, reads the mocked empty list, and
 * fails every launch with "exited before it could be displayed". The other
 * specs never hit this because the panel's launch path never lists terminals.
 */
test.use({ autoGoto: false, waitForApplication, terminals: null });

const CATEGORY = 'AI Assistants';
/** Cards this extension contributed, in the Launcher's own render order. */
const CARDS = `.jp-LauncherCard[data-category="${CATEGORY}"]`;
const SECTION_TITLE = '.jp-Launcher-sectionTitle';
/** The seeded Claude project and the conversation a resume must land on: the
 * newest of `branchy`'s three, per `jupyter_server_test_config.py`. */
const SEEDED_FOLDER = 'branchy';
const SEEDED_SESSION = 'branch-2';
/** A folder with no conversation for any provider, created per run. */
const FRESH_FOLDER = 'launcher-fresh';
/** The command that owns the spawn, and the sibling package that registers it. */
const SIBLING_COMMAND = 'basic-terminal:launch';
const SIBLING_ROUTE = '/jupyterlab-basic-terminal-extension/launch-terminal';
const PROBE_ROUTE = '/jupyterlab-ai-code-assistants-extension/providers';

/** Screenshots land beside the run's other artefacts, in the port-keyed
 * `test-results/<port>` the config already owns and sweeps. */
const shotPath = (name: string): string =>
  path.join(test.info().project.outputDir, 'screenshots', `${name}.png`);

/** Labels of this extension's tiles, top to bottom. */
async function tileLabels(page: any): Promise<string[]> {
  return page.locator(`${CARDS} .jp-LauncherCard-label p`).allTextContents();
}

/** Section headers of the open Launcher, top to bottom. */
async function sectionTitles(page: any): Promise<string[]> {
  return page.locator(SECTION_TITLE).allTextContents();
}

/**
 * Empty the main area and hand back the Launcher JupyterLab opens in its
 * place.
 *
 * Deliberately not `launcher:create`: the launcher-extension re-runs that
 * command itself whenever the main area empties, so disposing everything
 * yields exactly one Launcher, and it is the application's own - with the file
 * browser's path as its `cwd`, which is the value a tile click carries.
 */
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
 * Open one more Launcher without touching what is already in the main area -
 * the state a reuse click has to be measured in, because the terminal opened
 * by the previous click must stay open for the panel's tracker to find it.
 */
async function addLauncher(page: any): Promise<void> {
  await page.evaluate(async () => {
    // No `cwd` argument: the launcher-extension falls back to the default file
    // browser's path, so the click carries the folder the user is looking at.
    await (window as any).jupyterapp.commands.execute('launcher:create');
  });
  await page.locator('.jp-Launcher').waitFor({ state: 'visible' });
}

/** Click one provider's tile by its label. */
async function clickTile(page: any, label: string): Promise<void> {
  await page.locator(CARDS).filter({ hasText: label }).first().click();
}

/** How many terminals the server is running. */
async function terminalCount(page: any): Promise<number> {
  const running = (await (
    await page.request.get('/api/terminals')
  ).json()) as unknown[];
  return running.length;
}

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

/** Ask the extension what a terminal is running, for one provider. */
async function probeTerminal(
  page: any,
  providerId: string,
  terminalName: string
): Promise<{
  running: boolean;
  session_id: string | null;
  cwds: string[];
}> {
  const response = await page.request.get(
    `${PROBE_ROUTE}/${providerId}/terminal/${terminalName}`
  );
  expect(response.status()).toBe(200);
  return response.json();
}

test('ACC-LNCH-143 - one tile per available assistant, under AI Assistants', async ({
  page
}) => {
  await page.goto();

  // The expectation is the SERVER's roster, not a constant: a provider whose
  // binary the test config stopped stubbing must change this test's subject
  // rather than leave it asserting against a list nobody updated.
  const status = await fetchStatus(page);
  const available = status.providers.filter(p => p.available);
  expect(available.map(p => p.id)).toEqual(AVAILABLE);

  await resetToLauncher(page);

  await expect(page.locator(SECTION_TITLE, { hasText: CATEGORY })).toHaveCount(
    1
  );
  // Label for label, in the roster's order. This is NOT a proof of the tile
  // RANK (ACC-LNCH-158): the three available assistants happen to read the
  // same alphabetically as they do in the registry barrel, so the unit tier
  // owns that claim and this one only says the right tiles are here.
  expect(await tileLabels(page)).toEqual(available.map(p => p.label));

  // Each tile carries the provider icon the descriptor names - the Launcher
  // renders a LabIcon into the card, so an unresolved icon leaves no svg.
  const cards = page.locator(CARDS);
  await expect(cards).toHaveCount(available.length);
  for (let i = 0; i < available.length; i++) {
    await expect(cards.nth(i).locator('.jp-LauncherCard-icon svg')).toHaveCount(
      1
    );
  }

  await page
    .locator(SECTION_TITLE, { hasText: CATEGORY })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: shotPath('launcher-ai-assistants-section') });
});

test('ACC-LNCH-163 - the section header carries the joint icon, not a tile icon', async ({
  page
}) => {
  await page.goto();
  await resetToLauncher(page);

  // The Launcher draws a header with its first tile's command icon; this
  // extension's tile icon is a view that answers the header with the joint
  // icon instead, so the header svg matches none of the tiles' svgs.
  const section = page.locator('.jp-Launcher-section', {
    has: page.locator(SECTION_TITLE, { hasText: CATEGORY })
  });
  const header = section.locator('.jp-Launcher-sectionHeader svg');
  await expect(header).toHaveCount(1);
  const headerSvg = await header.innerHTML();
  expect(headerSvg).toContain('<path');

  const tileSvgs: string[] = await page
    .locator(`${CARDS} .jp-LauncherCard-icon svg`)
    .evaluateAll(nodes => nodes.map(node => node.innerHTML));
  expect(tileSvgs.length).toBeGreaterThan(0);
  for (const tileSvg of tileSvgs) {
    expect(headerSvg).not.toBe(tileSvg);
  }

  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: shotPath('launcher-section-joint-icon') });
});

test('ACC-LNCH-145 - a settings toggle adds and removes a tile with no reload', async ({
  page
}) => {
  await page.goto();
  await resetToLauncher(page);

  const all = await tileLabels(page);
  expect(all).toContain('Codex');

  try {
    await setProviderEnabled(page, 'codex', false);
    // The Launcher shares one LauncherModel, whose `stateChanged` the
    // disposable emits - so the open tab repaints itself with no navigation.
    await expect(page.locator(CARDS)).toHaveCount(all.length - 1);
    expect(await tileLabels(page)).toEqual(all.filter(l => l !== 'Codex'));
    await page.screenshot({ path: shotPath('launcher-tile-removed') });
  } finally {
    await setProviderEnabled(page, 'codex', true);
  }

  await expect(page.locator(CARDS)).toHaveCount(all.length);
  expect(await tileLabels(page)).toEqual(all);
});

test('ACC-LNCH-144 - no docked assistant leaves no section at all', async ({
  page
}) => {
  await page.goto();
  await resetToLauncher(page);
  await expect(page.locator(SECTION_TITLE, { hasText: CATEGORY })).toHaveCount(
    1
  );

  try {
    for (const id of AVAILABLE) {
      await setProviderEnabled(page, id, false);
    }
    // Not merely "no tiles": the Launcher builds a section from its items, so
    // the last tile disposed must take the header with it.
    await expect(page.locator(CARDS)).toHaveCount(0);
    await expect(
      page.locator(SECTION_TITLE, { hasText: CATEGORY })
    ).toHaveCount(0);
    await page.screenshot({ path: shotPath('launcher-section-absent') });
  } finally {
    for (const id of AVAILABLE) {
      await setProviderEnabled(page, id, true);
    }
  }

  await expect(page.locator(CARDS)).toHaveCount(AVAILABLE.length);
});

test('ACC-LNCH-156 - the section sits after Other', async ({ page }) => {
  await page.goto();
  await resetToLauncher(page);

  const titles = await sectionTitles(page);
  expect(titles).toContain(CATEGORY);
  expect(titles).toContain('Other');
  expect(titles.indexOf('Other')).toBeLessThan(titles.indexOf(CATEGORY));
});

test('ACC-LNCH-155 - the sibling that owns the spawn is present', async ({
  page
}) => {
  await page.goto();

  // The frontend half of the coupling: a command id, checked with the same
  // `hasCommand` the click path guards on.
  const registered = await page.evaluate(
    (id: string) => (window as any).jupyterapp?.commands.hasCommand(id),
    SIBLING_COMMAND
  );
  expect(registered).toBe(true);

  // The server half: the sibling's handler only implements POST, so a GET it
  // answers at all - 405 rather than the 404 an unmounted route gives - is
  // proof the server extension loaded.
  const response = await page.request.get(SIBLING_ROUTE);
  expect(response.status()).toBe(405);
});

test('ACC-LNCH-153 and ACC-LNCH-157 - a tile click in a folder with no conversation starts one', async ({
  page
}) => {
  await page.goto();
  const status = await fetchStatus(page);
  await page.contents.createDirectory(FRESH_FOLDER);
  await page.filebrowser.openDirectory(FRESH_FOLDER);

  const before = await terminalCount(page);
  await resetToLauncher(page);
  // The fixture, asserted rather than assumed: the Launcher carries the folder
  // the click is being made from.
  await expect(page.locator('.jp-Launcher-cwd h3')).toHaveText(FRESH_FOLDER);

  const argvResponse = page.waitForResponse(
    (r: any) =>
      r.url().includes('/providers/claude/launch-argv') && r.status() === 200
  );
  await clickTile(page, 'Claude Code');
  const argv = (await (await argvResponse).json()).argv as string[];
  // No row for this folder, so the id is minted client-side and the CLI is
  // told to start it - never resumed (ACC-LNCH-153).
  expect(argv).toContain('--session-id');
  expect(argv).not.toContain('--resume');

  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  // The command resolved to the terminal widget, so the Launcher gave up its
  // tab to it (ACC-LNCH-157).
  await expect(page.locator('.jp-Launcher')).toHaveCount(0);
  const name = await currentTerminalName(page);
  expect(name).not.toBeNull();
  expect(await terminalCount(page)).toBe(before + 1);

  // xterm paints to a canvas, so what the pty is running cannot be read off
  // the DOM - the extension's own probe reads it from /proc instead.
  await expect
    .poll(async () => (await probeTerminal(page, 'claude', name!)).running, {
      timeout: 30000
    })
    .toBe(true);
  const probe = await probeTerminal(page, 'claude', name!);
  expect(probe.session_id).toBe(argv[argv.indexOf('--session-id') + 1]);
  expect(probe.cwds).toContain(`${status.root_dir}/${FRESH_FOLDER}`);

  await page.screenshot({ path: shotPath('launcher-click-new-terminal') });
});

test('ACC-LNCH-151 and ACC-LNCH-152 - a folder with a conversation resumes it, and the second click reuses the terminal', async ({
  page
}) => {
  await page.goto();
  await page.filebrowser.openDirectory(SEEDED_FOLDER);
  await resetToLauncher(page);
  await expect(page.locator('.jp-Launcher-cwd h3')).toHaveText(SEEDED_FOLDER);

  const argvResponse = page.waitForResponse(
    (r: any) =>
      r.url().includes('/providers/claude/launch-argv') && r.status() === 200
  );
  await clickTile(page, 'Claude Code');
  const argv = (await (await argvResponse).json()).argv as string[];
  // The seeded project's NEWEST conversation - the same target the panel row
  // click takes (ACC-LNCH-151).
  expect(argv).toContain('--resume');
  expect(argv).toContain(SEEDED_SESSION);

  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  const name = await currentTerminalName(page);
  expect(name).not.toBeNull();
  await expect
    .poll(async () => (await probeTerminal(page, 'claude', name!)).session_id, {
      timeout: 30000
    })
    .toBe(SEEDED_SESSION);

  // Reuse is only observable from the page that opened the terminal: the
  // panel's ladder walks the terminal TRACKER, so a fresh page would find no
  // widget and launch again, correctly. Hence one test, two clicks.
  const before = await terminalCount(page);
  const widgetId = await page.evaluate(
    () => (window as any).jupyterapp.shell.currentWidget.id
  );
  let argvCalls = 0;
  page.on('request', (request: any) => {
    if (request.url().includes('/providers/claude/launch-argv')) {
      argvCalls += 1;
    }
  });

  await addLauncher(page);
  await clickTile(page, 'Claude Code');
  // The reuse path focuses the widget it found and returns it, so the Launcher
  // stands down exactly as it does for a fresh launch.
  await expect(page.locator('.jp-Launcher')).toHaveCount(0);

  expect(await terminalCount(page)).toBe(before);
  expect(
    await page.evaluate(() => (window as any).jupyterapp.shell.currentWidget.id)
  ).toBe(widgetId);
  expect(await currentTerminalName(page)).toBe(name);
  // No second launch was issued at all - the argv route was never reached
  // (ACC-LNCH-152).
  expect(argvCalls).toBe(0);

  await page.screenshot({ path: shotPath('launcher-click-reused-terminal') });
});
