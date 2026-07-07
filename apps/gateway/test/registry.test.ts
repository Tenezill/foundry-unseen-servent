import { describe, expect, it } from 'vitest';
import { dnd5eAdapter } from '@companion/adapter-dnd5e';
import { createDefaultRegistry } from '../src/registry.js';

describe('default adapter registry', () => {
  it('wires the real dnd5e adapter under its system id', () => {
    const registry = createDefaultRegistry();
    const adapter = registry.get('dnd5e');
    expect(adapter).toBe(dnd5eAdapter);
    expect(adapter?.systemId).toBe('dnd5e');
    // Smoke: the adapter produces a view model for a minimal doc.
    const vm = adapter!.toViewModel({ _id: 'x1', name: 'Test', type: 'character', system: {} });
    expect(vm.actorId).toBe('x1');
    expect(vm.systemId).toBe('dnd5e');
  });
});
