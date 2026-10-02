import { randomBytes } from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';

const token = (): string => randomBytes(16).toString('hex');

/**
 * A stand-in for the listener an OpenAI Codex login waits on.
 *
 * Modelled on a codex-cli 0.160.0 login observed on 2026-10-02, and on the
 * messages in that CLI's own file:
 *
 * - the login issues a `state` and waits on the loopback for
 *   `/auth/callback?code=...&scope=...&state=...`
 * - on that request it exchanges the code, which works once, saves the tokens
 *   and answers 302 to an absolute `/success?id_token=...` address on the
 *   same listener
 * - only the request for `/success` ends the login: the page is served and
 *   the listener closes
 *
 * The real listener owns port 1455, shared by every Codex terminal on the
 * machine. This one takes a free port, so a test never meets a real login.
 * The statuses of its two refusals are this fake's choice: the route under
 * test only tells a status below 400 from one at or above it.
 */
export class FakeCodexLogin {
  /** Each request the listener received, path and query, in order. */
  readonly seen: string[] = [];
  /** The token the login puts in the address it redirects to. */
  readonly idToken = token();
  /** True once the code was exchanged: the tokens are on disk from then. */
  tokensSaved = false;
  /** True once `/success` was served and the listener closed. */
  ended = false;

  async start(): Promise<void> {
    await new Promise<void>(resolve =>
      this._server.listen(0, '127.0.0.1', resolve)
    );
    const port = (this._server.address() as AddressInfo).port;
    this._origin = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    if (this._server.listening) {
      await new Promise(resolve => this._server.close(resolve));
    }
  }

  /** The address the browser is sent to after sign-in. On another machine
   * the page fails to load, and this is what stays in the address bar. */
  get link(): string {
    return this._link(this._state);
  }

  /** The same address from an earlier login attempt: its state is not this
   * login's. */
  get staleLink(): string {
    return this._link(token());
  }

  private _link(state: string): string {
    const query = new URLSearchParams({
      code: this._code,
      scope: 'openid profile email offline_access',
      state
    });
    return `${this._origin}/auth/callback?${query}`;
  }

  private _handle(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): void {
    const url = new URL(request.url ?? '/', this._origin);
    this.seen.push(url.pathname + url.search);
    const answer = (status: number, body: string): void => {
      response.writeHead(status, { 'Content-Type': 'text/html' });
      response.end(body);
    };
    if (url.pathname === '/auth/callback') {
      if (url.searchParams.get('state') !== this._state) {
        answer(400, 'State mismatch');
      } else if (
        url.searchParams.get('code') !== this._code ||
        this.tokensSaved
      ) {
        answer(500, 'Token exchange failed');
      } else {
        this.tokensSaved = true;
        const query = new URLSearchParams({
          id_token: this.idToken,
          needs_setup: 'false',
          org_id: '',
          project_id: '',
          plan_type: 'plus',
          platform_url: 'https://platform.openai.com'
        });
        response.writeHead(302, {
          Location: `${this._origin}/success?${query}`
        });
        response.end();
      }
    } else if (url.pathname === '/success') {
      answer(200, '<div class="title">Signed in to Codex</div>');
      this.ended = true;
      this._server.close();
    } else {
      answer(404, 'Not found');
    }
  }

  private _server = http.createServer((request, response) =>
    this._handle(request, response)
  );
  private _origin = '';
  private _state = token();
  private _code = token();
}
