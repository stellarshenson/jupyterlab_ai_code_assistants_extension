/**
 * The Open Callback command: a pasted login callback link, handed to the
 * server. The server's side - loopback only, one request, nothing logged - is
 * `tests/test_callback.py`; this is the popup, the request and what the user
 * is told.
 */

// ESM-only packages that JupyterLab's apputils pulls in and jest cannot parse.
jest.mock('@jupyter/react-components', () => ({}));
jest.mock('@jupyter/web-components', () => ({
  addJupyterLabThemeChangeListener: () => undefined,
  applyJupyterTheme: () => undefined,
  jpButton: () => undefined,
  jpToolbar: () => undefined,
  provideJupyterDesignSystem: () => ({ register: () => undefined })
}));
jest.mock('../core/request', () => ({
  requestAPI: jest.fn()
}));

import { Notification } from '@jupyterlab/apputils';
import { nullTranslator } from '@jupyterlab/translation';
import { CommandRegistry } from '@lumino/commands';

import { CALLBACK_COMMAND, addCallbackCommand } from '../core/callback';
import { requestAPI } from '../core/request';

const request = requestAPI as jest.Mock;
const LINK = 'http://127.0.0.1:1455/auth/callback?code=one-time&state=s';

/** One macrotask: `Dialog.launch` attaches the popup after its own awaits. */
const settle = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 0));

function setup(): {
  commands: CommandRegistry;
  added: { command: string; category: string }[];
  serverSettings: object;
} {
  const commands = new CommandRegistry();
  const serverSettings = {};
  const added: { command: string; category: string }[] = [];
  addCallbackCommand(
    { commands, serviceManager: { serverSettings } } as any,
    { addItem: (item: any) => added.push(item) } as any,
    'AI Assistants',
    nullTranslator.load('test')
  );
  return { commands, added, serverSettings };
}

interface IPopup {
  /** Settles when the popup has closed. */
  closed: Promise<unknown>;
  input: HTMLInputElement;
  status: HTMLElement;
  ok: HTMLElement;
  close: HTMLElement;
}

async function openPopup(commands: CommandRegistry): Promise<IPopup> {
  const closed = commands.execute(CALLBACK_COMMAND);
  await settle();
  const node = document.querySelector('.jp-Dialog') as HTMLElement;
  return {
    closed,
    input: node.querySelector(
      '.jp-AiAssistantsCallback input'
    ) as HTMLInputElement,
    status: node.querySelector(
      '.jp-AiAssistantsCallback-status'
    ) as HTMLElement,
    ok: node.querySelector('.jp-mod-accept') as HTMLElement,
    close: node.querySelector('.jp-mod-reject') as HTMLElement
  };
}

/** No status code, no server error code and never the link, which carries a
 * login code. */
function expectPlainWords(text: string): void {
  expect(text).not.toMatch(
    /callback_|HTTP|\b[45]\d\d\b|Internal Server Error|one-time/
  );
}

describe('the Open Callback command', () => {
  let success: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    request.mockReset();
    success = jest.spyOn(Notification, 'success').mockReturnValue('' as any);
    error = jest.spyOn(Notification, 'error').mockReturnValue('' as any);
  });

  afterEach(async () => {
    // A popup left open would hold every later one in JupyterLab's queue.
    (
      document.querySelector('.jp-Dialog .jp-mod-reject') as HTMLElement
    )?.click();
    await settle();
    jest.restoreAllMocks();
  });

  it('is on the command palette under the assistants category', () => {
    const { commands, added } = setup();
    expect(commands.hasCommand(CALLBACK_COMMAND)).toBe(true);
    expect(commands.label(CALLBACK_COMMAND)).toBe('Open Callback');
    expect(added).toEqual([
      { command: CALLBACK_COMMAND, category: 'AI Assistants' }
    ]);
  });

  it('registers without a palette', () => {
    const commands = new CommandRegistry();
    addCallbackCommand(
      { commands, serviceManager: { serverSettings: {} } } as any,
      null,
      'AI Assistants',
      nullTranslator.load('test')
    );
    expect(commands.hasCommand(CALLBACK_COMMAND)).toBe(true);
  });

  it('OK sends the trimmed link and writes the result under the field, window still open', async () => {
    const { commands, serverSettings } = setup();
    request.mockResolvedValue({ status: 302 });
    const popup = await openPopup(commands);

    popup.input.value = `  ${LINK}\n`;
    popup.ok.click();
    await settle();

    expect(request).toHaveBeenCalledWith('callback', serverSettings, {
      method: 'POST',
      body: JSON.stringify({ url: LINK })
    });
    expect(popup.status.dataset.level).toBe('success');
    expect(popup.status.textContent).toContain('The login accepted the link');
    expectPlainWords(popup.status.textContent ?? '');
    // Read in the popup, not in a toast, and the popup is still there.
    expect(success).not.toHaveBeenCalled();
    expect(document.querySelector('.jp-Dialog')).not.toBeNull();

    popup.close.click();
    await popup.closed;
    expect(document.querySelector('.jp-Dialog')).toBeNull();
  });

  it('Enter in the field sends, as OK does', async () => {
    const { commands } = setup();
    request.mockResolvedValue({ status: 200 });
    const popup = await openPopup(commands);

    popup.input.value = LINK;
    popup.input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    await settle();

    expect(request).toHaveBeenCalledTimes(1);
    expect(popup.status.dataset.level).toBe('success');
  });

  it('a refused link is replaced and sent again in the same window', async () => {
    const { commands } = setup();
    request
      .mockRejectedValueOnce(new Error('callback_unreachable'))
      .mockResolvedValueOnce({ status: 302 });
    const popup = await openPopup(commands);

    popup.input.value = LINK;
    popup.ok.click();
    await settle();
    expect(popup.status.dataset.level).toBe('error');

    popup.input.value = LINK.replace('one-time', 'second');
    popup.ok.click();
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    expect(popup.status.dataset.level).toBe('success');
  });

  it('OK on an empty field sends nothing and says so', async () => {
    const { commands } = setup();
    const popup = await openPopup(commands);

    popup.input.value = '   ';
    popup.ok.click();
    await settle();

    expect(request).not.toHaveBeenCalled();
    expect(popup.status.textContent).toBe('Paste the link first.');
  });

  it('Close sends nothing', async () => {
    const { commands } = setup();
    const popup = await openPopup(commands);

    popup.input.value = LINK;
    popup.close.click();
    await popup.closed;

    expect(request).not.toHaveBeenCalled();
    expect(document.querySelector('.jp-Dialog')).toBeNull();
  });

  it.each([
    [
      'the login answers with an error',
      () => Promise.resolve({ status: 400 }),
      'warning',
      'The login did not accept this link'
    ],
    [
      'the link is not a loopback link',
      () => Promise.reject(new Error('callback_not_loopback')),
      'error',
      'It must start with http://127.0.0.1 or http://localhost'
    ],
    [
      'no login is listening',
      () => Promise.reject(new Error('callback_unreachable')),
      'error',
      'No login is waiting for this link'
    ],
    [
      'the server fails',
      () => Promise.reject(new Error('Internal Server Error')),
      'error',
      'The link could not be sent to the Jupyter server'
    ]
  ])('says in plain words that %s', async (_case, answer, level, expected) => {
    const { commands } = setup();
    request.mockImplementation(answer);
    const popup = await openPopup(commands);

    popup.input.value = LINK;
    popup.ok.click();
    await settle();

    expect(popup.status.dataset.level).toBe(level);
    expect(popup.status.textContent).toContain(expected);
    expectPlainWords(popup.status.textContent ?? '');
  });

  it('given the link as an argument, opens no popup and reports in a toast', async () => {
    const { commands } = setup();
    request.mockRejectedValue(new Error('callback_unreachable'));

    await commands.execute(CALLBACK_COMMAND, { url: LINK });

    expect(document.querySelector('.jp-Dialog')).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expectPlainWords(String(error.mock.calls[0][0]));
  });
});
