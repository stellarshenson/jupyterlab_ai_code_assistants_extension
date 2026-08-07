/**
 * Menu-label truncation.
 *
 * Lumino sets no `max-width` on a menu item label, so an uncapped
 * auto-generated title stretches a submenu across the window. The budget is in
 * display COLUMNS, not characters: 60 Han glyphs measure at or above the width
 * that filed the defect, while 60 Latin ones are half that.
 */

import {
  MENU_TITLE_COLUMNS,
  branchMenuLabel,
  shortSessionId,
  truncateToColumns
} from '../providers/kimi';

describe('truncateToColumns', () => {
  it('leaves a short label alone, with no ellipsis', () => {
    expect(truncateToColumns('Refactor the panel', 60)).toEqual(
      'Refactor the panel'
    );
  });

  it('counts a wide glyph as two columns', () => {
    const han = '会'.repeat(40);
    const cut = truncateToColumns(han, 10);
    // Five glyphs fit in ten columns; the sixth would overflow.
    expect(cut).toEqual('会'.repeat(5) + '…');
  });

  it('counts a Latin character as one column', () => {
    expect(truncateToColumns('abcdefghij', 5)).toEqual('abcde…');
  });

  it('never splits an astral character into a lone surrogate', () => {
    // An emoji is two code units and two columns: cutting by code unit would
    // leave half a surrogate pair, which paints as the replacement glyph.
    const cut = truncateToColumns('😀😀😀', 5);
    expect(cut).toEqual('😀😀…');
    expect(cut).not.toContain('�');
    // Two emoji plus the ellipsis, counted by code point.
    expect([...cut]).toHaveLength(3);
  });

  it('drops a trailing space so the ellipsis hugs the last word', () => {
    expect(truncateToColumns('one two three', 8)).toEqual('one two…');
  });

  it('bounds a label at exactly the budget', () => {
    const cut = truncateToColumns('x'.repeat(200), MENU_TITLE_COLUMNS);
    expect(cut).toHaveLength(MENU_TITLE_COLUMNS + 1);
  });

  it('handles an empty label', () => {
    expect(truncateToColumns('', 60)).toEqual('');
  });
});

describe('shortSessionId', () => {
  it('slices past the prefix every conversation shares', () => {
    // The core front-slice would render the constant `session_` for every
    // conversation of a project - the exact thing the short id exists to tell
    // apart.
    expect(
      shortSessionId('session_9f8e7d6c-1111-2222-3333-444455556666')
    ).toEqual('9f8e7d6c');
  });

  it('front-slices an id that carries no prefix', () => {
    expect(shortSessionId('9f8e7d6c-1111-2222-3333-444455556666')).toEqual(
      '9f8e7d6c'
    );
  });
});

describe('branchMenuLabel', () => {
  it('keeps the id beside a truncated title', () => {
    const title = '会'.repeat(100);
    const label = branchMenuLabel(title, '9f8e7d6c');
    expect(label.endsWith(' (9f8e7d6c)')).toBe(true);
    // Branches of one project share a path, so the id is what tells them
    // apart - only the title may be trimmed.
    expect(label).toContain('…');
  });

  it('drops the bracketed id when the title already is the id', () => {
    expect(branchMenuLabel('9f8e7d6c', '9f8e7d6c')).toEqual('9f8e7d6c');
  });
});
