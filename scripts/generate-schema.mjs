// Emit schema/plugin.json from the provider registry.
//
// The settings schema must list exactly the registered providers, so adding an
// assistant adds its toggle and its launch-mode settings without a hand edit.
// This reads the compiled barrel (`lib/providers/index.js`), which is why
// provider modules keep their descriptors as plain data and their module scope
// free of side effects - the barrel has to be importable outside a browser.
//
// Run after `tsc`:  jlpm generate:schema

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const providersDir = join(root, 'lib', 'providers');
const target = join(root, 'schema', 'plugin.json');

// The Recent-section bounds have ONE home - `src/core/limits.ts`. Read the
// compiled module (import-free, so Node can load it) instead of restating the
// numbers here, where they would drift from the clamp the panel applies.
const { DEFAULT_RECENT_LIMIT, MIN_RECENT_LIMIT, MAX_RECENT_LIMIT } =
  await import(pathToFileURL(join(root, 'lib', 'core', 'limits.js')).href);

/** Settings shared by every panel - the part that is not per provider. */
const SHARED = {
  presentationMode: {
    type: 'string',
    title: 'Presentation mode',
    description:
      "How session rows are labelled, in every assistant's panel. `name` (default) shows the session name the assistant records for the project; the initial name is the project folder name, then the path is walked up to disambiguate when two projects share a folder name. `path` shows the project path relative to the JupyterLab notebook root (absolute if outside it).",
    enum: ['name', 'path'],
    default: 'name'
  },
  recentLimit: {
    type: 'integer',
    title: 'Recent items count',
    description:
      'Number of sessions listed in the Recent section, sorted by last activity (descending). The section displays up to 10 rows and scrolls for the rest.',
    default: DEFAULT_RECENT_LIMIT,
    minimum: MIN_RECENT_LIMIT,
    maximum: MAX_RECENT_LIMIT
  },
  colouredTabs: {
    type: 'boolean',
    title: 'Coloured terminal tabs',
    description:
      "When enabled (default), a terminal running an assistant has its dock tab tinted with that conversation's colour. Turning it off clears the tint and stops it being applied. Requires `jupyterlab_colourful_tab_extension`; without it there is no tint either way.",
    default: true
  },
  sidebar: {
    type: 'string',
    title: 'Sidebar position',
    description:
      'Which JupyterLab sidebar to dock the assistant panels to. `right` (default) keeps them clear of the file browser. `left` puts them next to it.',
    enum: ['left', 'right'],
    default: 'right'
  }
};

function providerProperties(descriptor) {
  const props = {};
  props[`providers.${descriptor.id}.enabled`] = {
    type: 'boolean',
    title: `${descriptor.label}: enabled`,
    description: `Show the ${descriptor.panelTitle} panel. A panel appears only when this is on AND the \`${descriptor.cliBinary}\` binary is on PATH.`,
    default: true
  };
  for (const mode of descriptor.launchModes ?? []) {
    const key = `providers.${descriptor.id}.${mode.id}`;
    props[key] = {
      type: mode.kind === 'boolean' ? 'boolean' : 'string',
      title: `${descriptor.label}: ${mode.title}`,
      description: mode.description,
      default: mode.default
    };
    if (mode.kind === 'enum' && mode.values) {
      props[key].enum = [...mode.values];
    }
  }
  return props;
}

// The compiled barrel uses extensionless relative imports, which webpack
// resolves but Node ESM refuses - so glob the provider modules directly.
// Same registry contract: a module in providers/ IS the registration.
const files = (await readdir(providersDir))
  .filter(f => f.endsWith('.js') && f !== 'index.js')
  .sort();
const PROVIDERS = [];
for (const f of files) {
  const mod = await import(pathToFileURL(join(providersDir, f)).href);
  if (mod.descriptor) {
    PROVIDERS.push({ descriptor: mod.descriptor });
  }
}

// The barrel is the RUNTIME registry; this glob is a second one. A module the
// barrel does not export still gets a settings toggle here - a panel-less
// provider whose settings section promises one - so the two counts are
// asserted equal rather than assumed. Read as text, because the compiled
// barrel's extensionless imports are resolvable by webpack but not by Node.
const barrel = await readFile(join(providersDir, 'index.js'), 'utf8');
const exported = new Set(
  [...barrel.matchAll(/from\s+["']\.\/([A-Za-z0-9_-]+)["']/g)].map(m => m[1])
);
if (exported.size !== PROVIDERS.length) {
  throw new Error(
    `providers/index.ts exports ${exported.size} module(s) but ` +
      `lib/providers holds ${PROVIDERS.length} - a provider dropped from the ` +
      'barrel would still get a settings toggle. Fix the barrel.'
  );
}

const schema = {
  title: 'AI Code Assistants',
  description:
    'One settings section for every AI code assistant panel. Generated from the provider registry by `jlpm generate:schema` - edit the provider descriptors, not this file.',
  type: 'object',
  'jupyter.lab.setting-icon':
    'jupyterlab_ai_code_assistants_extension:assistants',
  'jupyter.lab.setting-icon-label': 'AI Code Assistants',
  properties: { ...SHARED },
  // Open, deliberately: a provider removed from the barrel leaves its saved
  // key behind in the user's settings, and that leftover must be inert rather
  // than a validation failure.
  additionalProperties: true
};

for (const module of PROVIDERS) {
  Object.assign(schema.properties, providerProperties(module.descriptor));
}

await writeFile(target, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
console.log(
  `schema/plugin.json written for ${PROVIDERS.length} provider(s): ${PROVIDERS.map(
    m => m.descriptor.id
  ).join(', ')}`
);
