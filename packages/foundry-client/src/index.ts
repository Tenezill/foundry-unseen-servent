/**
 * Typed wrapper over the ThreeHats foundryvtt-rest-api-relay (v3.x, Go).
 * This is the ONLY package that knows relay URLs, API keys, and endpoint
 * shapes. Endpoint reference: relay repo `docs/md/api/*.md`, pinned in
 * VERSIONS.md; live-verified in docs/M0-findings.md.
 */

export interface RelayConfig {
  /** e.g. http://relay:3010 — never exposed to clients */
  baseUrl: string;
  /** scoped API key (entity:read, entity:write, search, events:subscribe, clients:read) */
  apiKey: string;
  /** Foundry world client id, e.g. fvtt_3a9f1c2e4b7d8e0f */
  clientId: string;
  /** Optional structured-log sink for defensive warnings (e.g. cross-wired
   *  GET /get responses — see getEntity). Silent no-op if omitted. */
  log?: { warn(obj: object, msg: string): void };
}

export interface RelayClientInfo {
  clientId: string;
  worldId: string;
  worldTitle: string;
  foundryVersion: string;
  systemId: string;
  isOnline: boolean;
}

export interface SearchOptions {
  query?: string;
  /** simple ("Actor") or compound ("documentType:Item,subType:weapon") */
  filter?: string;
  limit?: number;
  /** return only uuid,id,name,img,documentType */
  minified?: boolean;
}

export interface SearchResultEntry {
  uuid: string;
  id: string;
  name: string;
  img?: string;
  documentType: string;
  [key: string]: unknown;
}

export class RelayError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

/** An actor-changed push event from the relay SSE stream. */
export interface ActorEvent {
  actorUuid: string;
  /** raw event payload as sent by the relay */
  data: unknown;
}

/** A raw roll record from GET /rolls or the /rolls/subscribe stream. */
export interface RawRoll {
  id: string;
  messageId?: string;
  speaker?: { actor?: string; alias?: string };
  user?: { id?: string; name?: string } | null;
  flavor?: string;
  rollTotal?: number;
  formula?: string;
  isCritical?: boolean;
  isFumble?: boolean;
  timestamp?: number;
  [key: string]: unknown;
}

/** Result of a /roll or /dnd5e use-* roll, as returned by the relay. */
export interface RollResult {
  formula: string;
  total: number;
  isCritical?: boolean;
  isFumble?: boolean;
  [key: string]: unknown;
}

/** A named SSE event from the relay hooks stream. */
export interface HookEvent {
  /** SSE event name, e.g. "updateActor", "connected" */
  event: string;
  /** parsed data payload; hook events carry {data:{args:[<updated doc>, <diff>, …]}} */
  data: unknown;
}

export interface RelayCombatant {
  id: string;
  name: string;
  tokenUuid?: string;
  actorUuid?: string;
  img?: string | null;
  initiative?: number | null;
  hidden?: boolean;
  defeated?: boolean;
}

export interface RelayEncounter {
  id: string;
  name?: string;
  round: number;
  turn: number;
  current: boolean;
  combatants: RelayCombatant[];
}

export class FoundryRelayClient {
  constructor(private readonly cfg: RelayConfig) {}

  private url(path: string, params: Record<string, string | number | boolean | undefined> = {}): string {
    const u = new URL(path, this.cfg.baseUrl);
    u.searchParams.set('clientId', this.cfg.clientId);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'x-api-key': this.cfg.apiKey, ...extra };
  }

  private async request<T>(method: string, path: string, params: Record<string, string | number | boolean | undefined> = {}, body?: unknown): Promise<T> {
    const endpoint = this.url(path, params);
    let res: Response;
    try {
      const init: RequestInit = {
        method,
        headers: this.headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      res = await fetch(endpoint, init);
    } catch (err) {
      throw new RelayError(`relay unreachable: ${(err as Error).message}`, undefined, path);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RelayError(`relay ${path} -> ${res.status}: ${text.slice(0, 300)}`, res.status, path);
    }
    return (await res.json()) as T;
  }

  /**
   * GET /rolls — recent rolls across the whole world (M9, needs roll:read).
   * Newest first. Shape (M9-verified): {data:[{id, speaker:{actor,alias},
   * flavor, rollTotal, formula, isCritical, isFumble, timestamp, user}]}.
   */
  async getRolls(limit = 50): Promise<RawRoll[]> {
    const body = await this.request<{ data?: RawRoll[] }>('GET', '/rolls', { limit });
    return Array.isArray(body.data) ? body.data : [];
  }

  /**
   * GET /rolls/subscribe (SSE) — live world rolls (M9). Emits `event: roll`
   * frames whose `data.data` is a RawRoll. Calls onRoll per roll until the
   * signal aborts or the stream closes; caller owns reconnection.
   */
  async subscribeRolls(onRoll: (roll: RawRoll) => void, signal: AbortSignal): Promise<void> {
    await this.readSse('/rolls/subscribe', {}, signal, (ev) => {
      if (ev.event !== 'roll') return;
      const payload = ev.data;
      const inner = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).data : undefined;
      if (inner && typeof inner === 'object') onRoll(inner as RawRoll);
    });
  }

  /** GET /clients — worlds currently connected to the relay. */
  async listClients(): Promise<RelayClientInfo[]> {
    // /clients is relay-global; clientId param is harmlessly ignored.
    const body = await this.request<{ total: number; clients: RelayClientInfo[] }>('GET', '/clients');
    return body.clients ?? [];
  }

  /**
   * GET /get?uuid=Actor.xyz — full serialized entity document.
   * Returns null when the entity does not exist.
   *
   * Defense-in-depth (M22 cache-swap bug, live-verified against
   * threehats/foundryvtt-rest-api-relay 3.4.1): under CONCURRENT GET /get
   * calls, the relay was observed returning a 200 whose envelope `uuid` AND
   * whose `data._id` both belong to a DIFFERENT, concurrently-requested
   * uuid — i.e. it delivers the wrong client's response (a request/response
   * correlation bug upstream, not a transient field glitch). 25 rounds of 2
   * truly-concurrent GET /get against the live dev relay produced 14/50
   * cross-wired responses. Since the caller cannot fix the relay, every
   * response is checked for identity here: if the envelope uuid or the
   * document's own _id don't match what was requested, the fetch is treated
   * as failed (null) rather than trusted — callers already have a degrade
   * path for a failed/timed-out fetch (EncounterManager, admin console,
   * /api/actors all treat null as "not yet resolved").
   */
  async getEntity(uuid: string): Promise<Record<string, unknown> | null> {
    try {
      const body = await this.request<Record<string, unknown>>('GET', '/get', { uuid });
      const doc = unwrapEntity(body);
      if (doc === null) return null;
      const expectedId = uuid.split('.').pop();
      const envelopeUuid = typeof body.uuid === 'string' ? body.uuid : undefined;
      const docId = typeof doc._id === 'string' ? doc._id : undefined;
      const envelopeMismatch = envelopeUuid !== undefined && envelopeUuid !== uuid;
      const docMismatch = docId !== undefined && expectedId !== undefined && expectedId !== '' && docId !== expectedId;
      if (envelopeMismatch || docMismatch) {
        this.cfg.log?.warn(
          { requestedUuid: uuid, envelopeUuid, docId },
          'relay GET /get returned a mismatched entity (cross-wired response) — treating as a failed fetch',
        );
        return null;
      }
      return doc;
    } catch (err) {
      if (err instanceof RelayError && err.status === 404) return null;
      throw err;
    }
  }

  /** GET /search — find entities. */
  async search(opts: SearchOptions): Promise<SearchResultEntry[]> {
    const body = await this.request<Record<string, unknown>>('GET', '/search', {
      query: opts.query ?? '',
      filter: opts.filter,
      limit: opts.limit,
      minified: opts.minified,
    });
    const results = (body.results ?? body.entities ?? body) as unknown;
    return Array.isArray(results) ? (results as SearchResultEntry[]) : [];
  }

  /**
   * GET /<systemPath>/get-actor-details — system-specific derived data the
   * plain /get does not serialize (e.g. dnd5e `details=["spells"]` returns
   * real spell-slot maxima). Returns the endpoint's `data` payload.
   */
  async getSystemDetails(systemPath: string, actorUuid: string, details: string[]): Promise<unknown> {
    const body = await this.request<Record<string, unknown>>('GET', `/${systemPath}/get-actor-details`, {
      actorUuid,
      details: JSON.stringify(details),
    });
    return body.data ?? body;
  }

  /** GET /encounters — active/all combats (requires encounter:read scope). */
  async getEncounters(): Promise<RelayEncounter[]> {
    const body = await this.request<{ encounters?: RelayEncounter[] }>('GET', '/encounters', {});
    return Array.isArray(body.encounters) ? body.encounters : [];
  }

  /**
   * POST /roll — roll a formula in Foundry and post the chat card speaking
   * as the given actor (M6-verified). Requires the roll:execute scope.
   */
  async rollFormula(actorUuid: string, formula: string, flavor: string): Promise<RollResult> {
    const body = await this.request<{ data?: { roll?: RollResult } }>('POST', '/roll', {}, {
      formula,
      flavor,
      speaker: actorUuid,
      createChatMessage: true,
    });
    return body.data?.roll ?? { formula, total: Number.NaN };
  }

  /**
   * POST /dnd5e/use-item|use-spell|use-feature — run the system's real usage
   * workflow for an embedded item (chat card, slot/uses consumption).
   * Addressed by item uuid (`Actor.<id>.Item.<id>`).
   */
  async useAbility(
    endpoint: 'use-item' | 'use-spell' | 'use-feature',
    actorUuid: string,
    itemUuid: string,
    opts: { slotLevel?: number } = {},
  ): Promise<Record<string, unknown>> {
    // The module's upcast parameter is `level` (M6-live-verified: `slotLevel`
    // and other names are not recognised and make the cast fail outright).
    const body = await this.request<{ data?: Record<string, unknown>; error?: string }>('POST', `/dnd5e/${endpoint}`, {}, {
      actorUuid,
      abilityUuid: itemUuid,
      ...(opts.slotLevel !== undefined ? { level: opts.slotLevel } : {}),
    });
    if (typeof body.error === 'string' && body.error !== '') {
      throw new RelayError(`relay /dnd5e/${endpoint}: ${body.error}`, 200, `/dnd5e/${endpoint}`);
    }
    return body.data ?? {};
  }

  /** POST /dnd5e/equip-item — toggle an embedded item's equipped state. */
  async equipItem(actorUuid: string, itemUuid: string, equipped: boolean): Promise<void> {
    await this.request('POST', '/dnd5e/equip-item', {}, { actorUuid, itemUuid, equipped });
  }

  /**
   * POST /dnd5e/attune-item — set an embedded item's attuned state
   * (M12-live-verified). Errors arrive as HTTP 200 bodies with an `error`
   * field, so status alone cannot signal failure.
   */
  async attuneItem(actorUuid: string, itemUuid: string, attuned: boolean): Promise<void> {
    const body = await this.request<{ error?: string }>('POST', '/dnd5e/attune-item', {}, { actorUuid, itemUuid, attuned });
    if (typeof body.error === 'string' && body.error !== '') {
      throw new RelayError(`relay /dnd5e/attune-item: ${body.error}`, 200, '/dnd5e/attune-item');
    }
  }

  /**
   * POST /dnd5e/{short-rest|long-rest|death-save|break-concentration} — an
   * actor-scoped command (no item). M8-verified: `actorUuid` goes in the
   * query, no body needed; Foundry applies the result and posts any card.
   * death-save returns a roll under `data`; the others return a result
   * summary we ignore (the caller re-fetches the sheet).
   */
  async actorCommand(
    endpoint: 'short-rest' | 'long-rest' | 'death-save' | 'break-concentration',
    actorUuid: string,
  ): Promise<Record<string, unknown>> {
    const body = await this.request<{ data?: Record<string, unknown>; error?: string }>(
      'POST',
      `/dnd5e/${endpoint}`,
      { actorUuid },
      {},
    );
    if (typeof body.error === 'string' && body.error !== '') {
      throw new RelayError(`relay /dnd5e/${endpoint}: ${body.error}`, 200, `/dnd5e/${endpoint}`);
    }
    return body.data ?? {};
  }

  /**
   * POST /create — create a WORLD-level entity (not embedded on any actor).
   * Used only as the first leg of the custom-item chain (M23 Task 0
   * findings §Headline plan amendments 5: no embedded-create endpoint
   * exists, so a custom weapon/gear item is created as a scratch world item,
   * then `give`n onto the actor, then `delete`d). Returns the created uuid
   * (`body.uuid`, falling back to `'Item.' + body.entity._id` — both shapes
   * observed live), or null on any failure (never throws — the gateway
   * route treats null exactly like a bounded-timeout miss).
   */
  async createWorldItem(data: Record<string, unknown>): Promise<string | null> {
    try {
      const body = await this.request<{ uuid?: string; entity?: { _id?: string } }>(
        'POST',
        '/create',
        {},
        { entityType: 'Item', data },
      );
      if (typeof body.uuid === 'string' && body.uuid !== '') return body.uuid;
      const id = body.entity?._id;
      return typeof id === 'string' && id !== '' ? `Item.${id}` : null;
    } catch (err) {
      this.cfg.log?.warn({ err }, 'relay POST /create failed; treating as a failed fetch');
      return null;
    }
  }

  /**
   * POST /give — copy an item onto a target actor. `itemUuid` may be ANY
   * uuid Foundry's fromUuid resolves, including compendium uuids
   * (`Compendium.<pack>.Item.<id>`) — that is how "learn spell" works, and
   * (M23) a freshly `create`d world item, for the custom-item chain. Live-
   * verified response shape (M23 Task 0 findings): `{success:true}` on
   * success. Returns a boolean rather than throwing so every caller (the
   * M13 library "add" route and the M23 custom-item chain) can treat a
   * failure uniformly without a try/catch of its own.
   */
  async giveItem(toUuid: string, itemUuid: string): Promise<boolean> {
    try {
      const body = await this.request<{ success?: boolean; error?: string }>('POST', '/give', {}, { toUuid, itemUuid });
      if (body.success === true) return true;
      this.cfg.log?.warn({ toUuid, itemUuid, body }, 'relay POST /give did not report success');
      return false;
    } catch (err) {
      this.cfg.log?.warn({ err, toUuid, itemUuid }, 'relay POST /give failed');
      return false;
    }
  }

  /**
   * DELETE /delete — delete an entity by uuid; embedded item uuids
   * (`Actor.<id>.Item.<id>`) resolve via fromUuid, so this deletes a single
   * item off an actor; a bare `Item.<id>` uuid deletes a world item (M23:
   * the custom-item chain's cleanup step). Swallow-and-log: a failed delete
   * here is always a best-effort cleanup (a leftover world item, or a
   * library-collection item that stays on the actor) — never worth failing
   * the caller's whole request over, so this never throws.
   */
  async deleteEntity(uuid: string): Promise<void> {
    try {
      const body = await this.request<{ error?: string }>('DELETE', '/delete', { uuid });
      if (typeof body.error === 'string' && body.error !== '') {
        this.cfg.log?.warn({ uuid, error: body.error }, 'relay DELETE /delete reported an error; ignoring (best-effort)');
      }
    } catch (err) {
      this.cfg.log?.warn({ err, uuid }, 'relay DELETE /delete failed; ignoring (best-effort)');
    }
  }

  /**
   * PUT /update — apply a dot-notation update to an entity. The payload is
   * passed straight to Foundry's Document.update(), e.g.
   * `{ "system.attributes.hp.value": 25 }`.
   */
  async updateEntity(uuid: string, data: Record<string, number | string | boolean>): Promise<void> {
    await this.request('PUT', '/update', { uuid }, { data });
  }

  /**
   * GET /hooks/subscribe?hooks=updateActor,… — SSE push of Foundry hook
   * events. This is the live feed that works (M0-verified); a single
   * subscription covers all actors — filter by the document `_id` in
   * `data.args[0]`. Calls `onEvent` for every named event until `signal`
   * aborts or the stream ends. Resolves when the stream closes; the caller
   * owns reconnection.
   */
  async subscribeHooks(hooks: string[], onEvent: (ev: HookEvent) => void, signal: AbortSignal): Promise<void> {
    await this.readSse('/hooks/subscribe', { hooks: hooks.join(',') }, signal, onEvent);
  }

  /**
   * GET /actor/subscribe?actorUuid=… — per-actor SSE subscription.
   * M0 finding: connects but delivers no update events in relay/module
   * 3.4.1 — kept only for re-testing on upgrades. Prefer subscribeHooks.
   */
  async subscribeActor(actorUuid: string, onEvent: (ev: ActorEvent) => void, signal: AbortSignal): Promise<void> {
    await this.readSse('/actor/subscribe', { actorUuid }, signal, (ev) => onEvent({ actorUuid, data: ev.data }));
  }

  private async readSse(
    path: string,
    params: Record<string, string>,
    signal: AbortSignal,
    onEvent: (ev: HookEvent) => void,
  ): Promise<void> {
    const endpoint = this.url(path, params);
    const res = await fetch(endpoint, {
      headers: this.headers({ accept: 'text/event-stream' }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new RelayError(`relay ${path} -> ${res.status}`, res.status, path);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line
      for (;;) {
        const sep = buffer.indexOf('\n\n');
        if (sep === -1) break;
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = 'message';
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        const raw = dataLines.join('\n');
        let data: unknown = raw;
        try {
          data = JSON.parse(raw);
        } catch {
          /* keep raw string */
        }
        onEvent({ event, data });
      }
    }
  }
}

/**
 * The /get envelope, M0-verified (relay 3.4.1):
 * `{"type":"entity-result","requestId":"…","uuid":"Actor.x","data":{<doc>}}`.
 * The envelope itself carries a top-level `uuid`, so `data` must be checked
 * FIRST — a bare-document fallback is kept for older relays.
 */
export function unwrapEntity(body: Record<string, unknown>): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object') return null;
  for (const key of ['data', 'entity', 'result']) {
    const inner = body[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>;
  }
  if (typeof body._id === 'string') return body;
  return null;
}
