/**
 * dnd5e SystemAdapter (PLAN.md M2, §6, §7).
 *
 * Data paths are pinned to dnd5e system **5.3.3** on Foundry **v13**
 * (see VERSIONS.md) and covered by fixture tests.
 *
 * Write allow-list (PLAN §7) — everything else is read-only:
 *   - hp.value + hp.temp
 *   - death saves (success/failure, 0..3)
 *   - hit dice remaining (per denomination; backed by class items'
 *     `system.hd.spent`)
 *   - spell slot values, not max (`system.spells.spell1..9.value`,
 *     `system.spells.pact.value`)
 *   - item quantity (`system.quantity`) and item uses/charges
 *     (dnd5e 5.x: `system.uses.spent` + `system.uses.max`;
 *     remaining = max − spent; we write `spent`)
 *   - currency (`system.currency.pp/gp/ep/sp/cp`)
 *
 * Derived values: the relay may serialize source data without Foundry's
 * derived fields. We read derived paths when present (`abilities.X.mod`,
 * `skills.X.total`, `attributes.ac.value`, `attributes.prof`,
 * `attributes.init.total`, `spells.spellN.max`) and otherwise fall back to
 * floor((score−10)/2) ability mods and prof = 2 + floor((level−1)/4).
 * This fallback is presentation-only — NOT a rules engine.
 */
import type {
  ActionDescriptor,
  ActionIntent,
  AdapterIO,
  Condition,
  EffectPayload,
  FoundryActorDoc,
  FoundryItemDoc,
  FoundryUpdate,
  LibraryCollection,
  ListItem,
  RelayAction,
  ResourceDescriptor,
  ResourceIntent,
  SheetSection,
  SheetViewModel,
  Stat,
  SystemAdapter,
} from '@companion/adapter-sdk';
import { IntentError, clamp } from '@companion/adapter-sdk';

// ---------------------------------------------------------------------------
// Small safe-access helpers (raw documents are untyped `Record<string, unknown>`)

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
}

function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Rec)[part];
  }
  return cur;
}

function numAt(root: unknown, path: string): number | undefined {
  const v = getPath(root, path);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function strAt(root: unknown, path: string): string | undefined {
  const v = getPath(root, path);
  return typeof v === 'string' ? v : undefined;
}

function signed(n: number): string {
  return n < 0 ? String(n) : `+${n}`;
}

function ordinal(n: number): string {
  if (n === 1) return '1st';
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  return `${n}th`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// dnd5e 5.3.3 vocabulary (labels only — no game-rules content)

const ABILITIES = [
  { id: 'str', label: 'Strength' },
  { id: 'dex', label: 'Dexterity' },
  { id: 'con', label: 'Constitution' },
  { id: 'int', label: 'Intelligence' },
  { id: 'wis', label: 'Wisdom' },
  { id: 'cha', label: 'Charisma' },
] as const;

const SKILLS = [
  { id: 'acr', label: 'Acrobatics', ability: 'dex' },
  { id: 'ani', label: 'Animal Handling', ability: 'wis' },
  { id: 'arc', label: 'Arcana', ability: 'int' },
  { id: 'ath', label: 'Athletics', ability: 'str' },
  { id: 'dec', label: 'Deception', ability: 'cha' },
  { id: 'his', label: 'History', ability: 'int' },
  { id: 'ins', label: 'Insight', ability: 'wis' },
  { id: 'itm', label: 'Intimidation', ability: 'cha' },
  { id: 'inv', label: 'Investigation', ability: 'int' },
  { id: 'med', label: 'Medicine', ability: 'wis' },
  { id: 'nat', label: 'Nature', ability: 'int' },
  { id: 'prc', label: 'Perception', ability: 'wis' },
  { id: 'prf', label: 'Performance', ability: 'cha' },
  { id: 'per', label: 'Persuasion', ability: 'cha' },
  { id: 'rel', label: 'Religion', ability: 'int' },
  { id: 'slt', label: 'Sleight of Hand', ability: 'dex' },
  { id: 'ste', label: 'Stealth', ability: 'dex' },
  { id: 'sur', label: 'Survival', ability: 'wis' },
] as const;

const SPELL_SCHOOLS: Record<string, string> = {
  abj: 'Abjuration',
  con: 'Conjuration',
  div: 'Divination',
  enc: 'Enchantment',
  evo: 'Evocation',
  ill: 'Illusion',
  nec: 'Necromancy',
  trs: 'Transmutation',
};

/** dnd5e 5.3.3 `traits.languages.value` ids (M11) — labels only. */
const LANGUAGES: Record<string, string> = {
  common: 'Common',
  dwarvish: 'Dwarvish',
  elvish: 'Elvish',
  goblin: 'Goblin',
  draconic: 'Draconic',
  orc: 'Orc',
  giant: 'Giant',
  gnomish: 'Gnomish',
  halfling: 'Halfling',
  infernal: 'Infernal',
  abyssal: 'Abyssal',
  celestial: 'Celestial',
  primordial: 'Primordial',
  sylvan: 'Sylvan',
  undercommon: 'Undercommon',
  deep: 'Deep Speech',
  druidic: 'Druidic',
  cant: "Thieves' Cant",
};

/** dnd5e `traits.armorProf.value` ids (M11). */
const ARMOR_PROFICIENCIES: Record<string, string> = {
  lgt: 'Light Armor',
  med: 'Medium Armor',
  hvy: 'Heavy Armor',
  shl: 'Shields',
};

/** dnd5e `traits.weaponProf.value` ids (M11). */
const WEAPON_PROFICIENCIES: Record<string, string> = {
  sim: 'Simple Weapons',
  mar: 'Martial Weapons',
};

/**
 * dnd5e 5.3.3 `system.tools` record keys whose id doesn't capitalize into a
 * readable name (truncations and possessives); everything else falls back to
 * capitalize(). Tools do NOT live under traits.toolProf on 5.x.
 */
const TOOL_LABELS: Record<string, string> = {
  alchemist: "Alchemist's Supplies",
  brewer: "Brewer's Supplies",
  calligrapher: "Calligrapher's Supplies",
  carpenter: "Carpenter's Tools",
  cartographer: "Cartographer's Tools",
  cobbler: "Cobbler's Tools",
  cook: "Cook's Utensils",
  glassblower: "Glassblower's Tools",
  jeweler: "Jeweler's Tools",
  leatherworker: "Leatherworker's Tools",
  mason: "Mason's Tools",
  painter: "Painter's Supplies",
  potter: "Potter's Tools",
  smith: "Smith's Tools",
  tinker: "Tinker's Tools",
  weaver: "Weaver's Tools",
  woodcarver: "Woodcarver's Tools",
  disg: 'Disguise Kit',
  forg: 'Forgery Kit',
  herb: 'Herbalism Kit',
  navg: "Navigator's Tools",
  pois: "Poisoner's Kit",
  thief: "Thieves' Tools",
  card: 'Playing Card Set',
  dice: 'Dice Set',
};

/** `traits.dr/di/dv.bypasses` weapon-property ids that void the defense. */
const BYPASS_LABELS: Record<string, string> = {
  mgc: 'magical',
  ada: 'adamantine',
  sil: 'silvered',
};

const PHYSICAL_ITEM_TYPES = new Set(['weapon', 'equipment', 'consumable', 'tool', 'container', 'loot']);

/** dnd5e equipment `system.type.value`s that are armor/shield (equippable). */
const ARMOR_EQUIPMENT_TYPES = new Set(['light', 'medium', 'heavy', 'natural', 'shield']);

const CURRENCIES = [
  { id: 'pp', label: 'Platinum (pp)' },
  { id: 'gp', label: 'Gold (gp)' },
  { id: 'ep', label: 'Electrum (ep)' },
  { id: 'sp', label: 'Silver (sp)' },
  { id: 'cp', label: 'Copper (cp)' },
] as const;

// ---------------------------------------------------------------------------
// Actor readers

interface ClassInfo {
  itemId: string;
  name: string;
  levels: number;
  /** e.g. "d10" — class item `system.hd.denomination` */
  denomination: string;
  /** class item `system.hd.spent` */
  used: number;
  remaining: number;
}

function classItems(actor: FoundryActorDoc): ClassInfo[] {
  return (actor.items ?? [])
    .filter((i) => i.type === 'class')
    .map((i) => {
      const levels = numAt(i.system, 'levels') ?? 1;
      const denomination = strAt(i.system, 'hd.denomination') ?? 'd8';
      const used = numAt(i.system, 'hd.spent') ?? 0;
      return { itemId: i._id, name: i.name, levels, denomination, used, remaining: Math.max(0, levels - used) };
    });
}

function characterLevel(actor: FoundryActorDoc): number {
  const derived = numAt(actor.system, 'details.level');
  if (derived !== undefined) return derived;
  return classItems(actor).reduce((sum, c) => sum + c.levels, 0);
}

/** Presentation fallback, not a rules engine (see file header). */
function proficiency(actor: FoundryActorDoc): number {
  const derived = numAt(actor.system, 'attributes.prof');
  if (derived !== undefined) return derived;
  const level = Math.max(1, characterLevel(actor));
  return 2 + Math.floor((level - 1) / 4);
}

function abilityScore(system: unknown, id: string): number {
  return numAt(system, `abilities.${id}.value`) ?? 10;
}

function abilityMod(system: unknown, id: string): number {
  const derived = numAt(system, `abilities.${id}.mod`);
  if (derived !== undefined) return derived;
  return Math.floor((abilityScore(system, id) - 10) / 2);
}

function armorClass(actor: FoundryActorDoc): number {
  const derived = numAt(actor.system, 'attributes.ac.value');
  if (derived !== undefined) return derived;
  const flat = numAt(actor.system, 'attributes.ac.flat');
  if (flat !== undefined) return flat;
  // Presentation fallback from the actor's own equipped items (the relay
  // serializes source data without derived AC): dnd5e "default" calc =
  // armor base + dex capped by armor.dex, +2-style shield bonus, else
  // unarmored 10 + dex.
  const dex = abilityMod(actor.system, 'dex');
  let base: number | undefined;
  let shield = 0;
  for (const item of actor.items ?? []) {
    if (item.type !== 'equipment' || getPath(item.system, 'equipped') !== true) continue;
    const armor = rec(getPath(item.system, 'armor'));
    const value = typeof armor.value === 'number' && Number.isFinite(armor.value) ? armor.value : undefined;
    if (value === undefined) continue;
    const typeVal = strAt(item.system, 'type.value');
    if (typeVal === 'shield') {
      shield += value;
    } else {
      const dexCap = typeof armor.dex === 'number' && Number.isFinite(armor.dex) ? armor.dex : undefined;
      base = value + (dexCap === undefined ? dex : Math.min(dex, dexCap));
    }
  }
  return (base ?? 10 + dex) + shield;
}

function initiative(actor: FoundryActorDoc): number {
  const derived = numAt(actor.system, 'attributes.init.total');
  if (derived !== undefined) return derived;
  const rawBonus = getPath(actor.system, 'attributes.init.bonus');
  let bonus = 0;
  if (typeof rawBonus === 'number' && Number.isFinite(rawBonus)) bonus = rawBonus;
  else if (typeof rawBonus === 'string' && rawBonus.trim() !== '') {
    const n = Number(rawBonus);
    if (Number.isFinite(n)) bonus = n;
  }
  return abilityMod(actor.system, 'dex') + bonus;
}

/**
 * dnd5e 5.x item uses: `system.uses.spent` (number) + `system.uses.max`
 * (number when derived, formula string in source data — plain numeric
 * strings are accepted, anything else means "no uses").
 */
function usesInfo(item: FoundryItemDoc): { spent: number; max: number } | undefined {
  const uses = rec(getPath(item.system, 'uses'));
  const rawMax = uses.max;
  let max: number | undefined;
  if (typeof rawMax === 'number' && Number.isFinite(rawMax)) max = rawMax;
  else if (typeof rawMax === 'string' && rawMax.trim() !== '') {
    const n = Number(rawMax);
    if (Number.isFinite(n)) max = n;
  }
  if (max === undefined || max <= 0) return undefined;
  const spent = typeof uses.spent === 'number' && Number.isFinite(uses.spent) ? uses.spent : 0;
  return { spent, max };
}

const RECOVERY_LABELS: Record<string, string> = {
  sr: 'short rest',
  lr: 'long rest',
};

/** A friendly recharge-period string for an item's first uses-recovery
 *  entry (e.g. "dawn", "short rest"), or undefined when the item has no
 *  recovery period (most consumables — single-use, destroyed on use). */
function recoveryLabel(item: FoundryItemDoc): string | undefined {
  const recovery = getPath(item.system, 'uses.recovery');
  if (!Array.isArray(recovery) || recovery.length === 0) return undefined;
  const period = rec(recovery[0]).period;
  if (typeof period !== 'string' || period === '') return undefined;
  return RECOVERY_LABELS[period] ?? period;
}

interface SlotInfo {
  id: string;
  label: string;
  value: number;
  max: number;
  /** spell level this pool casts at (pips UI); pact omits it when the actor
   *  document carries no `spells.pact.level` (enrich merges it in). */
  castsAt?: number;
}

/** Present slot levels (max or current > 0) plus pact slots. */
function spellSlots(actor: FoundryActorDoc): SlotInfo[] {
  const out: SlotInfo[] = [];
  for (let lvl = 1; lvl <= 9; lvl++) {
    const slot = rec(getPath(actor.system, `spells.spell${lvl}`));
    const value = typeof slot.value === 'number' && Number.isFinite(slot.value) ? slot.value : 0;
    // max is derived; source data only has `override`. Fall back so bounds
    // never clamp below the current value.
    const max =
      (typeof slot.max === 'number' && Number.isFinite(slot.max) ? slot.max : undefined) ??
      (typeof slot.override === 'number' && Number.isFinite(slot.override) ? slot.override : undefined) ??
      value;
    if (max > 0 || value > 0) {
      out.push({
        id: `slots.${lvl}`,
        label: `${ordinal(lvl)}-Level Slots`,
        value,
        max: Math.max(max, value),
        castsAt: lvl,
      });
    }
  }
  const pact = rec(getPath(actor.system, 'spells.pact'));
  const pactValue = typeof pact.value === 'number' && Number.isFinite(pact.value) ? pact.value : 0;
  const pactMax =
    (typeof pact.max === 'number' && Number.isFinite(pact.max) ? pact.max : undefined) ??
    (typeof pact.override === 'number' && Number.isFinite(pact.override) ? pact.override : undefined) ??
    pactValue;
  if (pactMax > 0 || pactValue > 0) {
    const pactLevel = numAt(actor.system, 'spells.pact.level');
    out.push({
      id: 'slots.pact',
      label: 'Pact Slots',
      value: pactValue,
      max: Math.max(pactMax, pactValue),
      ...(pactLevel !== undefined ? { castsAt: pactLevel } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resource descriptors (the write allow-list, as data)

function buildResources(actor: FoundryActorDoc): ResourceDescriptor[] {
  const sys = actor.system;
  const out: ResourceDescriptor[] = [];

  const hpValue = numAt(sys, 'attributes.hp.value') ?? 0;
  const hpMax = numAt(sys, 'attributes.hp.max') ?? hpValue;
  out.push({ id: 'hp', label: 'Hit Points', value: hpValue, min: 0, max: hpMax, writable: true, group: 'vitals' });
  out.push({
    id: 'hp.temp',
    label: 'Temporary HP',
    value: numAt(sys, 'attributes.hp.temp') ?? 0,
    min: 0,
    writable: true,
    group: 'vitals',
  });
  out.push({
    id: 'deathsaves.success',
    label: 'Death Save Successes',
    value: numAt(sys, 'attributes.death.success') ?? 0,
    min: 0,
    max: 3,
    writable: true,
    group: 'vitals',
  });
  out.push({
    id: 'deathsaves.failure',
    label: 'Death Save Failures',
    value: numAt(sys, 'attributes.death.failure') ?? 0,
    min: 0,
    max: 3,
    writable: true,
    group: 'vitals',
  });

  // Hit dice per denomination, aggregated over class items.
  const byDenom = new Map<string, { remaining: number; max: number }>();
  for (const c of classItems(actor)) {
    const agg = byDenom.get(c.denomination) ?? { remaining: 0, max: 0 };
    agg.remaining += c.remaining;
    agg.max += c.levels;
    byDenom.set(c.denomination, agg);
  }
  const denoms = [...byDenom.entries()].sort(
    (a, b) => Number(b[0].slice(1)) - Number(a[0].slice(1)) || a[0].localeCompare(b[0]),
  );
  for (const [denom, agg] of denoms) {
    out.push({
      id: `hitdice.${denom}`,
      label: `Hit Dice (${denom})`,
      value: agg.remaining,
      min: 0,
      max: agg.max,
      writable: true,
      group: 'vitals',
    });
  }

  // Inspiration is a boolean in dnd5e; surfaced as a 0/1 toggle resource.
  out.push({
    id: 'inspiration',
    label: 'Inspiration',
    value: getPath(sys, 'attributes.inspiration') === true ? 1 : 0,
    min: 0,
    max: 1,
    writable: true,
    group: 'vitals',
  });
  out.push({
    id: 'exhaustion',
    label: 'Exhaustion',
    value: numAt(sys, 'attributes.exhaustion') ?? 0,
    min: 0,
    max: 6,
    writable: true,
    group: 'vitals',
  });

  for (const slot of spellSlots(actor)) {
    out.push({
      id: slot.id,
      label: slot.label,
      value: slot.value,
      min: 0,
      max: slot.max,
      writable: true,
      group: 'slots',
      ...(slot.castsAt !== undefined ? { level: slot.castsAt } : {}),
    });
  }

  for (const item of actor.items ?? []) {
    if (PHYSICAL_ITEM_TYPES.has(item.type)) {
      out.push({
        id: `item.${item._id}.qty`,
        label: `${item.name} (quantity)`,
        value: numAt(item.system, 'quantity') ?? 1,
        min: 0,
        writable: true,
        group: 'inventory',
      });
    }
    const uses = usesInfo(item);
    if (uses) {
      out.push({
        id: `item.${item._id}.uses`,
        label: `${item.name} (uses)`,
        value: Math.max(0, uses.max - uses.spent),
        min: 0,
        max: uses.max,
        writable: true,
        group: 'inventory',
      });
    }
  }

  for (const c of CURRENCIES) {
    out.push({
      id: `currency.${c.id}`,
      label: c.label,
      value: numAt(sys, `currency.${c.id}`) ?? 0,
      min: 0,
      writable: true,
      group: 'currency',
    });
  }

  // Read-only tracked value: on the sheet, but never writable via intents.
  out.push({ id: 'ac', label: 'Armor Class', value: armorClass(actor), writable: false });

  return out;
}

// ---------------------------------------------------------------------------
// buildUpdate — intent -> concrete Foundry update

function buildUpdate(actor: FoundryActorDoc, intent: ResourceIntent): FoundryUpdate {
  const descriptor = buildResources(actor).find((r) => r.id === intent.resourceId);
  if (!descriptor) {
    throw new IntentError(`unknown resource "${intent.resourceId}"`, 'UNKNOWN_RESOURCE');
  }
  if (!descriptor.writable) {
    throw new IntentError(`resource "${intent.resourceId}" is read-only`, 'READ_ONLY');
  }
  const operand = intent.kind === 'set' ? intent.value : intent.amount;
  if (typeof operand !== 'number' || !Number.isInteger(operand)) {
    throw new IntentError(`intent ${intent.kind} requires a finite integer`, 'INVALID');
  }
  const raw = intent.kind === 'set' ? intent.value : descriptor.value + intent.amount;
  const target = clamp(raw, descriptor.min, descriptor.max);
  const id = intent.resourceId;

  if (id === 'hp') {
    // dnd5e rule: damage drains temporary HP before hp.value. This only
    // applies to `delta` intents with a negative amount (damage) — that's
    // the only shape the PWA's "− Damage" / stepper controls ever send for
    // hp. A `set` intent is a direct, literal write (e.g. GM/admin tooling)
    // and intentionally bypasses temp-HP absorption — see the "hp set is a
    // direct, literal write" test.
    if (intent.kind === 'delta' && intent.amount < 0) {
      const damage = -intent.amount;
      const currentTemp = numAt(actor.system, 'attributes.hp.temp') ?? 0;
      const tempAbsorbed = Math.min(currentTemp, damage);
      const remaining = damage - tempAbsorbed;
      const newValue = clamp(descriptor.value - remaining, descriptor.min, descriptor.max);
      return tempAbsorbed > 0
        ? {
            data: {
              'system.attributes.hp.value': newValue,
              'system.attributes.hp.temp': currentTemp - tempAbsorbed,
            },
          }
        : { data: { 'system.attributes.hp.value': newValue } };
    }
    return { data: { 'system.attributes.hp.value': target } };
  }
  if (id === 'hp.temp') return { data: { 'system.attributes.hp.temp': target } };
  if (id === 'deathsaves.success') return { data: { 'system.attributes.death.success': target } };
  if (id === 'deathsaves.failure') return { data: { 'system.attributes.death.failure': target } };
  if (id === 'slots.pact') return { data: { 'system.spells.pact.value': target } };
  // dnd5e stores inspiration as a boolean; the 0/1 resource maps onto it.
  if (id === 'inspiration') return { data: { 'system.attributes.inspiration': target === 1 } };
  if (id === 'exhaustion') return { data: { 'system.attributes.exhaustion': target } };

  const slotMatch = /^slots\.([1-9])$/.exec(id);
  if (slotMatch) return { data: { [`system.spells.spell${slotMatch[1]}.value`]: target } };

  const currencyMatch = /^currency\.(pp|gp|ep|sp|cp)$/.exec(id);
  if (currencyMatch) return { data: { [`system.currency.${currencyMatch[1]}`]: target } };

  const itemMatch = /^item\.(.+)\.(qty|uses)$/.exec(id);
  if (itemMatch) {
    const itemId = itemMatch[1] as string;
    if (itemMatch[2] === 'qty') return { itemId, data: { 'system.quantity': target } };
    // "uses" resources carry *remaining* semantics (delta -1 = spend one
    // charge); dnd5e 5.x stores spent, so write spent = max - remaining.
    return { itemId, data: { 'system.uses.spent': (descriptor.max ?? 0) - target } };
  }

  if (id.startsWith('hitdice.')) {
    return buildHitDiceUpdate(actor, id.slice('hitdice.'.length), descriptor.value, target);
  }

  // A descriptor id we created but forgot to map — a programming error.
  throw new IntentError(`resource "${id}" has no write mapping`, 'INVALID');
}

/**
 * Map an aggregate "remaining hit dice of denomination X" change onto ONE
 * class item's `system.hd.spent` (FoundryUpdate targets a single item):
 * spend from the class with the most remaining dice, regain to the class
 * with the most used dice (ties: higher class level, then item id). If the
 * chosen class cannot absorb the whole diff, the change is partially
 * applied — fine in practice, since players spend/regain one die at a time.
 */
function buildHitDiceUpdate(actor: FoundryActorDoc, denomination: string, current: number, target: number): FoundryUpdate {
  const classes = classItems(actor).filter((c) => c.denomination === denomination);
  const diff = target - current;
  let chosen: ClassInfo | undefined;
  let newUsed: number;
  if (diff < 0) {
    chosen = [...classes].sort(
      (a, b) => b.remaining - a.remaining || b.levels - a.levels || a.itemId.localeCompare(b.itemId),
    )[0];
    if (!chosen) throw new IntentError(`no class items with ${denomination} hit dice`, 'INVALID');
    newUsed = chosen.used + Math.min(-diff, chosen.remaining);
  } else if (diff > 0) {
    chosen = [...classes].sort(
      (a, b) => b.used - a.used || b.levels - a.levels || a.itemId.localeCompare(b.itemId),
    )[0];
    if (!chosen) throw new IntentError(`no class items with ${denomination} hit dice`, 'INVALID');
    newUsed = chosen.used - Math.min(diff, chosen.used);
  } else {
    chosen = classes[0];
    if (!chosen) throw new IntentError(`no class items with ${denomination} hit dice`, 'INVALID');
    newUsed = chosen.used;
  }
  return { itemId: chosen.itemId, data: { 'system.hd.spent': newUsed } };
}

// ---------------------------------------------------------------------------
// View model

/** All movement modes (§1 "speeds"): walk always shown, others when > 0. */
const MOVEMENT_MODES = ['walk', 'fly', 'swim', 'climb', 'burrow'] as const;

function speedLine(actor: FoundryActorDoc): string {
  // The relay serializes source data: actor movement modes may be absent
  // (derived from the race item, where values are formula strings like "30").
  const race = (actor.items ?? []).find((i) => i.type === 'race');
  const modeValue = (mode: string): number => {
    const own = numAt(actor.system, `attributes.movement.${mode}`);
    if (own !== undefined) return own;
    const raw = race ? getPath(race.system, `movement.${mode}`) : undefined;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim() !== '') {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  };
  const units =
    strAt(actor.system, 'attributes.movement.units') ??
    (race ? strAt(race.system, 'movement.units') : undefined) ??
    'ft';
  const parts: string[] = [];
  for (const mode of MOVEMENT_MODES) {
    const v = modeValue(mode);
    if (mode === 'walk') parts.push(`${v} ${units}`);
    else if (v > 0) parts.push(`${mode} ${v} ${units}`);
  }
  if (getPath(actor.system, 'attributes.movement.hover') === true) parts.push('hover');
  return parts.join(' · ');
}

function abilityStats(actor: FoundryActorDoc): Stat[] {
  return ABILITIES.map((a) => {
    // Save proficiency marker (M14) goes on the LABEL — the PWA's ability
    // gems render `sub` as the large modifier text, so sub must stay a bare
    // modifier. Threshold mirrors saveBonus (>= 1, not === 1): whatever
    // rolls with proficiency must show the marker.
    const saveProf = (numAt(actor.system, `abilities.${a.id}.proficient`) ?? 0) >= 1;
    return {
      id: `ability.${a.id}`,
      label: saveProf ? `${a.label} ●` : a.label,
      value: abilityScore(actor.system, a.id),
      sub: signed(abilityMod(actor.system, a.id)),
      actionId: `ability.${a.id}.check`,
      ...biasFields(rollBias(actor, 'check', a.id)),
    };
  });
}

/** Skill total + provenance shared by the view model and buildAction so the
 * rolled bonus is exactly what the sheet shows (derived total preferred,
 * fallback = ability mod + prof multiplier). */
function skillInfo(actor: FoundryActorDoc, s: { id: string; ability: string }): { total: number; ability: string; profMult: number } {
  const skill = rec(getPath(actor.system, `skills.${s.id}`));
  const ability = typeof skill.ability === 'string' && skill.ability !== '' ? skill.ability : s.ability;
  const profMult = typeof skill.value === 'number' && Number.isFinite(skill.value) ? skill.value : 0;
  const derivedTotal = typeof skill.total === 'number' && Number.isFinite(skill.total) ? skill.total : undefined;
  const total = derivedTotal ?? abilityMod(actor.system, ability) + Math.floor(profMult * proficiency(actor));
  return { total, ability, profMult };
}

/** The three passive senses DDB-style sheets surface (M10). */
const PASSIVE_SKILLS = [
  { id: 'prc', label: 'Passive Perception', ability: 'wis' },
  { id: 'inv', label: 'Passive Investigation', ability: 'int' },
  { id: 'ins', label: 'Passive Insight', ability: 'wis' },
] as const;

/** Numeric value of a dnd5e bonus/formula field when it is a plain number
 * (source data stores strings like "5" or ""); dice formulas -> undefined. */
function numericBonus(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** True when a dnd5e advantage/disadvantage flag counts as set (Foundry
 *  writes "1", true, or 1). */
function isFlagSet(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s !== '' && s !== '0' && s !== 'false';
  }
  return false;
}

/** Any equipped equipment whose dnd5e properties impose stealth disadvantage. */
function hasStealthDisadvantageArmor(actor: FoundryActorDoc): boolean {
  for (const item of actor.items ?? []) {
    if (item.type !== 'equipment') continue;
    if (getPath(item.system, 'equipped') !== true) continue;
    const props = getPath(item.system, 'properties');
    if (Array.isArray(props) && props.includes('stealthDisadvantage')) return true;
  }
  return false;
}

/**
 * Passive advantage/disadvantage indicator for a d20 roll row. DISPLAY-ONLY:
 * never applied to the rolled formula, because other effects can flip the net.
 * OR of dnd5e bonus flags, the per-roll `roll.mode` override, and (Stealth
 * only) equipped stealth-disadvantage armor.
 */
function rollBias(
  actor: FoundryActorDoc,
  kind: 'skill' | 'check' | 'save',
  id: string,
): { advantage: boolean; disadvantage: boolean } {
  const flagPaths = (dir: 'advantage' | 'disadvantage'): string[] => {
    const base = `flags.dnd5e.${dir}`;
    if (kind === 'skill') return [`${base}.all`, `${base}.skill.all`, `${base}.skill.${id}`];
    if (kind === 'check')
      return [`${base}.all`, `${base}.ability.all`, `${base}.ability.check.all`, `${base}.ability.check.${id}`];
    return [`${base}.all`, `${base}.ability.all`, `${base}.ability.save.all`, `${base}.ability.save.${id}`];
  };
  let advantage = flagPaths('advantage').some((p) => isFlagSet(getPath(actor, p)));
  let disadvantage = flagPaths('disadvantage').some((p) => isFlagSet(getPath(actor, p)));

  const modePath =
    kind === 'skill'
      ? `skills.${id}.roll.mode`
      : kind === 'check'
        ? `abilities.${id}.check.roll.mode`
        : `abilities.${id}.save.roll.mode`;
  const mode = numAt(actor.system, modePath);
  if (mode === 1) advantage = true;
  else if (mode === -1) disadvantage = true;

  if (kind === 'skill' && id === 'ste' && hasStealthDisadvantageArmor(actor)) disadvantage = true;

  return { advantage, disadvantage };
}

/** Emit advantage/disadvantage ONLY when set, so unaffected stat rows stay
 *  byte-identical to before this feature. */
function biasFields(bias: { advantage: boolean; disadvantage: boolean }): {
  advantage?: true;
  disadvantage?: true;
} {
  return {
    ...(bias.advantage ? { advantage: true as const } : {}),
    ...(bias.disadvantage ? { disadvantage: true as const } : {}),
  };
}

function passiveStats(actor: FoundryActorDoc): Stat[] {
  return PASSIVE_SKILLS.map((p) => {
    // Derived `skills.<id>.passive` when serialized, else dnd5e's formula:
    // 10 + skill total + bonuses.passive + 5 * roll.mode (adv +5 / dis -5).
    const derived = numAt(actor.system, `skills.${p.id}.passive`);
    if (derived !== undefined) return { id: `passive.${p.id}`, label: p.label, value: derived };
    const bonus = numericBonus(getPath(actor.system, `skills.${p.id}.bonuses.passive`)) ?? 0;
    const mode = numAt(actor.system, `skills.${p.id}.roll.mode`) ?? 0;
    return { id: `passive.${p.id}`, label: p.label, value: 10 + skillInfo(actor, p).total + bonus + 5 * mode };
  });
}

/** One stat per set sense range ("Darkvision 60 ft"); empty when none.
 * Like speedLine: the relay serializes source data where race-granted senses
 * live on the race item (possibly as numeric strings) and the actor's own
 * ranges are null overrides — so fall back to the race item per mode. */
function senseStats(actor: FoundryActorDoc): Stat[] {
  const senses = rec(getPath(actor.system, 'attributes.senses'));
  const ranges = rec(senses.ranges);
  const race = (actor.items ?? []).find((i) => i.type === 'race');
  const raceSenses = race ? rec(getPath(race.system, 'senses')) : {};
  const raceRanges = rec(raceSenses.ranges);
  const units =
    (typeof senses.units === 'string' && senses.units !== '' ? senses.units : undefined) ??
    (typeof raceSenses.units === 'string' && raceSenses.units !== '' ? raceSenses.units : undefined) ??
    'ft';
  const modeValue = (mode: string): number => {
    const own = ranges[mode];
    if (typeof own === 'number' && Number.isFinite(own)) return own;
    return numericBonus(raceRanges[mode]) ?? 0;
  };
  const out: Stat[] = [];
  for (const mode of new Set([...Object.keys(ranges), ...Object.keys(raceRanges)])) {
    const v = modeValue(mode);
    if (v <= 0) continue;
    out.push({
      id: `sense.${mode}`,
      label: mode.charAt(0).toUpperCase() + mode.slice(1),
      value: `${v} ${units}`,
    });
  }
  return out;
}

/**
 * The label list for one `traits.<key>` category (M11): `.value` ids mapped
 * through the vocab (unknown ids capitalized), plus the free-text `.custom`
 * string when asked for (dr/di/dv/ci carry player-written entries there).
 * Empty array = category absent from the sheet.
 */
function traitLabels(
  actor: FoundryActorDoc,
  key: string,
  vocab: Record<string, string> = {},
  includeCustom = false,
): string[] {
  const trait = rec(getPath(actor.system, `traits.${key}`));
  const value = Array.isArray(trait.value) ? trait.value : [];
  const out = value
    .filter((id): id is string => typeof id === 'string' && id !== '')
    .map((id) => vocab[id] ?? capitalize(id));
  if (includeCustom && typeof trait.custom === 'string' && trait.custom.trim() !== '') {
    out.push(trait.custom.trim());
  }
  return out;
}

/**
 * Tool proficiencies (M11): dnd5e 5.x stores them at top-level
 * `system.tools`, a record keyed by tool id with a proficiency multiplier
 * `value` — NOT under traits.toolProf (pre-2.x path that no longer exists).
 */
function toolLabels(actor: FoundryActorDoc): string[] {
  const tools = rec(getPath(actor.system, 'tools'));
  return Object.entries(tools)
    .filter(([, entry]) => (typeof rec(entry).value === 'number' ? (rec(entry).value as number) > 0 : true))
    .map(([id]) => TOOL_LABELS[id] ?? capitalize(id))
    .sort((a, b) => a.localeCompare(b));
}

/** " (except magical, silvered)" when a defense carries bypasses. */
function bypassSuffix(actor: FoundryActorDoc, key: string): string {
  const raw = getPath(actor.system, `traits.${key}.bypasses`);
  const ids = Array.isArray(raw) ? raw.filter((b): b is string => typeof b === 'string' && b !== '') : [];
  if (ids.length === 0) return '';
  return ` (except ${ids.map((b) => BYPASS_LABELS[b] ?? capitalize(b)).join(', ')})`;
}

/** One Stat per non-empty proficiency/trait category (M11); read-only. */
function traitStats(actor: FoundryActorDoc): Stat[] {
  // Every category includes its free-text `.custom` — homebrew languages and
  // proficiencies typed into the Foundry sheet must not vanish on the phone.
  const categories: Array<{ id: string; label: string; values: string[]; suffix?: string }> = [
    { id: 'languages', label: 'Languages', values: traitLabels(actor, 'languages', LANGUAGES, true) },
    { id: 'armor', label: 'Armor', values: traitLabels(actor, 'armorProf', ARMOR_PROFICIENCIES, true) },
    { id: 'weapons', label: 'Weapons', values: traitLabels(actor, 'weaponProf', WEAPON_PROFICIENCIES, true) },
    { id: 'tools', label: 'Tools', values: toolLabels(actor) },
    { id: 'dr', label: 'Resistances', values: traitLabels(actor, 'dr', {}, true), suffix: bypassSuffix(actor, 'dr') },
    { id: 'di', label: 'Immunities', values: traitLabels(actor, 'di', {}, true), suffix: bypassSuffix(actor, 'di') },
    {
      id: 'dv',
      label: 'Vulnerabilities',
      values: traitLabels(actor, 'dv', {}, true),
      suffix: bypassSuffix(actor, 'dv'),
    },
    { id: 'ci', label: 'Condition Immunities', values: traitLabels(actor, 'ci', {}, true) },
  ];
  return categories
    .filter((c) => c.values.length > 0)
    .map((c) => ({ id: `trait.${c.id}`, label: c.label, value: c.values.join(', ') + (c.suffix ?? '') }));
}

/** The five personality one-liners rendered under the biography (M11). */
const PERSONALITY_FIELDS = [
  { id: 'trait', label: 'Personality' },
  { id: 'ideal', label: 'Ideal' },
  { id: 'bond', label: 'Bond' },
  { id: 'flaw', label: 'Flaw' },
  { id: 'appearance', label: 'Appearance' },
] as const;

/**
 * Read-only "Character" rows (M11): the biography HTML as a detail row
 * (content from the user's OWN world; the client sanitizes, same pipeline as
 * item details) plus personality one-liners. Empty sources are omitted; an
 * empty array means the whole section is omitted. Render-only — biography
 * editing from the phone is a non-goal (roadmap §M11).
 */
function biographyItems(actor: FoundryActorDoc): ListItem[] {
  const out: ListItem[] = [];
  const bio = strAt(actor.system, 'details.biography.value');
  // Editor-empty HTML ("<p></p>", stray &nbsp;) is not content — strip
  // markup before deciding whether there is anything to read.
  const bioText = (bio ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  if (bio !== undefined && bioText !== '') {
    out.push({ id: 'bio', label: 'Biography', sub: 'Tap to read', detail: resolveEnrichers(bio) });
  }
  for (const f of PERSONALITY_FIELDS) {
    const v = strAt(actor.system, `details.${f.id}`);
    if (v !== undefined && v.trim() !== '') out.push({ id: f.id, label: f.label, sub: v });
  }
  return out;
}

/** Save bonus: derived `abilities.<id>.save.value` when the relay provides
 * it (active-effect bonuses included), else ability mod + prof when
 * save-proficient (`abilities.<id>.proficient` >= 1). Single source of truth
 * for the Saving Throws cards AND buildAbilityRoll — the sheet never shows a
 * number it won't roll. */
function saveBonus(actor: FoundryActorDoc, abilityId: string): number {
  const derived = numAt(actor.system, `abilities.${abilityId}.save.value`);
  if (derived !== undefined) return derived;
  const proficient = numAt(actor.system, `abilities.${abilityId}.proficient`) ?? 0;
  return abilityMod(actor.system, abilityId) + (proficient >= 1 ? proficiency(actor) : 0);
}

/** One card per ability save (2026-07-19), rendered by the PWA's stats-card
 * grid like skills. Marker mirrors abilityStats' threshold (>= 1) and tracks
 * the SOURCE `proficient` flag, not the derived total — an active effect that
 * grants proficiency only inside derived `save.value` shows the higher bonus
 * without the marker, by design (marker = declared proficiency). */
function saveStats(actor: FoundryActorDoc): Stat[] {
  return ABILITIES.map((a) => {
    const proficient = (numAt(actor.system, `abilities.${a.id}.proficient`) ?? 0) >= 1;
    return {
      id: `save.${a.id}`,
      label: a.label,
      value: signed(saveBonus(actor, a.id)),
      ...(proficient ? { sub: '● proficient' } : {}),
      actionId: `ability.${a.id}.save`,
      ...biasFields(rollBias(actor, 'save', a.id)),
    };
  });
}

/** Item types whose descriptions may carry save-advantage prose (live-verified
 * 2026-07-19: racial traits duplicate into race items, War Caster is a feat,
 * Holy Symbol of Ravenkind is equipment). */
const SAVE_NOTE_ITEM_TYPES = new Set(['feat', 'race', 'background', 'equipment', 'weapon']);

/** One qualifying sentence: mentions (dis)advantage AND saving throw(s). */
const SAVE_NOTE_SENTENCE = /[^.!?]*\b(?:dis)?advantage\b[^.!?]*\bsaving throws?\b[^.!?]*[.!?]/gi;

/** The player must be the explicit subject of the (dis)advantage grant
 * ("you have advantage", "…of you have advantage", "you also gain
 * advantage") — also anchors the dedupe key (see saveNoteStats) so a race
 * item's trait-name prefix ("Dwarven Resilience You have advantage…") can't
 * defeat matching against the clean standalone trait feat's sentence. */
const SAVE_NOTE_SUBJECT_GATE = /\byou(?:\s+\w+)?\s+(?:have|gain|get|make)s?\s+(?:dis)?advantage\b/i;

/** Common ddb-importer/Foundry HTML entities seen in item description prose,
 * decoded after tag-strip and before whitespace collapse. Numeric character
 * references (&#8217; etc.) are handled separately via String.fromCodePoint. */
const SAVE_NOTE_ENTITY_MAP: Record<string, string> = {
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * D&D-Beyond-style situational save reminders (2026-07-19). The structured
 * data does NOT exist in dnd5e/ddb-importer documents — the only source is
 * the items' own description prose, so this extracts sentences that say the
 * PLAYER has (dis)advantage on saving throws. Presentation of the user's own
 * world content, exactly like item detail views.
 */
function saveNoteStats(actor: FoundryActorDoc): Stat[] {
  const out: Stat[] = [];
  // key -> index into `out`, so a later shorter duplicate can replace a
  // race-name-prefixed row already emitted (see the dedupe-key comment below).
  const seen = new Map<string, number>();
  for (const item of actor.items ?? []) {
    if (!SAVE_NOTE_ITEM_TYPES.has(item.type)) continue;
    const html = strAt(item.system, 'description.value') ?? '';
    if (html === '') continue;
    // Cheap presence guard on the RAW html, before any normalization: skip
    // items that can't possibly qualify. Deliberately loose single-word
    // tests (not the full "saving throw(s)" phrase) — markup can split the
    // phrase across tags ("saving <em>throws</em>"), which a phrase test
    // would wrongly skip. This also keeps the expensive sentence regex away
    // from its worst-case input: long punctuation-free text containing
    // "advantage" but no "saving", which is the input shape that maximizes
    // backtracking below.
    if (!/advantage/i.test(html) || !/saving/i.test(html)) continue;
    const text = html
      // Enricher tokens keep their human label: @UUID[...]{Poisoned}, &Reference[...]{Charmed}.
      .replace(/[@&][A-Za-z]+\[[^\]]*\]\{([^}]*)\}/g, '$1')
      .replace(/<[^>]*>/g, ' ')
      // Broader entity decoding (2026-07-20): ddb-importer descriptions carry
      // curly quotes/dashes as named entities, plus occasional numeric
      // character references. &amp; is decoded LAST, after this pass, so a
      // doubly-escaped "&amp;rsquo;" decodes to "&rsquo;" first and is left
      // alone rather than being corrupted into a stray "&" + "rsquo;".
      .replace(/&(rsquo|lsquo|rdquo|ldquo|ndash|mdash|quot|apos|nbsp);|&#(\d+);/g, (m, name, code) => {
        // Malformed oversized refs (&#9999999999;) must not throw on the
        // sheet-build hot path — leave them verbatim instead.
        if (code !== undefined) return Number(code) <= 0x10ffff ? String.fromCodePoint(Number(code)) : m;
        return SAVE_NOTE_ENTITY_MAP[name] ?? m;
      })
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ');
    for (const match of text.matchAll(SAVE_NOTE_SENTENCE)) {
      let sentence = match[0];
      const advIndex = sentence.search(/\b(?:dis)?advantage\b/i);
      // List preambles ("…the following benefits: You have advantage…") end
      // at a colon — keep only the clause that carries the advantage.
      const colon = sentence.lastIndexOf(':', advIndex);
      if (colon !== -1) sentence = sentence.slice(colon + 1);
      sentence = sentence.trim();
      // Only the player's own saves: the (dis)advantage must be granted to
      // "you" as its subject. A looser earlier-"you" test wrongly keeps "When
      // you do so, undead have disadvantage…" (Holy Symbol of Ravenkind).
      const gateMatch = SAVE_NOTE_SUBJECT_GATE.exec(sentence);
      if (!gateMatch) continue;
      // Dedupe key starts at the subject-gate match ("you have advantage…"
      // onward), not the full sentence: race items embed the trait name
      // INSIDE the sentence with no colon separator ("Dwarven Resilience You
      // have advantage on saving throws against poison…"), which otherwise
      // defeats matching against the clean standalone trait feat's identical
      // tail (live-verified 2026-07-19: 4/9 party PCs doubled every racial
      // note). Sliced BEFORE the display truncation so the gate index always
      // addresses the string it was matched against.
      const key = sentence.slice(gateMatch.index).toLowerCase();
      if (sentence.length > 200) sentence = `${sentence.slice(0, 199).trimEnd()}…`;
      const existingIndex = seen.get(key);
      if (existingIndex === undefined) {
        seen.set(key, out.length);
        out.push({ id: `savenote.${out.length}`, label: item.name, value: sentence });
        continue;
      }
      const existing = out[existingIndex];
      // A strictly shorter duplicate is the clean feat sentence without the
      // race's name prefix — it wins in place, regardless of item order
      // (race items serialize before their trait feats in live data). Equal
      // length (e.g. both already colon-trimmed to the same clause) keeps
      // the first source, unchanged.
      if (existing && sentence.length < String(existing.value).length) {
        out[existingIndex] = { ...existing, label: item.name, value: sentence };
      }
    }
  }
  return out;
}

function skillStats(actor: FoundryActorDoc): Stat[] {
  return SKILLS.map((s) => {
    const { total, ability, profMult } = skillInfo(actor, s);
    const subParts = [ability.toUpperCase()];
    // Proficiency markers (M14): ◐ half / ● proficient / ◆ expertise.
    if (profMult >= 2) subParts.push('◆ expertise');
    else if (profMult >= 1) subParts.push('● proficient');
    else if (profMult > 0) subParts.push('◐ half');
    return {
      id: `skill.${s.id}`,
      label: s.label,
      value: signed(total),
      sub: subParts.join(' · '),
      actionId: `skill.${s.id}`,
      ...biasFields(rollBias(actor, 'skill', s.id)),
    };
  });
}

/** Physical items whose equipped state the player may toggle: weapons plus
 * equipment that is armor or a shield (clothing/trinkets stay untoggled). */
function isEquippable(item: FoundryItemDoc): boolean {
  if (item.type === 'weapon') return true;
  if (item.type !== 'equipment') return false;
  const typeVal = strAt(item.system, 'type.value');
  return typeVal !== undefined && ARMOR_EQUIPMENT_TYPES.has(typeVal);
}

/** Attunement-required physical items get an attune toggle. dnd5e 5.x:
 * `system.attunement` is a string enum "" | "required" | "optional"
 * (live-verified on 5.3.3); pre-5.x numeric values (1 = required,
 * 2 = attuned) are accepted defensively. */
function isAttuneable(item: FoundryItemDoc): boolean {
  if (!PHYSICAL_ITEM_TYPES.has(item.type)) return false;
  const att = getPath(item.system, 'attunement');
  // 'optional' items attune in Foundry too — they need the toggle just like
  // 'required' ones (they already show the tag and count against the cap).
  return att === 'required' || att === 'optional' || att === 1 || att === 2;
}

/** Current attuned state — 5.x boolean, with the pre-5.x numeric fallback
 * (attunement 2 = attuned) so legacy documents don't render inverted. Single
 * source of truth for the descriptor, the row tag, and the gear counter. */
function isAttuned(item: FoundryItemDoc): boolean {
  return getPath(item.system, 'attuned') === true || getPath(item.system, 'attunement') === 2;
}

/** Attunement is mandatory for this item to function ('required', or the
 * pre-5.x numeric 1). Narrower than isAttuneable: 'optional'-attunement
 * items get the toggle but still work unattuned. */
function requiresAttunement(item: FoundryItemDoc): boolean {
  const att = getPath(item.system, 'attunement');
  return att === 'required' || att === 1;
}

/** A physical, non-weapon item is usable when its data carries activities
 * (dnd5e 5.x usage rules: potions, torches, rations…). Weapons keep their
 * attack action instead. */
function isUsableInventoryItem(item: FoundryItemDoc): boolean {
  if (!PHYSICAL_ITEM_TYPES.has(item.type) || item.type === 'weapon') return false;
  return Object.keys(rec(getPath(item.system, 'activities'))).length > 0;
}

/** A feature is usable when it has activities to run or limited uses; a
 * passive feat (no activities, no uses) gets no action. */
function isUsableFeature(item: FoundryItemDoc): boolean {
  if (item.type !== 'feat') return false;
  const activities = rec(getPath(item.system, 'activities'));
  return Object.keys(activities).length > 0 || usesInfo(item) !== undefined;
}

/**
 * Resolve Foundry text-enricher tokens to readable text so descriptions don't
 * leak raw source like "&Reference[inv]{Investigation}". HTML tags are
 * preserved (callers sanitize + render via v-html). Conservative: only
 * recognized shapes are rewritten; unknown/labelless tokens pass through.
 */
export function resolveEnrichers(text: string): string {
  return text
    // Labeled document/reference/check enrichers -> the author's label:
    // @UUID[..]{Label}, &Reference[..]{Label}, @Check[..]{Label}, @Damage[..]{Label}
    .replace(/[@&][A-Za-z]+\[[^\]]*\]\{([^}]*)\}/g, '$1')
    // Labeled inline rolls: [[/r 1d20]]{Label} -> Label
    .replace(/\[\[[^\]]*\]\]\{([^}]*)\}/g, '$1')
    // Bare inline rolls: [[/r 1d20 + 3]] -> "1d20 + 3", [[1d6]] -> "1d6"
    .replace(/\[\[\s*\/?[A-Za-z]*\s*([^\]]*?)\s*\]\]/g, '$1');
}

/** A world item/doc's description HTML with enrichers resolved; undefined when
 *  empty/missing. Single source for detail views + compendium previews. */
function descriptionHtml(system: unknown): string | undefined {
  const v = getPath(system, 'description.value');
  return typeof v === 'string' && v !== '' ? resolveEnrichers(v) : undefined;
}

/**
 * The item's own description HTML (`system.description.value`), for the M8
 * detail view. Content from the user's OWN world — the repo ships none; the
 * client sanitizes before rendering. Empty/missing -> undefined.
 */
function itemDetail(item: FoundryItemDoc): string | undefined {
  return descriptionHtml(item.system);
}

/**
 * Conditions + concentration from `actor.effects` (M8). Each enabled effect
 * (disabled !== true) is either the concentration marker (name starts with
 * "Concentrating" OR statuses include "concentrating") or a condition badge.
 * `statuses` may be a bare string or an array; both normalize to string[].
 */
interface EffectSummary {
  concentration: { label: string } | null;
  conditions: Condition[];
}

function normalizeStatuses(raw: unknown): string[] {
  if (typeof raw === 'string') return raw === '' ? [] : [raw];
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
  return [];
}

/** True when an enabled Active Effect changes any system.attributes.ac*
 *  path (Mage Armor's ac.calc OVERRIDE, Shield's ac.bonus…). Gate for the
 *  extra execute-js AC read — rare enough to keep sheet loads cheap. */
function hasAcEffect(actor: FoundryActorDoc): boolean {
  const effects = Array.isArray(actor.effects) ? actor.effects : [];
  return effects.some((e) => {
    const eff = rec(e);
    if (eff.disabled === true) return false;
    const changes = Array.isArray(eff.changes) ? eff.changes : [];
    return changes.some((c) => {
      const key = rec(c).key;
      return typeof key === 'string' && key.startsWith('system.attributes.ac');
    });
  });
}

function parseEffects(actor: FoundryActorDoc): EffectSummary {
  const rawEffects = getPath(actor, 'effects');
  const effects = Array.isArray(rawEffects) ? rawEffects : [];
  let concentration: { label: string } | null = null;
  const conditions: Condition[] = [];
  const CONC_PREFIX = 'Concentrating: ';
  for (const raw of effects) {
    const eff = rec(raw);
    if (eff.disabled === true) continue;
    const name = typeof eff.name === 'string' ? eff.name : '';
    const statuses = normalizeStatuses(eff.statuses);
    if (name.startsWith('Concentrating') || statuses.includes('concentrating')) {
      const label = name.startsWith(CONC_PREFIX) ? name.slice(CONC_PREFIX.length) : name;
      concentration = { label };
      continue;
    }
    const id =
      (typeof eff._id === 'string' && eff._id !== '' ? eff._id : undefined) ??
      (typeof eff.id === 'string' && eff.id !== '' ? eff.id : undefined) ??
      slug(name);
    const appliedBy = getPath(eff, 'flags.unseen-servent.appliedBy');
    conditions.push({
      id,
      label: name,
      ...(typeof eff.icon === 'string' ? { icon: eff.icon } : {}),
      ...(typeof appliedBy === 'string' && appliedBy !== '' ? { removeActionId: `effect.${id}.remove` } : {}),
    });
  }
  return { concentration, conditions };
}

function inventoryListItem(item: FoundryItemDoc, resourceIds: Set<string>, physicalIds: Set<string>): ListItem {
  const qty = numAt(item.system, 'quantity') ?? 1;
  const subParts: string[] = [];
  if (qty !== 1) subParts.push(`×${qty}`);
  subParts.push(item.type);
  // Presentation-only per-row weight: "<n> <unit>", "<qty> × <n> <unit>" for
  // stacks. Units come from the item itself (metric worlds serialize kg).
  const weight = numAt(item.system, 'weight.value');
  if (weight !== undefined && weight > 0) {
    const unit = strAt(item.system, 'weight.units') || 'lb';
    subParts.push(qty > 1 ? `${qty} × ${weight} ${unit}` : `${weight} ${unit}`);
  }
  const recovery = recoveryLabel(item);
  if (recovery !== undefined) subParts.push(`recharges: ${recovery}`);
  const usesId = `item.${item._id}.uses`;
  const qtyId = `item.${item._id}.qty`;
  const resourceId = resourceIds.has(usesId) ? usesId : resourceIds.has(qtyId) ? qtyId : undefined;
  const tags: string[] = [];
  if (getPath(item.system, 'equipped') === true) tags.push('equipped');
  if (isAttuned(item)) tags.push('attuned');
  // Group under a container row only when the ref resolves on this sheet —
  // captured worlds carry dangling compendium-source refs, which render flat.
  const container = strAt(item.system, 'container');
  const containerId =
    container !== undefined && container !== '' && container !== item._id && physicalIds.has(container)
      ? container
      : undefined;
  const detail = itemDetail(item);
  return {
    id: item._id,
    label: item.name,
    sub: subParts.join(' · '),
    ...(item.img !== undefined ? { img: item.img } : {}),
    ...(resourceId !== undefined ? { resourceId } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    // No primary actionId: inventory rows manage (quantity, equip); using and
    // attacking live on the Actions tab.
    ...(isEquippable(item) ? { toggleActionId: `item.${item._id}.equip` } : {}),
    ...(isAttuneable(item) ? { attuneActionId: `item.${item._id}.attune` } : {}),
    ...(isVersatileWeapon(item) ? { gripActionId: `item.${item._id}.grip` } : {}),
    ...(containerId !== undefined ? { containerId } : {}),
    ...(detail !== undefined ? { detail } : {}),
    // Physical items may be removed via the library API (M13).
    removable: 'gear',
  };
}

function featureListItem(item: FoundryItemDoc, resourceIds: Set<string>): ListItem {
  const featType = strAt(item.system, 'type.value');
  const sub = featType === 'class' ? 'Class feature' : 'Feat';
  const usesId = `item.${item._id}.uses`;
  const detail = itemDetail(item);
  return {
    id: item._id,
    label: item.name,
    sub,
    ...(item.img !== undefined ? { img: item.img } : {}),
    ...(resourceIds.has(usesId) ? { resourceId: usesId } : {}),
    ...(isUsableFeature(item) ? { actionId: `feature.${item._id}.use` } : {}),
    ...(detail !== undefined ? { detail } : {}),
    // Feats may be removed via the library API (M13).
    removable: 'feats',
  };
}

/** Feat/racial spell grants (dnd5e 5.3.3 `system.method`, live-verified on
 *  Morgrim): 'atwill' and 'innate' spells cast WITHOUT a slot, tracking their
 *  own item uses (e.g. 1/long rest) instead. Everything else ('spell',
 *  'ritual', absent) is slot-based. */
function freeUseMethod(item: FoundryItemDoc): 'atwill' | 'innate' | undefined {
  const method = strAt(item.system, 'method');
  return method === 'atwill' || method === 'innate' ? method : undefined;
}

function spellListItem(item: FoundryItemDoc, resourceIds: Set<string>): ListItem {
  const actionId = `spell.${item._id}.cast`;
  const level = numAt(item.system, 'level') ?? 0;
  const school = strAt(item.system, 'school');
  // dnd5e 5.3.3 (live-verified): `system.method` ("spell", …) plus a numeric
  // `system.prepared` flag — 0 = unprepared, 1 = prepared, 2 = always
  // prepared. There is NO `system.preparation` object. Booleans are accepted
  // defensively for older documents.
  const rawPrepared = getPath(item.system, 'prepared');
  const always = rawPrepared === 2;
  const isPrepared = always || rawPrepared === 1 || rawPrepared === true;
  const rawProps = getPath(item.system, 'properties');
  const properties = Array.isArray(rawProps) ? rawProps : [];
  const freeUse = freeUseMethod(item);

  const subParts: string[] = [level === 0 ? 'Cantrip' : `${ordinal(level)} level`];
  const schoolLabel = school !== undefined ? SPELL_SCHOOLS[school] : undefined;
  if (schoolLabel !== undefined) subParts.push(schoolLabel);
  if (freeUse !== undefined) {
    // "1/long rest" — so the two Healing Words are never confused again.
    const uses = usesInfo(item);
    const recovery = recoveryLabel(item);
    if (uses !== undefined && recovery !== undefined) subParts.push(`${uses.max}/${recovery}`);
    else subParts.push('no slot needed');
  } else if (always) subParts.push('always prepared');
  else if (isPrepared) subParts.push('prepared');

  const tags: string[] = [];
  if (freeUse !== undefined) tags.push(freeUse === 'atwill' ? 'free use' : 'innate');
  if (freeUse === undefined && isPrepared) tags.push('prepared');
  if (properties.includes('concentration')) tags.push('concentration');
  if (properties.includes('ritual')) tags.push('ritual');

  const usesId = `item.${item._id}.uses`;
  const detail = itemDetail(item);
  return {
    id: item._id,
    label: item.name,
    sub: subParts.join(' · '),
    ...(item.img !== undefined ? { img: item.img } : {}),
    ...(freeUse !== undefined && resourceIds.has(usesId) ? { resourceId: usesId } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(isPreparableSpell(item) ? { toggleActionId: `spell.${item._id}.prepare` } : {}),
    // Any spell on the sheet may be removed via the library API.
    removable: 'spells',
    actionId,
  };
}

/** Leveled, not-always-prepared spells may be toggled; cantrips,
 * `prepared: 2` (always prepared, e.g. domain spells), and free-use grants
 * (atwill/innate — no preparation concept) may not. */
function isPreparableSpell(item: FoundryItemDoc): boolean {
  if (item.type !== 'spell') return false;
  const level = numAt(item.system, 'level') ?? 0;
  return level > 0 && getPath(item.system, 'prepared') !== 2 && freeUseMethod(item) === undefined;
}

/**
 * Preview ListItem for a RAW spell document (compendium search hit, not an
 * embedded item) — the learn-confirm sheet in the PWA renders it. Content
 * comes from the user's own world/compendia; the client sanitizes.
 */
function spellPreview(doc: Rec): ListItem {
  const system = rec(doc.system);
  const level = numAt(system, 'level') ?? 0;
  const school = strAt(system, 'school');
  const subParts: string[] = [level === 0 ? 'Cantrip' : `${ordinal(level)} level`];
  const schoolLabel = school !== undefined ? SPELL_SCHOOLS[school] : undefined;
  if (schoolLabel !== undefined) subParts.push(schoolLabel);
  const detail = descriptionHtml(system);
  const name = typeof doc.name === 'string' && doc.name !== '' ? doc.name : 'Unknown spell';
  const id = typeof doc._id === 'string' && doc._id !== '' ? doc._id : slug(name);
  return {
    id,
    label: name,
    sub: subParts.join(' · '),
    ...(typeof doc.img === 'string' ? { img: doc.img } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * Preview ListItem for a RAW feat document (compendium search hit) — the
 * add-confirm sheet renders it. sub is the feat-type label, mirroring
 * featureListItem ("Class feature" / "Feat").
 */
function featPreview(doc: Rec): ListItem {
  const system = rec(doc.system);
  const featType = strAt(system, 'type.value');
  const sub = featType === 'class' ? 'Class feature' : 'Feat';
  const detail = descriptionHtml(system);
  const name = typeof doc.name === 'string' && doc.name !== '' ? doc.name : 'Unknown feat';
  const id = typeof doc._id === 'string' && doc._id !== '' ? doc._id : slug(name);
  return {
    id,
    label: name,
    sub,
    ...(typeof doc.img === 'string' ? { img: doc.img } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * Preview ListItem for a RAW physical-item document (compendium search hit) —
 * the add-confirm sheet renders it. sub is the item's Foundry type
 * (weapon/equipment/consumable…), mirroring inventoryListItem.
 */
function gearPreview(doc: Rec): ListItem {
  const detail = descriptionHtml(rec(doc.system));
  const name = typeof doc.name === 'string' && doc.name !== '' ? doc.name : 'Unknown item';
  const id = typeof doc._id === 'string' && doc._id !== '' ? doc._id : slug(name);
  const type = typeof doc.type === 'string' && doc.type !== '' ? doc.type : undefined;
  return {
    id,
    label: name,
    ...(type !== undefined ? { sub: type } : {}),
    ...(typeof doc.img === 'string' ? { img: doc.img } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

// ---------------------------------------------------------------------------
// Library collections (PLAN.md M13): search -> preview -> add / remove. The
// adapter declares each addable/removable class of documents; the gateway
// resolves a collection by id and relays give/delete. No rules engine — add
// only copies a legal world doc onto the actor; remove only deletes an item
// already on the actor. `describe` reuses the sheet preview builders.

const LIBRARY: LibraryCollection[] = [
  {
    id: 'spells',
    label: 'Learn spell',
    searchFilter: 'documentType:Item,subType:spell',
    canAdd: (doc) => doc.type === 'spell',
    canRemove: (item) => item.type === 'spell',
    describe: (doc) => spellPreview(doc),
  },
  {
    id: 'feats',
    label: 'Add feat',
    searchFilter: 'documentType:Item,subType:feat',
    canAdd: (doc) => doc.type === 'feat',
    canRemove: (item) => item.type === 'feat',
    describe: (doc) => featPreview(doc),
  },
  {
    id: 'gear',
    label: 'Add item',
    searchFilter: 'documentType:Item',
    canAdd: (doc) => typeof doc.type === 'string' && PHYSICAL_ITEM_TYPES.has(doc.type),
    canRemove: (item) => PHYSICAL_ITEM_TYPES.has(item.type),
    describe: (doc) => gearPreview(doc),
  },
];

// ---------------------------------------------------------------------------
// Actions (PLAN.md M6) — descriptors + intent -> relay call. The adapter only
// describes what is possible and translates taps; Foundry owns all rules
// (attack/damage math, slot & uses consumption, chat cards).

/**
 * Whether the actor can cast a level-`spellLevel` spell right now.
 *
 * The relay module (3.4.1) casts a spell only at its OWN base level and
 * ignores any requested higher level — true upcasting is not supported over
 * the bridge (M6-live-verified). So castable ⇔ a remaining slot exists at the
 * spell's base level (`spells.spellN.value > 0`). Pact slots also satisfy a
 * spell of level ≤ the pact slot level. Cantrips (level 0) are always at-will.
 * Needs the enriched document for accuracy but degrades gracefully (source
 * data still carries `value`).
 *
 * `pact.level` is derived-only (never in source data; enrich merges it from
 * the relay's spells detail). When pact slots remain but the level is
 * unknown — enrich failed or an old relay — do NOT lock the warlock out:
 * offer the cast and let Foundry refuse an illegal one itself.
 */
function canCastAtBase(actor: FoundryActorDoc, spellLevel: number): boolean {
  if (spellLevel <= 0) return true;
  if ((numAt(actor.system, `spells.spell${spellLevel}.value`) ?? 0) > 0) return true;
  const pactValue = numAt(actor.system, 'spells.pact.value') ?? 0;
  if (pactValue <= 0) return false;
  const pactLevel = numAt(actor.system, 'spells.pact.level');
  return pactLevel === undefined || pactLevel >= spellLevel;
}

/** Ascending spell-slot levels the actor can pay for RIGHT NOW for a spell
 *  of `baseLevel`: every L in base..9 with `spells.spellL.value > 0`. Pact
 *  slots are deliberately excluded — dnd5e consumes them automatically for
 *  pact-method spells at pact level (no upcast concept). */
function payableSlotLevels(actor: FoundryActorDoc, baseLevel: number): number[] {
  const out: number[] = [];
  for (let lvl = Math.max(1, baseLevel); lvl <= 9; lvl++) {
    if ((numAt(actor.system, `spells.spell${lvl}.value`) ?? 0) > 0) out.push(lvl);
  }
  return out;
}

/** This item's first activity, or an empty record if it has none. Foundry
 *  stores activities as an object keyed by activity id; every dnd5e
 *  spell/feature/weapon relevant to actions has at most one. */
function firstActivity(item: FoundryItemDoc): Rec {
  const activities = rec(getPath(item.system, 'activities'));
  return rec(Object.values(activities)[0]);
}

/** All of this item's activities, in insertion order, or empty if it has
 *  none. Some items split a single effect across more than one activity —
 *  Bead of Force's real data (live-captured 2026-07-09) has a `save`
 *  activity carrying the DC and a *separate* `utility` activity carrying
 *  the damage roll — so callers that need to find a specific activity
 *  type must scan all of them, not just the first. */
function allActivities(item: FoundryItemDoc): Rec[] {
  const activities = rec(getPath(item.system, 'activities'));
  return Object.values(activities).map(rec);
}

/** True when any activity targets an area template (Bead of Force, Torch —
 *  their source activities carry their own `target.template.type`), OR when
 *  the ITEM-level `system.target.template.type` is set — dnd5e 5.3.3 spell
 *  activities with `target.override: false` store no type of their own in
 *  SOURCE data and inherit the item's template when derived (live-verified
 *  2026-07-20 on Daylight: sphere/60 lives only at system.target). Headless,
 *  dnd5e's use() blocks awaiting canvas placement for these — the gateway
 *  routes them through the template-suppressing execute-js activation. */
function hasAreaTemplate(item: FoundryItemDoc): boolean {
  const activityHas = allActivities(item).some((a) => {
    const type = getPath(a, 'target.template.type');
    return typeof type === 'string' && type !== '';
  });
  if (activityHas) return true;
  const itemLevel = getPath(item.system, 'target.template.type');
  return typeof itemLevel === 'string' && itemLevel !== '';
}

/** The dnd5e activity `type` this item's first activity carries, e.g.
 *  "attack", "heal", "save", "utility", "check". Undefined for items with
 *  no activities (most physical gear). */
function activityType(item: FoundryItemDoc): string | undefined {
  const type = firstActivity(item).type;
  return typeof type === 'string' ? type : undefined;
}

/**
 * Classify a spell/feature/item for the Actions tab (M15/M16): 'heal' for
 * heal activities, 'damage' for attacks in spells/features (but not items —
 * item attacks are weapon attacks handled in the Attacks section), for save
 * activities that still carry damage parts (e.g. Sacred Flame — mechanically
 * a `save` activity, not an `attack`, but it deals radiant damage on a
 * failed save; verified against the caster fixture: Sacred Flame's
 * `damage.parts` has one entry, the pure debuff saves Bane/Command/Sanctuary's
 * are empty), and for items that split DC and damage across two activities
 * (Bead of Force: a `save` activity for the DC, a separate `utility`
 * activity whose `roll.formula` carries the actual damage die — live-verified
 * 2026-07-09, this item has no non-empty `damage.parts` anywhere). 'utility'
 * for everything else (pure debuff saves, utility, check, item attacks).
 * Not exposed on weapon attack/damage descriptors — Attacks is already its
 * own unfiltered section.
 */
function hasSaveWithDamage(activities: Rec[]): boolean {
  return activities.some((a) => {
    if (a.type !== 'save') return false;
    const parts = getPath(a, 'damage.parts');
    return Array.isArray(parts) && parts.length > 0;
  });
}

function effectTypeOf(item: FoundryItemDoc): 'damage' | 'heal' | 'utility' {
  const activities = allActivities(item);
  if (activities.some((a) => a.type === 'heal')) return 'heal';
  // Attack activities on spells/features (cantrips like Fire Bolt) count as damage,
  // but attack activities on physical items are weapon attacks handled separately in Attacks.
  if (item.type === 'spell' || item.type === 'feat') {
    if (activities.some((a) => a.type === 'attack')) return 'damage';
  }
  if (hasSaveWithDamage(activities)) return 'damage';
  const hasSave = activities.some((a) => a.type === 'save');
  const hasUtilityRoll = activities.some(
    (a) => a.type === 'utility' && typeof getPath(a, 'roll.formula') === 'string' && getPath(a, 'roll.formula') !== '',
  );
  if (hasSave && hasUtilityRoll) return 'damage';
  return 'utility';
}

/**
 * In-combat targeting capability (2026-07-22): attack-roll damage → single
 * target; save-vs-DC damage → multiple (Fireball can catch several
 * combatants, friends included); heals → single. Utility-roll damage items
 * (Bead of Force's split activities) stay untargeted in v1 — their damage
 * has no per-target resolution rule to apply.
 *
 * INVARIANT (final-review Fix 3): the targeting descriptor must be derived
 * from the item's FIRST activity only, mirroring what actually executes —
 * targetedUseScript (foundry-client) runs `[...activities.values()][0]` and
 * never looks past it. Scanning ALL activities here (the old behavior) could
 * classify an item as targetable off an attack/save activity that isn't
 * first; the script would then run some OTHER (e.g. utility) activity and
 * no-op the targeting entirely. Restricting to the first activity is the
 * SAFE direction — an item can only lose targeting it doesn't actually have,
 * never gain targeting it can't execute.
 */
function targetingOf(item: FoundryItemDoc): { mode: 'single' | 'multiple'; kind: 'attack' | 'save' | 'heal' } | undefined {
  const et = effectTypeOf(item);
  if (et === 'heal') return { mode: 'single', kind: 'heal' };
  if (et !== 'damage') return undefined;
  const first = firstActivity(item);
  if (first.type === 'attack') return { mode: 'single', kind: 'attack' };
  if (first.type === 'save') {
    const parts = getPath(first, 'damage.parts');
    if (Array.isArray(parts) && parts.length > 0) return { mode: 'multiple', kind: 'save' };
  }
  return undefined;
}

/**
 * The Active Effect a self-buff spell should apply to the caster on cast, or
 * undefined. Data-shape only (no rules engine): the spell item carries an
 * effect that is applied on use — `transfer: false` (not a passive/always-on
 * effect) with at least one `change` — and the spell isn't a heal/damage
 * effect. Copied verbatim; `origin` points at the embedded item so Foundry
 * shows provenance. dnd5e/DAE never applies these headless (M-buff-effects
 * findings), so the gateway creates the effect itself.
 */
/** Foundry CONST.ACTIVE_EFFECT_MODES, keyed by the string `type` dnd5e 5.3.3
 *  stores under `system.changes` (live-verified 2026-07-23: relay GET /get
 *  serializes the core numeric-`mode` `changes` as null and keeps only
 *  `system.changes` with a string `type`). The buff write path creates a core
 *  ActiveEffect (numeric `mode`), so translate back. */
const AE_MODE_BY_TYPE: Record<string, number> = {
  custom: 0,
  multiply: 1,
  add: 2,
  downgrade: 3,
  upgrade: 4,
  override: 5,
};

/** An effect's changes as {key, numeric mode, value}, read from whichever
 *  shape the relay serialized: the core top-level `changes` (numeric `mode`,
 *  older dnd5e / synthetic fixtures) or dnd5e 5.3.3's `system.changes` (string
 *  `type`). Top-level wins when present; otherwise fall back to system.changes
 *  and map `type`→`mode`. */
function effectChanges(eff: Record<string, unknown>): Array<{ key: string; mode: number; value: string }> {
  const top = eff.changes;
  const sys = getPath(eff, 'system.changes');
  const raw = Array.isArray(top) && top.length > 0 ? top : Array.isArray(sys) ? sys : [];
  return raw
    .map(rec)
    .filter((c) => typeof c.key === 'string' && c.key !== '')
    .map((c) => ({
      key: c.key as string,
      mode:
        typeof c.mode === 'number'
          ? c.mode
          : (typeof c.type === 'string' ? AE_MODE_BY_TYPE[c.type] : undefined) ?? 0,
      value: typeof c.value === 'string' ? c.value : String(c.value ?? ''),
    }));
}

function selfBuffEffect(actor: FoundryActorDoc, item: FoundryItemDoc): EffectPayload | undefined {
  if (item.type !== 'spell') return undefined;
  if (effectTypeOf(item) !== 'utility') return undefined; // heals/damage handled elsewhere
  // Save-gated activities (Bane, etc.) apply their effect to targets that fail
  // the save, never to the caster — exclude them or a debuff would land on self.
  if (allActivities(item).some((a) => a.type === 'save')) return undefined;
  const rawEffects = getPath(item, 'effects');
  const effects = Array.isArray(rawEffects) ? rawEffects : [];
  for (const raw of effects) {
    const eff = rec(raw);
    if (eff.transfer === true) continue; // passive/always-on, not a cast-applied buff
    // Real dnd5e 5.3.3 activity-applied item effects are stored disabled:true
    // on the source spell (enabled only when copied onto a target); the copy
    // we build below (EffectPayload) is created enabled regardless.
    const changes = effectChanges(eff);
    if (changes.length === 0) continue;
    const name = typeof eff.name === 'string' && eff.name !== '' ? eff.name : item.name;
    return {
      name,
      ...(typeof eff.img === 'string' ? { img: eff.img } : {}),
      changes,
      ...(eff.duration !== undefined && eff.duration !== null ? { duration: rec(eff.duration) } : {}),
      origin: `Actor.${actor._id}.Item.${item._id}`,
    };
  }
  return undefined;
}

/** True when a self-buff spell targets only the caster (activity target
 *  `affects.type === 'self'`, e.g. Shield). Such buffs auto-apply to the
 *  caster and are NOT offered a target picker. Buffs that can affect a
 *  chosen creature (Bless, Aid, Mage Armor) return false. */
function buffTargetIsSelf(item: FoundryItemDoc): boolean {
  return getPath(firstActivity(item), 'target.affects.type') === 'self';
}

/**
 * The ability modifier dnd5e would add to this weapon's attack/damage roll.
 * An explicit activity `attack.ability` override wins; otherwise a finesse
 * weapon picks the better of STR/DEX, a ranged weapon uses DEX, and anything
 * else — including a thrown-but-not-finesse weapon, which by RAW keeps its
 * melee ability — uses STR.
 */
function weaponAbilityMod(actor: FoundryActorDoc, item: FoundryItemDoc): number {
  const activities = rec(getPath(item.system, 'activities'));
  const firstActivity = rec(Object.values(activities)[0]);
  const override = strAt(firstActivity, 'attack.ability');
  if (override !== undefined && override !== '') return abilityMod(actor.system, override);
  const rawProps = getPath(item.system, 'properties');
  const props = Array.isArray(rawProps) ? rawProps : [];
  if (props.includes('fin')) {
    return Math.max(abilityMod(actor.system, 'str'), abilityMod(actor.system, 'dex'));
  }
  const attackType = strAt(firstActivity, 'attack.type.value');
  return abilityMod(actor.system, attackType === 'ranged' ? 'dex' : 'str');
}

/**
 * Best-effort attack to-hit bonus for the companion-built attack roll — used
 * ONLY when the player picks advantage/disadvantage (a plain Roll goes through
 * Foundry's native use-item). Mirrors weaponDamageFormula's honesty: resolved
 * ability mod (finesse/ranged/override via weaponAbilityMod) + proficiency
 * (unless the item is explicitly non-proficient) + the weapon's magical bonus +
 * a flat activity attack bonus. NOT modelled (documented gaps, same as damage):
 * weapon-mastery bonuses, non-numeric @-formula attack bonuses, active effects.
 */
function weaponAttackBonus(actor: FoundryActorDoc, item: FoundryItemDoc): number {
  const ability = weaponAbilityMod(actor, item);
  const proficientRaw = numAt(item.system, 'proficient');
  const prof = proficientRaw === 0 ? 0 : proficiency(actor);
  const magic = numAt(item.system, 'magicalBonus') ?? 0;
  const activities = rec(getPath(item.system, 'activities'));
  const first = rec(Object.values(activities)[0]);
  const rawAtk = getPath(first, 'attack.bonus');
  const flat = typeof rawAtk === 'number' ? rawAtk : typeof rawAtk === 'string' ? Number(rawAtk) : Number.NaN;
  const atk = Number.isFinite(flat) ? flat : 0;
  return ability + prof + magic + atk;
}

/**
 * Grip-aware dice helpers for versatile ("ver") weapons: which die a weapon
 * rolls depends on the app's own `flags.unseen-servent.grip` item flag
 * (`weaponGrip`), stepped up from the base die when the item leaves
 * `damage.versatile` unpopulated (`versatileDice`/`stepUpDenomination`).
 * `gripDice` is the single source of truth shared by `weaponDamageFormula`
 * and `versatileAttackSub` so the formula and the attack-row sub-line never
 * disagree about which die is active.
 */

/** Weapon carries dnd5e's versatile ("ver") property. */
function isVersatileWeapon(item: FoundryItemDoc): boolean {
  if (item.type !== 'weapon') return false;
  const props = getPath(item.system, 'properties');
  return Array.isArray(props) && props.includes('ver');
}

/** Wielded grip for a versatile weapon, from the app's own item flag. Anything
 *  but the explicit 'twoHanded' flag is one-handed (the default). */
function weaponGrip(item: FoundryItemDoc): 'oneHanded' | 'twoHanded' {
  return getPath(item, 'flags.unseen-servent.grip') === 'twoHanded' ? 'twoHanded' : 'oneHanded';
}

/** Next larger polyhedral die (d4→d6→d8→d10→d12; d12 and anything unusual are
 *  returned unchanged). SRD versatile weapons all step exactly one size, so this
 *  reproduces the two-handed die when the item leaves `damage.versatile` empty. */
function stepUpDenomination(denomination: number): number {
  const ladder = [4, 6, 8, 10, 12];
  const i = ladder.indexOf(denomination);
  return i >= 0 && i < ladder.length - 1 ? (ladder[i + 1] as number) : denomination;
}

/** Read a {number, denomination} dice block off `item.system.<path>`, or
 *  undefined when either is missing/non-positive. */
function readDice(item: FoundryItemDoc, path: string): { number: number; denomination: number } | undefined {
  const d = rec(getPath(item.system, path));
  const number = typeof d.number === 'number' && Number.isFinite(d.number) ? d.number : undefined;
  const denomination = typeof d.denomination === 'number' && Number.isFinite(d.denomination) ? d.denomination : undefined;
  if (number === undefined || denomination === undefined || number <= 0 || denomination <= 0) return undefined;
  return { number, denomination };
}

/** Two-handed damage dice for a versatile weapon: the explicit versatile die
 *  when populated, else the base die stepped up one size. */
function versatileDice(item: FoundryItemDoc): { number: number; denomination: number } | undefined {
  const explicit = readDice(item, 'damage.versatile');
  if (explicit !== undefined) return explicit;
  const base = readDice(item, 'damage.base');
  return base === undefined ? undefined : { number: base.number, denomination: stepUpDenomination(base.denomination) };
}

/** Damage dice a versatile weapon rolls under `grip` (base one-handed,
 *  versatile two-handed). Shared by the formula and the attack sub-line so they
 *  never disagree. */
function gripDice(item: FoundryItemDoc, grip: 'oneHanded' | 'twoHanded'): { number: number; denomination: number } | undefined {
  return grip === 'twoHanded' ? versatileDice(item) : readDice(item, 'damage.base');
}

/** Active-die sub-line for a versatile weapon's attack row, e.g.
 *  "1d10 slashing · two-handed". Undefined for non-versatile weapons. */
function versatileAttackSub(item: FoundryItemDoc): string | undefined {
  if (!isVersatileWeapon(item)) return undefined;
  const grip = weaponGrip(item);
  const dice = gripDice(item, grip);
  if (dice === undefined) return undefined;
  const types = getPath(item.system, 'damage.base.types');
  const type = Array.isArray(types) && typeof types[0] === 'string' ? (types[0] as string) : undefined;
  const gripLabel = grip === 'twoHanded' ? 'two-handed' : 'one-handed';
  return `${dice.number}d${dice.denomination}${type !== undefined ? ` ${type}` : ''} · ${gripLabel}`;
}

/**
 * Weapon damage formula: base (or grip-selected versatile) dice + the
 * weapon's own static bonus (e.g. a +1 weapon's `damage.base.bonus`) + the
 * resolved ability modifier — dnd5e's default calc for a plain weapon hit.
 * Undefined when the item carries no base dice (e.g. an
 * improvised/unconfigured weapon).
 *
 * Deliberately NOT modelled (no relay action exists to cross-check against
 * Foundry's own roll — see docs/HOSTING.md troubleshooting notes on the
 * relay module's lack of a damage-roll endpoint): extra activity damage
 * parts, weapon mastery bonus dice, critical doubling, and active effects.
 * This is a best-effort client-side estimate, not a substitute for
 * Foundry's own roll.
 */
function weaponDamageFormula(actor: FoundryActorDoc, item: FoundryItemDoc): string | undefined {
  const grip = isVersatileWeapon(item) ? weaponGrip(item) : 'oneHanded';
  const dice = gripDice(item, grip);
  if (dice === undefined) return undefined;
  const diceStr = `${dice.number}d${dice.denomination}`;
  const base = rec(getPath(item.system, 'damage.base'));
  const rawBonus = typeof base.bonus === 'string' ? Number(base.bonus) : 0;
  const staticBonus = Number.isFinite(rawBonus) ? rawBonus : 0;
  const bonus = staticBonus + weaponAbilityMod(actor, item);
  if (bonus === 0) return diceStr;
  return `${diceStr} ${bonus < 0 ? '-' : '+'} ${Math.abs(bonus)}`;
}

/** The item's heal-type activity, or an empty record if it has none.
 *  effectTypeOf classifies by scanning ALL activities, so the formula and
 *  self-target reads must find the same activity it did — reading only the
 *  first would advertise a heal action and then fail to build it whenever
 *  the heal activity isn't first (branch review 2026-07-09). */
function healActivity(item: FoundryItemDoc): Rec {
  return allActivities(item).find((a) => a.type === 'heal') ?? {};
}

/** True only for activities whose target is unconditionally the caster
 *  (Second Wind, or a potion its holder drinks). Cure Wounds/Healing Word
 *  have no `target.affects.type` at all — they're cast at a creature the
 *  player chooses in Foundry, which is usually NOT the caster — so this
 *  must be the sole signal for whether a heal auto-applies to the actor's
 *  own HP (verified against both fixtures: Second Wind's
 *  `target.affects.type` is `"self"`; Cure Wounds/Healing Word's
 *  `target.affects` has no `type` field at all). */
function isSelfTargeted(item: FoundryItemDoc): boolean {
  return getPath(healActivity(item), 'target.affects.type') === 'self';
}

/**
 * Heal formula for a heal-type activity: base dice + a resolved bonus.
 * Mirrors weaponDamageFormula. `bonus` is a Foundry roll-data reference
 * string; only two shapes appear in dnd5e content and are resolved
 * explicitly — anything else falls back to +0 (documented gap, not a
 * roll-data evaluator, same honesty as weaponDamageFormula):
 *   "@mod"                  -> the actor's spellcasting ability modifier
 *                              (`actor.system.attributes.spellcasting`).
 *   "@classes.<id>.levels"  -> approximated with total character level
 *                              (ignores multiclass split — same caveat
 *                              already accepted for weapon ability lookups).
 * Undefined when the activity carries no healing dice. `castLevel` (an
 * explicit upcast slot, or undefined to use the effective default — see
 * scalingSteps) scales the dice count via the activity's own `scaling` data.
 */
function healFormula(actor: FoundryActorDoc, item: FoundryItemDoc, castLevel?: number): string | undefined {
  const healing = rec(getPath(healActivity(item), 'healing'));
  const number = typeof healing.number === 'number' && Number.isFinite(healing.number) ? healing.number : undefined;
  const denomination =
    typeof healing.denomination === 'number' && Number.isFinite(healing.denomination) ? healing.denomination : undefined;
  if (number === undefined || denomination === undefined || number <= 0 || denomination <= 0) return undefined;
  const steps = scalingSteps(actor, item, castLevel);
  const scaled = scaledDiceNumber(number, healing.scaling, steps) ?? number;
  const dice = `${scaled}d${denomination}`;
  const rawBonus = typeof healing.bonus === 'string' ? healing.bonus.trim() : '';
  let bonus: number;
  if (rawBonus === '@mod') {
    const ability = strAt(actor.system, 'attributes.spellcasting') ?? 'wis';
    bonus = abilityMod(actor.system, ability);
  } else if (/^@classes\.[a-z]+\.levels$/.test(rawBonus)) {
    bonus = characterLevel(actor);
  } else {
    const flat = Number(rawBonus);
    bonus = Number.isFinite(flat) ? flat : 0;
  }
  if (bonus === 0) return dice;
  return `${dice} ${bonus < 0 ? '-' : '+'} ${Math.abs(bonus)}`;
}

/** dnd5e 5.x part scaling ({ mode, number, formula }): extra dice per step
 *  above base. 'whole' = every level, 'half' = every two levels. Returns
 *  undefined when scaling data can't be applied (caller keeps base dice —
 *  documented gap, same honesty as the formula builders). */
function scaledDiceNumber(baseNumber: number, rawScaling: unknown, steps: number): number | undefined {
  if (steps <= 0) return baseNumber;
  const scaling = rec(rawScaling);
  // dnd5e 5.3.3 ground truth: DamageData#scaledFormula computes
  // `(this.scaling.number ?? 0) * increase` — a missing `number` adds no
  // extra dice per step, not one (SHOULD-FIX 1, spec design.md:92 amended
  // to match).
  const per = typeof scaling.number === 'number' && Number.isFinite(scaling.number) ? scaling.number : 0;
  if (scaling.mode === 'whole') return baseNumber + per * steps;
  if (scaling.mode === 'half') return baseNumber + per * Math.floor(steps / 2);
  return undefined;
}

/** Cantrip damage tier from total character level (dnd5e: 5/11/17). */
function cantripSteps(actor: FoundryActorDoc): number {
  const lvl = characterLevel(actor);
  return lvl >= 17 ? 3 : lvl >= 11 ? 2 : lvl >= 5 ? 1 : 0;
}

/** Steps above base the display roll should scale by: explicit castLevel
 *  wins; cantrips use the character-level tier; pact-method spells scale to
 *  the pact slot level when known; everything else stays at base. */
function scalingSteps(actor: FoundryActorDoc, item: FoundryItemDoc, castLevel?: number): number {
  if (item.type !== 'spell') return 0;
  const base = numAt(item.system, 'level') ?? 0;
  if (base === 0) return cantripSteps(actor);
  if (castLevel !== undefined) return Math.max(0, castLevel - base);
  if (strAt(item.system, 'method') === 'pact') {
    const pactLevel = numAt(actor.system, 'spells.pact.level');
    if (pactLevel !== undefined) return Math.max(0, pactLevel - base);
  }
  return 0;
}

/**
 * Damage formula for an item's on-use damage effect (M16), checked in the
 * order these two real shapes were confirmed to exist:
 *   1. Inline `damage.parts` on any activity (a future item shaped like
 *      Sacred Flame) — each part's `number`/`denomination` becomes a dice
 *      term, `bonus` resolves through the same two roll-data shapes
 *      `healFormula`/`weaponDamageFormula` already accept, parts join
 *      with `+`.
 *   2. A sibling `utility` activity's `roll.formula` string, used verbatim
 *      (Bead of Force's real shape — its `"5d4"` is already a complete
 *      dice formula with no roll-data references to resolve, unlike a
 *      spell/feature's healing/damage dice).
 * Undefined when neither shape is present. `castLevel` (an explicit upcast
 * slot, or undefined to use the effective default — see scalingSteps) scales
 * each part's dice count via its own `scaling` data.
 */
function itemDamageFormula(actor: FoundryActorDoc, item: FoundryItemDoc, castLevel?: number): string | undefined {
  const activities = allActivities(item);
  const steps = scalingSteps(actor, item, castLevel);
  for (const activity of activities) {
    const rawParts = getPath(activity, 'damage.parts');
    if (!Array.isArray(rawParts) || rawParts.length === 0) continue;
    const terms: string[] = [];
    for (const rawPart of rawParts) {
      const part = rec(rawPart);
      const number = typeof part.number === 'number' && Number.isFinite(part.number) ? part.number : undefined;
      const denomination =
        typeof part.denomination === 'number' && Number.isFinite(part.denomination) ? part.denomination : undefined;
      if (number === undefined || denomination === undefined || number <= 0 || denomination <= 0) continue;
      const scaled = scaledDiceNumber(number, part.scaling, steps) ?? number;
      const dice = `${scaled}d${denomination}`;
      const rawBonus = typeof part.bonus === 'string' ? part.bonus.trim() : '';
      let bonus: number;
      if (rawBonus === '@mod') {
        const ability = strAt(actor.system, 'attributes.spellcasting') ?? 'wis';
        bonus = abilityMod(actor.system, ability);
      } else if (/^@classes\.[a-z]+\.levels$/.test(rawBonus)) {
        bonus = characterLevel(actor);
      } else {
        const flat = Number(rawBonus);
        bonus = Number.isFinite(flat) ? flat : 0;
      }
      terms.push(bonus === 0 ? dice : `${dice} ${bonus < 0 ? '-' : '+'} ${Math.abs(bonus)}`);
    }
    if (terms.length > 0) return terms.join(' + ');
  }
  const utilityRoll = activities.find(
    (a) => a.type === 'utility' && typeof getPath(a, 'roll.formula') === 'string' && getPath(a, 'roll.formula') !== '',
  );
  if (utilityRoll) return String(getPath(utilityRoll, 'roll.formula'));
  return undefined;
}

/** The use-* relay endpoint an action id's prefix maps to — the same
 *  prefix→endpoint rule buildAction's plain paths already apply. */
function useEndpointFor(actionId: string): 'use-item' | 'use-spell' | 'use-feature' {
  if (actionId.startsWith('spell.')) return 'use-spell';
  if (actionId.startsWith('feature.')) return 'use-feature';
  return 'use-item';
}

/** Reject a use/cast whose limited uses are exhausted. Foundry itself
 *  refuses too (the use-and-roll activation runs first for exactly that
 *  reason), but its refusal surfaces as a chat message, not a relay error —
 *  the display roll would still fire. This guard turns exhaustion into the
 *  same 422 the rest of the intent pipeline speaks. */
function assertUsesRemaining(item: FoundryItemDoc): void {
  const uses = usesInfo(item);
  if (uses !== undefined && uses.spent >= uses.max) {
    throw new IntentError(`"${item.name}" has no uses remaining`, 'INVALID');
  }
}

/**
 * A heal-type use/cast: the relay only auto-executes attack-type activities
 * (live-verified 2026-07-09 — Second Wind's "Use" consumed its use but
 * rolled/applied nothing), so the display roll is computed client-side, same
 * as weapon damage — but the activation still goes through Foundry first
 * (use-and-roll) so slots/uses/quantity/auto-destroy follow Foundry's own
 * rules. Self-targeted heals (Second Wind, a drunk potion) also write the
 * resulting HP directly, since there's no card-click step to rely on; heals
 * that target a chosen creature (Cure Wounds, Healing Word) only roll and
 * display — applying them to whichever creature was healed stays a manual
 * step in Foundry, exactly like weapon damage today.
 */
function buildHealAction(
  actor: FoundryActorDoc,
  item: FoundryItemDoc,
  actionId: string,
  opts?: { forceSelf?: boolean; slotLevel?: number },
): RelayAction {
  assertUsesRemaining(item);
  const formula = healFormula(actor, item, opts?.slotLevel);
  if (formula === undefined) {
    throw new IntentError(`no heal formula for "${actionId}"`, 'UNKNOWN_RESOURCE');
  }
  const baseLevel = numAt(item.system, 'level') ?? 0;
  const upcast = opts?.slotLevel !== undefined && opts.slotLevel > baseLevel;
  const base = {
    endpoint: 'use-and-roll' as const,
    use: upcast ? ('cast-at-slot' as const) : useEndpointFor(actionId),
    ...(upcast ? { slotKey: `spell${opts.slotLevel}` } : {}),
    itemId: item._id,
    formula,
    flavor: `${item.name} — Healing`,
    ...(hasAreaTemplate(item) ? { noTemplate: true as const } : {}),
  };
  if (!opts?.forceSelf && !isSelfTargeted(item)) {
    return base;
  }
  const current = numAt(actor.system, 'attributes.hp.value') ?? 0;
  const max = numAt(actor.system, 'attributes.hp.max') ?? current;
  return { ...base, heal: { path: 'system.attributes.hp.value', current, max } };
}

function buildActions(actor: FoundryActorDoc): ActionDescriptor[] {
  const out: ActionDescriptor[] = [];
  for (const s of SKILLS) {
    out.push({ id: `skill.${s.id}`, label: s.label, kind: 'check' });
  }
  for (const a of ABILITIES) {
    out.push({ id: `ability.${a.id}.check`, label: `${a.label} Check`, kind: 'check' });
    out.push({ id: `ability.${a.id}.save`, label: `${a.label} Save`, kind: 'save' });
  }
  out.push({ id: 'init.roll', label: 'Initiative', kind: 'check' });
  for (const item of actor.items ?? []) {
    if (item.type === 'weapon' && getPath(item.system, 'equipped') === true) {
      // Stowed weapons keep their row + equip toggle but offer no rolls —
      // equipping brings Attack/Dmg back (2026-07-18 design).
      out.push({ id: `item.${item._id}.attack`, label: item.name, kind: 'attack', targeting: { mode: 'single', kind: 'attack' } });
      if (weaponDamageFormula(actor, item) !== undefined) {
        out.push({ id: `item.${item._id}.damage`, label: item.name, kind: 'damage' });
      }
    }
    if (isUsableInventoryItem(item)) {
      // Offered even at 0 uses/quantity — Foundry owns the rules and refuses
      // when empty (same philosophy as unprepared spells).
      const itemTargeting = targetingOf(item);
      out.push({
        id: `item.${item._id}.use`,
        label: item.name,
        kind: 'use',
        group: 'items',
        effectType: effectTypeOf(item),
        ...(itemTargeting !== undefined ? { targeting: itemTargeting } : {}),
      });
    }
    if (isEquippable(item)) {
      out.push({
        id: `item.${item._id}.equip`,
        label: item.name,
        kind: 'equip',
        equipped: getPath(item.system, 'equipped') === true,
      });
    }
    if (isAttuneable(item)) {
      out.push({
        id: `item.${item._id}.attune`,
        label: item.name,
        kind: 'attune',
        attuned: isAttuned(item),
      });
    }
    if (isVersatileWeapon(item)) {
      out.push({ id: `item.${item._id}.grip`, label: item.name, kind: 'grip', grip: weaponGrip(item) });
    }
    if (PHYSICAL_ITEM_TYPES.has(item.type)) {
      out.push({ id: `item.${item._id}.move`, label: item.name, kind: 'move' });
    }
    if (item.type === 'spell') {
      const level = numAt(item.system, 'level') ?? 0;
      const rawPrepared = getPath(item.system, 'prepared');
      const alwaysPrepared = rawPrepared === 2;
      const isPrepared = alwaysPrepared || rawPrepared === 1 || rawPrepared === true;
      const freeUse = freeUseMethod(item);
      // The Actions tab only offers spells that are actually ready to cast
      // right now: cantrips (no preparation concept), always-prepared spells
      // (domain/ritual grants), explicitly prepared leveled spells, and
      // free-use grants (atwill/innate — always ready, own uses). An
      // unprepared leveled spell still appears on the Spells tab — with its
      // own Prepare toggle below — so the player can ready it; cluttering the
      // Actions tab with spells that Foundry would just refuse was confusing.
      if (level === 0 || isPrepared || freeUse !== undefined) {
        const spellTargeting = targetingOf(item);
        out.push({
          id: `spell.${item._id}.cast`,
          label: freeUse !== undefined ? `${item.name} (free use)` : item.name,
          kind: 'cast',
          // Grouping metadata: the Actions tab renders per-level headers
          // (Cantrips / 1st Level / …), same split as the Spells tab.
          level: Math.max(0, Math.min(9, level)),
          effectType: effectTypeOf(item),
          ...(spellTargeting !== undefined ? { targeting: spellTargeting } : {}),
          ...(selfBuffEffect(actor, item) !== undefined && !buffTargetIsSelf(item) ? { targetable: true } : {}),
          // slotLevels semantics (2026-07-19 spec): absent = direct cast, no
          // picker (cantrips, free-use, pact-payable); otherwise the payable
          // spellN levels — [] disables, length 1 direct-casts, >1 opens the
          // PWA picker.
          ...(freeUse === undefined && level > 0
            ? (() => {
                // Spec 2026-07-19: pact-method spells stay pickerless — dnd5e
                // auto-casts them at pact level; spellN pools never pay for them.
                if (strAt(item.system, 'method') === 'pact') {
                  return canCastAtBase(actor, level) ? {} : { slotLevels: [] };
                }
                const payable = payableSlotLevels(actor, level);
                if (payable.length > 0) return { slotLevels: payable };
                return canCastAtBase(actor, level) ? {} : { slotLevels: [] };
              })()
            : {}),
        });
        // Damage spells get a companion damage-roll action, exactly like weapons
        // (attack + Dmg): cast is the to-hit/activation, this rolls the damage.
        if (effectTypeOf(item) === 'damage' && itemDamageFormula(actor, item) !== undefined) {
          out.push({ id: `spell.${item._id}.damage`, label: item.name, kind: 'damage' });
        }
      }
      if (isPreparableSpell(item)) {
        out.push({
          id: `spell.${item._id}.prepare`,
          label: item.name,
          kind: 'prepare',
          prepared: isPrepared,
        });
      }
    }
    if (isUsableFeature(item)) {
      const featureTargeting = targetingOf(item);
      out.push({
        id: `feature.${item._id}.use`,
        label: item.name,
        kind: 'use',
        effectType: effectTypeOf(item),
        ...(featureTargeting !== undefined ? { targeting: featureTargeting } : {}),
      });
    }
  }

  // M8 actor-scoped commands (no item target). Rests are always available;
  // concentration/death-save appear only when the actor's state calls for them.
  out.push({ id: 'rest.short', label: 'Short Rest', kind: 'rest' });
  out.push({ id: 'rest.long', label: 'Long Rest', kind: 'rest' });
  const effects = parseEffects(actor);
  if (effects.concentration) {
    out.push({ id: 'concentration.end', label: 'End Concentration', kind: 'endconcentration' });
  }
  for (const cond of effects.conditions) {
    if (cond.removeActionId !== undefined) {
      out.push({ id: cond.removeActionId, kind: 'endeffect', label: `End ${cond.label}` });
    }
  }
  if ((numAt(actor.system, 'attributes.hp.value') ?? 0) <= 0) {
    out.push({ id: 'deathsave.roll', label: 'Death Save', kind: 'deathsave' });
  }
  return out;
}

/** Standard 5e critical hit: double the COUNT of every dice term, keep
 *  static bonuses (2024/2014 core rule). Damage formulas here are always
 *  built from `NdM`-shaped terms (weaponDamageFormula / itemDamageFormula),
 *  so a plain term rewrite is exact. */
function criticalFormula(formula: string): string {
  return formula.replace(/(\d+)d(\d+)/g, (_m, count: string, faces: string) => `${Number(count) * 2}d${faces}`);
}

function d20Formula(bonus: number, mode: 'advantage' | 'disadvantage' | undefined): string {
  const dice = mode === 'advantage' ? '2d20kh1' : mode === 'disadvantage' ? '2d20kl1' : '1d20';
  return bonus < 0 ? `${dice} - ${-bonus}` : `${dice} + ${bonus}`;
}

function buildRollAction(
  actor: FoundryActorDoc,
  actionId: string,
  mode: 'advantage' | 'disadvantage' | undefined,
): RelayAction {
  if (actionId === 'init.roll') {
    return { endpoint: 'roll', formula: d20Formula(initiative(actor), mode), flavor: 'Initiative' };
  }
  const skillMatch = /^skill\.([a-z]+)$/.exec(actionId);
  if (skillMatch) {
    const def = SKILLS.find((s) => s.id === skillMatch[1]);
    if (!def) throw new IntentError(`unknown action "${actionId}"`, 'UNKNOWN_RESOURCE');
    return { endpoint: 'roll', formula: d20Formula(skillInfo(actor, def).total, mode), flavor: `${def.label} Check` };
  }
  const abilityMatch = /^ability\.([a-z]+)\.(check|save)$/.exec(actionId);
  const def = abilityMatch ? ABILITIES.find((a) => a.id === abilityMatch[1]) : undefined;
  if (!abilityMatch || !def) throw new IntentError(`unknown action "${actionId}"`, 'UNKNOWN_RESOURCE');
  if (abilityMatch[2] === 'check') {
    return { endpoint: 'roll', formula: d20Formula(abilityMod(actor.system, def.id), mode), flavor: `${def.label} Check` };
  }
  return { endpoint: 'roll', formula: d20Formula(saveBonus(actor, def.id), mode), flavor: `${def.label} Save` };
}

function buildAction(actor: FoundryActorDoc, intent: ActionIntent): RelayAction {
  const descriptor = buildActions(actor).find((a) => a.id === intent.actionId);
  if (!descriptor) {
    throw new IntentError(`unknown action "${intent.actionId}"`, 'UNKNOWN_RESOURCE');
  }
  if (descriptor.kind !== intent.kind) {
    throw new IntentError(
      `action "${intent.actionId}" is "${descriptor.kind}", not "${intent.kind}"`,
      'UNKNOWN_RESOURCE',
    );
  }

  // In-combat targeting (2026-07-22): validated once here, shared by the
  // attack/use/cast cases below — Foundry owns resolution, this only checks
  // the descriptor's own targeting capability and single/multiple arity.
  const targeted =
    'targetTokenUuids' in intent && Array.isArray(intent.targetTokenUuids) && intent.targetTokenUuids.length > 0
      ? intent.targetTokenUuids
      : undefined;
  if (targeted !== undefined) {
    if (descriptor.targeting === undefined) {
      throw new IntentError(`action "${intent.actionId}" does not support targets`, 'INVALID');
    }
    if (descriptor.targeting.mode === 'single' && targeted.length !== 1) {
      throw new IntentError(`action "${intent.actionId}" takes a single target`, 'INVALID');
    }
  }

  switch (intent.kind) {
    case 'check':
    case 'save': {
      const mode = intent.mode;
      if (mode !== undefined && mode !== 'advantage' && mode !== 'disadvantage') {
        throw new IntentError(`unknown roll mode "${String(mode)}"`, 'INVALID');
      }
      return buildRollAction(actor, intent.actionId, mode);
    }
    case 'attack': {
      const mode = intent.mode;
      if (mode !== undefined && mode !== 'advantage' && mode !== 'disadvantage') {
        throw new IntentError(`unknown roll mode "${String(mode)}"`, 'INVALID');
      }
      const itemId = intent.actionId.slice('item.'.length, -'.attack'.length);
      if (targeted !== undefined) {
        return { endpoint: 'use-on-targets', itemId, targetTokenUuids: targeted, ...(mode !== undefined ? { mode } : {}) };
      }
      // Plain Roll: Foundry-native item use (consumes ammo/uses, rolls to hit).
      if (mode === undefined) return { endpoint: 'use-item', itemId };
      // Advantage/disadvantage: companion-built to-hit (the relay's use-item
      // path exposes no advantage without execute-JS). Best-effort bonus;
      // ammo/uses and auto-crit are NOT modelled on this path.
      const item = (actor.items ?? []).find((i) => i._id === itemId);
      if (!item) throw new IntentError(`unknown weapon "${itemId}"`, 'UNKNOWN_RESOURCE');
      return {
        endpoint: 'roll',
        formula: d20Formula(weaponAttackBonus(actor, item), mode),
        flavor: `${item.name} — Attack`,
      };
    }
    case 'damage': {
      // Weapons (item.<id>.damage) and damage spells (spell.<id>.damage) both
      // roll their damage as a bare display roll — the attack/cast already
      // activated in Foundry. Weapons use the weapon formula (ability mod +
      // weapon bonus); spells use the activity damage.parts formula.
      if (intent.critical !== undefined && typeof intent.critical !== 'boolean') {
        throw new IntentError('damage requires a boolean "critical"', 'INVALID');
      }
      if (
        intent.slotLevel !== undefined &&
        (!Number.isInteger(intent.slotLevel) || intent.slotLevel < 1 || intent.slotLevel > 9)
      ) {
        throw new IntentError('damage slotLevel must be an integer 1-9', 'INVALID');
      }
      const isSpell = intent.actionId.startsWith('spell.');
      const prefix = isSpell ? 'spell.' : 'item.';
      const itemId = intent.actionId.slice(prefix.length, -'.damage'.length);
      const item = (actor.items ?? []).find((i) => i._id === itemId);
      if (isSpell && item && intent.slotLevel !== undefined) {
        const baseLevel = numAt(item.system, 'level') ?? 0;
        if (intent.slotLevel < baseLevel) {
          throw new IntentError("damage slotLevel must be at least the spell's base level", 'INVALID');
        }
      }
      const formula = item
        ? isSpell
          ? itemDamageFormula(actor, item, intent.slotLevel)
          : weaponDamageFormula(actor, item)
        : undefined;
      if (!item || formula === undefined) {
        throw new IntentError(`no damage formula for "${intent.actionId}"`, 'UNKNOWN_RESOURCE');
      }
      if (intent.critical === true) {
        return { endpoint: 'roll', formula: criticalFormula(formula), flavor: `${item.name} — Critical Damage` };
      }
      return { endpoint: 'roll', formula, flavor: `${item.name} — Damage` };
    }
    case 'use': {
      // Items and features share the kind; the id prefix picks the endpoint.
      if (intent.actionId.startsWith('item.')) {
        const itemId = intent.actionId.slice('item.'.length, -'.use'.length);
        const item = (actor.items ?? []).find((i) => i._id === itemId);
        // Only attunement 'required' (or the pre-5.x numeric 1) gates use —
        // an 'optional'-attunement item works unattuned by the rules (it
        // just forgoes its attuned benefit), so isAttuneable (which includes
        // 'optional' for the toggle) must NOT be the gate here.
        if (item && requiresAttunement(item) && !isAttuned(item)) {
          throw new IntentError(`"${item.name}" requires attunement`, 'INVALID');
        }
        if (targeted !== undefined) {
          return { endpoint: 'use-on-targets', itemId, targetTokenUuids: targeted };
        }
        if (item) {
          const effect = effectTypeOf(item);
          if (effect === 'heal') {
            return buildHealAction(actor, item, intent.actionId, { forceSelf: true });
          }
          if (effect === 'damage') {
            assertUsesRemaining(item);
            const formula = itemDamageFormula(actor, item);
            if (!formula) throw new IntentError(`no damage formula for "${intent.actionId}"`, 'UNKNOWN_RESOURCE');
            // use-and-roll, not a bare roll: Foundry's activation consumes
            // the charge / destroys the bead; the roll is display only.
            return {
              endpoint: 'use-and-roll',
              use: 'use-item',
              itemId,
              formula,
              flavor: `${item.name} — Damage`,
              ...(hasAreaTemplate(item) ? { noTemplate: true as const } : {}),
            };
          }
        }
        return { endpoint: 'use-item', itemId, ...(item !== undefined && hasAreaTemplate(item) ? { noTemplate: true as const } : {}) };
      }
      const itemId = intent.actionId.slice('feature.'.length, -'.use'.length);
      const item = (actor.items ?? []).find((i) => i._id === itemId);
      if (targeted !== undefined) {
        return { endpoint: 'use-on-targets', itemId, targetTokenUuids: targeted };
      }
      if (item && activityType(item) === 'heal') {
        return buildHealAction(actor, item, intent.actionId);
      }
      return { endpoint: 'use-feature', itemId, ...(item !== undefined && hasAreaTemplate(item) ? { noTemplate: true as const } : {}) };
    }
    case 'cast': {
      const itemId = intent.actionId.slice('spell.'.length, -'.cast'.length);
      if (descriptor.slotLevels !== undefined && descriptor.slotLevels.length === 0) {
        throw new IntentError(`no spell slot available for "${intent.actionId}"`, 'INVALID');
      }
      const item = (actor.items ?? []).find((i) => i._id === itemId);
      const baseLevel = numAt(item?.system, 'level') ?? 0;
      // Resolve the paying slot: with a payable list, the intent's slotLevel
      // (default: base) must be in it. Without a list (cantrip/free-use/
      // pact) any slotLevel is ignored — today's behavior.
      let chosen = baseLevel;
      if (descriptor.slotLevels !== undefined) {
        chosen = intent.slotLevel ?? baseLevel;
        if (!descriptor.slotLevels.includes(chosen)) {
          throw new IntentError(`no ${ordinal(chosen)}-level slot available for "${intent.actionId}"`, 'INVALID');
        }
      }
      const upcast = descriptor.slotLevels !== undefined && chosen > baseLevel;
      if (targeted !== undefined) {
        return {
          endpoint: 'use-on-targets',
          itemId,
          targetTokenUuids: targeted,
          ...(upcast ? { slotKey: `spell${chosen}` } : {}),
        };
      }
      const buff = item ? selfBuffEffect(actor, item) : undefined;
      if (buff) {
        return {
          endpoint: 'cast-and-apply-effect',
          use: upcast ? 'cast-at-slot' : 'use-spell',
          itemId,
          ...(upcast ? { slotKey: `spell${chosen}` } : {}),
          effect: buff,
          ...(intent.targetActorId !== undefined && item !== undefined && !buffTargetIsSelf(item)
            ? { targetActorId: intent.targetActorId }
            : {}),
          ...(item !== undefined && hasAreaTemplate(item) ? { noTemplate: true as const } : {}),
        };
      }
      if (item && activityType(item) === 'heal') {
        return buildHealAction(actor, item, intent.actionId, upcast ? { slotLevel: chosen } : undefined);
      }
      // Cast = the to-hit/activation (use-spell; the relay auto-rolls an attack
      // activity). Damage is a SEPARATE `spell.<id>.damage` action, exactly like
      // weapons (attack + Dmg) — see the 'damage' case and buildActions.
      if (upcast) {
        return { endpoint: 'cast-at-slot', itemId, slotKey: `spell${chosen}` };
      }
      return { endpoint: 'use-spell', itemId, ...(item !== undefined && hasAreaTemplate(item) ? { noTemplate: true as const } : {}) };
    }
    case 'equip': {
      if (typeof intent.equipped !== 'boolean') {
        throw new IntentError('equip requires a boolean "equipped"', 'INVALID');
      }
      return {
        endpoint: 'equip-item',
        itemId: intent.actionId.slice('item.'.length, -'.equip'.length),
        equipped: intent.equipped,
      };
    }
    case 'attune': {
      if (typeof intent.attuned !== 'boolean') {
        throw new IntentError('attune requires a boolean "attuned"', 'INVALID');
      }
      // The attunement cap is deliberately NOT enforced here (the relay
      // module does not enforce it either) — Foundry/GM owns rules; the
      // sheet only surfaces the count via the gearstats section.
      return {
        endpoint: 'attune-item',
        itemId: intent.actionId.slice('item.'.length, -'.attune'.length),
        attuned: intent.attuned,
      };
    }
    case 'grip': {
      if (intent.grip !== 'oneHanded' && intent.grip !== 'twoHanded') {
        throw new IntentError('grip requires "oneHanded" or "twoHanded"', 'INVALID');
      }
      return {
        endpoint: 'update-item',
        itemId: intent.actionId.slice('item.'.length, -'.grip'.length),
        data: { 'flags.unseen-servent.grip': intent.grip },
      };
    }
    case 'prepare': {
      if (typeof intent.prepared !== 'boolean') {
        throw new IntentError('prepare requires a boolean "prepared"', 'INVALID');
      }
      // dnd5e 5.3.3: numeric `system.prepared` (0/1/2). The module's own
      // prepare-spell endpoint writes the pre-5.x `system.preparation.*`
      // path and is dead on this system version — bypass it with a plain
      // item-field update.
      return {
        endpoint: 'update-item',
        itemId: intent.actionId.slice('spell.'.length, -'.prepare'.length),
        data: { 'system.prepared': intent.prepared ? 1 : 0 },
      };
    }
    case 'move': {
      if (intent.containerId !== null && (typeof intent.containerId !== 'string' || intent.containerId === '')) {
        throw new IntentError('move requires a container id or null', 'INVALID');
      }
      const itemId = intent.actionId.slice('item.'.length, -'.move'.length);
      if (intent.containerId !== null) {
        const items = new Map((actor.items ?? []).map((i) => [i._id, i]));
        const target = items.get(intent.containerId);
        if (!target || target.type !== 'container') {
          throw new IntentError('move target must be a container on this sheet', 'INVALID');
        }
        if (intent.containerId === itemId) {
          throw new IntentError('an item cannot contain itself', 'INVALID');
        }
        // No cycles: walk the target's containment chain upward; hitting the
        // moved item means the target lives (transitively) inside it.
        let cursor: string | undefined = intent.containerId;
        const hops = new Set<string>();
        while (cursor !== undefined && !hops.has(cursor)) {
          hops.add(cursor);
          const parent = strAt(items.get(cursor)?.system, 'container');
          if (parent === itemId) {
            throw new IntentError('cannot move a container into its own contents', 'INVALID');
          }
          cursor = parent !== undefined && parent !== '' && items.has(parent) ? parent : undefined;
        }
      }
      return {
        endpoint: 'update-item',
        itemId,
        data: { 'system.container': intent.containerId ?? '' },
      };
    }
    // M8 actor-scoped commands: no item target, no params. The descriptor
    // lookup + kind check above already reject unknown/absent ids (e.g.
    // deathsave.roll when the actor is not down).
    case 'rest':
      return { endpoint: intent.actionId === 'rest.long' ? 'long-rest' : 'short-rest' };
    case 'deathsave':
      return { endpoint: 'death-save' };
    case 'endconcentration':
      return { endpoint: 'break-concentration' };
    case 'endeffect': {
      const m = /^effect\.([A-Za-z0-9]{1,16})\.remove$/.exec(intent.actionId);
      if (!m) throw new IntentError(`bad endeffect action "${intent.actionId}"`, 'INVALID');
      return { endpoint: 'remove-effect', effectId: m[1] as string };
    }
    default:
      throw new IntentError(`unknown intent kind "${String((intent as { kind: unknown }).kind)}"`, 'INVALID');
  }
}

/** Read-only inventory counters (M12): attuned count vs the actor's cap, and
 * carried weight. Presentation only — nothing here gates any action. */
function gearStats(actor: FoundryActorDoc): Stat[] {
  const physical = (actor.items ?? []).filter((i) => PHYSICAL_ITEM_TYPES.has(i.type));
  const attunedCount = physical.filter(isAttuned).length;
  const attunementMax = numAt(actor.system, 'attributes.attunement.max') ?? 3;
  // Sum per unit — a world is normally uniform (imperial or metric), but a
  // mixed bag must not silently add kg to lb under one label.
  const sums = new Map<string, number>();
  for (const item of physical) {
    const weight = numAt(item.system, 'weight.value');
    if (weight === undefined || weight <= 0) continue;
    const unit = strAt(item.system, 'weight.units') || 'lb';
    sums.set(unit, (sums.get(unit) ?? 0) + weight * (numAt(item.system, 'quantity') ?? 1));
  }
  const round1 = (n: number): number => Math.round(n * 10) / 10;
  const localSum = [...sums.entries()].map(([unit, n]) => `${round1(n)} ${unit}`).join(' + ') || '0 lb';
  // Prefer the derived encumbrance the enriched doc carries (value/max); its
  // unit follows the world setting, best inferred from the items themselves.
  const encUnit = sums.size === 1 ? [...sums.keys()][0] : 'lb';
  const encValue = numAt(actor.system, 'attributes.encumbrance.value');
  const encMax = numAt(actor.system, 'attributes.encumbrance.max');
  const weightValue =
    encValue !== undefined && encMax !== undefined
      ? `${round1(encValue)}/${round1(encMax)} ${encUnit}`
      : localSum;
  return [
    { id: 'attunement', label: 'Attunement', value: `${attunedCount}/${attunementMax}` },
    { id: 'weight', label: 'Carried weight', value: weightValue },
  ];
}

// ---------------------------------------------------------------------------

function toViewModel(actor: FoundryActorDoc): SheetViewModel {
  const resources = buildResources(actor);
  const resourceIds = new Set(resources.map((r) => r.id));
  const classes = classItems(actor);
  const level = characterLevel(actor);

  const classLine =
    classes.length > 0
      ? [...classes]
          .sort((a, b) => b.levels - a.levels || a.name.localeCompare(b.name))
          .map((c) => `${c.name} ${c.levels}`)
          .join(' / ')
      : `Level ${level}`;
  const headline: Stat[] = [
    { id: 'ac', label: 'AC', value: armorClass(actor) },
    { id: 'class', label: 'Class', value: classLine },
    { id: 'speed', label: 'Speed', value: speedLine(actor) },
    { id: 'prof', label: 'Proficiency', value: signed(proficiency(actor)) },
    { id: 'init', label: 'Initiative', value: signed(initiative(actor)), actionId: 'init.roll' },
  ];

  const features: ListItem[] = [];
  /** Spell rows grouped by level, insertion-ordered within a level. */
  const spellsByLevel = new Map<number, ListItem[]>();
  const physicalIds = new Set((actor.items ?? []).filter((i) => PHYSICAL_ITEM_TYPES.has(i.type)).map((i) => i._id));
  for (const item of actor.items ?? []) {
    if (item.type === 'feat') features.push(featureListItem(item, resourceIds));
    else if (item.type === 'spell') {
      const level = Math.max(0, Math.min(9, numAt(item.system, 'level') ?? 0));
      const list = spellsByLevel.get(level);
      if (list) list.push(spellListItem(item, resourceIds));
      else spellsByLevel.set(level, [spellListItem(item, resourceIds)]);
    }
  }

  const vitalsIds = [
    'hp',
    'hp.temp',
    'deathsaves.success',
    'deathsaves.failure',
    ...resources.filter((r) => r.id.startsWith('hitdice.')).map((r) => r.id),
    'inspiration',
    'exhaustion',
  ];
  const slotIds = resources.filter((r) => r.id.startsWith('slots.')).map((r) => r.id);

  const sections: SheetSection[] = [
    { kind: 'stats', id: 'abilities', label: 'Abilities', stats: abilityStats(actor) },
    { kind: 'stats', id: 'saves', label: 'Saving Throws', stats: saveStats(actor) },
    { kind: 'stats', id: 'skills', label: 'Skills', stats: skillStats(actor) },
    { kind: 'stats', id: 'passives', label: 'Passive Senses', stats: passiveStats(actor) },
  ];
  const saveNotes = saveNoteStats(actor);
  if (saveNotes.length > 0) {
    sections.splice(2, 0, { kind: 'stats', id: 'savenotes', label: 'Saving Throw Notes', stats: saveNotes });
  }
  const traits = traitStats(actor);
  if (traits.length > 0) {
    sections.push({ kind: 'stats', id: 'traits', label: 'Proficiencies & Traits', stats: traits });
  }
  const senses = senseStats(actor);
  if (senses.length > 0) {
    sections.push({ kind: 'stats', id: 'senses', label: 'Senses', stats: senses });
  }
  sections.push({ kind: 'tracks', id: 'vitals', label: 'Vitals', resourceIds: vitalsIds });
  if (slotIds.length > 0) {
    sections.push({ kind: 'tracks', id: 'slots', label: 'Spell Slots', resourceIds: slotIds });
  }
  const physicalItems = (actor.items ?? []).filter((i) => PHYSICAL_ITEM_TYPES.has(i.type));

  /** Resolved location: a container id on this sheet, else undefined (Carried). */
  const locationOf = (item: FoundryItemDoc): string | undefined => {
    const c = strAt(item.system, 'container');
    return c !== undefined && c !== '' && c !== item._id && physicalIds.has(c) ? c : undefined;
  };

  const carried: ListItem[] = [];
  const byContainer = new Map<string, ListItem[]>();
  for (const item of physicalItems) {
    const loc = locationOf(item);
    const row = inventoryListItem(item, resourceIds, physicalIds);
    if (loc !== undefined) {
      const list = byContainer.get(loc);
      if (list) list.push(row);
      else byContainer.set(loc, [row]);
    } else if (item.type !== 'container') {
      carried.push(row); // containers render as sections, not Carried rows
    }
  }

  sections.push({ kind: 'list', id: 'inventory', label: 'Carried', items: carried });
  for (const item of physicalItems) {
    if (item.type !== 'container') continue;
    const contents = byContainer.get(item._id) ?? [];
    const header = inventoryListItem(item, resourceIds, physicalIds);
    // Presentation-only contents weight (direct contents; same parsing as rows).
    let total = 0;
    let unit = 'lb';
    for (const child of physicalItems) {
      if (locationOf(child) !== item._id) continue;
      const w = numAt(child.system, 'weight.value');
      if (w === undefined || w <= 0) continue;
      total += w * (numAt(child.system, 'quantity') ?? 1);
      unit = strAt(child.system, 'weight.units') || unit;
    }
    if (total > 0) header.sub = `${header.sub} · Σ ${Number(total.toFixed(2))} ${unit}`;
    sections.push({ kind: 'list', id: `inventory.${item._id}`, label: item.name, header, items: contents });
  }
  sections.push({ kind: 'stats', id: 'gearstats', label: 'Gear', stats: gearStats(actor) });
  sections.push({ kind: 'list', id: 'features', label: 'Features', items: features });
  // One collapsible section per spell level (2026-07-18 design), same
  // headline mechanism as inventory containers. Section ids keep the
  // 'spells' stem so the PWA's tab heuristic still routes them.
  for (const level of [...spellsByLevel.keys()].sort((a, b) => a - b)) {
    const items = spellsByLevel.get(level) ?? [];
    const label = level === 0 ? 'Cantrips' : `${ordinal(level)} Level`;
    sections.push({
      kind: 'list',
      id: `spells.l${level}`,
      label,
      header: { id: `spells.l${level}.header`, label, sub: `${items.length} ${items.length === 1 ? 'spell' : 'spells'}` },
      items,
    });
  }
  // "Character" deliberately matches neither of the PWA's tab regexes
  // (spell/gear), so the section routes to Overview.
  const biography = biographyItems(actor);
  if (biography.length > 0) {
    sections.push({ kind: 'list', id: 'biography', label: 'Character', items: biography });
  }
  sections.push({
    kind: 'tracks',
    id: 'currency',
    label: 'Currency',
    resourceIds: CURRENCIES.map((c) => `currency.${c.id}`),
  });

  const { concentration, conditions } = parseEffects(actor);

  return {
    actorId: actor._id,
    systemId: 'dnd5e',
    name: actor.name,
    ...(actor.img !== undefined ? { img: actor.img } : {}),
    headline,
    sections,
    resources,
    actions: buildActions(actor),
    concentration,
    ...(conditions.length > 0 ? { conditions } : {}),
    library: LIBRARY.map((c) => ({ id: c.id, label: c.label })),
  };
}

// ---------------------------------------------------------------------------

/**
 * The relay's plain /get serializes source data, which for spell slots has
 * only {value, override} — no max (it is derived at runtime). The relay's
 * dnd5e endpoint (`details=["spells"]`) returns the real derived slots, e.g.
 * `{ spellSlots: { spell3: { value: 0, max: 2 } } }` (M0-verified). Merge
 * value+max into the document so bounds are correct and empty slots do not
 * vanish from the sheet. The `stats` detail (M10-verified) additionally
 * exposes derived encumbrance, merged under `system.attributes.encumbrance`
 * for the carried-weight counter, and the real derived `ac` (active-effect
 * bonuses like Fighting Style: Defense that the local armor fallback cannot
 * see), merged under `system.attributes.ac.value` — one call covers both
 * details. IO failure returns the actor unchanged.
 */
async function enrich(actor: FoundryActorDoc, io: AdapterIO): Promise<FoundryActorDoc> {
  // Everyone gets `stats` (encumbrance); only casters need `spells`.
  const hasSpellcasting =
    (actor.items ?? []).some((i) => i.type === 'spell') ||
    Object.keys(rec(getPath(actor.system, 'spells'))).length > 0;
  let details: unknown;
  try {
    details = await io.getSystemDetails(
      hasSpellcasting
        ? ['spells', 'stats', 'skills', 'abilities']
        : ['stats', 'skills', 'abilities'],
    );
  } catch {
    return actor;
  }
  const body = rec(details);
  const system = rec(actor.system);
  let merged: Rec | undefined;

  const slots = rec(body.spellSlots);
  const slotKeys = Object.keys(slots);
  if (slotKeys.length > 0) {
    const spells = { ...rec(system.spells) };
    for (const key of slotKeys) {
      const derived = rec(slots[key]);
      const max = typeof derived.max === 'number' && Number.isFinite(derived.max) ? derived.max : undefined;
      const value = typeof derived.value === 'number' && Number.isFinite(derived.value) ? derived.value : undefined;
      // Pact entries additionally carry the derived slot LEVEL (module
      // 3.4.1: `spellSlots.pact = {value, max, level}`) — canCastAtBase
      // needs it, and like max it never appears in source data.
      const level = typeof derived.level === 'number' && Number.isFinite(derived.level) ? derived.level : undefined;
      if (max === undefined && value === undefined && level === undefined) continue;
      spells[key] = {
        ...rec(spells[key]),
        ...(value !== undefined ? { value } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(level !== undefined ? { level } : {}),
      };
    }
    merged = { ...system, spells };
  }

  const stats = rec(body.stats);
  const acDerived = typeof stats.ac === 'number' && Number.isFinite(stats.ac) ? stats.ac : undefined;
  if (acDerived !== undefined) {
    const base = merged ?? { ...system };
    const attributes = rec(base.attributes);
    base.attributes = { ...attributes, ac: { ...rec(attributes.ac), value: acDerived } };
    merged = base;
  }

  const encumbrance = rec(stats.encumbrance);
  const encValue = typeof encumbrance.value === 'number' && Number.isFinite(encumbrance.value) ? encumbrance.value : undefined;
  const encMax = typeof encumbrance.max === 'number' && Number.isFinite(encumbrance.max) ? encumbrance.max : undefined;
  if (encValue !== undefined || encMax !== undefined) {
    const base = merged ?? { ...system };
    const attributes = rec(base.attributes);
    base.attributes = {
      ...attributes,
      encumbrance: {
        ...rec(attributes.encumbrance),
        ...(encValue !== undefined ? { value: encValue } : {}),
        ...(encMax !== undefined ? { max: encMax } : {}),
      },
    };
    merged = base;
  }

  const initBonus =
    typeof stats.initBonus === 'number' && Number.isFinite(stats.initBonus) ? stats.initBonus : undefined;
  if (initBonus !== undefined) {
    const base = merged ?? { ...system };
    const attributes = rec(base.attributes);
    base.attributes = { ...attributes, init: { ...rec(attributes.init), total: initBonus } };
    merged = base;
  }

  const derivedSkills = rec(body.skills);
  const skillKeys = Object.keys(derivedSkills);
  if (skillKeys.length > 0) {
    const base = merged ?? { ...system };
    const skills = { ...rec(base.skills) };
    for (const key of skillKeys) {
      const d = rec(derivedSkills[key]);
      const total = typeof d.total === 'number' && Number.isFinite(d.total) ? d.total : undefined;
      const mod = typeof d.mod === 'number' && Number.isFinite(d.mod) ? d.mod : undefined;
      const passive = typeof d.passive === 'number' && Number.isFinite(d.passive) ? d.passive : undefined;
      if (total === undefined && mod === undefined && passive === undefined) continue;
      skills[key] = {
        ...rec(skills[key]),
        ...(total !== undefined ? { total } : {}),
        ...(mod !== undefined ? { mod } : {}),
        ...(passive !== undefined ? { passive } : {}),
      };
    }
    base.skills = skills;
    merged = base;
  }

  const derivedAbilities = rec(body.abilities);
  const abilityKeys = Object.keys(derivedAbilities);
  if (abilityKeys.length > 0) {
    const base = merged ?? { ...system };
    const abilities = { ...rec(base.abilities) };
    for (const key of abilityKeys) {
      const d = rec(derivedAbilities[key]);
      const mod = typeof d.mod === 'number' && Number.isFinite(d.mod) ? d.mod : undefined;
      const save = typeof d.save === 'number' && Number.isFinite(d.save) ? d.save : undefined;
      if (mod === undefined && save === undefined) continue;
      const prev = rec(abilities[key]);
      abilities[key] = {
        ...prev,
        ...(mod !== undefined ? { mod } : {}),
        ...(save !== undefined ? { save: { ...rec(prev.save), value: save } } : {}),
      };
    }
    base.abilities = abilities;
    merged = base;
  }

  // 2026-07-22 Mage Armor: the relay's get-actor-details stats.ac does not
  // recompute ac.calc overrides. When an AC-touching effect is active, read
  // the live prepared AC (execute-js) and let it win; null degrades to the
  // stats.ac merge above.
  if (hasAcEffect(actor) && io.getDerivedAc !== undefined) {
    try {
      const liveAc = await io.getDerivedAc();
      if (liveAc !== null) {
        const base = merged ?? { ...system };
        const attributes = rec(base.attributes);
        base.attributes = { ...attributes, ac: { ...rec(attributes.ac), value: liveAc } };
        merged = base;
      }
    } catch {
      /* keep the stats.ac merge */
    }
  }

  return merged === undefined ? actor : { ...actor, system: merged };
}

export const dnd5eAdapter: SystemAdapter = {
  systemId: 'dnd5e',
  enrich,
  toViewModel,
  resources: buildResources,
  buildUpdate,
  actions: buildActions,
  buildAction,
  library: LIBRARY,
};

export default dnd5eAdapter;
