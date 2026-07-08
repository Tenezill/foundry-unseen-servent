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

interface SlotInfo {
  id: string;
  label: string;
  value: number;
  max: number;
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
      out.push({ id: `slots.${lvl}`, label: `${ordinal(lvl)}-Level Slots`, value, max: Math.max(max, value) });
    }
  }
  const pact = rec(getPath(actor.system, 'spells.pact'));
  const pactValue = typeof pact.value === 'number' && Number.isFinite(pact.value) ? pact.value : 0;
  const pactMax =
    (typeof pact.max === 'number' && Number.isFinite(pact.max) ? pact.max : undefined) ??
    (typeof pact.override === 'number' && Number.isFinite(pact.override) ? pact.override : undefined) ??
    pactValue;
  if (pactMax > 0 || pactValue > 0) {
    out.push({ id: 'slots.pact', label: 'Pact Slots', value: pactValue, max: Math.max(pactMax, pactValue) });
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
    out.push({ id: slot.id, label: slot.label, value: slot.value, min: 0, max: slot.max, writable: true, group: 'slots' });
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

  if (id === 'hp') return { data: { 'system.attributes.hp.value': target } };
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
  return ABILITIES.map((a) => ({
    id: `ability.${a.id}`,
    label: a.label,
    value: abilityScore(actor.system, a.id),
    sub: signed(abilityMod(actor.system, a.id)),
    actionId: `ability.${a.id}.check`,
  }));
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
    out.push({ id: 'bio', label: 'Biography', sub: 'Tap to read', detail: bio });
  }
  for (const f of PERSONALITY_FIELDS) {
    const v = strAt(actor.system, `details.${f.id}`);
    if (v !== undefined && v.trim() !== '') out.push({ id: f.id, label: f.label, sub: v });
  }
  return out;
}

/** Save bonus = ability mod + prof when save-proficient (`abilities.<id>.proficient` >= 1). */
function saveBonus(actor: FoundryActorDoc, abilityId: string): number {
  const proficient = numAt(actor.system, `abilities.${abilityId}.proficient`) ?? 0;
  return abilityMod(actor.system, abilityId) + (proficient >= 1 ? proficiency(actor) : 0);
}

function skillStats(actor: FoundryActorDoc): Stat[] {
  return SKILLS.map((s) => {
    const { total, ability, profMult } = skillInfo(actor, s);
    const subParts = [ability.toUpperCase()];
    if (profMult >= 2) subParts.push('expertise');
    else if (profMult >= 1) subParts.push('proficient');
    else if (profMult > 0) subParts.push('half proficiency');
    return {
      id: `skill.${s.id}`,
      label: s.label,
      value: signed(total),
      sub: subParts.join(' · '),
      actionId: `skill.${s.id}`,
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
 * The item's own description HTML (`system.description.value`), for the M8
 * detail view. Content from the user's OWN world — the repo ships none; the
 * client sanitizes before rendering. Empty/missing -> undefined.
 */
function itemDetail(item: FoundryItemDoc): string | undefined {
  const v = getPath(item.system, 'description.value');
  return typeof v === 'string' && v !== '' ? v : undefined;
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
    conditions.push({
      id,
      label: name,
      ...(typeof eff.icon === 'string' ? { icon: eff.icon } : {}),
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

function spellListItem(item: FoundryItemDoc): ListItem {
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

  const subParts: string[] = [level === 0 ? 'Cantrip' : `${ordinal(level)} level`];
  const schoolLabel = school !== undefined ? SPELL_SCHOOLS[school] : undefined;
  if (schoolLabel !== undefined) subParts.push(schoolLabel);
  if (always) subParts.push('always prepared');
  else if (isPrepared) subParts.push('prepared');

  const tags: string[] = [];
  if (isPrepared) tags.push('prepared');
  if (properties.includes('concentration')) tags.push('concentration');
  if (properties.includes('ritual')) tags.push('ritual');

  const detail = itemDetail(item);
  return {
    id: item._id,
    label: item.name,
    sub: subParts.join(' · '),
    ...(item.img !== undefined ? { img: item.img } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(isPreparableSpell(item) ? { toggleActionId: `spell.${item._id}.prepare` } : {}),
    // Any spell on the sheet may be removed via the library API.
    removable: 'spells',
    actionId,
  };
}

/** Leveled, not-always-prepared spells may be toggled; cantrips and
 * `prepared: 2` (always prepared, e.g. domain spells) may not. */
function isPreparableSpell(item: FoundryItemDoc): boolean {
  if (item.type !== 'spell') return false;
  const level = numAt(item.system, 'level') ?? 0;
  return level > 0 && getPath(item.system, 'prepared') !== 2;
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
  const detail = getPath(system, 'description.value');
  const name = typeof doc.name === 'string' && doc.name !== '' ? doc.name : 'Unknown spell';
  const id = typeof doc._id === 'string' && doc._id !== '' ? doc._id : slug(name);
  return {
    id,
    label: name,
    sub: subParts.join(' · '),
    ...(typeof doc.img === 'string' ? { img: doc.img } : {}),
    ...(typeof detail === 'string' && detail !== '' ? { detail } : {}),
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
  const detail = getPath(system, 'description.value');
  const name = typeof doc.name === 'string' && doc.name !== '' ? doc.name : 'Unknown feat';
  const id = typeof doc._id === 'string' && doc._id !== '' ? doc._id : slug(name);
  return {
    id,
    label: name,
    sub,
    ...(typeof doc.img === 'string' ? { img: doc.img } : {}),
    ...(typeof detail === 'string' && detail !== '' ? { detail } : {}),
  };
}

/**
 * Preview ListItem for a RAW physical-item document (compendium search hit) —
 * the add-confirm sheet renders it. sub is the item's Foundry type
 * (weapon/equipment/consumable…), mirroring inventoryListItem.
 */
function gearPreview(doc: Rec): ListItem {
  const detail = getPath(rec(doc.system), 'description.value');
  const name = typeof doc.name === 'string' && doc.name !== '' ? doc.name : 'Unknown item';
  const id = typeof doc._id === 'string' && doc._id !== '' ? doc._id : slug(name);
  const type = typeof doc.type === 'string' && doc.type !== '' ? doc.type : undefined;
  return {
    id,
    label: name,
    ...(type !== undefined ? { sub: type } : {}),
    ...(typeof doc.img === 'string' ? { img: doc.img } : {}),
    ...(typeof detail === 'string' && detail !== '' ? { detail } : {}),
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
 */
function canCastAtBase(actor: FoundryActorDoc, spellLevel: number): boolean {
  if (spellLevel <= 0) return true;
  if ((numAt(actor.system, `spells.spell${spellLevel}.value`) ?? 0) > 0) return true;
  const pactValue = numAt(actor.system, 'spells.pact.value') ?? 0;
  const pactLevel = numAt(actor.system, 'spells.pact.level') ?? 0;
  return pactValue > 0 && pactLevel >= spellLevel;
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
    if (item.type === 'weapon') {
      out.push({ id: `item.${item._id}.attack`, label: item.name, kind: 'attack' });
    }
    if (isUsableInventoryItem(item)) {
      // Offered even at 0 uses/quantity — Foundry owns the rules and refuses
      // when empty (same philosophy as unprepared spells).
      out.push({ id: `item.${item._id}.use`, label: item.name, kind: 'use', group: 'items' });
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
    if (item.type === 'spell') {
      // Deliberately offer EVERY spell on the sheet, prepared or not
      // (mirrors spellListItem, which always sets actionId): dnd5e casts
      // unprepared spells legitimately via rituals, always-prepared domain
      // spells (`prepared: 2`), and table rulings. Foundry's use-spell
      // workflow owns preparation/slot rules and is free to refuse; the
      // sheet surfaces the prepared state as tags so the player can judge.
      const level = numAt(item.system, 'level') ?? 0;
      // The bridge casts at base level only (no upcast), so a spell is either
      // castable now (single Cast) or not (disabled). We signal this with
      // slotLevels: absent = castable directly (cantrip or a base slot is
      // free); [] = no slot, render disabled. No per-level picker — the
      // module cannot honour a chosen higher level.
      out.push({
        id: `spell.${item._id}.cast`,
        label: item.name,
        kind: 'cast',
        ...(level > 0 && !canCastAtBase(actor, level) ? { slotLevels: [] } : {}),
      });
      if (isPreparableSpell(item)) {
        const rawPrepared = getPath(item.system, 'prepared');
        out.push({
          id: `spell.${item._id}.prepare`,
          label: item.name,
          kind: 'prepare',
          prepared: rawPrepared === 1 || rawPrepared === true,
        });
      }
    }
    if (isUsableFeature(item)) {
      out.push({ id: `feature.${item._id}.use`, label: item.name, kind: 'use' });
    }
  }

  // M8 actor-scoped commands (no item target). Rests are always available;
  // concentration/death-save appear only when the actor's state calls for them.
  out.push({ id: 'rest.short', label: 'Short Rest', kind: 'rest' });
  out.push({ id: 'rest.long', label: 'Long Rest', kind: 'rest' });
  if (parseEffects(actor).concentration) {
    out.push({ id: 'concentration.end', label: 'End Concentration', kind: 'endconcentration' });
  }
  if ((numAt(actor.system, 'attributes.hp.value') ?? 0) <= 0) {
    out.push({ id: 'deathsave.roll', label: 'Death Save', kind: 'deathsave' });
  }
  return out;
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

  switch (intent.kind) {
    case 'check':
    case 'save': {
      const mode = intent.mode;
      if (mode !== undefined && mode !== 'advantage' && mode !== 'disadvantage') {
        throw new IntentError(`unknown roll mode "${String(mode)}"`, 'INVALID');
      }
      return buildRollAction(actor, intent.actionId, mode);
    }
    case 'attack':
      return { endpoint: 'use-item', itemId: intent.actionId.slice('item.'.length, -'.attack'.length) };
    case 'use': {
      // Items and features share the kind; the id prefix picks the endpoint.
      if (intent.actionId.startsWith('item.')) {
        return { endpoint: 'use-item', itemId: intent.actionId.slice('item.'.length, -'.use'.length) };
      }
      return { endpoint: 'use-feature', itemId: intent.actionId.slice('feature.'.length, -'.use'.length) };
    }
    case 'cast': {
      const itemId = intent.actionId.slice('spell.'.length, -'.cast'.length);
      // slotLevels === [] means no slot is available at the spell's base
      // level. The bridge casts at base only (no upcast), so intent.slotLevel
      // is intentionally ignored — Foundry consumes the base-level slot.
      if (descriptor.slotLevels !== undefined && descriptor.slotLevels.length === 0) {
        throw new IntentError(`no spell slot available for "${intent.actionId}"`, 'INVALID');
      }
      return { endpoint: 'use-spell', itemId };
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
    // M8 actor-scoped commands: no item target, no params. The descriptor
    // lookup + kind check above already reject unknown/absent ids (e.g.
    // deathsave.roll when the actor is not down).
    case 'rest':
      return { endpoint: intent.actionId === 'rest.long' ? 'long-rest' : 'short-rest' };
    case 'deathsave':
      return { endpoint: 'death-save' };
    case 'endconcentration':
      return { endpoint: 'break-concentration' };
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
    { id: 'xp', label: 'XP', value: numAt(actor.system, 'details.xp.value') ?? 0 },
  ];

  const inventory: ListItem[] = [];
  const features: ListItem[] = [];
  const spells: ListItem[] = [];
  const physicalIds = new Set((actor.items ?? []).filter((i) => PHYSICAL_ITEM_TYPES.has(i.type)).map((i) => i._id));
  for (const item of actor.items ?? []) {
    if (PHYSICAL_ITEM_TYPES.has(item.type)) inventory.push(inventoryListItem(item, resourceIds, physicalIds));
    else if (item.type === 'feat') features.push(featureListItem(item, resourceIds));
    else if (item.type === 'spell') spells.push(spellListItem(item));
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
    { kind: 'stats', id: 'skills', label: 'Skills', stats: skillStats(actor) },
    { kind: 'stats', id: 'passives', label: 'Passive Senses', stats: passiveStats(actor) },
  ];
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
  sections.push({ kind: 'list', id: 'inventory', label: 'Inventory', items: inventory });
  sections.push({ kind: 'stats', id: 'gearstats', label: 'Gear', stats: gearStats(actor) });
  sections.push({ kind: 'list', id: 'features', label: 'Features', items: features });
  if (spells.length > 0) {
    sections.push({ kind: 'list', id: 'spells', label: 'Spells', items: spells });
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
 * for the carried-weight counter — one call covers both details. IO failure
 * returns the actor unchanged.
 */
async function enrich(actor: FoundryActorDoc, io: AdapterIO): Promise<FoundryActorDoc> {
  // Everyone gets `stats` (encumbrance); only casters need `spells`.
  const hasSpellcasting =
    (actor.items ?? []).some((i) => i.type === 'spell') ||
    Object.keys(rec(getPath(actor.system, 'spells'))).length > 0;
  let details: unknown;
  try {
    details = await io.getSystemDetails(hasSpellcasting ? ['spells', 'stats'] : ['stats']);
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
      if (max === undefined && value === undefined) continue;
      spells[key] = {
        ...rec(spells[key]),
        ...(value !== undefined ? { value } : {}),
        ...(max !== undefined ? { max } : {}),
      };
    }
    merged = { ...system, spells };
  }

  const encumbrance = rec(rec(body.stats).encumbrance);
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
