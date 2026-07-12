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
 * This task (Task 2) implements `toViewModel` + `resources` only.
 * `buildUpdate` is a throwing stub — Task 3 implements the write allow-list
 * (health/willpower/hunger/humanity.stains, tri-state clamp invariant).
 * `actions`/`buildAction` (pool rolls, rouse checks, power use) are Task 4;
 * per coordinator resolution, stats/list rows in this task carry NO
 * `actionId` even though the brief mentions one — Task 4 wires it in without
 * needing to touch this file's stat/row shape.
 */
import type {
  BoxTrackSpec,
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

// Renders a dots-stat list FROM a canonical vocabulary, merging any source
// values over it (missing key -> defaultValue). Extra keys present in the
// source record but not in the vocab (homebrew) still render, appended
// after the vocab entries — real data is never dropped.
function vocabDotsStats(
  source: Rec,
  vocab: readonly string[],
  idPrefix: string,
  labelFor: (key: string) => string,
  defaultValue: number,
): Stat[] {
  const stat = (key: string): Stat => ({
    id: `${idPrefix}.${key}`,
    label: labelFor(key),
    value: numAt(source, `${key}.value`) ?? defaultValue,
    display: 'dots' as const,
    max: DOTS_MAX,
  });
  const vocabSet = new Set<string>(vocab);
  const extras = Object.keys(source).filter((key) => !vocabSet.has(key));
  return [...vocab.map(stat), ...extras.map(stat)];
}

function attributeStats(actor: FoundryActorDoc): Stat[] {
  const sys = rec(actor.system);
  const attributes = rec(sys.attributes);
  return vocabDotsStats(attributes, ATTRIBUTES, 'attr', capitalize, 1); // default/min 1 (Task 0)
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
  return vocabDotsStats(skills, SKILLS, 'skill', skillLabel, 0);
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
};

export default wod5eAdapter;
