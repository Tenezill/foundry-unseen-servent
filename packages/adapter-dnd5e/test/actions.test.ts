/**
 * M6 action surface tests, driven by the captured live-world fixtures
 * (Randal, Fighter 5 / Akra, Cleric 5 — dnd5e 5.3.3 on Foundry 13.351).
 */
import { describe, expect, it } from 'vitest';
import type { ActionDescriptor, ActionIntent, FoundryActorDoc, FoundryItemDoc, SheetSection } from '@companion/adapter-sdk';
import { IntentError } from '@companion/adapter-sdk';
import { dnd5eAdapter } from '../src/index.js';
import casterJson from './fixtures/caster.json' with { type: 'json' };
import martialCapturedJson from './fixtures/martial-captured.json' with { type: 'json' };
import casterCapturedJson from './fixtures/caster-captured.json' with { type: 'json' };

const caster = casterJson as unknown as FoundryActorDoc;
const martialCaptured = martialCapturedJson as unknown as FoundryActorDoc;
const casterCaptured = casterCapturedJson as unknown as FoundryActorDoc;

// The workspace has no @types/node and this package's tsconfig lib is
// ES2022, which doesn't declare the (Node 17+/browser) global structuredClone
// used below to build a mutated copy of a fixture without touching the
// original object other tests share.
declare const structuredClone: <T>(value: T) => T;

function actions(actor: FoundryActorDoc): ActionDescriptor[] {
  if (!dnd5eAdapter.actions) throw new Error('adapter must expose actions()');
  return dnd5eAdapter.actions(actor);
}

function action(actor: FoundryActorDoc, id: string): ActionDescriptor {
  const a = actions(actor).find((x) => x.id === id);
  if (!a) throw new Error(`action ${id} not found`);
  return a;
}

function build(actor: FoundryActorDoc, intent: ActionIntent) {
  if (!dnd5eAdapter.buildAction) throw new Error('adapter must expose buildAction()');
  return dnd5eAdapter.buildAction(actor, intent);
}

function formulaOf(actor: FoundryActorDoc, intent: ActionIntent): string {
  const action = build(actor, intent);
  if (action.endpoint !== 'roll') throw new Error(`expected a roll action, got ${action.endpoint}`);
  return action.formula;
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

/** Minimal warlock: one class item, one prepared 1st-level spell, one
 *  prepared 4th-level spell, pact data as given, plus any extra items
 *  (e.g. a pact-method damage spell for scaling tests). Mirrors what the
 *  relay serializes for an imported warlock. `extraItems` defaults to none
 *  so every existing caller is unaffected. */
function warlock(pact: Record<string, unknown>, extraItems: FoundryActorDoc['items'] = []): FoundryActorDoc {
  return {
    _id: 'actorWarlock0001',
    name: 'Pact Test',
    type: 'character',
    system: {
      abilities: { cha: { value: 16 } },
      attributes: { hp: { value: 20, max: 20 } },
      spells: { pact },
    },
    items: [
      {
        _id: 'clsWarlock000001',
        name: 'Warlock',
        type: 'class',
        system: { levels: 7, hd: { denomination: 'd8', spent: 0 } },
      },
      {
        _id: 'spellHex00000001',
        name: 'Hex',
        type: 'spell',
        system: { level: 1, school: 'enc', prepared: 1, method: 'spell', activities: {} },
      },
      {
        _id: 'spellBanish00001',
        name: 'Banishment',
        type: 'spell',
        system: { level: 4, school: 'abj', prepared: 1, method: 'spell', activities: {} },
      },
      ...extraItems,
    ],
  };
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

// Randal's items (martial-captured): 3 weapons (Longsword gta26ORvqC323k3r,
// Longbow DHfjuHRMDDsyjBti, Handaxe rEwBQ75m41HeBYOs), Chain Mail
// yz7DxhEVWUzdQKm7 (heavy), Shield u69KONMFqydKuk1H (shield), Second Wind
// 7r63kurEAM3GdEec (1 activity), Grappler r7UallZJjcIFsz8i (passive feat).
// Akra's items (caster-captured): 2 weapons (Light Crossbow hutWJTfurJjNbSpG,
// Mace iLKpfoGF7rGpvNWD), Scale Mail WBL9RaW0MEEVU3fX (medium), Shield
// tnoOhcw37wWUhWzd (shield), 18 spells, Breath Weapon vWo0CO4uYJ8XRnRi.

describe('actions() — martial (Randal, Fighter 5)', () => {
  const all = actions(martialCaptured);

  it('exposes 18 skill checks + 6 ability checks + 6 saves', () => {
    expect(all.filter((a) => a.id.startsWith('skill.'))).toHaveLength(18);
    expect(all.filter((a) => /^ability\.\w+\.check$/.test(a.id))).toHaveLength(6);
    expect(all.filter((a) => /^ability\.\w+\.save$/.test(a.id))).toHaveLength(6);
    expect(action(martialCaptured, 'skill.ath')).toEqual({ id: 'skill.ath', label: 'Athletics', kind: 'check' });
    expect(action(martialCaptured, 'ability.str.check')).toEqual({
      id: 'ability.str.check',
      label: 'Strength Check',
      kind: 'check',
    });
    expect(action(martialCaptured, 'ability.str.save')).toEqual({
      id: 'ability.str.save',
      label: 'Strength Save',
      kind: 'save',
    });
  });

  it('exposes an attack per weapon and equip toggles for weapons + armor + shield', () => {
    const attacks = all.filter((a) => a.kind === 'attack');
    expect(attacks.map((a) => a.id).sort()).toEqual([
      'item.DHfjuHRMDDsyjBti.attack',
      'item.gta26ORvqC323k3r.attack',
      'item.rEwBQ75m41HeBYOs.attack',
    ]);
    expect(attacks.find((a) => a.id === 'item.gta26ORvqC323k3r.attack')?.label).toBe('Longsword');

    // Every attack gets a companion damage roll (M14: no native relay
    // damage-roll action exists, so the adapter computes the formula).
    const damages = all.filter((a) => a.kind === 'damage');
    expect(damages.map((a) => a.id).sort()).toEqual([
      'item.DHfjuHRMDDsyjBti.damage',
      'item.gta26ORvqC323k3r.damage',
      'item.rEwBQ75m41HeBYOs.damage',
    ]);

    const equips = all.filter((a) => a.kind === 'equip');
    expect(equips.map((a) => a.id).sort()).toEqual([
      'item.DHfjuHRMDDsyjBti.equip',
      'item.gta26ORvqC323k3r.equip',
      'item.rEwBQ75m41HeBYOs.equip',
      'item.u69KONMFqydKuk1H.equip', // Shield
      'item.yz7DxhEVWUzdQKm7.equip', // Chain Mail
    ]);
  });

  it('equip descriptors carry the current equipped state', () => {
    expect(action(martialCaptured, 'item.gta26ORvqC323k3r.equip').equipped).toBe(true);
    // Same actor with the Longsword unequipped -> descriptor flips.
    const unequipped: FoundryActorDoc = {
      ...martialCaptured,
      items: (martialCaptured.items ?? []).map((i) =>
        i._id === 'gta26ORvqC323k3r' ? { ...i, system: { ...i.system, equipped: false } } : i,
      ),
    };
    expect(action(unequipped, 'item.gta26ORvqC323k3r.equip').equipped).toBe(false);
  });

  it('usable feature (Second Wind, has an activity) gets a use action; passive feat (Grappler) gets none', () => {
    expect(action(martialCaptured, 'feature.7r63kurEAM3GdEec.use')).toEqual({
      id: 'feature.7r63kurEAM3GdEec.use',
      label: 'Second Wind',
      kind: 'use',
      effectType: 'heal',
      targeting: { mode: 'single', kind: 'heal' },
    });
    expect(all.some((a) => a.id.startsWith('feature.r7UallZJjcIFsz8i'))).toBe(false);
  });

  it('non-caster has no cast actions; total count is pinned', () => {
    expect(all.filter((a) => a.kind === 'cast')).toHaveLength(0);
    // 18 skills + 12 ability checks/saves + 1 initiative (M10) + 3 attacks
    // + 3 weapon damage rolls (M14) + 5 equips + 1 feature use + 7 item uses
    // (Waterskin, Torch, Rations, Piton, Rope, Horn, Bead of Force)
    // + 2 rests (M8; hp>0 & no concentration -> no death-save/end-conc)
    // + 21 move descriptors, one per physical item (M19)
    expect(all).toHaveLength(73);
  });
});

describe('actions() — caster (Akra, Cleric 5)', () => {
  const all = actions(casterCaptured);

  it('exposes a cast action per castable-now spell and the pinned total count', () => {
    // Actions tab shows only what's castable right now: 3 cantrips (Thaumaturgy,
    // Guidance, Sacred Flame) + 3 prepared (Guiding Bolt, Detect Magic, Cure
    // Wounds) + 2 always-prepared (Bless, Healing Word) = 8. The other 10
    // leveled spells are unprepared and still get a Prepare toggle (below)
    // but no Cast action here — the Spells tab is where you ready them.
    expect(all.filter((a) => a.kind === 'cast')).toHaveLength(8);
    expect(all.filter((a) => a.kind === 'attack')).toHaveLength(2);
    expect(all.filter((a) => a.kind === 'equip').map((a) => a.id).sort()).toEqual([
      'item.WBL9RaW0MEEVU3fX.equip', // Scale Mail (clothing items get no toggle)
      'item.hutWJTfurJjNbSpG.equip',
      'item.iLKpfoGF7rGpvNWD.equip',
      'item.tnoOhcw37wWUhWzd.equip', // Shield
    ]);
    expect(all.filter((a) => a.kind === 'use' && a.group === undefined).map((a) => a.id)).toEqual([
      'feature.vWo0CO4uYJ8XRnRi.use',
    ]);
    expect(all.filter((a) => a.kind === 'use' && a.group === 'items')).toHaveLength(7);
    // 18 skills + 12 ability checks/saves + 1 initiative (M10) + 2 attacks
    // + 2 weapon damage rolls (M14) + 2 spell damage rolls (Sacred Flame,
    // Guiding Bolt) + 4 equips + 8 casts (castable-now spells only)
    // + 13 prepare toggles (18 spells − 3 cantrips − 2 always-prepared)
    // + 1 feature use + 7 item uses (Waterskin, Torch, Common Clothes,
    // Rations, Rope, Vestments, Potion of Healing)
    // + 2 rests (M8; hp>0 & no concentration -> no death-save/end-conc)
    // + 21 move descriptors, one per physical item (M19)
    expect(all).toHaveLength(93);
  });

  it('a leveled spell with payable slots lists them (picker feed)', () => {
    // Guiding Bolt (level 1); raw capture has spell1.value=2, spell2.value=2,
    // spell3.value=1 — all payable, base up.
    expect(action(casterCaptured, 'spell.pZMrJb3AXiRYO5E8.cast')).toEqual({
      id: 'spell.pZMrJb3AXiRYO5E8.cast',
      label: 'Guiding Bolt',
      kind: 'cast',
      level: 1,
      effectType: 'damage',
      slotLevels: [1, 2, 3],
      targeting: { mode: 'single', kind: 'attack' },
    });
  });

  it('cast descriptors carry the spell level for per-level grouping (cantrip = 0)', () => {
    expect(action(casterCaptured, 'spell.P97npemu7j70IZAQ.cast').level).toBe(0); // Sacred Flame
    for (const a of actions(casterCaptured)) {
      if (a.kind === 'cast') expect(typeof a.level).toBe('number');
    }
  });

  it('cantrips carry no slotLevels at all', () => {
    const flame = action(casterCaptured, 'spell.P97npemu7j70IZAQ.cast'); // Sacred Flame, level 0
    expect(flame.kind).toBe('cast');
    expect(flame.slotLevels).toBeUndefined();
  });

  it('a leveled spell with nothing payable at any level is disabled (slotLevels: []) — upcast is not supported by the bridge', async () => {
    if (!dnd5eAdapter.enrich) throw new Error('adapter must expose enrich()');
    // Guiding Bolt is level 1; drain every level 1-3 slot.
    const enriched = await dnd5eAdapter.enrich(casterCaptured, {
      getSystemDetails: async () => ({
        spellSlots: {
          spell1: { value: 0, max: 4 },
          spell2: { value: 0, max: 3 },
          spell3: { value: 0, max: 1 },
        },
      }),
    });
    expect(action(enriched, 'spell.pZMrJb3AXiRYO5E8.cast').slotLevels).toEqual([]);
    // ...and buildAction refuses it.
    expect(() => build(enriched, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast' })).toThrow(IntentError);
  });

  it('unprepared leveled spells get no cast action on the Actions tab, but keep their Prepare toggle', () => {
    // Bane: prepared 0 in the capture. Foundry would refuse to cast it, so
    // the Actions tab must not offer it at all.
    expect(all.find((a) => a.id === 'spell.9FrgmKwWCYPhlZ5w.cast')).toBeUndefined();
    expect(() =>
      build(casterCaptured, { kind: 'cast', actionId: 'spell.9FrgmKwWCYPhlZ5w.cast' }),
    ).toThrow(IntentError);
    expect(action(casterCaptured, 'spell.9FrgmKwWCYPhlZ5w.prepare')).toEqual({
      id: 'spell.9FrgmKwWCYPhlZ5w.prepare',
      label: 'Bane',
      kind: 'prepare',
      prepared: false,
    });
    // The Spells tab still lists it — with its own actionId — so the player
    // can prepare it there.
    const spells = { items: spellRows(casterCaptured) };
    expect(spells.items.every((i) => i.actionId !== undefined)).toBe(true);
  });
});

describe('buildAction — checks and saves', () => {
  it('skill check uses the same bonus the sheet shows (Athletics: str +3, prof +3)', () => {
    expect(build(martialCaptured, { kind: 'check', actionId: 'skill.ath' })).toEqual({
      endpoint: 'roll',
      formula: '1d20 + 6',
      flavor: 'Athletics Check',
    });
  });

  it('advantage/disadvantage swap the d20 term', () => {
    expect(formulaOf(martialCaptured, { kind: 'check', actionId: 'skill.ath', mode: 'advantage' })).toBe('2d20kh1 + 6');
    expect(formulaOf(martialCaptured, { kind: 'check', actionId: 'skill.ath', mode: 'disadvantage' })).toBe(
      '2d20kl1 + 6',
    );
  });

  it('a negative modifier renders as valid Foundry syntax (Akra int 8 -> -1)', () => {
    expect(build(casterCaptured, { kind: 'check', actionId: 'ability.int.check' })).toEqual({
      endpoint: 'roll',
      formula: '1d20 - 1',
      flavor: 'Intelligence Check',
    });
    expect(formulaOf(casterCaptured, { kind: 'check', actionId: 'ability.int.check', mode: 'disadvantage' })).toBe(
      '2d20kl1 - 1',
    );
  });

  it('ability check uses the bare modifier (Randal str 16 -> +3)', () => {
    expect(build(martialCaptured, { kind: 'check', actionId: 'ability.str.check' })).toEqual({
      endpoint: 'roll',
      formula: '1d20 + 3',
      flavor: 'Strength Check',
    });
  });

  it('saves add proficiency only when save-proficient', () => {
    // str proficient: 1 -> +3 mod +3 prof
    expect(build(martialCaptured, { kind: 'save', actionId: 'ability.str.save' })).toEqual({
      endpoint: 'roll',
      formula: '1d20 + 6',
      flavor: 'Strength Save',
    });
    // wis proficient: 0, wis 13 -> +1
    expect(formulaOf(martialCaptured, { kind: 'save', actionId: 'ability.wis.save' })).toBe('1d20 + 1');
  });

  it('skill check prefers the derived total when serialized (synthetic caster rel: +2 with bonuses)', () => {
    expect(formulaOf(caster, { kind: 'check', actionId: 'skill.rel' })).toBe('1d20 + 2');
  });

  it('every skill/ability roll uses exactly the bonus the sheet displays (no drift)', () => {
    for (const actor of [martialCaptured, casterCaptured, caster]) {
      const vm = dnd5eAdapter.toViewModel(actor);
      const skills = vm.sections.find((s) => s.id === 'skills');
      if (skills?.kind !== 'stats') throw new Error('skills must be a stats section');
      for (const stat of skills.stats) {
        const shown = /^([+-])(\d+)$/.exec(String(stat.value));
        if (!shown || stat.actionId === undefined) throw new Error(`bad skill stat ${stat.id}`);
        expect(formulaOf(actor, { kind: 'check', actionId: stat.actionId })).toBe(
          `1d20 ${shown[1]} ${shown[2]}`,
        );
      }
      const abilities = vm.sections.find((s) => s.id === 'abilities');
      if (abilities?.kind !== 'stats') throw new Error('abilities must be a stats section');
      for (const stat of abilities.stats) {
        // Sub starts with the modifier; M14 may append ' · ● save' after it.
        const shown = /^([+-])(\d+)(?: · |$)/.exec(String(stat.sub));
        if (!shown || stat.actionId === undefined) throw new Error(`bad ability stat ${stat.id}`);
        expect(formulaOf(actor, { kind: 'check', actionId: stat.actionId })).toBe(
          `1d20 ${shown[1]} ${shown[2]}`,
        );
      }
    }
  });
});

describe('buildAction — attack / cast / use / equip', () => {
  it('attack maps to use-item with the bare item id', () => {
    expect(build(martialCaptured, { kind: 'attack', actionId: 'item.DHfjuHRMDDsyjBti.attack' })).toEqual({
      endpoint: 'use-item',
      itemId: 'DHfjuHRMDDsyjBti',
    });
  });

  it('attack with advantage builds a 2d20kh1 to-hit formula (fallback, no execute-JS)', () => {
    const actor = {
      system: { attributes: { prof: 2 }, abilities: { str: { mod: 3 }, dex: { mod: 1 } } },
      items: [
        {
          _id: 'wpn1',
          type: 'weapon',
          name: 'Longsword',
          system: { equipped: true, proficient: 1, damage: { base: { number: 1, denomination: 8 } } },
        },
      ],
    } as unknown as FoundryActorDoc;
    expect(build(actor, { kind: 'attack', actionId: 'item.wpn1.attack', mode: 'advantage' })).toEqual({
      endpoint: 'roll',
      formula: '2d20kh1 + 5', // STR +3 + proficiency +2
      flavor: 'Longsword — Attack',
    });
    expect(build(actor, { kind: 'attack', actionId: 'item.wpn1.attack', mode: 'disadvantage' })).toMatchObject({
      formula: '2d20kl1 + 5',
    });
  });

  it('attack with no mode still maps to native use-item', () => {
    const actor = {
      system: { attributes: { prof: 2 }, abilities: { str: { mod: 3 }, dex: { mod: 1 } } },
      items: [
        {
          _id: 'wpn1',
          type: 'weapon',
          name: 'Longsword',
          system: { equipped: true, proficient: 1, damage: { base: { number: 1, denomination: 8 } } },
        },
      ],
    } as unknown as FoundryActorDoc;
    expect(build(actor, { kind: 'attack', actionId: 'item.wpn1.attack' })).toEqual({
      endpoint: 'use-item',
      itemId: 'wpn1',
    });
  });

  it('attack rejects an unknown roll mode', () => {
    const actor = {
      system: { attributes: { prof: 2 }, abilities: { str: { mod: 3 }, dex: { mod: 1 } } },
      items: [
        {
          _id: 'wpn1',
          type: 'weapon',
          name: 'Longsword',
          system: { equipped: true, proficient: 1, damage: { base: { number: 1, denomination: 8 } } },
        },
      ],
    } as unknown as FoundryActorDoc;
    expect(() =>
      build(actor, { kind: 'attack', actionId: 'item.wpn1.attack', mode: 'sideways' as never }),
    ).toThrow(/roll mode/);
  });

  it('use maps to use-feature (non-heal features are unaffected by M15)', () => {
    // Second Wind is heal-type and now maps to roll-and-heal (see the M15
    // 'buildAction — heal formulas & self-heal write-through' describe
    // block below) — clone it with a non-heal activity type to keep covering
    // the plain use-feature fallback path. Same technique as the other
    // 'still maps feature use intents to use-feature' fix (M15 Step 6); the
    // task brief named only that one, but this test shares the identical
    // premise (Second Wind -> use-feature) and broke for the same reason.
    const nonHeal: FoundryActorDoc = {
      ...martialCaptured,
      items: (martialCaptured.items ?? []).map((i) => {
        if (i._id !== '7r63kurEAM3GdEec') return i;
        const system = i.system as Record<string, unknown>;
        const activities = system.activities as Record<string, unknown>;
        const activityId = Object.keys(activities)[0] as string;
        const activity = activities[activityId] as Record<string, unknown>;
        return {
          ...i,
          system: { ...system, activities: { ...activities, [activityId]: { ...activity, type: 'utility' } } },
        };
      }),
    };
    expect(build(nonHeal, { kind: 'use', actionId: 'feature.7r63kurEAM3GdEec.use' })).toEqual({
      endpoint: 'use-feature',
      itemId: '7r63kurEAM3GdEec',
    });
  });

  it('cast is the to-hit/activation: use-spell at base level (an explicit base-level slotLevel is honored, not an upcast)', () => {
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast', slotLevel: 1 })).toEqual({
      endpoint: 'use-spell',
      itemId: 'pZMrJb3AXiRYO5E8',
    });
  });

  it('cantrip cast maps to use-spell with no slot', () => {
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.P97npemu7j70IZAQ.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: 'P97npemu7j70IZAQ',
    });
  });

  it('a damage spell gets a companion damage action that rolls its dice (like weapons)', () => {
    // Guiding Bolt (attack, 4d6) and Sacred Flame (save cantrip, 1d8) each emit
    // a spell.<id>.damage alongside the cast, resolving to a bare display roll.
    const all = actions(casterCaptured);
    expect(all.find((a) => a.id === 'spell.pZMrJb3AXiRYO5E8.damage')).toMatchObject({ kind: 'damage' });
    expect(formulaOf(casterCaptured, { kind: 'damage', actionId: 'spell.pZMrJb3AXiRYO5E8.damage' })).toBe('4d6');
    // Akra is character level 5 -> cantrip tier 1 (Task 3: scaled display
    // formulas) -> Sacred Flame's base 1d8 scales to 2d8, not the base dice.
    expect(build(casterCaptured, { kind: 'damage', actionId: 'spell.P97npemu7j70IZAQ.damage' })).toEqual({
      endpoint: 'roll',
      formula: '2d8',
      flavor: 'Sacred Flame — Damage',
    });
  });

  it('equip round-trips the desired state', () => {
    expect(build(martialCaptured, { kind: 'equip', actionId: 'item.gta26ORvqC323k3r.equip', equipped: false })).toEqual({
      endpoint: 'equip-item',
      itemId: 'gta26ORvqC323k3r',
      equipped: false,
    });
    expect(build(martialCaptured, { kind: 'equip', actionId: 'item.yz7DxhEVWUzdQKm7.equip', equipped: true })).toEqual({
      endpoint: 'equip-item',
      itemId: 'yz7DxhEVWUzdQKm7',
      equipped: true,
    });
  });
});

describe('buildAction — upcast (cast-at-slot)', () => {
  it('base-level choice keeps the plain use-spell wire shape', () => {
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast', slotLevel: 1 })).toEqual({
      endpoint: 'use-spell',
      itemId: 'pZMrJb3AXiRYO5E8',
    });
  });

  it('a higher slot maps to cast-at-slot with the spellN key (Guiding Bolt at 3rd)', () => {
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast', slotLevel: 3 })).toEqual({
      endpoint: 'cast-at-slot',
      itemId: 'pZMrJb3AXiRYO5E8',
      slotKey: 'spell3',
    });
  });

  it('a slotLevel not in the payable list is INVALID (no slot to pay with)', () => {
    expectIntentError(
      () => build(casterCaptured, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast', slotLevel: 5 }),
      'INVALID',
    );
  });

  it('omitted slotLevel defaults to base when base is payable', () => {
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: 'pZMrJb3AXiRYO5E8',
    });
  });

  it('an upcast heal keeps the use-and-roll display shape but activates via cast-at-slot (Cure Wounds at 2nd)', () => {
    const a = build(casterCaptured, { kind: 'cast', actionId: 'spell.LjT1wf4D38c9Ieuo.cast', slotLevel: 2 });
    expect(a).toMatchObject({
      endpoint: 'use-and-roll',
      use: 'cast-at-slot',
      itemId: 'LjT1wf4D38c9Ieuo',
      slotKey: 'spell2',
      flavor: 'Cure Wounds — Healing',
    });
  });
});

describe('buildAction — weapon damage (M14)', () => {
  // Randal: str +3, dex +2. Akra: str +3, dex +0.
  it('melee, non-finesse weapon uses STR (Longsword: 1d8 + str)', () => {
    expect(formulaOf(martialCaptured, { kind: 'damage', actionId: 'item.gta26ORvqC323k3r.damage' })).toBe('1d8 + 3');
  });

  it('ranged weapon uses DEX (Longbow: 1d8 + dex)', () => {
    expect(formulaOf(martialCaptured, { kind: 'damage', actionId: 'item.DHfjuHRMDDsyjBti.damage' })).toBe('1d8 + 2');
  });

  it('thrown-but-not-finesse weapon still keeps its melee (STR) ability (Handaxe: 1d6 + str)', () => {
    expect(formulaOf(martialCaptured, { kind: 'damage', actionId: 'item.rEwBQ75m41HeBYOs.damage' })).toBe('1d6 + 3');
  });

  it('a zero ability modifier is omitted, not rendered as "+ 0" (Akra dex +0 on her ranged weapon)', () => {
    expect(formulaOf(casterCaptured, { kind: 'damage', actionId: 'item.hutWJTfurJjNbSpG.damage' })).toBe('1d8');
  });

  it('finesse weapon picks the better of STR/DEX', () => {
    // Synthetic: Randal's Longsword with the finesse property added, and DEX
    // pushed above STR to confirm the "better of the two" pick, not a fixed one.
    const system = martialCaptured.system as Record<string, unknown>;
    const abilities = system.abilities as Record<string, unknown>;
    const dex = abilities.dex as Record<string, unknown>;
    const finesseWielder: FoundryActorDoc = {
      ...martialCaptured,
      system: { ...system, abilities: { ...abilities, dex: { ...dex, value: 20 } } },
      items: (martialCaptured.items ?? []).map((i) =>
        i._id === 'gta26ORvqC323k3r'
          ? { ...i, system: { ...(i.system as Record<string, unknown>), properties: ['ver', 'fin'] } }
          : i,
      ),
    };
    expect(formulaOf(finesseWielder, { kind: 'damage', actionId: 'item.gta26ORvqC323k3r.damage' })).toBe('1d8 + 5');
  });

  it('an explicit activity ability override wins over the finesse/ranged/melee default', () => {
    const longsword = (martialCaptured.items ?? []).find((i) => i._id === 'gta26ORvqC323k3r');
    if (!longsword) throw new Error('fixture missing Longsword');
    const lsSystem = longsword.system as Record<string, unknown>;
    const activities = lsSystem.activities as Record<string, unknown>;
    const activity = activities.dnd5eactivity000 as Record<string, unknown>;
    const attack = activity.attack as Record<string, unknown>;
    const overridden: FoundryActorDoc = {
      ...martialCaptured,
      items: (martialCaptured.items ?? []).map((i) =>
        i._id === 'gta26ORvqC323k3r'
          ? {
              ...i,
              system: {
                ...lsSystem,
                activities: { ...activities, dnd5eactivity000: { ...activity, attack: { ...attack, ability: 'dex' } } },
              },
            }
          : i,
      ),
    };
    expect(formulaOf(overridden, { kind: 'damage', actionId: 'item.gta26ORvqC323k3r.damage' })).toBe('1d8 + 2');
  });

  it('unknown damage action id -> UNKNOWN_RESOURCE', () => {
    expectIntentError(
      () => build(martialCaptured, { kind: 'damage', actionId: 'item.NoSuchItem00001.damage' }),
      'UNKNOWN_RESOURCE',
    );
  });
});

describe('effectType classification (M15)', () => {
  it('heal-type activities classify as heal', () => {
    expect(action(casterCaptured, 'spell.LjT1wf4D38c9Ieuo.cast').effectType).toBe('heal'); // Cure Wounds
    expect(action(casterCaptured, 'spell.HpjaVMLEU14tJG7y.cast').effectType).toBe('heal'); // Healing Word
  });

  it('attack-type activities classify as damage', () => {
    expect(action(casterCaptured, 'spell.pZMrJb3AXiRYO5E8.cast').effectType).toBe('damage'); // Guiding Bolt
  });

  it('a save-type activity that deals damage classifies as damage (Sacred Flame)', () => {
    expect(action(casterCaptured, 'spell.P97npemu7j70IZAQ.cast').effectType).toBe('damage');
  });

  it('a save-type activity with no damage parts classifies as utility (Bane — a debuff, no damage)', () => {
    // Bane is unprepared in the fixture (prepared: 0), so the M14 spell
    // filter gives it no cast action by default — prepare it in a clone to
    // reach the classification path directly (same technique as the M14
    // finesse-weapon synthetic-actor test).
    const prepared: FoundryActorDoc = {
      ...casterCaptured,
      items: (casterCaptured.items ?? []).map((i) =>
        i._id === '9FrgmKwWCYPhlZ5w'
          ? { ...i, system: { ...(i.system as Record<string, unknown>), prepared: 1 } }
          : i,
      ),
    };
    expect(action(prepared, 'spell.9FrgmKwWCYPhlZ5w.cast').effectType).toBe('utility');
  });

  it('a plain utility activity classifies as utility (Detect Magic)', () => {
    expect(action(casterCaptured, 'spell.a7IlF5H2ZPsB4VWm.cast').effectType).toBe('utility');
  });

  it('Second Wind (feature, heal-type) classifies as heal', () => {
    expect(action(martialCaptured, 'feature.7r63kurEAM3GdEec.use').effectType).toBe('heal');
  });

  it('weapon attack/damage descriptors carry no effectType (out of scope — Attacks stays its own section)', () => {
    expect(action(martialCaptured, 'item.gta26ORvqC323k3r.attack').effectType).toBeUndefined();
    expect(action(martialCaptured, 'item.gta26ORvqC323k3r.damage').effectType).toBeUndefined();
  });
});

describe('effectType classification — items (M16)', () => {
  it('Bead of Force (save DC on one activity, damage die on a separate utility activity) classifies as damage', () => {
    expect(action(martialCaptured, 'item.iecfawCz0pIwcPVg.use').effectType).toBe('damage');
  });

  it('Potion of Healing (heal-type activity) classifies as heal', () => {
    expect(action(casterCaptured, 'item.7vIZxvwGzmJgmugo.use').effectType).toBe('heal');
  });

  it('mundane items with no damage/heal activity stay utility (Torch)', () => {
    const torch = martialCaptured.items?.find((i) => i.name === 'Torch');
    if (!torch) throw new Error('Torch not found');
    expect(action(martialCaptured, `item.${torch._id}.use`).effectType).toBe('utility');
  });

  it('a lone save activity with no sibling utility roll still classifies as utility (regression: Bane/Command/Sanctuary unaffected)', () => {
    const prepared: FoundryActorDoc = {
      ...casterCaptured,
      items: (casterCaptured.items ?? []).map((i) =>
        i._id === '9FrgmKwWCYPhlZ5w'
          ? { ...i, system: { ...(i.system as Record<string, unknown>), prepared: 1 } }
          : i,
      ),
    };
    expect(action(prepared, 'spell.9FrgmKwWCYPhlZ5w.cast').effectType).toBe('utility'); // Bane
  });
});

describe('buildAction — heal formulas & self-heal write-through (M15)', () => {
  it('Second Wind (self-targeted) rolls 1d10 + fighter level and writes HP directly', () => {
    // Randal's fixture HP is 35/44 (system.attributes.hp — verified directly
    // against martial-captured.json; do not assume live-session values,
    // they drift as the test campaign is played).
    // use-and-roll: Foundry's own activation consumes the use (and refuses
    // when empty); the formula is the client-computed display roll; heal
    // carries the self-apply write.
    expect(build(martialCaptured, { kind: 'use', actionId: 'feature.7r63kurEAM3GdEec.use' })).toEqual({
      endpoint: 'use-and-roll',
      use: 'use-feature',
      itemId: '7r63kurEAM3GdEec',
      formula: '1d10 + 5',
      flavor: 'Second Wind — Healing',
      heal: { path: 'system.attributes.hp.value', current: 35, max: 44 },
    });
  });

  it('an exhausted self-heal is rejected with a 422 instead of healing for free', () => {
    // Fixture Second Wind is {max:"1", spent:0}; clone it fully spent.
    const spent: FoundryActorDoc = {
      ...martialCaptured,
      items: (martialCaptured.items ?? []).map((i) =>
        i._id === '7r63kurEAM3GdEec'
          ? {
              ...i,
              system: {
                ...(i.system as Record<string, unknown>),
                uses: { max: '1', recovery: [{ period: 'sr', type: 'recoverAll' }], spent: 1 },
              },
            }
          : i,
      ),
    };
    expectIntentError(() => build(spent, { kind: 'use', actionId: 'feature.7r63kurEAM3GdEec.use' }), 'INVALID');
  });

  it('Cure Wounds (target-chosen, not self) consumes its slot via use-spell, rolls, but does NOT auto-apply (no heal field)', () => {
    // Akra: WIS 15 (+2), Cleric spellcasting ability is "wis" in the fixture.
    // Branch review 2026-07-09: an earlier bare-roll shape here silently
    // stopped consuming the spell slot — use-and-roll restores that by
    // running Foundry's own cast first.
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.LjT1wf4D38c9Ieuo.cast' })).toEqual({
      endpoint: 'use-and-roll',
      use: 'use-spell',
      itemId: 'LjT1wf4D38c9Ieuo',
      formula: '1d8 + 2',
      flavor: 'Cure Wounds — Healing',
    });
  });

  it('Healing Word (target-chosen, not self) consumes its slot and rolls 1d4 + spellcasting mod', () => {
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.HpjaVMLEU14tJG7y.cast' })).toEqual({
      endpoint: 'use-and-roll',
      use: 'use-spell',
      itemId: 'HpjaVMLEU14tJG7y',
      formula: '1d4 + 2',
      flavor: 'Healing Word — Healing',
    });
  });

  it('non-heal use/cast actions are unaffected (Guiding Bolt cast still maps to use-spell)', () => {
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: 'pZMrJb3AXiRYO5E8',
    });
  });
});

describe('buildAction — item on-use effects (M16)', () => {
  it('Bead of Force consumes its use via use-item and rolls its sibling-activity damage formula, display-only (no heal field)', () => {
    // Branch review 2026-07-09: an earlier bare-roll shape never consumed
    // the bead (infinite reuse) — use-and-roll lets Foundry's activation
    // consume/destroy it before the display roll.
    expect(build(martialCaptured, { kind: 'use', actionId: 'item.iecfawCz0pIwcPVg.use' })).toEqual({
      endpoint: 'use-and-roll',
      use: 'use-item',
      itemId: 'iecfawCz0pIwcPVg',
      formula: '5d4',
      flavor: 'Bead of Force — Damage',
      // Real fixture data: Bead of Force's activities carry a radius/10
      // template (target.template.type), so this heads through the
      // template-suppressing execute-js path headless.
      noTemplate: true,
    });
  });

  it('an exhausted damage item is rejected with a 422', () => {
    const spent: FoundryActorDoc = {
      ...martialCaptured,
      items: (martialCaptured.items ?? []).map((i) =>
        i._id === 'iecfawCz0pIwcPVg'
          ? {
              ...i,
              system: {
                ...(i.system as Record<string, unknown>),
                uses: { max: '1', recovery: [], autoDestroy: true, spent: 1 },
              },
            }
          : i,
      ),
    };
    expectIntentError(() => build(spent, { kind: 'use', actionId: 'item.iecfawCz0pIwcPVg.use' }), 'INVALID');
  });

  it('Potion of Healing always self-heals, even though its real target.affects.type is "creature", not "self"', () => {
    // Akra's fixture HP is 38/38 (verified directly against caster-captured.json).
    // Consumption (including the single-use autoDestroy) is Foundry's job,
    // reached through the use-item activation — not re-implemented here.
    expect(build(casterCaptured, { kind: 'use', actionId: 'item.7vIZxvwGzmJgmugo.use' })).toEqual({
      endpoint: 'use-and-roll',
      use: 'use-item',
      itemId: '7vIZxvwGzmJgmugo',
      formula: '2d4 + 2',
      flavor: 'Potion of Healing — Healing',
      heal: { path: 'system.attributes.hp.value', current: 38, max: 38 },
    });
  });

  it('classification and heal formula agree when the heal activity is not first (multi-activity item)', () => {
    // Synthetic: prepend a utility activity before the Potion's heal
    // activity. effectTypeOf scans all activities, so healFormula and
    // isSelfTargeted must find the same heal activity, not just [0].
    const reordered: FoundryActorDoc = {
      ...casterCaptured,
      items: (casterCaptured.items ?? []).map((i) => {
        if (i._id !== '7vIZxvwGzmJgmugo') return i;
        const system = i.system as Record<string, unknown>;
        const activities = system.activities as Record<string, unknown>;
        return {
          ...i,
          system: {
            ...system,
            activities: {
              aaaFirstUtility0: { _id: 'aaaFirstUtility0', type: 'utility', activation: { type: 'action' } },
              ...activities,
            },
          },
        };
      }),
    };
    const result = build(reordered, { kind: 'use', actionId: 'item.7vIZxvwGzmJgmugo.use' });
    expect(result).toMatchObject({
      endpoint: 'use-and-roll',
      formula: '2d4 + 2',
      heal: { path: 'system.attributes.hp.value', current: 38, max: 38 },
    });
  });

  it('a mundane item with no damage/heal effect is unaffected (Torch still maps to use-item)', () => {
    const torch = martialCaptured.items?.find((i) => i.name === 'Torch');
    if (!torch) throw new Error('Torch not found');
    expect(build(martialCaptured, { kind: 'use', actionId: `item.${torch._id}.use` })).toEqual({
      endpoint: 'use-item',
      itemId: torch._id,
      // Real fixture data: Torch's attack activity carries a radius/40
      // template (its light-shedding "area"), so noTemplate applies here too.
      noTemplate: true,
    });
  });
});

describe('buildAction — attunement-required-to-use enforcement (M16)', () => {
  function withAttunement(attunement: string, attuned: boolean): FoundryActorDoc {
    return {
      ...martialCaptured,
      items: (martialCaptured.items ?? []).map((i) =>
        i._id === 'iecfawCz0pIwcPVg'
          ? { ...i, system: { ...(i.system as Record<string, unknown>), attunement, attuned } }
          : i,
      ),
    };
  }

  it('blocks use with a clear message when attunement is required but missing', () => {
    const actor = withAttunement('required', false);
    let caught: unknown;
    try {
      build(actor, { kind: 'use', actionId: 'item.iecfawCz0pIwcPVg.use' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IntentError);
    expect((caught as IntentError).code).toBe('INVALID');
    expect((caught as IntentError).message).toBe('"Bead of Force" requires attunement');
  });

  it('allows use normally once attuned', () => {
    const actor = withAttunement('required', true);
    expect(build(actor, { kind: 'use', actionId: 'item.iecfawCz0pIwcPVg.use' })).toEqual({
      endpoint: 'use-and-roll',
      use: 'use-item',
      itemId: 'iecfawCz0pIwcPVg',
      formula: '5d4',
      flavor: 'Bead of Force — Damage',
      noTemplate: true,
    });
  });

  it('optional-attunement items work unattuned (only "required" gates use)', () => {
    // By the rules an attunement-optional item functions without attunement
    // (it just forgoes the attuned benefit) — the gate must not block it
    // even though isAttuneable offers it the attune toggle.
    const actor = withAttunement('optional', false);
    expect(build(actor, { kind: 'use', actionId: 'item.iecfawCz0pIwcPVg.use' })).toEqual({
      endpoint: 'use-and-roll',
      use: 'use-item',
      itemId: 'iecfawCz0pIwcPVg',
      formula: '5d4',
      flavor: 'Bead of Force — Damage',
      noTemplate: true,
    });
  });

  it('items that do not require attunement are unaffected (Bead of Force real data, Torch)', () => {
    expect(build(martialCaptured, { kind: 'use', actionId: 'item.iecfawCz0pIwcPVg.use' })).toEqual({
      endpoint: 'use-and-roll',
      use: 'use-item',
      itemId: 'iecfawCz0pIwcPVg',
      formula: '5d4',
      flavor: 'Bead of Force — Damage',
      // Real fixture data: Bead of Force's activities carry a radius/10
      // template (target.template.type), so this heads through the
      // template-suppressing execute-js path headless.
      noTemplate: true,
    });
  });
});

describe('buildAction — rejections', () => {
  it('unknown action id -> UNKNOWN_RESOURCE', () => {
    expectIntentError(() => build(martialCaptured, { kind: 'check', actionId: 'skill.nope' }), 'UNKNOWN_RESOURCE');
    expectIntentError(
      () => build(martialCaptured, { kind: 'attack', actionId: 'item.NoSuchItem00001.attack' }),
      'UNKNOWN_RESOURCE',
    );
    // Grappler is passive: no use action exists for it.
    expectIntentError(
      () => build(martialCaptured, { kind: 'use', actionId: 'feature.r7UallZJjcIFsz8i.use' }),
      'UNKNOWN_RESOURCE',
    );
  });

  it('kind mismatch with the descriptor -> UNKNOWN_RESOURCE', () => {
    expectIntentError(() => build(martialCaptured, { kind: 'attack', actionId: 'skill.ath' }), 'UNKNOWN_RESOURCE');
    expectIntentError(
      () => build(martialCaptured, { kind: 'save', actionId: 'ability.str.check' }),
      'UNKNOWN_RESOURCE',
    );
    expectIntentError(
      () => build(martialCaptured, { kind: 'equip', actionId: 'item.gta26ORvqC323k3r.attack', equipped: false }),
      'UNKNOWN_RESOURCE',
    );
  });

  it('casting a spell with no base-level slot -> INVALID (bridge casts at base only)', async () => {
    if (!dnd5eAdapter.enrich) throw new Error('adapter must expose enrich()');
    // Guiding Bolt is level 1; drain 1st-level slots (2nd/3rd remain but the
    // module cannot upcast into them).
    const drained = await dnd5eAdapter.enrich(casterCaptured, {
      getSystemDetails: async () => ({
        spellSlots: { spell1: { value: 0, max: 4 }, spell2: { value: 2, max: 3 }, spell3: { value: 1, max: 1 } },
      }),
    });
    expectIntentError(
      () => build(drained, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast' }),
      'INVALID',
    );
  });

  it('malformed params -> INVALID', () => {
    expectIntentError(
      () =>
        build(martialCaptured, {
          kind: 'check',
          actionId: 'skill.ath',
          mode: 'lucky' as unknown as 'advantage',
        }),
      'INVALID',
    );
    expectIntentError(
      () =>
        build(martialCaptured, {
          kind: 'equip',
          actionId: 'item.gta26ORvqC323k3r.equip',
          equipped: 'yes' as unknown as boolean,
        }),
      'INVALID',
    );
  });
});

describe('M8 actor-command actions (rest / death save / concentration)', () => {
  it('short + long rest are always present, regardless of state', () => {
    for (const actor of [martialCaptured, casterCaptured]) {
      const ids = actions(actor).map((a) => a.id);
      expect(ids).toContain('rest.short');
      expect(ids).toContain('rest.long');
    }
    expect(action(martialCaptured, 'rest.short')).toEqual({ id: 'rest.short', label: 'Short Rest', kind: 'rest' });
    expect(action(martialCaptured, 'rest.long')).toEqual({ id: 'rest.long', label: 'Long Rest', kind: 'rest' });
  });

  it('death save appears only when hp <= 0', () => {
    expect(actions(martialCaptured).some((a) => a.id === 'deathsave.roll')).toBe(false);
    const down: FoundryActorDoc = {
      ...martialCaptured,
      system: {
        ...martialCaptured.system,
        attributes: {
          ...(martialCaptured.system.attributes as Record<string, unknown>),
          hp: { ...((martialCaptured.system.attributes as Record<string, unknown>).hp as Record<string, unknown>), value: 0 },
        },
      },
    };
    expect(action(down, 'deathsave.roll')).toEqual({ id: 'deathsave.roll', label: 'Death Save', kind: 'deathsave' });
  });

  it('concentration.end appears only while concentrating', () => {
    expect(actions(casterCaptured).some((a) => a.id === 'concentration.end')).toBe(false);
    const conc: FoundryActorDoc = {
      ...casterCaptured,
      effects: [{ _id: 'e1', name: 'Concentrating: Bless', statuses: ['concentrating'], disabled: false }],
    };
    expect(action(conc, 'concentration.end')).toEqual({
      id: 'concentration.end',
      label: 'End Concentration',
      kind: 'endconcentration',
    });
  });

  it('buildAction maps all four commands to the right relay endpoints', () => {
    expect(build(martialCaptured, { kind: 'rest', actionId: 'rest.short' })).toEqual({ endpoint: 'short-rest' });
    expect(build(martialCaptured, { kind: 'rest', actionId: 'rest.long' })).toEqual({ endpoint: 'long-rest' });

    const down: FoundryActorDoc = {
      ...martialCaptured,
      system: {
        ...martialCaptured.system,
        attributes: {
          ...(martialCaptured.system.attributes as Record<string, unknown>),
          hp: { ...((martialCaptured.system.attributes as Record<string, unknown>).hp as Record<string, unknown>), value: 0 },
        },
      },
    };
    expect(build(down, { kind: 'deathsave', actionId: 'deathsave.roll' })).toEqual({ endpoint: 'death-save' });

    const conc: FoundryActorDoc = {
      ...casterCaptured,
      effects: [{ _id: 'e1', name: 'Concentrating: Bless', statuses: ['concentrating'], disabled: false }],
    };
    expect(build(conc, { kind: 'endconcentration', actionId: 'concentration.end' })).toEqual({
      endpoint: 'break-concentration',
    });
  });

  it('rejects commands whose descriptor is absent for this actor state', () => {
    // Not concentrating -> no concentration.end descriptor.
    expectIntentError(
      () => build(casterCaptured, { kind: 'endconcentration', actionId: 'concentration.end' }),
      'UNKNOWN_RESOURCE',
    );
    // hp > 0 -> no death-save descriptor.
    expectIntentError(
      () => build(martialCaptured, { kind: 'deathsave', actionId: 'deathsave.roll' }),
      'UNKNOWN_RESOURCE',
    );
    // kind mismatch against a present descriptor.
    expectIntentError(
      () => build(martialCaptured, { kind: 'check', actionId: 'rest.short' }),
      'UNKNOWN_RESOURCE',
    );
  });
});

describe('M10 initiative roll', () => {
  it('exposes init.roll as a check action for every actor', () => {
    for (const actor of [martialCaptured, casterCaptured, caster]) {
      expect(action(actor, 'init.roll')).toEqual({ id: 'init.roll', label: 'Initiative', kind: 'check' });
    }
  });

  it('rolls d20 + the initiative the headline shows (martial: dex fallback +2)', () => {
    expect(build(martialCaptured, { kind: 'check', actionId: 'init.roll' })).toEqual({
      endpoint: 'roll',
      formula: '1d20 + 2',
      flavor: 'Initiative',
    });
    // Derived init.total preferred (synthetic caster: 0).
    expect(formulaOf(caster, { kind: 'check', actionId: 'init.roll' })).toBe('1d20 + 0');
  });

  it('advantage/disadvantage swap the d20 term', () => {
    expect(formulaOf(martialCaptured, { kind: 'check', actionId: 'init.roll', mode: 'advantage' })).toBe('2d20kh1 + 2');
    expect(formulaOf(martialCaptured, { kind: 'check', actionId: 'init.roll', mode: 'disadvantage' })).toBe(
      '2d20kl1 + 2',
    );
  });

  it('the headline init stat carries actionId init.roll', () => {
    for (const actor of [martialCaptured, casterCaptured]) {
      const byId = new Map(dnd5eAdapter.toViewModel(actor).headline.map((s) => [s.id, s]));
      expect(byId.get('init')?.actionId).toBe('init.roll');
    }
  });

  it('kind mismatch is rejected', () => {
    expectIntentError(() => build(martialCaptured, { kind: 'save', actionId: 'init.roll' }), 'UNKNOWN_RESOURCE');
  });
});

describe('view model wiring', () => {
  it('skill and ability stats carry actionIds', () => {
    const skills = section(martialCaptured, 'skills');
    if (skills.kind !== 'stats') throw new Error('skills must be a stats section');
    expect(skills.stats.find((s) => s.id === 'skill.ath')?.actionId).toBe('skill.ath');
    expect(skills.stats.every((s) => s.actionId === s.id)).toBe(true);
    const abilities = section(martialCaptured, 'abilities');
    if (abilities.kind !== 'stats') throw new Error('abilities must be a stats section');
    expect(abilities.stats.find((s) => s.id === 'ability.str')?.actionId).toBe('ability.str.check');
  });

  it('inventory rows manage only: equip toggles where applicable, never a primary action', () => {
    const inv = section(martialCaptured, 'inventory');
    if (inv.kind !== 'list') throw new Error('inventory must be a list section');
    const sword = inv.items.find((i) => i.label === 'Longsword');
    expect(sword?.actionId).toBeUndefined();
    expect(sword?.toggleActionId).toBe('item.gta26ORvqC323k3r.equip');
    const mail = inv.items.find((i) => i.label === 'Chain Mail');
    expect(mail?.actionId).toBeUndefined();
    expect(mail?.toggleActionId).toBe('item.yz7DxhEVWUzdQKm7.equip');
    const torch = inv.items.find((i) => i.label === 'Torch');
    expect(torch?.actionId).toBeUndefined();
    expect(torch?.toggleActionId).toBeUndefined();
  });

  it('spell rows carry cast actions', () => {
    const spells = { items: spellRows(casterCaptured) };
    expect(spells.items.find((i) => i.label === 'Guiding Bolt')?.actionId).toBe('spell.pZMrJb3AXiRYO5E8.cast');
    expect(spells.items.every((i) => i.actionId === `spell.${i.id}.cast`)).toBe(true);
  });

  it('usable feature rows carry use actions; passive feats do not', () => {
    const features = section(martialCaptured, 'features');
    if (features.kind !== 'list') throw new Error('features must be a list section');
    expect(features.items.find((i) => i.label === 'Second Wind')?.actionId).toBe('feature.7r63kurEAM3GdEec.use');
    expect(features.items.find((i) => i.label === 'Grappler')?.actionId).toBeUndefined();
  });

  it('the sheet embeds the full action list', () => {
    expect(dnd5eAdapter.toViewModel(martialCaptured).actions).toEqual(actions(martialCaptured));
    expect(dnd5eAdapter.toViewModel(casterCaptured).actions).toHaveLength(93);
  });
});

describe('item use actions (inventory/actions split)', () => {
  const all = actions(martialCaptured);
  const itemOf = (name: string) => {
    const item = martialCaptured.items?.find((i) => i.name === name);
    if (!item) throw new Error(`item ${name} not found`);
    return item;
  };

  it('offers use (group items) for physical items with activities', () => {
    const torch = itemOf('Torch');
    const a = all.find((x) => x.id === `item.${torch._id}.use`);
    expect(a).toMatchObject({ kind: 'use', group: 'items', label: 'Torch' });
    // Rations (autoDestroy) and the Horn (tool) are usable too.
    expect(all.some((x) => x.id === `item.${itemOf('Rations')._id}.use`)).toBe(true);
    expect(all.some((x) => x.id === `item.${itemOf('Horn')._id}.use`)).toBe(true);
  });

  it('offers no use action for passive items without activities', () => {
    for (const name of ['Hammer', 'Arrow', 'Chain Mail', 'Backpack']) {
      expect(all.some((x) => x.id === `item.${itemOf(name)._id}.use`)).toBe(false);
    }
  });

  it('weapons keep attack and gain no item use action', () => {
    const sword = itemOf('Longsword');
    expect(all.some((x) => x.id === `item.${sword._id}.attack`)).toBe(true);
    expect(all.some((x) => x.id === `item.${sword._id}.use`)).toBe(false);
  });

  it('feature use actions carry no group', () => {
    expect(action(martialCaptured, 'feature.7r63kurEAM3GdEec.use').group).toBeUndefined();
  });

  it('maps item use intents to the use-item endpoint', () => {
    const torch = itemOf('Torch');
    expect(build(martialCaptured, { kind: 'use', actionId: `item.${torch._id}.use` })).toEqual({
      endpoint: 'use-item',
      itemId: torch._id,
      noTemplate: true,
    });
  });

  it('still maps feature use intents to use-feature (non-heal features are unaffected by M15)', () => {
    // Second Wind is heal-type and now maps to roll-and-heal (see the M15
    // 'buildAction — heal formulas & self-heal write-through' describe
    // block) — clone it with a non-heal activity type to keep covering the
    // plain use-feature fallback path.
    const nonHeal: FoundryActorDoc = {
      ...martialCaptured,
      items: (martialCaptured.items ?? []).map((i) => {
        if (i._id !== '7r63kurEAM3GdEec') return i;
        const system = i.system as Record<string, unknown>;
        const activities = system.activities as Record<string, unknown>;
        const activityId = Object.keys(activities)[0] as string;
        const activity = activities[activityId] as Record<string, unknown>;
        return {
          ...i,
          system: { ...system, activities: { ...activities, [activityId]: { ...activity, type: 'utility' } } },
        };
      }),
    };
    expect(build(nonHeal, { kind: 'use', actionId: 'feature.7r63kurEAM3GdEec.use' })).toEqual({
      endpoint: 'use-feature',
      itemId: '7r63kurEAM3GdEec',
    });
  });

  it('inventory rows carry no primary actionId (manage-only)', () => {
    const inv = section(martialCaptured, 'inventory');
    if (inv.kind !== 'list') throw new Error('inventory must be a list section');
    for (const row of inv.items) expect(row.actionId).toBeUndefined();
  });
});

describe('spellbook management', () => {
  const all = actions(casterCaptured);
  // caster-captured spells: Guiding Bolt pZMrJb3AXiRYO5E8 (L1, prepared: 1),
  // Bless m6cRE9Skgcx1Rhcf (L1, prepared: 2 = always), Sacred Flame
  // P97npemu7j70IZAQ (L0 cantrip), Bane (L1, prepared: 0).
  const spellOf = (name: string) => {
    const item = casterCaptured.items?.find((i) => i.type === 'spell' && i.name === name);
    if (!item) throw new Error(`spell ${name} not found`);
    return item;
  };

  it('offers a prepare toggle for leveled, not-always-prepared spells', () => {
    const bolt = spellOf('Guiding Bolt');
    expect(action(casterCaptured, `spell.${bolt._id}.prepare`)).toEqual({
      id: `spell.${bolt._id}.prepare`,
      label: 'Guiding Bolt',
      kind: 'prepare',
      prepared: true,
    });
    const bane = spellOf('Bane');
    expect(action(casterCaptured, `spell.${bane._id}.prepare`).prepared).toBe(false);
  });

  it('offers no prepare toggle for cantrips or always-prepared spells', () => {
    const cantrip = spellOf('Sacred Flame');
    expect(all.some((a) => a.id === `spell.${cantrip._id}.prepare`)).toBe(false);
    const always = spellOf('Bless');
    expect(all.some((a) => a.id === `spell.${always._id}.prepare`)).toBe(false);
  });

  it('maps prepare intents to an update-item write on system.prepared', () => {
    const bane = spellOf('Bane');
    expect(build(casterCaptured, { kind: 'prepare', actionId: `spell.${bane._id}.prepare`, prepared: true })).toEqual({
      endpoint: 'update-item',
      itemId: bane._id,
      data: { 'system.prepared': 1 },
    });
    expect(
      build(casterCaptured, { kind: 'prepare', actionId: `spell.${bane._id}.prepare`, prepared: false }),
    ).toEqual({ endpoint: 'update-item', itemId: bane._id, data: { 'system.prepared': 0 } });
  });

  it('spell rows carry toggleActionId and are removable from the spells collection; the sheet lists library collections', () => {
    const spells = { items: spellRows(casterCaptured) };
    const bolt = spellOf('Guiding Bolt');
    const row = spells.items.find((r) => r.id === bolt._id);
    expect(row?.toggleActionId).toBe(`spell.${bolt._id}.prepare`);
    expect(row?.removable).toBe('spells');
    const cantripRow = spells.items.find((r) => r.id === spellOf('Sacred Flame')._id);
    expect(cantripRow?.toggleActionId).toBeUndefined();
    expect(cantripRow?.removable).toBe('spells');
    expect(dnd5eAdapter.toViewModel(casterCaptured).library).toEqual([
      { id: 'spells', label: 'Learn spell' },
      { id: 'feats', label: 'Add feat' },
      { id: 'gear', label: 'Add item' },
    ]);
  });

  it('feature and inventory rows carry their removable collection id', () => {
    const features = section(casterCaptured, 'features');
    if (features.kind !== 'list') throw new Error('features must be a list section');
    for (const row of features.items) expect(row.removable).toBe('feats');
    const inventory = section(casterCaptured, 'inventory');
    if (inventory.kind !== 'list') throw new Error('inventory must be a list section');
    for (const row of inventory.items) expect(row.removable).toBe('gear');
  });

  it('exposes spells / feats / gear library collections', () => {
    const lib = dnd5eAdapter.library;
    if (!lib) throw new Error('adapter must expose library');
    expect(lib.map((c) => c.id)).toEqual(['spells', 'feats', 'gear']);
    expect(lib.map((c) => c.label)).toEqual(['Learn spell', 'Add feat', 'Add item']);

    const byId = (id: string) => {
      const c = lib.find((x) => x.id === id);
      if (!c) throw new Error(`collection ${id} missing`);
      return c;
    };

    const spells = byId('spells');
    expect(spells.searchFilter).toBe('documentType:Item,subType:spell');
    expect(spells.canAdd({ type: 'spell' })).toBe(true);
    expect(spells.canAdd({ type: 'weapon' })).toBe(false);
    expect(spells.canRemove(spellOf('Bane'))).toBe(true);
    const nonSpell = casterCaptured.items?.find((i) => i.type !== 'spell');
    if (!nonSpell) throw new Error('need a non-spell item');
    expect(spells.canRemove(nonSpell)).toBe(false);

    const feats = byId('feats');
    expect(feats.searchFilter).toBe('documentType:Item,subType:feat');
    expect(feats.canAdd({ type: 'feat' })).toBe(true);
    expect(feats.canAdd({ type: 'spell' })).toBe(false);
    const feat = casterCaptured.items?.find((i) => i.type === 'feat');
    if (!feat) throw new Error('need a feat item');
    expect(feats.canRemove(feat)).toBe(true);
    expect(feats.canRemove(spellOf('Bane'))).toBe(false);

    const gear = byId('gear');
    expect(gear.searchFilter).toBe('documentType:Item');
    expect(gear.canAdd({ type: 'weapon' })).toBe(true);
    expect(gear.canAdd({ type: 'equipment' })).toBe(true);
    expect(gear.canAdd({ type: 'spell' })).toBe(false);
    expect(gear.canAdd({ type: 'feat' })).toBe(false);
    const weapon = casterCaptured.items?.find((i) => i.type === 'weapon');
    if (!weapon) throw new Error('need a weapon item');
    expect(gear.canRemove(weapon)).toBe(true);
    expect(gear.canRemove(spellOf('Bane'))).toBe(false);
  });

  it('spells collection describe renders a preview ListItem from a raw compendium doc', () => {
    const spells = dnd5eAdapter.library?.find((c) => c.id === 'spells');
    if (!spells) throw new Error('adapter must expose spells collection');
    const li = spells.describe({
      _id: 'x1',
      name: 'Fireball',
      type: 'spell',
      img: 'icons/f.webp',
      system: { level: 3, school: 'evo', description: { value: '<p>Boom</p>' } },
    });
    expect(li).toMatchObject({ id: 'x1', label: 'Fireball', img: 'icons/f.webp', detail: '<p>Boom</p>' });
    expect(li.sub).toContain('3rd level');
    expect(li.sub).toContain('Evocation');
    const cantrip = spells.describe({ _id: 'x2', name: 'Light', type: 'spell', system: { level: 0 } });
    expect(cantrip.sub).toContain('Cantrip');
  });

  it('feats collection describe renders type label and detail', () => {
    const feats = dnd5eAdapter.library?.find((c) => c.id === 'feats');
    if (!feats) throw new Error('adapter must expose feats collection');
    const classFeat = feats.describe({
      _id: 'f1',
      name: 'Second Wind',
      type: 'feat',
      img: 'icons/w.webp',
      system: { type: { value: 'class' }, description: { value: '<p>Heal</p>' } },
    });
    expect(classFeat).toMatchObject({ id: 'f1', label: 'Second Wind', sub: 'Class feature', img: 'icons/w.webp', detail: '<p>Heal</p>' });
    const plainFeat = feats.describe({ _id: 'f2', name: 'Grappler', type: 'feat', system: {} });
    expect(plainFeat.sub).toBe('Feat');
  });

  it('gear collection describe renders item type and detail', () => {
    const gear = dnd5eAdapter.library?.find((c) => c.id === 'gear');
    if (!gear) throw new Error('adapter must expose gear collection');
    const li = gear.describe({
      _id: 'g1',
      name: 'Potion of Healing',
      type: 'consumable',
      img: 'icons/p.webp',
      system: { description: { value: '<p>Drink</p>' } },
    });
    expect(li).toMatchObject({ id: 'g1', label: 'Potion of Healing', sub: 'consumable', img: 'icons/p.webp', detail: '<p>Drink</p>' });
  });

  it('rejects prepare intents for spells without a toggle', () => {
    const always = spellOf('Bless');
    expectIntentError(
      () => build(casterCaptured, { kind: 'prepare', actionId: `spell.${always._id}.prepare`, prepared: false }),
      'UNKNOWN_RESOURCE',
    );
  });
});

describe('move', () => {
  const withRealContainment = () => {
    const actor = structuredClone(martialCaptured);
    const items = actor.items as Array<{ _id: string; system: Record<string, unknown> }>;
    // Repair the captured dangling refs into a real containment chain:
    // Rations -> Backpack, Pouch -> Backpack (nested container).
    items.find((i) => i._id === 'ulOW5qzq7q2edJTP')!.system.container = 'wYUZWMKa6FntpIvv';
    items.find((i) => i._id === 'T8BW5LfQIDdur78q')!.system.container = 'wYUZWMKa6FntpIvv';
    return actor;
  };

  it('every physical item gets a move descriptor', () => {
    const ids = dnd5eAdapter.actions!(martialCaptured).filter((a) => a.kind === 'move').map((a) => a.id);
    expect(ids).toContain('item.ulOW5qzq7q2edJTP.move'); // consumable
    expect(ids).toContain('item.wYUZWMKa6FntpIvv.move'); // container itself
    expect(ids).not.toContain('item.7r63kurEAM3GdEec.move'); // Second Wind (feat), not physical
  });

  it('move into a container writes system.container', () => {
    expect(
      build(withRealContainment(), {
        kind: 'move',
        actionId: 'item.ulOW5qzq7q2edJTP.move',
        containerId: 'wYUZWMKa6FntpIvv',
      }),
    ).toEqual({
      endpoint: 'update-item',
      itemId: 'ulOW5qzq7q2edJTP',
      data: { 'system.container': 'wYUZWMKa6FntpIvv' },
    });
  });

  it('move to carried clears the ref with an empty string', () => {
    expect(
      build(withRealContainment(), { kind: 'move', actionId: 'item.ulOW5qzq7q2edJTP.move', containerId: null }),
    ).toEqual({ endpoint: 'update-item', itemId: 'ulOW5qzq7q2edJTP', data: { 'system.container': '' } });
  });

  it('rejects a non-container target', () => {
    expect(() =>
      build(withRealContainment(), {
        kind: 'move',
        actionId: 'item.wYUZWMKa6FntpIvv.move',
        containerId: 'ulOW5qzq7q2edJTP', // Rations: physical but not a container
      }),
    ).toThrow(IntentError);
  });

  it('rejects an unknown target id', () => {
    expect(() =>
      build(withRealContainment(), { kind: 'move', actionId: 'item.ulOW5qzq7q2edJTP.move', containerId: 'nope' }),
    ).toThrow(IntentError);
  });

  it('rejects moving an item into itself', () => {
    expect(() =>
      build(withRealContainment(), {
        kind: 'move',
        actionId: 'item.wYUZWMKa6FntpIvv.move',
        containerId: 'wYUZWMKa6FntpIvv',
      }),
    ).toThrow(IntentError);
  });

  it('rejects moving a container into its own contents (cycle)', () => {
    // Pouch sits inside Backpack; Backpack -> Pouch would be a cycle.
    expect(() =>
      build(withRealContainment(), {
        kind: 'move',
        actionId: 'item.wYUZWMKa6FntpIvv.move',
        containerId: 'T8BW5LfQIDdur78q',
      }),
    ).toThrow(IntentError);
  });
});

describe('buildAction — critical damage (nat 20 doubles the dice)', () => {
  it('weapon crit doubles the dice, not the static bonus (Longsword: 2d8 + 3)', () => {
    expect(
      build(martialCaptured, { kind: 'damage', actionId: 'item.gta26ORvqC323k3r.damage', critical: true }),
    ).toEqual({ endpoint: 'roll', formula: '2d8 + 3', flavor: 'Longsword — Critical Damage' });
  });

  it('critical: false and an absent flag both roll the plain formula', () => {
    for (const intent of [
      { kind: 'damage', actionId: 'item.gta26ORvqC323k3r.damage', critical: false },
      { kind: 'damage', actionId: 'item.gta26ORvqC323k3r.damage' },
    ] as const) {
      expect(build(martialCaptured, intent)).toEqual({
        endpoint: 'roll',
        formula: '1d8 + 3',
        flavor: 'Longsword — Damage',
      });
    }
  });

  it('spell crit doubles every dice term (Guiding Bolt: 4d6 -> 8d6)', () => {
    expect(
      build(casterCaptured, { kind: 'damage', actionId: 'spell.pZMrJb3AXiRYO5E8.damage', critical: true }),
    ).toEqual({ endpoint: 'roll', formula: '8d6', flavor: 'Guiding Bolt — Critical Damage' });
  });

  it('a non-boolean critical flag is rejected as INVALID', () => {
    expectIntentError(
      () =>
        build(martialCaptured, {
          kind: 'damage',
          actionId: 'item.gta26ORvqC323k3r.damage',
          critical: 'yes',
        } as unknown as ActionIntent),
      'INVALID',
    );
  });
});

describe('display formula scaling (upcast + cantrip tiers)', () => {
  it('Guiding Bolt at 3rd rolls 6d6 (base 4d6, whole-mode +1 die/level)', () => {
    expect(build(casterCaptured, { kind: 'damage', actionId: 'spell.pZMrJb3AXiRYO5E8.damage', slotLevel: 3 })).toEqual({
      endpoint: 'roll',
      formula: '6d6',
      flavor: 'Guiding Bolt — Damage',
    });
  });

  it('crit doubles the SCALED dice (Guiding Bolt at 3rd, crit: 12d6)', () => {
    expect(
      build(casterCaptured, { kind: 'damage', actionId: 'spell.pZMrJb3AXiRYO5E8.damage', slotLevel: 3, critical: true }),
    ).toEqual({ endpoint: 'roll', formula: '12d6', flavor: 'Guiding Bolt — Critical Damage' });
  });

  it('cantrip damage scales with character level (Akra is level 5: Sacred Flame 2d8)', () => {
    expect(build(casterCaptured, { kind: 'damage', actionId: 'spell.P97npemu7j70IZAQ.damage' })).toEqual({
      endpoint: 'roll',
      formula: '2d8',
      flavor: 'Sacred Flame — Damage',
    });
  });

  it('a slotLevel below base or out of range is INVALID', () => {
    expectIntentError(
      () => build(casterCaptured, { kind: 'damage', actionId: 'spell.pZMrJb3AXiRYO5E8.damage', slotLevel: 0 }),
      'INVALID',
    );
  });

  it('an in-range slotLevel still below the spell\'s own base level is INVALID', () => {
    // slotLevel 0 above is rejected by the integer/1-9 range check alone —
    // it never reaches the spell-specific "< baseLevel" branch. Raise
    // Guiding Bolt's base level to 2 so slotLevel 1 (a valid 1-9 integer)
    // exercises that branch instead.
    const actor = structuredClone(casterCaptured);
    const items = actor.items as Array<{ _id: string; system: Record<string, unknown> }>;
    items.find((i) => i._id === 'pZMrJb3AXiRYO5E8')!.system.level = 2;
    expectIntentError(
      () => build(actor, { kind: 'damage', actionId: 'spell.pZMrJb3AXiRYO5E8.damage', slotLevel: 1 }),
      'INVALID',
    );
  });

  it('upcast heal formula scales (Cure Wounds at 2nd: 2d8 + 2)', () => {
    const a = build(casterCaptured, { kind: 'cast', actionId: 'spell.LjT1wf4D38c9Ieuo.cast', slotLevel: 2 });
    if (a.endpoint !== 'use-and-roll') throw new Error('expected use-and-roll');
    expect(a.formula).toBe('2d8 + 2');
  });

  it('weapon damage is untouched by slotLevel (weapons have no cast level)', () => {
    expect(formulaOf(martialCaptured, { kind: 'damage', actionId: 'item.gta26ORvqC323k3r.damage' })).toBe('1d8 + 3');
  });

  it("SHOULD-FIX 1: a scaling part with no explicit `number` adds no dice per step (dnd5e's own `?? 0` fallback)", () => {
    const actor = warlock({ value: 0 }, [
      {
        _id: 'spellNoScaleNum1',
        name: 'Test Bolt',
        type: 'spell',
        system: {
          level: 1,
          school: 'evo',
          prepared: 1,
          method: 'spell',
          activities: {
            a1: {
              _id: 'a1',
              type: 'attack',
              damage: {
                parts: [{ number: 4, denomination: 6, bonus: '', types: ['fire'], scaling: { mode: 'whole' } }],
              },
            },
          },
        },
      },
    ]);
    expect(build(actor, { kind: 'damage', actionId: 'spell.spellNoScaleNum1.damage', slotLevel: 2 })).toEqual({
      endpoint: 'roll',
      formula: '4d6',
      flavor: 'Test Bolt — Damage',
    });
  });

  it('SHOULD-FIX 2a: mode "half" scaling floors the extra dice (Math.floor) at +2 and +3 levels', () => {
    const actor = warlock({ value: 0 }, [
      {
        _id: 'spellHalfScale01',
        name: 'Half Scaler',
        type: 'spell',
        system: {
          level: 1,
          school: 'evo',
          prepared: 1,
          method: 'spell',
          activities: {
            a1: {
              _id: 'a1',
              type: 'attack',
              damage: {
                parts: [{ number: 4, denomination: 6, bonus: '', types: ['fire'], scaling: { mode: 'half', number: 1 } }],
              },
            },
          },
        },
      },
    ]);
    // +2 levels -> floor(2/2)=1 extra die; +3 levels -> floor(3/2)=1 extra die.
    expect(build(actor, { kind: 'damage', actionId: 'spell.spellHalfScale01.damage', slotLevel: 3 })).toEqual({
      endpoint: 'roll',
      formula: '5d6',
      flavor: 'Half Scaler — Damage',
    });
    expect(build(actor, { kind: 'damage', actionId: 'spell.spellHalfScale01.damage', slotLevel: 4 })).toEqual({
      endpoint: 'roll',
      formula: '5d6',
      flavor: 'Half Scaler — Damage',
    });
  });

  it('SHOULD-FIX 2b: an unknown scaling mode keeps the base dice count', () => {
    const actor = warlock({ value: 0 }, [
      {
        _id: 'spellUnknownScale',
        name: 'Odd Scaler',
        type: 'spell',
        system: {
          level: 1,
          school: 'evo',
          prepared: 1,
          method: 'spell',
          activities: {
            a1: {
              _id: 'a1',
              type: 'attack',
              damage: {
                parts: [{ number: 4, denomination: 6, bonus: '', types: ['fire'], scaling: { mode: 'other', number: 1 } }],
              },
            },
          },
        },
      },
    ]);
    expect(build(actor, { kind: 'damage', actionId: 'spell.spellUnknownScale.damage', slotLevel: 3 })).toEqual({
      endpoint: 'roll',
      formula: '4d6',
      flavor: 'Odd Scaler — Damage',
    });
  });

  it('SHOULD-FIX 2c: cantrip damage tiers step at character level 4 (base), 11 (+2 steps: 3 dice), 17 (+3 steps: 4 dice)', () => {
    const cantripActor = (level: number): FoundryActorDoc => {
      const actor = warlock({ value: 0 }, [
        {
          _id: 'spellCantrip0001',
          name: 'Test Cantrip',
          type: 'spell',
          system: {
            level: 0,
            school: 'evo',
            prepared: 1,
            method: 'spell',
            activities: {
              a1: {
                _id: 'a1',
                type: 'attack',
                damage: {
                  parts: [{ number: 1, denomination: 8, bonus: '', types: ['fire'], scaling: { mode: 'whole', number: 1 } }],
                },
              },
            },
          },
        },
      ]);
      // `details.level` (when present) wins over summing class items —
      // set it directly so the tier boundaries below are exact.
      (actor.system as Record<string, unknown>).details = { level };
      return actor;
    };
    expect(
      build(cantripActor(4), { kind: 'damage', actionId: 'spell.spellCantrip0001.damage' }),
    ).toEqual({ endpoint: 'roll', formula: '1d8', flavor: 'Test Cantrip — Damage' });
    expect(
      build(cantripActor(11), { kind: 'damage', actionId: 'spell.spellCantrip0001.damage' }),
    ).toEqual({ endpoint: 'roll', formula: '3d8', flavor: 'Test Cantrip — Damage' });
    expect(
      build(cantripActor(17), { kind: 'damage', actionId: 'spell.spellCantrip0001.damage' }),
    ).toEqual({ endpoint: 'roll', formula: '4d8', flavor: 'Test Cantrip — Damage' });
  });
});

describe('pact magic (warlock) — slots display and castability', () => {
  it('enriched pact slots (value/max/level) make base-level spells castable', () => {
    const actor = warlock({ value: 2, max: 2, level: 4 });
    expect(action(actor, 'spell.spellHex00000001.cast').slotLevels).toBeUndefined();
    expect(action(actor, 'spell.spellBanish00001.cast').slotLevels).toBeUndefined();
    expect(build(actor, { kind: 'cast', actionId: 'spell.spellHex00000001.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: 'spellHex00000001',
    });
  });

  it('a spell above the pact-slot level is disabled', () => {
    const actor = warlock({ value: 2, max: 2, level: 3 });
    expect(action(actor, 'spell.spellHex00000001.cast').slotLevels).toBeUndefined();
    expect(action(actor, 'spell.spellBanish00001.cast').slotLevels).toEqual([]);
    expectIntentError(
      () => build(actor, { kind: 'cast', actionId: 'spell.spellBanish00001.cast' }),
      'INVALID',
    );
  });

  it('source-only pact data (no derived level — enrich failed) stays castable and defers to Foundry', () => {
    // The relay's plain /get serializes pact as {value, override} only. If
    // enrich cannot supply the derived level, the sheet must not lock the
    // warlock out of casting — Foundry owns the rules and refuses illegal
    // casts itself.
    const actor = warlock({ value: 1, override: null });
    expect(action(actor, 'spell.spellHex00000001.cast').slotLevels).toBeUndefined();
    expect(action(actor, 'spell.spellBanish00001.cast').slotLevels).toBeUndefined();
  });

  it('no pact slots remaining disables leveled spells', () => {
    const actor = warlock({ value: 0, max: 2, level: 4 });
    expect(action(actor, 'spell.spellHex00000001.cast').slotLevels).toEqual([]);
  });

  it('pact-method damage spell display roll scales to the pact slot level with no explicit slotLevel (base 1 -> pact 3 = 2 steps: 4d6 -> 6d6)', () => {
    const actor = warlock(
      { value: 2, max: 2, level: 3 },
      [
        {
          _id: 'spellPactDmg001',
          name: 'Eldritch Blast',
          type: 'spell',
          system: {
            level: 1,
            school: 'evo',
            prepared: 1,
            method: 'pact',
            activities: {
              dnd5eactivity001: {
                _id: 'dnd5eactivity001',
                type: 'attack',
                damage: {
                  parts: [
                    { number: 4, denomination: 6, bonus: '', types: ['force'], scaling: { mode: 'whole', number: 1, formula: '' } },
                  ],
                },
              },
            },
          },
        },
      ],
    );
    expect(build(actor, { kind: 'damage', actionId: 'spell.spellPactDmg001.damage' })).toEqual({
      endpoint: 'roll',
      formula: '6d6',
      flavor: 'Eldritch Blast — Damage',
    });
  });

  it('enrich merges pact value/max/level from the relay spells detail (imported-warlock regression)', async () => {
    if (!dnd5eAdapter.enrich) throw new Error('adapter must expose enrich()');
    // Source data: pact spent (value 0), no max, no level — exactly what the
    // relay's plain /get serializes. The dnd5e detail endpoint returns the
    // derived slots; after the merge the pact row exists AND casting works.
    const source = warlock({ value: 0, override: null });
    const enriched = await dnd5eAdapter.enrich(source, {
      getSystemDetails: async () => ({
        spellSlots: { pact: { value: 2, max: 2, level: 4 } },
      }),
    });
    expect(dnd5eAdapter.resources(enriched).find((r) => r.id === 'slots.pact')).toMatchObject({
      value: 2,
      min: 0,
      max: 2,
      writable: true,
    });
    expect(action(enriched, 'spell.spellHex00000001.cast').slotLevels).toBeUndefined();
    expect(action(enriched, 'spell.spellBanish00001.cast').slotLevels).toBeUndefined();
  });
});

describe('slotLevels — payable levels for the upcast picker', () => {
  it('a leveled spell lists every payable level from base up (Guiding Bolt: slots at 1/2/3 all non-empty)', () => {
    // caster-captured has spell1.value=2, spell2.value=2, spell3.value=1.
    expect(action(casterCaptured, 'spell.pZMrJb3AXiRYO5E8.cast').slotLevels).toEqual([1, 2, 3]);
  });

  it('drained base level drops out of the list but higher levels remain', async () => {
    if (!dnd5eAdapter.enrich) throw new Error('adapter must expose enrich()');
    const drained = await dnd5eAdapter.enrich(casterCaptured, {
      getSystemDetails: async () => ({
        spellSlots: { spell1: { value: 0, max: 4 }, spell2: { value: 2, max: 3 }, spell3: { value: 1, max: 1 } },
      }),
    });
    expect(action(drained, 'spell.pZMrJb3AXiRYO5E8.cast').slotLevels).toEqual([2, 3]);
  });

  it('cantrips still carry no slotLevels', () => {
    expect(action(casterCaptured, 'spell.P97npemu7j70IZAQ.cast').slotLevels).toBeUndefined();
  });

  it('SHOULD-FIX 3: draining one step further (spell2 -> 0 too) leaves a length-1 [3] list (PWA direct-cast contract)', async () => {
    if (!dnd5eAdapter.enrich) throw new Error('adapter must expose enrich()');
    const drained = await dnd5eAdapter.enrich(casterCaptured, {
      getSystemDetails: async () => ({
        spellSlots: { spell1: { value: 0, max: 4 }, spell2: { value: 0, max: 3 }, spell3: { value: 1, max: 1 } },
      }),
    });
    expect(action(drained, 'spell.pZMrJb3AXiRYO5E8.cast').slotLevels).toEqual([3]);
  });

  it('SHOULD-FIX 4: an omitted slotLevel on the drained fixture ([2,3]) is INVALID, not a silent default', async () => {
    if (!dnd5eAdapter.enrich) throw new Error('adapter must expose enrich()');
    const drained = await dnd5eAdapter.enrich(casterCaptured, {
      getSystemDetails: async () => ({
        spellSlots: { spell1: { value: 0, max: 4 }, spell2: { value: 2, max: 3 }, spell3: { value: 1, max: 1 } },
      }),
    });
    expectIntentError(() => build(drained, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast' }), 'INVALID');
  });

  it('pact-only casting stays pickerless (slotLevels absent)', () => {
    const actor = warlock({ value: 2, max: 2, level: 4 });
    expect(action(actor, 'spell.spellHex00000001.cast').slotLevels).toBeUndefined();
  });

  it('nothing payable at all -> [] (disabled)', () => {
    const actor = warlock({ value: 0, max: 2, level: 4 });
    expect(action(actor, 'spell.spellHex00000001.cast').slotLevels).toEqual([]);
  });
});

describe('MF-3: multiclass warlock — a true method:"pact" spell stays pickerless', () => {
  // A genuine pact-method spell (unlike Hex/Banishment above, which are
  // method:'spell' items only reachable via the pact fallback in
  // canCastAtBase) — dnd5e auto-casts these at pact level; spellN pools
  // must never pay for them or open the upcast picker (spec 2026-07-19,
  // design.md:36-45).
  const pactSpell = {
    _id: 'spellPactCast0001',
    name: 'Eldritch Blast',
    type: 'spell',
    system: { level: 1, school: 'evo', prepared: 1, method: 'pact', activities: {} },
  } as const;

  it('has slotLevels undefined (pickerless) even with payable spellN pools (pact-base-payable + higher-real-slot corner)', () => {
    const actor = warlock({ value: 2, max: 2, level: 4 }, [pactSpell]);
    // Multiclass wizard-side slots at the pact spell's own base level (1)
    // AND one level up — under the pre-fix code these made payableSlotLevels
    // non-empty and wrongly opened the picker for a pact-only spell.
    const spells = (actor.system as Record<string, unknown>).spells as Record<string, unknown>;
    spells.spell1 = { value: 2, max: 2 };
    spells.spell2 = { value: 1, max: 1 };
    expect(action(actor, 'spell.spellPactCast0001.cast').slotLevels).toBeUndefined();
  });

  it('with pact drained (pact.value = 0) gets slotLevels: [] (disabled), never the spellN picker', () => {
    const actor = warlock({ value: 0, max: 2, level: 4 }, [pactSpell]);
    expect(action(actor, 'spell.spellPactCast0001.cast').slotLevels).toEqual([]);
  });
});

describe('buildAction — self-buff spells apply their active effect', () => {
  // A minimal Shield-shaped spell: level 1, an item Active Effect applied on
  // use (transfer:false) that adds +5 to ac.bonus. Cast at self.
  function withShield(base = casterCaptured): FoundryActorDoc {
    const actor = structuredClone(base);
    (actor.items as FoundryItemDoc[]).push({
      _id: 'spellShield0001',
      name: 'Shield',
      type: 'spell',
      system: {
        level: 1,
        school: 'abj',
        prepared: 1,
        method: 'spell',
        activities: { a1: { type: 'utility' } },
      },
      effects: [
        {
          _id: 'aeShield00000001',
          name: 'Shield',
          img: 'icons/svg/shield.svg',
          transfer: false,
          // Matches real dnd5e 5.3.3 data: activity-applied source effects
          // are stored disabled:true on the spell itself (MF-1) — the copy
          // selfBuffEffect builds is created enabled regardless.
          disabled: true,
          duration: { seconds: 6 },
          changes: [{ key: 'system.attributes.ac.bonus', mode: 2, value: '+5' }],
        },
      ],
    } as unknown as FoundryItemDoc);
    return actor;
  }

  it('a leveled self-buff cast at base -> cast-and-apply-effect via use-spell, effect copied verbatim', () => {
    const actor = withShield();
    expect(build(actor, { kind: 'cast', actionId: 'spell.spellShield0001.cast', slotLevel: 1 })).toEqual({
      endpoint: 'cast-and-apply-effect',
      use: 'use-spell',
      itemId: 'spellShield0001',
      effect: {
        name: 'Shield',
        img: 'icons/svg/shield.svg',
        changes: [{ key: 'system.attributes.ac.bonus', mode: 2, value: '+5' }],
        duration: { seconds: 6 },
        origin: 'Actor.pTvtx5dm2AuYqeX2.Item.spellShield0001',
      },
    });
  });

  it('the same spell upcast -> cast-and-apply-effect via cast-at-slot', () => {
    // caster-captured has spell2.value>0; casting Shield (base 1) at 2 upcasts.
    const a = build(withShield(), { kind: 'cast', actionId: 'spell.spellShield0001.cast', slotLevel: 2 });
    expect(a).toMatchObject({ endpoint: 'cast-and-apply-effect', use: 'cast-at-slot', slotKey: 'spell2', itemId: 'spellShield0001' });
  });

  it('a spell with no use-applied effect is unaffected (Guiding Bolt still use-spell)', () => {
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: 'pZMrJb3AXiRYO5E8',
    });
  });

  it('a transfer:true (passive) item effect does NOT count as a castable buff', () => {
    const actor = withShield();
    const shield = (actor.items as FoundryItemDoc[]).find((i) => i._id === 'spellShield0001')!;
    (shield.effects as Array<Record<string, unknown>>)[0]!.transfer = true;
    expect(build(actor, { kind: 'cast', actionId: 'spell.spellShield0001.cast', slotLevel: 1 })).toEqual({
      endpoint: 'use-spell',
      itemId: 'spellShield0001',
    });
  });

  it('MF-1: a real disabled:true source effect (Shield of Faith, live-captured) still applies as a buff', () => {
    // Shield of Faith is unprepared (prepared:0) in the capture — prepare it
    // in a clone to reach the cast path (same technique as the Bane
    // effectType test above). Real _id verified against the fixture:
    // d56v9vczAXEgMhCY (NOT hQ1zxREvUlaNKQpz, which is Sanctuary's id —
    // the fixlist's item id was wrong).
    const prepared: FoundryActorDoc = {
      ...casterCaptured,
      items: (casterCaptured.items ?? []).map((i) =>
        i._id === 'd56v9vczAXEgMhCY'
          ? { ...i, system: { ...(i.system as Record<string, unknown>), prepared: 1 } }
          : i,
      ),
    };
    expect(build(prepared, { kind: 'cast', actionId: 'spell.d56v9vczAXEgMhCY.cast' })).toMatchObject({
      endpoint: 'cast-and-apply-effect',
      use: 'use-spell',
      itemId: 'd56v9vczAXEgMhCY',
      effect: {
        name: 'Shield of Faith',
        changes: [{ key: 'system.attributes.ac.bonus', mode: 2, value: '2' }],
        origin: 'Actor.pTvtx5dm2AuYqeX2.Item.d56v9vczAXEgMhCY',
      },
    });
  });

  it('MF-2: a save-gated activity (synthetic) never qualifies as a self-buff', () => {
    const actor = withShield();
    const shield = (actor.items as FoundryItemDoc[]).find((i) => i._id === 'spellShield0001')!;
    (shield.system as Record<string, unknown>).activities = {
      a1: { type: 'utility' },
      a2: { type: 'save' },
    };
    expect(build(actor, { kind: 'cast', actionId: 'spell.spellShield0001.cast', slotLevel: 1 })).toEqual({
      endpoint: 'use-spell',
      itemId: 'spellShield0001',
    });
  });

  it('MF-2: Bane (real save-gated debuff, live-captured) never applies its penalties to the caster', () => {
    const prepared: FoundryActorDoc = {
      ...casterCaptured,
      items: (casterCaptured.items ?? []).map((i) =>
        i._id === '9FrgmKwWCYPhlZ5w'
          ? { ...i, system: { ...(i.system as Record<string, unknown>), prepared: 1 } }
          : i,
      ),
    };
    expect(build(prepared, { kind: 'cast', actionId: 'spell.9FrgmKwWCYPhlZ5w.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: '9FrgmKwWCYPhlZ5w',
    });
  });
});

describe('target buffs — targetable flag + targetActorId', () => {
  // Bless-shaped: utility activity, effect applied on use (transfer:false),
  // NO target.affects.type:'self' → creature-targetable.
  function withBless(base = casterCaptured): FoundryActorDoc {
    const actor = structuredClone(base);
    (actor.items as FoundryItemDoc[]).push({
      _id: 'spellBless000001', name: 'Bless', type: 'spell',
      system: {
        level: 1, school: 'enc', prepared: 1, method: 'spell',
        activities: { a1: { type: 'utility', target: { affects: {} } } },
      },
      effects: [{ _id: 'aeBless000000001', name: 'Bless', transfer: false, disabled: false,
        changes: [{ key: 'system.bonuses.abilities.save', mode: 2, value: '+1d4' }] }],
    } as unknown as FoundryItemDoc);
    return actor;
  }
  // Shield-shaped: activity target.affects.type:'self' → self-only, NOT targetable.
  function withShieldSelf(base = casterCaptured): FoundryActorDoc {
    const actor = structuredClone(base);
    (actor.items as FoundryItemDoc[]).push({
      _id: 'spellShieldS0001', name: 'Shield', type: 'spell',
      system: {
        level: 1, school: 'abj', prepared: 1, method: 'spell',
        activities: { a1: { type: 'utility', target: { affects: { type: 'self' } } } },
      },
      effects: [{ _id: 'aeShieldS0000001', name: 'Shield', transfer: false, disabled: false,
        changes: [{ key: 'system.attributes.ac.bonus', mode: 2, value: '+5' }] }],
    } as unknown as FoundryItemDoc);
    return actor;
  }

  it('a creature-targetable buff cast descriptor is flagged targetable', () => {
    expect(action(withBless(), 'spell.spellBless000001.cast').targetable).toBe(true);
  });

  it('a self-only buff (Shield) is NOT targetable', () => {
    expect(action(withShieldSelf(), 'spell.spellShieldS0001.cast').targetable).toBeUndefined();
  });

  it('a non-buff spell is NOT targetable (Guiding Bolt)', () => {
    expect(action(casterCaptured, 'spell.pZMrJb3AXiRYO5E8.cast').targetable).toBeUndefined();
  });

  it('cast with targetActorId threads it into cast-and-apply-effect', () => {
    expect(build(withBless(), { kind: 'cast', actionId: 'spell.spellBless000001.cast', slotLevel: 1, targetActorId: 'TARGETACTOR00001' })).toEqual({
      endpoint: 'cast-and-apply-effect',
      use: 'use-spell',
      itemId: 'spellBless000001',
      effect: {
        name: 'Bless',
        changes: [{ key: 'system.bonuses.abilities.save', mode: 2, value: '+1d4' }],
        origin: 'Actor.pTvtx5dm2AuYqeX2.Item.spellBless000001',
      },
      targetActorId: 'TARGETACTOR00001',
    });
  });

  it('cast without targetActorId omits it (self-apply, unchanged)', () => {
    const a = build(withBless(), { kind: 'cast', actionId: 'spell.spellBless000001.cast', slotLevel: 1 });
    if (a.endpoint !== 'cast-and-apply-effect') throw new Error('expected cast-and-apply-effect');
    expect(a.targetActorId).toBeUndefined();
  });

  it('a self-only buff ignores a crafted targetActorId (server enforcement)', () => {
    const a = build(withShieldSelf(), { kind: 'cast', actionId: 'spell.spellShieldS0001.cast', slotLevel: 1, targetActorId: 'TARGETACTOR00001' });
    if (a.endpoint !== 'cast-and-apply-effect') throw new Error('expected cast-and-apply-effect');
    expect(a.targetActorId).toBeUndefined();
  });
});

describe('app-applied effects are removable', () => {
  function withAppliedShield(): FoundryActorDoc {
    const actor = structuredClone(casterCaptured);
    (actor as unknown as { effects: unknown[] }).effects = [
      {
        _id: 'aeApplied0000001',
        name: 'Shield',
        icon: 'icons/svg/shield.svg',
        disabled: false,
        flags: { 'unseen-servent': { appliedBy: 'app' } },
      },
    ];
    return actor;
  }

  it('parseEffects marks the flagged effect with a removeActionId (still a badge)', () => {
    const vm = dnd5eAdapter.toViewModel(withAppliedShield());
    const shield = (vm.conditions ?? []).find((c) => c.label === 'Shield');
    expect(shield?.removeActionId).toBe('effect.aeApplied0000001.remove');
  });

  it('a GM/system effect (no flag) is a plain badge with no removeActionId', () => {
    const actor = structuredClone(casterCaptured);
    (actor as unknown as { effects: unknown[] }).effects = [
      { _id: 'aePoison00000001', name: 'Poisoned', disabled: false },
    ];
    const vm = dnd5eAdapter.toViewModel(actor);
    expect((vm.conditions ?? []).find((c) => c.label === 'Poisoned')?.removeActionId).toBeUndefined();
  });

  it('buildActions emits an endeffect action for the applied effect', () => {
    const actor = withAppliedShield();
    const a = actions(actor).find((x) => x.id === 'effect.aeApplied0000001.remove');
    expect(a).toEqual({ id: 'effect.aeApplied0000001.remove', kind: 'endeffect', label: 'End Shield' });
  });

  it('endeffect intent -> remove-effect with the effect id', () => {
    expect(build(withAppliedShield(), { kind: 'endeffect', actionId: 'effect.aeApplied0000001.remove' })).toEqual({
      endpoint: 'remove-effect',
      effectId: 'aeApplied0000001',
    });
  });
});

describe('template-bearing items set noTemplate (M-daylight, 2026-07-20)', () => {
  /** Minimal caster with one leveled utility spell; `template` toggles the
   *  activity's area template (Daylight's live shape: sphere/60). */
  const templateCaster = (template: boolean) => ({
    _id: 'actorTemplate001',
    name: 'Template Caster',
    type: 'character',
    system: {
      attributes: { hp: { value: 20, max: 20 } },
      spells: { spell3: { value: 2, max: 3 }, spell4: { value: 1, max: 1 } },
    },
    items: [
      {
        _id: 'spellDaylight001',
        name: 'Daylight',
        type: 'spell',
        system: {
          level: 3,
          school: 'evo',
          prepared: 1,
          method: 'spell',
          activities: {
            a1: {
              _id: 'a1',
              type: 'utility',
              ...(template ? { target: { template: { type: 'sphere', size: 60 } } } : {}),
            },
          },
        },
      },
    ],
  });

  it('base-level cast of a template spell -> use-spell + noTemplate', () => {
    expect(build(templateCaster(true), { kind: 'cast', actionId: 'spell.spellDaylight001.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: 'spellDaylight001',
      noTemplate: true,
    });
  });

  it('base-level cast of a non-template spell carries NO flag (unchanged wire shape)', () => {
    expect(build(templateCaster(false), { kind: 'cast', actionId: 'spell.spellDaylight001.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: 'spellDaylight001',
    });
  });

  it('a spell whose activity inherits the ITEM-level template (override:false source shape, live Daylight capture) is flagged', () => {
    const actor = templateCaster(false); // activity has no template of its own
    const item = actor.items[0]!;
    (item.system.activities as Record<string, Record<string, unknown>>).a1 = {
      _id: 'a1',
      type: 'utility',
      // Live source capture: no template.type on the activity; it inherits.
      target: {
        template: { contiguous: false, stationary: false, units: 'ft' },
        affects: { choice: false },
        override: false,
        prompt: true,
      },
    };
    (item.system as Record<string, unknown>).target = {
      affects: { count: '', type: '', choice: false, special: '' },
      template: { count: '', contiguous: false, type: 'sphere', size: '60', width: '', height: '', units: 'ft', stationary: false },
    };
    expect(build(actor, { kind: 'cast', actionId: 'spell.spellDaylight001.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: 'spellDaylight001',
      noTemplate: true,
    });
  });

  it('upcast of a template spell keeps cast-at-slot (no flag needed — castAtSlot suppresses itself)', () => {
    expect(build(templateCaster(true), { kind: 'cast', actionId: 'spell.spellDaylight001.cast', slotLevel: 4 })).toEqual(
      { endpoint: 'cast-at-slot', itemId: 'spellDaylight001', slotKey: 'spell4' },
    );
  });

  it('a template item with damage (Bead of Force shape) -> use-and-roll + noTemplate', () => {
    const actor = {
      _id: 'actorTemplate002',
      name: 'Bead Holder',
      type: 'character',
      system: { attributes: { hp: { value: 20, max: 20 } }, spells: {} },
      items: [
        {
          _id: 'itemBeadForce001',
          name: 'Bead of Force',
          type: 'consumable',
          system: {
            quantity: 1,
            activities: {
              a1: {
                _id: 'a1',
                type: 'save',
                target: { template: { type: 'sphere', size: 10 } },
                damage: { parts: [{ number: 5, denomination: 4, bonus: '', types: ['force'] }] },
              },
            },
          },
        },
      ],
    };
    const a = build(actor, { kind: 'use', actionId: 'item.itemBeadForce001.use' });
    if (a.endpoint !== 'use-and-roll') throw new Error('expected use-and-roll, got ' + a.endpoint);
    expect(a.noTemplate).toBe(true);
    expect(a.use).toBe('use-item');
  });

  it('a template save-spell with damage (Fireball shape): the cast intent carries the flag', () => {
    // Fireball's Cast action is the activation only (damage is the separate
    // spell.<id>.damage action) -> the cast intent must carry the flag.
    const actor = templateCaster(true);
    (actor.items[0]!.system.activities as Record<string, Record<string, unknown>>).a1 = {
      _id: 'a1',
      type: 'save',
      target: { template: { type: 'radius', size: 20 } },
      damage: { parts: [{ number: 8, denomination: 6, bonus: '', types: ['fire'] }] },
    };
    expect(build(actor, { kind: 'cast', actionId: 'spell.spellDaylight001.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: 'spellDaylight001',
      noTemplate: true,
    });
  });

  it('a self-buff template spell threads the flag through cast-and-apply-effect', () => {
    const actor = templateCaster(true);
    const item = actor.items[0]! as unknown as Record<string, unknown>;
    (item.system as Record<string, unknown>).activities = {
      a1: { _id: 'a1', type: 'utility', target: { template: { type: 'radius', size: 10 }, affects: { type: 'self' } } },
    };
    item.effects = [
      { transfer: false, name: 'Buffed', changes: [{ key: 'system.attributes.ac.bonus', mode: 2, value: '2' }] },
    ];
    const a = build(actor, { kind: 'cast', actionId: 'spell.spellDaylight001.cast' });
    if (a.endpoint !== 'cast-and-apply-effect') throw new Error('expected cast-and-apply-effect, got ' + a.endpoint);
    expect(a.noTemplate).toBe(true);
  });

  it('a heal spell with a template threads the flag through use-and-roll', () => {
    const actor = templateCaster(true);
    (actor.items[0]!.system.activities as Record<string, Record<string, unknown>>).a1 = {
      _id: 'a1',
      type: 'heal',
      target: { template: { type: 'radius', size: 30 } },
      healing: { number: 3, denomination: 8, bonus: '', types: ['healing'] },
    };
    const a = build(actor, { kind: 'cast', actionId: 'spell.spellDaylight001.cast' });
    if (a.endpoint !== 'use-and-roll') throw new Error('expected use-and-roll, got ' + a.endpoint);
    expect(a.noTemplate).toBe(true);
  });
});

describe('combat targeting metadata + use-on-targets (2026-07-22)', () => {
  // Real fixture spells cover attack-roll damage (Guiding Bolt, kind
  // 'attack') and save-with-damage (Sacred Flame, kind 'save') but the only
  // natural save-damage spell (Sacred Flame) is a cantrip with no slots to
  // upcast — a synthetic clone of Guiding Bolt with its activity retyped to
  // 'save' covers the slotKey-threading test below (same technique as the
  // finesse-weapon / self-buff synthetic-actor tests elsewhere in this file).
  function withSyntheticSaveSpell(): FoundryActorDoc {
    const guidingBolt = casterCaptured.items?.find((i) => i._id === 'pZMrJb3AXiRYO5E8');
    if (!guidingBolt) throw new Error('fixture missing Guiding Bolt');
    const gbSystem = guidingBolt.system as Record<string, unknown>;
    const gbActivities = gbSystem.activities as Record<string, unknown>;
    const gbActivity = gbActivities.dnd5eactivity000 as Record<string, unknown>;
    const syntheticSpell = {
      ...guidingBolt,
      _id: 'spellSyntheticSave1',
      name: 'Test Save Bolt',
      system: {
        ...gbSystem,
        activities: { dnd5eactivity000: { ...gbActivity, type: 'save' } },
      },
    } as unknown as FoundryItemDoc;
    return { ...casterCaptured, items: [...(casterCaptured.items ?? []), syntheticSpell] };
  }

  it('Bead of Force (split save-DC + utility-roll damage) stays untargetable', () => {
    const actions = dnd5eAdapter.actions!(martialCaptured);
    const beadOfForce = actions.find((a) => a.id === 'item.iecfawCz0pIwcPVg.use')!;
    expect(beadOfForce).toBeDefined();
    expect(beadOfForce.targeting).toBeUndefined();
    expect(() =>
      dnd5eAdapter.buildAction!(martialCaptured, {
        kind: 'use', actionId: 'item.iecfawCz0pIwcPVg.use',
        targetTokenUuids: ['Scene.s1.Token.t1'],
      } as never),
    ).toThrow(/does not support targets/);
  });

  // Final-review Fix 3 (invariant pin): targetingOf must derive from the
  // item's FIRST activity only, matching targetedUseScript's
  // `[...activities.values()][0]` selection — never scan every activity.
  // This clones Guiding Bolt (attack, non-empty damage.parts) but inserts a
  // 'utility' activity ahead of it, so the attack activity is real but NOT
  // first. Under the old all-activities scan this item would have been
  // classified single/attack (an attack activity exists somewhere) even
  // though the script only ever runs the first (utility) activity — a no-op
  // targeting descriptor. The fix must leave it untargetable instead.
  it('an attack activity that is not the FIRST activity does not make the item targetable', () => {
    const guidingBolt = casterCaptured.items?.find((i) => i._id === 'pZMrJb3AXiRYO5E8');
    if (!guidingBolt) throw new Error('fixture missing Guiding Bolt');
    const gbSystem = guidingBolt.system as Record<string, unknown>;
    const gbActivities = gbSystem.activities as Record<string, unknown>;
    const gbActivity = gbActivities.dnd5eactivity000 as Record<string, unknown>;
    const syntheticItem = {
      ...guidingBolt,
      _id: 'itemSyntheticNonFirstAttack',
      name: 'Test Non-First Attack',
      system: {
        ...gbSystem,
        // Insertion order matters: 'utility' first, the real attack
        // activity (with damage.parts) second.
        activities: {
          utilityFirst: { _id: 'utilityFirst', type: 'utility' },
          dnd5eactivity000: gbActivity,
        },
      },
    } as unknown as FoundryItemDoc;
    const actor = { ...casterCaptured, items: [...(casterCaptured.items ?? []), syntheticItem] };
    const found = dnd5eAdapter.actions!(actor).find((a) => a.id === `spell.${syntheticItem._id}.cast`);
    expect(found).toBeDefined();
    expect(found!.targeting).toBeUndefined();
    expect(() =>
      dnd5eAdapter.buildAction!(actor, {
        kind: 'cast', actionId: found!.id,
        targetTokenUuids: ['Scene.s1.Token.t1'],
      } as never),
    ).toThrow(/does not support targets/);
  });

  it('equipped weapon attack descriptors carry single/attack targeting', () => {
    const actions = dnd5eAdapter.actions!(martialCaptured);
    const attack = actions.find((a) => a.kind === 'attack');
    expect(attack?.targeting).toEqual({ mode: 'single', kind: 'attack' });
  });

  it('attack-roll damage spells target single; save-damage spells target multiple; heals single', () => {
    const actions = dnd5eAdapter.actions!(casterCaptured);
    // Guiding Bolt: attack-type damage spell.
    const guidingBolt = actions.find((a) => a.kind === 'cast' && a.label.includes('Guiding Bolt'));
    expect(guidingBolt?.targeting).toEqual({ mode: 'single', kind: 'attack' });
    // Sacred Flame: save-type damage cantrip.
    const sacredFlame = actions.find((a) => a.kind === 'cast' && a.label.includes('Sacred Flame'));
    expect(sacredFlame?.targeting).toEqual({ mode: 'multiple', kind: 'save' });
    // Cure Wounds: heal spell.
    const cureWounds = actions.find((a) => a.kind === 'cast' && a.label.includes('Cure Wounds'));
    expect(cureWounds?.targeting).toEqual({ mode: 'single', kind: 'heal' });
  });

  it('attack intent with a target builds use-on-targets (mode passthrough)', () => {
    const actions = dnd5eAdapter.actions!(martialCaptured);
    const attack = actions.find((a) => a.kind === 'attack')!;
    const action = dnd5eAdapter.buildAction!(martialCaptured, {
      kind: 'attack', actionId: attack.id, mode: 'advantage',
      targetTokenUuids: ['Scene.s1.Token.t1'],
    });
    expect(action).toMatchObject({
      endpoint: 'use-on-targets',
      targetTokenUuids: ['Scene.s1.Token.t1'],
      mode: 'advantage',
    });
  });

  it('single-target actions reject multiple targets', () => {
    const actions = dnd5eAdapter.actions!(martialCaptured);
    const attack = actions.find((a) => a.kind === 'attack')!;
    expect(() =>
      dnd5eAdapter.buildAction!(martialCaptured, {
        kind: 'attack', actionId: attack.id,
        targetTokenUuids: ['Scene.s1.Token.t1', 'Scene.s1.Token.t2'],
      }),
    ).toThrow(/single target/);
  });

  it('targeted upcast cast threads slotKey into use-on-targets', () => {
    const actor = withSyntheticSaveSpell();
    const actions = dnd5eAdapter.actions!(actor);
    const dmgSpell = actions.find(
      (a) => a.kind === 'cast' && a.targeting?.kind === 'save' && (a.slotLevels?.length ?? 0) > 1,
    )!;
    expect(dmgSpell).toBeDefined();
    const chosen = dmgSpell.slotLevels![dmgSpell.slotLevels!.length - 1]!;
    const action = dnd5eAdapter.buildAction!(actor, {
      kind: 'cast', actionId: dmgSpell.id, slotLevel: chosen,
      targetTokenUuids: ['Scene.s1.Token.t1', 'Scene.s1.Token.t2'],
    });
    expect(action).toMatchObject({ endpoint: 'use-on-targets', slotKey: `spell${chosen}` });
  });

  it('a targeted use-kind feature (Breath Weapon, save+damage) builds use-on-targets', () => {
    const actions = dnd5eAdapter.actions!(casterCaptured);
    const breathWeapon = actions.find((a) => a.kind === 'use' && a.targeting?.kind === 'save')!;
    expect(breathWeapon).toBeDefined();
    const action = dnd5eAdapter.buildAction!(casterCaptured, {
      kind: 'use', actionId: breathWeapon.id,
      targetTokenUuids: ['Scene.s1.Token.t1', 'Scene.s1.Token.t2'],
    });
    expect(action).toMatchObject({ endpoint: 'use-on-targets', targetTokenUuids: ['Scene.s1.Token.t1', 'Scene.s1.Token.t2'] });
  });

  it('untargetable actions reject targets', () => {
    expect(() =>
      dnd5eAdapter.buildAction!(martialCaptured, {
        kind: 'check', actionId: 'skill.ath',
        // check intents have no targetTokenUuids field — cast an any to prove
        // the runtime guard, not just the compiler, rejects it:
      } as never),
    ).not.toThrow(); // baseline: kind check unaffected
    const actions = dnd5eAdapter.actions!(casterCaptured);
    const utility = actions.find((a) => a.kind === 'cast' && a.targeting === undefined);
    if (utility) {
      expect(() =>
        dnd5eAdapter.buildAction!(casterCaptured, {
          kind: 'cast', actionId: utility.id, targetTokenUuids: ['Scene.s1.Token.t1'],
        }),
      ).toThrow(/does not support targets/);
    }
  });
});
