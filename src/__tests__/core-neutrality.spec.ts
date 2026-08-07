/**
 * No assistant is named in `src/core/`.
 *
 * The architecture rests on it: adding or removing an assistant must touch one
 * provider module and one barrel line, never a core file. A single `if (id ===
 * 'claude')` is enough to break that promise, and it would never show up as a
 * failing behaviour test - so the source itself is the assertion.
 *
 * Comments are stripped before the scan: the core is allowed to EXPLAIN why an
 * assistant needed a capability flag, it is just not allowed to branch on one.
 */

import * as fs from 'fs';
import * as path from 'path';

// Every id the registry ships, plus the names of the retired extensions they
// were ported from.
const ASSISTANT_NAMES = /claude|codex|kimi|gemini|moonshot|anthropic/i;

const CORE_DIR = path.resolve(__dirname, '..', 'core');

/** Drop block and line comments, leaving code and string literals. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[^\n]*?\/\/.*$/gm, line =>
      // Keep the part before a trailing `//`, so code on a commented line is
      // still scanned - but drop a whole-line comment entirely.
      line.slice(0, line.indexOf('//'))
    );
}

function coreFiles(): string[] {
  return fs
    .readdirSync(CORE_DIR)
    .filter(name => name.endsWith('.ts'))
    .map(name => path.join(CORE_DIR, name));
}

describe('the core names no assistant', () => {
  it('has core files to scan at all', () => {
    // Guards against the scan passing because it found nothing to read.
    expect(coreFiles().length).toBeGreaterThan(3);
  });

  it.each(coreFiles().map(file => [path.basename(file), file]))(
    '%s carries no assistant name outside comments',
    (_name: string, file: string) => {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const offenders = code
        .split('\n')
        .map((line, index) => [index + 1, line] as [number, string])
        .filter(([, line]) => ASSISTANT_NAMES.test(line));
      expect(offenders).toEqual([]);
    }
  );

  it('reaches every assistant through the registry, not by name', () => {
    // A core file importing a provider module directly is the same failure in
    // a different shape, and the regex above would not catch a relative path.
    for (const file of coreFiles()) {
      const code = fs.readFileSync(file, 'utf8');
      expect(code).not.toMatch(/from\s+'(\.\.\/)+providers/);
    }
  });
});

describe('the comment-stripping the scan relies on', () => {
  it('drops a whole-line comment', () => {
    expect(stripComments('// claude is the base\nconst x = 1;')).not.toMatch(
      ASSISTANT_NAMES
    );
  });

  it('drops a block comment', () => {
    expect(
      stripComments('/** ported from claude */\nconst x = 1;')
    ).not.toMatch(ASSISTANT_NAMES);
  });

  it('keeps code that a trailing comment sits beside', () => {
    expect(stripComments("const id = 'claude'; // the base")).toMatch(
      ASSISTANT_NAMES
    );
  });
});
