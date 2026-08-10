/**
 * The deadline on the shared request helper (DEF-72).
 *
 * `ServerConnection.makeRequest` sets no timeout, so before this the extension
 * had no upper bound on a single call at all - a wedged server held the panel
 * for as long as the browser held the socket. That is what turned DEF-55's
 * cleanup modal into a trap, and it is the prerequisite the DEF-30 deferral
 * named: nothing can be safely chained behind a request that never ends.
 *
 * Three properties are asserted here because each of them is a way the fix can
 * be silently wrong rather than absent: the deadline is the number claimed and
 * not merely "a timer"; the resulting error is TELLABLE APART from a dead
 * server, or a caller cannot report either honestly; and a caller that brings
 * its own signal is left alone, which is the escape hatch for the bulk routes
 * whose server-side cost scales with N.
 *
 * `makeRequest` is spied rather than `fetch` stubbed: the point under test is
 * the helper's own abort wiring, and going through the real `handleRequest`
 * would drag jsdom's fetch surface into it without exercising a line of it.
 */

import { ServerConnection } from '@jupyterlab/services';

import {
  REQUEST_TIMEOUT_MS,
  RequestTimeoutError,
  isRequestTimeout,
  requestAPI
} from '../core/request';

const SETTINGS = {
  baseUrl: 'http://localhost:8888/'
} as ServerConnection.ISettings;

/** The error jsdom's `AbortController` raises, matching what a real fetch
 * rejects with when its signal fires. */
function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** A response body that satisfies everything `requestAPI` reads off it. */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    text: async () => JSON.stringify(body)
  } as unknown as Response;
}

let makeRequest: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  makeRequest = jest.spyOn(ServerConnection, 'makeRequest');
});

afterEach(() => {
  makeRequest.mockRestore();
  jest.useRealTimers();
});

/** Resolve to the thrown error rather than letting it escape - `rejects`
 * matchers and `advanceTimersByTime` do not compose, because the timer has to
 * be advanced while the call is still in flight. */
function capture(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    value => value,
    error => error
  );
}

describe('requestAPI deadline', () => {
  it('aborts a hung request and reports a timeout, not a dead server', async () => {
    makeRequest.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(abortError()));
        })
    );

    const result = capture(requestAPI('sessions', SETTINGS));

    // One millisecond short of the deadline the call is still open. Without
    // this the test would pass against any timeout at all, including one so
    // short it would cut a legitimate Codex disposal.
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(makeRequest).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    const error = await result;

    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect(isRequestTimeout(error)).toBe(true);
    expect(error).not.toBeInstanceOf(ServerConnection.NetworkError);
    expect((error as RequestTimeoutError).endPoint).toBe('sessions');
    expect((error as RequestTimeoutError).timeoutMs).toBe(REQUEST_TIMEOUT_MS);
  });

  it('states the deadline as sixty seconds, a full CLI timeout above codex', () => {
    // `providers/codex.py` caps one `codex archive` / `codex delete` at
    // `_CLI_TIMEOUT_S = 30`. A client ceiling at or below that breaks Codex
    // branching silently, so the margin is the assertion, not the constant.
    expect(REQUEST_TIMEOUT_MS).toBe(60000);
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it('aborts a hang that starts after the headers arrived', async () => {
    // fetch resolves on headers, so a body that never finishes is a second,
    // distinct way to hang - and it has to answer with the same error.
    makeRequest.mockImplementation(async (_url: string, init: RequestInit) => {
      return {
        ok: true,
        text: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(abortError()));
          })
      } as unknown as Response;
    });

    const result = capture(requestAPI('sessions', SETTINGS));
    await Promise.resolve();
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);

    expect(await result).toBeInstanceOf(RequestTimeoutError);
  });

  it('leaves no timer pending after a fast response', async () => {
    makeRequest.mockResolvedValue(jsonResponse({ sessions: [] }));

    await expect(requestAPI('sessions', SETTINGS)).resolves.toEqual({
      sessions: []
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('leaves no timer pending after a failed request', async () => {
    makeRequest.mockRejectedValue(new TypeError('Failed to fetch'));

    const error = await capture(requestAPI('sessions', SETTINGS));

    expect(error).toBeInstanceOf(ServerConnection.NetworkError);
    expect(isRequestTimeout(error)).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('requestAPI with a caller-supplied signal', () => {
  it('passes the caller signal through untouched and arms no deadline', async () => {
    const controller = new AbortController();
    makeRequest.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(abortError()));
        })
    );

    const result = capture(
      requestAPI('sessions', SETTINGS, { signal: controller.signal })
    );

    // Identity compared as a boolean rather than through `toBe`: on failure
    // jest deep-copies both sides to build the diff, and deep-copying a live
    // `AbortSignal` aborts the node process outright, which would hide the
    // very regression this line exists to catch.
    const passed = makeRequest.mock.calls[0][1].signal === controller.signal;
    expect(passed).toBe(true);
    expect(jest.getTimerCount()).toBe(0);

    // Well past the default deadline, and the call is still the caller's to
    // end. This is the escape hatch for the routes whose server-side cost
    // scales with N - a project disposal is one CLI invocation per
    // conversation, so no single constant can bound it.
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS * 10);
    await Promise.resolve();
    expect(makeRequest).toHaveBeenCalledTimes(1);

    controller.abort();
    const error = await result;

    // The caller's own cancellation is not this helper's timeout. It keeps the
    // pre-existing `NetworkError` wrapping - deliberately unchanged, because
    // the caller holds the controller and reads `signal.aborted` to tell its
    // own cancellation from a server that died mid-call.
    expect(isRequestTimeout(error)).toBe(false);
    expect(error).toBeInstanceOf(ServerConnection.NetworkError);
    expect(controller.signal.aborted).toBe(true);
  });

  it('still resolves normally when the caller signal never fires', async () => {
    const controller = new AbortController();
    makeRequest.mockResolvedValue(jsonResponse({ ok: true }));

    await expect(
      requestAPI('sessions', SETTINGS, { signal: controller.signal })
    ).resolves.toEqual({ ok: true });
  });
});
