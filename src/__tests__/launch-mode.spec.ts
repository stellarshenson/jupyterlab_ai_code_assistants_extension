/**
 * Launch-mode precedence.
 *
 * A provider can expose both a boolean switch and an enum ladder over the same
 * approval surface, and the payload carries only one token. An enum moved off
 * its default is the user's explicit statement, so it has to beat a boolean
 * left on - otherwise a read-only ladder setting launches wide open.
 */

import { resolveLaunchMode, resolvedLaunchModeEntry } from '../core/modes';
import { ILaunchMode } from '../core/types';

const MODES: ILaunchMode[] = [
  {
    id: 'yoloMode',
    title: 'YOLO',
    description: 'Boolean switch.',
    kind: 'boolean',
    default: false,
    // Carrying a menu label IS a boolean mode's declaration that it skips
    // approval - it is what puts a variant in the menu.
    menuLabel: 'YOLO'
  },
  {
    id: 'approvalMode',
    title: 'Approval',
    description: 'Enum ladder.',
    kind: 'enum',
    values: ['default', 'plan', 'yolo'],
    default: 'default',
    unsafeValues: ['yolo']
  }
];

describe('resolveLaunchMode', () => {
  it('lets a non-default enum beat a boolean that is on', () => {
    expect(
      resolveLaunchMode(MODES, { yoloMode: true, approvalMode: 'plan' })
    ).toEqual('approvalMode=plan');
  });

  it('sends the boolean while every enum sits at its default', () => {
    expect(
      resolveLaunchMode(MODES, { yoloMode: true, approvalMode: 'default' })
    ).toEqual('yoloMode');
  });

  it('sends nothing when no mode is set', () => {
    expect(resolveLaunchMode(MODES, {})).toBeUndefined();
  });

  it('forces the requested mode whatever the settings say', () => {
    expect(
      resolveLaunchMode(MODES, { approvalMode: 'plan' }, 'yoloMode')
    ).toEqual('yoloMode');
  });
});

describe('resolvedLaunchModeEntry', () => {
  // What the panel marks its PLAIN menu items from. Deciding the warning glyph
  // from the menu's `force` argument instead leaves the entry the user
  // actually clicks unmarked, while marking a forced duplicate that builds the
  // identical launch. Deciding it from "a mode resolved at all" is the same
  // error one level down: it warns on Gemini's `plan`, which is read-only.
  it('warns on a boolean skip-approval switch and names it', () => {
    const r = resolvedLaunchModeEntry(MODES, { yoloMode: true });
    expect(r?.mode.id).toEqual('yoloMode');
    expect(r?.label).toEqual('YOLO');
    expect(r?.unsafe).toBe(true);
  });

  it('warns on an enum value the provider declared as widening', () => {
    const r = resolvedLaunchModeEntry(MODES, { approvalMode: 'yolo' });
    expect(r?.mode.id).toEqual('approvalMode');
    expect(r?.label).toEqual('yolo');
    expect(r?.unsafe).toBe(true);
  });

  it('does NOT warn on an enum value that is stricter than the default', () => {
    // `plan` is read-only. Marking it like `yolo` says nothing about either.
    const r = resolvedLaunchModeEntry(MODES, { approvalMode: 'plan' });
    expect(r?.mode.id).toEqual('approvalMode');
    expect(r?.label).toEqual('plan');
    expect(r?.unsafe).toBe(false);
  });

  it('names the mode that actually wins, not both', () => {
    expect(
      resolvedLaunchModeEntry(MODES, { yoloMode: true, approvalMode: 'plan' })
        ?.mode.id
    ).toEqual('approvalMode');
  });

  it('names nothing for a launch that carries no mode', () => {
    expect(resolvedLaunchModeEntry(MODES, {})).toBeNull();
    expect(
      resolvedLaunchModeEntry(MODES, { approvalMode: 'default' })
    ).toBeNull();
  });
});
