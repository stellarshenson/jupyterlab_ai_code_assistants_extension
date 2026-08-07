/**
 * Launch-mode precedence.
 *
 * A provider can expose both a boolean switch and an enum ladder over the same
 * approval surface, and the payload carries only one token. An enum moved off
 * its default is the user's explicit statement, so it has to beat a boolean
 * left on - otherwise a read-only ladder setting launches wide open.
 */

import { resolveLaunchMode } from '../core/modes';
import { ILaunchMode } from '../core/types';

const MODES: ILaunchMode[] = [
  {
    id: 'yoloMode',
    title: 'YOLO',
    description: 'Boolean switch.',
    kind: 'boolean',
    default: false
  },
  {
    id: 'approvalMode',
    title: 'Approval',
    description: 'Enum ladder.',
    kind: 'enum',
    values: ['default', 'plan', 'yolo'],
    default: 'default'
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
