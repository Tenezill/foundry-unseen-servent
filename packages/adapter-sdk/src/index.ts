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
}

export type SheetSection =
  | { kind: 'stats'; id: string; label: string; stats: Stat[] }
  | { kind: 'list'; id: string; label: string; items: ListItem[] }
  /** Renders the referenced resources as interactive trackers. */
  | { kind: 'tracks'; id: string; label: string; resourceIds: string[] };

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
}

/**
 * IO handed to `SystemAdapter.enrich`: lets the adapter pull extra derived
 * data for THIS actor from the relay's system-specific endpoints without
 * knowing transport details (URLs/keys stay in foundry-client/gateway).
 */
export interface AdapterIO {
  /** relay GET /<systemId>/get-actor-details?details=[…] for this actor. */
  getSystemDetails(details: string[]): Promise<unknown>;
}

export interface SystemAdapter {
  /** Foundry system id this adapter handles, e.g. "dnd5e". */
  systemId: string;
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
