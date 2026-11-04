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
    probe.style.color = 'var(--jp-layout-color3)';
    root.appendChild(probe);
    const layoutColor3 = getComputedStyle(probe).color;
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
      layoutColor3,
      sections,
      above: lines
        .filter(l => Math.round(l.y + l.width) === Math.round(firstBand))
        .map(l => `${l.width}px ${l.colour}`)
    };
  });

  // A folded section with a section below it is its band plus its 1px bottom
  // line; the last has nothing below, so it is its band alone (DEF-PANE-382).
  expect(layout.sections.length).toBeGreaterThan(0);
  layout.sections.forEach((section, index) => {
    expect(section.height, `section ${section.key}`).toBeCloseTo(
      index === layout.sections.length - 1
        ? section.headerHeight
        : section.headerHeight + 1,
      1
    );
  });
  // The title band's own --jp-border-color2 rule equals the band colour in
  // dark themes, so a --jp-layout-color3 line must stand above the first band.
  expect(layout.above).toContain(`1px ${layout.layoutColor3}`);
});

test('DEF-PANE-382 - only two adjacent bands take a dividing line', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  // Favorites exists only once a row is starred, and it renders above All.
  for (const name of STARRED) {
    await toggleFavourite(page, name, 'Add to Favorites');
  }
  try {
    const panel = page.locator(PANEL);
    const favourites = panel.locator(
      '.jp-AiAssistantsPanel-section[data-section="favourites"]'
    );
    await expect(favourites).toBeVisible({ timeout: 15000 });

    // Expanded, the section ends in rows on the panel fill: no line above
    // them.
    await expect(favourites).toHaveCSS('border-bottom-width', '0px');

    // Folded, its band sits directly above the next section's band - one fill,
    // so it takes the one-fill-step line.
    await favourites.locator('.jp-AiAssistantsPanel-sectionHeader').click();
    await expect(favourites).toHaveCSS('border-bottom-width', '1px');
    const layoutColor3 = await panel.evaluate((root: HTMLElement) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--jp-layout-color3)';
      root.appendChild(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    });
    await expect(favourites).toHaveCSS('border-bottom-color', layoutColor3);
  } finally {
    // One server serves the whole run; later specs expect no favourites.
    for (const name of STARRED) {
      await toggleFavourite(page, name, 'Remove from Favorites');
    }
  }
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

  // A shown filter suppresses the section separator: the header keeps the
  // base --jp-border-color2 line, so the guard in style/base.css must not
  // paint --jp-layout-color3 here. Probing the token, not the header's line
  // before the filter: in Galaxa Steel light the two tokens resolve equal.
  const divider = await panel.evaluate((root: HTMLElement) => {
    const probe = document.createElement('span');
    root.appendChild(probe);
    probe.style.color = 'var(--jp-border-color2)';
    const border = getComputedStyle(probe).color;
    probe.remove();
    const header = root.querySelector<HTMLElement>(
      '.jp-AiAssistantsPanel-header'
    )!;
    return { border, headerBorder: getComputedStyle(header).borderBottomColor };
  });
  expect(divider.headerBorder).toBe(divider.border);

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

test('DEF-PANE-383 - the section count takes the meta ink', async ({
  page
}) => {
  await page.goto();
  await openPanelTab(page, 'claude');

  const header = page
    .locator(PANEL)
    .locator('.jp-AiAssistantsPanel-sectionHeader')
    .first();
  await expect(header).toBeVisible({ timeout: 15000 });

  const probe = await header.evaluate((el: HTMLElement) => {
    const label = el.querySelector<HTMLElement>(
      '.jp-AiAssistantsPanel-sectionLabel'
    );
    const count = el.querySelector<HTMLElement>(
      '.jp-AiAssistantsPanel-sectionCount'
    );
    // The theme tokens as the browser resolves them, read off a probe element
    // rather than the elements under test.
    const token = document.createElement('span');
    el.appendChild(token);
    token.style.color = 'var(--jp-ui-font-color2)';
    const meta = getComputedStyle(token).color;
    token.style.color = 'var(--jp-ui-font-color1)';
    const ink = getComputedStyle(token).color;
    token.remove();
    return {
      hasLabel: label !== null,
      hasCount: count !== null,
      labelColour: label ? getComputedStyle(label).color : '',
      countColour: count ? getComputedStyle(count).color : '',
      meta,
      ink,
      labelRight: label?.getBoundingClientRect().right ?? NaN,
      countLeft: count?.getBoundingClientRect().left ?? NaN
    };
  });

  expect(probe.hasLabel).toBe(true);
  expect(probe.hasCount).toBe(true);
  expect(probe.countColour).toBe(probe.meta);
  expect(probe.labelColour).toBe(probe.ink);
  expect(probe.labelColour).not.toBe(probe.countColour);
  // The label rect already includes its glyph advance, so the gap is the
  // count's 6px margin-left.
  const gap = probe.countLeft - probe.labelRight;
  expect(gap).toBeCloseTo(6, 0);
});

test("DEF-PANE-384 - a hovered row takes three quarters of the band's fill", async ({
  page
}) => {
  // Tall enough for the 13 seeded All rows, so the list does not scroll and
  // the no-scrollbar case the owner reported is the one under test.
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto();
  await openPanelTab(page, 'claude');

  const row = page.locator(`${ALL} .jp-AiAssistantsPanel-row`).first();
  await expect(row).toBeVisible({ timeout: 15000 });

  // The theme tokens as the browser resolves them, read off a probe span
  // rather than the row under test.
  const tokens = await row.evaluate((el: HTMLElement) => {
    const probe = document.createElement('span');
    el.appendChild(probe);
    const read = (name: string) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    };
    const values = {
      row: read('--jp-layout-color1'),
      band: read('--jp-layout-color2'),
      selected: read('--jp-layout-color3')
    };
    probe.remove();
    return values;
  });

  // The rule under test is `color-mix(in srgb, var(--jp-layout-color2) 75%,
  // var(--jp-layout-color1))`: three quarters of the band over the row's own
  // fill. Compute it here from the probe values, allowing rounding per
  // channel. Chrome serialises a color-mix result as `color(srgb 0..1 ...)`,
  // while a plain token reads `rgb(0..255 ...)`, so scale the former.
  const rgb = (value: string) => {
    const scale = value.startsWith('color(srgb') ? 255 : 1;
    return value
      .match(/\d+(?:\.\d+)?/g)!
      .slice(0, 3)
      .map(channel => Number(channel) * scale);
  };
  const rowRgb = rgb(tokens.row);
  const expected = rgb(tokens.band).map((channel, i) =>
    Math.round(0.75 * channel + 0.25 * rowRgb[i])
  );
  const isMix = (value: string) =>
    rgb(value).every((channel, i) => Math.abs(channel - expected[i]) <= 1);

  await row.hover();
  // The hover fill comes from a stylesheet rule, so poll until the pointer
  // state has been applied.
  await expect
    .poll(async () =>
      isMix(
        await row.evaluate(
          (el: HTMLElement) => getComputedStyle(el).backgroundColor
        )
      )
    )
    .toBe(true);
  const hovered = await row.evaluate(
    (el: HTMLElement) => getComputedStyle(el).backgroundColor
  );

  const hoverRgb = rgb(hovered);
  const differs = (other: number[]) =>
    hoverRgb.some((channel, i) => Math.abs(channel - other[i]) > 2);

  expect(isMix(hovered)).toBe(true);
  expect(differs(rgb(tokens.band))).toBe(true);
  expect(differs(rgb(tokens.selected))).toBe(true);

  // ACC-PANE-241-HOVER-WIDTH: no scrollbar gutter is reserved, so with no
  // scrollbar showing the fill reaches the panel edge. A list that scrolls
  // gives up only the scrollbar's own strip.
  const widths = await row.evaluate((el: HTMLElement) => {
    const list = el.closest('.jp-AiAssistantsPanel-list') as HTMLElement;
    const root = el.closest('.jp-AiAssistantsPanel') as HTMLElement;
    return {
      row: el.getBoundingClientRect().width,
      rowRight: el.getBoundingClientRect().right,
      list: list.clientWidth,
      listRight: list.getBoundingClientRect().right,
      rootRight: root.getBoundingClientRect().right,
      noScrollbar: list.scrollHeight <= list.clientHeight,
      gutter: getComputedStyle(list).scrollbarGutter
    };
  });
  expect(widths.noScrollbar).toBe(true);
  expect(widths.gutter).toBe('auto');
  expect(widths.row).toBeCloseTo(widths.list, 0);
  expect(Math.abs(widths.listRight - widths.rootRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(widths.rowRight - widths.rootRight)).toBeLessThanOrEqual(1);
});
