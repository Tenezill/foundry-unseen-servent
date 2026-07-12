import { describe, expect, it } from 'vitest';
import { IntentError } from '@companion/adapter-sdk';
import type { FoundryActorDoc } from '@companion/adapter-sdk';
import { wod5eAdapter } from '../src/index.js';
import vampireCapturedJson from './fixtures/vampire-captured.json' with { type: 'json' };

// Same unwrap convention as the other wod5e test files.
const marius = (vampireCapturedJson as { data: unknown }).data as FoundryActorDoc;

function build(input: Record<string, unknown>): Record<string, unknown> {
  if (!wod5eAdapter.buildCustomItem) throw new Error('buildCustomItem not implemented');
  return wod5eAdapter.buildCustomItem(marius, input as never);
}

function throwsInvalid(input: Record<string, unknown>): void {
  expect(() => build(input)).toThrow(IntentError);
  try {
    build(input);
  } catch (err) {
    expect(err).toBeInstanceOf(IntentError);
    expect((err as IntentError).code).toBe('INVALID');
  }
}

describe('buildCustomItem — weapon', () => {
  it('builds a weapon payload with damage -> weaponvalue + default melee weaponType', () => {
    const payload = build({ name: 'Stake', type: 'weapon', damage: 2 });
    expect(payload).toEqual({
      name: 'Stake',
      type: 'weapon',
      system: { weaponvalue: 2, weaponType: 'melee' },
    });
  });

  it('trims the name', () => {
    const payload = build({ name: '  Stake  ', type: 'weapon', damage: 2 });
    expect(payload.name).toBe('Stake');
  });

  it('a weapon without damage still defaults weaponType to melee', () => {
    const payload = build({ name: 'Bare Fists', type: 'weapon' });
    expect(payload).toEqual({ name: 'Bare Fists', type: 'weapon', system: { weaponType: 'melee' } });
  });

  it('includes a description when given', () => {
    const payload = build({ name: 'Stake', type: 'weapon', damage: 2, description: 'Sharpened wood.' });
    expect(payload).toEqual({
      name: 'Stake',
      type: 'weapon',
      system: { weaponvalue: 2, weaponType: 'melee', description: 'Sharpened wood.' },
    });
  });

  it('rejects a damage value outside 0-10', () => {
    throwsInvalid({ name: 'Stake', type: 'weapon', damage: 11 });
    throwsInvalid({ name: 'Stake', type: 'weapon', damage: -1 });
  });

  it('rejects a non-integer damage value', () => {
    throwsInvalid({ name: 'Stake', type: 'weapon', damage: 2.5 });
  });
});

describe('buildCustomItem — gear', () => {
  it('builds a bare gear payload', () => {
    const payload = build({ name: 'Lockpicks', type: 'gear' });
    expect(payload).toEqual({ name: 'Lockpicks', type: 'gear', system: {} });
  });

  it('rejects damage on gear (weapons only)', () => {
    throwsInvalid({ name: 'Lockpicks', type: 'gear', damage: 2 });
  });
});

describe('buildCustomItem — whitelist / validation', () => {
  it('rejects an unsupported type', () => {
    throwsInvalid({ name: 'Thing', type: 'power' });
    throwsInvalid({ name: 'Thing', type: 'clan' });
  });

  it('rejects a missing or empty name', () => {
    throwsInvalid({ type: 'gear' });
    throwsInvalid({ name: '', type: 'gear' });
    throwsInvalid({ name: '   ', type: 'gear' });
  });

  it('rejects a name over 80 characters', () => {
    throwsInvalid({ name: 'x'.repeat(81), type: 'gear' });
  });

  it('accepts a name of exactly 80 characters', () => {
    const payload = build({ name: 'x'.repeat(80), type: 'gear' });
    expect(payload.name).toBe('x'.repeat(80));
  });

  it('rejects a description over 2000 characters', () => {
    throwsInvalid({ name: 'Thing', type: 'gear', description: 'x'.repeat(2001) });
  });

  it('drops fields outside the whitelist rather than passing them through', () => {
    const payload = build({ name: 'Stake', type: 'weapon', damage: 2, hax: 'ignored' });
    expect(payload).toEqual({
      name: 'Stake',
      type: 'weapon',
      system: { weaponvalue: 2, weaponType: 'melee' },
    });
  });
});
