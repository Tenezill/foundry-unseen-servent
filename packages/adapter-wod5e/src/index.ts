/**
 * wod5e (Vampire: the Masquerade V5) SystemAdapter (M23, PLAN.md §6/§7).
 *
 * Data paths are pinned to wod5e **5.3.15** on Foundry **v13** (the last
 * v13-compatible release — see the Task 0 findings doc,
 * docs/superpowers/specs/2026-07-11-vtm-player-ui-task0-findings.md, which is
 * normative for every path below).
 *
 * Critical, easy-to-get-wrong invariants (Task 0):
 *   - `system.health.value` / `system.willpower.value` are DERIVED/STALE in
 *     relay source data — never read or write them. Boxes render from
 *     `{max, superficial, aggravated}` only.
 *   - `system.disciplines.<key>.powers` is ALWAYS `[]` in source data — the
 *     adapter groups embedded items of `type:'power'` by `system.discipline`
 *     itself.
 *   - Weapon damage is `system.weaponvalue` (not `system.damage`); gear item
 *     type id is `gear`. No `equipped` flag exists on any item type — no
 *     equip toggle in v1.
 *
 * Task 2 implemented `toViewModel` + `resources`; Task 3 implemented
 * `buildUpdate` (write allow-list: health/willpower/hunger/humanity.stains,
 * tri-state clamp invariant). Task 4 (this pass) implements `actions` +
 * `buildAction`: one `kind:'pool'` descriptor per attribute/skill/power
 * (Strategy 2 formula rolls — see the Task 0 findings doc, roll strategy is
 * FINAL, per-die results are the gateway/PWA's concern) plus one
 * `kind:'rouse'` descriptor, and wires `actionId` onto the attribute/skill
 * stats and power list rows that Task 2 deliberately left bare.
 */
import type {
  ActionDescriptor,
  ActionIntent,
  BoxTrackSpec,
  CustomItemInput,
  FoundryActorDoc,
  FoundryItemDoc,
  FoundryUpdate,
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
// — same idiom as adapter-dnd5e, kept local since this adapter is small.

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

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function items(actor: FoundryActorDoc): FoundryItemDoc[] {
  return Array.isArray(actor.items) ? actor.items : [];
}

// ---------------------------------------------------------------------------
// Vocabulary (labels only — no game-rules content). Attribute and skill keys
// are pinned by the Task 0 path table and captured live from a prepared
// wod5e 5.3.15 actor (M23 Task 2 review finding): SOURCE data only persists
// keys the sheet has touched (the captured fixture has just 6 skill keys),
// so the untouched rest must render from these vocabularies at their
// defaults rather than being dropped. Later tasks (pool-roll builder) need
// the complete list to reference.

const ATTRIBUTES = [
  'strength',
  'dexterity',
  'stamina',
  'charisma',
  'manipulation',
  'composure',
  'intelligence',
  'wits',
  'resolve',
] as const;

const SKILLS = [
  'academics',
  'animalken',
  'athletics',
  'awareness',
  'brawl',
  'craft',
  'drive',
  'etiquette',
  'finance',
  'firearms',
  'insight',
  'intimidation',
  'investigation',
  'larceny',
  'leadership',
  'medicine',
  'melee',
  'occult',
  'performance',
  'persuasion',
  'politics',
  'science',
  'stealth',
  'streetwise',
  'subterfuge',
  'survival',
  'technology',
] as const;

// Known label override for the one skill key whose id doesn't capitalize
// naturally; any other key (including homebrew extras not in SKILLS) falls
// back to a plain capitalize().
const SKILL_LABELS: Record<string, string> = {
  animalken: 'Animal Ken',
};

function skillLabel(key: string): string {
  return SKILL_LABELS[key] ?? capitalize(key);
}

// Known label overrides for discipline keys whose id doesn't read naturally
// capitalized (Task 0: "14 keys incl. sorcery, alchemy"); any other key falls
// back to a plain capitalize().
const DISCIPLINE_LABELS: Record<string, string> = {
  sorcery: 'Blood Sorcery',
  alchemy: 'Thin-Blood Alchemy',
};

function disciplineLabel(key: string): string {
  return DISCIPLINE_LABELS[key] ?? capitalize(key);
}

const DOTS_MAX = 5;

// ---------------------------------------------------------------------------
// Attributes + skills + humanity (overview tab)

// Vocab entries in order, followed by any extra keys present in the source
// record but not in the vocab (homebrew) — real data is never dropped.
// Shared between the dots-stat renderer below and the Task-4 pool-action
// enumerator, so actions() always matches the exact set of stats rendered.
function vocabKeys(source: Rec, vocab: readonly string[]): string[] {
  const vocabSet = new Set<string>(vocab);
  const extras = Object.keys(source).filter((key) => !vocabSet.has(key));
  return [...vocab, ...extras];
}

// Renders a dots-stat list FROM a canonical vocabulary, merging any source
// values over it (missing key -> defaultValue). Extra keys present in the
// source record but not in the vocab (homebrew) still render, appended
// after the vocab entries — real data is never dropped. `actionPrefix`
// (Task 4), when given, wires `actionId: '<actionPrefix>.<idPrefix>.<key>'`
// onto every stat (pool rolls for attributes/skills; discipline ratings
// pass no prefix and get no actionId per the Task 4 brief).
function vocabDotsStats(
  source: Rec,
  vocab: readonly string[],
  idPrefix: string,
  labelFor: (key: string) => string,
  defaultValue: number,
  actionPrefix?: string,
): Stat[] {
  const stat = (key: string): Stat => ({
    id: `${idPrefix}.${key}`,
    label: labelFor(key),
    value: numAt(source, `${key}.value`) ?? defaultValue,
    display: 'dots' as const,
    max: DOTS_MAX,
    ...(actionPrefix !== undefined ? { actionId: `${actionPrefix}.${idPrefix}.${key}` } : {}),
  });
  return vocabKeys(source, vocab).map(stat);
}

function attributeStats(actor: FoundryActorDoc): Stat[] {
  const sys = rec(actor.system);
  const attributes = rec(sys.attributes);
  return vocabDotsStats(attributes, ATTRIBUTES, 'attr', capitalize, 1, 'pool'); // default/min 1 (Task 0)
}

function humanityStat(actor: FoundryActorDoc): Stat {
  const sys = rec(actor.system);
  return {
    id: 'humanity',
    label: 'Humanity',
    value: numAt(sys, 'humanity.value') ?? 7, // system template default (Task 0)
    display: 'dots',
    max: 10,
  };
}

function skillStats(actor: FoundryActorDoc): Stat[] {
  const sys = rec(actor.system);
  const skills = rec(sys.skills);
  return vocabDotsStats(skills, SKILLS, 'skill', skillLabel, 0, 'pool');
}

// ---------------------------------------------------------------------------
// Disciplines: dot ratings (disc.<key>) + powers list, grouped by discipline
// key from embedded `power` items (Task 0: disciplines.<key>.powers is always
// empty in source — never read it).

function powerItems(actor: FoundryActorDoc): FoundryItemDoc[] {
  return items(actor).filter((i) => i.type === 'power');
}

function disciplineKeys(actor: FoundryActorDoc): string[] {
  const sys = rec(actor.system);
  const disciplines = rec(sys.disciplines);
  const keys = new Set(Object.keys(disciplines));
  for (const power of powerItems(actor)) {
    const key = strAt(power.system, 'discipline');
    if (key) keys.add(key);
  }
  return [...keys];
}

function disciplineRatingStats(actor: FoundryActorDoc): Stat[] {
  const sys = rec(actor.system);
  const disciplines = rec(sys.disciplines);
  const powers = powerItems(actor);
  return disciplineKeys(actor)
    .filter((key) => {
      const node = rec(disciplines[key]);
      const value = numAt(node, 'value') ?? 0;
      const visible = node.visible === true;
      const hasPower = powers.some((p) => strAt(p.system, 'discipline') === key);
      return visible || value > 0 || hasPower;
    })
    .sort((a, b) => disciplineLabel(a).localeCompare(disciplineLabel(b)))
    .map((key) => ({
      id: `disc.${key}`,
      label: disciplineLabel(key),
      value: numAt(rec(disciplines[key]), 'value') ?? 0,
      display: 'dots' as const,
      max: DOTS_MAX,
    }));
}

function powerDetail(item: FoundryItemDoc): string | undefined {
  const v = getPath(item.system, 'description');
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function disciplinePowerItems(actor: FoundryActorDoc): ListItem[] {
  return powerItems(actor)
    .map((item) => {
      const disc = strAt(item.system, 'discipline') ?? '';
      const level = numAt(item.system, 'level') ?? 0;
      const entry: ListItem = {
        id: item._id,
        label: item.name,
        sub: `Level ${level} · ${disciplineLabel(disc)}`,
        actionId: `pool.power.${item._id}`,
      };
      const detail = powerDetail(item);
      if (detail !== undefined) entry.detail = detail;
      if (item.img !== undefined) entry.img = item.img;
      return { entry, disc, level };
    })
    .sort((a, b) => {
      const byDisc = disciplineLabel(a.disc).localeCompare(disciplineLabel(b.disc));
      if (byDisc !== 0) return byDisc;
      return a.level - b.level;
    })
    .map((x) => x.entry);
}

// ---------------------------------------------------------------------------
// Box tracks (health/willpower/hunger/stains) — vitals tab. `max` on a
// BoxTrackSpec is the fixed track size, NOT derived from a resource max (the
// superficial/aggravated *resources* have a dynamic bound — see
// buildResources below).

function boxTrackSpecs(actor: FoundryActorDoc): BoxTrackSpec[] {
  const sys = rec(actor.system);
  return [
    {
      id: 'health',
      label: 'Health',
      max: numAt(sys, 'health.max') ?? 0,
      primaryId: 'health.superficial',
      aggravatedId: 'health.aggravated',
    },
    {
      id: 'willpower',
      label: 'Willpower',
      max: numAt(sys, 'willpower.max') ?? 0,
      primaryId: 'willpower.superficial',
      aggravatedId: 'willpower.aggravated',
    },
    {
      id: 'hunger',
      label: 'Hunger',
      max: 5, // fixed per spec (Task 0), not read from system.hunger.max
      primaryId: 'hunger',
    },
    {
      id: 'stains',
      label: 'Stains',
      max: 10, // fixed per spec
      primaryId: 'humanity.stains',
    },
  ];
}

// ---------------------------------------------------------------------------
// Gear (weapons + gear items).

function gearListItems(actor: FoundryActorDoc): ListItem[] {
  return items(actor)
    .filter((i) => i.type === 'weapon' || i.type === 'gear')
    .map((item) => {
      const entry: ListItem = { id: item._id, label: item.name };
      if (item.type === 'weapon') {
        const dmg = numAt(item.system, 'weaponvalue') ?? 0;
        const kind = strAt(item.system, 'weaponType') ?? 'melee';
        entry.sub = `Damage ${dmg} · ${kind}`;
      } else {
        const qty = numAt(item.system, 'quantity') ?? 1;
        if (qty > 1) entry.resourceId = `item.${item._id}.qty`;
      }
      return entry;
    });
}

// ---------------------------------------------------------------------------
// Headline: clan name (if a `clan`-type item exists), Blood Potency, Hunger.

function headlineStats(actor: FoundryActorDoc): Stat[] {
  const sys = rec(actor.system);
  const stats: Stat[] = [];
  const clan = items(actor).find((i) => i.type === 'clan');
  if (clan) stats.push({ id: 'clan', label: 'Clan', value: clan.name });
  stats.push({ id: 'bloodpotency', label: 'Blood Potency', value: numAt(sys, 'blood.potency') ?? 0 });
  stats.push({ id: 'hunger', label: 'Hunger', value: numAt(sys, 'hunger.value') ?? 0 });
  return stats;
}

// ---------------------------------------------------------------------------
// Resources — the writable (and read-only-tracked) numeric bounds.
// Health/willpower superficial+aggravated share a dynamic bound: the OTHER
// box's current value eats into this box's max (superficial + aggravated <=
// track max — enforced here at read time, enforced again by Task 3's writes).

function trackBoxResources(
  sys: Rec,
  prefix: 'health' | 'willpower',
  label: string,
): ResourceDescriptor[] {
  const max = numAt(sys, `${prefix}.max`) ?? 0;
  const superficial = numAt(sys, `${prefix}.superficial`) ?? 0;
  const aggravated = numAt(sys, `${prefix}.aggravated`) ?? 0;
  return [
    {
      id: `${prefix}.superficial`,
      label: `${label} (Superficial)`,
      value: superficial,
      min: 0,
      max: Math.max(0, max - aggravated),
      writable: true,
      group: prefix,
    },
    {
      id: `${prefix}.aggravated`,
      label: `${label} (Aggravated)`,
      value: aggravated,
      min: 0,
      max: Math.max(0, max - superficial),
      writable: true,
      group: prefix,
    },
  ];
}

function buildResources(actor: FoundryActorDoc): ResourceDescriptor[] {
  const sys = rec(actor.system);
  const resources: ResourceDescriptor[] = [
    ...trackBoxResources(sys, 'health', 'Health'),
    ...trackBoxResources(sys, 'willpower', 'Willpower'),
    {
      id: 'hunger',
      label: 'Hunger',
      value: numAt(sys, 'hunger.value') ?? 0,
      min: 0,
      max: 5,
      writable: true,
      group: 'hunger',
    },
    {
      id: 'humanity.stains',
      label: 'Humanity Stains',
      value: numAt(sys, 'humanity.stains') ?? 0,
      min: 0,
      max: 10,
      writable: true,
      group: 'humanity',
    },
    {
      id: 'humanity',
      label: 'Humanity',
      value: numAt(sys, 'humanity.value') ?? 7,
      min: 0,
      max: 10,
      writable: false,
      group: 'humanity',
    },
    {
      id: 'bloodpotency',
      label: 'Blood Potency',
      value: numAt(sys, 'blood.potency') ?? 0,
      min: 0,
      writable: false,
      group: 'blood',
    },
  ];

  // Gear quantity links (only when the stack is > 1 — see gearListItems).
  for (const item of items(actor)) {
    if (item.type !== 'gear') continue;
    const qty = numAt(item.system, 'quantity') ?? 1;
    if (qty <= 1) continue;
    resources.push({
      id: `item.${item._id}.qty`,
      label: `${item.name} (Qty)`,
      value: qty,
      min: 0,
      max: 999, // sane upper bound (M23 review finding) — no in-system cap exists
      writable: true,
      group: 'gear',
    });
  }

  return resources;
}

// ---------------------------------------------------------------------------
// Actions (Task 4): one kind:'pool' descriptor per attribute/skill/power
// (Strategy 2 formula rolls — findings doc, roll strategy is FINAL) plus one
// kind:'rouse' descriptor. Enumerated from the SAME vocabularies the stats
// render from (vocabKeys), so every actionId Task 2/4 wires onto a stat or
// list row always resolves to an emitted descriptor, including homebrew
// extras.

function poolAttributeActions(actor: FoundryActorDoc): ActionDescriptor[] {
  const sys = rec(actor.system);
  const attributes = rec(sys.attributes);
  return vocabKeys(attributes, ATTRIBUTES).map((key) => ({
    id: `pool.attr.${key}`,
    label: capitalize(key),
    kind: 'pool',
    pool: { attribute: `attr.${key}` },
  }));
}

function poolSkillActions(actor: FoundryActorDoc): ActionDescriptor[] {
  const sys = rec(actor.system);
  const skills = rec(sys.skills);
  // Default pairing is attr.dexterity + this skill; the pool sheet always
  // lets the player re-pick either component (buildAction honors an
  // intent-supplied override over this default).
  return vocabKeys(skills, SKILLS).map((key) => ({
    id: `pool.skill.${key}`,
    label: skillLabel(key),
    kind: 'pool',
    pool: { attribute: 'attr.dexterity', skill: `skill.${key}` },
  }));
}

function poolPowerActions(actor: FoundryActorDoc): ActionDescriptor[] {
  // V5 power pools vary; the discipline rating is the stable second
  // component — the sheet lets the player adjust via intent override.
  return powerItems(actor).map((item) => {
    const disc = strAt(item.system, 'discipline') ?? '';
    return {
      id: `pool.power.${item._id}`,
      label: item.name,
      kind: 'pool',
      pool: { attribute: 'attr.resolve', skill: `disc.${disc}` },
    };
  });
}

function buildActions(actor: FoundryActorDoc): ActionDescriptor[] {
  return [
    ...poolAttributeActions(actor),
    ...poolSkillActions(actor),
    ...poolPowerActions(actor),
    { id: 'rouse', label: 'Rouse Check', kind: 'rouse' },
  ];
}

// A vampire's hunger gates a pool roll's hunger-die split; mortals/ghouls
// share the schema but never roll hunger dice (Task 0 findings §canonical
// path table). `system.gamesystem` is the documented flavor flag; the
// captured fixture doesn't carry it (only `type` does), so fall back to the
// actor's own `type` when `gamesystem` is absent.
function isVampireFlavored(actor: FoundryActorDoc): boolean {
  const sys = rec(actor.system);
  const gamesystem = strAt(sys, 'gamesystem');
  if (gamesystem !== undefined) return gamesystem === 'vampire';
  return actor.type === 'vampire';
}

// Validates an `attr.<key>` id: key must be in the canonical vocab OR
// already present on the actor (homebrew). Returns the bare key.
function validateAttributeId(actor: FoundryActorDoc, id: string): string {
  const m = /^attr\.(.+)$/.exec(id);
  if (!m) throw new IntentError(`invalid attribute id "${id}"`, 'INVALID');
  const key = m[1] as string;
  const attributes = rec(rec(actor.system).attributes);
  const known =
    (ATTRIBUTES as readonly string[]).includes(key) || Object.prototype.hasOwnProperty.call(attributes, key);
  if (!known) throw new IntentError(`unknown attribute "${id}"`, 'INVALID');
  return key;
}

// Validates a `skill.<key>` or `disc.<key>` id (the pool's second
// component). skill keys must be in the canonical vocab OR present on the
// actor; discipline keys must be present on the actor (system.disciplines
// or as a power item's discipline) — there is no fixed discipline vocab
// exported by this adapter (Task 0: "14 keys", not enumerated here).
function validateSecondId(actor: FoundryActorDoc, id: string): { kind: 'skill' | 'disc'; key: string } {
  const skillMatch = /^skill\.(.+)$/.exec(id);
  if (skillMatch) {
    const key = skillMatch[1] as string;
    const skills = rec(rec(actor.system).skills);
    const known = (SKILLS as readonly string[]).includes(key) || Object.prototype.hasOwnProperty.call(skills, key);
    if (!known) throw new IntentError(`unknown skill "${id}"`, 'INVALID');
    return { kind: 'skill', key };
  }
  const discMatch = /^disc\.(.+)$/.exec(id);
  if (discMatch) {
    const key = discMatch[1] as string;
    const disciplines = rec(rec(actor.system).disciplines);
    const known = Object.prototype.hasOwnProperty.call(disciplines, key) || disciplineKeys(actor).includes(key);
    if (!known) throw new IntentError(`unknown discipline "${id}"`, 'INVALID');
    return { kind: 'disc', key };
  }
  throw new IntentError(`invalid skill/discipline id "${id}"`, 'INVALID');
}

function buildAction(actor: FoundryActorDoc, intent: ActionIntent): RelayAction {
  if (intent.kind === 'rouse') {
    const descriptor = buildActions(actor).find((a) => a.id === intent.actionId);
    if (!descriptor || descriptor.kind !== 'rouse') {
      throw new IntentError(`unknown action "${intent.actionId}"`, 'UNKNOWN_RESOURCE');
    }
    // Hunger increment is MANUAL (Task 0 findings §Open items) — no
    // follow-up write; the player adjusts the hunger track themselves.
    return { endpoint: 'roll', formula: '1d10cs>=6', flavor: 'Rouse Check' };
  }

  if (intent.kind !== 'pool') {
    throw new IntentError(`action kind "${intent.kind}" is not supported by wod5e`, 'UNKNOWN_RESOURCE');
  }

  const descriptor = buildActions(actor).find((a) => a.id === intent.actionId);
  if (!descriptor || descriptor.kind !== 'pool') {
    throw new IntentError(`unknown action "${intent.actionId}"`, 'UNKNOWN_RESOURCE');
  }

  const modifier = intent.modifier ?? 0;
  if (!Number.isInteger(modifier) || Math.abs(modifier) > 20) {
    throw new IntentError('modifier must be an integer with |modifier| <= 20', 'INVALID');
  }

  // The intent's attribute/skill (when present) OVERRIDE the descriptor's
  // default pairing — that's the point of the pool sheet.
  const attributeId = intent.attribute ?? descriptor.pool?.attribute;
  if (attributeId === undefined) {
    throw new IntentError(`action "${intent.actionId}" has no attribute to roll`, 'INVALID');
  }
  const attrKey = validateAttributeId(actor, attributeId);

  const secondId = intent.skill ?? descriptor.pool?.skill;
  const second = secondId !== undefined ? validateSecondId(actor, secondId) : undefined;

  const sys = rec(actor.system);
  const attrValue = numAt(rec(sys.attributes), `${attrKey}.value`) ?? 1;
  const secondValue =
    second === undefined
      ? 0
      : second.kind === 'skill'
        ? (numAt(rec(sys.skills), `${second.key}.value`) ?? 0)
        : (numAt(rec(sys.disciplines), `${second.key}.value`) ?? 0);

  const dice = Math.max(1, attrValue + secondValue + modifier);
  const hunger = isVampireFlavored(actor) ? Math.min(numAt(sys, 'hunger.value') ?? 0, dice) : 0;
  const normal = dice - hunger;

  const formula =
    normal > 0 && hunger > 0
      ? `${normal}d10cs>=6 + ${hunger}d10cs>=6`
      : hunger > 0
        ? `${hunger}d10cs>=6`
        : `${normal}d10cs>=6`;

  const attrLabel = capitalize(attrKey);
  const secondLabel =
    second === undefined ? undefined : second.kind === 'skill' ? skillLabel(second.key) : disciplineLabel(second.key);
  const hungerPart = hunger > 0 ? `, ${hunger} hunger` : '';
  const flavor = `${attrLabel}${secondLabel !== undefined ? ` + ${secondLabel}` : ''} (${dice} dice${hungerPart})`;

  return { endpoint: 'roll', formula, flavor };
}

// ---------------------------------------------------------------------------
// buildUpdate — intent -> concrete Foundry update (Task 3). Write allow-list:
// health/willpower superficial+aggravated (tri-state clamp: the descriptor's
// dynamic max already encodes `superficial + aggravated <= track max`, so
// clamping to [min, max] from the descriptor is sufficient — no cross-field
// coupling needed here), hunger, humanity.stains, and gear item quantity.
// Everything else (humanity, bloodpotency) is read-only; anything not in
// `resources()` is unknown. Mirrors adapter-dnd5e's buildUpdate contract,
// including an adapter-level optimistic-lock check (the gateway also checks
// `expected` against its own fresh descriptor read before ever calling
// buildUpdate — this is defense in depth using the exact same comparison).

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
  if (intent.expected !== undefined && intent.expected !== descriptor.value) {
    throw new IntentError(`expected value is stale for "${intent.resourceId}"`, 'CONFLICT');
  }
  const raw = intent.kind === 'set' ? intent.value : descriptor.value + intent.amount;
  const target = clamp(raw, descriptor.min, descriptor.max);
  const id = intent.resourceId;

  if (id === 'health.superficial') return { data: { 'system.health.superficial': target } };
  if (id === 'health.aggravated') return { data: { 'system.health.aggravated': target } };
  if (id === 'willpower.superficial') return { data: { 'system.willpower.superficial': target } };
  if (id === 'willpower.aggravated') return { data: { 'system.willpower.aggravated': target } };
  if (id === 'hunger') return { data: { 'system.hunger.value': target } };
  if (id === 'humanity.stains') return { data: { 'system.humanity.stains': target } };

  const itemMatch = /^item\.(.+)\.qty$/.exec(id);
  if (itemMatch) {
    const itemId = itemMatch[1] as string;
    return { itemId, data: { 'system.quantity': target } };
  }

  // A descriptor id we created but forgot to map — a programming error.
  throw new IntentError(`resource "${id}" has no write mapping`, 'INVALID');
}

// ---------------------------------------------------------------------------
// buildCustomItem (Task 5, M23): player-authored weapon/gear -> the full
// world-item payload for the relay `create` call (see the Task 0 findings
// doc §Headline plan amendments 5 — create -> give -> delete chain). A
// strict whitelist: name (non-empty, trimmed, <=80 chars), type ('weapon' |
// 'gear' only), damage (weapons only, integer 0-10 -> system.weaponvalue,
// plus a default system.weaponType:'melee'), description (<=2000 chars ->
// system.description). Anything else on the input is silently dropped, not
// copied through — the gateway route passes the raw client body straight
// through without pre-sanitizing it, so this function is the ONLY line of
// defense against extra/hostile fields landing in a relay-created world item.

const CUSTOM_ITEM_TYPES = ['weapon', 'gear'] as const;
const CUSTOM_ITEM_NAME_MAX = 80;
const CUSTOM_ITEM_DESCRIPTION_MAX = 2000;

function buildCustomItem(_actor: FoundryActorDoc, input: CustomItemInput): Record<string, unknown> {
  const rawName = input?.name;
  if (typeof rawName !== 'string') {
    throw new IntentError('name is required', 'INVALID');
  }
  const name = rawName.trim();
  if (name === '' || name.length > CUSTOM_ITEM_NAME_MAX) {
    throw new IntentError(`name must be 1-${CUSTOM_ITEM_NAME_MAX} characters`, 'INVALID');
  }

  const type = input.type;
  if (!(CUSTOM_ITEM_TYPES as readonly string[]).includes(type)) {
    throw new IntentError(`unsupported custom item type "${String(type)}"`, 'INVALID');
  }

  const system: Record<string, unknown> = {};

  if (input.damage !== undefined) {
    if (type !== 'weapon') {
      throw new IntentError('damage is only valid for weapons', 'INVALID');
    }
    const damage = input.damage;
    if (typeof damage !== 'number' || !Number.isInteger(damage) || damage < 0 || damage > 10) {
      throw new IntentError('damage must be an integer 0-10', 'INVALID');
    }
    system.weaponvalue = damage;
  }
  if (type === 'weapon') {
    system.weaponType = 'melee'; // default; no equip/kind picker in v1 (Task 0 findings)
  }

  if (input.description !== undefined) {
    const description = input.description;
    if (typeof description !== 'string' || description.length > CUSTOM_ITEM_DESCRIPTION_MAX) {
      throw new IntentError(`description must be a string up to ${CUSTOM_ITEM_DESCRIPTION_MAX} characters`, 'INVALID');
    }
    system.description = description;
  }

  return { name, type, system };
}

// ---------------------------------------------------------------------------
// Sections + tabs

function buildSections(actor: FoundryActorDoc): SheetSection[] {
  const attrs = attributeStats(actor);
  attrs.push(humanityStat(actor));
  return [
    { kind: 'stats', id: 'attributes', label: 'Attributes', stats: attrs },
    { kind: 'stats', id: 'skills', label: 'Skills', stats: skillStats(actor) },
    {
      kind: 'stats',
      id: 'discipline-ratings',
      label: 'Discipline Ratings',
      stats: disciplineRatingStats(actor),
    },
    { kind: 'list', id: 'disciplines', label: 'Disciplines', items: disciplinePowerItems(actor) },
    {
      kind: 'tracks',
      id: 'tracks',
      label: 'Tracks',
      resourceIds: ['health.superficial', 'health.aggravated', 'willpower.superficial', 'willpower.aggravated', 'hunger', 'humanity.stains'],
      boxTracks: boxTrackSpecs(actor),
    },
    { kind: 'list', id: 'gear', label: 'Gear', items: gearListItems(actor) },
  ];
}

export const wod5eAdapter: SystemAdapter = {
  systemId: 'wod5e',

  toViewModel(actor: FoundryActorDoc): SheetViewModel {
    const resources = buildResources(actor);
    return {
      actorId: actor._id,
      systemId: 'wod5e',
      name: actor.name,
      ...(actor.img !== undefined ? { img: actor.img } : {}),
      glyph: '☥',
      headline: headlineStats(actor),
      sections: buildSections(actor),
      resources,
      actions: buildActions(actor),
      tabs: [
        { id: 'overview', label: 'Overview', sectionIds: ['attributes', 'skills'], hostsActions: false },
        { id: 'rolls', label: 'Rolls', sectionIds: [], hostsActions: true },
        {
          id: 'disciplines',
          label: 'Disciplines',
          sectionIds: ['discipline-ratings', 'disciplines'],
          hostsActions: false,
        },
        { id: 'vitals', label: 'Vitals', sectionIds: ['tracks'], hostsActions: false },
        { id: 'gear', label: 'Gear', sectionIds: ['gear'], hostsActions: false },
      ],
      customItems: [
        { type: 'weapon', label: 'Weapon', hasDamage: true },
        { type: 'gear', label: 'Gear', hasDamage: false },
      ],
    };
  },

  resources(actor: FoundryActorDoc): ResourceDescriptor[] {
    return buildResources(actor);
  },

  buildUpdate(actor: FoundryActorDoc, intent: ResourceIntent): FoundryUpdate {
    return buildUpdate(actor, intent);
  },

  actions(actor: FoundryActorDoc): ActionDescriptor[] {
    return buildActions(actor);
  },

  buildAction(actor: FoundryActorDoc, intent: ActionIntent): RelayAction {
    return buildAction(actor, intent);
  },

  buildCustomItem(actor: FoundryActorDoc, input: CustomItemInput): Record<string, unknown> {
    return buildCustomItem(actor, input);
  },
};

export default wod5eAdapter;
