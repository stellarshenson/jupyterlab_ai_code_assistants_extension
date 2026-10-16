import * as path from 'path';

import { expect, test } from '@jupyterlab/galata';

import {
  openPanelTab,
  panelId,
  STATUS_URL,
  waitForApplication
} from './shared';

/**
 * Feature-parity evidence against the extension this one retires.
 *
 * Ported from `jupyterlab_claude_code_extension/ui-tests/tests/
 * jupyterlab_claude_code_extension.spec.ts`. Every behavioural assertion of
 * that suite is preserved; only the names it addresses changed, because the
 * panel is now the shared core driven by the Claude provider:
 *
 * - widget id `jupyterlab-claude-code-extension` -> `jupyterlab-ai-code-assistants-claude`
 * - CSS prefix `jp-ClaudeSessionsPanel-` -> `jp-AiAssistantsPanel-`
 * - menu class `jp-ClaudeSessionsContextMenu` -> `jp-AiAssistantsContextMenu`
 * - command ids `jupyterlab-claude-code-extension:*` -> `ai-code-assistants:claude:*`
 *   (private to the panel's own registry, so they are addressed only through
 *   the menu labels below)
 * - user-facing strings now carry the provider label "Claude Code" rather than
 *   the hard-coded word "Claude"
 *
 * The fixtures are the same shape as the original's: a stub `claude` on PATH
 * and a seeded "branchy" project holding three parallel conversations. The
 * stub is a shell script, so its process `comm` is never "claude" and the
 * terminal-reuse ladder never matches - every open spawns a fresh terminal,
 * which is exactly how independent branches behave. Conversation-aware reuse
 * is covered by the unit tiers.
 */
test.use({ autoGoto: false, waitForApplication });

const PANEL = `#${panelId('claude')}`;
const NEW_BUTTON = 'button[title="New session in current folder"]';
const MENU = '.lm-Menu.jp-AiAssistantsContextMenu';

const shotPath = (name: string): string =>
  path.join(test.info().project.outputDir, 'screenshots', `${name}.png`);

test('should emit an activation console message', async ({ page }) => {
  const logs: string[] = [];

  page.on('console', message => {
    logs.push(message.text());
  });

  await page.goto();

  // The original accepted either "panel registered" or "`claude` binary not
  // found", because its CI had no CLI. Here the stub is guaranteed on PATH, so
  // the stronger claim holds: the extension activated AND docked panels.
  const activated = logs.some(s =>
    s.includes(
      'JupyterLab extension jupyterlab_ai_code_assistants_extension is activated!'
    )
  );
  expect(activated).toBe(true);
  await expect(page.locator(PANEL)).toHaveCount(1);
});

test('plus button opens the new-session menu', async ({ page }) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  const panel = page.locator(PANEL);
  await expect(panel).toBeVisible();

  await panel.locator(NEW_BUTTON).click();

  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();
  await expect(
    menu.locator('.lm-Menu-itemLabel', { hasText: 'New session' })
  ).toHaveCount(2);
  await expect(
    menu.locator('.lm-Menu-itemLabel', {
      hasText: 'New session (Skip Permissions)'
    })
  ).toHaveCount(1);
});

test('new-session menu item opens a terminal in the current folder', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  const panel = page.locator(PANEL);
  await panel.locator(NEW_BUTTON).click();

  const menu = page.locator(MENU);
  await menu
    .locator('.lm-Menu-itemLabel', {
      hasText: /^New session$/
    })
    .click();

  // The launch flow POSTs the provider's launch route (a frontend-minted
  // new_session_id -> a fresh `claude --session-id <uuid>`), then attaches
  // JupyterLab's terminal widget. The pty runs the stub directly - no shell
  // prompt. xterm paints to canvas so the script's output is not assertable
  // via DOM text; instead confirm the server now reports a live terminal.
  const terminal = page.locator('.jp-Terminal');
  await expect(terminal).toBeVisible({ timeout: 30000 });

  const response = await page.request.get('/api/terminals');
  expect(response.ok()).toBe(true);
  const terminals = (await response.json()) as Array<{ name: string }>;
  expect(terminals.length).toBeGreaterThan(0);
});

/** Right-click the seeded "branchy" row and return its context menu. */
async function openBranchyMenu(page: any) {
  await page.goto();
  await openPanelTab(page, 'claude');
  const panel = page.locator(PANEL);
  await expect(panel).toBeVisible();
  const row = panel
    .locator('.jp-AiAssistantsPanel-row', { hasText: 'branchy' })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click({ button: 'right' });
  const menu = page.locator(MENU).first();
  await expect(menu).toBeVisible({ timeout: 15000 });
  return menu;
}

test('context menu offers Open Branched Conversation for a multi-branch project', async ({
  page
}) => {
  const menu = await openBranchyMenu(page);
  await expect(
    menu.locator('.lm-Menu-itemLabel', {
      hasText: 'Open Branched Conversation'
    })
  ).toBeVisible();
  // The switch submenu still coexists (Open alongside Switch).
  await expect(
    menu.locator('.lm-Menu-itemLabel', {
      hasText: 'Switch and Manage Sessions'
    })
  ).toBeVisible();
});

test('Open Branched Conversation lists branches and opening one launches a terminal', async ({
  page
}) => {
  const menu = await openBranchyMenu(page);
  await menu
    .locator('.lm-Menu-itemLabel', { hasText: 'Open Branched Conversation' })
    .hover();
  // Hovering the submenu opens a nested Lumino menu with the branch entries.
  const submenu = page.locator('.lm-Menu').last();
  const entries = submenu.locator('.lm-Menu-item[data-type="command"]');
  await expect(entries.first()).toBeVisible({ timeout: 10000 });
  await entries.first().click();

  // open-branch -> launch route (claude --resume <id>) -> JL terminal widget.
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
});

/** Open the Manage Sessions popup of the seeded "branchy" project. */
async function openManageSessions(page: any) {
  const menu = await openBranchyMenu(page);
  await menu
    .locator('.lm-Menu-itemLabel', { hasText: 'Open Branched Conversation' })
    .hover();
  const submenu = page.locator('.lm-Menu').last();
  // Wait for the submenu to open, then click its "Manage Sessions..."
  // COMMAND item. The ``[data-type="command"]`` filter is essential -
  // ``hasText: 'Manage Sessions'`` alone also matches the "Switch and Manage
  // Sessions" submenu PARENT, which does not open the popup.
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

test('Manage Sessions popup exposes a per-row Open button', async ({
  page
}) => {
  const popup = await openManageSessions(page);
  // Every row (current + branches) carries an Open button.
  const openButtons = popup.locator('.jp-AiAssistantsPanel-branchOpen');
  await expect(openButtons.first()).toBeVisible();
  const count = await openButtons.count();
  expect(count).toBeGreaterThanOrEqual(2);

  // Opening from the popup launches a terminal and dismisses the popup.
  await openButtons.first().click();
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  await expect(popup).toBeHidden();
});

test('Manage Sessions Delete sits in the action row and follows the destructive style (DEF-PANE-307)', async ({
  page
}) => {
  // The server's move-to-trash preference, reported as off. A permanent
  // delete arms on the first click and only the second one deletes, so this
  // test reaches the armed state without ever removing a seeded conversation;
  // a trashed delete would execute on the first click.
  await page.route(`**${STATUS_URL}*`, async (route: any) => {
    const response = await route.fetch();
    const body = await response.json();
    body.delete_to_trash = false;
    await route.fulfill({ response, json: body });
  });

  const popup = await openManageSessions(page);

  // Opens with the keyboard focus on the filter, not on Close, so typing
  // filters straight away (DEF-PANE-314). "branch" is in every seeded session
  // id, so every row stays listed for the steps below.
  const filter = popup.locator('.jp-AiAssistantsPanel-branchSearch');
  await expect(filter).toBeFocused();
  await page.keyboard.type('branch');
  await expect(filter).toHaveValue('branch');

  const dialog = page.locator('.jp-Dialog');
  const footer = dialog.locator('.jp-Dialog-footer');
  const del = footer.locator('.jp-AiAssistantsPanel-branchDelete');
  const close = footer.locator('.jp-Dialog-button', { hasText: 'Close' });

  // Shift+Tab from the filter, the first focusable element, leaves the
  // dialog, and the dialog returns the focus to Close, its primary button.
  await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();

  // In the dialog's own action row, not the body: on its left edge, on the
  // same line as Close.
  await expect(del).toBeVisible();
  await expect(
    dialog.locator('.jp-Dialog-body .jp-AiAssistantsPanel-branchDelete')
  ).toHaveCount(0);
  const delBox = (await del.boundingBox())!;
  const closeBox = (await close.boundingBox())!;
  expect(delBox.x + delBox.width).toBeLessThan(closeBox.x);
  expect(
    Math.abs(delBox.y + delBox.height / 2 - (closeBox.y + closeBox.height / 2))
  ).toBeLessThan(2);

  /** The computed colours of Delete, beside the theme's error colour resolved
   * in the same place, so the comparison holds in any theme. */
  const colours = () =>
    del.evaluate((node: HTMLElement) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--jp-error-color1)';
      node.parentElement!.appendChild(probe);
      const error = getComputedStyle(probe).color;
      probe.remove();
      const style = getComputedStyle(node);
      return {
        error,
        border: style.borderTopColor,
        background: style.backgroundColor,
        opacity: style.opacity,
        cursor: style.cursor
      };
    });

  // Nothing selected: disabled, faded by opacity as JupyterLab's own disabled
  // buttons are.
  await expect(del).toBeDisabled();
  let seen = await colours();
  expect(seen.opacity).toBe('0.5');
  expect(seen.cursor).toBe('not-allowed');
  await page.screenshot({ path: shotPath('manage-sessions-delete-disabled') });

  // One selected: enabled, an error-colour outline on an unfilled button.
  await popup
    .locator(
      '.jp-AiAssistantsPanel-branchRow:not(.jp-mod-current) input[type="checkbox"]'
    )
    .first()
    .check();
  await expect(del).toBeEnabled();
  await expect(del).toHaveText('Delete (1)');
  seen = await colours();
  expect(seen.opacity).toBe('1');
  expect(seen.border).toBe(seen.error);
  expect(seen.background).not.toBe(seen.error);
  await page.screenshot({ path: shotPath('manage-sessions-delete-enabled') });

  // Armed by the first click: filled with the error colour, label names the
  // confirmation. The second click is never made.
  await del.click();
  await expect(del).toHaveClass(/jp-mod-armed/);
  await expect(del).toHaveText('Confirm delete 1');
  seen = await colours();
  expect(seen.background).toBe(seen.error);
  await page.screenshot({ path: shotPath('manage-sessions-delete-armed') });

  // The click armed, it did not close the dialog.
  await expect(popup).toBeVisible();
  await close.click();
  await expect(popup).toBeHidden();
});

test('two different branches open as two independent terminals', async ({
  page
}) => {
  const before = (
    (await (await page.request.get('/api/terminals')).json()) as unknown[]
  ).length;

  // Open the first branch.
  let menu = await openBranchyMenu(page);
  await menu
    .locator('.lm-Menu-itemLabel', { hasText: 'Open Branched Conversation' })
    .hover();
  let submenu = page.locator('.lm-Menu').last();
  let entries = submenu.locator('.lm-Menu-item[data-type="command"]');
  await expect(entries.first()).toBeVisible({ timeout: 10000 });
  await entries.first().click();
  await expect(page.locator('.jp-Terminal').first()).toBeVisible({
    timeout: 30000
  });

  // Open a different branch - it must NOT replace the first terminal.
  menu = await openBranchyMenu(page);
  await menu
    .locator('.lm-Menu-itemLabel', { hasText: 'Open Branched Conversation' })
    .hover();
  submenu = page.locator('.lm-Menu').last();
  entries = submenu.locator('.lm-Menu-item[data-type="command"]');
  await expect(entries.nth(1)).toBeVisible({ timeout: 10000 });
  await entries.nth(1).click();
  await expect(page.locator('.jp-Terminal').first()).toBeVisible({
    timeout: 30000
  });

  const after = (
    (await (await page.request.get('/api/terminals')).json()) as unknown[]
  ).length;
  expect(after - before).toBeGreaterThanOrEqual(2);
});
