import { expect, test } from '@jupyterlab/galata';

import { AVAILABLE, waitForApplication } from './shared';

/**
 * Don't load JupyterLab webpage before running the tests.
 * This is required to ensure we capture all log messages.
 */
test.use({ autoGoto: false, waitForApplication });

test('should emit an activation console message', async ({ page }) => {
  const logs: string[] = [];

  page.on('console', message => {
    logs.push(message.text());
  });

  await page.goto();

  expect(
    logs.filter(
      s =>
        s ===
        'JupyterLab extension jupyterlab_ai_code_assistants_extension is activated!'
    )
  ).toHaveLength(1);
});

test('should log how many assistant panels docked', async ({ page }) => {
  const logs: string[] = [];

  page.on('console', message => {
    logs.push(message.text());
  });

  await page.goto();

  // The count is the extension's own summary of the reconcile: as many panels
  // as there are providers with a binary on PATH.
  expect(
    logs.filter(s =>
      s.includes(
        `[jupyterlab_ai_code_assistants_extension] ${AVAILABLE.length} of `
      )
    ).length
  ).toBeGreaterThan(0);
});
