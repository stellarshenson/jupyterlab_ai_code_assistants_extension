import * as http from 'http';
import { AddressInfo } from 'net';
import * as path from 'path';

import { expect, test } from '@jupyterlab/galata';

import { waitForApplication } from './shared';

test.use({ autoGoto: false, waitForApplication });

/** Screenshots land beside the run's other artefacts, in the port-keyed
 * `test-results/<port>` the config already owns and sweeps. */
const shotPath = (name: string): string =>
  path.join(test.info().project.outputDir, 'screenshots', `${name}.png`);

/**
 * The whole path, nothing mocked: the popup, the extension's route, and a real
 * listener on the loopback of the machine the Jupyter server runs on - which
 * is where a CLI login waits for its redirect.
 */
test('Open Callback delivers a pasted link to the login waiting on the server', async ({
  page
}) => {
  // Shaped like the Codex listener: the callback redirects to the closing
  // page, and the request for that page is what ends the login.
  const seen: string[] = [];
  const listener = http.createServer((request, response) => {
    const url = request.url ?? '';
    seen.push(url);
    if (url.startsWith('/auth/callback')) {
      response.writeHead(302, { Location: '/success' });
    } else {
      response.writeHead(200);
    }
    response.end();
  });
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as AddressInfo).port;
  const link = `http://127.0.0.1:${port}/auth/callback?code=one-time&state=s`;

  try {
    await page.goto();

    const dialog = page.locator('.jp-Dialog');
    // Found by its name on the command palette.
    const openPopup = async (): Promise<void> => {
      await page.keyboard.press('Control+Shift+C');
      await page.locator('.lm-CommandPalette-input').fill('Open Callback');
      const item = page.locator('.lm-CommandPalette-item', {
        hasText: 'Open Callback'
      });
      await expect(item).toHaveCount(1);
      await item.click();
      await expect(dialog).toBeVisible();
    };

    await openPopup();
    const field = dialog.locator('.jp-AiAssistantsCallback input');
    const status = dialog.locator('.jp-AiAssistantsCallback-status');
    const ok = dialog.locator('.jp-mod-accept');

    // Wide: a callback link runs to about 250 characters.
    expect((await field.boundingBox())!.width).toBeGreaterThanOrEqual(600);

    // A link the server refuses. The reason is written under the field, in
    // words, and the popup then closes by itself, 3 s later.
    await field.fill('http://listener.invalid/auth/callback?code=one-time');
    await ok.click();
    await expect(status).toHaveText(
      'This link cannot be used. It must start with http://127.0.0.1 or http://localhost.'
    );
    await expect(dialog).toBeVisible();
    expect(seen).toEqual([]);
    await page.screenshot({ path: shotPath('callback-refused') });
    await expect(dialog).toHaveCount(0, { timeout: 10000 });

    await openPopup();
    await field.fill(link);
    await ok.click();
    await expect(status).toHaveText(
      'The login accepted the link. Check the terminal where the login is running.',
      { timeout: 15000 }
    );
    // Told in the popup, which is still open, and not in a toast.
    await expect(dialog).toBeVisible();
    await expect(page.locator('.Toastify__toast')).toHaveCount(0);
    // The link as pasted, then the closing page it redirects to. Each once.
    expect(seen).toEqual(['/auth/callback?code=one-time&state=s', '/success']);
    await page.screenshot({ path: shotPath('callback-accepted') });

    // Nobody clicks Close: the popup ends itself.
    await expect(dialog).toHaveCount(0, { timeout: 10000 });
  } finally {
    await new Promise(resolve => listener.close(resolve));
  }
});
