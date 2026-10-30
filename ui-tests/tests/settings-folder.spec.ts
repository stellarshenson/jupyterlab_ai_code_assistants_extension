import * as fs from 'fs';
import * as path from 'path';

import { expect, test } from '@jupyterlab/galata';

import { PLUGIN_ID, setProviderEnabled, waitForApplication } from './shared';

/**
 * Saved settings after the npm package took its scoped name.
 *
 * JupyterLab keeps them at <user-settings>/<npm package name>/, so the rename
 * moved the folder. The server's settings are used, not Galata's in-page mock:
 * a save kept in the browser never reaches the file the server reads.
 */
test.use({ autoGoto: false, mockSettings: false, waitForApplication });

const SETTINGS_URL = `/lab/api/settings/${PLUGIN_ID}`;
const SCRATCH = String(process.env.JLAB_TEST_SCRATCH);
const SETTINGS_DIR = path.join(
  SCRATCH,
  'home',
  '.jupyter',
  'lab',
  'user-settings'
);
const SETTINGS_FILE = 'plugin.jupyterlab-settings';
const OLD_FILE = path.join(
  SETTINGS_DIR,
  'jupyterlab_ai_code_assistants_extension',
  SETTINGS_FILE
);
const NEW_FILE = path.join(
  SETTINGS_DIR,
  PLUGIN_ID.split(':')[0],
  SETTINGS_FILE
);
const MARKER = path.join(SCRATCH, 'state', 'migration.json');
const CARRIED_KEY = 'recentLimit';
// Not the schema's default of 10, so a value that was not carried cannot pass.
const CARRIED_VALUE = 37;
const UNDECLARED_KEY = 'providers.gemini.approvalMode';

/** The saved value of one key, as this window's registry holds it. */
const savedValue = (page: any, key: string): Promise<unknown> =>
  page.evaluate(
    async (args: { pluginId: string; key: string }) => {
      const registry = await (window as any).galata.getPlugin(
        '@jupyterlab/apputils-extension:settings'
      );
      return (await registry.get(args.pluginId, args.key)).user;
    },
    { pluginId: PLUGIN_ID, key }
  );

/** Forget that the old folder was carried; the other ids stay marked. */
const dropMarkerEntry = (): void => {
  if (fs.existsSync(MARKER)) {
    const marker = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
    marker.migrated = marker.migrated.filter(
      (id: string) => id !== 'settings-folder'
    );
    fs.writeFileSync(MARKER, JSON.stringify(marker));
  }
};

test('DEF-SERV-378 - a provider turned off through the registry is off on the server', async ({
  page
}) => {
  await page.goto();
  const sessions = () =>
    page.request.get(
      '/jupyterlab-ai-code-assistants-extension/providers/codex/sessions'
    );
  const { raw } = await (await page.request.get(SETTINGS_URL)).json();
  expect((await sessions()).status()).toBe(200);

  try {
    await setProviderEnabled(page, 'codex', false);
    const refused = await sessions();
    expect(refused.status()).toBe(404);
    expect(await refused.json()).toEqual({ error: 'provider_disabled' });
  } finally {
    await page.request.put(SETTINGS_URL, { data: { raw } });
  }
});

test('ACC-RETI-237 - values in the old folder reach the new one on the first load', async ({
  page
}) => {
  const seeded = JSON.stringify({
    [CARRIED_KEY]: CARRIED_VALUE,
    [UNDECLARED_KEY]: 'yolo'
  });
  const newFileBefore = fs.existsSync(NEW_FILE)
    ? fs.readFileSync(NEW_FILE)
    : null;

  try {
    fs.mkdirSync(path.dirname(OLD_FILE), { recursive: true });
    fs.writeFileSync(OLD_FILE, seeded);
    fs.rmSync(NEW_FILE, { force: true });
    dropMarkerEntry();

    await page.goto();

    await expect.poll(() => savedValue(page, CARRIED_KEY)).toBe(CARRIED_VALUE);
    expect(await savedValue(page, UNDECLARED_KEY)).toBeUndefined();
    const saved = fs.readFileSync(NEW_FILE, 'utf8');
    // The saved file carries comments, so it is read as text. The key's own
    // line starts with the quote; a comment line starts with //.
    expect(saved).toMatch(
      new RegExp(`^\\s*"${CARRIED_KEY}":\\s*${CARRIED_VALUE},?\\s*$`, 'm')
    );
    expect(saved).not.toContain(UNDECLARED_KEY);
    expect(fs.readFileSync(OLD_FILE, 'utf8')).toBe(seeded);
  } finally {
    fs.rmSync(path.dirname(OLD_FILE), { recursive: true, force: true });
    if (newFileBefore === null) {
      fs.rmSync(NEW_FILE, { force: true });
    } else {
      fs.writeFileSync(NEW_FILE, newFileBefore);
    }
    dropMarkerEntry();
  }
});
