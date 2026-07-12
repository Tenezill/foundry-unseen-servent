/**
 * systemId -> SystemAdapter registry. The gateway picks the adapter from the
 * actor's system id (relay doc field, falling back to DEFAULT_SYSTEM_ID).
 */
import type { SystemAdapter } from '@companion/adapter-sdk';
import { dnd5eAdapter } from '@companion/adapter-dnd5e';
import { wod5eAdapter } from '@companion/adapter-wod5e';

export type AdapterRegistry = ReadonlyMap<string, SystemAdapter>;

export function createRegistry(adapters: readonly SystemAdapter[]): AdapterRegistry {
  return new Map(adapters.map((a) => [a.systemId, a]));
}

/** Production registry: dnd5e and wod5e (M23 §1). */
export function createDefaultRegistry(): AdapterRegistry {
  return createRegistry([dnd5eAdapter, wod5eAdapter]);
}
