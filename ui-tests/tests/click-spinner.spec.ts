import { expect, test } from '@jupyterlab/galata';

import {
  openPanelTab,
  panelId,
  terminalCount,
  waitForApplication
} from './shared';

test.use({ autoGoto: false, waitForApplication });

/**
 * The click's own feedback (DEF-PANE-318, DEF-PANE-324,
 * DEF-PANE-327-BUSY-MODAL-1, DEF-PANE-328-FOCUS-RIM,
 * DEF-PANE-329-SPINNER-SIZE).
 *
 * A Branch Session click and a row click used to show nothing for seconds: the
 * branch spinner was raised only after the branch route answered, and the open
 * spinner only after the server had been asked about every live terminal. Both
 * routes are held open here, so only a spinner raised ON the click can be seen
 * before the answer arrives.
 *
 * The click-time spinner is the launch spinner's own JupyterLab Dialog, and
 * there is one of it: the launch that follows joins the dialog the click
 * raised instead of raising a second. The dialog covers the window, blocks the
 * page behind and takes the focus; the menu that ran Branch Session has closed
 * by then, because Lumino closes a menu before it runs the item's command.
 * When the action ends the dialog closes before the terminal takes the
 * keyboard, so typing reaches the assistant without a second click.
 *
 * The dialog is compact - a semi-bold title one step above the base UI size,
 * a 240px minimum width, a 24px ring - and never shows a scrollbar: a turning ring's box grows to its
 * diagonal, and the dialog body scrolls. Its Hide button is the filled primary
 * with no focus rim. The ring turns under both motion preferences
 * (DEF-PANE-324).
 */

const PANEL = `#${panelId('claude')}`;
const MENU = '.lm-Menu.jp-AiAssistantsContextMenu';
const SESSIONS =
  '/jupyterlab-ai-code-assistants-extension/providers/claude/sessions';
const DIALOG = '.jp-Dialog.jp-AiAssistantsPanel-spinnerDialog';
const TITLE = `${DIALOG} .jp-Dialog-header`;
const RING = `${DIALOG} .jp-AiAssistantsPanel-launchSpinner`;
const HIDE = `${DIALOG} .jp-Dialog-footer .jp-Dialog-button`;

/** Longer than the assertion deadline, so a spinner raised only when the
 * delayed route answers cannot pass. */
const HOLD_MS = 4000;
const SEEN_MS = 1500;

const BRANCH_ROUTE = /\/providers\/[^/]+\/branch(\?|$)/;
const PROBE_ROUTE = /\/providers\/[^/]+\/terminal\//;
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

/** The current conversation's display name for the project ending in
 * `suffix`, off the listing route the panel itself reads. */
async function currentName(page: any, suffix: string): Promise<string> {
  const response = await page.request.get(SESSIONS);
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  const found = (payload.sessions as Array<Record<string, any>>).find(entry =>
    String(entry.project_path).endsWith(suffix)
  );
  expect(found).toBeTruthy();
  return found!.name;
}

/** Click Branch Session on the named row, flat or in its mode submenu. */
async function branchRow(page: any, name: string): Promise<void> {
  const target = row(page, name);
  await expect(target).toBeVisible({ timeout: 15000 });
  await target.click({ button: 'right' });

  const menu = page.locator(MENU).first();
  await expect(menu).toBeVisible({ timeout: 15000 });
  const flat = menu.locator('.lm-Menu-item[data-type="command"]', {
    hasText: /^Branch Session$/
  });
  if (await flat.count()) {
    await flat.click();
    return;
  }
  await menu
    .locator('.lm-Menu-itemLabel', { hasText: /^Branch Session$/ })
    .hover();
  const item = page
    .locator('.lm-Menu')
    .last()
    .locator('.lm-Menu-item[data-type="command"]', { hasText: /^Normal$/ });
  await expect(item).toBeVisible({ timeout: 10000 });
  await item.click();
}

/** A theme token as the browser paints it, read off a probe element so it
 * compares equal to another element's computed colour. */
async function paintedColour(page: any, token: string): Promise<string> {
  return page.evaluate((name: string) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = `var(${name})`;
    document.body.appendChild(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  }, token);
}

/** Every title the extension gives the spinner dialog. */
const TITLES = ['Claude Code', 'Codex', 'Kimi', 'Gemini', 'DeepSeek'].flatMap(
  label => [`Opening ${label}`, `Branching ${label} session`]
);

/** How far the spinner dialog's body and content overflow, at worst, over
 * one second of the ring turning, with the header cycling through every
 * title. Zero on both axes means no scrollbar can show. */
async function worstOverflow(page: any): Promise<Record<string, number>> {
  return page
    .locator(DIALOG)
    .evaluate(async (dialog: Element, titles: string[]) => {
      const header = dialog.querySelector('.jp-Dialog-header')!;
      const shown = header.textContent;
      const boxes = {
        body: dialog.querySelector('.jp-Dialog-body')!,
        content: dialog.querySelector('.jp-Dialog-content')!
      };
      const worst: Record<string, number> = {
        bodyY: 0,
        bodyX: 0,
        contentY: 0,
        contentX: 0,
        frames: 0
      };
      const start = performance.now();
      while (performance.now() - start < 1000) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        header.textContent = titles[worst.frames++ % titles.length];
        for (const [name, box] of Object.entries(boxes)) {
          worst[`${name}Y`] = Math.max(
            worst[`${name}Y`],
            box.scrollHeight - box.clientHeight
          );
          worst[`${name}X`] = Math.max(
            worst[`${name}X`],
            box.scrollWidth - box.clientWidth
          );
        }
      }
      header.textContent = shown;
      return worst;
    }, TITLES);
}

/** The focused element's outline style and width. */
async function focusedOutline(page: any): Promise<string> {
  return page.evaluate(() => {
    const style = getComputedStyle(document.activeElement as Element);
    return `${style.outlineStyle} ${style.outlineWidth}`;
  });
}

/** One spinner dialog is on screen, titled `title`, covering and blocking the
 * window, compact, and with a filled Hide button that has the focus and no
 * rim. Returns once all of that holds. */
async function expectSpinnerDialog(page: any, title: string): Promise<void> {
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: SEEN_MS });
  // One dialog of any kind: the launch never stacks a second.
  await expect(page.locator('.jp-Dialog')).toHaveCount(1);
  await expect(page.locator(TITLE)).toHaveText(title, { useInnerText: true });
  // Not inside the panel, where a hidden or scrolled panel keeps it out of
  // sight (DEF-PANE-318-1).
  await expect(page.locator(`${PANEL} .jp-Dialog`)).toHaveCount(0);

  // The backdrop covers the window and blocks the page behind it: the point
  // over the clicked row now lands on the dialog.
  const viewport = page.viewportSize()!;
  const box = await page.locator(DIALOG).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeLessThanOrEqual(1);
  expect(box!.y).toBeLessThanOrEqual(1);
  expect(box!.width).toBeGreaterThanOrEqual(viewport.width - 2);
  expect(box!.height).toBeGreaterThanOrEqual(viewport.height - 2);
  const backdrop = await page
    .locator(DIALOG)
    .evaluate((element: Element) => getComputedStyle(element).backgroundColor);
  expect(backdrop).not.toBe('rgba(0, 0, 0, 0)');
  const panelBox = await page.locator(PANEL).boundingBox();
  const blocked = await page.evaluate(
    (point: { x: number; y: number }) =>
      !!document.elementFromPoint(point.x, point.y)?.closest('.jp-Dialog'),
    { x: panelBox!.x + panelBox!.width / 2, y: panelBox!.y + 60 }
  );
  expect(blocked).toBe(true);

  // Compact: the title semi-bold at --jp-ui-font-size2, one step above the
  // base UI size and one below JupyterLab's default; padding about halfway to
  // JupyterLab's default dialog; a 240px minimum width, below the default
  // 300px; a 24px ring. The token is an em size, so it is resolved where the
  // title sits.
  const titleSize = await page.locator(TITLE).evaluate((title: Element) => {
    const probe = document.createElement('div');
    probe.style.fontSize = 'var(--jp-ui-font-size2)';
    title.parentElement!.appendChild(probe);
    const size = getComputedStyle(probe).fontSize;
    probe.remove();
    return size;
  });
  expect(titleSize).toBe('15.6px');
  await expect(page.locator(TITLE)).toHaveCSS('font-size', titleSize);
  await expect(page.locator(TITLE)).toHaveCSS('font-weight', '600');
  await expect(page.locator(TITLE)).toHaveCSS('padding-bottom', '8px');
  const content = page.locator(`${DIALOG} .jp-Dialog-content`);
  await expect(content).toHaveCSS('padding', '16px 20px 8px');
  await expect(content).toHaveCSS('min-width', '240px');
  await expect(page.locator(`${DIALOG} .jp-Dialog-footer`)).toHaveCSS(
    'padding',
    '8px 12px'
  );
  const card = await content.boundingBox();
  expect(card!.width).toBeGreaterThanOrEqual(240);
  expect(card!.width).toBeLessThan(300);
  const ring = page.locator(RING);
  await expect(ring).toHaveCSS('width', '24px');
  await expect(ring).toHaveCSS('height', '24px');
  await expect(ring).toHaveCSS('border-top-width', '3px');
  await expect(ring).toHaveCSS('animation-name', 'jp-ai-assistants-spin');

  // No scrollbar beside the turning ring, whatever the title
  // (DEF-PANE-329-SPINNER-SIZE).
  const overflow = await worstOverflow(page);
  expect(overflow.frames).toBeGreaterThan(20);
  expect(overflow).toEqual({
    bodyY: 0,
    bodyX: 0,
    contentY: 0,
    contentX: 0,
    frames: overflow.frames
  });

  // Hide is the one primary, marked by its fill - JupyterLab's accept fill,
  // which the light theme this suite runs in paints in the brand colour - and
  // it has the focus with no rim, both as the dialog opened on the click and
  // once the keyboard moves the focus (Tab wraps back to the only button).
  const hide = page.locator(HIDE);
  await expect(hide).toHaveCount(1);
  await expect(hide).toHaveClass(/jp-mod-accept/);
  await expect(hide).toHaveCSS('height', '28px');
  await expect(hide).toHaveCSS(
    'background-color',
    await paintedColour(page, '--jp-brand-color1')
  );
  await expect(hide).toBeFocused();
  expect(await focusedOutline(page)).toMatch(/^none |^\S+ 0px$/);
  await page.keyboard.press('Tab');
  await expect(hide).toBeFocused();
  expect(await focusedOutline(page)).toMatch(/^none |^\S+ 0px$/);
}

/** The keyboard is in a terminal: its xterm input has the focus. */
async function expectTerminalFocused(page: any): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const active = document.activeElement;
          return (
            !!active?.classList.contains('xterm-helper-textarea') &&
            !!active.closest('.jp-Terminal')
          );
        }),
      { timeout: 10000 }
    )
    .toBe(true);
}

test('a branch click shows the spinner dialog before the branch route answers', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  await page.route(BRANCH_ROUTE, async (route: any) => {
    await new Promise(resolve => setTimeout(resolve, HOLD_MS));
    await route.continue();
  });

  const parent = await currentName(page, 'spinner-fixture');
  const before = await terminalCount(page);
  await branchRow(page, parent);

  // While the branch route is unanswered. The old code raised nothing here,
  // and then a card of its own instead of this dialog.
  await expectSpinnerDialog(page, 'Branching Claude Code session');

  // The branch lands, its terminal opens, the dialog is gone and the keyboard
  // is in the new terminal.
  await expect
    .poll(() => currentName(page, 'spinner-fixture'), { timeout: 30000 })
    .not.toBe(parent);
  await expect
    .poll(() => terminalCount(page), { timeout: 30000 })
    .toBe(before + 1);
  await expect(page.locator('.jp-Dialog')).toHaveCount(0, { timeout: 30000 });
  await expectTerminalFocused(page);
});

test('a row click keeps one spinner dialog from the click to the launch', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  // One live terminal for the probe to walk: open another project's row
  // first. The fixture's own row is clicked second, on a cold microcache.
  const first = await currentName(page, '/branchy');
  const before = await terminalCount(page);
  await row(page, first).click();
  await expect(page.locator('.jp-Terminal')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => terminalCount(page)).toBe(before + 1);
  await expect(page.locator('.jp-Dialog')).toHaveCount(0, { timeout: 30000 });

  const hold = async (route: any): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, HOLD_MS));
    await route.continue();
  };
  await page.route(PROBE_ROUTE, hold);
  await page.route(LAUNCH_ROUTE, hold);

  const second = await currentName(page, 'spinner-fixture');
  const launched = page.waitForRequest(LAUNCH_ROUTE, { timeout: 30000 });
  await row(page, second).click();

  // While the probe of the live terminal is unanswered.
  await expectSpinnerDialog(page, 'Opening Claude Code');
  await page
    .locator(DIALOG)
    .evaluate((element: Element) => element.setAttribute('data-click', ''));

  // The probe answers with the other project's conversation, so the launch
  // runs - and joins the click's dialog: the same node, the same title, and
  // still the only dialog.
  await launched;
  await expect(page.locator('.jp-Dialog')).toHaveCount(1);
  await expect(page.locator(`${DIALOG}[data-click]`)).toHaveCount(1);
  await expect(page.locator(TITLE)).toHaveText('Opening Claude Code', {
    useInnerText: true
  });

  // The terminal appears, the dialog is gone, and the keyboard is in it.
  await expect
    .poll(() => terminalCount(page), { timeout: 30000 })
    .toBe(before + 2);
  await expect(page.locator('.jp-Dialog')).toHaveCount(0, { timeout: 30000 });
  await expectTerminalFocused(page);
});

test('a refused branch closes the spinner dialog and says what happened', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  await page.route(BRANCH_ROUTE, async (route: any) => {
    await new Promise(resolve => setTimeout(resolve, HOLD_MS));
    // A failed request, not an invented answer: the branch route is never
    // called, so nothing is minted and the panel reports the failure.
    await route.abort();
  });

  const parent = await currentName(page, 'spinner-fixture');
  const before = await terminalCount(page);
  await branchRow(page, parent);

  await expectSpinnerDialog(page, 'Branching Claude Code session');

  // The refusal closes the click's dialog, opens no terminal, and tells the
  // user in the panel's own banner.
  await expect(page.locator('.jp-Dialog')).toHaveCount(0, { timeout: 15000 });
  await expect.poll(() => terminalCount(page), { timeout: 15000 }).toBe(before);
  const banner = page.locator(PANEL).locator('.jp-AiAssistantsPanel-error');
  await expect(banner).toBeVisible({ timeout: 15000 });
  await expect(banner).toContainText('Could not branch this session');
});

test('a reduced-motion click still turns the ring and names the action in sight', async ({
  page
}) => {
  // What the browser reports for an OS with animation effects off. The
  // extension does not honour the preference: the ring turns regardless.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto();
  await openPanelTab(page, 'claude');

  await page.route(BRANCH_ROUTE, async (route: any) => {
    await new Promise(resolve => setTimeout(resolve, HOLD_MS));
    await route.abort();
  });

  const parent = await currentName(page, 'spinner-fixture');
  await branchRow(page, parent);

  await expect(page.locator(DIALOG)).toBeVisible({ timeout: SEEN_MS });
  const ring = page.locator(RING);
  await expect(ring).toBeVisible({ timeout: SEEN_MS });

  // The ring turns under the emulated preference: no reduced-motion rule
  // stops the spin, and the arc keeps full opacity above the 3:1 non-text
  // minimum while it turns.
  await expect(ring).toHaveCSS('animation-name', 'jp-ai-assistants-spin');
  const transform = await ring.evaluate(
    (element: Element) => getComputedStyle(element).transform
  );
  expect(transform).not.toBe('none');
  await expect(ring).toHaveCSS('opacity', '1');
  // The title names the action in visible text alongside the motion.
  await expect(page.locator(TITLE)).toBeVisible();
  await expect(page.locator(TITLE)).toHaveText(
    'Branching Claude Code session',
    {
      useInnerText: true
    }
  );

  // And the dialog still closes when the request is refused.
  await expect(page.locator('.jp-Dialog')).toHaveCount(0, { timeout: 15000 });
  const banner = page.locator(PANEL).locator('.jp-AiAssistantsPanel-error');
  await expect(banner).toBeVisible({ timeout: 15000 });
});
