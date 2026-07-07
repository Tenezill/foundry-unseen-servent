/**
 * Adversarial M8 verification probes (throwaway-style, but kept for coverage).
 * Each block targets one claim in the M8 verify brief.
 */
import { describe, expect, it } from 'vitest';
import type { ActionIntent, FoundryActorDoc } from '@companion/adapter-sdk';
import { IntentError } from '@companion/adapter-sdk';
import { dnd5eAdapter } from '../src/index.js';
import martialCapturedJson from './fixtures/martial-captured.json' with { type: 'json' };
import casterCapturedJson from './fixtures/caster-captured.json' with { type: 'json' };

const martial = martialCapturedJson as unknown as FoundryActorDoc;
const caster = casterCapturedJson as unknown as FoundryActorDoc;

function withEffects(effects: unknown[]): FoundryActorDoc {
  return { ...martial, effects };
}
function vmOf(effects: unknown[]) {
  return dnd5eAdapter.toViewModel(withEffects(effects));
}
function build(actor: FoundryActorDoc, intent: ActionIntent) {
  if (!dnd5eAdapter.buildAction) throw new Error('no buildAction');
  return dnd5eAdapter.buildAction(actor, intent);
}
function expectErr(fn: () => unknown, code: IntentError['code']) {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(IntentError);
  expect((caught as IntentError).code).toBe(code);
}

describe('ADV: effects parsing — statuses string vs array vs missing', () => {
  it('statuses as a bare string becomes a single condition', () => {
    const vm = vmOf([{ _id: 'a1', name: 'Poisoned', statuses: 'poisoned', disabled: false }]);
    expect(vm.conditions).toEqual([{ id: 'a1', label: 'Poisoned' }]);
  });

  it('statuses as an array becomes a condition', () => {
    const vm = vmOf([{ _id: 'a2', name: 'Blinded', statuses: ['blinded'], disabled: false }]);
    expect(vm.conditions).toEqual([{ id: 'a2', label: 'Blinded' }]);
  });

  it('statuses missing entirely still yields a condition (id from _id)', () => {
    const vm = vmOf([{ _id: 'a3', name: 'Prone' }]);
    expect(vm.conditions).toEqual([{ id: 'a3', label: 'Prone' }]);
  });

  it('statuses as empty string / empty array / null / number do not crash and yield a condition', () => {
    for (const s of ['', [], null, 42, { junk: true }]) {
      const vm = vmOf([{ _id: 'x', name: 'Grappled', statuses: s, disabled: false }]);
      expect(vm.conditions).toEqual([{ id: 'x', label: 'Grappled' }]);
    }
  });

  it('array of mixed junk keeps only string statuses (concentrating detected among junk)', () => {
    const vm = vmOf([{ _id: 'c', name: 'Haste', statuses: [null, 3, 'concentrating'], disabled: false }]);
    expect(vm.concentration).toEqual({ label: 'Haste' });
    expect(vm.conditions).toBeUndefined();
  });
});

describe('ADV: effects parsing — disabled / absent flags', () => {
  it('disabled === true is skipped', () => {
    const vm = vmOf([{ _id: 'd1', name: 'Blinded', statuses: ['blinded'], disabled: true }]);
    expect(vm.conditions).toBeUndefined();
  });

  it('disabled absent means active', () => {
    const vm = vmOf([{ _id: 'd2', name: 'Stunned', statuses: ['stunned'] }]);
    expect(vm.conditions).toEqual([{ id: 'd2', label: 'Stunned' }]);
  });

  it('disabled === false means active', () => {
    const vm = vmOf([{ _id: 'd3', name: 'Charmed', statuses: ['charmed'], disabled: false }]);
    expect(vm.conditions).toEqual([{ id: 'd3', label: 'Charmed' }]);
  });

  it('a disabled concentration marker does not register concentration', () => {
    const vm = vmOf([{ _id: 'd4', name: 'Concentrating: Bless', statuses: ['concentrating'], disabled: true }]);
    expect(vm.concentration).toBeNull();
    expect(dnd5eAdapter.actions?.(withEffects([{ _id: 'd4', name: 'Concentrating: Bless', statuses: ['concentrating'], disabled: true }])).some((a) => a.id === 'concentration.end')).toBe(false);
  });

  it('non-array effects field is treated as empty', () => {
    for (const e of [undefined, null, {}, 'nope', 7]) {
      const vm = dnd5eAdapter.toViewModel({ ...martial, effects: e });
      expect(vm.concentration).toBeNull();
      expect(vm.conditions).toBeUndefined();
    }
  });
});

describe('ADV: concentration separated from conditions', () => {
  it('a concentration effect with a real _id + extra statuses never leaks into conditions', () => {
    const vm = vmOf([
      { _id: 'concReal01', name: 'Concentrating: Bless', statuses: ['concentrating', 'blessed'], disabled: false },
      { _id: 'poison01', name: 'Poisoned', statuses: ['poisoned'], disabled: false },
    ]);
    expect(vm.concentration).toEqual({ label: 'Bless' });
    expect(vm.conditions).toEqual([{ id: 'poison01', label: 'Poisoned' }]);
    // The concentration _id must not be present among condition ids.
    expect((vm.conditions ?? []).some((c) => c.id === 'concReal01')).toBe(false);
  });

  it('concentration identified purely by name prefix (no concentrating status) still excluded from conditions', () => {
    const vm = vmOf([{ _id: 'cn', name: 'Concentrating: Web', statuses: [], disabled: false }]);
    expect(vm.concentration).toEqual({ label: 'Web' });
    expect(vm.conditions).toBeUndefined();
  });

  it('name starting with "Concentrating" without a colon keeps the full label and is not a condition', () => {
    const vm = vmOf([{ _id: 'cn2', name: 'Concentrating', statuses: ['concentrating'], disabled: false }]);
    expect(vm.concentration).toEqual({ label: 'Concentrating' });
    expect(vm.conditions).toBeUndefined();
  });
});

describe('ADV: death-save action only at hp<=0; rests always', () => {
  function atHp(v: number | undefined): FoundryActorDoc {
    const attrs = martial.system.attributes as Record<string, unknown>;
    const hp = attrs.hp as Record<string, unknown>;
    return { ...martial, system: { ...martial.system, attributes: { ...attrs, hp: { ...hp, value: v } } } };
  }
  it('hp>0 -> no death save', () => {
    expect(dnd5eAdapter.actions?.(atHp(5)).some((a) => a.id === 'deathsave.roll')).toBe(false);
  });
  it('hp===0 -> death save present', () => {
    expect(dnd5eAdapter.actions?.(atHp(0)).some((a) => a.id === 'deathsave.roll')).toBe(true);
  });
  it('hp<0 -> death save present', () => {
    expect(dnd5eAdapter.actions?.(atHp(-3)).some((a) => a.id === 'deathsave.roll')).toBe(true);
  });
  it('rests always present for every hp state', () => {
    for (const v of [10, 0, -1, undefined]) {
      const ids = (dnd5eAdapter.actions?.(atHp(v)) ?? []).map((a) => a.id);
      expect(ids).toContain('rest.short');
      expect(ids).toContain('rest.long');
    }
  });
  it('buildAction refuses death-save while hp>0 (descriptor absent)', () => {
    expectErr(() => build(atHp(9), { kind: 'deathsave', actionId: 'deathsave.roll' }), 'UNKNOWN_RESOURCE');
  });
});

describe('ADV: buildAction rejects unknown ids and kind mismatches', () => {
  it('unknown action id', () => {
    expectErr(() => build(martial, { kind: 'check', actionId: 'skill.zzz' }), 'UNKNOWN_RESOURCE');
    expectErr(() => build(martial, { kind: 'rest', actionId: 'rest.eternal' } as ActionIntent), 'UNKNOWN_RESOURCE');
  });
  it('kind mismatch against a present descriptor', () => {
    expectErr(() => build(martial, { kind: 'use', actionId: 'rest.short' } as ActionIntent), 'UNKNOWN_RESOURCE');
    expectErr(() => build(martial, { kind: 'rest', actionId: 'skill.ath' } as ActionIntent), 'UNKNOWN_RESOURCE');
  });
});

describe('ADV: detail only set for non-empty string description', () => {
  function grapplerDesc(value: unknown): FoundryActorDoc {
    return {
      ...martial,
      items: (martial.items ?? []).map((i) =>
        i.name === 'Grappler' ? { ...i, system: { ...i.system, description: { value } } } : i,
      ),
    };
  }
  function grapplerDetail(actor: FoundryActorDoc): unknown {
    const s = dnd5eAdapter.toViewModel(actor).sections.find((x) => x.id === 'features');
    if (s?.kind !== 'list') throw new Error('no features list');
    return s.items.find((i) => i.label === 'Grappler')?.detail;
  }
  it('empty string -> undefined', () => {
    expect(grapplerDetail(grapplerDesc(''))).toBeUndefined();
  });
  it('number/null/undefined/object -> undefined (no coercion leaking)', () => {
    for (const v of [0, 123, null, undefined, {}, ['x']]) {
      const d = grapplerDetail(grapplerDesc(v));
      expect(d).toBeUndefined();
    }
  });
  it('missing description object entirely -> undefined', () => {
    const actor: FoundryActorDoc = {
      ...martial,
      items: (martial.items ?? []).map((i) =>
        i.name === 'Grappler' ? { ...i, system: { ...(i.system as Record<string, unknown>), description: undefined } } : i,
      ),
    };
    expect(grapplerDetail(actor)).toBeUndefined();
  });
  it('non-empty string -> passes through verbatim', () => {
    expect(grapplerDetail(grapplerDesc('<p>hi</p>'))).toBe('<p>hi</p>');
  });
  it('the literal string "undefined" is a legal world value and passes through (not stripped)', () => {
    expect(grapplerDetail(grapplerDesc('undefined'))).toBe('undefined');
  });
});

describe('ADV: caster is untouched by effects probes (sanity)', () => {
  it('caster with no effects has null concentration and no conditions', () => {
    const vm = dnd5eAdapter.toViewModel(caster);
    expect(vm.concentration).toBeNull();
    expect(vm.conditions).toBeUndefined();
  });
});
