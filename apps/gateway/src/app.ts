/**
 * The BFF gateway (docs/API.md, implemented exactly).
 *
 * `buildApp(deps)` takes injected dependencies (relay port, players, adapter
 * registry) so tests can run against fakes; `server.ts` wires the real ones.
 *
 * Invariant: RELAY_API_KEY / relay URLs never appear in any response body.
 * All error responses use fixed gateway-owned messages (or adapter
 * IntentError messages, which are ours too) — upstream error text goes only
 * to the structured logger.
 */
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import type {
  ActionIntent,
  CustomItemInput,
  FoundryActorDoc,
  FoundryUpdate,
  RelayAction,
  ResourceIntent,
  RollEntry,
  SheetActionKind,
  SheetViewModel,
  SystemAdapter,
} from '@companion/adapter-sdk';
import { IntentError } from '@companion/adapter-sdk';
import type {
  RawRoll,
  RelayCanvasToken,
  RelayEncounter,
  RelayScene,
  TargetedUseResult,
} from '@companion/foundry-client';
import { buildMovementContext, chebyshev, occupiedCells, speedFromStats, validateMove } from './movement.js';
import { MovementBudgetTracker } from './movement-budget.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyToken, type Player } from './players.js';
import { PlayerStoreError } from './player-store.js';
import { LiveManager } from './live.js';
import type { EncounterView } from './encounters.js';
import type { AdapterRegistry } from './registry.js';
import type { WorldHealth } from './client-id-resolver.js';
import type { BootstrapStatusView } from './status-file.js';
import type { RelayAccountView } from './relay-account.js';

/** Distinct sentinel for a stalled scene fetch in fetchMovementContext —
 *  getScene() legitimately resolves null ("no active scene"), so null can't
 *  double as a timeout marker; a unique Symbol can't collide with it. */
const SCENE_FETCH_STALLED = Symbol('scene-fetch-stalled');

/** Live view of the player list; backed by FilePlayerStore in production. */
export interface PlayersPort {
  list(): readonly Player[];
}

/** Mutating store used by the admin console (FilePlayerStore in production). */
export interface AdminStorePort extends PlayersPort {
  create(name: string, actorIds: string[]): Promise<{ token: string; player: Player }>;
  rotate(name: string): Promise<{ token: string }>;
  remove(name: string): Promise<void>;
}

/** The slice of FoundryRelayClient the gateway uses (fakeable in tests). */
export interface RelayPort {
  listClients(): Promise<unknown>;
  getEntity(uuid: string): Promise<Record<string, unknown> | null>;
  /** System-specific derived data (relay /<system>/get-actor-details). */
  getSystemDetails(systemPath: string, actorUuid: string, details: string[]): Promise<unknown>;
  updateEntity(uuid: string, data: Record<string, number | string | boolean>): Promise<void>;
  /** POST /roll — roll a formula, chat card speaking as the actor (M6). */
  rollFormula(
    actorUuid: string,
    formula: string,
    flavor: string,
  ): Promise<{ formula: string; total: number; [key: string]: unknown }>;
  /** POST /dnd5e/use-* — the system's real usage workflow for an item (M6). */
  useAbility(
    endpoint: 'use-item' | 'use-spell' | 'use-feature',
    actorUuid: string,
    itemUuid: string,
    opts?: { slotLevel?: number },
  ): Promise<Record<string, unknown>>;
  /** POST /execute-js via foundry-client castAtSlot — upcast only. */
  castAtSlot(actorUuid: string, itemUuid: string, slotKey: string): Promise<Record<string, unknown>>;
  /** POST /execute-js via foundry-client useWithoutTemplate — template-
   *  bearing items only (headless placement block, M-daylight 2026-07-20). */
  useWithoutTemplate(actorUuid: string, itemUuid: string): Promise<Record<string, unknown>>;
  /** POST /dnd5e/equip-item — toggle an item's equipped state (M6). */
  equipItem(actorUuid: string, itemUuid: string, equipped: boolean): Promise<void>;
  /** POST /dnd5e/attune-item — set an item's attuned state (M12). */
  attuneItem(actorUuid: string, itemUuid: string, attuned: boolean): Promise<void>;
  /** GET /search — find entities; compendia are included by default. */
  search(opts: { query?: string; filter?: string; limit?: number }): Promise<
    Array<{ uuid: string; id: string; name: string; img?: string; documentType: string; [key: string]: unknown }>
  >;
  /** POST /give — copy an item (compendium uuid ok) onto a target actor;
   *  true on success (M23: never throws — see foundry-client). */
  giveItem(toUuid: string, itemUuid: string): Promise<boolean>;
  /** PUT /update embedded-upsert — create/replace an Active Effect on an
   *  actor (2026-07-19 buff effects: the headless use-flow never applies
   *  self-effects, so cast-and-apply-effect applies it explicitly). */
  applyEffect(actorUuid: string, effect: Record<string, unknown>): Promise<void>;
  /** DELETE /delete — delete an entity (embedded item uuid ok); true on
   *  success (M23: never throws — see foundry-client). Callers decide
   *  whether a `false` matters: the library "remove" route surfaces it as
   *  a 502, the custom-item chain's cleanup leg treats it as best-effort. */
  deleteEntity(uuid: string): Promise<boolean>;
  /**
   * POST /create — create a world-level Item (M23: the first leg of the
   * custom-item chain — no embedded-create endpoint exists). Returns the
   * created uuid, or null on failure/timeout.
   */
  createWorldItem(data: Record<string, unknown>): Promise<string | null>;
  /**
   * POST /dnd5e/{short-rest|long-rest|death-save|break-concentration} — an
   * actor-scoped command with no item target (M8). Foundry applies the result
   * and posts any chat card; the caller re-fetches the sheet.
   */
  actorCommand(
    endpoint: 'short-rest' | 'long-rest' | 'death-save' | 'break-concentration',
    actorUuid: string,
  ): Promise<Record<string, unknown>>;
  /** GET /rolls — recent rolls across the whole world, newest first (M9). */
  getRolls(limit?: number): Promise<RawRoll[]>;
  /** GET /rolls/subscribe — live world-roll SSE stream (M9). */
  subscribeRolls(onRoll: (roll: RawRoll) => void, signal: AbortSignal): Promise<void>;
  /** World-level hooks SSE stream (the M0-verified push channel). */
  subscribeHooks(
    hooks: string[],
    onEvent: (ev: { event: string; data: unknown }) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** GET /encounters — active/all combats (M22, requires encounter:read scope). */
  getEncounters(): Promise<RelayEncounter[]>;
  /** Active scene, null when none (or relay reported none). Tokens ride
   *  along embedded on the scene document (`scene.tokens`) — there is no
   *  separate canvas-documents route on the relay. */
  getScene(): Promise<RelayScene | null>;
  /** Move a token to canvas px (top-left), animated. */
  moveToken(tokenUuid: string, x: number, y: number): Promise<void>;
  /** POST /execute-js via foundry-client useAbilityOnTargets — one
   *  orchestration: target -> activity.use -> attack/save resolution ->
   *  damage roll -> dnd5e applyDamage per target (2026-07-22). Never
   *  retried on failure (side-effecting — see the route's 408 handling). */
  useAbilityOnTargets(
    actorUuid: string,
    itemUuid: string,
    opts: {
      targetTokenUuids: string[];
      slotKey?: string;
      mode?: 'advantage' | 'disadvantage';
      attackMode?: 'oneHanded' | 'twoHanded';
    },
  ): Promise<TargetedUseResult>;
  /** POST /execute-js via foundry-client endCombatTurn — advance the combat
   *  turn IFF the expected combatant is still acting (race-guard, 2026-07-22). */
  endCombatTurn(expectedCombatantId: string): Promise<{ advanced: boolean; reason?: string; round?: number; turn?: number }>;
  /** POST /execute-js via foundry-client postChatNote — a plain chat card
   *  speaking as the actor (Dash's GM-visibility note, 2026-07-22). */
  postChatNote(actorUuid: string, text: string): Promise<void>;
  /** POST /execute-js via foundry-client getDerivedAc — the PREPARED actor's
   *  live system.attributes.ac.value (Task 8: AC display fix under active
   *  effects). Null on any failure; never throws. */
  getDerivedAc(actorUuid: string): Promise<number | null>;
}

/**
 * The slice of EncounterManager (encounters.ts) the routes need (M22).
 * Structural — EncounterManager satisfies this without an explicit
 * `implements`. Absent from GatewayDeps -> the three /api/encounter* routes
 * are never registered and fall through to the standard 404 envelope.
 */
export interface EncounterManagerPort {
  isActive(): boolean;
  combatant(id: string): { id: string; actorId?: string } | undefined;
  view(): EncounterView;
  attach(send: (view: EncounterView) => void): () => void;
  /** Re-fetch one actor (bounded) and refresh cached hp/type before the
   *  caller re-reads view() — used right after an hp write. */
  refreshActor(actorId: string): Promise<void>;
  /** The acting combatant (2026-07-22 turn flow): null when inactive or when
   *  the acting combatant is hidden. */
  current(): { combatId: string; round: number; combatantId: string; actorId?: string } | null;
  /** First non-hidden combatant linked to this actor (movement budget /
   *  End turn both key on it, 2026-07-22). */
  combatantByActorId(actorId: string): { id: string; actorId?: string } | undefined;
  /** Active combat's id + round regardless of the acting combatant's
   *  visibility (final-review Fix 1) — null only when inactive. */
  activeRound(): { combatId: string; round: number } | null;
  /** Fire-and-forget coalesced REST reconcile (2026-07-23) — the SSE route
   *  calls this on client connect so a reload reflects truth immediately. */
  reconcileNow(): void;
}

export interface GatewayDeps {
  relay: RelayPort;
  players: PlayersPort;
  registry: AdapterRegistry;
  /** Adapter used when the relay doc carries no system id. Default "dnd5e".
   *  Turnkey (RELAY_CLIENT_ID=auto): pass a provider so a systemId resolved
   *  AFTER buildApp (server.ts's ClientIdResolver.resolvedWorld(), populated
   *  by its bounded probe loop) is picked up per-request without rebuilding
   *  the app — fixes a wod5e actor being served through the dnd5e adapter
   *  when the relay doc itself carries no systemId (Task 0 findings §6-2). */
  defaultSystemId?: string | (() => string);
  /** Poll interval for the live-update fallback. Default 3000. */
  livePollMs?: number;
  /** Hooks-stream reconnect backoff floor. Default 1000. */
  liveReconnectMinMs?: number;
  /** Hooks-stream reconnect backoff ceiling. Default 30000. */
  liveReconnectMaxMs?: number;
  /** SSE keep-alive interval. Default 25000. */
  pingMs?: number;
  /** Write intents allowed per token per window. Default 30. */
  rateLimitMax?: number;
  /** Rate-limit window. Default 60000. */
  rateLimitWindowMs?: number;
  logger?: FastifyServerOptions['logger'];
  /** When present (non-empty password), enables the /api/admin/* surface. */
  admin?: { password: string; store: AdminStorePort };
  /** Per-actor name-resolution budget for the admin console. Default 3000. */
  adminNameTimeoutMs?: number;
  /** M22: live combat mirror + hp-write routes. Absent -> those routes 404. */
  encounters?: EncounterManagerPort;
  /** M22: budget for the hp-write route's actor fetch (every relay await on
   *  the encounter path is bounded — Global Constraints). Default 3000. */
  encounterFetchTimeoutMs?: number;
  /** Budget for POST /api/encounter/turn/end's relay call (final-review Fix
   *  4). Deliberately longer than encounterFetchTimeoutMs: that budget is
   *  sized for plain REST fetches (getScene, getEntity), but endCombatTurn
   *  runs a script through execute-js in the GM's browser — a slower path —
   *  so the 3s REST bound was firing spurious 502s while the turn was still
   *  genuinely advancing. Default 15000. */
  turnEndTimeoutMs?: number;
  /** Token movement: budget per relay leg (scene/tokens/actor fetch, and the
   *  POST move) — every relay await is bounded. Default 3000. */
  movementTimeoutMs?: number;
  /** M23: budget per relay call in the custom-item create->give->delete
   *  chain (every relay await is bounded — Global Constraints). Default 3000. */
  customItemTimeoutMs?: number;
  /** Turnkey: subscribe to relay identity changes (key rotated / clientId
   *  re-resolved). On fire, buildApp restarts its relay-side streams:
   *  LiveManager's hooks stream is aborted+reopened, and every gm-rolls SSE
   *  connection is closed (its relay-side /rolls/subscribe aborts; browser
   *  EventSources reconnect and re-subscribe under the new identity). The
   *  EncounterManager's stream is restarted by server.ts, which owns it.
   *  Returns an unsubscribe function. */
  relayIdentityChanged?: (cb: () => void) => () => void;
  /** Turnkey: world-resolution state merged into /healthz (client-safe — no
   *  clientId). Absent, or returning null, omits the field. */
  worldStatus?: () => WorldHealth | null;
  /** Turnkey: whitelisted sidecar status.json view merged into /healthz;
   *  null (absent/unreadable) omits the field. */
  bootstrapStatus?: () => BootstrapStatusView | null;
  /** Turnkey: relay account (email+password) for the admin pairing panel,
   *  surfaced only via GET /api/admin/relay. null when the sidecar file is
   *  absent/unreadable. Requires `admin` to be configured to have any effect. */
  relayAccount?: () => RelayAccountView | null;
  /** Turnkey: the self-hosted relay URL shown in the admin pairing panel so
   *  approvals open the right page. Absent -> panel reports it as unknown. */
  relayPairBaseUrl?: string;
  /** Bound for /healthz's relay probe (M18 pattern). Default 3000. */
  healthTimeoutMs?: number;
}

type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN_RESOURCE'
  | 'INVALID_INTENT'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UPSTREAM'
  | 'NOT_FOUND';

declare module 'fastify' {
  interface FastifyRequest {
    player?: Player;
  }
}

/** In-memory sliding-window rate limiter, keyed per token (hash). */
class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

function sendError(reply: FastifyReply, status: number, code: ErrorCode, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

function parseIntent(body: Record<string, unknown>, resourceId: string): ResourceIntent | null {
  let expected: number | undefined;
  if (body.expected !== undefined) {
    if (typeof body.expected !== 'number' || !Number.isFinite(body.expected)) return null;
    expected = body.expected;
  }
  if (body.kind === 'set') {
    if (typeof body.value !== 'number' || !Number.isFinite(body.value)) return null;
    return expected === undefined
      ? { kind: 'set', resourceId, value: body.value }
      : { kind: 'set', resourceId, value: body.value, expected };
  }
  if (body.kind === 'delta') {
    if (typeof body.amount !== 'number' || !Number.isFinite(body.amount)) return null;
    return expected === undefined
      ? { kind: 'delta', resourceId, amount: body.amount }
      : { kind: 'delta', resourceId, amount: body.amount, expected };
  }
  return null;
}

/**
 * Validate the per-kind extras of an action body. `kind` is the descriptor's
 * kind (already confirmed to equal `body.kind` by the allow-list check).
 */
/** Full REST-scoped token uuid, e.g. `Scene.abc123.Token.def456` — the shape
 *  the roster (EncounterView combatants) and use-on-targets both deal in. */
const TARGET_TOKEN_UUID_RE = /^Scene\.[A-Za-z0-9]{1,32}\.Token\.[A-Za-z0-9]{1,32}$/;

/** undefined = field absent; null = malformed (422). 1-12 unique full uuids. */
function parseTargetTokenUuids(raw: unknown): string[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 12) return null;
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string' || !TARGET_TOKEN_UUID_RE.test(t) || out.includes(t)) return null;
    out.push(t);
  }
  return out;
}

function parseActionIntent(
  body: Record<string, unknown>,
  actionId: string,
  kind: SheetActionKind,
): ActionIntent | null {
  switch (kind) {
    case 'check':
    case 'save':
      if (body.mode !== undefined && body.mode !== 'advantage' && body.mode !== 'disadvantage') return null;
      return body.mode === undefined ? { kind, actionId } : { kind, actionId, mode: body.mode };
    case 'attack': {
      if (body.mode !== undefined && body.mode !== 'advantage' && body.mode !== 'disadvantage') return null;
      const targetTokenUuids = parseTargetTokenUuids(body.targetTokenUuids);
      if (targetTokenUuids === null) return null;
      return {
        kind,
        actionId,
        ...(body.mode !== undefined ? { mode: body.mode as 'advantage' | 'disadvantage' } : {}),
        ...(targetTokenUuids !== undefined ? { targetTokenUuids } : {}),
      };
    }
    case 'use': {
      const targetTokenUuids = parseTargetTokenUuids(body.targetTokenUuids);
      if (targetTokenUuids === null) return null;
      return { kind, actionId, ...(targetTokenUuids !== undefined ? { targetTokenUuids } : {}) };
    }
    case 'damage':
      // Optional nat-20 flag: the adapter doubles the damage dice (5e crit).
      if (body.critical !== undefined && typeof body.critical !== 'boolean') return null;
      // Optional upcast level (deep bounds live in the adapter): scales the
      // display formula's dice for the slot the spell was actually cast at.
      if (
        body.slotLevel !== undefined &&
        (typeof body.slotLevel !== 'number' || !Number.isInteger(body.slotLevel) || body.slotLevel < 1)
      ) {
        return null;
      }
      return {
        kind,
        actionId,
        ...(body.critical !== undefined ? { critical: body.critical } : {}),
        ...(body.slotLevel !== undefined ? { slotLevel: body.slotLevel } : {}),
      };
    case 'cast':
      if (
        body.slotLevel !== undefined &&
        (typeof body.slotLevel !== 'number' || !Number.isInteger(body.slotLevel) || body.slotLevel < 0)
      ) {
        return null;
      }
      if (
        body.targetActorId !== undefined &&
        (typeof body.targetActorId !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(body.targetActorId))
      ) {
        return null;
      }
      {
        const targetTokenUuids = parseTargetTokenUuids(body.targetTokenUuids);
        if (targetTokenUuids === null) return null;
        return {
          kind,
          actionId,
          ...(body.slotLevel !== undefined ? { slotLevel: body.slotLevel } : {}),
          ...(body.targetActorId !== undefined ? { targetActorId: body.targetActorId } : {}),
          ...(targetTokenUuids !== undefined ? { targetTokenUuids } : {}),
        };
      }
    case 'equip':
      if (typeof body.equipped !== 'boolean') return null;
      return { kind, actionId, equipped: body.equipped };
    case 'prepare':
      if (typeof body.prepared !== 'boolean') return null;
      return { kind, actionId, prepared: body.prepared };
    case 'attune':
      if (typeof body.attuned !== 'boolean') return null;
      return { kind, actionId, attuned: body.attuned };
    case 'grip':
      if (body.grip !== 'oneHanded' && body.grip !== 'twoHanded') return null;
      return { kind, actionId, grip: body.grip };
    case 'move':
      if (body.containerId !== null && (typeof body.containerId !== 'string' || body.containerId === '')) {
        return null;
      }
      return { kind, actionId, containerId: body.containerId as string | null };
    case 'rest':
    case 'deathsave':
    case 'endconcentration':
    case 'endeffect':
      // Actor-scoped commands carry only {kind, actionId} — no extra fields.
      return { kind, actionId };
    case 'pool': {
      // M23 wod5e pool roll: attribute/skill/modifier are all optional
      // overrides of the descriptor's default pairing — only type-check
      // them here (shape sanity); the adapter does the deep validation
      // (prefix shapes, known vocab, modifier range).
      if (body.attribute !== undefined && typeof body.attribute !== 'string') return null;
      if (body.skill !== undefined && typeof body.skill !== 'string') return null;
      if (body.modifier !== undefined && (typeof body.modifier !== 'number' || !Number.isFinite(body.modifier))) {
        return null;
      }
      return {
        kind,
        actionId,
        ...(body.attribute !== undefined ? { attribute: body.attribute } : {}),
        ...(body.skill !== undefined ? { skill: body.skill } : {}),
        ...(body.modifier !== undefined ? { modifier: body.modifier } : {}),
      };
    }
    case 'rouse':
      // M23 wod5e rouse check: no extra fields, mirrors the actor-scoped
      // commands above.
      return { kind, actionId };
    default:
      return null;
  }
}

/** The roll summary returned to the client for actions that rolled dice. */
interface ActionRollResult {
  total: number;
  formula: string;
  isCritical?: boolean;
  isFumble?: boolean;
}

/**
 * Pull `{total, formula, isCritical?, isFumble?}` out of a relay response:
 * `rollFormula` returns the roll itself; the `use-*` endpoints nest it under
 * `roll` (the M6-verified `data.roll` shape). Anything else -> null.
 */
function extractRoll(value: unknown): ActionRollResult | null {
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.total === 'number' && typeof obj.formula === 'string') {
    return {
      total: obj.total,
      formula: obj.formula,
      ...(typeof obj.isCritical === 'boolean' ? { isCritical: obj.isCritical } : {}),
      ...(typeof obj.isFumble === 'boolean' ? { isFumble: obj.isFumble } : {}),
    };
  }
  return 'roll' in obj ? extractRoll(obj.roll) : null;
}

/** True when `err` is a RelayError carrying HTTP 408 — the relay's usage
 *  workflow completed (or started) in Foundry but the response itself was
 *  slow, never a config/permissions problem. Shared by every cast/use path
 *  below (use-and-roll, the bare use-item/use-spell/use-feature case, and
 *  cast-at-slot) so the timeout-tolerance rule lives in exactly one place. */
function isRelayTimeout(err: unknown): boolean {
  const status = (err as { status?: unknown }).status;
  return err instanceof Error && err.name === 'RelayError' && status === 408;
}

/** RelayError from execute-js when the module setting or API-key scope is
 *  missing — surfaced as an actionable 422 instead of a generic 502.
 *  Keys on the module's refusal WORDING, never the endpoint path (which
 *  foundry-client embeds in every HTTP-failure message — see
 *  packages/foundry-client/src/index.ts's request() `relay ${path} -> ...`
 *  template), so a genuine script/5xx/timeout failure on /execute-js falls
 *  through to the 502 handler instead of the "Allow Execute JS" toast. */
function upcastUnavailable(err: unknown): string | null {
  if (!(err instanceof Error) || err.name !== 'RelayError') return null;
  // A timeout is never a config problem (see the 408-tolerance handling in
  // the use-and-roll catch below).
  if ((err as { status?: unknown }).status === 408) return null;
  // NOTE: these strings are pinned by the Task-11 live verification gate —
  // adjust here (and there) if the observed relay wording differs.
  if (!/execute-js is disabled|execute-js.*scope/i.test(err.message)) return null;
  return 'Upcasting is not enabled on the table: enable "Allow Execute JS" in the Foundry REST API module settings and grant the relay API key the execute-js scope.';
}

/** Run an item's usage workflow. Template-bearing items (action.noTemplate)
 *  go through the execute-js activation, which suppresses the headless-
 *  blocking canvas placement prompt (5-8s -> ~250ms, live-verified
 *  2026-07-20); when the table has execute-js disabled/unscoped
 *  (upcastUnavailable wording — used here as a detector only, its message is
 *  NOT surfaced) the module use-* endpoint still works, just slow (the
 *  template prompt 408s and the caller's isRelayTimeout handling tolerates
 *  it). Every other execute-js failure stays fatal — a fallback would risk a
 *  double activation. `slotLevel` casts skip the execute-js path (it speaks
 *  default consumption only).
 */
async function activateAbility(
  relay: RelayPort,
  endpoint: 'use-item' | 'use-spell' | 'use-feature',
  actorUuid: string,
  itemUuid: string,
  opts: { slotLevel?: number },
  noTemplate: true | undefined,
  log?: { warn(obj: unknown, msg?: string): void },
): Promise<Record<string, unknown>> {
  if (noTemplate === true && opts.slotLevel === undefined) {
    try {
      return await relay.useWithoutTemplate(actorUuid, itemUuid);
    } catch (err) {
      if (upcastUnavailable(err) === null) throw err;
      log?.warn(
        { err: (err as Error).message },
        'noTemplate activation: execute-js unavailable; falling back to the module endpoint (slow — enable "Allow Execute JS" + the execute-js key scope to fix)',
      );
    }
  }
  return relay.useAbility(endpoint, actorUuid, itemUuid, opts);
}

const AE_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** A Foundry-style 16-char document id for an app-applied effect. */
function mintEffectId(): string {
  let s = '';
  for (let i = 0; i < 16; i++) s += AE_ID_ALPHABET[Math.floor(Math.random() * AE_ID_ALPHABET.length)];
  return s;
}

/** actor ids a player may drop a buff on: the caster is always allowed;
 *  otherwise the target must be a current combatant or a party member. */
function buffTargetAllowed(targetId: string, casterId: string, deps: GatewayDeps): boolean {
  if (targetId === casterId) return true;
  const party = new Set(deps.players.list().flatMap((p) => p.actorIds));
  if (party.has(targetId)) return true;
  const combatIds = new Set(
    (deps.encounters?.view().combatants ?? [])
      .map((c) => c.actorId)
      .filter((a): a is string => typeof a === 'string'),
  );
  return combatIds.has(targetId);
}

/** Per-actor combat movement budget context (2026-07-22 §F4) — see
 *  combatMoveContext inside buildApp. `key` is the MovementBudgetTracker key
 *  for this actor's combatant this round; absent when out of combat. */
interface CombatMoveContext {
  inCombat: boolean;
  yourTurn: boolean;
  key?: string;
  remainingFt?: number;
  dashed?: boolean;
}

/** The `{inCombat, yourTurn, remainingFt, dashed}` fields spread onto a
 *  movement response (GET/POST /api/actors/:id/movement, the dash route) —
 *  `{}` out of combat, so the shape stays absent (not undefined-valued) on
 *  the wire exactly as before. */
function budgetFields(cc: CombatMoveContext): Record<string, unknown> {
  return cc.inCombat
    ? { inCombat: true, yourTurn: cc.yourTurn, remainingFt: cc.remainingFt, dashed: cc.dashed }
    : {};
}

/**
 * Whitelist for the manual dice tray: only `NdM` dice terms and integer
 * modifiers joined by + / - (e.g. "2d6 + 1d8 + 3"). Keeps the endpoint a dice
 * tray, not a Foundry-formula console — no @refs, functions, or code paths
 * reach the relay. Caps count/sides so a roll can't be abusive.
 */
export function isSafeDiceFormula(formula: string): boolean {
  if (formula === '' || formula.length > 100) return false;
  if (!/^[0-9d+\-\s]+$/i.test(formula)) return false;
  const terms = formula.split(/[+-]/).map((t) => t.trim());
  let hasDie = false;
  for (const term of terms) {
    if (term === '') return false; // trailing/double operator
    if (/^\d+$/.test(term)) continue; // flat integer modifier
    const m = /^(\d*)d(\d+)$/i.exec(term);
    if (!m) return false;
    const count = m[1] === '' ? 1 : Number(m[1]);
    const sides = Number(m[2]);
    if (count < 1 || count > 100 || sides < 1 || sides > 1000) return false;
    hasDie = true;
  }
  return hasDie;
}

export function buildApp(deps: GatewayDeps): FastifyInstance {
  const resolveDefaultSystemId = (): string =>
    typeof deps.defaultSystemId === 'function' ? deps.defaultSystemId() : (deps.defaultSystemId ?? 'dnd5e');
  const pingMs = deps.pingMs ?? 25_000;
  const livePollMs = deps.livePollMs ?? 3_000;
  const adminNameTimeoutMs = deps.adminNameTimeoutMs ?? 3_000;
  const encounterFetchTimeoutMs = deps.encounterFetchTimeoutMs ?? 3_000;
  const turnEndTimeoutMs = deps.turnEndTimeoutMs ?? 15_000;
  const movementTimeoutMs = deps.movementTimeoutMs ?? 3_000;
  const customItemTimeoutMs = deps.customItemTimeoutMs ?? 3_000;
  const healthTimeoutMs = deps.healthTimeoutMs ?? 3_000;
  const limiter = new SlidingWindowLimiter(deps.rateLimitMax ?? 30, deps.rateLimitWindowMs ?? 60_000);
  const movementBudget = new MovementBudgetTracker();
  const { relay, players, registry } = deps;

  const app = Fastify({ logger: deps.logger ?? false });

  // ---- helpers ------------------------------------------------------------

  const systemIdOf = (doc: Record<string, unknown>): string =>
    typeof doc.systemId === 'string' && doc.systemId !== '' ? doc.systemId : resolveDefaultSystemId();

  const adapterFor = (doc: Record<string, unknown>): SystemAdapter | undefined => registry.get(systemIdOf(doc));

  const fetchActor = async (actorId: string): Promise<FoundryActorDoc | null> => {
    const doc = await relay.getEntity(`Actor.${actorId}`);
    if (doc === null || typeof doc !== 'object') return null;
    let actor = doc as unknown as FoundryActorDoc;
    // Enrich with derived data /get does not serialize (e.g. dnd5e slot
    // maxima) so descriptor bounds and sheets are correct on every path.
    const adapter = adapterFor(actor);
    if (adapter?.enrich) {
      try {
        actor = await adapter.enrich(actor, {
          getSystemDetails: (details) => relay.getSystemDetails(adapter.systemId, `Actor.${actorId}`, details),
          getDerivedAc: () =>
            boundedMs(relay.getDerivedAc(`Actor.${actorId}`), encounterFetchTimeoutMs).then((v) => v ?? null),
        });
      } catch (err) {
        app.log.warn({ err, actorId }, 'adapter enrich failed; serving unenriched document');
      }
    }
    return actor;
  };

  /** M18-style bounded await: relay stall → null sentinel instead of a hang. */
  const boundedMs = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
    Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

  /** Scene + tokens + walk speed for one actor, every leg bounded.
   *  Returns null when a leg AFTER a resolved scene fails (→ 502);
   *  an unresolved scene is a normal offScene result, not an error — EXCEPT
   *  `stalled: true`, which means the scene leg itself timed out rather than
   *  the relay answering "no active scene". GET degrades both the same way
   *  (200 onScene:false); POST must not, since a stall isn't "no token on the
   *  active scene" — it's an upstream outage (502), so `stalled` lets POST
   *  tell the two apart while GET ignores it. */
  const fetchMovementContext = async (actorId: string) => {
    const sceneOrStall = await Promise.race([
      relay.getScene(),
      new Promise<typeof SCENE_FETCH_STALLED>((resolve) =>
        setTimeout(() => resolve(SCENE_FETCH_STALLED), movementTimeoutMs)),
    ]);
    if (sceneOrStall === SCENE_FETCH_STALLED) return { offScene: true as const, stalled: true as const };
    const scene = sceneOrStall;
    if (!scene) return { offScene: true as const, stalled: false as const };
    // Movement v1 is dnd5e-only (spec), and only the relay's derived
    // get-actor-details response carries a real walk speed — source actor
    // docs (relay.getEntity) have no system.attributes.movement in dnd5e 5.x
    // (see speedFromStats doc comment in movement.ts).
    const details = await boundedMs(relay.getSystemDetails('dnd5e', `Actor.${actorId}`, ['stats']), movementTimeoutMs);
    if (details === null) return null;
    const tokens: RelayCanvasToken[] = Array.isArray(scene.tokens) ? scene.tokens : [];
    return {
      offScene: false as const,
      ctx: buildMovementContext(scene, tokens, actorId, speedFromStats(details)),
      tokens,
    };
  };

  /** Budget context for this actor (2026-07-22 §F4). Not a combatant (or no
   *  live encounter) -> free movement, exactly like out-of-combat today.
   *
   *  Final-review Fix 1: `mgr.current()` is null BOTH when combat is
   *  inactive AND when combat is active but the acting combatant is hidden
   *  (same visibility rule as view().turn — current()'s doc comment). Those
   *  are not the same thing: during a hidden NPC's turn, a player with a
   *  visible combatant must still be blocked (off-turn), not granted free
   *  movement. So `mine` (this player's own visible combatant) is resolved
   *  first and gates the free-movement fallback; the round/combatId needed
   *  to key the budget then comes from `current()` when the acting
   *  combatant is visible, or from `activeRound()` (visibility-independent)
   *  when it's hidden — `yourTurn` is false in that case since a hidden
   *  combatant can never be `mine` (combatantByActorId only returns visible
   *  ones). */
  function combatMoveContext(actorId: string, speedFt: number): CombatMoveContext {
    const mgr = deps.encounters;
    if (!mgr || !mgr.isActive()) return { inCombat: false, yourTurn: false };
    const mine = mgr.combatantByActorId(actorId);
    if (!mine) return { inCombat: false, yourTurn: false };
    const cur = mgr.current();
    const round = cur ?? mgr.activeRound();
    if (!round) return { inCombat: false, yourTurn: false }; // defensive: isActive() implies activeRound() non-null
    movementBudget.prune(round.combatId, round.round);
    const key = MovementBudgetTracker.key(round.combatId, round.round, mine.id);
    const st = movementBudget.state(key);
    return {
      inCombat: true,
      yourTurn: cur !== null && mine.id === cur.combatantId,
      key,
      remainingFt: Math.max(0, speedFt * (st.dashed ? 2 : 1) - st.movedFt),
      dashed: st.dashed,
    };
  }

  const buildSheet = (adapter: SystemAdapter, actor: FoundryActorDoc): SheetViewModel => adapter.toViewModel(actor);

  const fetchSheetJson = async (actorId: string): Promise<string | null> => {
    const actor = await fetchActor(actorId);
    if (!actor) return null;
    const adapter = adapterFor(actor);
    if (!adapter) return null;
    return JSON.stringify(buildSheet(adapter, actor));
  };

  const live = new LiveManager({
    pollMs: livePollMs,
    fetchSheetJson,
    subscribeHooks: (hooks, onEvent, signal) => relay.subscribeHooks(hooks, onEvent, signal),
    ...(deps.liveReconnectMinMs !== undefined ? { reconnectMinMs: deps.liveReconnectMinMs } : {}),
    ...(deps.liveReconnectMaxMs !== undefined ? { reconnectMaxMs: deps.liveReconnectMaxMs } : {}),
    log: { warn: (obj, msg) => app.log.warn(obj as object, msg) },
  });

  // Open SSE connections' cleanup functions, run on app close as a safety net.
  const sseCleanups = new Set<() => void>();

  // gm-rolls SSE connections hold a relay-side /rolls/subscribe opened with
  // the connection-time identity; tracked separately so an identity change
  // can close exactly these (see relayIdentityChanged).
  const rollStreamCleanups = new Set<() => void>();

  if (deps.relayIdentityChanged !== undefined) {
    const unsubscribe = deps.relayIdentityChanged(() => {
      app.log.warn({}, 'relay identity changed; restarting relay-side streams');
      live.restartStream();
      for (const cleanup of [...rollStreamCleanups]) cleanup();
    });
    app.addHook('onClose', async () => unsubscribe());
  }

  const extractToken = (req: FastifyRequest, allowQueryToken: boolean): string | null => {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const token = header.slice('Bearer '.length).trim();
      if (token !== '') return token;
    }
    if (allowQueryToken) {
      const q = (req.query ?? {}) as Record<string, unknown>;
      if (typeof q.token === 'string' && q.token !== '') return q.token;
    }
    return null;
  };

  const auth =
    (allowQueryToken: boolean) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const token = extractToken(req, allowQueryToken);
      const player = token === null ? null : verifyToken(players.list(), token);
      if (!player) {
        sendError(reply, 401, 'UNAUTHORIZED', 'missing or unknown token');
        return;
      }
      req.player = player;
    };

  // ---- admin (M18): env-credential surface, disabled unless configured -----

  const adminHash =
    deps.admin !== undefined && deps.admin.password !== ''
      ? createHash('sha256').update(deps.admin.password, 'utf8').digest()
      : null;
  const adminStore = adminHash !== null ? (deps.admin as { store: AdminStorePort }).store : null;

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (adminHash === null) {
      sendError(reply, 404, 'NOT_FOUND', 'not found');
      return;
    }
    const presented = extractToken(req, false);
    const ok =
      presented !== null &&
      timingSafeEqual(createHash('sha256').update(presented, 'utf8').digest(), adminHash);
    if (!ok) sendError(reply, 401, 'UNAUTHORIZED', 'missing or unknown credential');
  };

  // ---- envelope for framework-level errors ---------------------------------

  app.setErrorHandler((err, req, reply) => {
    // Full upstream error text goes to the log only — never to the client.
    req.log.error({ err }, 'request failed');
    if (reply.sent || reply.raw.headersSent) return;
    const maybeStatus = (err as { statusCode?: unknown }).statusCode;
    const statusCode = typeof maybeStatus === 'number' ? maybeStatus : undefined;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      void sendError(reply, statusCode, 'INVALID_INTENT', 'invalid request');
      return;
    }
    void sendError(reply, 502, 'UPSTREAM', 'upstream error');
  });

  app.setNotFoundHandler((_req, reply) => {
    void sendError(reply, 404, 'NOT_FOUND', 'not found');
  });

  app.addHook('onClose', async () => {
    for (const cleanup of [...sseCleanups]) cleanup();
    live.stopAll();
  });

  // ---- routes --------------------------------------------------------------

  app.get('/healthz', async (_req, reply) => {
    // Bounded probe: the relay is known to stall requests (docs/RELAY.md) —
    // the health surface must never hang with it.
    let relayState: 'connected' | 'disconnected' = 'connected';
    try {
      const ok = await Promise.race([
        relay.listClients().then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), healthTimeoutMs)),
      ]);
      if (!ok) relayState = 'disconnected';
    } catch (err) {
      app.log.warn({ err }, 'relay health check failed');
      relayState = 'disconnected';
    }
    const world = deps.worldStatus?.() ?? null;
    const bootstrap = deps.bootstrapStatus?.() ?? null;
    return reply.code(200).send({
      ok: true,
      relay: relayState,
      ...(world !== null ? { world } : {}),
      ...(bootstrap !== null ? { bootstrap } : {}),
    });
  });

  app.get('/api/me', { preHandler: auth(false) }, async (req, reply) => {
    const player = req.player as Player;
    return reply.code(200).send({
      player: { name: player.name, actorIds: player.actorIds, gm: player.gm === true },
    });
  });

  // Out-of-combat target picker's roster: every player's actorIds, deduped,
  // with best-effort name/img resolved via the relay (bounded, mirrors the
  // /api/admin/players lookup below) — a bare id on miss.
  app.get('/api/party', { preHandler: auth(false) }, async (_req, reply) => {
    const ids = [...new Set(players.list().flatMap((p) => p.actorIds))];
    const meta = new Map<string, { name?: string; img?: string }>();
    await Promise.all(
      ids.map(async (id) => {
        try {
          const doc = await Promise.race([
            relay.getEntity(`Actor.${id}`),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), adminNameTimeoutMs)),
          ]);
          if (doc !== null) {
            const entry: { name?: string; img?: string } = {};
            if (typeof doc.name === 'string') entry.name = doc.name;
            if (typeof doc.img === 'string') entry.img = doc.img;
            meta.set(id, entry);
          }
        } catch {
          /* best-effort: unresolved ids render bare */
        }
      }),
    );
    return reply.code(200).send({
      actors: ids.map((id) => ({ id, ...(meta.get(id) ?? {}) })),
    });
  });

  app.get('/api/admin/players', { preHandler: requireAdmin }, async (_req, reply) => {
    const entries = (adminStore as AdminStorePort).list();
    const ids = [...new Set(entries.flatMap((p) => p.actorIds))];
    const names = new Map<string, string>();
    await Promise.all(
      ids.map(async (id) => {
        try {
          // The relay occasionally accepts a request and never responds; a
          // never-settling promise defeats the catch below, so every lookup
          // is raced against a budget. Timeout -> null -> id renders bare.
          const doc = await Promise.race([
            relay.getEntity(`Actor.${id}`),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), adminNameTimeoutMs)),
          ]);
          if (doc !== null && typeof doc.name === 'string') names.set(id, doc.name);
        } catch {
          /* best-effort: unresolved ids render bare */
        }
      }),
    );
    return reply.code(200).send({
      players: entries.map((p) => ({
        name: p.name,
        gm: p.gm === true,
        actors: p.actorIds.map((id) => {
          const name = names.get(id);
          return name === undefined ? { id } : { id, name };
        }),
      })),
    });
  });

  app.post<{ Body: { name?: unknown; actorIds?: unknown } }>(
    '/api/admin/players',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const body = req.body ?? {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const actorIds =
        Array.isArray(body.actorIds) && body.actorIds.every((a) => typeof a === 'string' && a !== '')
          ? (body.actorIds as string[])
          : null;
      if (name === '' || actorIds === null || actorIds.length === 0) {
        return sendError(reply, 422, 'INVALID_INTENT', 'name and actorIds are required');
      }
      try {
        const { token, player } = await (adminStore as AdminStorePort).create(name, actorIds);
        // The plaintext token exists only in this response — it is never stored.
        return reply.code(201).send({
          token,
          player: { name: player.name, actorIds: player.actorIds, gm: player.gm === true },
        });
      } catch (err) {
        if (err instanceof PlayerStoreError && err.code === 'DUPLICATE') {
          return sendError(reply, 409, 'CONFLICT', 'a player with that name already exists');
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    '/api/admin/players/:name/rotate',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        const { token } = await (adminStore as AdminStorePort).rotate(req.params.name);
        return reply.code(200).send({ token });
      } catch (err) {
        if (err instanceof PlayerStoreError && err.code === 'NOT_FOUND') {
          return sendError(reply, 404, 'NOT_FOUND', 'not found');
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { name: string } }>(
    '/api/admin/players/:name',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        await (adminStore as AdminStorePort).remove(req.params.name);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof PlayerStoreError && err.code === 'NOT_FOUND') {
          return sendError(reply, 404, 'NOT_FOUND', 'not found');
        }
        throw err;
      }
    },
  );

  app.get<{ Querystring: { q?: string } }>(
    '/api/admin/actors',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const q = (req.query.q ?? '').trim();
      if (q === '') return reply.code(200).send({ actors: [] });
      const entries = await relay.search({
        query: q,
        filter: 'documentType:Actor,subType:character',
        limit: 20,
      });
      // World actors only — compendium uuids are premades, not table characters.
      const actors = entries
        .filter((e) => e.uuid.startsWith('Actor.'))
        .map((e) => ({ id: e.id, name: e.name, ...(e.img !== undefined ? { img: e.img } : {}) }));
      return reply.code(200).send({ actors });
    },
  );

  // Relay & Pairing panel (admin-only): the relay account credentials needed
  // to APPROVE a pairing request, plus the self-hosted URL where that approval
  // happens. Both are behind requireAdmin — the password never appears on any
  // unauthenticated surface. account is null until the sidecar has written its
  // relay-account.json (fresh stack, before the first converge pass).
  app.get('/api/admin/relay', { preHandler: requireAdmin }, async (_req, reply) => {
    const account = deps.relayAccount?.() ?? null;
    return reply.code(200).send({
      account,
      pairBaseUrl: deps.relayPairBaseUrl ?? null,
    });
  });

  /** Map a raw relay roll to the client-facing RollEntry (M9). */
  const toRollEntry = (r: RawRoll): RollEntry => ({
    id: typeof r.id === 'string' ? r.id : typeof r.messageId === 'string' ? r.messageId : String(r.timestamp ?? ''),
    by: r.speaker?.alias ?? r.user?.name ?? 'Someone',
    flavor: typeof r.flavor === 'string' ? r.flavor : '',
    total: typeof r.rollTotal === 'number' ? r.rollTotal : Number.NaN,
    formula: typeof r.formula === 'string' ? r.formula : '',
    isCritical: r.isCritical === true,
    isFumble: r.isFumble === true,
    timestamp: typeof r.timestamp === 'number' ? r.timestamp : 0,
  });

  // GM roll feed (M9). GM-only; non-GM tokens get 404 (do not leak the route).
  app.get<{ Querystring: { limit?: string } }>(
    '/api/gm/rolls',
    { preHandler: auth(false) },
    async (req, reply) => {
      const player = req.player as Player;
      if (player.gm !== true) return sendError(reply, 404, 'NOT_FOUND', 'not found');
      const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit ?? '50', 10) || 50));
      const rolls = (await relay.getRolls(limit)).map(toRollEntry);
      return reply.code(200).send({ rolls });
    },
  );

  app.get<{ Querystring: { token?: string } }>(
    '/api/gm/rolls/events',
    { preHandler: auth(true) },
    async (req, reply) => {
      const player = req.player as Player;
      if (player.gm !== true) return sendError(reply, 404, 'NOT_FOUND', 'not found');

      reply.hijack();
      const rawRes = reply.raw;
      rawRes.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      const ac = new AbortController();
      let ping: ReturnType<typeof setInterval> | undefined;
      let done = false;
      const cleanup = (): void => {
        if (done) return;
        done = true;
        rollStreamCleanups.delete(cleanup);
        if (ping) clearInterval(ping);
        ac.abort();
        rawRes.end();
      };
      rollStreamCleanups.add(cleanup);
      const send = (event: string, data: string): void => {
        if (done) return;
        try {
          rawRes.write(`event: ${event}\ndata: ${data}\n\n`);
        } catch {
          cleanup();
        }
      };

      // Seed with recent history so the feed isn't empty on open.
      try {
        const recent = (await relay.getRolls(30)).map(toRollEntry);
        for (const r of recent.reverse()) send('roll', JSON.stringify(r));
      } catch (err) {
        app.log.warn({ err }, 'gm rolls: initial history failed');
      }

      ping = setInterval(() => send('ping', '{}'), pingMs);
      rawRes.on('error', cleanup);
      rawRes.on('close', cleanup);
      if (req.raw.destroyed || rawRes.destroyed || rawRes.writableEnded) {
        cleanup();
        return;
      }

      relay
        .subscribeRolls((raw) => send('roll', JSON.stringify(toRollEntry(raw))), ac.signal)
        .catch((err) => {
          if (!ac.signal.aborted) app.log.warn({ err }, 'gm rolls: relay stream ended');
        })
        .finally(cleanup);
    },
  );

  app.get('/api/actors', { preHandler: auth(false) }, async (req, reply) => {
    const player = req.player as Player;
    const docs = await Promise.all(player.actorIds.map((id) => fetchActor(id)));
    const actors = docs
      .map((doc, i) => ({ doc, id: player.actorIds[i] as string }))
      .filter((e): e is { doc: FoundryActorDoc; id: string } => e.doc !== null)
      .map(({ doc, id }) => ({
        id,
        name: typeof doc.name === 'string' ? doc.name : id,
        ...(typeof doc.img === 'string' ? { img: doc.img } : {}),
        systemId: systemIdOf(doc),
      }));
    return reply.code(200).send({ actors });
  });

  app.get<{ Params: { id: string } }>(
    '/api/actors/:id/sheet',
    { preHandler: auth(false) },
    async (req, reply) => {
      const player = req.player as Player;
      const { id } = req.params;
      if (!player.actorIds.includes(id)) return sendError(reply, 404, 'NOT_FOUND', 'actor not found');
      const actor = await fetchActor(id);
      if (!actor) return sendError(reply, 404, 'NOT_FOUND', 'actor not found');
      const adapter = adapterFor(actor);
      if (!adapter) return sendError(reply, 502, 'UPSTREAM', 'no adapter for actor system');
      return reply.code(200).send({ sheet: buildSheet(adapter, actor) });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/actors/:id/movement',
    { preHandler: auth(false) },
    async (req, reply) => {
      const player = req.player as Player;
      const { id } = req.params;
      // Ownership (404, never 403 — do not leak actor existence).
      if (!player.actorIds.includes(id)) return sendError(reply, 404, 'NOT_FOUND', 'actor not found');
      const result = await fetchMovementContext(id);
      if (result === null) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
      if (result.offScene) return reply.code(200).send({ movement: { onScene: false } });
      const cc = combatMoveContext(id, result.ctx.view.speedFt ?? 0);
      return reply.code(200).send({
        movement: {
          ...result.ctx.view,
          ...budgetFields(cc),
        },
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/actors/:id/movement',
    { preHandler: auth(false) },
    async (req, reply) => {
      const player = req.player as Player;
      const { id } = req.params;
      // Ownership (404, never 403 — do not leak actor existence).
      if (!player.actorIds.includes(id)) return sendError(reply, 404, 'NOT_FOUND', 'actor not found');
      if (!limiter.allow(player.tokenHash)) return sendError(reply, 429, 'RATE_LIMITED', 'too many write intents');

      const body = req.body as { cx?: unknown; cy?: unknown } | null;
      const cx = body && typeof body === 'object' ? body.cx : undefined;
      const cy = body && typeof body === 'object' ? body.cy : undefined;
      if (!Number.isInteger(cx) || !Number.isInteger(cy)) {
        return sendError(reply, 422, 'INVALID_INTENT', 'cx and cy must be integers');
      }
      const target = { cx: cx as number, cy: cy as number };

      const result = await fetchMovementContext(id);
      if (result === null) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
      if (result.offScene) {
        // A stalled scene leg is an upstream outage (502), not "the relay
        // answered: no token on the active scene" (409) — see fetchMovementContext.
        if (result.stalled) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
        return sendError(reply, 409, 'CONFLICT', 'no token on the active scene');
      }
      const { ctx, tokens } = result;
      if (!ctx.own || !ctx.gridSize || !ctx.view.sceneId) {
        return sendError(reply, 409, 'CONFLICT', 'no token on the active scene');
      }

      // Accepted TOCTOU: the budget check here and the spend below (after
      // relay.moveToken) straddle the relay await — two overlapping POSTs
      // can both validate against the same remaining budget. Accepted:
      // soft-cap philosophy (spec 2026-07-22 §F4), table-scale traffic, and
      // the write rate limiter narrow the window; the GM sees every token
      // move. Do NOT add locking.
      const cc = combatMoveContext(id, ctx.view.speedFt ?? 0);
      if (cc.inCombat && !cc.yourTurn) return sendError(reply, 409, 'CONFLICT', 'not your turn');
      const effView = cc.inCombat ? { ...ctx.view, speedFt: cc.remainingFt } : ctx.view;

      const occupied = occupiedCells(tokens, ctx.gridSize, ctx.own._id);
      const verdict = validateMove(effView, target, occupied);
      if (!verdict.ok) return sendError(reply, verdict.status, verdict.code, verdict.message);

      const tokenUuid = `Scene.${ctx.view.sceneId}.Token.${ctx.own._id}`;
      const moved = await boundedMs(
        relay.moveToken(tokenUuid, target.cx * ctx.gridSize, target.cy * ctx.gridSize).then(() => true),
        movementTimeoutMs,
      );
      if (moved === null) return sendError(reply, 502, 'UPSTREAM', 'upstream error');

      if (cc.inCombat && cc.key !== undefined && ctx.view.token) {
        movementBudget.addMove(cc.key, chebyshev(ctx.view.token, target) * (ctx.view.gridDistance ?? 5));
      }

      // Confirmed view: same context with the token at its new cell (no refetch —
      // the relay echoed the destination; a fresh GET runs on the next sheet open).
      const fresh = combatMoveContext(id, ctx.view.speedFt ?? 0);
      return reply.code(200).send({
        movement: {
          ...ctx.view,
          token: target,
          ...budgetFields(fresh),
        },
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/actors/:id/movement/dash',
    { preHandler: auth(false) },
    async (req, reply) => {
      const player = req.player as Player;
      const { id } = req.params;
      if (!player.actorIds.includes(id)) return sendError(reply, 404, 'NOT_FOUND', 'actor not found');
      if (!limiter.allow(player.tokenHash)) return sendError(reply, 429, 'RATE_LIMITED', 'too many write intents');
      const result = await fetchMovementContext(id);
      if (result === null) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
      if (result.offScene) return sendError(reply, 409, 'CONFLICT', 'no token on the active scene');
      const speedFt = result.ctx.view.speedFt ?? 0;
      const cc = combatMoveContext(id, speedFt);
      if (!cc.inCombat) return sendError(reply, 409, 'CONFLICT', 'not in combat');
      if (!cc.yourTurn) return sendError(reply, 409, 'CONFLICT', 'not your turn');
      if (cc.key === undefined || !movementBudget.markDashed(cc.key)) {
        return sendError(reply, 409, 'CONFLICT', 'already dashed this turn');
      }
      // Best-effort GM visibility — a failed note never fails the dash. The
      // `.catch` is required, not decorative: without it a rejecting
      // postChatNote rejects the raced promise, and since the result is
      // never awaited (fire-and-forget), that becomes an unhandled promise
      // rejection that can crash the process.
      const name = typeof result.ctx.own?.name === 'string' ? result.ctx.own.name : 'A player';
      void boundedMs(relay.postChatNote(`Actor.${id}`, `${name} dashes!`).then(() => true), movementTimeoutMs).catch(
        (err) => req.log.warn({ err }, 'dash: chat note failed; continuing'),
      );
      const fresh = combatMoveContext(id, speedFt);
      return reply.code(200).send({
        movement: {
          ...result.ctx.view,
          ...budgetFields(fresh),
        },
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/actors/:id/intents',
    { preHandler: auth(false) },
    async (req, reply) => {
      const player = req.player as Player;

      if (!limiter.allow(player.tokenHash)) {
        return sendError(reply, 429, 'RATE_LIMITED', 'too many write intents');
      }

      // 1. Ownership (404, never 403 — do not leak actor existence).
      const { id } = req.params;
      if (!player.actorIds.includes(id)) return sendError(reply, 404, 'NOT_FOUND', 'actor not found');
      const actor = await fetchActor(id);
      if (!actor) return sendError(reply, 404, 'NOT_FOUND', 'actor not found');
      const adapter = adapterFor(actor);
      if (!adapter) return sendError(reply, 502, 'UPSTREAM', 'no adapter for actor system');

      const body = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return sendError(reply, 422, 'INVALID_INTENT', 'intent body must be an object');
      }
      const raw = body as Record<string, unknown>;
      if (typeof raw.resourceId !== 'string' || raw.resourceId === '') {
        return sendError(reply, 422, 'INVALID_INTENT', 'resourceId is required');
      }

      // 2. Resource must exist and be writable.
      const descriptor = adapter.resources(actor).find((r) => r.id === raw.resourceId);
      if (!descriptor || !descriptor.writable) {
        return sendError(reply, 403, 'FORBIDDEN_RESOURCE', 'resource does not exist or is not writable');
      }

      // 3. Payload must validate.
      const intent = parseIntent(raw, raw.resourceId);
      if (!intent) return sendError(reply, 422, 'INVALID_INTENT', 'invalid intent payload');

      // 4. Optimistic lock.
      if (intent.expected !== undefined && intent.expected !== descriptor.value) {
        return reply.code(409).send({
          error: { code: 'CONFLICT', message: 'expected value is stale' },
          sheet: buildSheet(adapter, actor),
        });
      }

      // 5. Clamp via adapter, write via relay, return fresh sheet.
      let update: FoundryUpdate;
      try {
        update = adapter.buildUpdate(actor, intent);
      } catch (err) {
        if (err instanceof IntentError) {
          switch (err.code) {
            case 'UNKNOWN_RESOURCE':
            case 'READ_ONLY':
              return sendError(reply, 403, 'FORBIDDEN_RESOURCE', err.message);
            case 'INVALID':
              return sendError(reply, 422, 'INVALID_INTENT', err.message);
            case 'CONFLICT':
              return reply.code(409).send({
                error: { code: 'CONFLICT', message: err.message },
                sheet: buildSheet(adapter, actor),
              });
          }
        }
        throw err;
      }

      const targetUuid =
        update.itemId !== undefined ? `Actor.${id}.Item.${update.itemId}` : `Actor.${id}`;
      await relay.updateEntity(targetUuid, update.data);

      const fresh = await fetchActor(id);
      if (!fresh) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
      const freshAdapter = adapterFor(fresh) ?? adapter;
      return reply.code(200).send({ sheet: buildSheet(freshAdapter, fresh) });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/actors/:id/actions',
    { preHandler: auth(false) },
    async (req, reply) => {
      const player = req.player as Player;

      // Shares the write rate limit (and limiter instance) with intents.
      if (!limiter.allow(player.tokenHash)) {
        return sendError(reply, 429, 'RATE_LIMITED', 'too many write intents');
      }

      // 1. Ownership (404, never 403 — do not leak actor existence).
      const { id } = req.params;
      if (!player.actorIds.includes(id)) return sendError(reply, 404, 'NOT_FOUND', 'actor not found');
      const actor = await fetchActor(id);
      if (!actor) return sendError(reply, 404, 'NOT_FOUND', 'actor not found');
      const adapter = adapterFor(actor);
      if (!adapter) return sendError(reply, 502, 'UPSTREAM', 'no adapter for actor system');

      const body = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return sendError(reply, 422, 'INVALID_INTENT', 'action body must be an object');
      }
      const raw = body as Record<string, unknown>;
      if (typeof raw.actionId !== 'string' || raw.actionId === '') {
        return sendError(reply, 422, 'INVALID_INTENT', 'actionId is required');
      }

      // 2. Allow-list: the adapter's action list is the whole legal surface.
      // An adapter without action support means every action is forbidden.
      const descriptor =
        adapter.actions && adapter.buildAction
          ? adapter.actions(actor).find((a) => a.id === raw.actionId)
          : undefined;
      if (!descriptor || descriptor.kind !== raw.kind) {
        return sendError(reply, 403, 'FORBIDDEN_RESOURCE', 'action does not exist or kind does not match');
      }

      // 3. Payload must validate.
      const intent = parseActionIntent(raw, raw.actionId, descriptor.kind);
      if (!intent) return sendError(reply, 422, 'INVALID_INTENT', 'invalid action payload');

      // 4. Adapter translates the intent into a relay call.
      let action: RelayAction;
      try {
        action = (adapter.buildAction as NonNullable<SystemAdapter['buildAction']>)(actor, intent);
      } catch (err) {
        if (err instanceof IntentError) {
          switch (err.code) {
            case 'UNKNOWN_RESOURCE':
            case 'READ_ONLY':
              return sendError(reply, 403, 'FORBIDDEN_RESOURCE', err.message);
            case 'INVALID':
              return sendError(reply, 422, 'INVALID_INTENT', err.message);
            case 'CONFLICT':
              return reply.code(409).send({
                error: { code: 'CONFLICT', message: err.message },
                sheet: buildSheet(adapter, actor),
              });
          }
        }
        throw err;
      }

      // 5. Execute via the relay (Foundry rolls, posts cards, consumes
      // slots/uses itself). Relay failures throw -> 502 via setErrorHandler.
      let result: ActionRollResult | null = null;
      let outcome: unknown = null;
      switch (action.endpoint) {
        case 'roll':
          result = extractRoll(await relay.rollFormula(`Actor.${id}`, action.formula, action.flavor));
          break;
        case 'use-item':
        case 'use-spell':
        case 'use-feature':
          try {
            result = extractRoll(
              await activateAbility(
                relay,
                action.endpoint,
                `Actor.${id}`,
                `Actor.${id}.Item.${action.itemId}`,
                action.slotLevel !== undefined ? { slotLevel: action.slotLevel } : {},
                action.noTemplate,
                req.log,
              ),
            );
          } catch (err) {
            // A relay 408 here means the cast/use DID execute in Foundry —
            // just like use-and-roll below, only the response was slow.
            // Surfacing this as a 502 would show "the table didn't respond"
            // for a cast that already happened, inviting a double-cast
            // retry. There's no roll pill to show, but the fresh-sheet fetch
            // below still reflects the new state.
            if (isRelayTimeout(err)) {
              req.log.warn({ err }, 'use-ability: activation timed out on Foundry UI; returning the fresh sheet');
              result = null;
            } else {
              throw err;
            }
          }
          break;
        case 'cast-at-slot':
          try {
            result = extractRoll(
              await relay.castAtSlot(`Actor.${id}`, `Actor.${id}.Item.${action.itemId}`, action.slotKey),
            );
          } catch (err) {
            // 408-tolerate first (mirrors use-and-roll's ordering below) so a
            // timeout is never mistaken for the execute-js-disabled config
            // problem that upcastUnavailable maps to a 422.
            if (isRelayTimeout(err)) {
              req.log.warn({ err }, 'cast-at-slot: activation timed out on Foundry UI; returning the fresh sheet');
              result = null;
            } else {
              const mapped = upcastUnavailable(err);
              if (mapped) return sendError(reply, 422, 'INVALID_INTENT', mapped);
              throw err;
            }
          }
          break;
        case 'equip-item':
          await relay.equipItem(`Actor.${id}`, `Actor.${id}.Item.${action.itemId}`, action.equipped);
          break;
        case 'attune-item':
          await relay.attuneItem(`Actor.${id}`, `Actor.${id}.Item.${action.itemId}`, action.attuned);
          break;
        case 'update-item':
          // Generic item-field write (e.g. prepared state) — same entity-update
          // path as quantity/uses; no chat card, no roll.
          await relay.updateEntity(`Actor.${id}.Item.${action.itemId}`, action.data);
          break;
        case 'use-and-roll': {
          // M15/M16: the relay only auto-executes attack-type activities — a
          // heal/save/utility use posts an inert card. So the activation
          // goes through Foundry FIRST (it consumes slots/uses/quantity and
          // auto-destroys per its own rules — never re-implemented here),
          // then the adapter-computed display roll fires, then the optional
          // self-heal write. All field paths are adapter-supplied so this
          // stays system-agnostic.
          try {
            if (action.use === 'cast-at-slot') {
              await relay.castAtSlot(`Actor.${id}`, `Actor.${id}.Item.${action.itemId}`, action.slotKey as string);
            } else {
              await activateAbility(relay, action.use, `Actor.${id}`, `Actor.${id}.Item.${action.itemId}`, {}, action.noTemplate, req.log);
            }
          } catch (err) {
            // A relay 408 means Foundry's usage workflow is waiting on
            // optional UI (live-verified 2026-07-10: Bead of Force's
            // area-template prompt) — consumption has already completed by
            // then, so the display roll must still fire. Checked FIRST so a
            // timeout is never mistaken for a config problem. Anything else
            // (unknown item, permissions) stays fatal.
            if (isRelayTimeout(err)) {
              req.log.warn({ err }, 'use-and-roll: activation timed out on Foundry UI; continuing with the roll');
            } else {
              const mapped = action.use === 'cast-at-slot' ? upcastUnavailable(err) : null;
              if (mapped) return sendError(reply, 422, 'INVALID_INTENT', mapped);
              throw err;
            }
          }
          const rolled = extractRoll(await relay.rollFormula(`Actor.${id}`, action.formula, action.flavor));
          result = rolled;
          if (rolled !== null && action.heal) {
            // Floor at current: a heal total should never be negative in
            // practice (the adapter only builds this for heal formulas), but
            // an unusual negative bonus resolving a formula like "1d4 - 2"
            // must not let this endpoint reduce HP.
            const newValue = Math.min(action.heal.max, action.heal.current + Math.max(0, rolled.total));
            await relay.updateEntity(`Actor.${id}`, { [action.heal.path]: newValue });
          }
          break;
        }
        case 'cast-and-apply-effect': {
          // Buff spell (dnd5e): activate the spell (consumes the slot/use —
          // Foundry's job, same reasoning as use-and-roll above) THEN create
          // the effect via the relay's embedded-upsert, since the headless
          // use-flow never applies self-effects (see EffectPayload comment).
          // The target permission gate is checked BEFORE activation: it's
          // pure over action/id/deps (no dependency on the activation
          // result), so a forbidden target must never burn the caster's slot.
          const targetId = action.targetActorId ?? id;
          if (!buffTargetAllowed(targetId, id, deps)) {
            return sendError(reply, 403, 'FORBIDDEN_RESOURCE', 'cannot target that actor');
          }
          try {
            if (action.use === 'cast-at-slot') {
              await relay.castAtSlot(`Actor.${id}`, `Actor.${id}.Item.${action.itemId}`, action.slotKey as string);
            } else {
              await activateAbility(relay, 'use-spell', `Actor.${id}`, `Actor.${id}.Item.${action.itemId}`, {}, action.noTemplate, req.log);
            }
          } catch (err) {
            if (isRelayTimeout(err)) {
              req.log.warn({ err }, 'cast-and-apply-effect: activation timed out; applying the effect anyway');
            } else {
              const mapped = action.use === 'cast-at-slot' ? upcastUnavailable(err) : null;
              if (mapped) return sendError(reply, 422, 'INVALID_INTENT', mapped);
              throw err;
            }
          }
          await relay.applyEffect(`Actor.${targetId}`, {
            _id: mintEffectId(),
            ...action.effect,
            flags: { 'unseen-servent': { appliedBy: 'app' } },
          });
          break;
        }
        case 'remove-effect': {
          // Delete the app-applied Active Effect off the actor (buff badge's
          // remove action) — the existing embedded-item delete path.
          const ok = await relay.deleteEntity(`Actor.${id}.ActiveEffect.${action.effectId}`);
          // 'UPSTREAM' (not a bespoke 'RELAY_ERROR') to match the ErrorCode
          // union and the sibling library-remove route's 502 below.
          if (!ok) return sendError(reply, 502, 'UPSTREAM', 'Failed to remove the effect.');
          break;
        }
        case 'short-rest':
        case 'long-rest':
        case 'death-save':
        case 'break-concentration':
          // death-save returns a roll under `data`; the rest post their own
          // card and carry no roll total -> extractRoll yields null.
          result = extractRoll(await relay.actorCommand(action.endpoint, `Actor.${id}`));
          break;
        case 'use-on-targets': {
          // Targets are only meaningful during a live encounter; the visible
          // roster is the whole legal target surface (hidden combatants never
          // reach the view, so they are untargetable by construction —
          // Global Constraints).
          const mgr = deps.encounters;
          if (!mgr || !mgr.isActive()) return sendError(reply, 409, 'CONFLICT', 'no active encounter');
          const roster = new Set(
            (mgr.view().combatants ?? []).map((c) => c.tokenUuid).filter((t): t is string => typeof t === 'string'),
          );
          for (const t of action.targetTokenUuids) {
            if (!roster.has(t)) return sendError(reply, 403, 'FORBIDDEN_RESOURCE', 'target is not in the encounter');
          }
          try {
            const res = await relay.useAbilityOnTargets(`Actor.${id}`, `Actor.${id}.Item.${action.itemId}`, {
              targetTokenUuids: action.targetTokenUuids,
              ...(action.slotKey !== undefined ? { slotKey: action.slotKey } : {}),
              ...(action.mode !== undefined ? { mode: action.mode } : {}),
              ...(action.attackMode !== undefined ? { attackMode: action.attackMode } : {}),
            });
            outcome = res;
            result = res.attack !== null ? extractRoll(res.attack) : null;
          } catch (err) {
            // SIDE-EFFECTING — never retried. A relay 408 means the
            // orchestration may have already applied damage in Foundry;
            // retrying could double it.
            if (isRelayTimeout(err)) {
              return sendError(reply, 502, 'UPSTREAM', 'Timed out — check the Foundry chat before retrying.');
            }
            throw err;
          }
          break;
        }
      }

      const fresh = await fetchActor(id);
      if (!fresh) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
      const freshAdapter = adapterFor(fresh) ?? adapter;
      return reply
        .code(200)
        .send({ result, ...(outcome !== null ? { outcome } : {}), sheet: buildSheet(freshAdapter, fresh) });
    },
  );

  // ---- manual dice tray (fallback for anything without a dedicated button) --
  // Rolls a simple dice pool as the actor. Whitelisted to NdM terms + integer
  // modifiers (isSafeDiceFormula) so this stays a dice tray, not a Foundry
  // formula console. No sheet echo — a bare roll changes nothing on the actor.
  app.post<{ Params: { id: string } }>(
    '/api/actors/:id/roll',
    { preHandler: auth(false) },
    async (req, reply) => {
      const player = req.player as Player;
      if (!limiter.allow(player.tokenHash)) {
        return sendError(reply, 429, 'RATE_LIMITED', 'too many rolls');
      }
      const { id } = req.params;
      if (!player.actorIds.includes(id)) return sendError(reply, 404, 'NOT_FOUND', 'actor not found');
      const body = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return sendError(reply, 422, 'INVALID_INTENT', 'roll body must be an object');
      }
      const raw = body as Record<string, unknown>;
      const formula = typeof raw.formula === 'string' ? raw.formula.trim() : '';
      if (!isSafeDiceFormula(formula)) {
        return sendError(reply, 422, 'INVALID_INTENT', 'formula must be a simple dice pool, e.g. "2d6 + 1d8 + 3"');
      }
      const flavor =
        typeof raw.flavor === 'string' && raw.flavor.trim() !== '' ? raw.flavor.trim().slice(0, 60) : 'Dice roll';
      const result = extractRoll(await relay.rollFormula(`Actor.${id}`, formula, flavor));
      return reply.code(200).send({ result });
    },
  );

  // ---- custom items (M23): create -> give -> best-effort delete chain ------
  // No embedded-create endpoint exists on the relay (Task 0 findings §5), so
  // a player-authored weapon/gear is created as a scratch WORLD item, given
  // to the actor (which copies it in with system data intact), then the
  // scratch world item is best-effort deleted. 404 when the actor's adapter
  // doesn't declare buildCustomItem (mirrors the library-collection 404).

  app.post<{ Params: { id: string } }>(
    '/api/actors/:id/items',
    { preHandler: auth(false) },
    async (req, reply) => {
      const player = req.player as Player;

      // Shares the write rate limit with intents/actions.
      if (!limiter.allow(player.tokenHash)) {
        return sendError(reply, 429, 'RATE_LIMITED', 'too many write intents');
      }

      // 1. Ownership (404, never 403 — do not leak actor existence).
      const { id } = req.params;
      if (!player.actorIds.includes(id)) return sendError(reply, 404, 'NOT_FOUND', 'actor not found');
      const actor = await fetchActor(id);
      if (!actor) return sendError(reply, 404, 'NOT_FOUND', 'actor not found');
      const adapter = adapterFor(actor);
      if (!adapter?.buildCustomItem) return sendError(reply, 404, 'NOT_FOUND', 'not found');

      const body = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return sendError(reply, 422, 'INVALID_INTENT', 'item body must be an object');
      }

      // 2. The adapter builds AND validates the world-item payload — the
      // raw client body is passed straight through un-sanitized; the
      // adapter's whitelist is the only thing that reaches the relay.
      let payload: Record<string, unknown>;
      try {
        payload = adapter.buildCustomItem(actor, body as unknown as CustomItemInput);
      } catch (err) {
        if (err instanceof IntentError && err.code === 'INVALID') {
          return sendError(reply, 422, 'INVALID_INTENT', err.message);
        }
        throw err;
      }

      // 3. Bounded create -> give -> best-effort delete chain (M18 pattern:
      // every relay await races a timeout so a stalled relay can't hang the
      // request; a miss degrades exactly like an explicit failure).
      const worldItemUuid = await Promise.race([
        relay.createWorldItem(payload),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), customItemTimeoutMs)),
      ]);
      if (!worldItemUuid) return sendError(reply, 502, 'UPSTREAM', 'upstream error');

      const gave = await Promise.race([
        relay.giveItem(`Actor.${id}`, worldItemUuid),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), customItemTimeoutMs)),
      ]);

      // Best-effort cleanup regardless of give's outcome (Task 0 findings
      // §5: a failed delete just leaves a harmless world item behind) —
      // deleteEntity itself never throws (foundry-client swallows + logs);
      // its boolean result is intentionally ignored here.
      await Promise.race([
        relay.deleteEntity(worldItemUuid),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), customItemTimeoutMs)),
      ]);

      if (!gave) return sendError(reply, 502, 'UPSTREAM', 'upstream error');

      const fresh = await fetchActor(id);
      if (!fresh) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
      const freshAdapter = adapterFor(fresh) ?? adapter;
      return reply.code(200).send({ sheet: buildSheet(freshAdapter, fresh) });
    },
  );

  // ---- library (search / preview / add / remove) ----------------------------
  // A collection-parameterized capability (M13): spells, feats, gear share one
  // search -> preview -> add / remove flow. Available only when the actor's
  // adapter declares `library`; a missing library OR an unknown :collection id
  // 404s so the routes never leak which systems/collections support it.

  /** Ownership + adapter + collection preamble shared by the library routes.
   *  Resolves the :collection id against adapter.library. Sends the error
   *  response and returns null when any check fails. */
  const libraryCtx = async (
    req: FastifyRequest,
    reply: FastifyReply,
    id: string,
    collectionId: string,
  ): Promise<{
    actor: FoundryActorDoc;
    adapter: SystemAdapter;
    collection: NonNullable<SystemAdapter['library']>[number];
  } | null> => {
    const player = req.player as Player;
    if (!player.actorIds.includes(id)) {
      sendError(reply, 404, 'NOT_FOUND', 'actor not found');
      return null;
    }
    const actor = await fetchActor(id);
    if (!actor) {
      sendError(reply, 404, 'NOT_FOUND', 'actor not found');
      return null;
    }
    const adapter = adapterFor(actor);
    if (!adapter) {
      sendError(reply, 502, 'UPSTREAM', 'no adapter for actor system');
      return null;
    }
    const collection = adapter.library?.find((c) => c.id === collectionId);
    if (!collection) {
      sendError(reply, 404, 'NOT_FOUND', 'not found');
      return null;
    }
    return { actor, adapter, collection };
  };

  app.get<{ Params: { id: string; collection: string }; Querystring: { q?: string } }>(
    '/api/actors/:id/library/:collection/search',
    { preHandler: auth(false) },
    async (req, reply) => {
      const ctx = await libraryCtx(req, reply, req.params.id, req.params.collection);
      if (!ctx) return reply;
      const q = (req.query.q ?? '').trim();
      if (q === '') return reply.code(200).send({ results: [] });
      const entries = await relay.search({ query: q, filter: ctx.collection.searchFilter, limit: 20 });
      // A single relay `subType` filter cannot express the OR of physical-item
      // subtypes, so the broad `documentType:Item` gear filter also returns
      // spells and feats. Drop any hit the collection would reject on add so
      // search never surfaces a non-member that would 422 on preview/add.
      // Relay SEARCH entries carry the item type as `subType` (full documents
      // carry `type` — M13-live-verified), so synthesize `type` for canAdd.
      // Entries with neither (rare minified/limited hits) already matched the
      // server-side filter and pass through.
      const results = entries
        .filter((e) => {
          const t = typeof e.subType === 'string' ? e.subType : typeof e.type === 'string' ? e.type : undefined;
          return t === undefined ? true : ctx.collection.canAdd({ ...e, type: t });
        })
        .map((e) => ({
          uuid: e.uuid,
          name: e.name,
          ...(typeof e.img === 'string' ? { img: e.img } : {}),
          ...(typeof e.packageName === 'string' ? { pack: e.packageName } : {}),
        }));
      return reply.code(200).send({ results });
    },
  );

  app.get<{ Params: { id: string; collection: string }; Querystring: { uuid?: string } }>(
    '/api/actors/:id/library/:collection/preview',
    { preHandler: auth(false) },
    async (req, reply) => {
      const ctx = await libraryCtx(req, reply, req.params.id, req.params.collection);
      if (!ctx) return reply;
      const uuid = req.query.uuid ?? '';
      if (uuid === '') return sendError(reply, 422, 'INVALID_INTENT', 'uuid is required');
      const doc = await relay.getEntity(uuid);
      if (!doc) return sendError(reply, 404, 'NOT_FOUND', 'entry not found');
      if (!ctx.collection.canAdd(doc)) {
        return sendError(reply, 422, 'INVALID_INTENT', 'entry cannot be added to this collection');
      }
      return reply.code(200).send({ preview: ctx.collection.describe(doc) });
    },
  );

  app.post<{ Params: { id: string; collection: string } }>(
    '/api/actors/:id/library/:collection/add',
    { preHandler: auth(false) },
    async (req, reply) => {
      const player = req.player as Player;
      if (!limiter.allow(player.tokenHash)) {
        return sendError(reply, 429, 'RATE_LIMITED', 'too many write intents');
      }
      const ctx = await libraryCtx(req, reply, req.params.id, req.params.collection);
      if (!ctx) return reply;
      const raw = (req.body ?? {}) as Record<string, unknown>;
      if (typeof raw.uuid !== 'string' || raw.uuid === '') {
        return sendError(reply, 422, 'INVALID_INTENT', 'uuid is required');
      }
      const doc = await relay.getEntity(raw.uuid);
      if (!doc) return sendError(reply, 404, 'NOT_FOUND', 'entry not found');
      if (!ctx.collection.canAdd(doc)) {
        return sendError(reply, 422, 'INVALID_INTENT', 'entry cannot be added to this collection');
      }
      const gave = await relay.giveItem(`Actor.${req.params.id}`, raw.uuid);
      if (!gave) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
      const fresh = await fetchActor(req.params.id);
      if (!fresh) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
      const freshAdapter = adapterFor(fresh) ?? ctx.adapter;
      return reply.code(200).send({ sheet: buildSheet(freshAdapter, fresh) });
    },
  );

  app.delete<{ Params: { id: string; collection: string; itemId: string } }>(
    '/api/actors/:id/library/:collection/:itemId',
    { preHandler: auth(false) },
    async (req, reply) => {
      const player = req.player as Player;
      if (!limiter.allow(player.tokenHash)) {
        return sendError(reply, 429, 'RATE_LIMITED', 'too many write intents');
      }
      const ctx = await libraryCtx(req, reply, req.params.id, req.params.collection);
      if (!ctx) return reply;
      const item = (ctx.actor.items ?? []).find((i) => i._id === req.params.itemId);
      if (!item || !ctx.collection.canRemove(item)) {
        return sendError(reply, 403, 'FORBIDDEN_RESOURCE', 'item does not exist or cannot be removed');
      }
      const deleted = await relay.deleteEntity(`Actor.${req.params.id}.Item.${req.params.itemId}`);
      if (!deleted) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
      const fresh = await fetchActor(req.params.id);
      if (!fresh) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
      const freshAdapter = adapterFor(fresh) ?? ctx.adapter;
      return reply.code(200).send({ sheet: buildSheet(freshAdapter, fresh) });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/api/actors/:id/events',
    { preHandler: auth(true) },
    async (req, reply) => {
      const player = req.player as Player;
      const { id } = req.params;
      if (!player.actorIds.includes(id)) return sendError(reply, 404, 'NOT_FOUND', 'actor not found');

      const actor = await fetchActor(id);
      if (!actor) return sendError(reply, 404, 'NOT_FOUND', 'actor not found');
      const adapter = adapterFor(actor);
      if (!adapter) return sendError(reply, 502, 'UPSTREAM', 'no adapter for actor system');
      const initialJson = JSON.stringify(buildSheet(adapter, actor));

      reply.hijack();
      const rawRes = reply.raw;
      rawRes.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      const writeEvent = (name: string, data: string): void => {
        try {
          rawRes.write(`event: ${name}\ndata: ${data}\n\n`);
        } catch {
          /* client is gone; cleanup runs on close */
        }
      };

      writeEvent('sheet', initialJson);
      const detach = live.attach(id, (json) => writeEvent('sheet', json), initialJson);
      const ping = setInterval(() => writeEvent('ping', '{}'), pingMs);

      let done = false;
      const cleanup = (): void => {
        if (done) return;
        done = true;
        clearInterval(ping);
        detach();
        sseCleanups.delete(cleanup);
        try {
          rawRes.end();
        } catch {
          /* already closed */
        }
      };
      sseCleanups.add(cleanup);
      req.raw.on('close', cleanup);
      rawRes.on('close', cleanup);
      // A write on an already-destroyed socket emits an async 'error' event
      // that try/catch around write() cannot catch — swallow it and clean up.
      rawRes.on('error', cleanup);
      // The client may have disconnected while we awaited the initial actor
      // fetch above; in that case 'close' fired before the listeners existed
      // and would never run cleanup — the watcher and ping would leak.
      if (req.raw.destroyed || rawRes.destroyed || rawRes.writableEnded) cleanup();
    },
  );

  // ---- encounters (M22): live combat mirror + player-applied hp writes -----
  // Only registered when a manager is wired (server.ts in production); tests
  // inject a real EncounterManager over FakeRelay. Absent -> 404 (feature
  // requires wiring), via the standard setNotFoundHandler envelope above.

  const encounterManager = deps.encounters;
  if (encounterManager) {
    app.get('/api/encounter', { preHandler: auth(false) }, async (_req, reply) => {
      return reply.code(200).send(encounterManager.view());
    });

    app.get<{ Querystring: { token?: string } }>(
      '/api/encounter/events',
      { preHandler: auth(true) },
      async (req, reply) => {
        reply.hijack();
        const rawRes = reply.raw;
        rawRes.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });

        const writeEvent = (name: string, data: string): void => {
          try {
            rawRes.write(`event: ${name}\ndata: ${data}\n\n`);
          } catch {
            /* client is gone; cleanup runs on close */
          }
        };

        writeEvent('encounter', JSON.stringify(encounterManager.view()));
        const detach = encounterManager.attach((view) => writeEvent('encounter', JSON.stringify(view)));
        // A fresh connection re-reads authoritative REST state so a reload
        // reflects truth immediately (2026-07-23): if the mirror missed a
        // combat start/end hook, this reseed corrects it and the attached
        // listener above receives the corrected frame.
        encounterManager.reconcileNow();
        // Keep-alive doubles as a level-triggered state re-emit: the relay's
        // known SSE-drop-under-burst bug can lose a terminal {active:false}
        // frame, leaving a client stuck (no further change frame ever arrives
        // for an ended combat). Re-asserting current state every pingMs lets
        // any missed frame self-heal; the web applies frames idempotently.
        const ping = setInterval(
          () => writeEvent('encounter', JSON.stringify(encounterManager.view())),
          pingMs,
        );

        let done = false;
        const cleanup = (): void => {
          if (done) return;
          done = true;
          clearInterval(ping);
          detach();
          sseCleanups.delete(cleanup);
          try {
            rawRes.end();
          } catch {
            /* already closed */
          }
        };
        sseCleanups.add(cleanup);
        req.raw.on('close', cleanup);
        rawRes.on('close', cleanup);
        // A write on an already-destroyed socket emits an async 'error' event
        // that try/catch around write() cannot catch — swallow it and clean up.
        rawRes.on('error', cleanup);
        // The client may have disconnected while we awaited above; in that
        // case 'close' fired before the listeners existed and would never
        // run cleanup — the ping would leak.
        if (req.raw.destroyed || rawRes.destroyed || rawRes.writableEnded) cleanup();
      },
    );

    app.post<{ Params: { id: string } }>(
      '/api/encounter/combatants/:id/hp',
      { preHandler: auth(false) },
      async (req, reply) => {
        const player = req.player as Player;
        if (!limiter.allow(player.tokenHash)) {
          return sendError(reply, 429, 'RATE_LIMITED', 'too many write intents');
        }

        // Order matters: no active encounter is a blanket 409 regardless of
        // whether :id even names a real combatant (M22 plan).
        const target = encounterManager.combatant(req.params.id);
        if (!encounterManager.isActive()) return sendError(reply, 409, 'CONFLICT', 'no active encounter');
        if (!target) return sendError(reply, 404, 'NOT_FOUND', 'not found');
        if (!target.actorId) return sendError(reply, 422, 'INVALID_INTENT', 'combatant has no linked actor');
        const actorId = target.actorId;

        const body = req.body;
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return sendError(reply, 422, 'INVALID_INTENT', 'body must be an object');
        }
        const raw = body as Record<string, unknown>;
        if (
          raw.kind !== 'delta' ||
          typeof raw.amount !== 'number' ||
          !Number.isFinite(raw.amount) ||
          raw.amount === 0
        ) {
          return sendError(reply, 422, 'INVALID_INTENT', 'invalid hp intent');
        }

        // Bounded (M18 pattern): a stalled relay must not hang the route —
        // timeout degrades to the same 502 envelope a missing actor gets.
        const actor = await Promise.race([
          fetchActor(actorId),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), encounterFetchTimeoutMs)),
        ]);
        if (!actor) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
        const adapter = adapterFor(actor);
        if (!adapter) return sendError(reply, 502, 'UPSTREAM', 'no adapter for actor system');

        // Never hand-roll hp math here — buildUpdate owns clamping and the
        // M20 temp-HP-absorbs-first rule for damage.
        let update: FoundryUpdate;
        try {
          update = adapter.buildUpdate(actor, { kind: 'delta', resourceId: 'hp', amount: raw.amount });
        } catch (err) {
          if (err instanceof IntentError) {
            switch (err.code) {
              case 'UNKNOWN_RESOURCE':
              case 'READ_ONLY':
                return sendError(reply, 403, 'FORBIDDEN_RESOURCE', err.message);
              case 'INVALID':
                return sendError(reply, 422, 'INVALID_INTENT', err.message);
              case 'CONFLICT':
                return sendError(reply, 409, 'CONFLICT', err.message);
            }
          }
          throw err;
        }

        const targetUuid =
          update.itemId !== undefined ? `Actor.${actorId}.Item.${update.itemId}` : `Actor.${actorId}`;
        await relay.updateEntity(targetUuid, update.data);
        await encounterManager.refreshActor(actorId);
        return reply.code(200).send({ encounter: encounterManager.view() });
      },
    );

    app.post('/api/encounter/turn/end', { preHandler: auth(false) }, async (req, reply) => {
      const player = req.player as Player;
      if (!limiter.allow(player.tokenHash)) {
        return sendError(reply, 429, 'RATE_LIMITED', 'too many write intents');
      }
      const cur = encounterManager.current();
      if (!cur) return sendError(reply, 409, 'CONFLICT', 'no active encounter');
      // Only the acting combatant's owner may advance — GM keeps NPC turns in Foundry.
      if (cur.actorId === undefined || !player.actorIds.includes(cur.actorId)) {
        return sendError(reply, 403, 'FORBIDDEN_RESOURCE', 'not your turn');
      }
      const res = await boundedMs(relay.endCombatTurn(cur.combatantId), turnEndTimeoutMs);
      if (res === null) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
      if (!res.advanced) return sendError(reply, 409, 'CONFLICT', 'turn already advanced');
      return reply.code(200).send({ ok: true });
    });
  }

  return app;
}
