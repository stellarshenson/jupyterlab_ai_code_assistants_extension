import { URLExt } from '@jupyterlab/coreutils';

import { ServerConnection } from '@jupyterlab/services';

/** The server extension's API namespace. Every route lives under it. */
export const API_NAMESPACE = 'jupyterlab-ai-code-assistants-extension';

/**
 * Call the server extension.
 *
 * @param endPoint API REST end point for the extension, relative to the
 *   extension namespace
 * @param serverSettings The server settings to use for the request
 * @param init Initial values for the request
 * @returns The response body interpreted as JSON
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

  let response: Response;
  try {
    response = await ServerConnection.makeRequest(
      requestUrl,
      init,
      serverSettings
    );
  } catch (error) {
    throw new ServerConnection.NetworkError(error as any);
  }

  let data: any = await response.text();

  if (data.length > 0) {
    try {
      data = JSON.parse(data);
    } catch (error) {
      console.log('Not a JSON response body.', response);
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
