import { expect, test } from '@jupyterlab/galata';

import { PLUGIN_ID, waitForApplication } from './shared';

/**
 * DEF-PANE-331 - the AI Code Assistants form in JupyterLab's Settings Editor.
 *
 * The form ends an object with an Add item control whenever the schema's
 * `additionalProperties` is truthy, and a key added there is saved and never
 * read. The schema leaves the keyword out, so the form shows the declared
 * settings and nothing to add. The server's settings are used, not Galata's
 * in-page mock, so the schema on screen is the one the build shipped.
 */
test.use({ autoGoto: false, mockSettings: false, waitForApplication });

test('DEF-PANE-331 - the settings form shows every declared setting and no Add item control', async ({
  page
}) => {
  await page.goto();
  const { schema } = await (
    await page.request.get(`/lab/api/settings/${PLUGIN_ID}`)
  ).json();
  const titles = Object.values(schema.properties).map(
    (property: any) => property.title as string
  );
  expect(titles.length).toBeGreaterThan(0);

  // No value returned: the command resolves to the editor widget, which does
  // not serialise back to the test.
  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute('settingeditor:open', {
      query: 'AI Code Assistants'
    });
  });
  await page.locator(`.jp-PluginList-entry[data-id="${PLUGIN_ID}"]`).click();
  const form = page.locator('.jp-SettingsForm', {
    has: page.locator('.jp-SettingsHeader-title', {
      hasText: /^AI Code Assistants$/
    })
  });

  // The declared settings first: an Add item count of zero proves nothing
  // about a form that never rendered.
  for (const title of titles) {
    await expect(form.getByText(title, { exact: true }).first()).toBeVisible();
  }
  await expect(form.locator('button[title="Add item"]')).toHaveCount(0);

  // How this fails: put `additionalProperties: true` back in
  // `scripts/generate-schema.mjs` and the form draws the Add item button
  // after the last setting.
});
