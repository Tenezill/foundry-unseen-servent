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
    expect(str?.sub).toBe('+3');
    const cha = s.stats.find((x) => x.id === 'ability.cha');
    expect(cha?.value).toBe(8);
    expect(cha?.sub).toBe('-1');
  });

  it('skills: all 18, computed total, proficient tag in sub', () => {
    const s = section(martial, 'skills');
    if (s.kind !== 'stats') throw new Error('skills must be a stats section');
    expect(s.stats).toHaveLength(18);
    const ath = s.stats.find((x) => x.id === 'skill.ath');
    expect(ath?.value).toBe('+6'); // str +3 + prof +3
    expect(ath?.sub).toBe('STR · proficient');
    const acr = s.stats.find((x) => x.id === 'skill.acr');
    expect(acr?.value).toBe('+2'); // dex +2, not proficient
    expect(acr?.sub).toBe('DEX');
  });

  it('vitals tracks hp, temp hp, death saves, and hit dice', () => {
    const s = section(martial, 'vitals');
    if (s.kind !== 'tracks') throw new Error('vitals must be a tracks section');
    expect(s.resourceIds).toEqual([
      'hp',
      'hp.temp',
      'deathsaves.success',
      'deathsaves.failure',
      'hitdice.d10',
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
    expect(arrows?.sub).toBe('×20 · consumable');
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
    expect(ins?.sub).toBe('WIS · proficient');
  });

  it('slots section lists present slot levels only (no empty levels, no pact)', () => {
    const s = section(caster, 'slots');
    if (s.kind !== 'tracks') throw new Error('slots must be a tracks section');
    expect(s.resourceIds).toEqual(['slots.1', 'slots.2', 'slots.3']);
  });

  it('spells list: level, school, prepared state in sub; tags for prepared/concentration/ritual', () => {
    const s = section(caster, 'spells');
    if (s.kind !== 'list') throw new Error('spells must be a list section');
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
    expect(torch?.sub).toBe('×10 · consumable');
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
    const s = section(casterCaptured, 'spells');
    if (s.kind !== 'list') throw new Error('spells must be a list section');
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
