/**
 * In-process fake of the relay's auth/session surface, mirroring the shapes
 * captured in Task 0 findings §4. Tests drive provisioning + session logic
 * against real HTTP (node:http) exactly like the gateway's FakeRelay drives
 * routes — no network mocking.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface FakeRelayClientRow {
  clientId: string;
  worldId: string;
  worldTitle: string;
  isOnline: boolean;
}

export class FakeRelayServer {
  readonly accounts = new Map<string, string>(); // email -> password
  readonly bearers = new Map<string, string>();  // bearer -> email
  readonly keys = new Map<string, string[]>();   // key -> scopes
  clients: FakeRelayClientRow[] = [];
  /** every /auth/* path hit, in order — lets tests assert "no auth calls". */
  readonly authCalls: string[] = [];
  readonly mintedScopes: string[][] = [];
  throttleAuth = false;
  gmPassword = 'gm-pass';
  /** set true to make /start-session mark the first client online. */
  sessionBringsOnline = true;

  private server: Server | null = null;
  // Separate counters: bearer allocation (register/login) must never shift
  // key numbering — a provisioning pass always mints the relay's *first*
  // key as "key-1" regardless of how many /auth/* round trips it took.
  private bearerSeq = 0;
  private keySeq = 0;

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => (this.server as Server).listen(0, '127.0.0.1', resolve));
    const addr = (this.server as Server).address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server === null) return; // idempotent: a second stop() must not hang
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '';
    const body = await readJson(req);
    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.startsWith('/auth/')) {
      this.authCalls.push(url);
      if (this.throttleAuth) return send(429, { error: 'too many requests' });
    }
    if (req.method === 'POST' && url === '/auth/register') {
      const { email, password } = body as { email?: string; password?: string };
      if (typeof email !== 'string' || typeof password !== 'string') return send(400, { error: 'bad request' });
      if (this.accounts.has(email)) return send(409, { error: 'account exists' });
      this.accounts.set(email, password);
      return send(200, { sessionToken: this.newBearer(email) });
    }
    if (req.method === 'POST' && url === '/auth/login') {
      const { email, password } = body as { email?: string; password?: string };
      if (typeof email === 'string' && this.accounts.get(email) === password) {
        return send(200, { sessionToken: this.newBearer(email) });
      }
      return send(401, { error: 'invalid credentials' });
    }
    if (req.method === 'POST' && url === '/auth/api-keys') {
      const auth = req.headers.authorization ?? '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!this.bearers.has(bearer)) return send(401, { error: 'unauthorized' });
      const scopes = (body as { scopes?: string[] }).scopes ?? [];
      const key = `key-${++this.keySeq}`;
      this.keys.set(key, [...scopes]);
      this.mintedScopes.push([...scopes]);
      return send(200, { key });
    }
    if (req.method === 'GET' && url.startsWith('/clients')) {
      const key = (req.headers['x-api-key'] as string | undefined) ?? '';
      if (!this.keys.has(key)) return send(401, { error: 'unauthorized' });
      return send(200, { total: this.clients.length, clients: this.clients });
    }
    if (req.method === 'POST' && url === '/session-handshake') {
      const key = (req.headers['x-api-key'] as string | undefined) ?? '';
      if (!this.keys.has(key)) return send(401, { error: 'unauthorized' });
      return send(200, { token: 'hs-token-1' });
    }
    if (req.method === 'POST' && url === '/start-session') {
      const { token, password } = body as { token?: string; password?: string };
      if (token !== 'hs-token-1') return send(400, { error: 'bad handshake token' });
      if (password !== this.gmPassword) return send(401, { error: 'invalid credentials' });
      if (this.sessionBringsOnline && this.clients.length > 0) {
        (this.clients[0] as FakeRelayClientRow).isOnline = true;
      }
      return send(200, { sessionId: 'sess-1', clientId: this.clients[0]?.clientId ?? 'fvtt_new' });
    }
    return send(404, { error: 'not found' });
  }

  private newBearer(email: string): string {
    const bearer = `bearer-${++this.bearerSeq}`;
    this.bearers.set(bearer, email);
    return bearer;
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += String(c)));
    req.on('end', () => {
      try {
        resolve(buf === '' ? {} : JSON.parse(buf));
      } catch {
        resolve({});
      }
    });
  });
}
