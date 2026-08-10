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

import { IProviderDescriptor } from '../core/types';
import { PROVIDERS } from '../providers';

/**
 * Names the roster carries that no descriptor field spells out - the vendors
 * behind the assistants. A core file branching on `anthropic` or `moonshot` is
 * the same violation as one branching on `claude`, and neither word can be
 * derived, so this is the one list that still has to be maintained by hand.
 */
const VENDOR_ALIASES = ['anthropic', 'moonshot'];

/**
 * Label words that name the CATEGORY rather than the assistant. `Claude Code`
 * contributes `claude`; `code` on its own appears in every core file (
 * `charCodeAt`, `encodedPath`) and as a name would flag all of them.
 */
const GENERIC_LABEL_WORDS = new Set([
  'ai',
  'assistant',
  'assistants',
  'cli',
  'code',
  'sessions'
]);

/**
 * Every word that names an assistant, read off the registry rather than typed
 * out here.
 *
 * This used to be a literal `claude|codex|kimi|gemini` regex, which is a guard
 * that ages out of its own invariant: a fifth provider joins the barrel, no
 * one remembers this file, and the scan then walks straight past a core file
 * branching on the new id. Deriving the list means the guard grows with the
 * roster - see the `nimbus` case below, which is exactly that scenario.
 */
function namesFrom(descriptors: IProviderDescriptor[]): string[] {
  const names = new Set(VENDOR_ALIASES);
  for (const descriptor of descriptors) {
    names.add(descriptor.id);
    names.add(descriptor.cliBinary);
    if (descriptor.legacyPluginId) {
      names.add(descriptor.legacyPluginId);
    }
    for (const word of descriptor.label.split(/\s+/)) {
      const lower = word.toLowerCase();
      if (lower && !GENERIC_LABEL_WORDS.has(lower)) {
        names.add(lower);
      }
    }
  }
  return [...names].filter(Boolean).sort();
}

/** One alternation over the roster, matched case-insensitively - a core file
 * writing `Gemini` is as much a violation as one writing `gemini`. */
function namePattern(names: string[]): RegExp {
  const escaped = names.map(name =>
    name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  return new RegExp(escaped.join('|'), 'i');
}

const ASSISTANT_NAMES = namePattern(
  namesFrom(PROVIDERS.map(module => module.descriptor))
);

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

/** Lines of `source` that name an assistant, as `[line number, text]`. */
function offenders(source: string, pattern: RegExp): [number, string][] {
  return stripComments(source)
    .split('\n')
    .map((line, index) => [index + 1, line] as [number, string])
    .filter(([, line]) => pattern.test(line));
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
      const code = fs.readFileSync(file, 'utf8');
      expect(offenders(code, ASSISTANT_NAMES)).toEqual([]);
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

describe('the name list the scan runs on', () => {
  it('is the registry read at run time, not a list frozen into this file', () => {
    // The one assertion that fails if someone puts the literal alternation
    // back: a frozen list names today's four assistants and silently stops
    // covering the fifth, which is the whole failure this guard exists to
    // prevent from happening to the core.
    expect(ASSISTANT_NAMES.source.split('|').sort()).toEqual(
      namesFrom(PROVIDERS.map(module => module.descriptor))
    );
  });

  it('covers every assistant the barrel ships', () => {
    for (const module of PROVIDERS) {
      expect(module.descriptor.id).toMatch(ASSISTANT_NAMES);
      expect(module.descriptor.label).toMatch(ASSISTANT_NAMES);
    }
  });

  it('keeps the retired extensions, whose names no descriptor spells out', () => {
    for (const vendor of VENDOR_ALIASES) {
      expect(vendor).toMatch(ASSISTANT_NAMES);
    }
  });

  it('drops the label words that name the category, not the assistant', () => {
    // `Claude Code` must not put `code` on the list - it appears in the core
    // as `charCodeAt` and `encodedPath`, and would flag every file.
    expect('const c = s.charCodeAt(i);').not.toMatch(ASSISTANT_NAMES);
  });

  it('grows with the roster instead of ageing out of it', () => {
    // The whole point of deriving the list. A fifth provider joins the barrel
    // and a core file branches on its id: the derived list flags that line,
    // the frozen one this guard used to carry walks straight past it.
    const nimbus: IProviderDescriptor = {
      ...PROVIDERS[0].descriptor,
      id: 'nimbus',
      label: 'Nimbus',
      cliBinary: 'nimbus',
      legacyPluginId: undefined
    };
    const line = "if (provider.id === 'nimbus') {";
    const withNimbus = namePattern(
      namesFrom([...PROVIDERS.map(module => module.descriptor), nimbus])
    );
    expect(offenders(line, withNimbus)).toHaveLength(1);
    // Same line, roster as it stands today - unseen, which is the defect.
    expect(offenders(line, ASSISTANT_NAMES)).toEqual([]);
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
