// Launch-mode resolution: which single mode token, if any, one launch carries.
//
// Its own module because the panel is the only caller but not the only reader -
// the rule that one launch carries at most one mode is worth asserting on its
// own, and this file pulls in no JupyterLab surface.

import { ILaunchMode } from './types';

/** A resolved launch mode, with what to call it and whether to warn. */
export interface IResolvedLaunchMode {
  mode: ILaunchMode;
  /** What the menu should call it - the mode's own label. */
  label: string;
  /** Whether this widens what the assistant may do without asking. */
  unsafe: boolean;
}

/**
 * The single launch-mode token for one action, or undefined for a plain launch.
 *
 * The payload carries at most one mode, because the server maps one token to
 * one flag. `force` wins outright - that is what the menu's variant entries
 * do. Otherwise the first switch that is on fires. Every mode is a boolean
 * skip-approval switch, so "on" always means the same thing.
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
    if (values[mode.id] === true) {
      return mode.id;
    }
  }
  return undefined;
}

/**
 * The mode a PLAIN launch would carry right now, as a descriptor entry.
 *
 * The panel marks and labels its plain menu items from this. A mode left on in
 * settings applies to the plain items too, so deciding the warning glyph from
 * the menu's `force` argument instead puts it on the safer-looking of two
 * entries that build an identical launch - and leaves the one the user clicks
 * unmarked. Answers the entry rather than the token so the caller can use the
 * assistant's own wording.
 */
export function resolvedLaunchModeEntry(
  launchModes: ILaunchMode[],
  values: Record<string, boolean | string>
): IResolvedLaunchMode | null {
  const token = resolveLaunchMode(launchModes, values);
  if (!token) {
    return null;
  }
  const mode = launchModes.find(m => m.id === token);
  if (!mode) {
    return null;
  }
  // Carrying a menu label IS a boolean mode's declaration that it skips
  // approval - it is what puts a variant in the menu.
  return {
    mode,
    label: mode.menuLabel ?? mode.title,
    unsafe: !!mode.menuLabel
  };
}
