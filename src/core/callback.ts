import { JupyterFrontEnd } from '@jupyterlab/application';
import {
  ICommandPalette,
  InputDialog,
  Notification
} from '@jupyterlab/apputils';
import { TranslationBundle } from '@jupyterlab/translation';

import { requestAPI } from './request';

/** The command that delivers a pasted login callback link. */
export const CALLBACK_COMMAND = 'open:callback';

/**
 * Register the command that sends a pasted login callback link to the login
 * waiting on the Jupyter server.
 *
 * A CLI login waits for its OAuth redirect on the server's own loopback, but
 * the browser that follows the redirect runs on the user's machine, where that
 * address is another host - so the page fails to load, with the link left in
 * the address bar. Pasted here, the server makes the request instead.
 */
export function addCallbackCommand(
  app: JupyterFrontEnd,
  palette: ICommandPalette | null,
  category: string,
  trans: TranslationBundle
): void {
  app.commands.addCommand(CALLBACK_COMMAND, {
    label: trans.__('Open Callback'),
    caption: trans.__(
      'Send a pasted login callback link to the login waiting on the Jupyter server'
    ),
    describedBy: {
      args: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The callback link. Asked for in a dialog when absent.'
          }
        }
      }
    },
    execute: async args => {
      let url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!url) {
        const asked = await InputDialog.getText({
          title: trans.__('Open Callback'),
          label: trans.__('Callback link from the browser address bar'),
          placeholder: 'http://127.0.0.1:1455/auth/callback?code=...'
        });
        url = asked.button.accept ? (asked.value ?? '').trim() : '';
        if (!url) {
          return;
        }
      }
      try {
        const answer = await requestAPI<{ status: number }>(
          'callback',
          app.serviceManager.serverSettings,
          { method: 'POST', body: JSON.stringify({ url }) }
        );
        if (answer.status < 400) {
          Notification.success(
            trans.__(
              'Callback delivered - the login answered HTTP %1.',
              answer.status
            ),
            { autoClose: 4000 }
          );
        } else {
          Notification.warning(
            trans.__(
              'The login refused the callback (HTTP %1). Start the login again and paste the new link.',
              answer.status
            ),
            { autoClose: 8000 }
          );
        }
      } catch (err) {
        // The server's own codes, never the link: it carries a login code.
        const code = err instanceof Error ? err.message : String(err);
        const message =
          code === 'callback_not_loopback'
            ? trans.__(
                'Only an http link to 127.0.0.1 or localhost can be opened.'
              )
            : code === 'callback_unreachable'
              ? trans.__(
                  'No login is waiting at that address. Start the login again and paste the new link.'
                )
              : trans.__('Could not open the callback: %1', code);
        Notification.error(message, { autoClose: 8000 });
      }
    }
  });
  palette?.addItem({ command: CALLBACK_COMMAND, category });
}
