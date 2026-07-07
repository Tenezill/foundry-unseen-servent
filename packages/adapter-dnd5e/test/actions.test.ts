/**
 * M6 action surface tests, driven by the captured live-world fixtures
 * (Randal, Fighter 5 / Akra, Cleric 5 — dnd5e 5.3.3 on Foundry 13.351).
 */
import { describe, expect, it } from 'vitest';
import type { ActionDescriptor, ActionIntent, FoundryActorDoc, SheetSection } from '@companion/adapter-sdk';
import { IntentError } from '@companion/adapter-sdk';
import { dnd5eAdapter } from '../src/index.js';
import casterJson from './fixtures/caster.json' with { type: 'json' };
import martialCapturedJson from './fixtures/martial-captured.json' with { type: 'json' };
import casterCapturedJson from './fixtures/caster-captured.json' with { type: 'json' };

const caster = casterJson as unknown as FoundryActorDoc;
const martialCaptured = martialCapturedJson as unknown as FoundryActorDoc;
const casterCaptured = casterCapturedJson as unknown as FoundryActorDoc;

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
    });
    expect(all.some((a) => a.id.startsWith('feature.r7UallZJjcIFsz8i'))).toBe(false);
  });

  it('non-caster has no cast actions; total count is pinned', () => {
    expect(all.filter((a) => a.kind === 'cast')).toHaveLength(0);
    // 18 skills + 12 ability checks/saves + 3 attacks + 5 equips + 1 use
    expect(all).toHaveLength(39);
  });
});

describe('actions() — caster (Akra, Cleric 5)', () => {
  const all = actions(casterCaptured);

  it('exposes a cast action per spell and the pinned total count', () => {
    expect(all.filter((a) => a.kind === 'cast')).toHaveLength(18);
    expect(all.filter((a) => a.kind === 'attack')).toHaveLength(2);
    expect(all.filter((a) => a.kind === 'equip').map((a) => a.id).sort()).toEqual([
      'item.WBL9RaW0MEEVU3fX.equip', // Scale Mail (clothing items get no toggle)
      'item.hutWJTfurJjNbSpG.equip',
      'item.iLKpfoGF7rGpvNWD.equip',
      'item.tnoOhcw37wWUhWzd.equip', // Shield
    ]);
    expect(all.filter((a) => a.kind === 'use').map((a) => a.id)).toEqual(['feature.vWo0CO4uYJ8XRnRi.use']);
    // 18 skills + 12 ability checks/saves + 2 attacks + 4 equips + 18 casts + 1 use
    expect(all).toHaveLength(55);
  });

  it('leveled spells list the slot levels with remaining slots (raw capture: 1..3 all have value > 0)', () => {
    expect(action(casterCaptured, 'spell.pZMrJb3AXiRYO5E8.cast')).toEqual({
      id: 'spell.pZMrJb3AXiRYO5E8.cast',
      label: 'Guiding Bolt',
      kind: 'cast',
      slotLevels: [1, 2, 3],
    });
  });

  it('cantrips carry no slotLevels at all', () => {
    const flame = action(casterCaptured, 'spell.P97npemu7j70IZAQ.cast'); // Sacred Flame, level 0
    expect(flame.kind).toBe('cast');
    expect(flame.slotLevels).toBeUndefined();
  });

  it('slotLevels track the enriched slot values (empty levels drop out)', async () => {
    if (!dnd5eAdapter.enrich) throw new Error('adapter must expose enrich()');
    // Same merge path production uses: derived slot data via AdapterIO.
    const enriched = await dnd5eAdapter.enrich(casterCaptured, {
      getSystemDetails: async () => ({
        spellSlots: {
          spell1: { value: 0, max: 4 }, // all 1st-level slots spent
          spell2: { value: 2, max: 3 },
          spell3: { value: 1, max: 1 },
        },
      }),
    });
    expect(action(enriched, 'spell.pZMrJb3AXiRYO5E8.cast').slotLevels).toEqual([2, 3]);
  });

  it('a leveled spell above every remaining slot gets an empty slotLevels list', async () => {
    if (!dnd5eAdapter.enrich) throw new Error('adapter must expose enrich()');
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
  });

  it('unprepared spells still get cast actions (deliberate: rituals/table rulings; Foundry owns the rules)', () => {
    // Bane: prepared 0 in the capture. It must be castable AND buildable.
    expect(action(casterCaptured, 'spell.9FrgmKwWCYPhlZ5w.cast')).toEqual({
      id: 'spell.9FrgmKwWCYPhlZ5w.cast',
      label: 'Bane',
      kind: 'cast',
      slotLevels: [1, 2, 3],
    });
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.9FrgmKwWCYPhlZ5w.cast', slotLevel: 1 })).toEqual({
      endpoint: 'use-spell',
      itemId: '9FrgmKwWCYPhlZ5w',
      slotLevel: 1,
    });
    // Consistency with the view model: every spell row is tappable.
    const spells = section(casterCaptured, 'spells');
    if (spells.kind !== 'list') throw new Error('spells must be a list section');
    expect(spells.items.every((i) => i.actionId !== undefined)).toBe(true);
  });

  it('slotLevels start at the spell level (synthetic caster: level-2 spell with slots 1..3)', () => {
    // caster.json has derived slot maxima inline: spell1 2/4, spell2 1/3, spell3 2/2.
    expect(action(caster, 'spell.splSpiritWeapon1.cast').slotLevels).toEqual([2, 3]);
    expect(action(caster, 'spell.splSpiritGuard01.cast').slotLevels).toEqual([3]);
    expect(action(caster, 'spell.splBless00000001.cast').slotLevels).toEqual([1, 2, 3]);
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
        const shown = /^([+-])(\d+)$/.exec(String(stat.sub));
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

  it('use maps to use-feature', () => {
    expect(build(martialCaptured, { kind: 'use', actionId: 'feature.7r63kurEAM3GdEec.use' })).toEqual({
      endpoint: 'use-feature',
      itemId: '7r63kurEAM3GdEec',
    });
  });

  it('cast maps to use-spell, carrying a legal slotLevel', () => {
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast', slotLevel: 2 })).toEqual({
      endpoint: 'use-spell',
      itemId: 'pZMrJb3AXiRYO5E8',
      slotLevel: 2,
    });
  });

  it('cast without a slotLevel omits it (Foundry picks the default)', () => {
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.P97npemu7j70IZAQ.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: 'P97npemu7j70IZAQ',
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

  it('illegal slot level -> INVALID', () => {
    // No 4th-level slots on Akra.
    expectIntentError(
      () => build(casterCaptured, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast', slotLevel: 4 }),
      'INVALID',
    );
    expectIntentError(
      () => build(casterCaptured, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast', slotLevel: 1.5 }),
      'INVALID',
    );
    // Cantrips take no slot level at all.
    expectIntentError(
      () => build(casterCaptured, { kind: 'cast', actionId: 'spell.P97npemu7j70IZAQ.cast', slotLevel: 1 }),
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

  it('weapon rows carry attack + equip actions; armor/shield rows carry equip only', () => {
    const inv = section(martialCaptured, 'inventory');
    if (inv.kind !== 'list') throw new Error('inventory must be a list section');
    const sword = inv.items.find((i) => i.label === 'Longsword');
    expect(sword?.actionId).toBe('item.gta26ORvqC323k3r.attack');
    expect(sword?.equipActionId).toBe('item.gta26ORvqC323k3r.equip');
    const mail = inv.items.find((i) => i.label === 'Chain Mail');
    expect(mail?.actionId).toBeUndefined();
    expect(mail?.equipActionId).toBe('item.yz7DxhEVWUzdQKm7.equip');
    const torch = inv.items.find((i) => i.label === 'Torch');
    expect(torch?.actionId).toBeUndefined();
    expect(torch?.equipActionId).toBeUndefined();
  });

  it('spell rows carry cast actions', () => {
    const spells = section(casterCaptured, 'spells');
    if (spells.kind !== 'list') throw new Error('spells must be a list section');
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
    expect(dnd5eAdapter.toViewModel(casterCaptured).actions).toHaveLength(55);
  });
});
