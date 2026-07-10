# GM Invite Management (M18) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator sets `ADMIN_PASSWORD` in the gateway's `.env`, logs in at `/admin` in the PWA, and can create / list / rotate / revoke player invite links (with QR codes) without ever touching a terminal.

**Architecture:** A new `FilePlayerStore` owns `players.yaml` reads and writes (atomic tmp+rename, hot reload on external edits) and replaces the load-once array in `buildApp`. Five `/api/admin/*` Fastify routes are gated by a timing-safe password check (404 when the feature is off). The web app gets an `/admin` page (login → console) that reuses the existing Gilded Tome component patterns and renders join links as QR codes client-side.

**Tech Stack:** Fastify + TypeScript ESM (gateway), Nuxt 3 / Vue 3 `<script setup>` (web), `yaml` package (already a gateway dep), `uqr` (new web dep, zero-dependency QR SVG), vitest.

**Spec:** `docs/superpowers/specs/2026-07-10-gm-invite-management-design.md`

## Global Constraints

- Plaintext invite tokens and the admin password must NEVER be persisted or logged; only sha256 hex digests at rest (`players.yaml`), timing-safe comparisons everywhere (`node:crypto.timingSafeEqual`).
- `ADMIN_PASSWORD` unset or empty → every `/api/admin/*` route answers **404** with the standard envelope (feature disabled, do not reveal the route exists).
- Player invite tokens must NOT work on admin routes; the admin password must NOT work on player routes.
- All gateway error responses use the existing envelope `{ error: { code, message } }` with fixed gateway-owned messages; codes from the existing `ErrorCode` union (`UNAUTHORIZED`, `CONFLICT`, `INVALID_INTENT`, `NOT_FOUND`, …).
- Gateway imports use ESM `.js` suffixes (`./players.js`), strict TypeScript.
- Test commands: `pnpm --filter @companion/gateway test` (vitest; pass a file path after `--` to scope). Web has no unit-test suite; web tasks are verified by typecheck (`pnpm --filter @companion/web typecheck` if present, else `nuxt build`) and the final live checklist.
- Dev environment is Windows; the gateway may be running during development (port 8090) — tests never touch the real `apps/gateway/players.yaml`, only `mkdtemp` copies.
- Commit after every task with a conventional message; end commit messages with the Claude Code co-author trailer.

---

### Task 1: FilePlayerStore

**Files:**
- Create: `apps/gateway/src/player-store.ts`
- Test: `apps/gateway/test/player-store.test.ts`

**Interfaces:**
- Consumes: `parsePlayers`, `sha256Hex`, `verifyToken`, `Player` from `apps/gateway/src/players.ts` (existing, unchanged).
- Produces (Tasks 2–3 rely on these exact signatures):
  - `class PlayerStoreError extends Error { readonly code: 'DUPLICATE' | 'NOT_FOUND' }`
  - `class FilePlayerStore`:
    - `constructor(filePath: string)` — loads + validates synchronously, throws on invalid file (startup-fail behavior preserved)
    - `list(): readonly Player[]`
    - `reload(): void` — re-read from disk; on failure keep last good state (logs when watching)
    - `startWatching(log?: { warn(obj: object, msg: string): void }): void`
    - `stopWatching(): void`
    - `create(name: string, actorIds: string[]): Promise<{ token: string; player: Player }>`
    - `rotate(name: string): Promise<{ token: string }>`
    - `remove(name: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `apps/gateway/test/player-store.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePlayerStore, PlayerStoreError } from '../src/player-store.js';
import { parsePlayers, sha256Hex, verifyToken } from '../src/players.js';

const INITIAL = `players:
  - name: Anna
    tokenHash: "${sha256Hex('anna-token')}"
    actorIds: ["a1"]
    gm: true
`;

async function makeStore(): Promise<{ store: FilePlayerStore; file: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'player-store-'));
  const file = join(dir, 'players.yaml');
  await writeFile(file, INITIAL, 'utf8');
  return { store: new FilePlayerStore(file), file, dir };
}

describe('FilePlayerStore', () => {
  it('loads the file at construction and lists entries', async () => {
    const { store } = await makeStore();
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ name: 'Anna', actorIds: ['a1'], gm: true });
  });

  it('throws at construction on an invalid file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'player-store-'));
    const file = join(dir, 'players.yaml');
    await writeFile(file, 'players: nope', 'utf8');
    expect(() => new FilePlayerStore(file)).toThrow();
  });

  it('create appends an entry, returns a verifying token, writes a loadable file with header', async () => {
    const { store, file, dir } = await makeStore();
    const { token, player } = await store.create('Ben', ['b1', 'b2']);
    expect(player).toEqual({ name: 'Ben', tokenHash: sha256Hex(token), actorIds: ['b1', 'b2'] });
    expect(verifyToken(store.list(), token)?.name).toBe('Ben');
    const text = await readFile(file, 'utf8');
    expect(text.startsWith('# Managed by the gateway')).toBe(true);
    expect(parsePlayers(text)).toHaveLength(2);
    expect(text).not.toContain(token); // plaintext never at rest
    const leftovers = (await readdir(dir)).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]); // atomic write cleaned up
  });

  it('create rejects duplicate names case-insensitively and leaves the file unchanged', async () => {
    const { store, file } = await makeStore();
    await expect(store.create('anna', ['x'])).rejects.toMatchObject({ code: 'DUPLICATE' });
    await expect(store.create('anna', ['x'])).rejects.toBeInstanceOf(PlayerStoreError);
    expect(parsePlayers(await readFile(file, 'utf8'))).toHaveLength(1);
  });

  it('rotate replaces the hash: old token dies, new token verifies', async () => {
    const { store } = await makeStore();
    const { token } = await store.rotate('Anna');
    expect(verifyToken(store.list(), 'anna-token')).toBeNull();
    expect(verifyToken(store.list(), token)?.name).toBe('Anna');
    expect(store.list()[0]?.gm).toBe(true); // other fields survive
  });

  it('rotate/remove of an unknown name throw NOT_FOUND', async () => {
    const { store } = await makeStore();
    await expect(store.rotate('Nobody')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.remove('Nobody')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('remove deletes the entry and persists', async () => {
    const { store, file } = await makeStore();
    await store.create('Ben', ['b1']);
    await store.remove('Anna');
    expect(store.list().map((p) => p.name)).toEqual(['Ben']);
    expect(parsePlayers(await readFile(file, 'utf8'))).toHaveLength(1);
  });

  it('reload picks up external edits; an invalid edit keeps the last good state', async () => {
    const { store, file } = await makeStore();
    await writeFile(
      file,
      `${INITIAL}  - name: Handmade\n    tokenHash: "${sha256Hex('hand')}"\n    actorIds: ["h1"]\n`,
      'utf8',
    );
    store.reload();
    expect(store.list()).toHaveLength(2);
    await writeFile(file, 'players: garbage', 'utf8');
    store.reload();
    expect(store.list()).toHaveLength(2); // last good state kept
  });

  it('watcher reloads after an external write (debounced)', async () => {
    const { store, file } = await makeStore();
    store.startWatching();
    try {
      await writeFile(
        file,
        `${INITIAL}  - name: Watched\n    tokenHash: "${sha256Hex('w')}"\n    actorIds: ["w1"]\n`,
        'utf8',
      );
      await vi.waitFor(() => expect(store.list()).toHaveLength(2), { timeout: 3000, interval: 100 });
    } finally {
      store.stopWatching();
    }
  });

  it('serializes concurrent mutations — no lost writes', async () => {
    const { store, file } = await makeStore();
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.create(`P${n}`, [`x${n}`])));
    expect(store.list()).toHaveLength(6);
    expect(parsePlayers(await readFile(file, 'utf8'))).toHaveLength(6);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @companion/gateway test -- test/player-store.test.ts`
Expected: FAIL — cannot resolve `../src/player-store.js`.

- [ ] **Step 3: Implement `FilePlayerStore`**

Create `apps/gateway/src/player-store.ts`:

```ts
/**
 * Gateway-owned players.yaml: reads, atomic writes, hot reload (M18 spec).
 *
 * The gateway is the writer of record; hand edits are still legal and picked
 * up by the watcher, but comments do not survive a UI-driven rewrite (the
 * emitted header says so). Plaintext tokens exist only in the create/rotate
 * return values — never on disk, never in this class's state.
 */
import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { stringify } from 'yaml';
import { parsePlayers, sha256Hex, type Player } from './players.js';

export class PlayerStoreError extends Error {
  constructor(
    readonly code: 'DUPLICATE' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

export interface StoreLog {
  warn(obj: object, msg: string): void;
}

const HEADER =
  '# Managed by the gateway (/admin console). Hand edits are picked up live,\n' +
  '# but comments do not survive a console-driven rewrite.\n';

export class FilePlayerStore {
  private players: readonly Player[];
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  /** Mutations run strictly in sequence; a failed one does not block the next. */
  private writeQueue: Promise<unknown> = Promise.resolve();
  private log: StoreLog | null = null;

  constructor(private readonly filePath: string) {
    this.players = parsePlayers(readFileSync(filePath, 'utf8'));
  }

  list(): readonly Player[] {
    return this.players;
  }

  /** Re-read from disk; on a bad file keep the last good state. */
  reload(): void {
    try {
      this.players = parsePlayers(readFileSync(this.filePath, 'utf8'));
    } catch (err) {
      this.log?.warn({ err }, 'players file reload failed; keeping last good state');
    }
  }

  /** Watch the parent directory (atomic renames would orphan a file watch). */
  startWatching(log?: StoreLog): void {
    if (log) this.log = log;
    if (this.watcher) return;
    const base = basename(this.filePath);
    this.watcher = watch(dirname(this.filePath), (_event, filename) => {
      if (filename !== null && filename !== base) return;
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => this.reload(), 300);
    });
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  async create(name: string, actorIds: string[]): Promise<{ token: string; player: Player }> {
    return this.mutate(async () => {
      const lower = name.toLowerCase();
      if (this.players.some((p) => p.name.toLowerCase() === lower)) {
        throw new PlayerStoreError('DUPLICATE', `player "${name}" already exists`);
      }
      const token = randomBytes(24).toString('base64url');
      const player: Player = { name, tokenHash: sha256Hex(token), actorIds };
      await this.persist([...this.players, player]);
      return { token, player };
    });
  }

  async rotate(name: string): Promise<{ token: string }> {
    return this.mutate(async () => {
      const idx = this.players.findIndex((p) => p.name === name);
      if (idx === -1) throw new PlayerStoreError('NOT_FOUND', `no player "${name}"`);
      const token = randomBytes(24).toString('base64url');
      const next = this.players.map((p, i) => (i === idx ? { ...p, tokenHash: sha256Hex(token) } : p));
      await this.persist(next);
      return { token };
    });
  }

  async remove(name: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.players.some((p) => p.name === name)) {
        throw new PlayerStoreError('NOT_FOUND', `no player "${name}"`);
      }
      await this.persist(this.players.filter((p) => p.name !== name));
    });
  }

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async persist(next: readonly Player[]): Promise<void> {
    const text = HEADER + stringify({ players: next });
    // Same validator as reads: never write a file the constructor could not load.
    parsePlayers(text);
    const tmp = join(dirname(this.filePath), `.${basename(this.filePath)}.tmp`);
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, this.filePath);
    this.players = next;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @companion/gateway test -- test/player-store.test.ts`
Expected: PASS (9 tests). If the watcher test is flaky on this machine, bump its `vi.waitFor` timeout to 5000 — do not delete the test.

- [ ] **Step 5: Run the full gateway suite (nothing else should be touched)**

Run: `pnpm --filter @companion/gateway test`
Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/player-store.ts apps/gateway/test/player-store.test.ts
git commit -m "feat(gateway): FilePlayerStore — atomic players.yaml writes + hot reload"
```

---

### Task 2: buildApp takes a live player source

**Files:**
- Modify: `apps/gateway/src/app.ts` (deps interface + auth prehandler, ~lines 88–107 and 313–323)
- Modify: `apps/gateway/test/fakes.ts` (new helper)
- Modify: `apps/gateway/test/app.test.ts` (every `buildApp(` call site — grep for them)
- Modify: `apps/gateway/src/server.ts` (construct the store)

**Interfaces:**
- Consumes: `FilePlayerStore` from Task 1.
- Produces (Task 3 relies on these):
  - `export interface PlayersPort { list(): readonly Player[] }` in `app.ts`
  - `GatewayDeps.players: PlayersPort` (was `readonly Player[]`)
  - fakes: `export function memoryPlayers(players: Player[]): PlayersPort`

This is a pure refactor — auth reads `players.list()` on every request so store
mutations/reloads take effect live. No new tests; the existing suite is the net.

- [ ] **Step 1: Change the deps type and auth in `app.ts`**

In `apps/gateway/src/app.ts`, add next to `GatewayDeps`:

```ts
/** Live view of the player list; backed by FilePlayerStore in production. */
export interface PlayersPort {
  list(): readonly Player[];
}
```

Change the deps field (was `players: readonly Player[];`):

```ts
export interface GatewayDeps {
  relay: RelayPort;
  players: PlayersPort;
  // ...rest unchanged
```

In `buildApp`, the destructured `players` is now a port; change the auth
prehandler's verify call (currently `verifyToken(players, token)`):

```ts
const player = token === null ? null : verifyToken(players.list(), token);
```

- [ ] **Step 2: Add the fakes helper and update test call sites**

In `apps/gateway/test/fakes.ts`:

```ts
import type { PlayersPort } from '../src/app.js';
import type { Player } from '../src/players.js';

/** Wrap a fixed array as the live player source buildApp now expects. */
export function memoryPlayers(players: Player[]): PlayersPort {
  return { list: () => players };
}
```

In `apps/gateway/test/app.test.ts`, wrap every `players: makePlayers()` (grep
`buildApp(` — 5 call sites) as:

```ts
players: memoryPlayers(makePlayers()),
```

and add `memoryPlayers` to the existing `./fakes.js` import.

- [ ] **Step 3: Wire the store in `server.ts`**

In `apps/gateway/src/server.ts`, replace the `loadPlayers` usage:

```ts
import { FilePlayerStore } from './player-store.js';
// delete: import { loadPlayers } from './players.js';

const store = new FilePlayerStore(cfg.playersFile);
```

pass `players: store` into `buildApp`, and after `buildApp(...)`:

```ts
store.startWatching({ warn: (obj, msg) => app.log.warn(obj, msg) });
```

and inside the existing `close()` function, before `app.close()`:

```ts
store.stopWatching();
```

- [ ] **Step 4: Run the gateway suite**

Run: `pnpm --filter @companion/gateway test`
Expected: PASS — identical count to before this task.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/app.ts apps/gateway/src/server.ts apps/gateway/test/fakes.ts apps/gateway/test/app.test.ts
git commit -m "refactor(gateway): buildApp reads players through a live PlayersPort"
```

---

### Task 3: Admin auth + /api/admin routes + config

**Files:**
- Modify: `apps/gateway/src/app.ts` (deps `admin` field, `requireAdmin`, 5 routes after `/api/me`)
- Modify: `apps/gateway/src/config.ts` (optional `adminPassword`)
- Modify: `apps/gateway/src/server.ts` (pass `admin` when configured)
- Test: `apps/gateway/test/admin.test.ts` (new)

**Interfaces:**
- Consumes: `FilePlayerStore`, `PlayerStoreError` (Task 1); `PlayersPort` (Task 2); `FakeRelay` fields `entities`, `searchResults`, `searchCalls`, helper `actorDoc` (existing fakes).
- Produces (Tasks 4–5 rely on these exact response shapes):
  - `GatewayDeps.admin?: { password: string; store: AdminStorePort }` where

    ```ts
    export interface AdminStorePort extends PlayersPort {
      create(name: string, actorIds: string[]): Promise<{ token: string; player: Player }>;
      rotate(name: string): Promise<{ token: string }>;
      remove(name: string): Promise<void>;
    }
    ```

  - `GET /api/admin/players` → `200 { players: [{ name: string, gm: boolean, actors: [{ id: string, name?: string }] }] }`
  - `POST /api/admin/players` body `{ name, actorIds }` → `201 { token: string, player: { name, actorIds, gm: boolean } }` | `422` | `409`
  - `POST /api/admin/players/:name/rotate` → `200 { token: string }` | `404`
  - `DELETE /api/admin/players/:name` → `204` | `404`
  - `GET /api/admin/actors?q=…` → `200 { actors: [{ id, name, img? }] }` (empty `q` → `{ actors: [] }`)
  - Disabled feature → `404` on all of the above; bad credential → `401`.
- Deviation from spec (record in the commit body): the spec's actor endpoint
  implied a full world listing; the relay only exposes discovery via `search`,
  so the picker is search-driven (`?q=`), mirroring the M13 library UX.

- [ ] **Step 1: Write the failing tests**

Create `apps/gateway/test/admin.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { FilePlayerStore } from '../src/player-store.js';
import { sha256Hex } from '../src/players.js';
import { FakeRelay, actorDoc, fakeAdapter } from './fakes.js';
import { createRegistry } from '../src/registry.js';

const ADMIN_PW = 'correct-horse-battery';
const ANNA_TOKEN = 'anna-invite-token-123';

const INITIAL = `players:
  - name: Anna
    tokenHash: "${sha256Hex(ANNA_TOKEN)}"
    actorIds: ["a1"]
    gm: true
`;

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function setup(opts: { password?: string | undefined } = { password: ADMIN_PW }) {
  const dir = await mkdtemp(join(tmpdir(), 'gw-admin-'));
  const file = join(dir, 'players.yaml');
  await writeFile(file, INITIAL, 'utf8');
  const store = new FilePlayerStore(file);
  const relay = new FakeRelay();
  relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 24, 30));
  app = buildApp({
    relay,
    players: store,
    registry: createRegistry([fakeAdapter]),
    defaultSystemId: 'fake',
    livePollMs: 10_000,
    pingMs: 60_000,
    ...(opts.password === undefined ? {} : { admin: { password: opts.password, store } }),
  });
  return { app, store, relay, file };
}

const asAdmin = { authorization: `Bearer ${ADMIN_PW}` };

describe('admin feature flag', () => {
  it('every admin route is 404 when ADMIN_PASSWORD is not configured', async () => {
    const { app } = await setup({ password: undefined });
    for (const [method, url] of [
      ['GET', '/api/admin/players'],
      ['POST', '/api/admin/players'],
      ['POST', '/api/admin/players/Anna/rotate'],
      ['DELETE', '/api/admin/players/Anna'],
      ['GET', '/api/admin/actors?q=x'],
    ] as const) {
      const res = await app.inject({ method, url, headers: asAdmin });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('rejects wrong passwords and player invite tokens with 401', async () => {
    const { app } = await setup();
    for (const auth of ['Bearer wrong', `Bearer ${ANNA_TOKEN}`, '']) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/players',
        headers: auth === '' ? {} : { authorization: auth },
      });
      expect(res.statusCode, auth || '(none)').toBe(401);
    }
  });

  it('the admin password grants no player access', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: asAdmin });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/admin/players', () => {
  it('lists entries with resolved actor names and never leaks hashes', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/admin/players', headers: asAdmin });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { players: unknown[] };
    expect(body.players).toEqual([
      { name: 'Anna', gm: true, actors: [{ id: 'a1', name: 'Sariel' }] },
    ]);
    expect(res.body).not.toMatch(/[0-9a-f]{64}/);
  });

  it('renders unresolvable actor ids without a name', async () => {
    const { app, store } = await setup();
    await store.create('Ben', ['ghost-id']);
    const res = await app.inject({ method: 'GET', url: '/api/admin/players', headers: asAdmin });
    const body = res.json() as { players: Array<{ name: string; actors: Array<{ id: string; name?: string }> }> };
    expect(body.players[1]?.actors).toEqual([{ id: 'ghost-id' }]);
  });
});

describe('POST /api/admin/players', () => {
  it('creates a player whose token immediately works on /api/me', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/players',
      headers: asAdmin,
      payload: { name: 'Ben', actorIds: ['b1'] },
    });
    expect(res.statusCode).toBe(201);
    const { token, player } = res.json() as { token: string; player: unknown };
    expect(player).toEqual({ name: 'Ben', actorIds: ['b1'], gm: false });
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { player: { name: string } }).player.name).toBe('Ben');
  });

  it('409 on duplicate name, 422 on bad bodies', async () => {
    const { app } = await setup();
    const dup = await app.inject({
      method: 'POST',
      url: '/api/admin/players',
      headers: asAdmin,
      payload: { name: 'anna', actorIds: ['x'] },
    });
    expect(dup.statusCode).toBe(409);
    for (const payload of [
      {},
      { name: '', actorIds: ['x'] },
      { name: 'Ok', actorIds: [] },
      { name: 'Ok', actorIds: ['', 'x'] },
      { name: 'Ok', actorIds: 'x' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/admin/players', headers: asAdmin, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
    }
  });
});

describe('rotate and revoke', () => {
  it('rotate kills the old token and returns a working new one', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/admin/players/Anna/rotate', headers: asAdmin });
    expect(res.statusCode).toBe(200);
    const { token } = res.json() as { token: string };
    const oldMe = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${ANNA_TOKEN}` } });
    expect(oldMe.statusCode).toBe(401);
    const newMe = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
    expect(newMe.statusCode).toBe(200);
  });

  it('revoke removes the entry and cuts access immediately', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/players/Anna', headers: asAdmin });
    expect(res.statusCode).toBe(204);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${ANNA_TOKEN}` } });
    expect(me.statusCode).toBe(401);
  });

  it('404 for unknown names', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/admin/players/Nobody/rotate', headers: asAdmin })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/players/Nobody', headers: asAdmin })).statusCode).toBe(404);
  });
});

describe('GET /api/admin/actors', () => {
  it('searches world character actors and drops compendium hits', async () => {
    const { app, relay } = await setup();
    relay.searchResults = [
      { uuid: 'Actor.w1', id: 'w1', name: 'Randal', img: 'i.webp', documentType: 'Actor', subType: 'character' },
      { uuid: 'Compendium.pack.Actor.c1', id: 'c1', name: 'Premade', documentType: 'Actor', subType: 'character' },
    ];
    const res = await app.inject({ method: 'GET', url: '/api/admin/actors?q=ran', headers: asAdmin });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ actors: [{ id: 'w1', name: 'Randal', img: 'i.webp' }] });
    expect(relay.searchCalls[0]).toMatchObject({ query: 'ran', filter: 'documentType:Actor,subType:character' });
  });

  it('empty q returns an empty list without hitting the relay', async () => {
    const { app, relay } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/admin/actors?q=', headers: asAdmin });
    expect(res.json()).toEqual({ actors: [] });
    expect(relay.searchCalls).toHaveLength(0);
  });
});

describe('config', () => {
  const BASE = {
    RELAY_URL: 'http://r',
    RELAY_API_KEY: 'k',
    RELAY_CLIENT_ID: 'c',
    PLAYERS_FILE: './p.yaml',
  };
  it('reads ADMIN_PASSWORD when set, omits it when unset or empty', () => {
    expect(loadConfig({ ...BASE, ADMIN_PASSWORD: 'pw' }).adminPassword).toBe('pw');
    expect(loadConfig({ ...BASE }).adminPassword).toBeUndefined();
    expect(loadConfig({ ...BASE, ADMIN_PASSWORD: '' }).adminPassword).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @companion/gateway test -- test/admin.test.ts`
Expected: FAIL — admin routes 404 in every case (routes don't exist), config field missing.

- [ ] **Step 3: Add `adminPassword` to config**

In `apps/gateway/src/config.ts`, add to `GatewayConfig`:

```ts
  /** Enables /api/admin/* when set. Unset/empty = admin surface disabled. */
  adminPassword?: string;
```

and in the returned object of `loadConfig`:

```ts
    ...(env.ADMIN_PASSWORD !== undefined && env.ADMIN_PASSWORD !== ''
      ? { adminPassword: env.ADMIN_PASSWORD }
      : {}),
```

- [ ] **Step 4: Add the admin deps, guard, and routes to `app.ts`**

Add imports at the top of `apps/gateway/src/app.ts`:

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
import { PlayerStoreError } from './player-store.js';
```

Add next to `PlayersPort`:

```ts
/** Mutating store used by the admin console (FilePlayerStore in production). */
export interface AdminStorePort extends PlayersPort {
  create(name: string, actorIds: string[]): Promise<{ token: string; player: Player }>;
  rotate(name: string): Promise<{ token: string }>;
  remove(name: string): Promise<void>;
}
```

Add to `GatewayDeps`:

```ts
  /** When present (non-empty password), enables the /api/admin/* surface. */
  admin?: { password: string; store: AdminStorePort };
```

Inside `buildApp`, after the `auth` helper definition:

```ts
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
```

Add the routes after the `/api/me` route:

```ts
  app.get('/api/admin/players', { preHandler: requireAdmin }, async (_req, reply) => {
    const entries = (adminStore as AdminStorePort).list();
    const ids = [...new Set(entries.flatMap((p) => p.actorIds))];
    const names = new Map<string, string>();
    await Promise.all(
      ids.map(async (id) => {
        try {
          const doc = await relay.getEntity(`Actor.${id}`);
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
```

- [ ] **Step 5: Pass `admin` from `server.ts`**

In `apps/gateway/src/server.ts`, in the `buildApp` call:

```ts
    ...(cfg.adminPassword !== undefined ? { admin: { password: cfg.adminPassword, store } } : {}),
```

- [ ] **Step 6: Run the whole gateway suite**

Run: `pnpm --filter @companion/gateway test`
Expected: PASS — all previous tests plus the new admin/config tests.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/app.ts apps/gateway/src/config.ts apps/gateway/src/server.ts apps/gateway/test/admin.test.ts
git commit -m "feat(gateway): /api/admin invite management behind ADMIN_PASSWORD

Spec deviation: /api/admin/actors is search-driven (?q=) rather than a full
world listing — the relay only exposes discovery via search; mirrors the M13
library picker UX."
```

---

### Task 4: Web plumbing — admin credential, API wrapper, types, QR component

**Files:**
- Modify: `apps/web/app/composables/useAuth.ts`
- Modify: `apps/web/app/composables/useApi.ts`
- Modify: `apps/web/app/types/api.ts`
- Create: `apps/web/app/components/QrCode.vue`
- Modify: `apps/web/package.json` (via `pnpm add`)

**Interfaces:**
- Consumes: gateway response shapes from Task 3.
- Produces (Task 5 relies on these):
  - `getAdminSecret(): string | null`, `setAdminSecret(secret: string): void`, `clearAdminSecret(): void` in `useAuth.ts`
  - `useAdminApi()` in `useApi.ts` returning `{ adminApi: <T>(path: string, opts?: ApiRequestOptions) => Promise<T> }`
  - Types: `AdminPlayer`, `AdminPlayersResponse`, `AdminInviteResponse`, `AdminActorsResponse`
  - `<QrCode :value="string" />` renders an SVG QR of `value`

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @companion/web add uqr`
Expected: `uqr` appears in `apps/web/package.json` dependencies.

- [ ] **Step 2: Admin secret storage in `useAuth.ts`**

Append to `apps/web/app/composables/useAuth.ts` (below `clearToken`, reusing
`safeGet`/`safeSet`):

```ts
const ADMIN_KEY = 'fc:admin'

export function getAdminSecret(): string | null {
  return safeGet(ADMIN_KEY)
}

export function setAdminSecret(secret: string): void {
  safeSet(ADMIN_KEY, secret)
}

export function clearAdminSecret(): void {
  try {
    localStorage.removeItem(ADMIN_KEY)
  } catch {
    /* noop */
  }
}
```

- [ ] **Step 3: Admin fetch wrapper in `useApi.ts`**

Append to `apps/web/app/composables/useApi.ts`:

```ts
/** Same wrapper as useApi, but authenticated with the admin credential. */
export function useAdminApi() {
  const config = useRuntimeConfig()
  const base = config.public.apiBase || ''

  async function adminApi<T>(path: string, opts: ApiRequestOptions = {}): Promise<T> {
    return await $fetch<T>(`${base}${path}`, {
      method: opts.method ?? 'GET',
      body: opts.body as Record<string, unknown> | undefined,
      headers: { authorization: `Bearer ${getAdminSecret() ?? ''}` },
    })
  }

  return { adminApi, base }
}
```

- [ ] **Step 4: Response types in `types/api.ts`**

Append to `apps/web/app/types/api.ts`:

```ts
// ---- admin console (M18) ----------------------------------------------------

export interface AdminPlayer {
  name: string
  gm: boolean
  actors: Array<{ id: string; name?: string }>
}

export interface AdminPlayersResponse {
  players: AdminPlayer[]
}

export interface AdminInviteResponse {
  token: string
  player?: { name: string; actorIds: string[]; gm: boolean }
}

export interface AdminActorsResponse {
  actors: Array<{ id: string; name: string; img?: string }>
}
```

- [ ] **Step 5: QR component**

Create `apps/web/app/components/QrCode.vue`:

```vue
<template>
  <!-- eslint-disable-next-line vue/no-v-html -- SVG generated locally by uqr from our own string -->
  <div class="qr" role="img" :aria-label="`QR code: ${value}`" v-html="svg" />
</template>

<script setup lang="ts">
import { renderSVG } from 'uqr'

const props = defineProps<{ value: string }>()

const svg = computed(() => renderSVG(props.value, { ecc: 'M', border: 2 }))
</script>

<style scoped>
.qr {
  /* White quiet zone regardless of theme — scanners need the contrast. */
  background: #fff;
  border-radius: 12px;
  padding: 8px;
  width: min(240px, 70vw);
  margin: 0 auto;
}

.qr :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
}
</style>
```

- [ ] **Step 6: Typecheck / build**

Run: `pnpm --filter @companion/web typecheck` (if the script doesn't exist, run `pnpm --filter @companion/web build`)
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/app/composables/useAuth.ts apps/web/app/composables/useApi.ts apps/web/app/types/api.ts apps/web/app/components/QrCode.vue
git commit -m "feat(web): admin credential storage, admin API wrapper, QR component"
```

---

### Task 5: /admin page + home-screen link

**Files:**
- Create: `apps/web/app/pages/admin.vue`
- Modify: `apps/web/app/pages/index.vue` (footer link)

**Interfaces:**
- Consumes: everything Task 4 produced; gateway routes from Task 3; existing components `ConfirmDialog` (props seen in `actor/[id].vue`: message/confirm flow), `ActorAvatar`, toast via `useToast()`.
- Produces: routes `/admin` (self-contained page). No exports consumed elsewhere.

Check `ConfirmDialog.vue`'s actual props before wiring (the actor page uses a
`confirmState` ref holding `{ message, resolve }`); replicate that pattern.

- [ ] **Step 1: Create the page**

Create `apps/web/app/pages/admin.vue`:

```vue
<template>
  <div class="page admin">
    <header class="head">
      <h1>Player links</h1>
      <button v-if="state === 'console'" class="logout" type="button" @click="logout">Log out</button>
    </header>

    <!-- login -->
    <form v-if="state === 'login'" class="card login" @submit.prevent="login">
      <p class="hint">Enter the admin password from the gateway's <code>.env</code>.</p>
      <input
        v-model="password"
        type="password"
        class="pw"
        placeholder="Admin password"
        autocomplete="current-password"
      />
      <button class="btn btn-accent" type="submit" :disabled="busy || password === ''">Log in</button>
      <p v-if="loginError" class="error-text">{{ loginError }}</p>
    </form>

    <!-- feature disabled -->
    <div v-else-if="state === 'disabled'" class="card status">
      <p class="status-title">Admin access is not enabled on this server</p>
      <p class="hint">Set <code>ADMIN_PASSWORD</code> in the gateway's <code>.env</code> and restart it.</p>
    </div>

    <!-- console -->
    <template v-else-if="state === 'console'">
      <button class="btn btn-accent new-player" type="button" @click="openCreate">+ New player</button>

      <div v-if="players.length === 0" class="card status">
        <p class="hint">No players linked yet. Create the first invite.</p>
      </div>

      <div v-for="p in players" :key="p.name" class="card player-row">
        <div class="player-main">
          <span class="player-name">{{ p.name }} <span v-if="p.gm" class="gm-badge">GM</span></span>
          <span class="player-actors">{{ p.actors.map((a) => a.name ?? a.id).join(', ') }}</span>
        </div>
        <div class="row-actions">
          <button class="btn small" type="button" :disabled="busy" @click="rotate(p.name)">New link</button>
          <button class="btn small danger" type="button" :disabled="busy" @click="revoke(p.name)">Revoke</button>
        </div>
      </div>
    </template>

    <!-- new player sheet -->
    <div v-if="createOpen" class="scrim" @click.self="createOpen = false">
      <div class="modal-sheet" role="dialog" aria-modal="true" aria-label="New player">
        <h2 class="sheet-title">New player</h2>
        <input v-model="newName" class="pw" placeholder="Player name" />
        <input v-model="actorQuery" class="pw" placeholder="Search characters…" @input="searchActors" />
        <div v-if="actorResults.length" class="actor-results">
          <button
            v-for="a in actorResults"
            :key="a.id"
            class="actor-hit"
            type="button"
            @click="toggleActor(a)"
          >
            {{ selectedActors.some((s) => s.id === a.id) ? '✓ ' : '' }}{{ a.name }}
          </button>
        </div>
        <p v-if="selectedActors.length" class="hint">
          Linked: {{ selectedActors.map((a) => a.name).join(', ') }}
        </p>
        <button
          class="btn btn-accent"
          type="button"
          :disabled="busy || newName.trim() === '' || selectedActors.length === 0"
          @click="create"
        >
          Create invite
        </button>
      </div>
    </div>

    <!-- invite result (create + rotate) -->
    <div v-if="invite" class="scrim" @click.self="invite = null">
      <div class="modal-sheet" role="dialog" aria-modal="true" aria-label="Invite link">
        <h2 class="sheet-title">Invite for {{ invite.name }}</h2>
        <QrCode :value="invite.link" />
        <p class="invite-link">{{ invite.link }}</p>
        <button class="btn btn-accent" type="button" @click="copy">Copy link</button>
        <p class="hint once">Shown once — it isn't stored anywhere. Closing this discards it.</p>
        <button class="btn" type="button" @click="invite = null">Done</button>
      </div>
    </div>

    <ConfirmDialog
      v-if="confirmState"
      :message="confirmState.message"
      @confirm="confirmState.resolve(true); confirmState = null"
      @cancel="confirmState.resolve(false); confirmState = null"
    />
  </div>
</template>

<script setup lang="ts">
import type { AdminActorsResponse, AdminInviteResponse, AdminPlayer, AdminPlayersResponse } from '~/types/api'

type AdminState = 'login' | 'disabled' | 'console'

const { adminApi } = useAdminApi()
const toast = useToast()

const state = ref<AdminState>('login')
const password = ref('')
const loginError = ref('')
const busy = ref(false)
const players = ref<AdminPlayer[]>([])
const confirmState = ref<{ message: string; resolve: (ok: boolean) => void } | null>(null)

const createOpen = ref(false)
const newName = ref('')
const actorQuery = ref('')
const actorResults = ref<Array<{ id: string; name: string }>>([])
const selectedActors = ref<Array<{ id: string; name: string }>>([])

const invite = ref<{ name: string; link: string } | null>(null)

function askConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.value = { message, resolve }
  })
}

async function loadPlayers(): Promise<void> {
  const res = await adminApi<AdminPlayersResponse>('/api/admin/players')
  players.value = res.players
  state.value = 'console'
}

async function boot(): Promise<void> {
  if (!getAdminSecret()) {
    state.value = 'login'
    return
  }
  try {
    await loadPlayers()
  } catch (err) {
    const status = errorStatus(err)
    if (status === 404) state.value = 'disabled'
    else {
      clearAdminSecret()
      state.value = 'login'
    }
  }
}

async function login(): Promise<void> {
  busy.value = true
  loginError.value = ''
  setAdminSecret(password.value)
  try {
    await loadPlayers()
    password.value = ''
  } catch (err) {
    clearAdminSecret()
    loginError.value = errorStatus(err) === 404
      ? 'Admin access is not enabled on this server.'
      : 'Wrong password.'
  } finally {
    busy.value = false
  }
}

function logout(): void {
  clearAdminSecret()
  players.value = []
  state.value = 'login'
}

/** Any 401 mid-session drops the credential back to the login state. */
async function guarded<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    if (errorStatus(err) === 401) {
      logout()
      toast.show('Session expired — log in again.')
      return null
    }
    throw err
  }
}

function openCreate(): void {
  newName.value = ''
  actorQuery.value = ''
  actorResults.value = []
  selectedActors.value = []
  createOpen.value = true
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
function searchActors(): void {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(async () => {
    const q = actorQuery.value.trim()
    if (q === '') {
      actorResults.value = []
      return
    }
    try {
      const res = await guarded(() =>
        adminApi<AdminActorsResponse>(`/api/admin/actors?q=${encodeURIComponent(q)}`),
      )
      if (res) actorResults.value = res.actors
    } catch {
      toast.show('Character search failed.')
    }
  }, 250)
}

function toggleActor(a: { id: string; name: string }): void {
  const i = selectedActors.value.findIndex((s) => s.id === a.id)
  if (i === -1) selectedActors.value.push(a)
  else selectedActors.value.splice(i, 1)
}

function joinLink(token: string): string {
  return `${location.origin}/join#${token}`
}

async function create(): Promise<void> {
  busy.value = true
  try {
    const res = await guarded(() =>
      adminApi<AdminInviteResponse>('/api/admin/players', {
        method: 'POST',
        body: { name: newName.value.trim(), actorIds: selectedActors.value.map((a) => a.id) },
      }),
    )
    if (!res) return
    createOpen.value = false
    invite.value = { name: newName.value.trim(), link: joinLink(res.token) }
    await loadPlayers()
  } catch (err) {
    toast.show(errorStatus(err) === 409 ? 'That name already exists.' : 'Couldn’t create the invite.')
  } finally {
    busy.value = false
  }
}

async function rotate(name: string): Promise<void> {
  const ok = await askConfirm(`Create a new link for ${name}? The old link stops working immediately.`)
  if (!ok) return
  busy.value = true
  try {
    const res = await guarded(() =>
      adminApi<AdminInviteResponse>(`/api/admin/players/${encodeURIComponent(name)}/rotate`, { method: 'POST' }),
    )
    if (res) invite.value = { name, link: joinLink(res.token) }
  } catch {
    toast.show('Couldn’t rotate the link.')
  } finally {
    busy.value = false
  }
}

async function revoke(name: string): Promise<void> {
  const ok = await askConfirm(`Revoke ${name}'s access? This cuts them off immediately.`)
  if (!ok) return
  busy.value = true
  try {
    const res = await guarded(async () => {
      await adminApi(`/api/admin/players/${encodeURIComponent(name)}`, { method: 'DELETE' })
      return true
    })
    if (res) {
      toast.show(`Revoked ${name}`)
      await loadPlayers()
    }
  } catch {
    toast.show('Couldn’t revoke that player.')
  } finally {
    busy.value = false
  }
}

async function copy(): Promise<void> {
  if (!invite.value) return
  try {
    await navigator.clipboard.writeText(invite.value.link)
    toast.show('Link copied')
  } catch {
    toast.show('Copy failed — long-press the link to copy it manually.')
  }
}

onMounted(() => void boot())
</script>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 4px 20px;
}

.head h1 {
  font-size: 1.35rem;
  font-weight: 800;
  letter-spacing: -0.01em;
}

.logout {
  color: var(--text-dim);
  font-size: 0.85rem;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 6px 12px;
}

.login,
.status {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.status-title {
  font-weight: 700;
}

.hint {
  color: var(--text-dim);
  font-size: 0.85rem;
}

.error-text {
  color: var(--garnet);
  font-size: 0.85rem;
}

.pw {
  min-height: 44px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: transparent;
  color: inherit;
  padding: 0 12px;
  font-size: 1rem;
}

.new-player {
  width: 100%;
  margin-bottom: 12px;
}

.player-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  margin-bottom: 10px;
}

.player-name {
  font-weight: 700;
}

.gm-badge {
  font-size: 0.7rem;
  font-weight: 800;
  color: var(--gold-bright);
  border: 1px solid currentcolor;
  border-radius: 6px;
  padding: 1px 5px;
  margin-left: 4px;
  vertical-align: middle;
}

.player-actors {
  display: block;
  color: var(--text-dim);
  font-size: 0.8rem;
  margin-top: 2px;
}

.row-actions {
  display: flex;
  gap: 8px;
  flex: none;
}

.btn.small {
  font-size: 0.8rem;
  padding: 8px 10px;
}

.btn.danger {
  color: var(--garnet);
  border-color: color-mix(in srgb, var(--garnet) 34%, transparent);
}

.sheet-title {
  font-family: var(--serif);
  font-size: 1.15rem;
  margin-bottom: 12px;
}

.modal-sheet {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.actor-results {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 30dvh;
  overflow-y: auto;
}

.actor-hit {
  text-align: left;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
}

.invite-link {
  font-size: 0.8rem;
  color: var(--text-dim);
  overflow-wrap: anywhere;
  text-align: center;
}

.once {
  text-align: center;
}
</style>
```

Adjust to the codebase as needed: reuse the global `card` / `btn` / `btn-accent` /
`scrim` / `modal-sheet` classes exactly as other pages do (check
`DetailDialog.vue` and `actor/[id].vue` if a class doesn't exist globally), and
match `ConfirmDialog`'s real prop/emit names before wiring.

- [ ] **Step 2: Add the home-screen footer link**

In `apps/web/app/pages/index.vue`, at the end of the template's `.page` div:

```vue
    <footer class="foot">
      <NuxtLink class="admin-link" to="/admin">Admin</NuxtLink>
    </footer>
```

and in the scoped styles:

```css
.foot {
  margin-top: 32px;
  text-align: center;
}

.admin-link {
  color: var(--text-dim);
  font-size: 0.8rem;
  opacity: 0.7;
}
```

- [ ] **Step 3: Typecheck / build**

Run: `pnpm --filter @companion/web typecheck` (or `build`)
Expected: clean.

- [ ] **Step 4: Manual smoke in the dev stack**

With Foundry+relay (docker), gateway (`ADMIN_PASSWORD` still unset), and
`pnpm --filter @companion/web dev` running: open `http://localhost:3001/admin`
(or whichever port Nuxt reports) → expect the login form; a login attempt must
show "Admin access is not enabled on this server."

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/pages/admin.vue apps/web/app/pages/index.vue
git commit -m "feat(web): /admin console — login, player list, create/rotate/revoke with QR invites"
```

---

### Task 6: Docs + live verification

**Files:**
- Modify: `docs/LLM-SETUP-RUNBOOK.md` (Phase 5 / invites section + Lifetimes section)
- Modify: `docs/API.md` (gateway configuration + new endpoints)
- Modify: `apps/gateway/.env` (add `ADMIN_PASSWORD` — the operator's copy, do not commit secrets; the value is set live, not in git)

**Interfaces:**
- Consumes: everything shipped in Tasks 1–5.
- Produces: updated operator docs; a live-verified feature.

- [ ] **Step 1: Update the runbook**

In `docs/LLM-SETUP-RUNBOOK.md`:
- The invite-creation phase (currently `node scripts/make-invite.mjs …` + hand-append to `players.yaml`): replace with — set `ADMIN_PASSWORD=<strong password>` in `apps/gateway/.env`, restart the gateway once, open `<app>/admin`, log in, use **New player**. Keep the CLI script as a one-paragraph "scripting alternative" note.
- Lifetimes section: add that `players.yaml` is gateway-managed and hot-reloaded — hand edits apply within ~1s without a restart; comments in the file do not survive console-driven rewrites.

- [ ] **Step 2: Update `docs/API.md`**

- Gateway configuration table: add `ADMIN_PASSWORD` (optional; enables `/api/admin/*`; unset = the routes answer 404).
- New "Admin endpoints (M18)" section documenting the five routes with the exact request/response shapes from Task 3's Interfaces block, the 404-when-disabled rule, and the show-once token semantics.

- [ ] **Step 3: Commit docs**

```bash
git add docs/LLM-SETUP-RUNBOOK.md docs/API.md
git commit -m "docs: admin console setup + API reference (M18)"
```

- [ ] **Step 4: Live verification checklist**

Environment: docker Foundry+relay up, gateway restarted with `ADMIN_PASSWORD` set in `apps/gateway/.env`, web dev server up.

1. `/admin` with no stored secret → login form. Wrong password → "Wrong password.", no console.
2. Correct password → console lists existing entries (Anna, Ben, Sebastian, Sebastian-tour) with resolved actor names.
3. **New player**: name `LiveTest`, search finds a world character, create → QR + link shown. Open the link in a private/incognito window → join succeeds → actor list shows the linked character. Confirm `apps/gateway/players.yaml` now contains a `LiveTest` entry with a hash (never the token) and the managed-file header.
4. Hot reload: hand-edit `players.yaml` (change nothing meaningful, e.g. re-order two entries), wait ~1s, `GET /api/admin/players` still correct — no gateway restart.
5. **Rotate** `LiveTest` → new QR; the private window's session dies on next request (401 → back to join); the new link works.
6. **Revoke** `LiveTest` → row gone; the new link is dead too; entry gone from `players.yaml`.
7. Player token on admin route: `curl -H "Authorization: Bearer <a player token>" <gateway>/api/admin/players` → 401.
8. QR scan: scan the QR from a real phone on the LAN (web dev server with `--host` or the prod build) and complete a join.

Record the outcome in `.superpowers/sdd/progress.md` (new M18 section).

- [ ] **Step 5: Final full-suite run and commit any fixes**

Run: `pnpm -r test`
Expected: green across adapter, gateway, client packages.

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** access model → Task 3 (`requireAdmin`, 404-when-disabled, timing-safe); PlayerStore load/hot-reload/atomic-write/validator/header → Task 1; endpoints table → Task 3 (search-driven actors deviation recorded in the commit message); logging/secrets → Task 3 tests (no hashes/tokens in bodies) + existing redaction; web login/disabled/console, list/revoke/rotate, new-player picker, QR, show-once, copy → Tasks 4–5; error handling (401 drops credential) → Task 5 `guarded()`; testing section → Tasks 1, 3; runbook impact → Task 6. `make-invite.mjs` stays untouched per revised spec (no `--gm` flag needed — admin no longer keys off `gm`).
- **Placeholder scan:** none — every code step carries full code.
- **Type consistency:** `PlayersPort.list()` (Tasks 1/2/3 agree); `AdminStorePort` methods match `FilePlayerStore` exactly (structural typing); web types match Task 3 response shapes; `AdminInviteResponse.token` used by both create and rotate paths.
