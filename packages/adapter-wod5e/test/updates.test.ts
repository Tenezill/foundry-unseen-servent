import { describe, expect, it } from 'vitest';
import { IntentError } from '@companion/adapter-sdk';
import type { FoundryActorDoc } from '@companion/adapter-sdk';
import { wod5eAdapter } from '../src/index.js';
import vampireCapturedJson from './fixtures/vampire-captured.json' with { type: 'json' };

// Same unwrap convention as adapter.test.ts (relay envelope -> raw actor doc).
const marius = (vampireCapturedJson as { data: unknown }).data as FoundryActorDoc;

// Fixture state (see fixtures/vampire-captured.json):
//   health {max: 6, superficial: 1, aggravated: 1}  -> superficial/aggravated max = 5 each
//   willpower {max: 4, superficial: 1, aggravated: 0} -> superficial max 4, aggravated max 3
//   hunger.value 2 (0..5); humanity {value: 7, stains: 1} (stains 0..10)
//   Lockpicks item (_id uPSi7wf2mUNcPlAu) quantity 1 by default.

const LOCKPICKS_ID = 'uPSi7wf2mUNcPlAu';

function stackedLockpicks(qty: number): FoundryActorDoc {
  return {
    ...marius,
    items: (marius.items ?? []).map((i) => (i._id === LOCKPICKS_ID ? { ...i, system: { ...i.system, quantity: qty } } : i)),
  };
}

describe('buildUpdate — health/willpower tracks', () => {
  it('delta +1 on health.superficial: 1 -> 2, exact dotted path', () => {
    const update = wod5eAdapter.buildUpdate(marius, { kind: 'delta', resourceId: 'health.superficial', amount: 1 });
    expect(update).toEqual({ data: { 'system.health.superficial': 2 } });
  });

  it('health.superficial delta beyond max - aggravated clamps to that max (5)', () => {
    const update = wod5eAdapter.buildUpdate(marius, { kind: 'delta', resourceId: 'health.superficial', amount: 10 });
    expect(update).toEqual({ data: { 'system.health.superficial': 5 } });
  });

  it('health.aggravated delta beyond max - superficial clamps to that max (5)', () => {
    const update = wod5eAdapter.buildUpdate(marius, { kind: 'delta', resourceId: 'health.aggravated', amount: 10 });
    expect(update).toEqual({ data: { 'system.health.aggravated': 5 } });
  });

  it('negative deltas clamp at 0 (health.superficial)', () => {
    const update = wod5eAdapter.buildUpdate(marius, { kind: 'delta', resourceId: 'health.superficial', amount: -10 });
    expect(update).toEqual({ data: { 'system.health.superficial': 0 } });
  });

  it('negative deltas clamp at 0 (health.aggravated)', () => {
    const update = wod5eAdapter.buildUpdate(marius, { kind: 'delta', resourceId: 'health.aggravated', amount: -10 });
    expect(update).toEqual({ data: { 'system.health.aggravated': 0 } });
  });

  it('willpower.superficial delta beyond max - aggravated clamps to that max (4)', () => {
    const update = wod5eAdapter.buildUpdate(marius, { kind: 'delta', resourceId: 'willpower.superficial', amount: 10 });
    expect(update).toEqual({ data: { 'system.willpower.superficial': 4 } });
  });

  it('willpower.aggravated delta beyond max - superficial clamps to that max (3)', () => {
    const update = wod5eAdapter.buildUpdate(marius, { kind: 'delta', resourceId: 'willpower.aggravated', amount: 10 });
    expect(update).toEqual({ data: { 'system.willpower.aggravated': 3 } });
  });

  it('willpower negative deltas clamp at 0', () => {
    const update = wod5eAdapter.buildUpdate(marius, { kind: 'delta', resourceId: 'willpower.superficial', amount: -10 });
    expect(update).toEqual({ data: { 'system.willpower.superficial': 0 } });
  });
});

describe('buildUpdate — hunger + humanity.stains', () => {
  it('hunger set 7 clamps to 5, exact dotted path', () => {
    const update = wod5eAdapter.buildUpdate(marius, { kind: 'set', resourceId: 'hunger', value: 7 });
    expect(update).toEqual({ data: { 'system.hunger.value': 5 } });
  });

  it('hunger set negative clamps to 0', () => {
    const update = wod5eAdapter.buildUpdate(marius, { kind: 'set', resourceId: 'hunger', value: -3 });
    expect(update).toEqual({ data: { 'system.hunger.value': 0 } });
  });

  it('humanity.stains set 11 clamps to 10, exact dotted path', () => {
    const update = wod5eAdapter.buildUpdate(marius, { kind: 'set', resourceId: 'humanity.stains', value: 11 });
    expect(update).toEqual({ data: { 'system.humanity.stains': 10 } });
  });

  it('humanity.stains set negative clamps to 0', () => {
    const update = wod5eAdapter.buildUpdate(marius, { kind: 'set', resourceId: 'humanity.stains', value: -1 });
    expect(update).toEqual({ data: { 'system.humanity.stains': 0 } });
  });
});

describe('buildUpdate — gear item quantity', () => {
  it('delta on item.<id>.qty targets the item with system.quantity, clamped at 0', () => {
    const actor = stackedLockpicks(5);
    const update = wod5eAdapter.buildUpdate(actor, { kind: 'delta', resourceId: `item.${LOCKPICKS_ID}.qty`, amount: -2 });
    expect(update).toEqual({ itemId: LOCKPICKS_ID, data: { 'system.quantity': 3 } });
  });

  it('item quantity floors at 0', () => {
    const actor = stackedLockpicks(5);
    const update = wod5eAdapter.buildUpdate(actor, { kind: 'delta', resourceId: `item.${LOCKPICKS_ID}.qty`, amount: -100 });
    expect(update).toEqual({ itemId: LOCKPICKS_ID, data: { 'system.quantity': 0 } });
  });

  it('item quantity clamps at the sane upper bound (999)', () => {
    const actor = stackedLockpicks(5);
    const update = wod5eAdapter.buildUpdate(actor, { kind: 'set', resourceId: `item.${LOCKPICKS_ID}.qty`, value: 5000 });
    expect(update).toEqual({ itemId: LOCKPICKS_ID, data: { 'system.quantity': 999 } });
  });
});

describe('buildUpdate — rejections', () => {
  it('unknown resource -> UNKNOWN_RESOURCE', () => {
    expect(() => wod5eAdapter.buildUpdate(marius, { kind: 'delta', resourceId: 'nope', amount: 1 })).toThrow(
      IntentError,
    );
    try {
      wod5eAdapter.buildUpdate(marius, { kind: 'delta', resourceId: 'nope', amount: 1 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IntentError);
      expect((err as IntentError).code).toBe('UNKNOWN_RESOURCE');
    }
  });

  it('humanity (read-only) -> READ_ONLY', () => {
    try {
      wod5eAdapter.buildUpdate(marius, { kind: 'set', resourceId: 'humanity', value: 5 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IntentError);
      expect((err as IntentError).code).toBe('READ_ONLY');
    }
  });

  it('bloodpotency (read-only) -> READ_ONLY', () => {
    try {
      wod5eAdapter.buildUpdate(marius, { kind: 'set', resourceId: 'bloodpotency', value: 5 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IntentError);
      expect((err as IntentError).code).toBe('READ_ONLY');
    }
  });

  it('non-finite or non-integer payload -> INVALID', () => {
    for (const intent of [
      { kind: 'set' as const, resourceId: 'hunger', value: Number.NaN },
      { kind: 'set' as const, resourceId: 'hunger', value: 1.5 },
      { kind: 'delta' as const, resourceId: 'hunger', amount: Number.POSITIVE_INFINITY },
    ]) {
      try {
        wod5eAdapter.buildUpdate(marius, intent);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(IntentError);
        expect((err as IntentError).code).toBe('INVALID');
      }
    }
  });
});

describe('buildUpdate — optimistic lock (expected)', () => {
  it('expected matching the current value succeeds', () => {
    const update = wod5eAdapter.buildUpdate(marius, {
      kind: 'delta',
      resourceId: 'hunger',
      amount: 1,
      expected: 2,
    });
    expect(update).toEqual({ data: { 'system.hunger.value': 3 } });
  });

  it('expected mismatch -> CONFLICT, no update returned', () => {
    try {
      wod5eAdapter.buildUpdate(marius, { kind: 'delta', resourceId: 'hunger', amount: 1, expected: 999 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IntentError);
      expect((err as IntentError).code).toBe('CONFLICT');
    }
  });

  it('omitted expected never triggers a conflict, regardless of current value', () => {
    const update = wod5eAdapter.buildUpdate(marius, { kind: 'set', resourceId: 'hunger', value: 4 });
    expect(update).toEqual({ data: { 'system.hunger.value': 4 } });
  });
});
