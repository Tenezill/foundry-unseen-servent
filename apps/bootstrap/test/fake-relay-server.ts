/**
 * In-process fake of the relay's auth/session surface, mirroring the shapes
 * captured in Task 0 findings §4. Tests drive provisioning + session logic
 * against real HTTP (node:http) exactly like the gateway's FakeRelay drives
 * routes — no network mocking.
 */
import { constants, generateKeyPairSync, type KeyObject, privateDecrypt } from 'node:crypto';
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
  /** scopes the fake rejects at mint time, mirroring relay 3.4.1's
   *  `400 {"error":"Invalid scope: <name>"}` for unknown system scopes. */
  readonly rejectScopes = new Set<string>();
  throttleAuth = false;
  gmPassword = 'gm-pass';
  /** set true to make /start-session mark the first client online. */
  sessionBringsOnline = true;

  // Lazily-generated RSA keypair for the session-handshake/start-session
  // encryption contract (relay 3.4.1). Only session tests trigger keygen.
  private rsa: { privateKey: KeyObject; publicKeyPem: string } | null = null;
  private readonly handshakes = new Map<string, string>(); // token -> nonce
  private hsSeq = 0;

  private ensureRsa(): { privateKey: KeyObject; publicKeyPem: string } {
    if (this.rsa === null) {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      this.rsa = { privateKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string };
    }
    return this.rsa;
  }

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
      this.mintedScopes.push([...scopes]); // record every attempt, incl. rejected
      const bad = scopes.find((s) => this.rejectScopes.has(s));
      if (bad !== undefined) return send(400, { error: `Invalid scope: ${bad}` });
      const key = `key-${++this.keySeq}`;
      this.keys.set(key, [...scopes]);
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
      const token = `hs-${++this.hsSeq}`;
      const nonce = `nonce-${this.hsSeq}`;
      this.handshakes.set(token, nonce);
      return send(200, {
        token,
        nonce,
        publicKey: this.ensureRsa().publicKeyPem,
        instanceId: 'local',
        foundryUrl: (req.headers['x-foundry-url'] as string | undefined) ?? '',
        username: (req.headers['x-username'] as string | undefined) ?? '',
      });
    }
    if (req.method === 'POST' && url === '/start-session') {
      const { handshakeToken, encryptedPassword } = body as { handshakeToken?: string; encryptedPassword?: string };
      // Mirror relay 3.4.1: both fields required, password RSA-OAEP/SHA-256.
      if (typeof handshakeToken !== 'string' || typeof encryptedPassword !== 'string') {
        return send(400, { error: 'handshakeToken and encryptedPassword are required' });
      }
      const nonce = this.handshakes.get(handshakeToken);
      if (nonce === undefined) return send(400, { error: 'unknown handshakeToken' });
      let creds: { password?: string; nonce?: string };
      try {
        const buf = privateDecrypt(
          { key: this.ensureRsa().privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
          Buffer.from(encryptedPassword, 'base64'),
        );
        creds = JSON.parse(buf.toString('utf8')) as { password?: string; nonce?: string };
      } catch {
        return send(400, { error: 'invalid encrypted password' });
      }
      if (creds.nonce !== nonce) return send(400, { error: 'nonce mismatch' });
      if (creds.password !== this.gmPassword) return send(401, { error: 'invalid credentials' });
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
