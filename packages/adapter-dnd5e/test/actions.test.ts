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
    // 18 skills + 12 ability checks/saves + 1 initiative (M10) + 3 attacks
    // + 5 equips + 1 feature use + 6 item uses (Waterskin, Torch, Rations,
    // Piton, Rope, Horn)
    // + 2 rests (M8; hp>0 & no concentration -> no death-save/end-conc)
    expect(all).toHaveLength(48);
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
    expect(all.filter((a) => a.kind === 'use' && a.group === undefined).map((a) => a.id)).toEqual([
      'feature.vWo0CO4uYJ8XRnRi.use',
    ]);
    expect(all.filter((a) => a.kind === 'use' && a.group === 'items')).toHaveLength(6);
    // 18 skills + 12 ability checks/saves + 1 initiative (M10) + 2 attacks
    // + 4 equips + 18 casts
    // + 13 prepare toggles (18 spells − 3 cantrips − 2 always-prepared)
    // + 1 feature use + 6 item uses (Waterskin, Torch, Common Clothes,
    // Rations, Rope, Vestments)
    // + 2 rests (M8; hp>0 & no concentration -> no death-save/end-conc)
    expect(all).toHaveLength(77);
  });

  it('a leveled spell with a base-level slot is directly castable (no slotLevels — the bridge casts at base only)', () => {
    // Guiding Bolt (level 1); raw capture has spell1.value > 0.
    expect(action(casterCaptured, 'spell.pZMrJb3AXiRYO5E8.cast')).toEqual({
      id: 'spell.pZMrJb3AXiRYO5E8.cast',
      label: 'Guiding Bolt',
      kind: 'cast',
    });
  });

  it('cantrips carry no slotLevels at all', () => {
    const flame = action(casterCaptured, 'spell.P97npemu7j70IZAQ.cast'); // Sacred Flame, level 0
    expect(flame.kind).toBe('cast');
    expect(flame.slotLevels).toBeUndefined();
  });

  it('a leveled spell with no base-level slot is disabled (slotLevels: []) — upcast is not supported by the bridge', async () => {
    if (!dnd5eAdapter.enrich) throw new Error('adapter must expose enrich()');
    // Guiding Bolt is level 1; drain 1st-level slots but leave 2nd/3rd. Since
    // the module casts at base level only, it is NOT castable.
    const enriched = await dnd5eAdapter.enrich(casterCaptured, {
      getSystemDetails: async () => ({
        spellSlots: {
          spell1: { value: 0, max: 4 },
          spell2: { value: 2, max: 3 },
          spell3: { value: 1, max: 1 },
        },
      }),
    });
    expect(action(enriched, 'spell.pZMrJb3AXiRYO5E8.cast').slotLevels).toEqual([]);
    // ...and buildAction refuses it.
    expect(() => build(enriched, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast' })).toThrow(IntentError);
  });

  it('unprepared spells still get cast actions (deliberate: rituals/table rulings; Foundry owns the rules)', () => {
    // Bane: prepared 0 in the capture. It must be castable AND buildable.
    expect(action(casterCaptured, 'spell.9FrgmKwWCYPhlZ5w.cast')).toEqual({
      id: 'spell.9FrgmKwWCYPhlZ5w.cast',
      label: 'Bane',
      kind: 'cast',
    });
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.9FrgmKwWCYPhlZ5w.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: '9FrgmKwWCYPhlZ5w',
    });
    // Consistency with the view model: every spell row is tappable.
    const spells = section(casterCaptured, 'spells');
    if (spells.kind !== 'list') throw new Error('spells must be a list section');
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

  it('cast maps to use-spell at base level (a requested slotLevel is ignored — the bridge cannot upcast)', () => {
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast', slotLevel: 2 })).toEqual({
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
    expect(dnd5eAdapter.toViewModel(casterCaptured).actions).toHaveLength(77);
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
    });
  });

  it('still maps feature use intents to use-feature', () => {
    expect(build(martialCaptured, { kind: 'use', actionId: 'feature.7r63kurEAM3GdEec.use' })).toEqual({
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

  it('spell rows carry toggleActionId and forgettable; the sheet flags spellbook support', () => {
    const spells = section(casterCaptured, 'spells');
    if (spells.kind !== 'list') throw new Error('spells must be a list section');
    const bolt = spellOf('Guiding Bolt');
    const row = spells.items.find((r) => r.id === bolt._id);
    expect(row?.toggleActionId).toBe(`spell.${bolt._id}.prepare`);
    expect(row?.forgettable).toBe(true);
    const cantripRow = spells.items.find((r) => r.id === spellOf('Sacred Flame')._id);
    expect(cantripRow?.toggleActionId).toBeUndefined();
    expect(cantripRow?.forgettable).toBe(true);
    expect(dnd5eAdapter.toViewModel(casterCaptured).hasSpellbook).toBe(true);
  });

  it('spellbook capability accepts spells and rejects everything else', () => {
    const sb = dnd5eAdapter.spellbook;
    if (!sb) throw new Error('adapter must expose spellbook');
    expect(sb.searchFilter).toBe('documentType:Item,subType:spell');
    expect(sb.canLearn({ type: 'spell' })).toBe(true);
    expect(sb.canLearn({ type: 'weapon' })).toBe(false);
    expect(sb.canForget(spellOf('Bane'))).toBe(true);
    const nonSpell = casterCaptured.items?.find((i) => i.type !== 'spell');
    if (!nonSpell) throw new Error('need a non-spell item');
    expect(sb.canForget(nonSpell)).toBe(false);
  });

  it('describe renders a preview ListItem from a raw compendium doc', () => {
    const sb = dnd5eAdapter.spellbook;
    if (!sb) throw new Error('adapter must expose spellbook');
    const li = sb.describe({
      _id: 'x1',
      name: 'Fireball',
      type: 'spell',
      img: 'icons/f.webp',
      system: { level: 3, school: 'evo', description: { value: '<p>Boom</p>' } },
    });
    expect(li).toMatchObject({ id: 'x1', label: 'Fireball', img: 'icons/f.webp', detail: '<p>Boom</p>' });
    expect(li.sub).toContain('3rd level');
    expect(li.sub).toContain('Evocation');
    const cantrip = sb.describe({ _id: 'x2', name: 'Light', type: 'spell', system: { level: 0 } });
    expect(cantrip.sub).toContain('Cantrip');
  });

  it('rejects prepare intents for spells without a toggle', () => {
    const always = spellOf('Bless');
    expectIntentError(
      () => build(casterCaptured, { kind: 'prepare', actionId: `spell.${always._id}.prepare`, prepared: false }),
      'UNKNOWN_RESOURCE',
    );
  });
});
