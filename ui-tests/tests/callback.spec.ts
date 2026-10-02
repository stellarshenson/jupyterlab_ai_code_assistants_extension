import * as path from 'path';

import { expect, test } from '@jupyterlab/galata';

import { FakeCodexLogin } from './fake-codex-login';
import { waitForApplication } from './shared';

test.use({ autoGoto: false, waitForApplication });

/**
 * The Open Callback command against a login shaped like OpenAI Codex's.
 *
 * Nothing between the popup and the login is mocked: the popup, the
 * extension's route on the Jupyter server, and a listener on that server's
 * own loopback - which is where a CLI login waits for its redirect. The
 * listener is the fake in `fake-codex-login.ts`. It issues the link a browser
 * would be sent to, and each test delivers that link through the popup.
 */

const ACCEPTED =
  'The login accepted the link. Check the terminal where the login is running.';
const NOT_ACCEPTED =
  'The login did not accept this link. Start the login again and paste the new link.';
const NO_LOGIN =
  'No login is waiting for this link. Start the login again and paste the new link.';
const NOT_LOOPBACK =
  'This link cannot be used. It must start with http://127.0.0.1 or http://localhost.';

/** The popup closes by itself 3 s after its result. */
const CLOSES = { timeout: 10000 };

/** Screenshots land beside the run's other artefacts, in the port-keyed
 * `test-results/<port>` the config already owns and sweeps. */
const shotPath = (name: string): string =>
  path.join(test.info().project.outputDir, 'screenshots', `${name}.png`);

let login: FakeCodexLogin;

test.beforeEach(async () => {
  login = new FakeCodexLogin();
  await login.start();
});

test.afterEach(async () => {
  await login.stop();
});

/** Open the popup from the command palette, by the command's name. */
async function openPopup(page: any): Promise<any> {
  await page.keyboard.press('Control+Shift+C');
  await page.locator('.lm-CommandPalette-input').fill('Open Callback');
  const item = page.locator('.lm-CommandPalette-item', {
    hasText: 'Open Callback'
  });
  await expect(item).toHaveCount(1);
  await item.click();
  const dialog = page.locator('.jp-Dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Paste a link, press OK, and return what the Jupyter server answered the
 * browser. */
async function send(
  page: any,
  dialog: any,
  link: string
): Promise<{ status: number; body: unknown }> {
  const answered = page.waitForResponse(
    (response: any) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/callback')
  );
  await dialog.locator('.jp-AiAssistantsCallback input').fill(link);
  await dialog.locator('.jp-mod-accept').click();
  const response = await answered;
  return { status: response.status(), body: await response.json() };
}

const statusLine = (dialog: any): any =>
  dialog.locator('.jp-AiAssistantsCallback-status');

test('Open Callback completes a Codex login: the callback, then the closing page', async ({
  page
}) => {
  await page.goto();
  const dialog = await openPopup(page);

  // Wide: a callback link runs to about 250 characters.
  const field = dialog.locator('.jp-AiAssistantsCallback input');
  expect((await field.boundingBox())!.width).toBeGreaterThanOrEqual(600);

  const answer = await send(page, dialog, login.link);
  await expect(statusLine(dialog)).toHaveText(ACCEPTED, { timeout: 15000 });

  // The handshake. First the link as pasted, on which the login exchanged
  // the code. Then the address the login redirected to, which is the request
  // that ends it. Each once.
  const pasted = new URL(login.link);
  expect(login.seen).toHaveLength(2);
  expect(login.seen[0]).toBe(pasted.pathname + pasted.search);
  expect(login.seen[1]).toContain(`/success?id_token=${login.idToken}`);
  expect(login.tokensSaved).toBe(true);
  expect(login.ended).toBe(true);

  // The browser is told the last status and nothing else: the token in the
  // redirect address stays on the server.
  expect(answer).toEqual({ status: 200, body: { status: 200 } });

  // Told in the popup, which is still open, and not in a toast.
  await expect(dialog).toBeVisible();
  await expect(page.locator('.Toastify__toast')).toHaveCount(0);
  await page.screenshot({ path: shotPath('callback-accepted') });

  // Nobody clicks Close: the popup ends itself.
  await expect(dialog).toHaveCount(0, CLOSES);
  expect(await page.content()).not.toContain(login.idToken);
});

test('the same link sent again finds the login gone and reaches nothing', async ({
  page
}) => {
  await page.goto();
  let dialog = await openPopup(page);
  await send(page, dialog, login.link);
  await expect(statusLine(dialog)).toHaveText(ACCEPTED, { timeout: 15000 });
  await expect(dialog).toHaveCount(0, CLOSES);

  // The code in the link works once, and the login it belonged to has ended.
  dialog = await openPopup(page);
  const answer = await send(page, dialog, login.link);
  await expect(statusLine(dialog)).toHaveText(NO_LOGIN);
  expect(answer).toEqual({
    status: 502,
    body: { error: 'callback_unreachable' }
  });
  expect(login.seen).toHaveLength(2);
  await expect(dialog).toHaveCount(0, CLOSES);
});

test('a link from an older login attempt is not accepted, and the login keeps waiting', async ({
  page
}) => {
  await page.goto();
  let dialog = await openPopup(page);

  const answer = await send(page, dialog, login.staleLink);
  await expect(statusLine(dialog)).toHaveText(NOT_ACCEPTED);
  expect(answer).toEqual({ status: 200, body: { status: 400 } });
  expect(login.seen).toHaveLength(1);
  expect(login.tokensSaved).toBe(false);
  expect(login.ended).toBe(false);
  await expect(dialog).toHaveCount(0, CLOSES);

  // The login was not spent by the refusal: its own link still completes it.
  dialog = await openPopup(page);
  await send(page, dialog, login.link);
  await expect(statusLine(dialog)).toHaveText(ACCEPTED, { timeout: 15000 });
  expect(login.ended).toBe(true);
  await expect(dialog).toHaveCount(0, CLOSES);
});

test('a link that is not loopback is refused before any request', async ({
  page
}) => {
  await page.goto();
  const dialog = await openPopup(page);

  const answer = await send(
    page,
    dialog,
    'http://listener.invalid/auth/callback?code=one-time'
  );
  await expect(statusLine(dialog)).toHaveText(NOT_LOOPBACK);
  expect(answer).toEqual({
    status: 400,
    body: { error: 'callback_not_loopback' }
  });
  expect(login.seen).toEqual([]);
  await page.screenshot({ path: shotPath('callback-refused') });
  await expect(dialog).toHaveCount(0, CLOSES);
});
