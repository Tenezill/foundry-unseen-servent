/**
 * The system-adapter contract (PLAN.md §6).
 *
 * All system-specific knowledge (dnd5e data paths, slot structure, currency
 * denominations…) lives behind this interface. The gateway runs adapters
 * server-side; the PWA only ever sees `SheetViewModel` and sends
 * `ResourceIntent`s. The PWA renders any system generically from the
 * view-model shape — adapters control layout hints, not the PWA.
 */

/** A raw Foundry actor document as returned by the relay. Adapters narrow it. */
export interface FoundryActorDoc {
  _id: string;
  uuid?: string;
  name: string;
  type: string;
  img?: string;
  system: Record<string, unknown>;
  items?: FoundryItemDoc[];
  [key: string]: unknown;
}

/** A raw embedded item document (weapons, spells, features, consumables…). */
export interface FoundryItemDoc {
  _id: string;
  name: string;
  type: string;
  img?: string;
  sort?: number;
  system: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * A writable (or read-only-tracked) numeric resource on the sheet.
 * `id` is stable and system-scoped, e.g. "hp", "hp.temp", "slots.3",
 * "item.<itemId>.qty", "item.<itemId>.uses", "hitdice.d8", "currency.gp",
 * "deathsaves.success".
 */
export interface ResourceDescriptor {
  id: string;
  label: string;
  value: number;
  max?: number;
  min?: number;
  /** UI increment; defaults to 1. */
  step?: number;
  /** Only writable resources may be targeted by intents (gateway-enforced). */
  writable: boolean;
  /** Optional grouping hint for the UI, e.g. "hp", "slots", "currency". */
  group?: string;
  /** spell-slot pools only: the spell level this pool casts at (pips UI). */
  level?: number;
}

/** App-level write intents. `expected` is the optimistic-lock token: the
 * last value the client saw. On mismatch with fresh state the gateway
 * rejects with 409 + the fresh sheet. */
export type ResourceIntent =
  | { kind: 'set'; resourceId: string; value: number; expected?: number }
  | { kind: 'delta'; resourceId: string; amount: number; expected?: number };

/** Concrete Foundry update payload: dotted paths → values. */
export interface FoundryUpdate {
  /**
   * When set, the update targets the embedded item document
   * (`Actor.<actorId>.Item.<itemId>`) instead of the actor itself —
   * used for item quantity/charges.
   */
  itemId?: string;
  /** e.g. { "system.attributes.hp.value": 17 } */
  data: Record<string, number | string | boolean>;
}

/** One display stat: label + primary value + optional secondary line. */
export interface Stat {
  id: string;
  label: string;
  value: string | number;
  /** e.g. the modifier "+4" under an ability score, or "proficient". */
  sub?: string;
  /** When set, tapping this stat triggers the referenced sheet action. */
  actionId?: string;
  /** Renders `value` as a dot row (0..max) instead of text (M23, wod5e
   *  attributes/skills). Absent = plain text/number rendering. */
  display?: 'dots';
  /** dots only: total dots to draw; max ≤ 10. */
  max?: number;
  /** Passive d20 roll indicators (display-only; never auto-applied to the
   *  roll). Set only when a source grants it; both may be true at once. */
  advantage?: boolean;
  disadvantage?: boolean;
}

/** One row in a list section (inventory, features, spells). */
export interface ListItem {
  id: string;
  label: string;
  /** secondary line, e.g. "1d8 slashing · versatile" or "3rd level · V,S". */
  sub?: string;
  img?: string;
  /** Link to a writable resource rendered inline (quantity, charges). */
  resourceId?: string;
  /** Free-form badges, e.g. ["equipped"], ["prepared"], ["concentration"]. */
  tags?: string[];
  /** Primary action for the row (attack, cast, use). */
  actionId?: string;
  /** Secondary toggle action (equip/unequip, prepare/unprepare), when
   *  applicable. The pill label follows the action's kind. */
  toggleActionId?: string;
  /** Attune toggle action (M12), rendered as a second pill next to the
   *  equip pill — attune never competes for toggleActionId. */
  attuneActionId?: string;
  /** Id of the container row this item sits inside (M12); the PWA groups
   *  inventory rows under their container. Only set when it matches another
   *  row in the same list — dangling refs render flat. */
  containerId?: string;
  /** The library collection id this item can be removed from, e.g. 'spells' |
   *  'feats' | 'gear' (renders a destructive detail action and lets the PWA
   *  hit DELETE /library/:collection/:itemId). Absent = not removable. */
  removable?: string;
  /**
   * Rich description for a detail view (M8). This is content from the user's
   * OWN world (the item's own description) — the app only ever renders what
   * the world legally contains; the repo ships no game-rules text. May be
   * HTML; the client sanitizes before rendering.
   */
  detail?: string;
}

/** An active condition/effect on the actor (M8), shown as a badge. */
export interface Condition {
  id: string;
  label: string;
  /** icon path served by Foundry (optional; client falls back to a glyph). */
  icon?: string;
  /** When set, this condition was applied by the app and can be removed from
   *  the badge — the id of an 'endeffect' action (2026-07-19 buff effects). */
  removeActionId?: string;
}

/** One roll in the world, for the GM roll feed (M9). System-agnostic. */
export interface RollEntry {
  id: string;
  /** Who rolled — speaker alias (character name) or the user's name. */
  by: string;
  /** e.g. "Athletics Check", "Longbow - Attack Roll" (may be empty). */
  flavor: string;
  total: number;
  formula: string;
  isCritical: boolean;
  isFumble: boolean;
  /** epoch ms; stamped by Foundry. */
  timestamp: number;
}

/** A box-rendered track (M23): tri-state (empty/superficial/aggravated)
 *  when `aggravatedId` is set, two-state otherwise (hunger, stains). */
export interface BoxTrackSpec {
  id: string;
  label: string;
  /** total boxes; NOT derived from a resource max (superficial's dynamic
   *  bound is max - aggravated). */
  max: number;
  /** resource counted as superficial ('/') or plain fill. */
  primaryId: string;
  /** resource counted as aggravated ('X'); shares `max` with primary. */
  aggravatedId?: string;
}

export type SheetSection =
  | { kind: 'stats'; id: string; label: string; stats: Stat[] }
  | { kind: 'list'; id: string; label: string; items: ListItem[]; header?: ListItem }
  /** Renders the referenced resources as interactive trackers. */
  | {
      kind: 'tracks';
      id: string;
      label: string;
      resourceIds: string[];
      /** Box-track specs rendered alongside the plain resource trackers
       *  (M23, wod5e health/willpower/hunger). */
      boxTracks?: BoxTrackSpec[];
    };

/** Adapter-declared tab layout (M23). Absent -> the PWA's legacy heuristic. */
export interface SheetTab {
  id: string;
  label: string;
  /** SheetSection ids rendered in this tab, in order. */
  sectionIds: string[];
  /** Exactly one tab may host the actions UI (rolls/attacks). */
  hostsActions?: boolean;
}

/** System-agnostic sheet: the PWA renders this without dnd5e knowledge. */
export interface SheetViewModel {
  actorId: string;
  systemId: string;
  name: string;
  img?: string;
  /** Compact always-visible chips: AC, level/class line, speed, prof… */
  headline: Stat[];
  sections: SheetSection[];
  /** Every tracked resource, including all writable ones. */
  resources: ResourceDescriptor[];
  /** Every action the player may trigger (M6); referenced by actionId. */
  actions?: ActionDescriptor[];
  /** Active conditions/effects on the actor (M8). */
  conditions?: Condition[];
  /** The spell being concentrated on, if any (M8, dnd5e: from effects). */
  concentration?: { label: string } | null;
  /** Library collections the actor's adapter supports (M13): search ->
   *  preview -> add / remove. Each entry is a button hint for the PWA: the
   *  `id` routes to /library/:id/*, the `label` names the add button. */
  library?: Array<{ id: string; label: string }>;
  /** Adapter-declared tab layout (M23). Absent -> the PWA's legacy heuristic. */
  tabs?: SheetTab[];
  /** Single-character/emoji glyph for the actor when `img` is unset or
   *  generic (M23, wod5e clan sigils). */
  glyph?: string;
  /** Custom item types the player may create from a form (M23); each entry
   *  names the type id, the create-button label, and whether the form
   *  should show a damage field. */
  customItems?: Array<{ type: string; label: string; hasDamage: boolean }>;
}

// ---------------------------------------------------------------------------
// Actions (PLAN.md M6): tap a skill to roll it, attack, cast, use, equip.
// Adapters describe what is possible; the gateway allow-lists against that
// list; Foundry executes and owns all rules (slot/uses consumption, cards).

export type SheetActionKind =
  | 'check'
  | 'save'
  | 'attack'
  /** roll a weapon's damage (companion to 'attack'; no native relay action
   *  exists for this, so the adapter computes the formula itself — see
   *  weaponDamageFormula in the dnd5e adapter). */
  | 'damage'
  | 'cast'
  | 'use'
  | 'equip'
  /** toggle a spell's prepared state (item-field write, no chat card). */
  | 'prepare'
  /** toggle an item's attuned state (M12; mirrors equip/prepare). */
  | 'attune'
  /** push a physical item between carried and a container (M19). */
  | 'move'
  // M8 actor-scoped commands (no item target):
  | 'rest'
  | 'deathsave'
  | 'endconcentration'
  /** remove an app-applied active effect (buff), by its actionId (2026-07-19). */
  | 'endeffect'
  /** roll an attribute+skill dice pool (M23, wod5e: the vampire replacement
   *  for 'check'/'save' — no target number, successes counted client-side). */
  | 'pool'
  /** wod5e Rouse check: spend a hunger-gated resource, no player-chosen
   *  pairing (M23). */
  | 'rouse';

export interface ActionDescriptor {
  /** stable id, e.g. "skill.ath", "ability.str.save", "item.<id>.attack",
   *  "spell.<id>.cast", "feature.<id>.use", "item.<id>.equip",
   *  "rest.short", "rest.long", "deathsave.roll", "concentration.end" */
  id: string;
  label: string;
  kind: SheetActionKind;
  /** UI grouping hint for actions sharing a kind, e.g. "items" separates
   *  item-use from feature-use on the Actions tab. */
  group?: string;
  /** cast only: slot levels currently legal (empty/absent = at-will/cantrip). */
  slotLevels?: number[];
  /** cast only: the spell's own level (0 = cantrip) — the PWA groups the
   *  Actions-tab spell list under per-level headers with it (2026-07-18). */
  level?: number;
  /** cast only: this buff can target another creature — the PWA opens a
   *  target picker before casting (2026-07-19 target buffs). Absent =
   *  self-only or non-buff, cast applies to the caster. */
  targetable?: boolean;
  /** equip only: current state (the intent carries the desired state). */
  equipped?: boolean;
  /** prepare only: current state (the intent carries the desired state). */
  prepared?: boolean;
  /** attune only: current state (the intent carries the desired state). */
  attuned?: boolean;
  /** cast/use only: what this spell/feature mechanically does, for grouping
   *  and roll-result wording on the Actions tab (M15). System-agnostic:
   *  'damage' (deals damage, whether via an attack roll or a save), 'heal'
   *  (restores HP), 'utility' (neither — buffs, debuffs, information). */
  effectType?: 'damage' | 'heal' | 'utility';
  /** pool only: default attribute/skill pairing the PWA preselects (M23);
   *  the player may repick either before rolling. Ids match Stat.id. */
  pool?: { attribute?: string; skill?: string };
  /** In-combat targeting capability (2026-07-22): absent = untargetable (the
   *  action keeps today's untargeted flow). mode 'multiple' only for
   *  save-vs-DC actions (Fireball can hit several combatants, friends
   *  included); attacks and heals are single-target in v1. */
  targeting?: { mode: 'single' | 'multiple'; kind: 'attack' | 'save' | 'heal' };
}

export type ActionIntent =
  | { kind: 'check' | 'save'; actionId: string; mode?: 'advantage' | 'disadvantage' }
  | { kind: 'attack'; actionId: string; mode?: 'advantage' | 'disadvantage'; targetTokenUuids?: string[] }
  | { kind: 'use'; actionId: string; targetTokenUuids?: string[] }
  /** `critical` (5e nat 20): the damage roll doubles its dice, keeping
   *  static bonuses — armed by the PWA when the preceding attack/cast
   *  roll came back `isCritical`. `slotLevel` is the level the spell was
   *  last cast at (upcasting) so the display roll scales its dice. */
  | { kind: 'damage'; actionId: string; critical?: boolean; slotLevel?: number }
  | { kind: 'cast'; actionId: string; slotLevel?: number; targetActorId?: string; targetTokenUuids?: string[] }
  | { kind: 'equip'; actionId: string; equipped: boolean }
  | { kind: 'prepare'; actionId: string; prepared: boolean }
  | { kind: 'attune'; actionId: string; attuned: boolean }
  | { kind: 'move'; actionId: string; containerId: string | null }
  | { kind: 'rest' | 'deathsave' | 'endconcentration' | 'endeffect'; actionId: string }
  /** M23: the player's chosen attribute/skill pairing overrides the
   *  descriptor's default `pool`; `modifier` folds in ad-hoc situational
   *  dice (specialties, bonuses). */
  | { kind: 'pool'; actionId: string; attribute?: string; skill?: string; modifier?: number }
  | { kind: 'rouse'; actionId: string };

/**
 * What the gateway should ask the relay to do. `roll` posts a chat card
 * speaking as the actor; the `use-*` endpoints run the system's real usage
 * workflow; `equip-item` toggles equipment; the actor-command endpoints
 * (M8, no item target) run rests, a death save, or drop concentration.
 */
/** A Foundry Active Effect the app applies to an actor (2026-07-19 buff
 *  spells). Copied verbatim from the casting spell item's own effect — the
 *  app never invents `changes`. `mode` is Foundry's CONST.ACTIVE_EFFECT_MODES
 *  number; `origin` is the source item uuid. */
export interface EffectPayload {
  name: string;
  img?: string;
  changes: Array<{ key: string; mode: number; value: string }>;
  duration?: Record<string, unknown>;
  origin?: string;
}

export type RelayAction =
  | { endpoint: 'roll'; formula: string; flavor: string }
  /** noTemplate: the item's activities carry an area template — dnd5e's
   *  headless activation would block awaiting canvas placement (relay 408
   *  after 5-8s). The gateway routes flagged activations through the
   *  execute-js path (which suppresses placement) and falls back to the
   *  module endpoint when execute-js is unavailable. */
  | { endpoint: 'use-item' | 'use-spell' | 'use-feature'; itemId: string; slotLevel?: number; noTemplate?: true }
  /** Upcast (dnd5e): cast the spell consuming a SPECIFIC higher-level slot.
   *  Executed via the relay's execute-js with a fixed script template —
   *  see foundry-client castAtSlot. slotKey matches ^spell[2-9]$. */
  | { endpoint: 'cast-at-slot'; itemId: string; slotKey: string }
  | { endpoint: 'equip-item'; itemId: string; equipped: boolean }
  /** M12: the relay module's dedicated attune endpoint (validates params and
   *  carries a Foundry-v12 legacy fallback; it does NOT enforce the actor's
   *  attunement cap). Gateway RelayPort + foundry-client must implement it. */
  | { endpoint: 'attune-item'; itemId: string; attuned: boolean }
  /** Generic embedded-item field write (e.g. prepared state); executed via
   *  the same entity-update path as quantity/uses. */
  | { endpoint: 'update-item'; itemId: string; data: Record<string, number | string | boolean> }
  /** M15/M16: activate the item through Foundry's own usage flow, then roll
   *  a client-computed formula for display. The relay only auto-executes
   *  attack-type activities — a heal/save/utility use posts an inert card —
   *  so the adapter computes the roll itself; but consumption (spell slots,
   *  limited uses, quantity, auto-destroy, refusing when empty) must stay
   *  Foundry's job, which is why the `use` call comes first. An earlier
   *  design (`roll-and-heal` + a hand-computed `consumeUse` write) skipped
   *  the activation entirely and re-implemented consumption in the gateway;
   *  branch review 2026-07-09 confirmed that leaked free castings (slots
   *  never consumed), infinite item reuse, and stack-wiping deletes — this
   *  variant replaces it. `heal`, when present (self-targeted heals only),
   *  makes the gateway also write `min(max, current + total)` to `path`;
   *  all three fields are adapter-resolved so this stays system-agnostic. */
  | {
      endpoint: 'use-and-roll';
      use: 'use-item' | 'use-spell' | 'use-feature' | 'cast-at-slot';
      itemId: string;
      /** required when use === 'cast-at-slot' (upcast heals). */
      slotKey?: string;
      noTemplate?: true;
      formula: string;
      flavor: string;
      heal?: { path: string; current: number; max: number };
    }
  /** Buff spell (dnd5e): activate the spell (consume the slot via use-spell,
   *  or cast-at-slot for an upcast) THEN create the spell's own Active Effect
   *  on the caster via the relay's PUT /update embedded-upsert — because the
   *  headless use-flow never applies self-effects (see M-buff-effects-findings).
   *  The gateway mints the effect `_id` and sets the unseen-servent flag. */
  | {
      endpoint: 'cast-and-apply-effect';
      use: 'use-spell' | 'cast-at-slot';
      itemId: string;
      slotKey?: string;
      effect: EffectPayload;
      targetActorId?: string;
      noTemplate?: true;
    }
  /** Delete an app-applied active effect off the actor (buff removal); the
   *  gateway resolves `Actor.<id>.ActiveEffect.<effectId>` via deleteEntity. */
  | { endpoint: 'remove-effect'; effectId: string }
  | { endpoint: 'short-rest' | 'long-rest' | 'death-save' | 'break-concentration' }
  /** Targeted use (2026-07-22): one execute-js orchestration — target →
   *  activity.use → attack/save resolution → damage roll → dnd5e applyDamage
   *  per target. Foundry owns ALL rules; the gateway validates targets
   *  against the visible encounter roster and never retries (side effects). */
  | {
      endpoint: 'use-on-targets';
      itemId: string;
      targetTokenUuids: string[];
      slotKey?: string;
      mode?: 'advantage' | 'disadvantage';
    };

/**
 * IO handed to `SystemAdapter.enrich`: lets the adapter pull extra derived
 * data for THIS actor from the relay's system-specific endpoints without
 * knowing transport details (URLs/keys stay in foundry-client/gateway).
 */
export interface AdapterIO {
  /** relay GET /<systemId>/get-actor-details?details=[…] for this actor. */
  getSystemDetails(details: string[]): Promise<unknown>;
  /** The enriched actor's OWN live derived AC (execute-js read of the
   *  prepared document). Used by enrich to display correct AC when an
   *  Active Effect (e.g. Mage Armor's ac.calc override) makes the relay's
   *  get-actor-details stats.ac stale. Attack resolution never uses this —
   *  the orchestration script reads target AC inside Foundry. Bounded +
   *  null-degrading (a stale AC beats no sheet). */
  getDerivedAc?(): Promise<number | null>;
}

/**
 * A library collection (M13): one searchable, addable/removable class of
 * documents (spells, feats, gear…) the adapter declares. Generalizes the
 * spells-only spellbook so feats and gear reuse the exact search -> preview
 * -> add / remove flow. Adding relays a `give` (copies the doc onto the
 * actor); removing relays a `delete` on the embedded item. All system
 * knowledge (filter strings, document types, preview labels) stays in the
 * adapter — no rules engine.
 */
export interface LibraryCollection {
  /** stable collection id, e.g. 'spells' | 'feats' | 'gear'. */
  id: string;
  /** the add-button label, e.g. "Learn spell" / "Add feat" / "Add item". */
  label: string;
  /** relay /search filter, e.g. "documentType:Item,subType:spell". */
  searchFilter: string;
  /** fetched compendium doc belongs in this collection (add is allowed). */
  canAdd(doc: Record<string, unknown>): boolean;
  /** embedded item belongs in this collection (remove is allowed). */
  canRemove(item: FoundryItemDoc): boolean;
  /** preview for the add-confirm sheet: label, "3rd level · Evocation", detail HTML. */
  describe(doc: Record<string, unknown>): ListItem;
}

/** Custom item creation (M23): input the PWA form sends. */
export interface CustomItemInput {
  name: string;
  /** adapter-declared type id, e.g. 'weapon' | 'gear'. */
  type: string;
  /** weapons only. */
  damage?: number;
  description?: string;
}

export interface SystemAdapter {
  /** Foundry system id this adapter handles, e.g. "dnd5e". */
  systemId: string;
  /** Optional: library collections (M13) for search/add/remove (the gateway
   *  404s for a collection id the adapter does not declare). */
  library?: LibraryCollection[];
  /**
   * Optional: merge derived data the relay's plain /get does not serialize
   * (e.g. dnd5e spell-slot maxima) into the document before rendering.
   * Must tolerate IO failure by returning the actor unchanged — a sheet
   * with fallback bounds beats no sheet.
   */
  enrich?(actor: FoundryActorDoc, io: AdapterIO): Promise<FoundryActorDoc>;
  /** Raw Foundry actor document -> normalized view model. */
  toViewModel(actor: FoundryActorDoc): SheetViewModel;
  /** The writable resources this system exposes, with bounds. */
  resources(actor: FoundryActorDoc): ResourceDescriptor[];
  /**
   * App-level intent -> concrete Foundry update payload (dotted paths).
   * Must throw `IntentError` for unknown/read-only resources; must clamp
   * to [min, max] from the descriptor.
   */
  buildUpdate(actor: FoundryActorDoc, intent: ResourceIntent): FoundryUpdate;
  /** Optional (M6): every action the player may trigger on this actor. */
  actions?(actor: FoundryActorDoc): ActionDescriptor[];
  /**
   * Optional (M6): action intent -> relay call. Must throw `IntentError`
   * ('UNKNOWN_RESOURCE' for unknown action ids, 'INVALID' for bad params
   * such as an illegal slot level).
   */
  buildAction?(actor: FoundryActorDoc, intent: ActionIntent): RelayAction;
  /**
   * Optional (M23): player-authored custom item (SheetViewModel.customItems)
   * -> the full embedded-item payload for the relay `create` call. Must
   * throw `IntentError('INVALID')` for a bad type id or missing/invalid
   * fields (e.g. `damage` on a non-weapon type).
   */
  buildCustomItem?(actor: FoundryActorDoc, input: CustomItemInput): Record<string, unknown>;
}

/** Error contract so the gateway can map failures to HTTP codes. */
export class IntentError extends Error {
  constructor(
    message: string,
    public readonly code: 'UNKNOWN_RESOURCE' | 'READ_ONLY' | 'CONFLICT' | 'INVALID',
  ) {
    super(message);
    this.name = 'IntentError';
  }
}

/** Clamp helper shared by adapters. */
export function clamp(value: number, min?: number, max?: number): number {
  let v = value;
  if (min !== undefined) v = Math.max(min, v);
  if (max !== undefined) v = Math.min(max, v);
  return v;
}
