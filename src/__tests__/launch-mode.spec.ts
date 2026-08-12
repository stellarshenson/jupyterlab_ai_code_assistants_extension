/**
 * Launch-mode resolution.
 *
 * Every mode is a boolean skip-approval switch in the assistant's own
 * terminology (DEF-111 retired the one enum ladder, Gemini's `approvalMode`),
 * and the payload carries only one token: `force` wins outright, otherwise
 * the first switch that is on fires.
 */

import { resolveLaunchMode, resolvedLaunchModeEntry } from '../core/modes';
import { ILaunchMode } from '../core/types';

const MODES: ILaunchMode[] = [
  {
    id: 'yoloMode',
    title: 'YOLO',
    description: 'Boolean switch.',
    default: false,
    // Carrying a menu label IS a boolean mode's declaration that it skips
    // approval - it is what puts a variant in the menu.
    menuLabel: 'YOLO'
  }
];

describe('resolveLaunchMode', () => {
  it('sends the boolean that is on', () => {
    expect(resolveLaunchMode(MODES, { yoloMode: true })).toEqual('yoloMode');
  });

  it('sends nothing when no mode is set', () => {
    expect(resolveLaunchMode(MODES, {})).toBeUndefined();
    expect(resolveLaunchMode(MODES, { yoloMode: false })).toBeUndefined();
  });

  it('forces the requested mode whatever the settings say', () => {
    expect(resolveLaunchMode(MODES, {}, 'yoloMode')).toEqual('yoloMode');
  });

  it('ignores a token from a retired setting', () => {
    // A stale `approvalMode` value in saved settings is not a boolean that is
    // on - it must never become a launch token (DEF-111).
    expect(
      resolveLaunchMode(MODES, { approvalMode: 'plan' } as any)
    ).toBeUndefined();
  });
});

describe('resolvedLaunchModeEntry', () => {
  // What the panel marks its PLAIN menu items from. Deciding the warning glyph
  // from the menu's `force` argument instead leaves the entry the user
  // actually clicks unmarked, while marking a forced duplicate that builds the
  // identical launch.
  it('warns on a boolean skip-approval switch and names it', () => {
    const r = resolvedLaunchModeEntry(MODES, { yoloMode: true });
    expect(r?.mode.id).toEqual('yoloMode');
    expect(r?.label).toEqual('YOLO');
    expect(r?.unsafe).toBe(true);
  });

  it('names nothing for a launch that carries no mode', () => {
    expect(resolvedLaunchModeEntry(MODES, {})).toBeNull();
    expect(resolvedLaunchModeEntry(MODES, { yoloMode: false })).toBeNull();
  });
});
