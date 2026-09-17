// Label derivations of the panel: pure string functions, kept free of
// JupyterLab imports so the unit tests load them without the panel's DOM.

/** The distinguishing part of a conversation id: its first eight characters
 * past `prefix`, the constant every id of the assistant carries
 * (`IProviderDescriptor.sessionIdPrefix`). Front-sliced when there is no
 * prefix, or when the id does not carry it. */
export function shortSessionId(sessionId: string, prefix?: string): string {
  const start = prefix && sessionId.startsWith(prefix) ? prefix.length : 0;
  return sessionId.slice(start, start + 8);
}

// Lumino sets no `max-width` on `.lm-Menu-itemLabel`, so an uncapped
// auto-generated conversation title stretches a submenu across the window.
// Budget is in COLUMNS, not characters. Han, Kana, Hangul and emoji render at
// roughly one em against Latin's half, so counting characters bounds nothing:
// 60 Han glyphs measured 851-862px in a real Lumino submenu, at or above the
// 850px that filed the defect in the first place. An assistant whose titles
// are model-generated makes a wide-script title the expected case.
export const MENU_TITLE_COLUMNS = 60;

// East Asian Wide and Fullwidth ranges, plus emoji. Deliberately coarse: this
// bounds a menu width, so a handful of mis-classified glyphs cost pixels, not
// correctness. Anything outside these ranges counts as one column.
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul Compat, CJK Compat
  [0x3400, 0x4dbf], // CJK Unified Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe6f], // CJK Compatibility Forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1faff], // Emoji and pictographs
  [0x20000, 0x3fffd] // CJK Unified Extensions B and beyond
];

function isWide(codePoint: number): boolean {
  return WIDE_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
}

/** Trim `text` to `maxColumns` display columns, appending an ellipsis when
 * anything was cut. Iterates by CODE POINT, so an astral character is never
 * split into a lone surrogate (which chromium paints as the replacement
 * glyph). Returns `text` unchanged when it already fits. */
export function truncateToColumns(text: string, maxColumns: number): string {
  let columns = 0;
  let kept = '';
  for (const ch of text) {
    const width = isWide(ch.codePointAt(0) as number) ? 2 : 1;
    if (columns + width > maxColumns) {
      // The cut can land just after a space; drop it so the ellipsis hugs the
      // last word. `trimEnd` is ES2019 and this project targets ES2018.
      return `${kept.replace(/\s+$/, '')}…`;
    }
    columns += width;
    kept += ch;
  }
  return text;
}

/** Menu-item label for one branch: the conversation title trimmed to the
 * column budget, followed by the short session id. Only the TITLE is trimmed -
 * branches of one project share a path, so the id is what tells them apart and
 * it must survive. The bracketed id is dropped when the title already IS the
 * id (the server's last-resort fallback), which can never be truncated since a
 * short id is at most 8 characters. */
export function branchMenuLabel(label: string, shortId: string): string {
  const title = truncateToColumns(label, MENU_TITLE_COLUMNS);
  return label === shortId ? title : `${title} (${shortId})`;
}
