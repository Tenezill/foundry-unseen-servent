/**
 * EncounterManager (M22): a gateway-side live mirror of Foundry's active
 * combat. It seeds from the relay's scope-gated `GET /encounters` read, then
 * keeps itself current from the relay's world hooks SSE stream (Task 0
 * verified `updateCombat` frames carry the full combatant array — no polling
 * needed once the stream is up).
 *
 * Exact NPC HP never leaves this module in a client-facing payload: `view()`
 * derives a `health` state for non-PC combatants and only ever attaches raw
 * `hp` to PC combatants (Global Constraints, docs/superpowers/plans/
 * 2026-07-11-encounters.md).
 *
 * The hooks-stream subscribe/backoff loop below deliberately duplicates
 * LiveManager's shape (./live.ts) rather than sharing it — LiveManager's
 * stream is private to actor-sheet watching, and coupling the two managers
 * isn't worth the surgery for one small loop (task-3 brief, explicit call).
 */
import type { RelayCombatant, RelayEncounter } from '@companion/foundry-client';

// ---------------------------------------------------------------------------
// Public view types (Task 3 contract; the gateway routes + Task 4 web consume
// these verbatim).

export interface EncounterCombatantView {
  id: string;
  actorId?: string;
  name: string;
  img?: string;
  initiative: number | null;
  isPC: boolean;
  defeated: boolean;
  /** NPCs only — derived server-side, never both this and `hp`. */
  health?: 'healthy' | 'wounded' | 'bloodied' | 'down';
  /** PCs only — exact HP never serialized for a non-PC combatant. */
  hp?: { value: number; max: number };
}

export interface EncounterView {
  active: boolean;
  round?: number;
  turn?: { combatantId: string | null };
  /** Initiative-desc order; hidden combatants dropped. */
  combatants?: EncounterCombatantView[];
}

/** A combatant in the manager's internal, normalized state — REST
 *  (`RelayCombatant`) and hook-frame (raw Foundry Combatant doc) shapes both
 *  collapse into this before anything else touches them. */
export interface CombatantRecord {
  id: string;
  actorId?: string;
  name?: string;
  img?: string;
  initiative: number | null;
  hidden: boolean;
  defeated: boolean;
}

interface CombatRecord {
  id: string;
  round: number;
  turn: number | null;
  combatants: CombatantRecord[];
}

/**
 * Cached actor slice the manager needs to derive isPC/health/hp. Kept wider
 * than the brief's `{type, hp}` pair by also carrying `name`: hook-pushed
 * combatants (Task 0 §2b capture) carry NO `name` field at all — Foundry
 * only serializes it when explicitly overridden on the combatant — but
 * `EncounterCombatantView.name` is mandatory. The actor doc we fetch for
 * hp/type already carries its own `name` for free, so the view falls back to
 * it instead of leaving `name` unresolved after a hook-driven replace.
 */
interface ActorCacheEntry {
  name: string;
  type: string;
  hp: { value: number; max: number };
}

export interface EncounterDeps {
  relay: {
    getEncounters(): Promise<RelayEncounter[]>;
    getEntity(uuid: string): Promise<Record<string, unknown> | null>;
    subscribeHooks(
      hooks: string[],
      onEvent: (ev: { event: string; data: unknown }) => void,
      signal: AbortSignal,
    ): Promise<void>;
  };
  /** Bound every relay await (M18 pattern). Default 3000. */
  fetchTimeoutMs?: number;
  /** Hooks-stream reconnect backoff floor. Default 1000. */
  reconnectMinMs?: number;
  /** Hooks-stream reconnect backoff ceiling. Default 30000. */
  reconnectMaxMs?: number;
  log?: { warn(obj: object, msg: string): void; debug?(obj: object, msg: string): void };
}

/** World hooks the manager subscribes to (Global Constraints, M22 plan). */
const COMBAT_HOOKS = [
  'updateCombat',
  'createCombat',
  'deleteCombat',
  'createCombatant',
  'updateCombatant',
  'deleteCombatant',
  'updateActor',
];

export class EncounterManager {
  private combat: CombatRecord | null = null;
  private readonly actorCache = new Map<string, ActorCacheEntry | null>();
  private readonly fetchingActorIds = new Set<string>();
  /** Serializes ensureActorCached's relay fetches — see its doc comment. */
  private seedQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(view: EncounterView) => void>();
  private loopAc: AbortController | null = null;
  private readonly fetchTimeoutMs: number;

  constructor(private readonly deps: EncounterDeps) {
    this.fetchTimeoutMs = deps.fetchTimeoutMs ?? 3_000;
  }

  /** Seed from the relay's REST read, then start the hooks subscribe loop
   *  (not awaited — it runs until `stop()`). */
  async start(): Promise<void> {
    await this.reseed();
    this.loopAc = new AbortController();
    void this.subscribeLoop(this.loopAc);
  }

  stop(): void {
    this.loopAc?.abort();
    this.loopAc = null;
  }

  isActive(): boolean {
    // Task 0: the doc's `active` flag is false even mid-combat for tokenless
    // combats — key on round instead (Global Constraints).
    return this.combat !== null && this.combat.round >= 1;
  }

  combatant(id: string): CombatantRecord | undefined {
    return this.combat?.combatants.find((c) => c.id === id);
  }

  view(): EncounterView {
    if (!this.isActive()) return { active: false };
    const combat = this.combat as CombatRecord;
    const sorted = [...combat.combatants].sort(byInitiativeDesc);
    const idx = combat.turn;
    const acting = idx !== null && idx >= 0 && idx < sorted.length ? sorted[idx] : undefined;
    // Turn pointer is computed against the sorted-UNfiltered list, then
    // nulled if the acting combatant turns out to be hidden — the player
    // must never be pointed at a combatant they can't see (Global Constraints).
    const turnCombatantId = acting !== undefined && !acting.hidden ? acting.id : null;
    const combatants = sorted.filter((c) => !c.hidden).map((c) => this.toCombatantView(c));
    return { active: true, round: combat.round, turn: { combatantId: turnCombatantId }, combatants };
  }

  /** LiveManager.attach idiom: every state change emits to all attached. */
  attach(send: (view: EncounterView) => void): () => void {
    this.listeners.add(send);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.listeners.delete(send);
    };
  }

  /** Re-fetch one actor (bounded) and refresh the cache + fan-out; awaited by
   *  the hp-write route so its response reflects the fresh value. */
  async refreshActor(actorId: string): Promise<void> {
    const entry = await this.fetchActorEntry(actorId);
    this.actorCache.set(actorId, entry);
    this.emit();
  }

  // ---- internals ------------------------------------------------------------

  private emit(): void {
    const view = this.view();
    for (const send of this.listeners) send(view);
  }

  private toCombatantView(c: CombatantRecord): EncounterCombatantView {
    const cached = c.actorId !== undefined ? (this.actorCache.get(c.actorId) ?? null) : null;
    const isPC = cached !== null && cached.type === 'character';
    const name = cached?.name ?? c.name ?? c.actorId ?? c.id;
    const out: EncounterCombatantView = {
      id: c.id,
      name,
      initiative: c.initiative,
      isPC,
      defeated: c.defeated,
      ...(c.actorId !== undefined ? { actorId: c.actorId } : {}),
      ...(c.img !== undefined ? { img: c.img } : {}),
    };
    // Degrade path (bounded fetch timed out/failed, or not fetched yet):
    // never PC, never exact hp — a generic "healthy" beats leaking nothing
    // or blocking the route (M18 precedent).
    if (isPC && cached !== null) {
      out.hp = { value: cached.hp.value, max: cached.hp.max };
    } else {
      out.health = cached !== null ? computeHealth(cached.hp) : 'healthy';
    }
    return out;
  }

  /** Bounded REST read. `null` = the fetch FAILED or timed out — callers must
   *  keep their current state (live-verified 2026-07-11: a relay-side stalled
   *  /encounters (408 after 10s) raced past our bound and, when this returned
   *  `[]` for it, clobbered a freshly-seeded live combat back to inactive).
   *  A genuine `[]` (relay answered: no combats) still clears state. */
  private async boundedGetEncounters(): Promise<RelayEncounter[] | null> {
    try {
      return await Promise.race([
        this.deps.relay.getEncounters(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), this.fetchTimeoutMs)),
      ]);
    } catch (err) {
      this.deps.log?.warn({ err: (err as Error).message }, 'encounter: getEncounters failed; keeping last state');
      return null;
    }
  }

  /** True while a reseed is in flight (concurrent requests coalesce). */
  private reseeding = false;
  private reseedPending = false;

  /** Full re-read via REST — used at start(), after any
   *  createCombatant/updateCombatant/deleteCombatant hook (those frames
   *  carry only the combatant, not the whole combat; a full re-read is
   *  simpler and rare — task-3 brief), and on every stream reconnect
   *  (frames missed while the stream was down are lost forever).
   *
   *  Concurrent calls coalesce into one in-flight read + at most one
   *  follow-up (live-verified 2026-07-11: a combat-creation burst fires
   *  4+ combatant hooks at once; the resulting concurrent /encounters
   *  calls stalled the relay into 408s, and out-of-order resolutions can
   *  write stale state last). A failed/timed-out read keeps current state. */
  private async reseed(): Promise<void> {
    if (this.reseeding) {
      this.reseedPending = true;
      return;
    }
    this.reseeding = true;
    try {
      do {
        this.reseedPending = false;
        const encounters = await this.boundedGetEncounters();
        if (encounters === null) continue; // failed/timed out: keep last state
        const chosen = pickCurrentEncounter(encounters);
        this.combat = chosen ? normalizeRestCombat(chosen) : null;
        if (this.combat) this.seedActorCache(this.combat.combatants);
        this.emit();
      } while (this.reseedPending);
    } finally {
      this.reseeding = false;
    }
  }

  private seedActorCache(combatants: CombatantRecord[]): void {
    for (const c of combatants) {
      if (c.actorId !== undefined) this.ensureActorCached(c.actorId);
    }
  }

  /** Kick off a bounded fetch for an actor not yet cached (and not already
   *  in flight); fire-and-forget — callers don't block on this.
   *
   *  Defense-in-depth (M22 cache-swap bug): fetches are chained onto
   *  `seedQueue` rather than launched concurrently. The relay has been
   *  live-verified to cross-wire responses under concurrent `GET /get`
   *  calls — foundry-client's `getEntity` now detects and rejects a
   *  mismatched response (returns null), so a corrupted cache entry can no
   *  longer happen even under concurrency, but a two-PC encounter seeding
   *  both actors at once is exactly the shape that triggers the relay bug
   *  most often. Serializing removes that trigger too: correctness over a
   *  hundred milliseconds of parallelism at table scale. */
  private ensureActorCached(actorId: string): void {
    if (this.actorCache.has(actorId) || this.fetchingActorIds.has(actorId)) return;
    this.fetchingActorIds.add(actorId);
    this.seedQueue = this.seedQueue.then(async () => {
      const entry = await this.fetchActorEntry(actorId);
      this.fetchingActorIds.delete(actorId);
      this.actorCache.set(actorId, entry);
      this.emit();
    });
  }

  private async fetchActorEntry(actorId: string): Promise<ActorCacheEntry | null> {
    try {
      const doc = await Promise.race([
        this.deps.relay.getEntity(`Actor.${actorId}`),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), this.fetchTimeoutMs)),
      ]);
      if (doc === null) {
        this.deps.log?.warn({ actorId }, 'encounter: actor fetch timed out or unavailable; degrading');
        return null;
      }
      // Defense-in-depth (M22 cache-swap bug, live-verified against the
      // relay): RelayPort is a thin interface — foundry-client's own
      // getEntity now rejects a cross-wired response, but don't assume
      // every RelayPort implementation does. Re-check identity against the
      // actorId we actually asked for before trusting the doc into the
      // cache; a mismatch degrades exactly like a timed-out fetch.
      const docId = typeof doc._id === 'string' ? doc._id : undefined;
      if (docId !== undefined && docId !== actorId) {
        this.deps.log?.warn(
          { actorId, docId },
          'encounter: actor fetch returned a mismatched entity (cross-wired response); degrading',
        );
        return null;
      }
      return toActorCacheEntry(actorId, doc);
    } catch (err) {
      this.deps.log?.warn({ err, actorId }, 'encounter: actor fetch failed; degrading');
      return null;
    }
  }

  private handleHookEvent(ev: { event: string; data: unknown }): void {
    switch (ev.event) {
      case 'updateCombat':
      case 'createCombat': {
        const doc = firstArg(ev.data);
        if (doc === null) return;
        this.combat = normalizeHookCombat(doc);
        this.seedActorCache(this.combat.combatants);
        this.emit();
        return;
      }
      case 'deleteCombat': {
        const doc = firstArg(ev.data);
        const id = doc !== null && typeof doc._id === 'string' ? doc._id : undefined;
        if (this.combat !== null && (id === undefined || id === this.combat.id)) {
          this.combat = null;
          this.emit();
        }
        return;
      }
      case 'createCombatant':
      case 'updateCombatant':
      case 'deleteCombatant':
        // These frames carry only the combatant, not the whole combat.
        void this.reseed();
        return;
      case 'updateActor': {
        const doc = firstArg(ev.data);
        if (doc === null) return;
        const actorId = typeof doc._id === 'string' ? doc._id : undefined;
        if (actorId === undefined) return;
        if (this.combat === null || !this.combat.combatants.some((c) => c.actorId === actorId)) return;
        // The frame carries the full updated doc — no extra fetch needed.
        this.actorCache.set(actorId, toActorCacheEntry(actorId, doc));
        this.emit();
        return;
      }
      default:
        // Non-hook frames ride the same stream (live-verified: the relay
        // greets every (re)connect with `event: connected`) — ignore them.
        this.deps.log?.debug?.({ event: ev.event }, 'encounter: ignoring non-combat stream event');
        return;
    }
  }

  /** Deliberate near-duplicate of LiveManager's reconnect loop (see file
   *  header) — own stream, own backoff. */
  private async subscribeLoop(ac: AbortController): Promise<void> {
    const minMs = this.deps.reconnectMinMs ?? 1_000;
    const maxMs = this.deps.reconnectMaxMs ?? 30_000;
    let backoff = minMs;
    let firstConnect = true;
    while (!ac.signal.aborted) {
      // Reconnects re-seed BEFORE resuming frame handling: frames missed
      // while the stream was down are lost forever, so REST is the only
      // recovery (live-verified 2026-07-11: the relay dropped the stream
      // mid-combat-creation — undici `TypeError: terminated` — and the
      // manager stayed stale on {active:false} until restart). start()
      // already seeded before the first connect.
      if (!firstConnect) await this.reseed();
      firstConnect = false;
      if (ac.signal.aborted) return;
      try {
        await this.deps.relay.subscribeHooks(
          COMBAT_HOOKS,
          (ev) => {
            backoff = minMs; // any frame proves the connection is healthy
            // Total handler: a malformed frame must never kill the stream
            // (a throw here rejects the subscribeHooks promise and drops
            // every future frame until reconnect).
            try {
              this.handleHookEvent(ev);
            } catch (err) {
              this.deps.log?.warn(
                { err: (err as Error).message, event: ev.event },
                'encounter: ignoring malformed hook frame',
              );
            }
          },
          ac.signal,
        );
        if (!ac.signal.aborted) {
          this.deps.log?.warn({ backoffMs: backoff }, 'encounter hooks stream closed; reconnecting');
        }
      } catch (err) {
        if (!ac.signal.aborted) {
          this.deps.log?.warn(
            {
              err: (err as Error).name,
              message: (err as Error).message,
              stack: (err as Error).stack,
              backoffMs: backoff,
            },
            'encounter hooks stream failed; reconnecting',
          );
        }
      }
      if (ac.signal.aborted) return;
      await abortableDelay(backoff, ac.signal);
      backoff = Math.min(backoff * 2, maxMs);
    }
  }
}

// ---------------------------------------------------------------------------
// Normalization: REST (RelayEncounter/RelayCombatant) and hook-frame (raw
// Foundry Combat/Combatant docs) both collapse into CombatRecord/CombatantRecord.

function pickCurrentEncounter(encounters: RelayEncounter[]): RelayEncounter | undefined {
  const current = encounters.find((e) => e.current === true);
  if (current) return current;
  const started = encounters.filter((e) => e.round >= 1);
  return started.length === 1 ? started[0] : undefined;
}

function normalizeRestCombat(e: RelayEncounter): CombatRecord {
  return {
    id: e.id,
    round: e.round,
    turn: typeof e.turn === 'number' ? e.turn : null,
    combatants: e.combatants.map(normalizeRestCombatant),
  };
}

function normalizeRestCombatant(c: RelayCombatant): CombatantRecord {
  const actorId = actorIdFromUuid(c.actorUuid);
  return {
    id: c.id,
    ...(actorId !== undefined ? { actorId } : {}),
    ...(c.name !== undefined ? { name: c.name } : {}),
    ...(c.img !== undefined && c.img !== null ? { img: c.img } : {}),
    initiative: typeof c.initiative === 'number' ? c.initiative : null,
    hidden: c.hidden === true,
    defeated: c.defeated === true,
  };
}

function normalizeHookCombat(raw: Record<string, unknown>): CombatRecord {
  const rawCombatants = Array.isArray(raw.combatants) ? raw.combatants : [];
  return {
    id: typeof raw._id === 'string' ? raw._id : '',
    round: typeof raw.round === 'number' ? raw.round : 0,
    turn: typeof raw.turn === 'number' ? raw.turn : null,
    combatants: rawCombatants
      .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
      .map(normalizeHookCombatant),
  };
}

function normalizeHookCombatant(raw: Record<string, unknown>): CombatantRecord {
  const actorId = typeof raw.actorId === 'string' && raw.actorId !== '' ? raw.actorId : undefined;
  return {
    id: typeof raw._id === 'string' ? raw._id : '',
    ...(actorId !== undefined ? { actorId } : {}),
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.img === 'string' ? { img: raw.img } : {}),
    initiative: typeof raw.initiative === 'number' ? raw.initiative : null,
    hidden: raw.hidden === true,
    defeated: raw.defeated === true,
  };
}

/** REST combatants carry `actorUuid` ("Actor.<id>"); hook frames carry a
 *  bare `actorId` already — this only applies to the REST shape. */
function actorIdFromUuid(uuid: string | undefined): string | undefined {
  if (uuid === undefined || !uuid.startsWith('Actor.')) return undefined;
  const id = uuid.split('.').pop();
  return id !== undefined && id !== '' ? id : undefined;
}

function toActorCacheEntry(actorId: string, doc: Record<string, unknown>): ActorCacheEntry {
  return {
    name: typeof doc.name === 'string' ? doc.name : actorId,
    type: typeof doc.type === 'string' ? doc.type : '',
    hp: extractHp(doc),
  };
}

/** dnd5e's hp path (system.attributes.hp.{value,max}) — the only system this
 *  registry serves today (registry.ts: dnd5e only in v1). */
function extractHp(doc: Record<string, unknown>): { value: number; max: number } {
  const sys = doc.system;
  const attrs = sys !== null && typeof sys === 'object' ? (sys as Record<string, unknown>).attributes : undefined;
  const hp = attrs !== null && typeof attrs === 'object' ? (attrs as Record<string, unknown>).hp : undefined;
  const hpRec = hp !== null && typeof hp === 'object' ? (hp as Record<string, unknown>) : {};
  const value = typeof hpRec.value === 'number' ? hpRec.value : 0;
  const max = typeof hpRec.max === 'number' ? hpRec.max : 0;
  return { value, max };
}

/** Global Constraints thresholds: down (<=0), bloodied (<50%), wounded
 *  (<100%), healthy (=max). max<=0 -> down (bare NPCs are 0/0 per Task 0). */
function computeHealth(hp: { value: number; max: number }): 'healthy' | 'wounded' | 'bloodied' | 'down' {
  if (hp.value <= 0 || hp.max <= 0) return 'down';
  const ratio = hp.value / hp.max;
  if (ratio < 0.5) return 'bloodied';
  if (ratio < 1) return 'wounded';
  return 'healthy';
}

/** Descending by initiative; null last. Array#sort is stable (spec'd since
 *  ES2019), so ties keep the combat doc's own combatant order. */
function byInitiativeDesc(a: CombatantRecord, b: CombatantRecord): number {
  const av = a.initiative === null ? -Infinity : a.initiative;
  const bv = b.initiative === null ? -Infinity : b.initiative;
  return bv - av;
}

/** Pull the hook frame's `args[0]` (Task 0 §2b: nested at data.data.args on
 *  the wire). Returns null unless it resolves to an object. */
function firstArg(payload: unknown): Record<string, unknown> | null {
  const args = extractArgsArray(payload);
  if (!args || args.length === 0) return null;
  const doc = args[0];
  return doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
}

/** Mirrors live.ts's findArgsArray tolerance for the shallower data.args
 *  nesting some relay versions use (M0 findings §3) — small enough to
 *  duplicate rather than share across the two independent managers. */
function extractArgsArray(payload: unknown): unknown[] | null {
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const data = obj.data;
  if (data !== null && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).args)) {
    return (data as Record<string, unknown>).args as unknown[];
  }
  if (Array.isArray(obj.args)) return obj.args as unknown[];
  return null;
}

/** Deliberate duplicate of live.ts's abortableDelay (see file header). */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
