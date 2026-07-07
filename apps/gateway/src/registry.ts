/**
 * systemId -> SystemAdapter registry. The gateway picks the adapter from the
 * actor's system id (relay doc field, falling back to DEFAULT_SYSTEM_ID).
 */
import type { SystemAdapter } from '@companion/adapter-sdk';
import { dnd5eAdapter } from '@companion/adapter-dnd5e';

export type AdapterRegistry = ReadonlyMap<string, SystemAdapter>;

export function createRegistry(adapters: readonly SystemAdapter[]): AdapterRegistry {
  return new Map(adapters.map((a) => [a.systemId, a]));
}

/** Production registry: dnd5e only in v1 (PLAN.md §1). */
export function createDefaultRegistry(): AdapterRegistry {
  return createRegistry([dnd5eAdapter]);
}
