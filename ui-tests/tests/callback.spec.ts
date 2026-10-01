import * as http from 'http';
import { AddressInfo } from 'net';

import { expect, test } from '@jupyterlab/galata';

import { waitForApplication } from './shared';

test.use({ autoGoto: false, waitForApplication });

/**
 * The whole path, nothing mocked: the popup, the extension's route, and a real
 * listener on the loopback of the machine the Jupyter server runs on - which
 * is where a CLI login waits for its redirect.
 */
test('Open Callback delivers a pasted link to the login waiting on the server', async ({
  page
}) => {
  const seen: string[] = [];
  const listener = http.createServer((request, response) => {
    seen.push(request.url ?? '');
    response.writeHead(302, { Location: '/success' });
    response.end();
  });
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as AddressInfo).port;
  const link = `http://127.0.0.1:${port}/auth/callback?code=one-time&state=s`;

  try {
    await page.goto();

    // Found by its name on the command palette.
    await page.keyboard.press('Control+Shift+C');
    await page.locator('.lm-CommandPalette-input').fill('Open Callback');
    const item = page.locator('.lm-CommandPalette-item', {
      hasText: 'Open Callback'
    });
    await expect(item).toHaveCount(1);
    await item.click();

    const dialog = page.locator('.jp-Dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('input').fill(link);
    await dialog.locator('.jp-mod-accept').click();

    await expect(
      page.locator('.Toastify__toast', { hasText: 'Callback delivered' })
    ).toBeVisible({ timeout: 15000 });
    // One request, as pasted, and the redirect to /success not followed.
    expect(seen).toEqual(['/auth/callback?code=one-time&state=s']);
  } finally {
    await new Promise(resolve => listener.close(resolve));
  }
});
