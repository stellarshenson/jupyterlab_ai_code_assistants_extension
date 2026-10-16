import * as fs from 'fs';
import * as path from 'path';

import { expect, test } from '@jupyterlab/galata';

import {
  openPanelTab,
  panelId,
  terminalCount,
  waitForApplication
} from './shared';

test.use({ autoGoto: false, waitForApplication });

const shotPath = (name: string): string =>
  path.join(test.info().project.outputDir, 'screenshots', `${name}.png`);

/**
 * The seeded "harness" project is a real directory under the served root with
 * one titled conversation in the scratch DeepSeek store, so the row drives the
 * whole launch path - panel to launch route to a pty running the `dsh` stub.
 * What is DeepSeek-specific and worth pinning in a browser: the row is named
 * by the log's title event, a click resumes that row's conversation in the
 * TUI under the default open verb, and a second click on the row reuses the
 * terminal instead of opening a second TUI.
 *
 * Not pinned here: reuse across a reload, a switch or a fork. That path rests
 * on the server confirming the terminal's process as the harness
 * (`owns_pid`: a node `comm` plus `dsh` in the argv), and the stub is a
 * `/bin/sh` script the probe never confirms - so the second click below is
 * answered by the page's own microcache, and the confirmed-process rule is
 * proven in `src/__tests__/terminals.spec.ts` against a stubbed probe.
 *
 * The second test pins the launched terminal's own end: the launch route
 * `exec`s the harness as the pty root, so stopping it from the keyboard ends
 * the pty, JupyterLab closes the tab (`closeOnExit`, on by default), the
 * panel's reuse entry goes with the widget, and the next click starts the
 * harness afresh rather than focusing a dead shell (DEF-PANE-223).
 *
 * The third test pins the refusal a machine without the TUI bundle earns. The
 * server config seeds `profiles/tui` so the first two tests can launch at all;
 * the third unmounts it, clicks the same row, and reads the toast the user
 * gets - the community bundle `@deepseek-harness-tui/dsh-tui` and its exact
 * mount command, which `dsh tui`'s own failure never names - then remounts it
 * in a `finally`, so the order the tests run in cannot leave the suite
 * refusing launches.
 */
test('a DeepSeek row opens the TUI terminal once', async ({ page }) => {
  await page.goto();
  await openPanelTab(page, 'deepseek');

  const panel = page.locator('#' + panelId('deepseek'));
  await expect(panel).toBeVisible();

  const row = panel
    .locator('.jp-AiAssistantsPanel-row', { hasText: 'Harness demo' })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });

  // No provider verb: the click resumes the row's conversation, which is what
  // the default label already says.
  await row.click({ button: 'right' });
  await expect(
    page.locator('.lm-Menu-itemLabel', { hasText: /^Resume$/ })
  ).toBeVisible();
  await page.screenshot({ path: shotPath('deepseek-row-resume-menu') });
  await page.keyboard.press('Escape');

  const before = await terminalCount(page);

  await row.click();
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => terminalCount(page)).toBe(before + 1);

  // The launch's own pty, once its harness has exec'd. The init waiter polls
  // the pty size for up to 5 s before the exec, so a shot taken at the count
  // above would catch the waiter rather than the harness; 6 s is the same
  // bound the second test waits before Ctrl+C. The screen is xterm's, not
  // assertable from the DOM, so the wait is bounded rather than probed.
  await page.waitForTimeout(6000);
  await page.screenshot({ path: shotPath('deepseek-tui-terminal') });

  // The same row again focuses the terminal it already has.
  await openPanelTab(page, 'deepseek');
  await row.click();
  await expect(page.locator('.jp-Terminal')).toBeVisible();
  await page.waitForTimeout(1500);
  expect(await terminalCount(page)).toBe(before + 1);
});

test('stopping the harness closes its tab and the next click starts it again', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'deepseek');
  const panel = page.locator('#' + panelId('deepseek'));
  const row = panel
    .locator('.jp-AiAssistantsPanel-row', { hasText: 'Harness demo' })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });
  const before = await terminalCount(page);

  await row.click();
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => terminalCount(page)).toBe(before + 1);
  // The init waiter polls the pty size for up to 5 s before it execs the
  // harness; Ctrl+C before that would end the waiter, not the harness.
  await page.waitForTimeout(6000);

  await page.locator('.jp-Terminal').first().click();
  await page.keyboard.press('Control+C');

  await expect(page.locator('.jp-Terminal')).toHaveCount(0, { timeout: 15000 });
  await expect.poll(() => terminalCount(page)).toBe(before);

  await openPanelTab(page, 'deepseek');
  await row.click();
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => terminalCount(page)).toBe(before + 1);
});

test('a launch without the mounted TUI bundle is refused in named words', async ({
  page
}) => {
  // The scratch tree's DSH_HOME, as `jupyter_server_test_config.py` lays it
  // out: `<scratch>/home/.dsh`, where `<scratch>` is the resolved value
  // `playwright.config.js` exports to its workers - the same lookup
  // `codex-rename.spec.ts` makes for its stub transcript.
  const scratch = String(process.env.JLAB_TEST_SCRATCH);
  const profile = path.join(scratch, 'home', '.dsh', 'profiles', 'tui');

  await page.goto();
  await openPanelTab(page, 'deepseek');
  const panel = page.locator('#' + panelId('deepseek'));
  const row = panel
    .locator('.jp-AiAssistantsPanel-row', { hasText: 'Harness demo' })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });
  const before = await terminalCount(page);

  // Unmount the bundle: the launch preflight is a stat of this very
  // directory, so its absence is the whole state the refusal needs.
  fs.rmSync(profile, { recursive: true, force: true });
  try {
    await row.click();

    // The refusal is the panel's toast - the launch POST answers with a
    // non-404 body whose `message` the panel prints after its own copy, so a
    // run without it shows up here as a failed click rather than a message.
    // The toast auto-closes after 4 seconds. `toBeVisible` alone is not
    // enough for the assertions or the screenshot: the toast slides in from
    // beyond the right edge (its rect sits at x=1038 in the 1024-wide
    // viewport, translated 348px by `Toastify__slide-enter`), so the wait is
    // for it to have arrived in view, which is when the user reads it.
    const toast = page.locator('.jp-Notification-Toast-error');
    await expect(toast).toBeVisible({ timeout: 15000 });
    await expect(toast).toBeInViewport({ ratio: 1 });
    // Where `dsh tui` dies in a stack trace naming only its literal
    // `<package>` placeholder, the user must get the bundle's real name and
    // the exact command that mounts it.
    await expect(toast).toContainText('Could not open that conversation:');
    await expect(toast).toContainText('@deepseek-harness-tui/dsh-tui');
    await expect(toast).toContainText(
      'dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui'
    );

    // A refused launch opens nothing, and the toast proves the attempt has
    // concluded: no terminal may have appeared behind it.
    expect(await terminalCount(page)).toBe(before);

    await page.screenshot({ path: shotPath('deepseek-missing-tui-refusal') });
  } finally {
    // Remount, so a later spec - or a re-run in another order - meets the
    // fixture's mounted machine rather than this test's refusal state.
    fs.mkdirSync(profile, { recursive: true });
  }
});
