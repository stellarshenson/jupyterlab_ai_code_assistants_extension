// Label derivations the panel shares with provider hooks.
//
// Keep this module import-free: a provider module may call into it from a
// hook, and the settings-schema generator loads the compiled provider barrel
// under plain Node - a single JupyterLab import here would break that.

/** The distinguishing part of a conversation id: its first eight characters
 * past `prefix`, the constant every id of the assistant carries
 * (`IProviderDescriptor.sessionIdPrefix`). Front-sliced when there is no
 * prefix, or when the id does not carry it. */
export function shortSessionId(sessionId: string, prefix?: string): string {
  const start = prefix && sessionId.startsWith(prefix) ? prefix.length : 0;
  return sessionId.slice(start, start + 8);
}
