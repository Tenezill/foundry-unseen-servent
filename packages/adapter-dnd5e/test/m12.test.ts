/**
 * M12 inventory upgrades: attunement (toggle + counter), container grouping,
 * per-row weight, carried-weight counter, and the stats enrich extension.
 * The captured fixtures carry NO attunement-required items and only dangling
 * container refs (compendium-source ids), so attune/container coverage uses
 * synthetic items grafted onto the captures.
 */
import { describe, expect, it } from 'vitest';
import type { ActionIntent, FoundryActorDoc, FoundryItemDoc, SheetSection } from '@companion/adapter-sdk';
import { IntentError } from '@companion/adapter-sdk';
import { dnd5eAdapter } from '../src/index.js';
import martialCapturedJson from './fixtures/martial-captured.json' with { type: 'json' };
import casterCapturedJson from './fixtures/caster-captured.json' with { type: 'json' };

const martialCaptured = martialCapturedJson as unknown as FoundryActorDoc;
const casterCaptured = casterCapturedJson as unknown as FoundryActorDoc;

function section(actor: FoundryActorDoc, id: string): SheetSection {
  const s = dnd5eAdapter.toViewModel(actor).sections.find((x) => x.id === id);
  if (!s) throw new Error(`section ${id} not found`);
  return s;
}

function inventoryRow(actor: FoundryActorDoc, label: string) {
  const s = section(actor, 'inventory');
  if (s.kind !== 'list') throw new Error('inventory must be a list section');
  const row = s.items.find((i) => i.label === label);
  if (!row) throw new Error(`inventory row ${label} not found`);
  return row;
}

function gearStat(actor: FoundryActorDoc, id: string) {
  const s = section(actor, 'gearstats');
  if (s.kind !== 'stats') throw new Error('gearstats must be a stats section');
  const stat = s.stats.find((x) => x.id === id);
  if (!stat) throw new Error(`gearstats stat ${id} not found`);
  return stat;
}

function build(actor: FoundryActorDoc, intent: ActionIntent) {
  if (!dnd5eAdapter.buildAction) throw new Error('adapter must expose buildAction()');
  return dnd5eAdapter.buildAction(actor, intent);
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

/** Attunement-required cloak in the dnd5e 5.3.3 wire shape (live-verified). */
function cloak(attuned: boolean, id = 'CloakProt0000001'): FoundryItemDoc {
  return {
    _id: id,
    name: 'Cloak of Protection',
    type: 'equipment',
    system: {
      quantity: 1,
      weight: { value: 1, units: 'lb' },
      attunement: 'required',
      attuned,
      equipped: true,
      container: null,
      type: { value: 'clothing' },
    },
  };
}

function withItems(actor: FoundryActorDoc, extra: FoundryItemDoc[]): FoundryActorDoc {
  return { ...actor, items: [...(actor.items ?? []), ...extra] };
}

// ---------------------------------------------------------------------------
// Attune actions

describe('M12 attune actions', () => {
  it('an attunement-required item gets an attune action carrying the current state', () => {
    const actor = withItems(martialCaptured, [cloak(false)]);
    const a = dnd5eAdapter.actions?.(actor).find((x) => x.id === 'item.CloakProt0000001.attune');
    expect(a).toEqual({
      id: 'item.CloakProt0000001.attune',
      label: 'Cloak of Protection',
      kind: 'attune',
      attuned: false,
    });
    const attuned = withItems(martialCaptured, [cloak(true)]);
    expect(
      dnd5eAdapter.actions?.(attuned).find((x) => x.id === 'item.CloakProt0000001.attune')?.attuned,
    ).toBe(true);
  });

  it('mundane items (attunement "") get no attune action — fixture totals stay pinned', () => {
    const all = dnd5eAdapter.actions?.(martialCaptured) ?? [];
    expect(all.some((a) => a.kind === 'attune')).toBe(false);
    expect(all).toHaveLength(73);
    expect((dnd5eAdapter.actions?.(casterCaptured) ?? []).some((a) => a.kind === 'attune')).toBe(false);
  });

  it('legacy numeric attunement (1 = required, 2 = attuned) is accepted defensively', () => {
    for (const legacy of [1, 2]) {
      const item: FoundryItemDoc = { ...cloak(false), system: { ...cloak(false).system, attunement: legacy } };
      const actor = withItems(martialCaptured, [item]);
      expect(dnd5eAdapter.actions?.(actor).some((a) => a.id === 'item.CloakProt0000001.attune')).toBe(true);
    }
  });

  it('non-physical items never get attune actions even if data claims required', () => {
    const spellish: FoundryItemDoc = {
      _id: 'weirdSpell000001',
      name: 'Weird',
      type: 'spell',
      system: { level: 1, attunement: 'required' },
    };
    const actor = withItems(casterCaptured, [spellish]);
    expect(dnd5eAdapter.actions?.(actor).some((a) => a.id === 'item.weirdSpell000001.attune')).toBe(false);
  });

  it('buildAction maps attune to the dedicated attune-item endpoint, round-tripping the desired state', () => {
    const actor = withItems(martialCaptured, [cloak(false)]);
    expect(build(actor, { kind: 'attune', actionId: 'item.CloakProt0000001.attune', attuned: true })).toEqual({
      endpoint: 'attune-item',
      itemId: 'CloakProt0000001',
      attuned: true,
    });
    expect(build(actor, { kind: 'attune', actionId: 'item.CloakProt0000001.attune', attuned: false })).toEqual({
      endpoint: 'attune-item',
      itemId: 'CloakProt0000001',
      attuned: false,
    });
  });

  it('does NOT enforce the attunement cap (Foundry/GM owns rules) — a 4th attune builds fine', () => {
    const actor = withItems(martialCaptured, [
      cloak(true, 'CloakAAAAAAAAAA1'),
      cloak(true, 'CloakBBBBBBBBBB2'),
      cloak(true, 'CloakCCCCCCCCCC3'),
      cloak(false, 'CloakDDDDDDDDDD4'),
    ]);
    expect(gearStat(actor, 'attunement').value).toBe('3/3');
    expect(build(actor, { kind: 'attune', actionId: 'item.CloakDDDDDDDDDD4.attune', attuned: true })).toEqual({
      endpoint: 'attune-item',
      itemId: 'CloakDDDDDDDDDD4',
      attuned: true,
    });
  });

  it('rejects a non-boolean attuned param -> INVALID', () => {
    const actor = withItems(martialCaptured, [cloak(false)]);
    expectIntentError(
      () =>
        build(actor, {
          kind: 'attune',
          actionId: 'item.CloakProt0000001.attune',
          attuned: 'yes' as unknown as boolean,
        }),
      'INVALID',
    );
  });

  it('rejects attune on items without the action and kind mismatches -> UNKNOWN_RESOURCE', () => {
    // Torch is mundane: no attune descriptor exists.
    expectIntentError(
      () => build(martialCaptured, { kind: 'attune', actionId: 'item.Di7LgeBsM42Mi6yF.attune', attuned: true }),
      'UNKNOWN_RESOURCE',
    );
    const actor = withItems(martialCaptured, [cloak(false)]);
    expectIntentError(
      () => build(actor, { kind: 'equip', actionId: 'item.CloakProt0000001.attune', equipped: true }),
      'UNKNOWN_RESOURCE',
    );
  });
});

// ---------------------------------------------------------------------------
// Inventory rows: attune pill, attuned tag, container grouping, weight

describe('M12 inventory rows', () => {
  it('attuneable rows carry attuneActionId (separate from the equip toggle)', () => {
    const actor = withItems(martialCaptured, [cloak(false)]);
    const row = inventoryRow(actor, 'Cloak of Protection');
    expect(row.attuneActionId).toBe('item.CloakProt0000001.attune');
    // Clothing is not equippable, so no equip pill competes.
    expect(row.toggleActionId).toBeUndefined();
    // Mundane rows carry none.
    expect(inventoryRow(martialCaptured, 'Torch').attuneActionId).toBeUndefined();
    expect(inventoryRow(martialCaptured, 'Longsword').attuneActionId).toBeUndefined();
  });

  it('attuned items get an "attuned" tag after "equipped"', () => {
    const actor = withItems(martialCaptured, [cloak(true)]);
    expect(inventoryRow(actor, 'Cloak of Protection').tags).toEqual(['equipped', 'attuned']);
    const unattuned = withItems(martialCaptured, [cloak(false)]);
    expect(inventoryRow(unattuned, 'Cloak of Protection').tags).toEqual(['equipped']);
  });

  it('containerId is set when system.container matches another physical item _id', () => {
    // Rewire Torch into the actually-present Quiver (B2OSARI9hcSzaai9). Torch
    // now lives inside the Quiver's own location-first section (M19); the
    // containerId field inventoryListItem sets is still correct there.
    const rewired: FoundryActorDoc = {
      ...martialCaptured,
      items: (martialCaptured.items ?? []).map((i) =>
        i.name === 'Torch' ? { ...i, system: { ...i.system, container: 'B2OSARI9hcSzaai9' } } : i,
      ),
    };
    const quiver = section(rewired, 'inventory.B2OSARI9hcSzaai9');
    if (quiver.kind !== 'list') throw new Error('quiver section must be a list section');
    expect(quiver.items.find((i) => i.label === 'Torch')?.containerId).toBe('B2OSARI9hcSzaai9');
    expect(quiver.header?.containerId).toBeUndefined();
  });

  it('dangling container refs yield no containerId (captured fixtures: all refs are compendium ids)', () => {
    // Torch's captured container "8KWz5DJbWUpNWniP" matches no embedded item.
    expect(inventoryRow(martialCaptured, 'Torch').containerId).toBeUndefined();
    const s = section(martialCaptured, 'inventory');
    if (s.kind !== 'list') throw new Error('inventory must be a list section');
    expect(s.items.every((i) => i.containerId === undefined)).toBe(true);
  });

  it('container null / absent yields no containerId', () => {
    expect(inventoryRow(martialCaptured, 'Longsword').containerId).toBeUndefined();
    expect(inventoryRow(martialCaptured, 'Hammer').containerId).toBeUndefined();
  });

  it('appends the per-row weight to sub ("<n> lb"; "<qty> × <n> lb" when qty > 1)', () => {
    expect(inventoryRow(martialCaptured, 'Longsword').sub).toBe('weapon · 3 lb');
    expect(inventoryRow(martialCaptured, 'Torch').sub).toBe('×10 · consumable · 10 × 1 lb');
    expect(inventoryRow(martialCaptured, 'Arrow').sub).toBe('×20 · consumable · 20 × 0.05 lb');
  });

  it('zero or missing weight adds no weight part', () => {
    // Stick of Incense: weight.value 0.
    expect(inventoryRow(casterCaptured, 'Stick of Incense').sub).toBe('×5 · loot');
    const noWeight: FoundryActorDoc = {
      ...martialCaptured,
      items: (martialCaptured.items ?? []).map((i) =>
        i.name === 'Hammer' ? { ...i, system: { ...i.system, weight: undefined } } : i,
      ),
    };
    expect(inventoryRow(noWeight, 'Hammer').sub).toBe('loot');
  });
});

// ---------------------------------------------------------------------------
// Gear stats section: attunement counter + carried weight

describe('M12 gearstats section', () => {
  it('sits right after the inventory sections (Carried + per-container) with id "gearstats", label "Gear"', () => {
    // M19: 'inventory' (Carried) is followed by one 'inventory.<cid>' section
    // per container (martialCaptured carries 3) before gearstats.
    const vm = dnd5eAdapter.toViewModel(martialCaptured);
    const lastInventoryIdx = vm.sections.reduce((last, s, i) => (/^inventory/.test(s.id) ? i : last), -1);
    expect(lastInventoryIdx).toBeGreaterThanOrEqual(0);
    const gear = vm.sections[lastInventoryIdx + 1];
    expect(gear).toMatchObject({ kind: 'stats', id: 'gearstats', label: 'Gear' });
  });

  it('Attunement counts attuned physical items against attributes.attunement.max', () => {
    expect(gearStat(martialCaptured, 'attunement')).toEqual({ id: 'attunement', label: 'Attunement', value: '0/3' });
    const one = withItems(martialCaptured, [cloak(true)]);
    expect(gearStat(one, 'attunement').value).toBe('1/3');
  });

  it('Attunement max falls back to 3 when the actor carries no attunement attribute', () => {
    const attrs = { ...(martialCaptured.system.attributes as Record<string, unknown>) };
    delete attrs.attunement;
    const bare: FoundryActorDoc = { ...martialCaptured, system: { ...martialCaptured.system, attributes: attrs } };
    expect(gearStat(bare, 'attunement').value).toBe('0/3');
  });

  it('Carried weight sums weight × quantity over physical items, 1 decimal', () => {
    // Randal's 21 physical items sum to 142.6 lb (Torch 10×1, Arrow 20×0.05,
    // …, Bead of Force 0.06×1, added M16 — rounds into the existing total).
    expect(gearStat(martialCaptured, 'weight')).toEqual({ id: 'weight', label: 'Carried weight', value: '142.6 lb' });
  });

  it('shows "<value>/<max> lb" when the enriched doc carries derived encumbrance', () => {
    const enriched: FoundryActorDoc = {
      ...martialCaptured,
      system: {
        ...martialCaptured.system,
        attributes: {
          ...(martialCaptured.system.attributes as Record<string, unknown>),
          encumbrance: { value: 142.5, max: 240 },
        },
      },
    };
    expect(gearStat(enriched, 'weight').value).toBe('142.5/240 lb');
  });
});

// ---------------------------------------------------------------------------
// enrich: stats detail merged alongside spells

describe('M12 enrich — stats detail (encumbrance)', () => {
  function enrichWith(actor: FoundryActorDoc, response: unknown, calls?: string[][]) {
    if (!dnd5eAdapter.enrich) throw new Error('adapter must expose enrich()');
    return dnd5eAdapter.enrich(actor, {
      getSystemDetails: async (details) => {
        calls?.push(details);
        return response;
      },
    });
  }

  it('merges encumbrance in a single call (martial capture keeps its spells request — it serializes a spells object)', async () => {
    const calls: string[][] = [];
    const enriched = await enrichWith(
      martialCaptured,
      { stats: { encumbrance: { value: 142.5, max: 240 } } },
      calls,
    );
    expect(calls).toEqual([['spells', 'stats']]);
    expect(gearStat(enriched, 'weight').value).toBe('142.5/240 lb');
  });

  it('a truly spell-less actor requests ["stats"] only', async () => {
    const spellless: FoundryActorDoc = {
      _id: 'actorNoSpells001',
      name: 'No Spells',
      type: 'character',
      system: { attributes: {} },
      items: (martialCaptured.items ?? []).filter((i) => i.type !== 'spell'),
    };
    const calls: string[][] = [];
    const enriched = await enrichWith(spellless, { stats: { encumbrance: { value: 10, max: 100 } } }, calls);
    expect(calls).toEqual([['stats']]);
    expect(gearStat(enriched, 'weight').value).toBe('10/100 lb');
  });

  it('casters request ["spells", "stats"] in ONE call; both merges apply', async () => {
    const calls: string[][] = [];
    const enriched = await enrichWith(
      casterCaptured,
      {
        spellSlots: { spell1: { value: 1, max: 4 } },
        stats: { encumbrance: { value: 120, max: 195 } },
      },
      calls,
    );
    expect(calls).toEqual([['spells', 'stats']]);
    const slot1 = dnd5eAdapter.resources(enriched).find((r) => r.id === 'slots.1');
    expect(slot1).toMatchObject({ value: 1, max: 4 });
    expect(gearStat(enriched, 'weight').value).toBe('120/195 lb');
  });

  it('merges derived AC from stats (active-effect bonuses the local fallback cannot see)', async () => {
    // Live bug: Fighting Style: Defense (+1 ac.bonus active effect) → Foundry
    // derives 19, but the local fallback from equipped armor computes 18. The
    // stats detail carries the real derived AC — it must win.
    const enriched = await enrichWith(martialCaptured, { stats: { ac: 19 } });
    expect(dnd5eAdapter.resources(enriched).find((r) => r.id === 'ac')).toMatchObject({ value: 19 });
  });

  it('junk stats.ac is tolerated (local armor computation stands)', async () => {
    for (const ac of [null, 'x', Number.NaN]) {
      const enriched = await enrichWith(martialCaptured, { stats: { ac } });
      expect(dnd5eAdapter.resources(enriched).find((r) => r.id === 'ac')).toMatchObject({ value: 18 });
    }
  });

  it('IO failure returns the actor unchanged', async () => {
    if (!dnd5eAdapter.enrich) throw new Error('adapter must expose enrich()');
    const out = await dnd5eAdapter.enrich(martialCaptured, {
      getSystemDetails: async () => {
        throw new Error('relay down');
      },
    });
    expect(out).toBe(martialCaptured);
  });

  it('a response without stats degrades to the local sum (spells still merge)', async () => {
    const enriched = await enrichWith(casterCaptured, { spellSlots: { spell1: { value: 0, max: 4 } } });
    expect(dnd5eAdapter.resources(enriched).find((r) => r.id === 'slots.1')).toMatchObject({ value: 0, max: 4 });
    expect(String(gearStat(enriched, 'weight').value)).toMatch(/ lb$/);
    expect(gearStat(enriched, 'weight').value).not.toContain('/');
  });

  it('junk stats payloads are tolerated', async () => {
    for (const stats of [null, 42, 'nope', { encumbrance: 'heavy' }, { encumbrance: { value: 'x', max: null } }]) {
      const enriched = await enrichWith(martialCaptured, { stats });
      expect(gearStat(enriched, 'weight').value).toBe('142.6 lb');
    }
  });
});

// ---------------------------------------------------------------------------
// Review-confirmed fixes: optional attunement, legacy state, units, max ≠ 3

describe('M12 review fixes', () => {
  const optionalRing = (attuned: boolean): FoundryItemDoc => ({
    _id: 'RingOptional0001',
    name: 'Ring of Warmth',
    type: 'equipment',
    system: {
      quantity: 1,
      weight: { value: 0.1, units: 'lb' },
      attunement: 'optional',
      attuned,
      equipped: true,
      container: null,
      type: { value: 'trinket' },
    },
  });

  it('optional-attunement items get the attune toggle too (they tag and count already)', () => {
    const actor = withItems(martialCaptured, [optionalRing(true)]);
    const row = inventoryRow(actor, 'Ring of Warmth');
    expect(row.attuneActionId).toBe('item.RingOptional0001.attune');
    const a = dnd5eAdapter.actions!(actor).find((x) => x.id === 'item.RingOptional0001.attune');
    expect(a).toMatchObject({ kind: 'attune', attuned: true });
  });

  it('legacy numeric attunement 2 renders as ATTUNED everywhere (state not inverted)', () => {
    const legacy: FoundryItemDoc = {
      _id: 'LegacyAttuned001',
      name: 'Old Amulet',
      type: 'equipment',
      // pre-5.x shape: numeric attunement, NO `attuned` boolean at all
      system: { quantity: 1, attunement: 2, equipped: true, container: null, type: { value: 'trinket' } },
    };
    const actor = withItems(martialCaptured, [legacy]);
    expect(inventoryRow(actor, 'Old Amulet').tags).toContain('attuned');
    const a = dnd5eAdapter.actions!(actor).find((x) => x.id === 'item.LegacyAttuned001.attune');
    expect(a?.attuned).toBe(true);
    expect(gearStat(actor, 'attunement').value).toBe('1/3');
  });

  it('row weight respects system.weight.units (metric worlds)', () => {
    const metric: FoundryItemDoc = {
      _id: 'MetricCrate0001',
      name: 'Crate',
      type: 'loot',
      system: { quantity: 2, weight: { value: 3, units: 'kg' }, container: null },
    };
    const actor = withItems(martialCaptured, [metric]);
    expect(inventoryRow(actor, 'Crate').sub).toContain('2 × 3 kg');
  });

  it('carried weight sums per unit and never mixes kg into an lb total', () => {
    const metric: FoundryItemDoc = {
      _id: 'MetricCrate0002',
      name: 'Crate',
      type: 'loot',
      system: { quantity: 1, weight: { value: 5, units: 'kg' }, container: null },
    };
    const actor = withItems(martialCaptured, [metric]);
    const value = String(gearStat(actor, 'weight').value);
    expect(value).toMatch(/ lb \+ 5 kg$/);
  });

  it('a non-default attunement max is read from the actor (not the fallback)', () => {
    const actor = withItems(
      {
        ...martialCaptured,
        system: {
          ...martialCaptured.system,
          attributes: { ...(martialCaptured.system as Record<string, any>).attributes, attunement: { max: 5 } },
        },
      } as FoundryActorDoc,
      [cloak(true)],
    );
    expect(gearStat(actor, 'attunement').value).toBe('1/5');
  });
});
