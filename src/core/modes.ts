// Launch-mode resolution: which single mode token, if any, one launch carries.
//
// Its own module because the panel is the only caller but not the only reader -
// the precedence between a boolean switch and an enum ladder is a rule worth
// asserting on its own, and this file pulls in no JupyterLab surface.

import { ILaunchMode } from './types';

/**
 * The single launch-mode token for one action, or undefined for a plain launch.
 *
 * The payload carries at most one mode, because the server maps one token to
 * one flag. `force` wins outright - that is what the menu's variant entries
 * do. Otherwise an enum mode moved off its default takes precedence over any
 * boolean switch: the enum is the explicit statement of intent, so a boolean
 * left on must not silently invert it. A boolean fires only while every enum
 * mode sits at its default. An enum at its default sends nothing - it is what
 * the CLI would do unasked.
 */
export function resolveLaunchMode(
  launchModes: ILaunchMode[],
  values: Record<string, boolean | string>,
  force?: string
): string | undefined {
  if (force) {
    return force;
  }
  for (const mode of launchModes) {
    const value = values[mode.id];
    if (
      mode.kind !== 'boolean' &&
      typeof value === 'string' &&
      value &&
      value !== mode.default
    ) {
      return `${mode.id}=${value}`;
    }
  }
  for (const mode of launchModes) {
    if (mode.kind === 'boolean' && values[mode.id] === true) {
      return mode.id;
    }
  }
  return undefined;
}
