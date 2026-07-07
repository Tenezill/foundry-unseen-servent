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
      res = await fetch(endpoint, {
        method,
        headers: this.headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new RelayError(`relay unreachable: ${(err as Error).message}`, undefined, path);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RelayError(`relay ${path} -> ${res.status}: ${text.slice(0, 300)}`, res.status, path);
    }
    return (await res.json()) as T;
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
   */
  async getEntity(uuid: string): Promise<Record<string, unknown> | null> {
    try {
      const body = await this.request<Record<string, unknown>>('GET', '/get', { uuid });
      return unwrapEntity(body);
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
   * PUT /update — apply a dot-notation update to an entity. The payload is
   * passed straight to Foundry's Document.update(), e.g.
   * `{ "system.attributes.hp.value": 25 }`.
   */
  async updateEntity(uuid: string, data: Record<string, number | string | boolean>): Promise<void> {
    await this.request('PUT', '/update', { uuid }, { data });
  }

  /**
   * GET /actor/subscribe?actorUuid=… — SSE push of actor changes.
   * Calls `onEvent` for every event until `signal` aborts or the stream
   * ends. Resolves when the stream closes; the caller owns reconnection.
   */
  async subscribeActor(actorUuid: string, onEvent: (ev: ActorEvent) => void, signal: AbortSignal): Promise<void> {
    const endpoint = this.url('/actor/subscribe', { actorUuid });
    const res = await fetch(endpoint, {
      headers: this.headers({ accept: 'text/event-stream' }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new RelayError(`relay /actor/subscribe -> ${res.status}`, res.status, '/actor/subscribe');
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
        const dataLines = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());
        if (dataLines.length === 0) continue;
        const raw = dataLines.join('\n');
        let data: unknown = raw;
        try {
          data = JSON.parse(raw);
        } catch {
          /* keep raw string */
        }
        onEvent({ actorUuid, data });
      }
    }
  }
}

/**
 * The /get envelope: v3 docs say "object containing entity details" without
 * a literal example. Handle both a bare document and common wrappers;
 * M0 live verification pins the actual shape.
 */
export function unwrapEntity(body: Record<string, unknown>): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object') return null;
  if (typeof body._id === 'string' || typeof body.uuid === 'string') return body;
  for (const key of ['entity', 'data', 'result']) {
    const inner = body[key];
    if (inner && typeof inner === 'object') return inner as Record<string, unknown>;
  }
  return body;
}
