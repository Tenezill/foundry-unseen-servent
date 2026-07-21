/**
 * The sidecar's own minimal relay HTTP client — auth + session surface only.
 * The gateway's foundry-client deliberately does not know these endpoints;
 * this file is the only place that does. Endpoint shapes: docs/HOSTING.md
 * A6/B4a + Task 0 findings §4 (live-captured on relay 3.4.1). If a captured
 * field name differs from the extraction below, fix it HERE (and in the fake
 * server) — callers only see the typed results. Every call is bounded.
 */
import { constants, publicEncrypt } from 'node:crypto';

export class RelayAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = 'RelayAuthError';
  }
}

export interface RelayAuthDeps {
  baseUrl: string;
  /** Bound for every call. Default 10000. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface CallResult {
  status: number;
  body: Record<string, unknown>;
}

export class RelayAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly deps: RelayAuthDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
  }

  private async call(
    method: string,
    path: string,
    opts: { headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<CallResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.deps.baseUrl).toString(), {
        method,
        headers: {
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(opts.headers ?? {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RelayAuthError(`relay unreachable: ${(err as Error).message}`, undefined, path);
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON body (throttle page etc.) — status carries the signal */
    }
    return { status: res.status, body };
  }

  /** POST /auth/register — 2xx = created; conflict/4xx = already registered
   *  (the idempotent path — login verifies authoritatively); 429 = throttled
   *  (~20 req/15 min/IP — the caller MUST back off, never hot-retry). */
  async register(email: string, password: string): Promise<'created' | 'exists' | 'throttled'> {
    const { status } = await this.call('POST', '/auth/register', { body: { email, password } });
    if (status === 429) return 'throttled';
    if (status >= 200 && status < 300) return 'created';
    return 'exists';
  }

  /** POST /auth/login {email,password} -> session bearer. */
  async login(email: string, password: string): Promise<string> {
    const { status, body } = await this.call('POST', '/auth/login', { body: { email, password } });
    if (status === 429) throw new RelayAuthError('auth throttled', 429, '/auth/login');
    // Field name per Task 0 findings §4 (docs: sessionToken; token = fallback).
    const token =
      typeof body.sessionToken === 'string' ? body.sessionToken : typeof body.token === 'string' ? body.token : null;
    if (status >= 200 && status < 300 && token !== null) return token;
    throw new RelayAuthError(`login failed (${status})`, status, '/auth/login');
  }

  /** POST /auth/api-keys {name, scopes} (Bearer) -> the key. Shown once.
   *  Some relay builds reject an unknown system scope (e.g. `wod5e` on 3.4.1)
   *  with 400 `Invalid scope: <name>`, failing the WHOLE request. Rather than
   *  never mint, drop the named scope and retry — the fallback scopes.ts
   *  documents. Only the rejected scope is dropped, so a supported system scope
   *  like `dnd5e` is preserved. Returns the scopes ACTUALLY minted (post-drop)
   *  alongside the key, so callers can persist a scope-drift sidecar that
   *  matches reality rather than the requested canonical list. */
  async mintKey(bearer: string, name: string, scopes: readonly string[]): Promise<{ key: string; scopes: string[] }> {
    let current = [...scopes];
    // At most one drop per scope, plus the initial attempt.
    for (let attempt = 0; attempt <= scopes.length; attempt++) {
      const { status, body } = await this.call('POST', '/auth/api-keys', {
        headers: { authorization: `Bearer ${bearer}` },
        body: { name, scopes: current },
      });
      if (status === 429) throw new RelayAuthError('auth throttled', 429, '/auth/api-keys');
      // Field name per Task 0 findings §4 (docs: key; apiKey = fallback).
      const key = typeof body.key === 'string' ? body.key : typeof body.apiKey === 'string' ? body.apiKey : null;
      if (status >= 200 && status < 300 && key !== null) return { key, scopes: current };
      const match =
        status === 400 && typeof body.error === 'string' ? /invalid scope:\s*(\S+)/i.exec(body.error) : null;
      if (match !== null) {
        const filtered = current.filter((s) => s !== match[1]);
        if (filtered.length < current.length) {
          current = filtered;
          continue;
        }
      }
      throw new RelayAuthError(`api-key mint failed (${status})`, status, '/auth/api-keys');
    }
    throw new RelayAuthError('api-key mint failed (every scope rejected)', 400, '/auth/api-keys');
  }

  /** GET /clients as a cheap authenticated probe — NOT throttled like /auth. */
  async probeKey(key: string): Promise<'valid' | 'invalid' | 'unreachable'> {
    let result: CallResult;
    try {
      result = await this.call('GET', '/clients', { headers: { 'x-api-key': key } });
    } catch {
      return 'unreachable';
    }
    if (result.status === 200) return 'valid';
    if (result.status === 401 || result.status === 403) return 'invalid';
    return 'unreachable';
  }

  async listClients(key: string): Promise<Array<{ clientId: string; worldId: string; isOnline: boolean }>> {
    const { status, body } = await this.call('GET', '/clients', { headers: { 'x-api-key': key } });
    if (status !== 200) throw new RelayAuthError(`clients failed (${status})`, status, '/clients');
    const clients = body.clients;
    return Array.isArray(clients) ? (clients as Array<{ clientId: string; worldId: string; isOnline: boolean }>) : [];
  }

  /** POST /session-handshake — headers per docs/HOSTING.md:313 + findings §4. */
  async sessionHandshake(key: string, foundryUrl: string, gmUser: string): Promise<CallResult> {
    return this.call('POST', '/session-handshake', {
      headers: { 'x-api-key': key, 'x-foundry-url': foundryUrl, 'x-username': gmUser },
    });
  }

  /** POST /start-session — relay 3.4.1 headless login. The handshake returns
   *  { token, publicKey, nonce }; the relay expects the GM password RSA-encrypted
   *  (OAEP / SHA-256, base64) over `{password, nonce}` and sent as
   *  { handshakeToken, encryptedPassword } — NOT a plaintext `password` (that
   *  now 400s: "handshakeToken and encryptedPassword are required"). Contract
   *  per the relay's session API docs/examples. */
  async startSession(key: string, handshakeBody: Record<string, unknown>, gmPassword: string): Promise<CallResult> {
    const token = typeof handshakeBody.token === 'string' ? handshakeBody.token : '';
    const publicKey = typeof handshakeBody.publicKey === 'string' ? handshakeBody.publicKey : '';
    const nonce = typeof handshakeBody.nonce === 'string' ? handshakeBody.nonce : '';
    if (token === '' || publicKey === '') {
      throw new RelayAuthError('session handshake missing token/publicKey', undefined, '/start-session');
    }
    const encryptedPassword = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(JSON.stringify({ password: gmPassword, nonce }), 'utf8'),
    ).toString('base64');
    return this.call('POST', '/start-session', {
      headers: { 'x-api-key': key },
      body: { handshakeToken: token, encryptedPassword },
    });
  }
}
