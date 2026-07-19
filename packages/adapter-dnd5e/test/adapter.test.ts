import { describe, expect, it } from 'vitest';
import type { FoundryActorDoc, ResourceDescriptor, SheetSection } from '@companion/adapter-sdk';
import { IntentError } from '@companion/adapter-sdk';
import dnd5eAdapterDefault, { dnd5eAdapter } from '../src/index.js';
import martialJson from './fixtures/martial.json' with { type: 'json' };
import casterJson from './fixtures/caster.json' with { type: 'json' };
import martialCapturedJson from './fixtures/martial-captured.json' with { type: 'json' };
import casterCapturedJson from './fixtures/caster-captured.json' with { type: 'json' };

const martial = martialJson as unknown as FoundryActorDoc;
const caster = casterJson as unknown as FoundryActorDoc;
const martialCaptured = martialCapturedJson as unknown as FoundryActorDoc;
const casterCaptured = casterCapturedJson as unknown as FoundryActorDoc;

function resource(actor: FoundryActorDoc, id: string): ResourceDescriptor {
  const r = dnd5eAdapter.resources(actor).find((d) => d.id === id);
  if (!r) throw new Error(`resource ${id} not found`);
  return r;
}

function section(actor: FoundryActorDoc, id: string): SheetSection {
  const s = dnd5eAdapter.toViewModel(actor).sections.find((x) => x.id === id);
  if (!s) throw new Error(`section ${id} not found`);
  return s;
}

/** All spell rows across the per-level `spells.l<N>` sections (2026-07-18). */
function spellRows(actor: FoundryActorDoc) {
  return dnd5eAdapter
    .toViewModel(actor)
    .sections.filter((s): s is Extract<SheetSection, { kind: 'list' }> => s.kind === 'list' && s.id.startsWith('spells.l'))
    .flatMap((s) => s.items);
}

// The workspace has no @types/node and this package's tsconfig lib is
// ES2022, which doesn't declare the (Node 17+/browser) global structuredClone
// used below to build a mutated copy of a fixture without touching the
// original object other tests share (same declaration as actions.test.ts).
declare const structuredClone: <T>(value: T) => T;

function expectIntentError(fn: () => unknown, code: IntentError['code']): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(IntentError);
  expect((caught as IntentError).code).toBe(code);
}

describe('exports', () => {
  it('exports the adapter as named and default export', () => {
    expect(dnd5eAdapter.systemId).toBe('dnd5e');
    expect(dnd5eAdapterDefault).toBe(dnd5eAdapter);
  });
});

describe('view model — martial (source-shaped data, fallback math)', () => {
  const vm = dnd5eAdapter.toViewModel(martial);

  it('carries identity', () => {
    expect(vm.actorId).toBe('actorMartial0001');
    expect(vm.systemId).toBe('dnd5e');
    expect(vm.name).toBe('Bram Ironfist');
    expect(vm.img).toBe('icons/svg/mystery-man.svg');
  });

  it('headline: AC, class line, speed, proficiency, initiative', () => {
    const byId = new Map(vm.headline.map((s) => [s.id, s]));
    expect(byId.get('ac')?.value).toBe(18); // ac.flat, no derived ac.value
    expect(byId.get('class')?.value).toBe('Fighter 5');
    expect(byId.get('speed')?.value).toBe('30 ft');
    expect(byId.get('prof')?.value).toBe('+3'); // level 5 from class item levels
    expect(byId.get('init')?.value).toBe('+2'); // dex mod fallback
  });

  it('abilities: six scores with computed modifier as sub', () => {
    const s = section(martial, 'abilities');
    if (s.kind !== 'stats') throw new Error('abilities must be a stats section');
    expect(s.stats).toHaveLength(6);
    const str = s.stats.find((x) => x.id === 'ability.str');
    expect(str?.value).toBe(16);
    expect(str?.sub).toBe('+3'); // sub stays the bare modifier (gems render it large)
    expect(str?.label).toBe('Strength ●'); // save-proficient (M14) marks the label
    const cha = s.stats.find((x) => x.id === 'ability.cha');
    expect(cha?.value).toBe(8);
    expect(cha?.sub).toBe('-1');
    expect(cha?.label).toBe('Charisma');
  });

  it('skills: all 18, computed total, proficient tag in sub', () => {
    const s = section(martial, 'skills');
    if (s.kind !== 'stats') throw new Error('skills must be a stats section');
    expect(s.stats).toHaveLength(18);
    const ath = s.stats.find((x) => x.id === 'skill.ath');
    expect(ath?.value).toBe('+6'); // str +3 + prof +3
    expect(ath?.sub).toBe('STR · ● proficient');
    const acr = s.stats.find((x) => x.id === 'skill.acr');
    expect(acr?.value).toBe('+2'); // dex +2, not proficient
    expect(acr?.sub).toBe('DEX');
  });

  it('vitals tracks hp, temp hp, death saves, hit dice, inspiration, exhaustion', () => {
    const s = section(martial, 'vitals');
    if (s.kind !== 'tracks') throw new Error('vitals must be a tracks section');
    expect(s.resourceIds).toEqual([
      'hp',
      'hp.temp',
      'deathsaves.success',
      'deathsaves.failure',
      'hitdice.d10',
      'inspiration',
      'exhaustion',
    ]);
  });

  it('speed includes non-walk movement modes when present (§1 "speeds")', () => {
    const flyer: FoundryActorDoc = {
      ...martial,
      system: {
        ...martial.system,
        attributes: {
          ...(martial.system.attributes as Record<string, unknown>),
          movement: { walk: 30, fly: 60, swim: 20, climb: 0, burrow: 0, units: 'ft', hover: true },
        },
      },
    };
    const byId = new Map(dnd5eAdapter.toViewModel(flyer).headline.map((s) => [s.id, s]));
    expect(byId.get('speed')?.value).toBe('30 ft · fly 60 ft · swim 20 ft · hover');
  });

  it('has no spell slot and no spells section for a non-caster', () => {
    expect(vm.sections.find((s) => s.id === 'slots')).toBeUndefined();
    expect(vm.sections.find((s) => s.id === 'spells')).toBeUndefined();
  });

  it('inventory: physical items with qty/type sub and resource links', () => {
    const s = section(martial, 'inventory');
    if (s.kind !== 'list') throw new Error('inventory must be a list section');
    expect(s.items.map((i) => i.label)).toEqual([
      'Longsword',
      'Longbow',
      'Arrows',
      "Healer's Kit",
      'Chain Mail',
    ]);
    const arrows = s.items.find((i) => i.label === 'Arrows');
    expect(arrows?.sub).toBe('×20 · consumable · 20 × 0.05 lb');
    expect(arrows?.resourceId).toBe('item.itmArrows0000001.qty');
    const kit = s.items.find((i) => i.label === "Healer's Kit");
    expect(kit?.resourceId).toBe('item.itmHealersKit001.uses'); // uses preferred over qty
    const sword = s.items.find((i) => i.label === 'Longsword');
    expect(sword?.tags).toEqual(['equipped']);
  });

  it('features: feat items with uses linked', () => {
    const s = section(martial, 'features');
    if (s.kind !== 'list') throw new Error('features must be a list section');
    expect(s.items.map((i) => i.label)).toEqual(['Second Wind', 'Action Surge']);
    const sw = s.items.find((i) => i.label === 'Second Wind');
    expect(sw?.sub).toBe('Class feature');
    expect(sw?.resourceId).toBe('item.featSecondWind01.uses');
  });

  it('currency tracks all five denominations', () => {
    const s = section(martial, 'currency');
    if (s.kind !== 'tracks') throw new Error('currency must be a tracks section');
    expect(s.resourceIds).toEqual(['currency.pp', 'currency.gp', 'currency.ep', 'currency.sp', 'currency.cp']);
  });

  it('embeds the resource descriptors', () => {
    expect(vm.resources).toEqual(dnd5eAdapter.resources(martial));
  });
});

describe('view model — caster (derived data preferred)', () => {
  it('headline uses derived AC, prof, and initiative', () => {
    const byId = new Map(dnd5eAdapter.toViewModel(caster).headline.map((s) => [s.id, s]));
    expect(byId.get('ac')?.value).toBe(18); // derived ac.value, not flat/dex fallback
    expect(byId.get('class')?.value).toBe('Cleric 5');
    expect(byId.get('speed')?.value).toBe('25 ft');
    expect(byId.get('prof')?.value).toBe('+3');
    expect(byId.get('init')?.value).toBe('+0'); // derived init.total
  });

  it('abilities use derived modifiers', () => {
    const s = section(caster, 'abilities');
    if (s.kind !== 'stats') throw new Error('abilities must be a stats section');
    const wis = s.stats.find((x) => x.id === 'ability.wis');
    expect(wis?.value).toBe(18);
    expect(wis?.sub).toBe('+4');
    expect(wis?.label).toBe('Wisdom ●'); // save-proficient (M14)
  });

  it('skills prefer derived totals over the computed fallback', () => {
    const s = section(caster, 'skills');
    if (s.kind !== 'stats') throw new Error('skills must be a stats section');
    expect(s.stats).toHaveLength(18);
    // rel has a +2 check bonus baked into the derived total; the computed
    // fallback (int +0, not proficient) would say +0.
    const rel = s.stats.find((x) => x.id === 'skill.rel');
    expect(rel?.value).toBe('+2');
    const ins = s.stats.find((x) => x.id === 'skill.ins');
    expect(ins?.value).toBe('+7');
    expect(ins?.sub).toBe('WIS · ● proficient');
  });

  it('slots section lists present slot levels only (no empty levels, no pact)', () => {
    const s = section(caster, 'slots');
    if (s.kind !== 'tracks') throw new Error('slots must be a tracks section');
    expect(s.resourceIds).toEqual(['slots.1', 'slots.2', 'slots.3']);
  });

  it('spells list: level, school, prepared state in sub; tags for prepared/concentration/ritual', () => {
    const s = { items: spellRows(caster) };
    expect(s.items).toHaveLength(6);

    const detect = s.items.find((i) => i.label === 'Detect Magic');
    expect(detect?.sub).toBe('1st level · Divination · always prepared');
    expect(detect?.tags).toEqual(['prepared', 'concentration', 'ritual']);

    const guardians = s.items.find((i) => i.label === 'Spirit Guardians');
    expect(guardians?.sub).toBe('3rd level · Conjuration · prepared');
    expect(guardians?.tags).toEqual(['prepared', 'concentration']);

    const weapon = s.items.find((i) => i.label === 'Spiritual Weapon');
    expect(weapon?.sub).toBe('2nd level · Evocation');
    expect(weapon?.tags).toBeUndefined(); // known but not prepared

    const flame = s.items.find((i) => i.label === 'Sacred Flame');
    expect(flame?.sub).toBe('Cantrip · Evocation · prepared');
  });

  it('features link uses-backed resources', () => {
    const s = section(caster, 'features');
    if (s.kind !== 'list') throw new Error('features must be a list section');
    const cd = s.items.find((i) => i.label === 'Channel Divinity');
    expect(cd?.resourceId).toBe('item.featChannelDiv01.uses');
  });
});

describe('resource descriptors — bounds', () => {
  it('hp: min 0, max from hp.max', () => {
    const hp = resource(martial, 'hp');
    expect(hp).toMatchObject({ value: 34, min: 0, max: 44, writable: true });
  });

  it('hp.temp: min 0, no max', () => {
    const temp = resource(martial, 'hp.temp');
    expect(temp.value).toBe(5);
    expect(temp.min).toBe(0);
    expect(temp.max).toBeUndefined();
    expect(temp.writable).toBe(true);
  });

  it('death saves: 0..3', () => {
    for (const id of ['deathsaves.success', 'deathsaves.failure']) {
      const d = resource(martial, id);
      expect(d.min).toBe(0);
      expect(d.max).toBe(3);
      expect(d.writable).toBe(true);
    }
  });

  it('hit dice: remaining out of class levels, per denomination', () => {
    const hd = resource(martial, 'hitdice.d10');
    expect(hd).toMatchObject({ value: 4, min: 0, max: 5, writable: true }); // 5 levels, 1 used
    const hd8 = resource(caster, 'hitdice.d8');
    expect(hd8).toMatchObject({ value: 5, min: 0, max: 5 });
  });

  it('spell slots: value/max per present level; absent for non-casters', () => {
    expect(resource(caster, 'slots.1')).toMatchObject({ value: 2, min: 0, max: 4, writable: true });
    expect(resource(caster, 'slots.2')).toMatchObject({ value: 1, max: 3 });
    expect(resource(caster, 'slots.3')).toMatchObject({ value: 2, max: 2 });
    expect(dnd5eAdapter.resources(martial).some((r) => r.id.startsWith('slots.'))).toBe(false);
    expect(dnd5eAdapter.resources(caster).find((r) => r.id === 'slots.pact')).toBeUndefined();
  });

  it('item quantity: min 0, no max', () => {
    const qty = resource(martial, 'item.itmArrows0000001.qty');
    expect(qty.value).toBe(20);
    expect(qty.min).toBe(0);
    expect(qty.max).toBeUndefined();
  });

  it('item uses: remaining = max - spent (string formula max in source data)', () => {
    expect(resource(martial, 'item.itmHealersKit001.uses')).toMatchObject({ value: 8, min: 0, max: 10 });
    expect(resource(martial, 'item.featSecondWind01.uses')).toMatchObject({ value: 1, max: 1 });
    expect(resource(caster, 'item.featChannelDiv01.uses')).toMatchObject({ value: 1, min: 0, max: 2 });
    // items whose uses.max is an empty formula get no uses resource
    expect(dnd5eAdapter.resources(martial).find((r) => r.id === 'item.itmLongsword0001.uses')).toBeUndefined();
  });

  it('currency: min 0, writable', () => {
    const gp = resource(martial, 'currency.gp');
    expect(gp).toMatchObject({ value: 25, min: 0, writable: true });
  });

  it('ac is tracked but read-only', () => {
    const ac = resource(martial, 'ac');
    expect(ac.value).toBe(18);
    expect(ac.writable).toBe(false);
  });

  it('pact slots appear when the actor has them', () => {
    const warlockish: FoundryActorDoc = {
      _id: 'actorPact0000001',
      name: 'Pact Test',
      type: 'character',
      system: { spells: { pact: { value: 1, max: 2, override: null } } },
      items: [],
    };
    expect(resource(warlockish, 'slots.pact')).toMatchObject({ value: 1, min: 0, max: 2, writable: true });
    const update = dnd5eAdapter.buildUpdate(warlockish, { kind: 'set', resourceId: 'slots.pact', value: 0 });
    expect(update).toEqual({ data: { 'system.spells.pact.value': 0 } });
  });

  it('slot resources carry their spell level for the pips UI', () => {
    expect(resource(caster, 'slots.1').level).toBe(1);
    expect(resource(caster, 'slots.3').level).toBe(3);
    const warlockish: FoundryActorDoc = {
      _id: 'actorPact0000002',
      name: 'Pact Pips',
      type: 'character',
      system: { spells: { pact: { value: 1, max: 2, level: 3 } } },
      items: [],
    };
    expect(resource(warlockish, 'slots.pact').level).toBe(3);
  });
});

describe('buildUpdate — clamping and paths', () => {
  it('hp delta clamps at max', () => {
    const u = dnd5eAdapter.buildUpdate(martial, { kind: 'delta', resourceId: 'hp', amount: 100 });
    expect(u).toEqual({ data: { 'system.attributes.hp.value': 44 } });
    expect(u.itemId).toBeUndefined();
  });

  it('hp delta clamps at min 0', () => {
    const u = dnd5eAdapter.buildUpdate(martial, { kind: 'delta', resourceId: 'hp', amount: -100 });
    expect(u.data['system.attributes.hp.value']).toBe(0);
  });

  it('hp set writes the value unclamped inside bounds', () => {
    const u = dnd5eAdapter.buildUpdate(martial, { kind: 'set', resourceId: 'hp', value: 20 });
    expect(u.data['system.attributes.hp.value']).toBe(20);
  });

  it('hp set is a direct, literal write — temp HP is untouched even though value drops (martial has temp 5)', () => {
    // `set` is used by administrative/GM-style writes, not the PWA's damage
    // controls (those always send `delta`). A set below the current value
    // is NOT treated as "damage" — see the delta-only branch below.
    const u = dnd5eAdapter.buildUpdate(martial, { kind: 'set', resourceId: 'hp', value: 20 });
    expect(u.data['system.attributes.hp.temp']).toBeUndefined();
  });

  it('damage (delta) smaller than temp HP: temp absorbs it all, hp.value unchanged (martial: value 34, temp 5)', () => {
    const u = dnd5eAdapter.buildUpdate(martial, { kind: 'delta', resourceId: 'hp', amount: -3 });
    expect(u.data['system.attributes.hp.value']).toBe(34);
    expect(u.data['system.attributes.hp.temp']).toBe(2);
  });

  it('damage (delta) larger than temp HP: temp drains to 0, remainder comes off hp.value (martial: value 34, temp 5)', () => {
    const u = dnd5eAdapter.buildUpdate(martial, { kind: 'delta', resourceId: 'hp', amount: -8 });
    expect(u.data['system.attributes.hp.value']).toBe(31);
    expect(u.data['system.attributes.hp.temp']).toBe(0);
  });

  it('regression: 44/44 +2 temp taking 5 damage ends at temp 0, hp.value 41 (live bug report)', () => {
    const randal: FoundryActorDoc = structuredClone(martial);
    (randal.system as { attributes: { hp: { value: number; max: number; temp: number } } }).attributes.hp = {
      value: 44,
      max: 44,
      temp: 2,
    };
    const u = dnd5eAdapter.buildUpdate(randal, { kind: 'delta', resourceId: 'hp', amount: -5 });
    expect(u.data['system.attributes.hp.value']).toBe(41);
    expect(u.data['system.attributes.hp.temp']).toBe(0);
  });

  it('damage (delta) with temp HP at 0: behaves exactly as before (no temp key written)', () => {
    const noTemp: FoundryActorDoc = structuredClone(martial);
    (noTemp.system as { attributes: { hp: { value: number; max: number; temp: number } } }).attributes.hp.temp = 0;
    const u = dnd5eAdapter.buildUpdate(noTemp, { kind: 'delta', resourceId: 'hp', amount: -10 });
    expect(u).toEqual({ data: { 'system.attributes.hp.value': 24 } });
  });

  it('damage (delta) with temp HP undefined: behaves exactly as before (no temp key written)', () => {
    const noTemp: FoundryActorDoc = structuredClone(martial);
    const hp = (noTemp.system as { attributes: { hp: Record<string, unknown> } }).attributes.hp;
    delete hp.temp;
    const u = dnd5eAdapter.buildUpdate(noTemp, { kind: 'delta', resourceId: 'hp', amount: -10 });
    expect(u).toEqual({ data: { 'system.attributes.hp.value': 24 } });
  });

  it('healing (positive delta) leaves temp HP untouched even when not clamped at max (martial: value 34, temp 5)', () => {
    const u = dnd5eAdapter.buildUpdate(martial, { kind: 'delta', resourceId: 'hp', amount: 3 });
    expect(u).toEqual({ data: { 'system.attributes.hp.value': 37 } });
  });

  it('hp.temp floors at 0 and has no upper clamp', () => {
    expect(
      dnd5eAdapter.buildUpdate(martial, { kind: 'set', resourceId: 'hp.temp', value: -3 }).data[
        'system.attributes.hp.temp'
      ],
    ).toBe(0);
    expect(
      dnd5eAdapter.buildUpdate(martial, { kind: 'delta', resourceId: 'hp.temp', amount: 995 }).data[
        'system.attributes.hp.temp'
      ],
    ).toBe(1000);
  });

  it('death saves clamp to 0..3', () => {
    expect(
      dnd5eAdapter.buildUpdate(martial, { kind: 'set', resourceId: 'deathsaves.success', value: 5 }).data[
        'system.attributes.death.success'
      ],
    ).toBe(3);
    expect(
      dnd5eAdapter.buildUpdate(martial, { kind: 'delta', resourceId: 'deathsaves.failure', amount: -2 }).data[
        'system.attributes.death.failure'
      ],
    ).toBe(0);
  });

  it('spell slot set beyond max clamps to max', () => {
    const u = dnd5eAdapter.buildUpdate(caster, { kind: 'set', resourceId: 'slots.1', value: 99 });
    expect(u).toEqual({ data: { 'system.spells.spell1.value': 4 } });
  });

  it('spell slot delta spends one slot', () => {
    const u = dnd5eAdapter.buildUpdate(caster, { kind: 'delta', resourceId: 'slots.3', amount: -1 });
    expect(u).toEqual({ data: { 'system.spells.spell3.value': 1 } });
  });

  it('item quantity targets the item with system.quantity', () => {
    const u = dnd5eAdapter.buildUpdate(martial, {
      kind: 'delta',
      resourceId: 'item.itmArrows0000001.qty',
      amount: -5,
    });
    expect(u).toEqual({ itemId: 'itmArrows0000001', data: { 'system.quantity': 15 } });
  });

  it('item quantity floors at 0', () => {
    const u = dnd5eAdapter.buildUpdate(martial, {
      kind: 'delta',
      resourceId: 'item.itmArrows0000001.qty',
      amount: -100,
    });
    expect(u.data['system.quantity']).toBe(0);
  });

  it('item uses: delta -1 spends one charge by writing system.uses.spent', () => {
    // Healer's Kit: max 10, spent 2 -> remaining 8; spending one -> spent 3.
    const u = dnd5eAdapter.buildUpdate(martial, {
      kind: 'delta',
      resourceId: 'item.itmHealersKit001.uses',
      amount: -1,
    });
    expect(u).toEqual({ itemId: 'itmHealersKit001', data: { 'system.uses.spent': 3 } });
  });

  it('item uses: set 0 remaining -> spent = max; set beyond max clamps to spent 0', () => {
    expect(
      dnd5eAdapter.buildUpdate(martial, { kind: 'set', resourceId: 'item.itmHealersKit001.uses', value: 0 }).data[
        'system.uses.spent'
      ],
    ).toBe(10);
    expect(
      dnd5eAdapter.buildUpdate(martial, { kind: 'set', resourceId: 'item.itmHealersKit001.uses', value: 99 }).data[
        'system.uses.spent'
      ],
    ).toBe(0);
  });

  it('currency floors at 0', () => {
    const u = dnd5eAdapter.buildUpdate(caster, { kind: 'delta', resourceId: 'currency.cp', amount: -9999 });
    expect(u).toEqual({ data: { 'system.currency.cp': 0 } });
  });
});

describe('buildUpdate — hit dice', () => {
  it('spending a die increments the class item hd.spent', () => {
    const u = dnd5eAdapter.buildUpdate(martial, { kind: 'delta', resourceId: 'hitdice.d10', amount: -1 });
    expect(u).toEqual({ itemId: 'clsFighter000001', data: { 'system.hd.spent': 2 } });
  });

  it('regaining clamps at max remaining (hd.spent floors at 0)', () => {
    const u = dnd5eAdapter.buildUpdate(martial, { kind: 'delta', resourceId: 'hitdice.d10', amount: 10 });
    expect(u).toEqual({ itemId: 'clsFighter000001', data: { 'system.hd.spent': 0 } });
  });

  const multiclass: FoundryActorDoc = {
    _id: 'actorMulti000001',
    name: 'Multi Test',
    type: 'character',
    system: {},
    items: [
      {
        _id: 'clsAAAAAAAAAAAA1',
        name: 'ClassA',
        type: 'class',
        system: { levels: 3, hd: { denomination: 'd8', spent: 1, additional: '' } },
      },
      {
        _id: 'clsBBBBBBBBBBBB2',
        name: 'ClassB',
        type: 'class',
        system: { levels: 2, hd: { denomination: 'd8', spent: 2, additional: '' } },
      },
    ],
  };

  it('aggregates one descriptor per denomination across classes', () => {
    const hd = resource(multiclass, 'hitdice.d8');
    expect(hd).toMatchObject({ value: 2, min: 0, max: 5 }); // (3-1) + (2-2)
  });

  it('spends from the class with the most remaining dice', () => {
    const u = dnd5eAdapter.buildUpdate(multiclass, { kind: 'delta', resourceId: 'hitdice.d8', amount: -1 });
    expect(u).toEqual({ itemId: 'clsAAAAAAAAAAAA1', data: { 'system.hd.spent': 2 } });
  });

  it('regains to the class with the most used dice', () => {
    const u = dnd5eAdapter.buildUpdate(multiclass, { kind: 'delta', resourceId: 'hitdice.d8', amount: 1 });
    expect(u).toEqual({ itemId: 'clsBBBBBBBBBBBB2', data: { 'system.hd.spent': 1 } });
  });
});

describe('buildUpdate — rejections', () => {
  it('unknown resource -> UNKNOWN_RESOURCE', () => {
    expectIntentError(
      () => dnd5eAdapter.buildUpdate(martial, { kind: 'set', resourceId: 'nope', value: 1 }),
      'UNKNOWN_RESOURCE',
    );
  });

  it('slot the actor does not have -> UNKNOWN_RESOURCE', () => {
    expectIntentError(
      () => dnd5eAdapter.buildUpdate(martial, { kind: 'set', resourceId: 'slots.1', value: 1 }),
      'UNKNOWN_RESOURCE',
    );
    expectIntentError(
      () => dnd5eAdapter.buildUpdate(caster, { kind: 'set', resourceId: 'slots.9', value: 1 }),
      'UNKNOWN_RESOURCE',
    );
  });

  it('read-only resource (ac) -> READ_ONLY', () => {
    expectIntentError(
      () => dnd5eAdapter.buildUpdate(martial, { kind: 'set', resourceId: 'ac', value: 20 }),
      'READ_ONLY',
    );
  });

  it('non-finite or non-integer payload -> INVALID', () => {
    expectIntentError(
      () => dnd5eAdapter.buildUpdate(martial, { kind: 'set', resourceId: 'hp', value: 3.5 }),
      'INVALID',
    );
    expectIntentError(
      () => dnd5eAdapter.buildUpdate(martial, { kind: 'delta', resourceId: 'hp', amount: Number.NaN }),
      'INVALID',
    );
    expectIntentError(
      () =>
        dnd5eAdapter.buildUpdate(martial, {
          kind: 'delta',
          resourceId: 'hp',
          amount: Number.POSITIVE_INFINITY,
        }),
      'INVALID',
    );
  });
});

// ---------------------------------------------------------------------------
// Captured fixtures — verbatim actor documents from the live M0 world
// (dnd5e 5.3.3 / Foundry 13.351, fetched through the relay). Ground truth for
// the serialization the gateway sees: class hit dice live in
// `system.hd.{denomination,spent}`, spells carry `system.method` + numeric
// `system.prepared`, and NO derived skill totals / ability mods / prof are
// serialized — the fallback math must carry the sheet.

describe('captured fixtures — martial (Randal, Fighter 5)', () => {
  it('toViewModel and resources do not throw', () => {
    expect(() => dnd5eAdapter.toViewModel(martialCaptured)).not.toThrow();
    expect(() => dnd5eAdapter.resources(martialCaptured)).not.toThrow();
  });

  it('hp matches the captured values exactly (35/44, temp 5)', () => {
    expect(resource(martialCaptured, 'hp')).toMatchObject({ value: 35, min: 0, max: 44, writable: true });
    expect(resource(martialCaptured, 'hp.temp')).toMatchObject({ value: 5, min: 0, writable: true });
  });

  it('AC falls back to equipped armor (chain mail 16, dex cap 0, shield +2 = 18)', () => {
    const byId = new Map(dnd5eAdapter.toViewModel(martialCaptured).headline.map((s) => [s.id, s]));
    expect(byId.get('ac')?.value).toBe(18);
  });

  it('speed falls back to the race item (30 ft)', () => {
    const byId = new Map(dnd5eAdapter.toViewModel(martialCaptured).headline.map((s) => [s.id, s]));
    expect(byId.get('speed')?.value).toBe('30 ft');
  });

  it('death saves come from system.attributes.death', () => {
    expect(resource(martialCaptured, 'deathsaves.success')).toMatchObject({ value: 0, min: 0, max: 3 });
    expect(resource(martialCaptured, 'deathsaves.failure')).toMatchObject({ value: 0, min: 0, max: 3 });
  });

  it('hit dice: denomination from hd.denomination, remaining = levels - hd.spent', () => {
    // Fighter 5, hd { denomination: "d10", spent: 1 } -> 4 of 5 remaining.
    expect(resource(martialCaptured, 'hitdice.d10')).toMatchObject({
      value: 4,
      min: 0,
      max: 5,
      writable: true,
    });
  });

  it("buildUpdate for hitdice.d10 writes system.hd.spent on the Fighter class item", () => {
    const u = dnd5eAdapter.buildUpdate(martialCaptured, { kind: 'delta', resourceId: 'hitdice.d10', amount: -1 });
    expect(u).toEqual({ itemId: 'IMdfN9m0aSEgqbYt', data: { 'system.hd.spent': 2 } });
  });

  it('has no spell slot resources (all captured slot values are 0, override null)', () => {
    expect(dnd5eAdapter.resources(martialCaptured).some((r) => r.id.startsWith('slots.'))).toBe(false);
  });

  it('inventory items carry qty resources (Torch ×10)', () => {
    expect(resource(martialCaptured, 'item.Di7LgeBsM42Mi6yF.qty')).toMatchObject({
      value: 10,
      min: 0,
      writable: true,
      group: 'inventory',
    });
    const inv = section(martialCaptured, 'inventory');
    if (inv.kind !== 'list') throw new Error('inventory must be a list section');
    const torch = inv.items.find((i) => i.label === 'Torch');
    expect(torch?.sub).toBe('×10 · consumable · 10 × 1 lb');
  });

  describe('inventory row recharge display (M16)', () => {
    function withWaterskinRecovery(period: string): FoundryActorDoc {
      return {
        ...martialCaptured,
        items: (martialCaptured.items ?? []).map((i) =>
          i._id === '4c3saZuHGHXb8Qlg' // Waterskin
            ? {
                ...i,
                system: {
                  ...(i.system as Record<string, unknown>),
                  uses: { max: '4', spent: 0, recovery: [{ period, type: 'recoverAll' }] },
                },
              }
            : i,
        ),
      };
    }

    it('shows a friendly recharge label when the item has a recovery period', () => {
      const inv = section(withWaterskinRecovery('dawn'), 'inventory');
      if (inv.kind !== 'list') throw new Error('inventory must be a list section');
      expect(inv.items.find((i) => i.label === 'Waterskin')?.sub).toBe('consumable · 5 lb · recharges: dawn');
    });

    it('maps the short rest period to a friendly label', () => {
      const inv = section(withWaterskinRecovery('sr'), 'inventory');
      if (inv.kind !== 'list') throw new Error('inventory must be a list section');
      expect(inv.items.find((i) => i.label === 'Waterskin')?.sub).toBe('consumable · 5 lb · recharges: short rest');
    });

    it('shows nothing extra for items with no recovery period (Bead of Force, real data)', () => {
      const inv = section(martialCaptured, 'inventory');
      if (inv.kind !== 'list') throw new Error('inventory must be a list section');
      expect(inv.items.find((i) => i.label === 'Bead of Force')?.sub).toBe('consumable · 0.06 lb');
    });
  });

  it('item uses: Torch has uses.max "1" (string formula) -> uses resource 1/1', () => {
    expect(resource(martialCaptured, 'item.Di7LgeBsM42Mi6yF.uses')).toMatchObject({ value: 1, min: 0, max: 1 });
    // Second Wind feat: uses.max "1", spent 0.
    expect(resource(martialCaptured, 'item.7r63kurEAM3GdEec.uses')).toMatchObject({ value: 1, max: 1 });
  });

  it('currency matches the capture', () => {
    expect(resource(martialCaptured, 'currency.gp').value).toBe(10);
    expect(resource(martialCaptured, 'currency.pp').value).toBe(0);
  });

  it('skills render numeric-looking totals via the fallback (no serialized total)', () => {
    const s = section(martialCaptured, 'skills');
    if (s.kind !== 'stats') throw new Error('skills must be a stats section');
    expect(s.stats).toHaveLength(18);
    for (const stat of s.stats) {
      expect(String(stat.value)).toMatch(/^[+-]\d+$/);
    }
    // Athletics: str 16 -> +3, proficient, prof +3 (level 5) -> +6.
    expect(s.stats.find((x) => x.id === 'skill.ath')?.value).toBe('+6');
  });
});

describe('captured fixtures — caster (Akra, Cleric 5)', () => {
  it('toViewModel and resources do not throw', () => {
    expect(() => dnd5eAdapter.toViewModel(casterCaptured)).not.toThrow();
    expect(() => dnd5eAdapter.resources(casterCaptured)).not.toThrow();
  });

  it('hp matches the captured values exactly (38/38, temp null -> 0)', () => {
    expect(resource(casterCaptured, 'hp')).toMatchObject({ value: 38, min: 0, max: 38, writable: true });
    expect(resource(casterCaptured, 'hp.temp')).toMatchObject({ value: 0, min: 0 });
  });

  it('AC falls back to equipped armor (scale mail 14, dex 0 capped at 2, shield +2 = 16)', () => {
    const byId = new Map(dnd5eAdapter.toViewModel(casterCaptured).headline.map((s) => [s.id, s]));
    expect(byId.get('ac')?.value).toBe(16);
  });

  it('hit dice: d8, nothing spent -> 5 of 5', () => {
    expect(resource(casterCaptured, 'hitdice.d8')).toMatchObject({ value: 5, min: 0, max: 5, writable: true });
  });

  it("buildUpdate for hitdice.d8 writes system.hd.spent on the Cleric class item", () => {
    const u = dnd5eAdapter.buildUpdate(casterCaptured, { kind: 'delta', resourceId: 'hitdice.d8', amount: -1 });
    expect(u).toEqual({ itemId: 'PZNSd7pd1tmTdLmw', data: { 'system.hd.spent': 1 } });
  });

  it('spell slots 1..3 carry the captured values (max not serialized -> falls back to value)', () => {
    expect(resource(casterCaptured, 'slots.1')).toMatchObject({ value: 2, min: 0, max: 2, writable: true });
    expect(resource(casterCaptured, 'slots.2')).toMatchObject({ value: 2, min: 0, max: 2, writable: true });
    expect(resource(casterCaptured, 'slots.3')).toMatchObject({ value: 1, min: 0, max: 1, writable: true });
    const ids = dnd5eAdapter.resources(casterCaptured).filter((r) => r.id.startsWith('slots.')).map((r) => r.id);
    expect(ids).toEqual(['slots.1', 'slots.2', 'slots.3']);
  });

  it('spells section lists spells with level info and method/prepared-based tags', () => {
    const s = { items: spellRows(casterCaptured) };
    expect(s.items.length).toBe(18);
    for (const item of s.items) {
      expect(item.sub).toMatch(/^(Cantrip|1st level|2nd level|3rd level)/);
    }
    // prepared: 1 -> prepared
    const bolt = s.items.find((i) => i.label === 'Guiding Bolt');
    expect(bolt?.sub).toBe('1st level · Evocation · prepared');
    expect(bolt?.tags).toEqual(['prepared']);
    // prepared: 2 -> always prepared (Life Domain spell)
    const bless = s.items.find((i) => i.label === 'Bless');
    expect(bless?.sub).toBe('1st level · Enchantment · always prepared');
    expect(bless?.tags).toEqual(['prepared', 'concentration']);
    // prepared: 0 -> known, not prepared; properties still drive tags
    const bane = s.items.find((i) => i.label === 'Bane');
    expect(bane?.sub).toBe('1st level · Enchantment');
    expect(bane?.tags).toEqual(['concentration']);
    const purify = s.items.find((i) => i.label === 'Purify Food and Drink');
    expect(purify?.tags).toEqual(['ritual']);
    // level 0 -> Cantrip
    const thaumaturgy = s.items.find((i) => i.label === 'Thaumaturgy');
    expect(thaumaturgy?.sub).toBe('Cantrip · Transmutation');
  });

  it('inventory items carry qty resources (Rations ×10)', () => {
    expect(resource(casterCaptured, 'item.WZX5bXeFiAw2BEU9.qty')).toMatchObject({
      value: 10,
      min: 0,
      writable: true,
      group: 'inventory',
    });
  });

  it('skills render numeric-looking totals via the fallback (no serialized total)', () => {
    const s = section(casterCaptured, 'skills');
    if (s.kind !== 'stats') throw new Error('skills must be a stats section');
    expect(s.stats).toHaveLength(18);
    for (const stat of s.stats) {
      expect(String(stat.value)).toMatch(/^[+-]\d+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// M14 — proficiency markers: skills (◐/●/◆ from skills.X.value) appended to
// the sub text; saves (● suffix on the ability LABEL, from
// abilities.X.proficient >= 1 — same threshold saveBonus rolls with). The
// ability sub must stay a bare modifier: the PWA gems render it at 2rem.

describe('M14 — skill and save proficiency markers', () => {
  function stats(actor: FoundryActorDoc, sectionId: string) {
    const s = section(actor, sectionId);
    if (s.kind !== 'stats') throw new Error(`${sectionId} must be a stats section`);
    return s.stats;
  }
  const skillSub = (actor: FoundryActorDoc, id: string) =>
    stats(actor, 'skills').find((x) => x.id === `skill.${id}`)?.sub;
  const abilitySub = (actor: FoundryActorDoc, id: string) =>
    stats(actor, 'abilities').find((x) => x.id === `ability.${id}`)?.sub;

  it('martial (Randal): ● proficient marker exactly on acr/ath/ins/itm/per, ability label preserved', () => {
    const proficient: Record<string, string> = { acr: 'DEX', ath: 'STR', ins: 'WIS', itm: 'CHA', per: 'CHA' };
    for (const [id, ability] of Object.entries(proficient)) {
      expect(skillSub(martialCaptured, id)).toBe(`${ability} · ● proficient`);
    }
    // Every other skill carries only the governing ability label — no marker.
    for (const stat of stats(martialCaptured, 'skills')) {
      const id = stat.id.slice('skill.'.length);
      if (!(id in proficient)) expect(stat.sub).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('caster (Akra): ● proficient marker exactly on his/ins/med/prc/rel', () => {
    const proficient: Record<string, string> = { his: 'INT', ins: 'WIS', med: 'WIS', prc: 'WIS', rel: 'INT' };
    for (const [id, ability] of Object.entries(proficient)) {
      expect(skillSub(casterCaptured, id)).toBe(`${ability} · ● proficient`);
    }
    for (const stat of stats(casterCaptured, 'skills')) {
      const id = stat.id.slice('skill.'.length);
      if (!(id in proficient)) expect(stat.sub).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('half proficiency and expertise get ◐ / ◆ markers', () => {
    const tweaked: FoundryActorDoc = {
      ...martialCaptured,
      system: {
        ...martialCaptured.system,
        skills: {
          ...(martialCaptured.system.skills as Record<string, unknown>),
          acr: { value: 0.5, ability: 'dex' },
          ath: { value: 2, ability: 'str' },
        },
      },
    };
    expect(skillSub(tweaked, 'acr')).toBe('DEX · ◐ half');
    expect(skillSub(tweaked, 'ath')).toBe('STR · ◆ expertise');
  });

  const abilityLabel = (actor: FoundryActorDoc, id: string) =>
    stats(actor, 'abilities').find((x) => x.id === `ability.${id}`)?.label;

  it('martial (Randal): str + con save proficiency marks the LABEL; sub stays the bare modifier', () => {
    expect(abilityLabel(martialCaptured, 'str')).toBe('Strength ●');
    expect(abilityLabel(martialCaptured, 'con')).toBe('Constitution ●');
    expect(abilitySub(martialCaptured, 'str')).toBe('+3');
    expect(abilitySub(martialCaptured, 'con')).toBe('+2');
    // Non-proficient abilities: plain label, bare modifier.
    expect(abilityLabel(martialCaptured, 'dex')).toBe('Dexterity');
    expect(abilitySub(martialCaptured, 'dex')).toBe('+2');
    expect(abilitySub(martialCaptured, 'int')).toBe('-1');
    expect(abilitySub(martialCaptured, 'wis')).toBe('+1');
    expect(abilitySub(martialCaptured, 'cha')).toBe('+0');
  });

  it('caster (Akra): wis + cha save proficiency marks the label', () => {
    expect(abilityLabel(casterCaptured, 'wis')).toBe('Wisdom ●');
    expect(abilityLabel(casterCaptured, 'cha')).toBe('Charisma ●');
    expect(abilitySub(casterCaptured, 'wis')).toBe('+2');
    expect(abilitySub(casterCaptured, 'cha')).toBe('-1');
    expect(abilityLabel(casterCaptured, 'str')).toBe('Strength');
  });

  it('proficient values above 1 (active effects/modules) still show the marker — matches saveBonus', () => {
    const doubled: FoundryActorDoc = {
      ...martialCaptured,
      system: {
        ...martialCaptured.system,
        abilities: {
          ...(martialCaptured.system.abilities as Record<string, unknown>),
          dex: { value: 14, proficient: 2 },
        },
      },
    };
    expect(abilityLabel(doubled, 'dex')).toBe('Dexterity ●');
  });
});

// ---------------------------------------------------------------------------
// M8 — conditions + concentration from actor.effects, and item detail.

describe('conditions + concentration (actor.effects)', () => {
  const withEffects: FoundryActorDoc = {
    ...martialCaptured,
    effects: [
      // Concentration marker: name prefix + statuses.
      {
        _id: 'effConc0000000001',
        name: 'Concentrating: Bless',
        icon: 'icons/svg/concentration.svg',
        statuses: ['concentrating'],
        disabled: false,
      },
      // A plain condition (statuses as a bare string).
      {
        _id: 'effPoison00000001',
        name: 'Poisoned',
        icon: 'icons/svg/poison.svg',
        statuses: 'poisoned',
        disabled: false,
      },
      // Disabled effect: must be ignored entirely.
      {
        _id: 'effDisabled000001',
        name: 'Blinded',
        icon: 'icons/svg/blind.svg',
        statuses: ['blinded'],
        disabled: true,
      },
    ],
  };

  it('extracts the concentrated spell (strips the "Concentrating: " prefix)', () => {
    expect(dnd5eAdapter.toViewModel(withEffects).concentration).toEqual({ label: 'Bless' });
  });

  it('lists only the enabled non-concentration effects as conditions', () => {
    const vm = dnd5eAdapter.toViewModel(withEffects);
    expect(vm.conditions).toEqual([
      { id: 'effPoison00000001', label: 'Poisoned', icon: 'icons/svg/poison.svg' },
    ]);
  });

  it('exposes an End Concentration action while concentrating', () => {
    const conc = dnd5eAdapter.actions?.(withEffects).find((a) => a.id === 'concentration.end');
    expect(conc).toEqual({ id: 'concentration.end', label: 'End Concentration', kind: 'endconcentration' });
  });

  it('no effects -> concentration null, no conditions, no end-concentration action', () => {
    const vm = dnd5eAdapter.toViewModel(martialCaptured);
    expect(vm.concentration).toBeNull();
    expect(vm.conditions).toBeUndefined();
    expect(dnd5eAdapter.actions?.(martialCaptured).some((a) => a.id === 'concentration.end')).toBe(false);
  });

  it('an absent effects array is treated as no effects', () => {
    const noArray: FoundryActorDoc = { ...martialCaptured, effects: undefined };
    expect(dnd5eAdapter.toViewModel(noArray).concentration).toBeNull();
    expect(dnd5eAdapter.toViewModel(noArray).conditions).toBeUndefined();
  });

  it('a concentration effect identified only by statuses still resolves (name fallback)', () => {
    const byStatus: FoundryActorDoc = {
      ...martialCaptured,
      effects: [{ _id: 'e1', name: 'Haste', statuses: ['concentrating'], disabled: false }],
    };
    expect(dnd5eAdapter.toViewModel(byStatus).concentration).toEqual({ label: 'Haste' });
  });
});

describe('item detail (system.description.value)', () => {
  it('carries the feature description onto the list item (Grappler)', () => {
    const s = section(martialCaptured, 'features');
    if (s.kind !== 'list') throw new Error('features must be a list section');
    const grappler = s.items.find((i) => i.label === 'Grappler');
    expect(grappler?.detail).toContain('close-quarters grappling');
  });

  it('leaves detail undefined when the description is empty', () => {
    const noDesc: FoundryActorDoc = {
      ...martialCaptured,
      items: (martialCaptured.items ?? []).map((i) =>
        i.name === 'Grappler' ? { ...i, system: { ...i.system, description: { value: '' } } } : i,
      ),
    };
    const s = dnd5eAdapter.toViewModel(noDesc).sections.find((x) => x.id === 'features');
    if (s?.kind !== 'list') throw new Error('features must be a list section');
    expect(s.items.find((i) => i.label === 'Grappler')?.detail).toBeUndefined();
  });

  it('carries an inline spell description onto a spell row', () => {
    const withSpellDesc: FoundryActorDoc = {
      ...casterCaptured,
      items: (casterCaptured.items ?? []).map((i) =>
        i.name === 'Bless'
          ? { ...i, system: { ...i.system, description: { value: '<p>You bless up to three creatures.</p>' } } }
          : i,
      ),
    };
    expect(spellRows(withSpellDesc).find((i) => i.label === 'Bless')?.detail).toBe(
      '<p>You bless up to three creatures.</p>',
    );
  });
});

// ---------------------------------------------------------------------------
// M10 — sheet completeness: inspiration, exhaustion, passives, senses, XP.

describe('inspiration + exhaustion (M10)', () => {
  it('inspiration: 0/1 vitals resource, false -> 0', () => {
    expect(resource(martial, 'inspiration')).toEqual({
      id: 'inspiration',
      label: 'Inspiration',
      value: 0,
      min: 0,
      max: 1,
      writable: true,
      group: 'vitals',
    });
  });

  it('inspiration true -> value 1', () => {
    const inspired: FoundryActorDoc = {
      ...martial,
      system: {
        ...martial.system,
        attributes: { ...(martial.system.attributes as Record<string, unknown>), inspiration: true },
      },
    };
    expect(resource(inspired, 'inspiration').value).toBe(1);
  });

  it('buildUpdate writes a BOOLEAN to system.attributes.inspiration', () => {
    expect(dnd5eAdapter.buildUpdate(martial, { kind: 'set', resourceId: 'inspiration', value: 1 })).toEqual({
      data: { 'system.attributes.inspiration': true },
    });
    expect(dnd5eAdapter.buildUpdate(martial, { kind: 'delta', resourceId: 'inspiration', amount: -1 })).toEqual({
      data: { 'system.attributes.inspiration': false },
    });
  });

  it('exhaustion: 0..6 vitals resource', () => {
    expect(resource(martial, 'exhaustion')).toEqual({
      id: 'exhaustion',
      label: 'Exhaustion',
      value: 0,
      min: 0,
      max: 6,
      writable: true,
      group: 'vitals',
    });
    expect(resource(martialCaptured, 'exhaustion')).toMatchObject({ value: 0, min: 0, max: 6 });
  });

  it('buildUpdate writes system.attributes.exhaustion, clamped to 0..6', () => {
    expect(dnd5eAdapter.buildUpdate(martial, { kind: 'set', resourceId: 'exhaustion', value: 3 })).toEqual({
      data: { 'system.attributes.exhaustion': 3 },
    });
    expect(
      dnd5eAdapter.buildUpdate(martial, { kind: 'delta', resourceId: 'exhaustion', amount: 99 }).data[
        'system.attributes.exhaustion'
      ],
    ).toBe(6);
  });
});

describe('passive senses (M10)', () => {
  it('passives section sits right after skills', () => {
    const vm = dnd5eAdapter.toViewModel(martial);
    const idx = vm.sections.findIndex((s) => s.id === 'skills');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(vm.sections[idx + 1]?.id).toBe('passives');
  });

  it('falls back to 10 + skill total when no derived passive is serialized', () => {
    const s = section(martial, 'passives');
    if (s.kind !== 'stats') throw new Error('passives must be a stats section');
    expect(s.label).toBe('Passive Senses');
    // prc proficient (wis +1, prof +3) -> 14; inv int +0 -> 10; ins wis +1 -> 11.
    expect(s.stats).toEqual([
      { id: 'passive.prc', label: 'Passive Perception', value: 14 },
      { id: 'passive.inv', label: 'Passive Investigation', value: 10 },
      { id: 'passive.ins', label: 'Passive Insight', value: 11 },
    ]);
  });

  it('uses the derived total in the fallback (caster: ins total +7 -> 17)', () => {
    const s = section(caster, 'passives');
    if (s.kind !== 'stats') throw new Error('passives must be a stats section');
    expect(s.stats.find((x) => x.id === 'passive.ins')?.value).toBe(17);
    expect(s.stats.find((x) => x.id === 'passive.prc')?.value).toBe(14);
  });

  it('prefers the derived skills.<id>.passive number when serialized', () => {
    const withPassive: FoundryActorDoc = {
      ...caster,
      system: {
        ...caster.system,
        skills: {
          ...(caster.system.skills as Record<string, unknown>),
          prc: { ...((caster.system.skills as Record<string, Record<string, unknown>>).prc), passive: 19 },
        },
      },
    };
    const s = dnd5eAdapter.toViewModel(withPassive).sections.find((x) => x.id === 'passives');
    if (s?.kind !== 'stats') throw new Error('passives must be a stats section');
    expect(s.stats.find((x) => x.id === 'passive.prc')?.value).toBe(19);
  });

  it('captured fixtures render passives via the fallback (pinned values)', () => {
    const m = section(martialCaptured, 'passives');
    if (m.kind !== 'stats') throw new Error('passives must be a stats section');
    // martial: prof 3; prc wis +1 unprof -> 11; inv int -1 -> 9; ins wis +1 prof -> 14.
    expect(m.stats).toEqual([
      { id: 'passive.prc', label: 'Passive Perception', value: 11 },
      { id: 'passive.inv', label: 'Passive Investigation', value: 9 },
      { id: 'passive.ins', label: 'Passive Insight', value: 14 },
    ]);
    const c = section(casterCaptured, 'passives');
    if (c.kind !== 'stats') throw new Error('passives must be a stats section');
    // caster: prof 3; prc wis +2 prof -> 15; inv int -1 -> 9; ins wis +2 prof -> 15.
    expect(c.stats).toEqual([
      { id: 'passive.prc', label: 'Passive Perception', value: 15 },
      { id: 'passive.inv', label: 'Passive Investigation', value: 9 },
      { id: 'passive.ins', label: 'Passive Insight', value: 15 },
    ]);
  });

  it('fallback adds skills.<id>.bonuses.passive (Observant: "5" as a source string)', () => {
    const observant = withSkillOverride(martialCaptured, 'prc', { bonuses: { check: '', passive: '5' } });
    const s = section(observant, 'passives');
    if (s.kind !== 'stats') throw new Error('passives must be a stats section');
    // Base 11 (see pinned captured values) + 5 passive bonus.
    expect(s.stats.find((x) => x.id === 'passive.prc')?.value).toBe(16);
  });

  it('fallback adds +5/-5 for roll.mode advantage/disadvantage', () => {
    const adv = withSkillOverride(martialCaptured, 'prc', { roll: { min: null, max: null, mode: 1 } });
    const sAdv = section(adv, 'passives');
    if (sAdv.kind !== 'stats') throw new Error('passives must be a stats section');
    expect(sAdv.stats.find((x) => x.id === 'passive.prc')?.value).toBe(16);

    const dis = withSkillOverride(martialCaptured, 'prc', { roll: { min: null, max: null, mode: -1 } });
    const sDis = section(dis, 'passives');
    if (sDis.kind !== 'stats') throw new Error('passives must be a stats section');
    expect(sDis.stats.find((x) => x.id === 'passive.prc')?.value).toBe(6);
  });

  it('fallback ignores a non-numeric bonuses.passive formula', () => {
    const weird = withSkillOverride(martialCaptured, 'prc', { bonuses: { check: '', passive: '1d4' } });
    const s = section(weird, 'passives');
    if (s.kind !== 'stats') throw new Error('passives must be a stats section');
    expect(s.stats.find((x) => x.id === 'passive.prc')?.value).toBe(11);
  });
});

/** Clone a captured-shape actor with fields merged into one skill's data. */
function withSkillOverride(actor: FoundryActorDoc, skillId: string, patch: Record<string, unknown>): FoundryActorDoc {
  const skills = actor.system.skills as Record<string, Record<string, unknown>>;
  return {
    ...actor,
    system: {
      ...actor.system,
      skills: { ...skills, [skillId]: { ...skills[skillId], ...patch } },
    },
  };
}

describe('senses (M10)', () => {
  it('is omitted when no sense is set (captured fixtures have all-null ranges)', () => {
    expect(dnd5eAdapter.toViewModel(martialCaptured).sections.some((s) => s.id === 'senses')).toBe(false);
    expect(dnd5eAdapter.toViewModel(casterCaptured).sections.some((s) => s.id === 'senses')).toBe(false);
    expect(dnd5eAdapter.toViewModel(martial).sections.some((s) => s.id === 'senses')).toBe(false);
  });

  it('lists set senses with capitalized label and units ("Darkvision 60 ft")', () => {
    const seer: FoundryActorDoc = {
      ...martial,
      system: {
        ...martial.system,
        attributes: {
          ...(martial.system.attributes as Record<string, unknown>),
          senses: {
            units: 'ft',
            ranges: { darkvision: 60, blindsight: null, tremorsense: 0, truesight: null },
          },
        },
      },
    };
    const s = dnd5eAdapter.toViewModel(seer).sections.find((x) => x.id === 'senses');
    if (s?.kind !== 'stats') throw new Error('senses must be a stats section');
    expect(s.label).toBe('Senses');
    expect(s.stats).toEqual([{ id: 'sense.darkvision', label: 'Darkvision', value: '60 ft' }]);
  });

  it('defaults units to ft when unset', () => {
    const seer: FoundryActorDoc = {
      ...martial,
      system: {
        ...martial.system,
        attributes: {
          ...(martial.system.attributes as Record<string, unknown>),
          senses: { ranges: { truesight: 30 } },
        },
      },
    };
    const s = dnd5eAdapter.toViewModel(seer).sections.find((x) => x.id === 'senses');
    if (s?.kind !== 'stats') throw new Error('senses must be a stats section');
    expect(s.stats).toEqual([{ id: 'sense.truesight', label: 'Truesight', value: '30 ft' }]);
  });

  it('falls back to race-item senses when actor ranges are null (relay source data)', () => {
    // Captured shape: actor senses.ranges are all null; the race item carries
    // the value — as a numeric string, like race movement.walk "30".
    const dwarf = withRaceSenses(martialCaptured, {
      units: 'ft',
      ranges: { darkvision: '60', blindsight: 0, tremorsense: null, truesight: null },
    });
    const s = dnd5eAdapter.toViewModel(dwarf).sections.find((x) => x.id === 'senses');
    if (s?.kind !== 'stats') throw new Error('senses must be a stats section');
    expect(s.stats).toEqual([{ id: 'sense.darkvision', label: 'Darkvision', value: '60 ft' }]);
  });

  it("actor's own numeric range overrides the race item", () => {
    const dwarf = withRaceSenses(martialCaptured, { ranges: { darkvision: '60' } });
    const boosted: FoundryActorDoc = {
      ...dwarf,
      system: {
        ...dwarf.system,
        attributes: {
          ...(dwarf.system.attributes as Record<string, unknown>),
          senses: { units: 'ft', ranges: { darkvision: 120, blindsight: null } },
        },
      },
    };
    const s = dnd5eAdapter.toViewModel(boosted).sections.find((x) => x.id === 'senses');
    if (s?.kind !== 'stats') throw new Error('senses must be a stats section');
    expect(s.stats).toEqual([{ id: 'sense.darkvision', label: 'Darkvision', value: '120 ft' }]);
  });
});

/** Clone a captured-shape actor with its race item's system.senses replaced. */
function withRaceSenses(actor: FoundryActorDoc, senses: Record<string, unknown>): FoundryActorDoc {
  return {
    ...actor,
    items: (actor.items ?? []).map((i) =>
      i.type === 'race' ? { ...i, system: { ...(i.system as Record<string, unknown>), senses } } : i,
    ),
  };
}

// ---------------------------------------------------------------------------
// M11 — identity & lore: proficiencies & traits stats, biography list.

/** Clone an actor with fields merged into system.traits. */
function withTraits(actor: FoundryActorDoc, patch: Record<string, unknown>): FoundryActorDoc {
  return {
    ...actor,
    system: {
      ...actor.system,
      traits: { ...(actor.system.traits as Record<string, unknown>), ...patch },
    },
  };
}

/** Clone an actor with fields merged into system.details. */
function withDetails(actor: FoundryActorDoc, patch: Record<string, unknown>): FoundryActorDoc {
  return {
    ...actor,
    system: {
      ...actor.system,
      details: { ...(actor.system.details as Record<string, unknown>), ...patch },
    },
  };
}

describe('proficiencies & traits (M11)', () => {
  it('sits right after passives with the pinned label', () => {
    const vm = dnd5eAdapter.toViewModel(martialCaptured);
    const idx = vm.sections.findIndex((s) => s.id === 'passives');
    expect(idx).toBeGreaterThanOrEqual(0);
    const s = vm.sections[idx + 1];
    expect(s?.id).toBe('traits');
    if (s?.kind !== 'stats') throw new Error('traits must be a stats section');
    expect(s.label).toBe('Proficiencies & Traits');
  });

  it('captured martial: languages/armor/weapons via the vocab, joined with ", "', () => {
    const s = section(martialCaptured, 'traits');
    if (s.kind !== 'stats') throw new Error('traits must be a stats section');
    expect(s.stats).toEqual([
      { id: 'trait.languages', label: 'Languages', value: 'Common, Dwarvish, Elvish, Goblin' },
      { id: 'trait.armor', label: 'Armor', value: 'Light Armor, Medium Armor, Heavy Armor, Shields' },
      { id: 'trait.weapons', label: 'Weapons', value: 'Simple Weapons, Martial Weapons' },
    ]);
  });

  it('captured caster: dr ["cold"] renders a capitalized Resistances stat', () => {
    const s = section(casterCaptured, 'traits');
    if (s.kind !== 'stats') throw new Error('traits must be a stats section');
    expect(s.stats).toEqual([
      { id: 'trait.languages', label: 'Languages', value: 'Giant, Halfling, Common, Draconic' },
      { id: 'trait.armor', label: 'Armor', value: 'Light Armor, Medium Armor, Shields, Heavy Armor' },
      { id: 'trait.weapons', label: 'Weapons', value: 'Simple Weapons' },
      { id: 'trait.dr', label: 'Resistances', value: 'Cold' },
    ]);
  });

  it('unknown language ids fall back to capitalization; known ids use the vocab', () => {
    const polyglot = withTraits(martialCaptured, {
      languages: { value: ['common', 'deep', 'cant', 'druidic', 'gith'], custom: '' },
    });
    const s = section(polyglot, 'traits');
    if (s.kind !== 'stats') throw new Error('traits must be a stats section');
    expect(s.stats.find((x) => x.id === 'trait.languages')?.value).toBe(
      "Common, Deep Speech, Thieves' Cant, Druidic, Gith",
    );
  });

  it('tool proficiencies come from system.tools (5.x record) — traits.toolProf does not exist', () => {
    // Real 5.3.3 wire shape: top-level system.tools keyed by tool id with a
    // proficiency multiplier; both captured fixtures carry it (empty here).
    const tinker: FoundryActorDoc = {
      ...martialCaptured,
      system: {
        ...martialCaptured.system,
        tools: {
          thief: { value: 1, ability: 'dex' },
          herb: { value: 1, ability: 'int' },
          flute: { value: 1, ability: 'cha' },
        },
      },
    };
    const s = section(tinker, 'traits');
    if (s.kind !== 'stats') throw new Error('traits must be a stats section');
    expect(s.stats.find((x) => x.id === 'trait.tools')).toEqual({
      id: 'trait.tools',
      label: 'Tools',
      // vocab for truncated/possessive ids, capitalize fallback, sorted
      value: "Flute, Herbalism Kit, Thieves' Tools",
    });
  });

  it('zero-multiplier tool entries do not count as proficiency', () => {
    const dabbler: FoundryActorDoc = {
      ...martialCaptured,
      system: { ...martialCaptured.system, tools: { thief: { value: 0, ability: 'dex' } } },
    };
    const s = section(dabbler, 'traits');
    if (s.kind !== 'stats') throw new Error('traits must be a stats section');
    expect(s.stats.find((x) => x.id === 'trait.tools')).toBeUndefined();
  });

  it('custom free-text entries render for languages/armor/weapons too', () => {
    const homebrew = withTraits(martialCaptured, {
      languages: { value: ['common'], custom: 'Aarakocra' },
    });
    const s = section(homebrew, 'traits');
    if (s.kind !== 'stats') throw new Error('traits must be a stats section');
    expect(s.stats.find((x) => x.id === 'trait.languages')?.value).toBe('Common, Aarakocra');
  });

  it('damage-defense bypasses render as an "(except …)" qualifier', () => {
    const stony = withTraits(martialCaptured, {
      dr: { value: ['blud', 'pier', 'slas'], bypasses: ['mgc'], custom: '' },
    });
    const s = section(stony, 'traits');
    if (s.kind !== 'stats') throw new Error('traits must be a stats section');
    expect(s.stats.find((x) => x.id === 'trait.dr')?.value).toBe('Blud, Pier, Slas (except magical)');
  });

  it('editor-empty biography HTML ("<p></p>") produces no Biography row', () => {
    const blank = withDetails(martialCaptured, { biography: { value: '<p>&nbsp;</p><p></p>', public: '' } });
    const s = dnd5eAdapter.toViewModel(blank).sections.find((x) => x.id === 'biography');
    expect(s === undefined || (s.kind === 'list' && !s.items.some((i) => i.id === 'bio'))).toBe(true);
  });

  it('di/dv/ci render when set; .custom strings are appended', () => {
    const tough = withTraits(martialCaptured, {
      dr: { value: ['fire'], bypasses: [], custom: 'Nonmagical slashing' },
      di: { value: ['poison'], bypasses: [], custom: '' },
      dv: { value: ['thunder'], bypasses: [], custom: '' },
      ci: { value: ['charmed', 'frightened'], custom: '' },
    });
    const s = section(tough, 'traits');
    if (s.kind !== 'stats') throw new Error('traits must be a stats section');
    expect(s.stats.find((x) => x.id === 'trait.dr')?.value).toBe('Fire, Nonmagical slashing');
    expect(s.stats.find((x) => x.id === 'trait.di')).toEqual({
      id: 'trait.di',
      label: 'Immunities',
      value: 'Poison',
    });
    expect(s.stats.find((x) => x.id === 'trait.dv')).toEqual({
      id: 'trait.dv',
      label: 'Vulnerabilities',
      value: 'Thunder',
    });
    expect(s.stats.find((x) => x.id === 'trait.ci')).toEqual({
      id: 'trait.ci',
      label: 'Condition Immunities',
      value: 'Charmed, Frightened',
    });
  });

  it('empty categories are omitted (captured fixtures have empty dr/di/dv/ci)', () => {
    const s = section(martialCaptured, 'traits');
    if (s.kind !== 'stats') throw new Error('traits must be a stats section');
    const ids = s.stats.map((x) => x.id);
    expect(ids).not.toContain('trait.dr');
    expect(ids).not.toContain('trait.di');
    expect(ids).not.toContain('trait.dv');
    expect(ids).not.toContain('trait.ci');
    expect(ids).not.toContain('trait.tools');
  });

  it('the whole section is omitted when every category is empty (synthetic fixtures)', () => {
    expect(dnd5eAdapter.toViewModel(martial).sections.some((s) => s.id === 'traits')).toBe(false);
    expect(dnd5eAdapter.toViewModel(caster).sections.some((s) => s.id === 'traits')).toBe(false);
  });
});

describe('biography & personality (M11)', () => {
  it('is a list section labelled "Character", last before currency', () => {
    const vm = dnd5eAdapter.toViewModel(martialCaptured);
    const idx = vm.sections.findIndex((s) => s.id === 'biography');
    expect(idx).toBeGreaterThanOrEqual(0);
    const s = vm.sections[idx];
    if (s?.kind !== 'list') throw new Error('biography must be a list section');
    expect(s.label).toBe('Character');
    expect(vm.sections[idx + 1]?.id).toBe('currency');
    expect(idx + 2).toBe(vm.sections.length);
  });

  it('biography row carries the HTML as detail with a "Tap to read" sub', () => {
    const s = section(martialCaptured, 'biography');
    if (s.kind !== 'list') throw new Error('biography must be a list section');
    const bio = s.items.find((i) => i.id === 'bio');
    expect(bio?.label).toBe('Biography');
    expect(bio?.sub).toBe('Tap to read');
    expect(bio?.detail).toHaveLength(293);
    expect(bio?.detail).toContain('Randal worked his way through the ranks');
    expect(bio?.actionId).toBeUndefined();
  });

  it('personality one-liners render as sub-only rows (no detail, no actions)', () => {
    const storied = withDetails(martialCaptured, {
      trait: 'Blunt to a fault.',
      ideal: 'The strong protect the weak.',
      bond: 'My old guard company.',
      flaw: 'Cannot refuse a wager.',
      appearance: 'Scarred hands, grey eyes.',
    });
    const s = section(storied, 'biography');
    if (s.kind !== 'list') throw new Error('biography must be a list section');
    expect(s.items).toEqual([
      s.items[0], // the bio row, asserted above
      { id: 'trait', label: 'Personality', sub: 'Blunt to a fault.' },
      { id: 'ideal', label: 'Ideal', sub: 'The strong protect the weak.' },
      { id: 'bond', label: 'Bond', sub: 'My old guard company.' },
      { id: 'flaw', label: 'Flaw', sub: 'Cannot refuse a wager.' },
      { id: 'appearance', label: 'Appearance', sub: 'Scarred hands, grey eyes.' },
    ]);
  });

  it('empty one-liners are omitted (captured fixtures have "" for all five)', () => {
    const s = section(martialCaptured, 'biography');
    if (s.kind !== 'list') throw new Error('biography must be a list section');
    expect(s.items.map((i) => i.id)).toEqual(['bio']);
  });

  it('the whole section is omitted when nothing is set (synthetic fixtures)', () => {
    expect(dnd5eAdapter.toViewModel(martial).sections.some((s) => s.id === 'biography')).toBe(false);
    expect(dnd5eAdapter.toViewModel(caster).sections.some((s) => s.id === 'biography')).toBe(false);
  });

  it('an empty biography HTML string yields no bio row', () => {
    const blank = withDetails(martialCaptured, { biography: { value: '', public: '' } });
    expect(dnd5eAdapter.toViewModel(blank).sections.some((s) => s.id === 'biography')).toBe(false);
  });
});

describe('inventory location sections', () => {
  const withRealContainment = () => {
    const actor = structuredClone(martialCaptured);
    const items = actor.items as Array<{ _id: string; system: Record<string, unknown> }>;
    // Repair the captured dangling refs into a real containment chain:
    // Rations -> Backpack, Pouch -> Backpack (nested container).
    items.find((i) => i._id === 'ulOW5qzq7q2edJTP')!.system.container = 'wYUZWMKa6FntpIvv';
    items.find((i) => i._id === 'T8BW5LfQIDdur78q')!.system.container = 'wYUZWMKa6FntpIvv';
    return actor;
  };

  const inventorySections = (actor: FoundryActorDoc) =>
    dnd5eAdapter.toViewModel(actor).sections.filter(
      (s): s is Extract<SheetSection, { kind: 'list' }> => s.kind === 'list' && /^inventory/.test(s.id),
    );

  it('emits Carried first, then one section per container in sheet order', () => {
    const secs = inventorySections(withRealContainment());
    expect(secs[0]).toMatchObject({ id: 'inventory', label: 'Carried' });
    const containerSecs = secs.slice(1);
    expect(containerSecs.map((s) => s.id)).toEqual(
      expect.arrayContaining(['inventory.wYUZWMKa6FntpIvv', 'inventory.T8BW5LfQIDdur78q', 'inventory.B2OSARI9hcSzaai9']),
    );
    expect(containerSecs.every((s) => s.header !== undefined)).toBe(true);
  });

  it('direct contents land in their container section; containers are not Carried rows', () => {
    const secs = inventorySections(withRealContainment());
    const backpack = secs.find((s) => s.id === 'inventory.wYUZWMKa6FntpIvv')!;
    expect(backpack.items.map((i) => i.id)).toEqual(
      expect.arrayContaining(['ulOW5qzq7q2edJTP', 'T8BW5LfQIDdur78q']), // Rations + nested Pouch as a row
    );
    const carried = secs.find((s) => s.id === 'inventory')!;
    expect(carried.items.map((i) => i.id)).not.toContain('wYUZWMKa6FntpIvv');
    expect(carried.items.map((i) => i.id)).not.toContain('ulOW5qzq7q2edJTP');
  });

  it('a nested container still gets its own top-level section', () => {
    const secs = inventorySections(withRealContainment());
    expect(secs.some((s) => s.id === 'inventory.T8BW5LfQIDdur78q')).toBe(true);
  });

  it('dangling refs count as Carried (captured fixture, unrepaired)', () => {
    const secs = inventorySections(martialCaptured);
    const carried = secs.find((s) => s.id === 'inventory')!;
    expect(carried.items.map((i) => i.id)).toContain('ulOW5qzq7q2edJTP'); // its captured ref dangles
  });

  it('an empty container renders as a section with zero items', () => {
    const secs = inventorySections(withRealContainment());
    const quiver = secs.find((s) => s.id === 'inventory.B2OSARI9hcSzaai9')!;
    expect(quiver.items).toEqual([]);
  });

  it("the header's sub carries the contents weight total", () => {
    const actor = withRealContainment();
    // give Rations a known weight for a deterministic sum
    const rations = (actor.items as Array<{ _id: string; system: Record<string, unknown> }>).find(
      (i) => i._id === 'ulOW5qzq7q2edJTP',
    )!;
    rations.system.quantity = 2;
    rations.system.weight = { value: 1, units: 'lb' };
    const backpack = inventorySections(actor).find((s) => s.id === 'inventory.wYUZWMKa6FntpIvv')!;
    expect(backpack.header!.sub).toMatch(/Σ [\d.]+ lb/);
  });
});

describe('XP hidden from headline (2026-07-19)', () => {
  it('emits no xp headline stat — most tables level by milestone', () => {
    for (const actor of [martial, martialCaptured]) {
      const ids = dnd5eAdapter.toViewModel(actor).headline.map((s) => s.id);
      expect(ids).not.toContain('xp');
    }
  });
});

describe('Saving Throws section (2026-07-19)', () => {
  it('emits a saves stats section directly after abilities', () => {
    const vm = dnd5eAdapter.toViewModel(martial);
    const ids = vm.sections.map((s) => s.id);
    expect(ids.indexOf('saves')).toBe(ids.indexOf('abilities') + 1);
    const saves = vm.sections.find((s) => s.id === 'saves');
    expect(saves?.kind).toBe('stats');
    if (saves?.kind !== 'stats') throw new Error('unreachable');
    expect(saves.label).toBe('Saving Throws');
    expect(saves.stats).toHaveLength(6);
  });

  it('save cards show the exact bonus the save roll uses, with proficiency marker', () => {
    const vm = dnd5eAdapter.toViewModel(martial);
    const saves = vm.sections.find((s) => s.id === 'saves');
    if (saves?.kind !== 'stats') throw new Error('saves must be a stats section');
    const str = saves.stats.find((s) => s.id === 'save.str')!;
    // martial fixture: STR 16 (mod +3), proficient 1, prof +3 -> +6.
    // IMPORTANT: verify the +3 prof against the fixture before trusting this
    // constant (existing headline tests assert Proficiency '+3' for martial).
    expect(str.value).toBe('+6');
    expect(str.sub).toBe('● proficient');
    expect(str.actionId).toBe('ability.str.save');
    const dex = saves.stats.find((s) => s.id === 'save.dex')!;
    // DEX 14 (mod +2), not proficient -> +2, no marker.
    expect(dex.value).toBe('+2');
    expect(dex.sub).toBeUndefined();
  });

  it('prefers derived abilities.<id>.save.value when the relay provides it', () => {
    const system = martial.system as Record<string, unknown>;
    const abilities = (system.abilities ?? {}) as Record<string, Record<string, unknown>>;
    const withDerived: FoundryActorDoc = {
      ...martial,
      system: {
        ...system,
        abilities: { ...abilities, str: { ...abilities.str, save: { value: 9 } } },
      },
    };
    const saves = dnd5eAdapter.toViewModel(withDerived).sections.find((s) => s.id === 'saves');
    if (saves?.kind !== 'stats') throw new Error('saves must be a stats section');
    expect(saves.stats.find((s) => s.id === 'save.str')?.value).toBe('+9');
  });
});

describe('Saving Throw Notes section (2026-07-19)', () => {
  /** An actor whose items carry the live-verified description shapes. */
  function actorWithFeats(feats: Array<{ name: string; type?: string; desc: string }>): FoundryActorDoc {
    return {
      ...martial,
      items: feats.map((f, i) => ({
        _id: `note-feat-${i}`.padEnd(16, '0'),
        name: f.name,
        type: f.type ?? 'feat',
        system: { description: { value: f.desc } },
      })),
    };
  }

  it('extracts "you have advantage" save sentences, attributed to the item', () => {
    const actor = actorWithFeats([
      {
        name: 'Gnomish Magic Resistance',
        desc: '<p>You have advantage on Intelligence, Wisdom, and Charisma saving throws against spells.</p>',
      },
    ]);
    const section = dnd5eAdapter.toViewModel(actor).sections.find((s) => s.id === 'savenotes');
    if (section?.kind !== 'stats') throw new Error('savenotes must be a stats section');
    expect(section.label).toBe('Saving Throw Notes');
    expect(section.stats).toEqual([
      {
        id: 'savenote.0',
        label: 'Gnomish Magic Resistance',
        value: 'You have advantage on Intelligence, Wisdom, and Charisma saving throws against spells.',
      },
    ]);
  });

  it('sits directly after the saves section', () => {
    const actor = actorWithFeats([
      { name: 'Danger Sense', desc: '<p>You have advantage on Dexterity saving throws against effects that you can see.</p>' },
    ]);
    const ids = dnd5eAdapter.toViewModel(actor).sections.map((s) => s.id);
    expect(ids.indexOf('savenotes')).toBe(ids.indexOf('saves') + 1);
  });

  it('is omitted when no item text qualifies', () => {
    const ids = dnd5eAdapter.toViewModel(martial).sections.map((s) => s.id);
    expect(ids).not.toContain('savenotes');
  });

  it('drops sentences about other creatures (no "you" before the keyword)', () => {
    const actor = actorWithFeats([
      { name: 'Holy Symbol of Ravenkind', type: 'equipment', desc: '<p>When you do so, undead have disadvantage on their saving throws against the effect.</p>' },
    ]);
    const ids = dnd5eAdapter.toViewModel(actor).sections.map((s) => s.id);
    expect(ids).not.toContain('savenotes');
  });

  it('trims list preambles at the last colon (Rage/War Caster shape)', () => {
    const actor = actorWithFeats([
      {
        name: 'Rage',
        desc: '<p>While raging, you gain the following benefits if you aren’t wearing heavy armor: You have advantage on Strength checks and Strength saving throws.</p>',
      },
    ]);
    const section = dnd5eAdapter.toViewModel(actor).sections.find((s) => s.id === 'savenotes');
    if (section?.kind !== 'stats') throw new Error('savenotes must be a stats section');
    expect(section.stats[0]?.value).toBe('You have advantage on Strength checks and Strength saving throws.');
  });

  it('dedupes identical sentences from race + trait feat, keeping the first source', () => {
    const actor = actorWithFeats([
      { name: 'Mountain Dwarf', type: 'race', desc: '<p>Dwarven Resilience: You have advantage on saving throws against poison.</p>' },
      { name: 'Dwarven Resilience', desc: '<p>You have advantage on saving throws against poison.</p>' },
    ]);
    const section = dnd5eAdapter.toViewModel(actor).sections.find((s) => s.id === 'savenotes');
    if (section?.kind !== 'stats') throw new Error('savenotes must be a stats section');
    expect(section.stats).toHaveLength(1);
  });

  it('dedupes race-name-prefixed duplicates, keeping the clean feat sentence', () => {
    // Live-data gap (2026-07-19): race items embed the trait name INSIDE the
    // sentence with no colon separator ("Dwarven Resilience You have
    // advantage…"), so the naive lowercased-full-sentence key never matches
    // the clean standalone trait feat's sentence. 4/9 live PCs showed every
    // racial note twice until the dedupe key was anchored at the "you have
    // advantage…" gate match instead of the full sentence.
    const actor = actorWithFeats([
      { name: 'Mountain Dwarf', type: 'race', desc: '<p>Dwarven Resilience You have advantage on saving throws against poison.</p>' },
      { name: 'Dwarven Resilience', desc: '<p>You have advantage on saving throws against poison.</p>' },
    ]);
    const section = dnd5eAdapter.toViewModel(actor).sections.find((s) => s.id === 'savenotes');
    if (section?.kind !== 'stats') throw new Error('savenotes must be a stats section');
    expect(section.stats).toHaveLength(1);
    expect(section.stats[0]?.value).toBe('You have advantage on saving throws against poison.');
    expect(section.stats[0]?.label).toBe('Dwarven Resilience');
  });

  it('resolves enricher tokens and caps runaway sentences at 200 chars', () => {
    const longTail = 'that you can see, such as traps and spells, and also '.repeat(6);
    const actor = actorWithFeats([
      { name: 'Fey Ancestry', desc: '<p>You have advantage on saving throws against being &Reference[charmed]{Charmed}.</p>' },
      { name: 'Windbag', desc: `<p>You have advantage on Dexterity saving throws against effects ${longTail}elsewhere.</p>` },
    ]);
    const section = dnd5eAdapter.toViewModel(actor).sections.find((s) => s.id === 'savenotes');
    if (section?.kind !== 'stats') throw new Error('savenotes must be a stats section');
    expect(section.stats[0]?.value).toBe('You have advantage on saving throws against being Charmed.');
    const long = String(section.stats[1]?.value);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith('…')).toBe(true);
  });

  it('keeps player-disadvantage notes, not just advantage', () => {
    const actor = actorWithFeats([
      {
        name: 'Frightened Fool',
        desc: '<p>You have disadvantage on Strength saving throws while you can see the source of your fear.</p>',
      },
    ]);
    const section = dnd5eAdapter.toViewModel(actor).sections.find((s) => s.id === 'savenotes');
    if (section?.kind !== 'stats') throw new Error('savenotes must be a stats section');
    expect(section.stats).toEqual([
      {
        id: 'savenote.0',
        label: 'Frightened Fool',
        value: 'You have disadvantage on Strength saving throws while you can see the source of your fear.',
      },
    ]);
  });

  it('decodes ddb-importer entities (e.g. &rsquo;) in the extracted sentence', () => {
    const actor = actorWithFeats([
      {
        name: 'Stone&rsquo;s Endurance',
        desc: '<p>You have advantage on Constitution saving throws when you use this trait, and you can&rsquo;t be knocked prone.</p>',
      },
    ]);
    const section = dnd5eAdapter.toViewModel(actor).sections.find((s) => s.id === 'savenotes');
    if (section?.kind !== 'stats') throw new Error('savenotes must be a stats section');
    expect(section.stats).toHaveLength(1);
    expect(section.stats[0]?.value).toBe(
      'You have advantage on Constitution saving throws when you use this trait, and you can’t be knocked prone.',
    );
  });

  it('keeps stats ids contiguous when a duplicate is dropped mid-list', () => {
    const actor = actorWithFeats([
      { name: 'Danger Sense', desc: '<p>You have advantage on Dexterity saving throws against effects that you can see.</p>' },
      { name: 'Gnomish Magic Resistance', desc: '<p>You have advantage on Intelligence, Wisdom, and Charisma saving throws against spells.</p>' },
      { name: 'Danger Sense (dup)', desc: '<p>You have advantage on Dexterity saving throws against effects that you can see.</p>' },
    ]);
    const section = dnd5eAdapter.toViewModel(actor).sections.find((s) => s.id === 'savenotes');
    if (section?.kind !== 'stats') throw new Error('savenotes must be a stats section');
    expect(section.stats.map((s) => s.id)).toEqual(['savenote.0', 'savenote.1']);
  });
});
