import { describe, expect, it } from 'vitest';
import { unwrapEntity } from '../src/index.js';

describe('unwrapEntity (relay 3.4.1 envelope, M0-verified)', () => {
  it('unwraps the entity-result envelope even though it has a top-level uuid', () => {
    const envelope = {
      type: 'entity-result',
      requestId: 'entity_1783421643752',
      uuid: 'Actor.zteTG9PZZ6XQpQtK',
      data: { _id: 'zteTG9PZZ6XQpQtK', name: 'Randal', type: 'character', system: {} },
    };
    expect(unwrapEntity(envelope)?._id).toBe('zteTG9PZZ6XQpQtK');
  });

  it('accepts a bare document (older relays)', () => {
    const doc = { _id: 'abc', name: 'X', type: 'character', system: {} };
    expect(unwrapEntity(doc)?._id).toBe('abc');
  });

  it('returns null for junk', () => {
    expect(unwrapEntity({ type: 'error' } as Record<string, unknown>)).toBeNull();
  });
});
