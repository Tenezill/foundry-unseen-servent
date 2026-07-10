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
import type { RawRoll } from '@companion/foundry-client';
import { verifyToken, type Player } from './players.js';
import { LiveManager } from './live.js';
import type { AdapterRegistry } from './registry.js';

/** Live view of the player list; backed by FilePlayerStore in production. */
export interface PlayersPort {
  list(): readonly Player[];
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
  /** POST /dnd5e/equip-item — toggle an item's equipped state (M6). */
  equipItem(actorUuid: string, itemUuid: string, equipped: boolean): Promise<void>;
  /** POST /dnd5e/attune-item — set an item's attuned state (M12). */
  attuneItem(actorUuid: string, itemUuid: string, attuned: boolean): Promise<void>;
  /** GET /search — find entities; compendia are included by default. */
  search(opts: { query?: string; filter?: string; limit?: number }): Promise<
    Array<{ uuid: string; id: string; name: string; img?: string; documentType: string; [key: string]: unknown }>
  >;
  /** POST /give — copy an item (compendium uuid ok) onto a target actor. */
  giveItem(toUuid: string, itemUuid: string): Promise<void>;
  /** DELETE /delete — delete an entity (embedded item uuid ok). */
  deleteEntity(uuid: string): Promise<void>;
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
}

export interface GatewayDeps {
  relay: RelayPort;
  players: PlayersPort;
  registry: AdapterRegistry;
  /** Adapter used when the relay doc carries no system id. Default "dnd5e". */
  defaultSystemId?: string;
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
    case 'attack':
    case 'use':
    case 'damage':
      return { kind, actionId };
    case 'cast':
      if (
        body.slotLevel !== undefined &&
        (typeof body.slotLevel !== 'number' || !Number.isInteger(body.slotLevel) || body.slotLevel < 0)
      ) {
        return null;
      }
      return body.slotLevel === undefined
        ? { kind, actionId }
        : { kind, actionId, slotLevel: body.slotLevel };
    case 'equip':
      if (typeof body.equipped !== 'boolean') return null;
      return { kind, actionId, equipped: body.equipped };
    case 'prepare':
      if (typeof body.prepared !== 'boolean') return null;
      return { kind, actionId, prepared: body.prepared };
    case 'attune':
      if (typeof body.attuned !== 'boolean') return null;
      return { kind, actionId, attuned: body.attuned };
    case 'rest':
    case 'deathsave':
    case 'endconcentration':
      // Actor-scoped commands carry only {kind, actionId} — no extra fields.
      return { kind, actionId };
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

export function buildApp(deps: GatewayDeps): FastifyInstance {
  const defaultSystemId = deps.defaultSystemId ?? 'dnd5e';
  const pingMs = deps.pingMs ?? 25_000;
  const livePollMs = deps.livePollMs ?? 3_000;
  const limiter = new SlidingWindowLimiter(deps.rateLimitMax ?? 30, deps.rateLimitWindowMs ?? 60_000);
  const { relay, players, registry } = deps;

  const app = Fastify({ logger: deps.logger ?? false });

  // ---- helpers ------------------------------------------------------------

  const systemIdOf = (doc: Record<string, unknown>): string =>
    typeof doc.systemId === 'string' && doc.systemId !== '' ? doc.systemId : defaultSystemId;

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
        });
      } catch (err) {
        app.log.warn({ err, actorId }, 'adapter enrich failed; serving unenriched document');
      }
    }
    return actor;
  };

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
    let relayState: 'connected' | 'disconnected' = 'connected';
    try {
      await relay.listClients();
    } catch (err) {
      app.log.warn({ err }, 'relay health check failed');
      relayState = 'disconnected';
    }
    return reply.code(200).send({ ok: true, relay: relayState });
  });

  app.get('/api/me', { preHandler: auth(false) }, async (req, reply) => {
    const player = req.player as Player;
    return reply.code(200).send({
      player: { name: player.name, actorIds: player.actorIds, gm: player.gm === true },
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
        if (ping) clearInterval(ping);
        ac.abort();
        rawRes.end();
      };
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
      switch (action.endpoint) {
        case 'roll':
          result = extractRoll(await relay.rollFormula(`Actor.${id}`, action.formula, action.flavor));
          break;
        case 'use-item':
        case 'use-spell':
        case 'use-feature':
          result = extractRoll(
            await relay.useAbility(
              action.endpoint,
              `Actor.${id}`,
              `Actor.${id}.Item.${action.itemId}`,
              action.slotLevel !== undefined ? { slotLevel: action.slotLevel } : {},
            ),
          );
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
            await relay.useAbility(action.use, `Actor.${id}`, `Actor.${id}.Item.${action.itemId}`, {});
          } catch (err) {
            // A relay 408 means Foundry's usage workflow is waiting on
            // optional UI (live-verified 2026-07-10: Bead of Force's
            // area-template prompt) — consumption has already completed by
            // then, so the display roll must still fire. Anything else
            // (unknown item, permissions) stays fatal.
            const status = (err as { status?: unknown }).status;
            if (!(err instanceof Error && err.name === 'RelayError' && status === 408)) throw err;
            req.log.warn({ err }, 'use-and-roll: activation timed out on Foundry UI; continuing with the roll');
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
        case 'short-rest':
        case 'long-rest':
        case 'death-save':
        case 'break-concentration':
          // death-save returns a roll under `data`; the rest post their own
          // card and carry no roll total -> extractRoll yields null.
          result = extractRoll(await relay.actorCommand(action.endpoint, `Actor.${id}`));
          break;
      }

      const fresh = await fetchActor(id);
      if (!fresh) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
      const freshAdapter = adapterFor(fresh) ?? adapter;
      return reply.code(200).send({ result, sheet: buildSheet(freshAdapter, fresh) });
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
      await relay.giveItem(`Actor.${req.params.id}`, raw.uuid);
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
      await relay.deleteEntity(`Actor.${req.params.id}.Item.${req.params.itemId}`);
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

  return app;
}
