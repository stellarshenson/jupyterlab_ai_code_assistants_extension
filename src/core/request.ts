import { URLExt } from '@jupyterlab/coreutils';

import { ServerConnection } from '@jupyterlab/services';

import { LOG_PREFIX } from './registry';

/** The server extension's API namespace. Every route lives under it. */
export const API_NAMESPACE = 'jupyterlab-ai-code-assistants-extension';

/**
 * DEF-72: how long a single server call may run before the client gives up.
 *
 * The number is not free to pick. `providers/codex.py` caps ONE `codex
 * archive` / `codex delete` invocation at `_CLI_TIMEOUT_S = 30`, so a Codex
 * disposal or fork can legitimately hold the server for thirty seconds. A
 * client ceiling at or below that would cut Codex silently on exactly the slow
 * path the server number was tuned for, so this sits a full CLI timeout above
 * it. Do not tune it down to the fast path.
 *
 * It bounds SINGLE-shot routes. Two server paths scale with N and can exceed
 * it honestly: a project DELETE runs one CLI invocation per conversation
 * (`CodexStore._dispose`, ~0.7s each measured, 30s each worst case), and a
 * sessions listing runs one `git` per project root capped at
 * `GIT_BRANCH_TIMEOUT_S = 2`. The `signal` hatch waives the ceiling for such a
 * caller, but no caller in `src/` passes one today - only `request.spec.ts`
 * exercises it. Measured, a project DELETE has to hold 86 conversations in one
 * project to breach at ~0.7s per Codex CLI invocation, or 858 at ~70ms, and a
 * breach costs a spurious toast rather than data: the server thread runs to
 * completion and the retry is idempotent.
 */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * DEF-72: the client gave up on a request before the server answered.
 *
 * A distinct type on purpose. `ServerConnection.NetworkError` means the server
 * is unreachable; this means it is reachable and slow, and a caller that
 * cannot tell the two apart cannot report either honestly - `isResponseStatus`
 * below exists for the same reason. An abort raised by a CALLER's own signal
 * is deliberately not this: it keeps the pre-existing `NetworkError` wrapping
 * and the caller reads its own `signal.aborted`, since only the caller knows
 * what its cancellation meant.
 */
export class RequestTimeoutError extends Error {
  constructor(
    readonly endPoint: string,
    readonly timeoutMs: number
  ) {
    super(`Request to ${endPoint} timed out after ${timeoutMs} ms`);
    this.name = 'RequestTimeoutError';
  }
}

/** True when the error is this client's own timeout rather than a dead server
 * or a refused response. Mirrors `isResponseStatus` so a caller branches on a
 * predicate rather than on an imported class. */
export function isRequestTimeout(err: unknown): boolean {
  return err instanceof RequestTimeoutError;
}

/**
 * Call the server extension.
 *
 * Bounded by {@link REQUEST_TIMEOUT_MS} unless `init.signal` is set, in which
 * case the caller owns cancellation entirely.
 *
 * @param endPoint API REST end point for the extension, relative to the
 *   extension namespace
 * @param serverSettings The server settings to use for the request
 * @param init Initial values for the request
 * @returns The response body interpreted as JSON
 * @throws RequestTimeoutError when the deadline passes before the server
 *   answers
 */
export async function requestAPI<T>(
  endPoint: string,
  serverSettings: ServerConnection.ISettings,
  init: RequestInit = {}
): Promise<T> {
  const requestUrl = URLExt.join(
    serverSettings.baseUrl,
    API_NAMESPACE,
    endPoint
  );

  // DEF-72: `ServerConnection.makeRequest` sets no deadline of its own, so
  // without this a wedged server holds the call for as long as the browser
  // will hold the socket. Hand-rolled rather than `AbortSignal.timeout`, which
  // the jsdom the Jest tier runs on does not define (measured: undefined,
  // while `AbortController` is present).
  const controller = init.signal ? undefined : new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (controller) {
    init = { ...init, signal: controller.signal };
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
  }

  let response: Response;
  let data: any;
  try {
    try {
      response = await ServerConnection.makeRequest(
        requestUrl,
        init,
        serverSettings
      );
    } catch (error) {
      throw new ServerConnection.NetworkError(error as any);
    }
    data = await response.text();
  } catch (error) {
    // The abort surfaces from whichever await was still pending - the fetch,
    // or the body read once the headers had already arrived. Both are the same
    // event to the caller, so both answer with the same error.
    if (timedOut) {
      throw new RequestTimeoutError(endPoint, REQUEST_TIMEOUT_MS);
    }
    throw error;
  } finally {
    // Both paths, so a fast response leaves no timer pending.
    clearTimeout(timer);
  }

  if (data.length > 0) {
    try {
      data = JSON.parse(data);
    } catch {
      console.log(`${LOG_PREFIX} Not a JSON response body.`, response);
    }
  }

  if (!response.ok) {
    throw new ServerConnection.ResponseError(response, data.message || data);
  }

  return data;
}

/** Build a provider-scoped path: `providers/<id>/<path>`. The id is encoded so
 * a malformed registration can never escape the namespace. */
export function providerPath(providerId: string, path: string): string {
  return `providers/${encodeURIComponent(providerId)}/${path}`;
}

/** Call a provider-scoped route. Every session, launch, colour and disposal
 * call goes through here, which is what keeps one provider's traffic out of
 * another's namespace. */
export async function requestProvider<T>(
  providerId: string,
  path: string,
  serverSettings: ServerConnection.ISettings,
  init: RequestInit = {}
): Promise<T> {
  return requestAPI<T>(providerPath(providerId, path), serverSettings, init);
}

/** Append a query string to a route path, skipping empty values. */
export function withQuery(
  path: string,
  params: Record<string, string | undefined>
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') {
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.length ? `${path}?${parts.join('&')}` : path;
}

/** True when the error is a server response carrying this status code - used
 * to tell "the conversation is gone" apart from "the server is unreachable". */
export function isResponseStatus(err: unknown, status: number): boolean {
  return (
    err instanceof ServerConnection.ResponseError &&
    err.response.status === status
  );
}
