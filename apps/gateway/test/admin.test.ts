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
