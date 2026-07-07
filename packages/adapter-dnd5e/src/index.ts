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
  AdapterIO,
  FoundryActorDoc,
  FoundryItemDoc,
  FoundryUpdate,
  ListItem,
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

const PHYSICAL_ITEM_TYPES = new Set(['weapon', 'equipment', 'consumable', 'tool', 'container', 'loot']);

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
  }));
}

function skillStats(actor: FoundryActorDoc): Stat[] {
  const prof = proficiency(actor);
  return SKILLS.map((s) => {
    const skill = rec(getPath(actor.system, `skills.${s.id}`));
    const ability = typeof skill.ability === 'string' && skill.ability !== '' ? skill.ability : s.ability;
    const profMult = typeof skill.value === 'number' && Number.isFinite(skill.value) ? skill.value : 0;
    const derivedTotal = typeof skill.total === 'number' && Number.isFinite(skill.total) ? skill.total : undefined;
    const total = derivedTotal ?? abilityMod(actor.system, ability) + Math.floor(profMult * prof);
    const subParts = [ability.toUpperCase()];
    if (profMult >= 2) subParts.push('expertise');
    else if (profMult >= 1) subParts.push('proficient');
    else if (profMult > 0) subParts.push('half proficiency');
    return { id: `skill.${s.id}`, label: s.label, value: signed(total), sub: subParts.join(' · ') };
  });
}

function inventoryListItem(item: FoundryItemDoc, resourceIds: Set<string>): ListItem {
  const qty = numAt(item.system, 'quantity') ?? 1;
  const subParts: string[] = [];
  if (qty !== 1) subParts.push(`×${qty}`);
  subParts.push(item.type);
  const usesId = `item.${item._id}.uses`;
  const qtyId = `item.${item._id}.qty`;
  const resourceId = resourceIds.has(usesId) ? usesId : resourceIds.has(qtyId) ? qtyId : undefined;
  const tags: string[] = [];
  if (getPath(item.system, 'equipped') === true) tags.push('equipped');
  return {
    id: item._id,
    label: item.name,
    sub: subParts.join(' · '),
    ...(item.img !== undefined ? { img: item.img } : {}),
    ...(resourceId !== undefined ? { resourceId } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

function featureListItem(item: FoundryItemDoc, resourceIds: Set<string>): ListItem {
  const featType = strAt(item.system, 'type.value');
  const sub = featType === 'class' ? 'Class feature' : 'Feat';
  const usesId = `item.${item._id}.uses`;
  return {
    id: item._id,
    label: item.name,
    sub,
    ...(item.img !== undefined ? { img: item.img } : {}),
    ...(resourceIds.has(usesId) ? { resourceId: usesId } : {}),
  };
}

function spellListItem(item: FoundryItemDoc): ListItem {
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

  return {
    id: item._id,
    label: item.name,
    sub: subParts.join(' · '),
    ...(item.img !== undefined ? { img: item.img } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

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
    { id: 'init', label: 'Initiative', value: signed(initiative(actor)) },
  ];

  const inventory: ListItem[] = [];
  const features: ListItem[] = [];
  const spells: ListItem[] = [];
  for (const item of actor.items ?? []) {
    if (PHYSICAL_ITEM_TYPES.has(item.type)) inventory.push(inventoryListItem(item, resourceIds));
    else if (item.type === 'feat') features.push(featureListItem(item, resourceIds));
    else if (item.type === 'spell') spells.push(spellListItem(item));
  }

  const vitalsIds = [
    'hp',
    'hp.temp',
    'deathsaves.success',
    'deathsaves.failure',
    ...resources.filter((r) => r.id.startsWith('hitdice.')).map((r) => r.id),
  ];
  const slotIds = resources.filter((r) => r.id.startsWith('slots.')).map((r) => r.id);

  const sections: SheetSection[] = [
    { kind: 'stats', id: 'abilities', label: 'Abilities', stats: abilityStats(actor) },
    { kind: 'stats', id: 'skills', label: 'Skills', stats: skillStats(actor) },
    { kind: 'tracks', id: 'vitals', label: 'Vitals', resourceIds: vitalsIds },
  ];
  if (slotIds.length > 0) {
    sections.push({ kind: 'tracks', id: 'slots', label: 'Spell Slots', resourceIds: slotIds });
  }
  sections.push({ kind: 'list', id: 'inventory', label: 'Inventory', items: inventory });
  sections.push({ kind: 'list', id: 'features', label: 'Features', items: features });
  if (spells.length > 0) {
    sections.push({ kind: 'list', id: 'spells', label: 'Spells', items: spells });
  }
  sections.push({
    kind: 'tracks',
    id: 'currency',
    label: 'Currency',
    resourceIds: CURRENCIES.map((c) => `currency.${c.id}`),
  });

  return {
    actorId: actor._id,
    systemId: 'dnd5e',
    name: actor.name,
    ...(actor.img !== undefined ? { img: actor.img } : {}),
    headline,
    sections,
    resources,
  };
}

// ---------------------------------------------------------------------------

/**
 * The relay's plain /get serializes source data, which for spell slots has
 * only {value, override} — no max (it is derived at runtime). The relay's
 * dnd5e endpoint (`details=["spells"]`) returns the real derived slots, e.g.
 * `{ spellSlots: { spell3: { value: 0, max: 2 } } }` (M0-verified). Merge
 * value+max into the document so bounds are correct and empty slots do not
 * vanish from the sheet. IO failure returns the actor unchanged.
 */
async function enrich(actor: FoundryActorDoc, io: AdapterIO): Promise<FoundryActorDoc> {
  // Only casters benefit; skip the extra relay round-trip for others.
  const hasSpellcasting =
    (actor.items ?? []).some((i) => i.type === 'spell') ||
    Object.keys(rec(getPath(actor.system, 'spells'))).length > 0;
  if (!hasSpellcasting) return actor;
  let details: unknown;
  try {
    details = await io.getSystemDetails(['spells']);
  } catch {
    return actor;
  }
  const slots = rec(rec(details).spellSlots);
  const slotKeys = Object.keys(slots);
  if (slotKeys.length === 0) return actor;
  const system = rec(actor.system);
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
  return { ...actor, system: { ...system, spells } };
}

export const dnd5eAdapter: SystemAdapter = {
  systemId: 'dnd5e',
  enrich,
  toViewModel,
  resources: buildResources,
  buildUpdate,
};

export default dnd5eAdapter;
