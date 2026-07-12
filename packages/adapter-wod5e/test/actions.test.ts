import { describe, expect, it } from 'vitest';
import { IntentError } from '@companion/adapter-sdk';
import type { ActionDescriptor, ActionIntent, FoundryActorDoc, RelayAction } from '@companion/adapter-sdk';
import { wod5eAdapter } from '../src/index.js';
import vampireCapturedJson from './fixtures/vampire-captured.json' with { type: 'json' };

// Same unwrap convention as adapter.test.ts / updates.test.ts (relay envelope
// -> raw actor doc).
const marius = (vampireCapturedJson as { data: unknown }).data as FoundryActorDoc;

// Fixture state relevant to pool math (see fixtures/vampire-captured.json):
//   attributes: strength 3, dexterity 2, stamina 3, charisma 2, manipulation 3,
//     composure 2, intelligence 2, wits 3, resolve 2
//   skills (raised): athletics 1, brawl 2, firearms 2, occult 3, persuasion 2,
//     streetwise 1 (rest default 0)
//   disciplines: potence 2 (visible), dominate 1 (visible)
//   hunger.value 2; type 'vampire'
//   power item "Lethal Body" (_id VSMlV6dQI5WK6zWS) grouped under potence

const LETHAL_BODY_ID = 'VSMlV6dQI5WK6zWS';

function withHunger(actor: FoundryActorDoc, hunger: number): FoundryActorDoc {
  return {
    ...actor,
    system: { ...actor.system, hunger: { ...(actor.system.hunger as Record<string, unknown>), value: hunger } },
  };
}

function withType(actor: FoundryActorDoc, type: string): FoundryActorDoc {
  return { ...actor, type };
}

function findAction(actor: FoundryActorDoc, id: string): ActionDescriptor {
  const a = wod5eAdapter.actions?.(actor).find((x) => x.id === id);
  if (!a) throw new Error(`action ${id} not found`);
  return a;
}

function roll(actor: FoundryActorDoc, intent: ActionIntent): RelayAction {
  if (!wod5eAdapter.buildAction) throw new Error('buildAction not implemented');
  return wod5eAdapter.buildAction(actor, intent);
}

// ---------------------------------------------------------------------------

describe('actions() — descriptor enumeration', () => {
  it('emits one pool descriptor per attribute (9), matching vocab order and default pairing', () => {
    const actions = wod5eAdapter.actions?.(marius) ?? [];
    const attrActions = actions.filter((a) => a.id.startsWith('pool.attr.'));
    expect(attrActions).toHaveLength(9);
    expect(findAction(marius, 'pool.attr.strength')).toEqual({
      id: 'pool.attr.strength',
      label: 'Strength',
      kind: 'pool',
      pool: { attribute: 'attr.strength' },
    });
  });

  it('emits one pool descriptor per canonical skill (27), default pairing attr.dexterity + skill.<key>', () => {
    const actions = wod5eAdapter.actions?.(marius) ?? [];
    const skillActions = actions.filter((a) => a.id.startsWith('pool.skill.'));
    expect(skillActions).toHaveLength(27);
    expect(findAction(marius, 'pool.skill.brawl')).toEqual({
      id: 'pool.skill.brawl',
      label: 'Brawl',
      kind: 'pool',
      pool: { attribute: 'attr.dexterity', skill: 'skill.brawl' },
    });
    expect(findAction(marius, 'pool.skill.animalken').label).toBe('Animal Ken');
  });

  it('emits one pool descriptor per power item, pairing attr.resolve + disc.<its discipline>', () => {
    expect(findAction(marius, `pool.power.${LETHAL_BODY_ID}`)).toEqual({
      id: `pool.power.${LETHAL_BODY_ID}`,
      label: 'Lethal Body',
      kind: 'pool',
      pool: { attribute: 'attr.resolve', skill: 'disc.potence' },
    });
  });

  it('emits exactly one rouse descriptor', () => {
    const actions = wod5eAdapter.actions?.(marius) ?? [];
    const rouseActions = actions.filter((a) => a.kind === 'rouse');
    expect(rouseActions).toEqual([{ id: 'rouse', label: 'Rouse Check', kind: 'rouse' }]);
  });

  it('a homebrew skill key that renders as a stat also gets a pool action', () => {
    const withHomebrew: FoundryActorDoc = {
      ...marius,
      system: {
        ...marius.system,
        skills: { ...(marius.system.skills as Record<string, unknown>), juggling: { value: 2 } },
      },
    };
    expect(findAction(withHomebrew, 'pool.skill.juggling')).toEqual({
      id: 'pool.skill.juggling',
      label: 'Juggling',
      kind: 'pool',
      pool: { attribute: 'attr.dexterity', skill: 'skill.juggling' },
    });
  });

  it('every actionId wired onto a stat or list row (toViewModel) resolves to an emitted descriptor', () => {
    const vm = wod5eAdapter.toViewModel(marius);
    const actionIds = new Set((wod5eAdapter.actions?.(marius) ?? []).map((a) => a.id));
    for (const section of vm.sections) {
      if (section.kind === 'stats') {
        for (const stat of section.stats) {
          if (stat.actionId !== undefined) {
            expect(actionIds.has(stat.actionId), `stat ${stat.id} -> ${stat.actionId}`).toBe(true);
          }
        }
      }
      if (section.kind === 'list') {
        for (const item of section.items) {
          if (item.actionId !== undefined) {
            expect(actionIds.has(item.actionId), `item ${item.id} -> ${item.actionId}`).toBe(true);
          }
        }
      }
    }
  });

  it('discipline-rating stats and humanity carry no actionId (not in the pool vocab)', () => {
    const vm = wod5eAdapter.toViewModel(marius);
    const ratings = vm.sections.find((s) => s.id === 'discipline-ratings');
    if (ratings?.kind !== 'stats') throw new Error('discipline-ratings must be a stats section');
    for (const stat of ratings.stats) expect(stat.actionId).toBeUndefined();

    const attrs = vm.sections.find((s) => s.id === 'attributes');
    if (attrs?.kind !== 'stats') throw new Error('attributes must be a stats section');
    expect(attrs.stats.find((s) => s.id === 'humanity')?.actionId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('buildAction — pool math (table-driven)', () => {
  const cases: Array<{
    name: string;
    actor: FoundryActorDoc;
    intent: ActionIntent;
    formula: string;
    flavor: string;
  }> = [
    {
      name: 'attribute-only pool (strength, no modifier): dice 3, hunger 2 -> split',
      actor: marius,
      intent: { kind: 'pool', actionId: 'pool.attr.strength' },
      formula: '1d10cs>=6 + 2d10cs>=6',
      flavor: 'Strength (3 dice, 2 hunger)',
    },
    {
      name: 'attribute + skill (default pairing, brawl): dexterity 2 + brawl 2 = 4 dice, hunger 2 -> split',
      actor: marius,
      intent: { kind: 'pool', actionId: 'pool.skill.brawl' },
      formula: '2d10cs>=6 + 2d10cs>=6',
      flavor: 'Dexterity + Brawl (4 dice, 2 hunger)',
    },
    {
      name: 'attribute + discipline via power (Lethal Body): resolve 2 + potence 2 = 4 dice, hunger 2 -> split',
      actor: marius,
      intent: { kind: 'pool', actionId: `pool.power.${LETHAL_BODY_ID}` },
      formula: '2d10cs>=6 + 2d10cs>=6',
      flavor: 'Resolve + Potence (4 dice, 2 hunger)',
    },
    {
      name: 'positive modifier (+3 on strength): dice 6, hunger 2 -> split',
      actor: marius,
      intent: { kind: 'pool', actionId: 'pool.attr.strength', modifier: 3 },
      formula: '4d10cs>=6 + 2d10cs>=6',
      flavor: 'Strength (6 dice, 2 hunger)',
    },
    {
      name: 'hunger 0 (mortal-flavored variant of the same actor): normal-only, no hunger dice',
      actor: withType(marius, 'mortal'),
      intent: { kind: 'pool', actionId: 'pool.attr.strength' },
      formula: '3d10cs>=6',
      flavor: 'Strength (3 dice)',
    },
    {
      name: 'hunger 0 (vampire-flavored clone with hunger.value 0): normal-only, no hunger dice',
      actor: withHunger(marius, 0),
      intent: { kind: 'pool', actionId: 'pool.attr.strength' },
      formula: '3d10cs>=6',
      flavor: 'Strength (3 dice)',
    },
    {
      name: 'hunger greater than the whole pool: all dice become hunger dice',
      actor: withHunger(marius, 5),
      intent: { kind: 'pool', actionId: 'pool.attr.dexterity' },
      formula: '2d10cs>=6',
      flavor: 'Dexterity (2 dice, 2 hunger)',
    },
    {
      name: 'negative modifier without a hunger clash: normal-only',
      actor: withHunger(marius, 0),
      intent: { kind: 'pool', actionId: 'pool.attr.strength', modifier: -1 },
      formula: '2d10cs>=6',
      flavor: 'Strength (2 dice)',
    },
    {
      name: 'floors at 1 die (sparse actor, huge negative modifier, no hunger)',
      actor: { _id: 'sparse01', name: 'Empty', type: 'vampire', system: {} },
      intent: { kind: 'pool', actionId: 'pool.attr.strength', modifier: -20 },
      formula: '1d10cs>=6',
      flavor: 'Strength (1 dice)',
    },
    {
      name: 'intent override: pool.skill.brawl re-paired to strength + potence',
      actor: marius,
      intent: { kind: 'pool', actionId: 'pool.skill.brawl', attribute: 'attr.strength', skill: 'disc.potence' },
      formula: '3d10cs>=6 + 2d10cs>=6',
      flavor: 'Strength + Potence (5 dice, 2 hunger)',
    },
  ];

  for (const { name, actor, intent, formula, flavor } of cases) {
    it(name, () => {
      expect(roll(actor, intent)).toEqual({ endpoint: 'roll', formula, flavor });
    });
  }
});

describe('buildAction — rouse', () => {
  it('exact formula/flavor, no follow-up hunger write', () => {
    expect(roll(marius, { kind: 'rouse', actionId: 'rouse' })).toEqual({
      endpoint: 'roll',
      formula: '1d10cs>=6',
      flavor: 'Rouse Check',
    });
  });

  it('unknown rouse actionId -> UNKNOWN_RESOURCE', () => {
    try {
      roll(marius, { kind: 'rouse', actionId: 'rouse.nope' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IntentError);
      expect((err as IntentError).code).toBe('UNKNOWN_RESOURCE');
    }
  });
});

describe('buildAction — validation', () => {
  it('unknown pool actionId -> UNKNOWN_RESOURCE', () => {
    try {
      roll(marius, { kind: 'pool', actionId: 'pool.attr.nope' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IntentError);
      expect((err as IntentError).code).toBe('UNKNOWN_RESOURCE');
    }
  });

  it('bad attribute override id -> INVALID', () => {
    try {
      roll(marius, { kind: 'pool', actionId: 'pool.attr.strength', attribute: 'attr.notreal' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IntentError);
      expect((err as IntentError).code).toBe('INVALID');
    }
  });

  it('bad skill/discipline override id -> INVALID', () => {
    try {
      roll(marius, { kind: 'pool', actionId: 'pool.skill.brawl', skill: 'skill.notreal' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IntentError);
      expect((err as IntentError).code).toBe('INVALID');
    }
    try {
      roll(marius, { kind: 'pool', actionId: 'pool.skill.brawl', skill: 'disc.notreal' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IntentError);
      expect((err as IntentError).code).toBe('INVALID');
    }
    try {
      roll(marius, { kind: 'pool', actionId: 'pool.skill.brawl', skill: 'bogus.notreal' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IntentError);
      expect((err as IntentError).code).toBe('INVALID');
    }
  });

  it('non-integer modifier -> INVALID', () => {
    try {
      roll(marius, { kind: 'pool', actionId: 'pool.attr.strength', modifier: 1.5 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IntentError);
      expect((err as IntentError).code).toBe('INVALID');
    }
  });

  it('|modifier| > 20 -> INVALID', () => {
    for (const modifier of [21, -21]) {
      try {
        roll(marius, { kind: 'pool', actionId: 'pool.attr.strength', modifier });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(IntentError);
        expect((err as IntentError).code).toBe('INVALID');
      }
    }
  });

  it('an unsupported action kind -> UNKNOWN_RESOURCE', () => {
    try {
      roll(marius, { kind: 'check', actionId: 'pool.attr.strength' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IntentError);
      expect((err as IntentError).code).toBe('UNKNOWN_RESOURCE');
    }
  });
});
