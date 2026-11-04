import { expect, test } from '@jupyterlab/galata';

import { openPanelTab, panelId, waitForApplication } from './shared';

/**
 * Rendered proof for the panel's horizontal layout (ACC-PANE-182,
 * ACC-PANE-183): where the favourite star sits and how far the content stands
 * from the panel border. Both are geometry, which jsdom does not compute, so
 * the unit tier cannot hold either.
 */
test.use({ autoGoto: false, waitForApplication });

const PANEL = `#${panelId('claude')}`;
const MENU = '.lm-Menu.jp-AiAssistantsContextMenu';
// All, not Recent: Recent is drawn only past the recent limit, and the
// fixture seeds fewer projects than that.
const ALL = `${PANEL} .jp-AiAssistantsPanel-section[data-section='all']`;

const SESSIONS_URL =
  '/jupyterlab-ai-code-assistants-extension/providers/claude/sessions';

/** The shared inset `style/base.css` declares as `--aica-inset`. */
const INSET = 4;

/** `branchy` is the newest seeded project (28 s old) and `renamable` was
 * seeded 900 s old, so with the clock fixed below their labels read "now" and
 * "14m ago". */
const STARRED = ['branchy', 'renamable'];

async function toggleFavourite(page: any, rowText: string, item: string) {
  const row = page
    .locator(PANEL)
    .locator('.jp-AiAssistantsPanel-row', { hasText: rowText })
    .first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click({ button: 'right' });
  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();
  await menu.locator('.lm-Menu-item', { hasText: item }).first().click();
}

test('ACC-PANE-182 - favourite stars keep one column beside the time', async ({
  page
}) => {
  // Fixed just after the newest conversation, so its label reads "now" -
  // narrower than the column - however long the run has been going.
  const response = await page.request.get(SESSIONS_URL);
  expect(response.ok()).toBe(true);
  const sessions = ((await response.json()) as any).sessions as any[];
  await page.clock.setFixedTime(
    Math.max(...sessions.map(s => s.file_mtime)) + 5000
  );
  await page.goto();
  await openPanelTab(page, 'claude');

  for (const name of STARRED) {
    await toggleFavourite(page, name, 'Add to Favorites');
  }
  try {
    const rights: number[] = [];
    const labelWidths: number[] = [];
    let minWidth = 0;
    for (const name of STARRED) {
      const row = page
        .locator(ALL)
        .locator('.jp-AiAssistantsPanel-row', { hasText: name })
        .first();
      const star = row.locator('.jp-AiAssistantsPanel-favStar');
      await expect(star).toBeVisible({ timeout: 15000 });
      const time = row.locator('.jp-AiAssistantsPanel-rowTime');
      const starBox = (await star.boundingBox())!;
      const timeBox = (await time.boundingBox())!;
      const widths = await time.evaluate((el: HTMLElement) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return {
          min: 4.5 * parseFloat(getComputedStyle(el).fontSize),
          label: range.getBoundingClientRect().width
        };
      });
      minWidth = widths.min;
      labelWidths.push(widths.label);

      // A time box is at least 4.5em wide, so the stars of rows whose label
      // fits in 4.5em line up.
      // Only a label wider than that - in a wide system-ui face - grows its
      // own box, and moves that one row's star with it.
      expect(timeBox.width).toBeCloseTo(Math.max(widths.min, widths.label), 0);

      // Directly before the time column, separated by the row's gap only.
      const gap = timeBox.x - (starBox.x + starBox.width);
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThanOrEqual(7);

      rights.push(timeBox.x + timeBox.width);
    }
    // Not vacuous: at least one label is narrower than the column, so a box
    // sized to its label would be caught above.
    expect(Math.min(...labelWidths)).toBeLessThan(minWidth - 1);
    // Every label ends on the column's one right edge.
    expect(rights[1]).toBeCloseTo(rights[0], 0);
  } finally {
    // One server serves the whole run; later specs expect no favourites.
    for (const name of STARRED) {
      await toggleFavourite(page, name, 'Remove from Favorites');
    }
  }
});

test('DEF-PANE-379 - folded sections end on their band, below a line above the first band', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  const panel = page.locator(PANEL);
  await expect(
    panel.locator('.jp-AiAssistantsPanel-section').first()
  ).toBeVisible({ timeout: 15000 });
  // The folded state lives in this page's own localStorage.
  const open = panel.locator(
    '.jp-AiAssistantsPanel-sectionHeader[aria-expanded="true"]'
  );
  for (let i = await open.count(); i > 0; i--) {
    await open.first().click();
  }
  await expect(open).toHaveCount(0);

  const layout = await panel.evaluate((root: HTMLElement) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--jp-border-color3)';
    root.appendChild(probe);
    const border3 = getComputedStyle(probe).color;
    probe.remove();

    // Every full-width line any element of the panel draws, from its borders.
    const width = root.getBoundingClientRect().width;
    const lines: { y: number; width: number; colour: string }[] = [];
    for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      const r = el.getBoundingClientRect();
      if (Math.abs(r.width - width) > 1) {
        continue;
      }
      const s = getComputedStyle(el);
      const top = parseFloat(s.borderTopWidth);
      if (s.borderTopStyle !== 'none' && top > 0) {
        lines.push({ y: r.top, width: top, colour: s.borderTopColor });
      }
      const bottom = parseFloat(s.borderBottomWidth);
      if (s.borderBottomStyle !== 'none' && bottom > 0) {
        lines.push({
          y: r.bottom - bottom,
          width: bottom,
          colour: s.borderBottomColor
        });
      }
    }

    const sections = [
      ...root.querySelectorAll<HTMLElement>('.jp-AiAssistantsPanel-section')
    ].map(section => {
      const box = section.getBoundingClientRect();
      const header = section
        .querySelector<HTMLElement>('.jp-AiAssistantsPanel-sectionHeader')!
        .getBoundingClientRect();
      return {
        key: section.dataset.section,
        height: box.height,
        headerHeight: header.height
      };
    });
    const firstBand = root
      .querySelector<HTMLElement>('.jp-AiAssistantsPanel-sectionHeader')!
      .getBoundingClientRect().top;
    return {
      border3,
      sections,
      above: lines
        .filter(l => Math.round(l.y + l.width) === Math.round(firstBand))
        .map(l => `${l.width}px ${l.colour}`)
    };
  });

  // A folded section is its band plus its 1px bottom line, so the line sits
  // directly under the band - a folded All that grows puts it at the panel
  // bottom.
  expect(layout.sections.length).toBeGreaterThan(0);
  for (const section of layout.sections) {
    expect(section.height, `section ${section.key}`).toBeCloseTo(
      section.headerHeight + 1,
      1
    );
  }
  // The title band's own --jp-border-color2 rule equals the band colour in
  // dark themes, so a --jp-border-color3 line must stand above the first band.
  expect(layout.above).toContain(`1px ${layout.border3}`);
});

test('DEF-PANE-380 - an empty panel draws one line under the header', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'kimi');
  const panel = page.locator('#' + panelId('kimi'));
  await expect(
    panel.locator('.jp-AiAssistantsPanel-empty').first()
  ).toBeVisible({ timeout: 15000 });
  const probe = await panel.evaluate((root: HTMLElement) => {
    const body = root.querySelector<HTMLElement>('.jp-AiAssistantsPanel-body')!;
    const header = root.querySelector<HTMLElement>(
      '.jp-AiAssistantsPanel-header'
    )!;
    const b = getComputedStyle(body);
    return {
      bodyTopWidth: b.borderTopWidth,
      headerBottomWidth: getComputedStyle(header).borderBottomWidth,
      bodyTop: body.getBoundingClientRect().top,
      headerBottom: header.getBoundingClientRect().bottom
    };
  });
  expect(probe.bodyTopWidth).toBe('0px');
  expect(probe.headerBottomWidth).toBe('1px');
  expect(probe.bodyTop).toBeCloseTo(probe.headerBottom, 1);
});

test('ACC-PANE-183 - content stands 4px from the panel border on both sides', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  const panel = page.locator(PANEL);
  const box = (await panel.boundingBox())!;
  const left = box.x;
  const right = box.x + box.width;

  // The title is text, so it starts with the text under it - the section
  // labels and the row names - and not on the inset the carets and the status
  // dots stand on (DEF-PANE-285).
  const title = (await panel
    .locator('.jp-AiAssistantsPanel-title')
    .boundingBox())!;
  const label = (await page
    .locator(`${ALL} .jp-AiAssistantsPanel-sectionLabel`)
    .boundingBox())!;
  const name = (await page
    .locator(`${ALL} .jp-AiAssistantsPanel-name`)
    .first()
    .boundingBox())!;
  expect(title.x).toBeCloseTo(label.x, 0);
  expect(title.x).toBeCloseTo(name.x, 0);
  expect(title.x - left).toBeGreaterThan(INSET);

  const buttons = panel.locator(
    '.jp-AiAssistantsPanel-header .jp-AiAssistantsPanel-iconButton'
  );
  const lastButton = (await buttons.last().boundingBox())!;
  expect(right - (lastButton.x + lastButton.width)).toBeCloseTo(INSET, 0);

  // The search field shares the edges once the funnel reveals it.
  await panel.getByTitle('Filter sessions').click();
  const search = panel.locator('.jp-AiAssistantsPanel-search');
  await expect(search).toBeVisible();
  const searchBox = (await search.boundingBox())!;
  expect(searchBox.x - left).toBeCloseTo(INSET, 0);
  expect(right - (searchBox.x + searchBox.width)).toBeCloseTo(INSET, 0);
  await panel.getByTitle('Filter sessions').click();
  await expect(search).toBeHidden();

  const caret = (await page
    .locator(`${ALL} .jp-AiAssistantsPanel-caret`)
    .boundingBox())!;
  expect(caret.x - left).toBeCloseTo(INSET, 0);

  // The dot column, live or placeholder, shares the caret's edge; the time
  // column ends the inset short of the list's content edge - the list reserves
  // a scrollbar gutter beyond that, which this inset does not include.
  const list = page.locator(`${ALL} .jp-AiAssistantsPanel-list`);
  const contentRight = await list.evaluate((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return r.left + el.clientLeft + el.clientWidth;
  });
  const rows = list.locator('.jp-AiAssistantsPanel-row');
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const dot = (await row
      .locator(
        '.jp-AiAssistantsPanel-dot, .jp-AiAssistantsPanel-dotPlaceholder'
      )
      .first()
      .boundingBox())!;
    expect(dot.x - left).toBeCloseTo(INSET, 0);
    const time = (await row
      .locator('.jp-AiAssistantsPanel-rowTime')
      .boundingBox())!;
    expect(contentRight - (time.x + time.width)).toBeCloseTo(INSET, 0);
  }
});
