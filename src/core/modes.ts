// Launch-mode resolution: which single mode token, if any, one launch carries.
//
// Its own module because the panel is the only caller but not the only reader -
// the precedence between a boolean switch and an enum ladder is a rule worth
// asserting on its own, and this file pulls in no JupyterLab surface.

import { ILaunchMode } from './types';

/** A resolved launch mode, with what to call it and whether to warn. */
export interface IResolvedLaunchMode {
  mode: ILaunchMode;
  /** What the menu should call it - the value, or the mode's own label. */
  label: string;
  /** Whether this widens what the assistant may do without asking. */
  unsafe: boolean;
}

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
  const [id, value] = token.split('=');
  const mode = launchModes.find(m => m.id === id);
  if (!mode) {
    return null;
  }
  // A boolean mode with a menu label IS the assistant's skip-approval switch;
  // an enum only widens on the values its provider declared. `plan` resolves
  // to a mode and is stricter than the default, so "resolved at all" is the
  // wrong question to ask about danger.
  const unsafe = value
    ? (mode.unsafeValues ?? []).indexOf(value) !== -1
    : !!mode.menuLabel;
  // Name the VALUE where there is one - three enum values sharing the mode's
  // title render as one indistinguishable label.
  return {
    mode,
    label: value ?? mode.menuLabel ?? mode.title,
    unsafe
  };
}
