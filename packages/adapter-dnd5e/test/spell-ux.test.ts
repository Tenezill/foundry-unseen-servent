// Spell-UX pass (2026-07-18 design): equipped-only weapon actions, free-use
// spell marking, and per-level spell sections. See
// docs/superpowers/specs/2026-07-18-spell-ux-weapons-portraits-design.md
import { describe, expect, it } from 'vitest';
import type { ActionDescriptor, FoundryActorDoc, FoundryItemDoc, SheetSection } from '@companion/adapter-sdk';
import { dnd5eAdapter } from '../src/index.js';
import martialCapturedJson from './fixtures/martial-captured.json' with { type: 'json' };
import casterCapturedJson from './fixtures/caster-captured.json' with { type: 'json' };

const martialCaptured = martialCapturedJson as unknown as FoundryActorDoc;
const casterCaptured = casterCapturedJson as unknown as FoundryActorDoc;

function actions(a: FoundryActorDoc): ActionDescriptor[] {
  if (!dnd5eAdapter.actions) throw new Error('adapter must expose actions()');
  return dnd5eAdapter.actions(a);
}
const sections = (a: FoundryActorDoc): SheetSection[] => dnd5eAdapter.toViewModel(a).sections;
const spellSections = (a: FoundryActorDoc) =>
  sections(a).filter((s): s is Extract<SheetSection, { kind: 'list' }> => s.kind === 'list' && s.id.startsWith('spells.l'));

function withUnequipped(actor: FoundryActorDoc, itemId: string): FoundryActorDoc {
  return {
    ...actor,
    items: (actor.items ?? []).map((i) =>
      i._id === itemId ? { ...i, system: { ...i.system, equipped: false } } : i,
    ),
  };
}

/** Morgrim-shaped free-use spell (live-verified 5.3.3 shape: method atwill,
 *  own 1/lr uses, heal activity consuming itemUses). */
function freeUseSpell(overrides: Partial<Record<string, unknown>> = {}): FoundryItemDoc {
  return {
    _id: 'FreeHealWord0001',
    name: 'Healing Word',
    type: 'spell',
    system: {
      level: 1,
      school: 'evo',
      method: 'atwill',
      prepared: 0,
      properties: ['vocal'],
      uses: { spent: 0, max: '1', recovery: [{ period: 'lr', type: 'recoverAll' }] },
      activities: {
        healFreeWord0000: {
          type: 'heal',
          _id: 'healFreeWord0000',
          activation: { type: 'bonus', value: 1 },
          consumption: { targets: [{ type: 'itemUses', target: '', value: '1' }] },
          healing: { number: 1, denomination: 4, bonus: '@abilities.wis.mod', types: ['healing'] },
        },
      },
      ...overrides,
    },
  };
}

function withSpell(actor: FoundryActorDoc, spell: FoundryItemDoc): FoundryActorDoc {
  return { ...actor, items: [...(actor.items ?? []), spell] };
}

/** Minimal leveled spell doc for preparation tests. Defaults: level 2,
 *  method "spell" (not free-use), unprepared. */
function spellDoc(id: string, overrides: Record<string, unknown> = {}): FoundryItemDoc {
  return {
    _id: id,
    name: id,
    type: 'spell',
    system: { level: 2, school: 'evo', method: 'spell', prepared: 0, properties: [], ...overrides },
  };
}

// ---------------------------------------------------------------------------

describe('weapon actions only while equipped', () => {
  it('an unequipped weapon loses its attack + damage actions but keeps the equip toggle', () => {
    const unequipped = withUnequipped(martialCaptured, 'gta26ORvqC323k3r');
    const ids = actions(unequipped).map((a) => a.id);
    expect(ids).not.toContain('item.gta26ORvqC323k3r.attack');
    expect(ids).not.toContain('item.gta26ORvqC323k3r.damage');
    expect(ids).toContain('item.gta26ORvqC323k3r.equip');
    // The other (still equipped) weapons keep theirs.
    expect(ids).toContain('item.DHfjuHRMDDsyjBti.attack');
    expect(ids).toContain('item.rEwBQ75m41HeBYOs.attack');
  });
});

// ---------------------------------------------------------------------------

describe('free-use / innate spells', () => {
  it('atwill spell row: "free use" tag, recharge in sub, uses counter wired', () => {
    const actor = withSpell(casterCaptured, freeUseSpell());
    const rows = spellSections(actor).flatMap((s) => s.items);
    const row = rows.find((r) => r.id === 'FreeHealWord0001');
    expect(row?.tags).toContain('free use');
    expect(row?.sub).toContain('1/long rest');
    expect(row?.resourceId).toBe('item.FreeHealWord0001.uses');
    // It does not participate in preparation.
    expect(row?.toggleActionId).toBeUndefined();
  });

  it('innate spell row gets the "innate" tag', () => {
    const actor = withSpell(casterCaptured, freeUseSpell({ method: 'innate' }));
    const row = spellSections(actor)
      .flatMap((s) => s.items)
      .find((r) => r.id === 'FreeHealWord0001');
    expect(row?.tags).toContain('innate');
  });

  it('cast action carries the "(free use)" label suffix and ignores empty slots', () => {
    const noSlots: FoundryActorDoc = {
      ...casterCaptured,
      system: {
        ...casterCaptured.system,
        spells: { spell1: { value: 0, override: null } },
      },
    };
    const actor = withSpell(noSlots, freeUseSpell());
    const cast = actions(actor).find((a) => a.id === 'spell.FreeHealWord0001.cast');
    // Unprepared (prepared: 0) — free-use spells are castable regardless.
    expect(cast).toBeDefined();
    expect(cast?.label).toBe('Healing Word (free use)');
    // No slot needed — must NOT render disabled when level-1 slots are empty.
    expect(cast?.slotLevels).toBeUndefined();
  });

  it('buildAction never gates a free-use cast on slot availability (regression: base-slot check must skip free-use grants)', () => {
    if (!dnd5eAdapter.buildAction) throw new Error('adapter must expose buildAction()');
    const noSlots: FoundryActorDoc = {
      ...casterCaptured,
      system: {
        ...casterCaptured.system,
        spells: { spell1: { value: 0, override: null } },
      },
    };
    const actor = withSpell(noSlots, freeUseSpell());
    // Same premise as the descriptor test above (level-1 slots all empty),
    // but exercised through buildAction — the leveled-spell base-slot refusal
    // must not accidentally catch a free-use/innate grant, which tracks its
    // own item uses instead of a spell slot.
    expect(() =>
      dnd5eAdapter.buildAction!(actor, { kind: 'cast', actionId: 'spell.FreeHealWord0001.cast' }),
    ).not.toThrow();
  });

  it('a normal slot spell is unchanged: no suffix, disabled without slots', () => {
    const noSlots: FoundryActorDoc = {
      ...casterCaptured,
      system: { ...casterCaptured.system, spells: { spell1: { value: 0, override: null } } },
    };
    const cast = actions(noSlots).find((a) => a.kind === 'cast' && a.slotLevels !== undefined);
    expect(cast).toBeDefined();
    expect(cast?.label.endsWith('(free use)')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('per-level spell sections', () => {
  it('caster splits into Cantrips + 1st Level sections with headers; no flat "spells" section', () => {
    const secs = sections(casterCaptured);
    expect(secs.find((s) => s.id === 'spells')).toBeUndefined();
    const spellSecs = spellSections(casterCaptured);
    expect(spellSecs.map((s) => s.id)).toEqual(['spells.l0', 'spells.l1']);
    expect(spellSecs[0]?.label).toBe('Cantrips');
    expect(spellSecs[1]?.label).toBe('1st Level');
    expect(spellSecs[0]?.items).toHaveLength(3);
    expect(spellSecs[1]?.items).toHaveLength(15);
    // Inventory-style collapsible headline: every level section has a header.
    for (const s of spellSecs) {
      expect(s.header?.label).toBe(s.label);
      expect(s.header?.sub).toMatch(/\d+ spells?$/);
    }
  });

  it('non-caster emits no spell sections at all', () => {
    expect(spellSections(martialCaptured)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('prepared spells: no redundant signalling', () => {
  it('a prepared leveled spell drops the "prepared" sub segment and tag but keeps its toggle + distinct tags', () => {
    const actor = withSpell(casterCaptured, spellDoc('PrepBolt00000001', { level: 1, prepared: 1, properties: ['concentration'] }));
    const row = spellSections(actor).flatMap((s) => s.items).find((r) => r.id === 'PrepBolt00000001');
    expect(row).toBeDefined();
    expect(row!.tags ?? []).not.toContain('prepared');
    expect(row!.sub ?? '').not.toMatch(/prepared/i);
    expect(row!.toggleActionId).toBe('spell.PrepBolt00000001.prepare');
    expect(row!.tags ?? []).toContain('concentration');
  });

  it('an always-prepared (prepared: 2) spell keeps its "always prepared" sub and gets no toggle', () => {
    const actor = withSpell(casterCaptured, spellDoc('DomainWard000001', { level: 1, prepared: 2 }));
    const row = spellSections(actor).flatMap((s) => s.items).find((r) => r.id === 'DomainWard000001');
    expect(row!.sub ?? '').toMatch(/always prepared/i);
    expect(row!.toggleActionId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('prepared-first ordering within a level', () => {
  it('prepared and always-prepared sort before unprepared, stable within each group', () => {
    let actor = casterCaptured;
    for (const s of [
      spellDoc('z_unprep_a'),                    // rank 1
      spellDoc('z_prep_b', { prepared: 1 }),      // rank 0
      spellDoc('z_unprep_c'),                    // rank 1
      spellDoc('z_always_d', { prepared: 2 }),    // rank 0
    ]) {
      actor = withSpell(actor, s);
    }
    const l2 = spellSections(actor).find((s) => s.id === 'spells.l2');
    expect(l2).toBeDefined();
    expect(l2!.items.map((i) => i.id)).toEqual(['z_prep_b', 'z_always_d', 'z_unprep_a', 'z_unprep_c']);
  });
});

// ---------------------------------------------------------------------------

describe('prepared-spell budget (spellPrep)', () => {
  const vm = (a: FoundryActorDoc) => dnd5eAdapter.toViewModel(a);

  it('a prepared caster reports current prepared count and a computed base', () => {
    // Akra, Cleric 5, WIS 15 (+2): base = 2 + 5 = 7; prepared leveled (===1) = 3
    // (Guiding Bolt, Detect Magic, Cure Wounds); always-prepared (===2) excluded.
    expect(vm(casterCaptured).spellPrep).toEqual({ prepared: 3, base: 7 });
  });

  it('an actor with no preparable spells has no budget', () => {
    expect(vm(martialCaptured).spellPrep).toBeUndefined();
  });

  it('toggling a spell to prepared raises the count', () => {
    const actor = withSpell(casterCaptured, spellDoc('BudgetAdd0000001', { level: 1, prepared: 1 }));
    expect(vm(actor).spellPrep).toEqual({ prepared: 4, base: 7 });
  });
});
