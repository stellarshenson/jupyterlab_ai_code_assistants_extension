import { expect, test } from '@jupyterlab/galata';

import { openPanelTab, panelId, waitForApplication } from './shared';

/**
 * The live status dot renders differently on a light theme than on a dark one,
 * and the difference is carried entirely by the stylesheet: JupyterLab stamps
 * the theme's own `isLight` onto the body, and `style/base.css` branches on it
 * (DEF-PANE-185). Nothing in TypeScript knows which theme is on, so this is
 * the tier that can catch the branch being lost.
 *
 * A dark theme must keep exactly what the extension shipped before the branch
 * existed - the green fill glowing in its own colour - because the change that
 * gave both themes one dark-contoured dot was rejected on sight. A light theme
 * must instead carry the bright green fill and a pale green ring, since the
 * dot's own green separates nothing from it and a white ring reads as a
 * bright blob on the mid-grey rows the light themes in use draw
 * (DEF-PANE-201).
 *
 * The dot is real, not a probe element. It is drawn for the seeded "branchy"
 * project, whose fixture carries a remote-control record - a live pid and a
 * bridge id - so the panel takes the same branch it takes in production. A
 * launched session cannot stand in for it: the suite's assistants are shell
 * stubs, and the record that marks a session remote-controlled is Claude's own
 * to write.
 */
test.use({ autoGoto: false, waitForApplication });

const PANEL = `#${panelId('claude')}`;
const DOT = '.jp-AiAssistantsPanel-dot';

/** md-green-500, the one green both themes put in the circle. */
const GREEN = 'rgb(76, 175, 80)';
/** md-green-200, the ring a light theme draws round it. */
const MINT = 'rgb(165, 214, 167)';

test('the dot keeps its green glow on a dark theme and takes a mint ring on a light theme', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  const panel = page.locator(PANEL);
  await expect(panel).toBeVisible();

  const row = panel
    .locator('.jp-AiAssistantsPanel-row', { hasText: 'branchy' })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });
  const dot = row.locator(DOT).first();
  await expect(dot).toBeVisible({ timeout: 30000 });

  const read = async () =>
    await dot.evaluate(el => ({
      isLight: document.body.getAttribute('data-jp-theme-light'),
      filter: getComputedStyle(el).filter,
      fill: getComputedStyle(
        el.querySelector('.jp-AiAssistantsPanel-dotGlyph') as Element
      ).fill
    }));

  await page.theme.setTheme('JupyterLab Dark');
  const dark = await read();
  expect(dark.isLight).toBe('false');
  expect(dark.fill).toBe(GREEN);
  // One pass, in the dot's own colour - the rendering that predates the branch.
  expect(dark.filter.match(/drop-shadow/g)).toHaveLength(1);
  expect(dark.filter).toContain(GREEN);

  await page.theme.setTheme('JupyterLab Light');
  const light = await read();
  expect(light.isLight).toBe('true');
  // The bright green, NOT the theme's own success colour, which is a step
  // darker on every light theme and reads as a near-black mark at 8px.
  expect(light.fill).toBe(GREEN);
  // Three mint passes: one pass leaves the ring faint, so the count is what
  // saturates it. Neither the fill's own green nor white, both rejected.
  expect(light.filter.match(/drop-shadow/g)).toHaveLength(3);
  expect(light.filter).toContain(MINT);
  expect(light.filter).not.toContain(GREEN);
  expect(light.filter).not.toContain('rgb(255, 255, 255)');
});
