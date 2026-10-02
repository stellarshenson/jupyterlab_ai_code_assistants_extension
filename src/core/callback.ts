import { JupyterFrontEnd } from '@jupyterlab/application';
import { Dialog, ICommandPalette, Notification } from '@jupyterlab/apputils';
import { TranslationBundle } from '@jupyterlab/translation';
import { Widget } from '@lumino/widgets';

import { requestAPI } from './request';

/** The command that delivers a pasted login callback link. */
export const CALLBACK_COMMAND = 'open:callback';

/** How long the popup stays open after it has shown what a send came to. */
const CLOSE_DELAY_MS = 3000;

/** What a delivery came to, in words for the user. Never the link, which
 * carries a login code, and never a status code. */
interface IOutcome {
  level: 'success' | 'warning' | 'error';
  message: string;
}

async function deliver(
  url: string,
  app: JupyterFrontEnd,
  trans: TranslationBundle
): Promise<IOutcome> {
  try {
    const answer = await requestAPI<{ status: number }>(
      'callback',
      app.serviceManager.serverSettings,
      { method: 'POST', body: JSON.stringify({ url }) }
    );
    return answer.status < 400
      ? {
          level: 'success',
          message: trans.__(
            'The login accepted the link. Check the terminal where the login is running.'
          )
        }
      : {
          level: 'warning',
          message: trans.__(
            'The login did not accept this link. Start the login again and paste the new link.'
          )
        };
  } catch (err) {
    const code = err instanceof Error ? err.message : '';
    return {
      level: 'error',
      message:
        code === 'callback_not_loopback'
          ? trans.__(
              'This link cannot be used. It must start with http://127.0.0.1 or http://localhost.'
            )
          : code === 'callback_unreachable'
            ? trans.__(
                'No login is waiting for this link. Start the login again and paste the new link.'
              )
            : trans.__(
                'The link could not be sent to the Jupyter server. Try again.'
              )
    };
  }
}

/** The popup's body: the link field and, below it, what the last send came
 * to. */
class CallbackForm extends Widget {
  constructor(trans: TranslationBundle) {
    super();
    this.addClass('jp-AiAssistantsCallback');
    const label = document.createElement('label');
    label.textContent = trans.__('Callback link from the browser address bar');
    this._input = document.createElement('input');
    this._input.type = 'text';
    this._input.className = 'jp-mod-styled';
    this._input.placeholder = 'http://127.0.0.1:1455/auth/callback?code=...';
    label.appendChild(this._input);
    this._status = document.createElement('div');
    this._status.className = 'jp-AiAssistantsCallback-status';
    this._status.setAttribute('role', 'status');
    this.node.append(label, this._status);
  }

  get url(): string {
    return this._input.value.trim();
  }

  report(level: IOutcome['level'] | 'pending', message: string): void {
    this._status.dataset.level = level;
    this._status.textContent = message;
  }

  private _input: HTMLInputElement;
  private _status: HTMLDivElement;
}

/** OK sends the link and leaves the window open, so the result is read in the
 * same place. The window then closes by itself after `CLOSE_DELAY_MS`. One
 * window sends one link: the login code in it works once, and a second send
 * of the same link fails a login the first send completed. Close and Escape
 * end the window at once. */
class CallbackDialog extends Dialog<void> {
  constructor(
    private _form: CallbackForm,
    private _send: (url: string) => Promise<IOutcome>,
    private _trans: TranslationBundle
  ) {
    super({
      title: _trans.__('Open Callback'),
      body: _form,
      buttons: [
        Dialog.cancelButton({ label: _trans.__('Close') }),
        Dialog.okButton({ label: _trans.__('OK') })
      ],
      defaultButton: 1,
      focusNodeSelector: 'input'
    });
  }

  resolve(index?: number): void {
    if (index === 0) {
      super.resolve(index);
      return;
    }
    void this._deliver();
  }

  private async _deliver(): Promise<void> {
    const url = this._form.url;
    if (this._sent) {
      return;
    }
    if (!url) {
      this._form.report('error', this._trans.__('Paste the link first.'));
      return;
    }
    this._sent = true;
    this._form.report('pending', this._trans.__('Sending the link...'));
    const outcome = await this._send(url);
    if (!this.isDisposed) {
      this._form.report(outcome.level, outcome.message);
      // A no-op when Close has already ended the window.
      window.setTimeout(() => this.reject(), CLOSE_DELAY_MS);
    }
  }

  private _sent = false;
}

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
            description: 'The callback link. Asked for in a popup when absent.'
          }
        }
      }
    },
    execute: async args => {
      const send = (url: string): Promise<IOutcome> => deliver(url, app, trans);
      const given = typeof args.url === 'string' ? args.url.trim() : '';
      if (given) {
        // No popup to write into, so the result is a toast.
        const outcome = await send(given);
        Notification[outcome.level](outcome.message, {
          autoClose: outcome.level === 'success' ? 4000 : 8000
        });
        return;
      }
      await new CallbackDialog(new CallbackForm(trans), send, trans).launch();
    }
  });
  palette?.addItem({ command: CALLBACK_COMMAND, category });
}
