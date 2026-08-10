/**
 * The frontend provider registry and the descriptor contract.
 *
 * Registration is the only place an id is asserted, and the core reads
 * capability flags rather than ids - so a descriptor that claims a capability
 * it cannot back, or two descriptors sharing an id, has to fail here rather
 * than at render time.
 */

import { ProviderRegistry } from '../core/registry';
import { IProviderDescriptor, IProviderModule } from '../core/types';
import { PROVIDERS } from '../providers';

// Every assistant shipped today. A provider added without reaching the barrel
// fails here rather than silently costing the user a panel.
const EXPECTED_IDS = ['claude', 'codex', 'kimi', 'gemini'];

const FORK_STRATEGIES = ['native-flag', 'native-command', 'server-copy'];
const COLOUR_SOURCES = ['native', 'derived', 'none'];
const NAMING_STRATEGIES = ['launch-flag', 'server-side', 'none'];

function stub(id: string): IProviderModule {
  return {
    descriptor: {
      id,
      label: id,
      panelTitle: id,
      iconName: `jupyterlab_ai_code_assistants_extension:${id}`,
      iconSvg: '<svg/>',
      cliBinary: id,
      forkStrategy: 'server-copy',
      colourSource: 'none',
      namingStrategy: 'none',
      mintsNewSessionId: false,
      launchModes: [],
      hasRemoteControl: false,
      hasBgAgents: false,
      hasLiveProcess: false
    }
  };
}

describe('the providers barrel', () => {
  it('exports every registered assistant', () => {
    expect(PROVIDERS.map(m => m.descriptor.id).sort()).toEqual(
      [...EXPECTED_IDS].sort()
    );
  });

  it('gives each assistant a unique id', () => {
    const ids = PROVIDERS.map(m => m.descriptor.id);
    expect(new Set(ids).size).toEqual(ids.length);
  });

  it.each(PROVIDERS.map(m => [m.descriptor.id, m.descriptor]))(
    '%s satisfies the descriptor contract',
    (_id: string, descriptor: IProviderDescriptor) => {
      expect(descriptor.label.trim()).toBeTruthy();
      expect(descriptor.panelTitle.trim()).toBeTruthy();
      expect(descriptor.cliBinary.trim()).toBeTruthy();
      // The icon name is namespaced so two providers' LabIcons never collide.
      expect(descriptor.iconName).toEqual(
        `jupyterlab_ai_code_assistants_extension:${descriptor.id}`
      );
      expect(descriptor.iconSvg).toContain('<svg');
      expect(FORK_STRATEGIES).toContain(descriptor.forkStrategy);
      expect(COLOUR_SOURCES).toContain(descriptor.colourSource);
      expect(NAMING_STRATEGIES).toContain(descriptor.namingStrategy);
      expect(typeof descriptor.mintsNewSessionId).toBe('boolean');
      expect(typeof descriptor.hasRemoteControl).toBe('boolean');
      expect(typeof descriptor.hasBgAgents).toBe('boolean');
      expect(typeof descriptor.hasLiveProcess).toBe('boolean');
    }
  );

  it.each(PROVIDERS.map(m => [m.descriptor.id, m.descriptor]))(
    '%s declares its launch modes in its own terminology',
    (_id: string, descriptor: IProviderDescriptor) => {
      for (const mode of descriptor.launchModes) {
        expect(mode.id.trim()).toBeTruthy();
        expect(mode.title.trim()).toBeTruthy();
        expect(mode.description.trim()).toBeTruthy();
        if (mode.kind === 'boolean') {
          // Every unsafe switch is off by default, without exception.
          expect(mode.default).toBe(false);
        } else {
          expect(mode.values).toBeDefined();
          expect(mode.values).toContain(mode.default as string);
        }
      }
      const ids = descriptor.launchModes.map(m => m.id);
      expect(new Set(ids).size).toEqual(ids.length);
    }
  );
});

describe('ProviderRegistry', () => {
  it('keeps the barrel order', () => {
    const registry = new ProviderRegistry(PROVIDERS);
    expect(registry.ids).toEqual(PROVIDERS.map(m => m.descriptor.id));
    expect(registry.descriptors.map(d => d.id)).toEqual(registry.ids);
  });

  it('throws on a duplicate id rather than shadowing one', () => {
    expect(() => new ProviderRegistry([stub('twin'), stub('twin')])).toThrow(
      /Duplicate/
    );
  });

  it('ignores a module with no descriptor id, and warns once', () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const registry = new ProviderRegistry([
      { descriptor: undefined } as unknown as IProviderModule,
      stub('alpha')
    ]);
    expect(registry.ids).toEqual(['alpha']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('answers null for an id it does not know', () => {
    const registry = new ProviderRegistry([stub('alpha')]);
    expect(registry.has('alpha')).toBe(true);
    expect(registry.has('stale')).toBe(false);
    // A stale id in saved settings is a null, never a hard failure.
    expect(registry.get('stale')).toBeNull();
  });
});
