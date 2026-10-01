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

import { InputDialog, Notification } from '@jupyterlab/apputils';
import { nullTranslator } from '@jupyterlab/translation';
import { CommandRegistry } from '@lumino/commands';

import { CALLBACK_COMMAND, addCallbackCommand } from '../core/callback';
import { requestAPI } from '../core/request';

const request = requestAPI as jest.Mock;
const LINK = 'http://127.0.0.1:1455/auth/callback?code=one-time&state=s';

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

describe('the Open Callback command', () => {
  let success: jest.SpyInstance;
  let warning: jest.SpyInstance;
  let error: jest.SpyInstance;
  let dialog: jest.SpyInstance;

  beforeEach(() => {
    request.mockReset();
    success = jest.spyOn(Notification, 'success').mockReturnValue('' as any);
    warning = jest.spyOn(Notification, 'warning').mockReturnValue('' as any);
    error = jest.spyOn(Notification, 'error').mockReturnValue('' as any);
    dialog = jest.spyOn(InputDialog, 'getText');
  });

  afterEach(() => {
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

  it('asks for the link in a popup and posts it, trimmed, to the server', async () => {
    const { commands, serverSettings } = setup();
    dialog.mockResolvedValue({
      button: { accept: true },
      value: `  ${LINK}\n`
    } as any);
    request.mockResolvedValue({ status: 302 });

    await commands.execute(CALLBACK_COMMAND);

    expect(dialog).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('callback', serverSettings, {
      method: 'POST',
      body: JSON.stringify({ url: LINK })
    });
    expect(success).toHaveBeenCalledTimes(1);
    expect(String(success.mock.calls[0][0])).toContain('302');
  });

  it('takes the link as an argument without a popup', async () => {
    const { commands } = setup();
    request.mockResolvedValue({ status: 200 });

    await commands.execute(CALLBACK_COMMAND, { url: LINK });

    expect(dialog).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['cancelled', { button: { accept: false }, value: LINK }],
    ['left empty', { button: { accept: true }, value: '   ' }]
  ])('sends nothing when the popup is %s', async (_name, answer) => {
    const { commands } = setup();
    dialog.mockResolvedValue(answer as any);

    await commands.execute(CALLBACK_COMMAND);

    expect(request).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('says so when the login refused the callback', async () => {
    const { commands } = setup();
    request.mockResolvedValue({ status: 400 });

    await commands.execute(CALLBACK_COMMAND, { url: LINK });

    expect(success).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(String(warning.mock.calls[0][0])).toContain('400');
  });

  it.each([
    ['callback_not_loopback', '127.0.0.1'],
    ['callback_unreachable', 'No login is waiting'],
    ['Internal Server Error', 'Internal Server Error']
  ])('reports %s without repeating the link', async (code, expected) => {
    const { commands } = setup();
    request.mockRejectedValue(new Error(code));

    await commands.execute(CALLBACK_COMMAND, { url: LINK });

    expect(error).toHaveBeenCalledTimes(1);
    const message = String(error.mock.calls[0][0]);
    expect(message).toContain(expected);
    // The link carries a login code.
    expect(message).not.toContain('one-time');
  });
});
