import { IProviderDescriptor, IProviderModule } from './types';

/** Console prefix for everything this extension logs. One spelling, so a
 * reader filtering the console on it sees every message the extension wrote. */
export const LOG_PREFIX = '[jupyterlab_ai_code_assistants_extension]';

/**
 * The frontend provider registry.
 *
 * Built once from the `providers/index.ts` barrel. Registration is the only
 * place a provider id is ever asserted, so a duplicate fails loudly here
 * rather than silently at render time - two panels sharing a widget id, a
 * command namespace and a settings key is not a state worth recovering from.
 */
export class ProviderRegistry {
  constructor(modules: IProviderModule[]) {
    for (const module of modules) {
      const descriptor = module?.descriptor;
      if (!descriptor?.id) {
        console.warn(
          `${LOG_PREFIX} ignoring a provider module with no descriptor id`
        );
        continue;
      }
      if (this._modules.has(descriptor.id)) {
        throw new Error(
          `Duplicate AI code assistant provider id "${descriptor.id}" - ` +
            'two descriptors cannot share an id.'
        );
      }
      this._modules.set(descriptor.id, module);
    }
  }

  /** Every registered module, in barrel order. */
  get modules(): IProviderModule[] {
    return [...this._modules.values()];
  }

  get descriptors(): IProviderDescriptor[] {
    return this.modules.map(m => m.descriptor);
  }

  get ids(): string[] {
    return [...this._modules.keys()];
  }

  has(id: string): boolean {
    return this._modules.has(id);
  }

  /** The module for an id, or null. A stale id in saved settings is a warning
   * and a null, never a hard failure. */
  get(id: string): IProviderModule | null {
    return this._modules.get(id) ?? null;
  }

  // Insertion-ordered, so `modules` and `ids` come back in barrel order.
  private readonly _modules: Map<string, IProviderModule> = new Map();
}
