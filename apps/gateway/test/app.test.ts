import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

/** Minimal structural type for the injected SSE response stream. */
interface EventStream {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  off(event: 'data', listener: (chunk: unknown) => void): unknown;
  destroy(): void;
}
import { IntentError, type SystemAdapter } from '@companion/adapter-sdk';
import { dnd5eAdapter } from '@companion/adapter-dnd5e';
import { wod5eAdapter } from '@companion/adapter-wod5e';
import { buildApp, isSafeDiceFormula, type EncounterManagerPort } from '../src/app.js';
import { EncounterManager } from '../src/encounters.js';
import { sha256Hex, type Player } from '../src/players.js';
import { createRegistry } from '../src/registry.js';
import {
  actionlessAdapter,
  actorDoc,
  customItemlessAdapter,
  fakeAdapter,
  FakeRelay,
  FAKE_API_KEY,
  FAKE_RELAY_URL,
  memoryPlayers,
} from './fakes.js';
import vampireCapturedJson from '../../../packages/adapter-wod5e/test/fixtures/vampire-captured.json' with { type: 'json' };

const ANNA_TOKEN = 'anna-invite-token-123';
const BOB_TOKEN = 'bob-invite-token-456';

function makePlayers(): Player[] {
  return [
    { name: 'Anna', tokenHash: sha256Hex(ANNA_TOKEN), actorIds: ['a1', 'a2', 'ghost'] },
    { name: 'Bob', tokenHash: sha256Hex(BOB_TOKEN), actorIds: ['b1'] },
  ];
}

let app: FastifyInstance | null = null;

function setup(
  overrides: {
    rateLimitMax?: number;
    customItemTimeoutMs?: number;
    movementTimeoutMs?: number;
    encounters?: EncounterManagerPort;
  } = {},
): { app: FastifyInstance; relay: FakeRelay } {
  const relay = new FakeRelay();
  relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 24, 30));
  relay.entities.set('Actor.a2', actorDoc('a2', 'Borin', 12, 40));
  relay.entities.set('Actor.b1', actorDoc('b1', 'Mysterious Stranger', 8, 8));
  app = buildApp({
    relay,
    players: memoryPlayers(makePlayers()),
    registry: createRegistry([fakeAdapter]),
    defaultSystemId: 'fake',
    livePollMs: 10_000,
    pingMs: 60_000,
    ...(overrides.rateLimitMax !== undefined ? { rateLimitMax: overrides.rateLimitMax } : {}),
    ...(overrides.customItemTimeoutMs !== undefined ? { customItemTimeoutMs: overrides.customItemTimeoutMs } : {}),
    ...(overrides.movementTimeoutMs !== undefined ? { movementTimeoutMs: overrides.movementTimeoutMs } : {}),
    ...(overrides.encounters !== undefined ? { encounters: overrides.encounters } : {}),
  });
  return { app, relay };
}

afterEach(async () => {
  if (app) await app.close();
  app = null;
});

const asAnna = { authorization: `Bearer ${ANNA_TOKEN}` };

describe('auth', () => {
  it('rejects a missing token with a 401 envelope', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
  });

  it('rejects a wrong token with 401', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Bearer nope' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('does not accept ?token= on non-SSE routes', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: `/api/me?token=${ANNA_TOKEN}` });
    expect(res.statusCode).toBe(401);
  });

  it('returns the /api/me shape for a valid token', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: asAnna });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ player: { name: 'Anna', actorIds: ['a1', 'a2', 'ghost'], gm: false } });
  });
});

describe('GET /api/party', () => {
  it('returns the deduped union of all players actorIds with resolved names', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/party', headers: asAnna });
    expect(res.statusCode).toBe(200);
    const actors = res.json().actors as Array<{ id: string; name?: string; img?: string }>;
    // union of Anna's ['a1', 'a2', 'ghost'] and Bob's ['b1'], deduped
    expect(actors.map((a) => a.id).sort()).toEqual(['a1', 'a2', 'b1', 'ghost']);
    expect(actors.find((a) => a.id === 'a1')).toMatchObject({ name: 'Sariel', img: 'icons/a1.webp' });
    expect(actors.find((a) => a.id === 'a2')).toMatchObject({ name: 'Borin', img: 'icons/a2.webp' });
    expect(actors.find((a) => a.id === 'b1')).toMatchObject({ name: 'Mysterious Stranger', img: 'icons/b1.webp' });
    // 'ghost' has no backing relay entity -> bare id, no name/img
    expect(actors.find((a) => a.id === 'ghost')).toEqual({ id: 'ghost' });
  });

  it('dedupes an actor co-owned by two players', async () => {
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 24, 30));
    const dedupApp = buildApp({
      relay,
      players: memoryPlayers([
        { name: 'Anna', tokenHash: sha256Hex(ANNA_TOKEN), actorIds: ['a1'] },
        { name: 'Bob', tokenHash: sha256Hex(BOB_TOKEN), actorIds: ['a1'] },
      ]),
      registry: createRegistry([fakeAdapter]),
      defaultSystemId: 'fake',
      livePollMs: 10_000,
      pingMs: 60_000,
    });
    try {
      const res = await dedupApp.inject({ method: 'GET', url: '/api/party', headers: asAnna });
      expect((res.json().actors as Array<{ id: string }>).filter((a) => a.id === 'a1')).toHaveLength(1);
    } finally {
      await dedupApp.close();
    }
  });

  it('401 without a token', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/party' });
    expect(res.statusCode).toBe(401);
  });
});

describe('actor scoping', () => {
  it('lists only the player’s own actors and tolerates missing ones', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/actors', headers: asAnna });
    expect(res.statusCode).toBe(200);
    const { actors } = res.json();
    expect(actors.map((a: { id: string }) => a.id)).toEqual(['a1', 'a2']); // 'ghost' skipped
    expect(actors[0]).toEqual({ id: 'a1', name: 'Sariel', img: 'icons/a1.webp', systemId: 'fake' });
  });

  it('404s (not 403) on a foreign actor sheet', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/actors/b1/sheet', headers: asAnna });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('serves the sheet for an owned actor', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/actors/a1/sheet', headers: asAnna });
    expect(res.statusCode).toBe(200);
    const { sheet } = res.json();
    expect(sheet.actorId).toBe('a1');
    expect(sheet.resources.find((r: { id: string }) => r.id === 'hp').value).toBe(24);
  });
});

describe('GET /api/actors/:id/movement', () => {
  let relay: FakeRelay;

  // Short movement budget so the relay-stall/hang tests degrade fast rather
  // than waiting the 3s default (mirrors the encounter timeout tests).
  beforeEach(() => {
    ({ app, relay } = setup({ movementTimeoutMs: 50 }));
  });

  const tok = (id: string, actorId: string | null, x: number, y: number, extra: Record<string, unknown> = {}) =>
    ({ _id: id, name: `tok-${id}`, x, y, width: 1, height: 1, hidden: false, disposition: 0, actorId, ...extra });
  // Tokens ride along embedded on the scene document (relay 3.4.1: no
  // separate canvas-documents route) — squareScene() takes them directly.
  const squareScene = (tokens: Array<ReturnType<typeof tok>> = []) =>
    ({ _id: 's1', name: 'Crypt', grid: { type: 1, size: 100, distance: 5, units: 'ft' }, tokens });

  /** Programs the FakeRelay's getSystemDetails response so fetchMovementContext's
   *  speed leg (relay.getSystemDetails('dnd5e', ..., ['stats'])) resolves a
   *  walk speed — dnd5e 5.x source docs never carry movement (see
   *  speedFromStats in movement.ts), so this is the only place speed comes from. */
  function withSpeed(r: FakeRelay, actorId: string, walk: number): void {
    r.systemDetails = { uuid: `Actor.${actorId}`, stats: { speed: walk } };
  }

  it('404s (not 403) on a foreign actor', async () => {
    const res = await (app as FastifyInstance).inject({ method: 'GET', url: '/api/actors/b1/movement', headers: asAnna });
    expect(res.statusCode).toBe(404);
  });

  it('returns onScene:false when there is no active scene', async () => {
    relay.scene = null;
    const res = await (app as FastifyInstance).inject({ method: 'GET', url: '/api/actors/a1/movement', headers: asAnna });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ movement: { onScene: false } });
  });

  it('returns onScene:false on a relay stall fetching the scene (bounded)', async () => {
    relay.hangScene = true;
    const res = await (app as FastifyInstance).inject({ method: 'GET', url: '/api/actors/a1/movement', headers: asAnna });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ movement: { onScene: false } });
  });

  it('returns the full view: cells, speed, visible others; hidden stripped', async () => {
    withSpeed(relay, 'a1', 30);
    relay.scene = squareScene([
      tok('t1', 'a1', 300, 200),
      tok('t2', 'm1', 500, 200, { disposition: -1 }),
      tok('t3', 'm2', 700, 200, { hidden: true }),
    ]);
    const res = await (app as FastifyInstance).inject({ method: 'GET', url: '/api/actors/a1/movement', headers: asAnna });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      movement: {
        onScene: true, sceneId: 's1', gridDistance: 5, gridUnits: 'ft', speedFt: 30,
        token: { cx: 3, cy: 2 },
        others: [{ cx: 5, cy: 2, disposition: -1, name: 'tok-t2' }],
      },
    });
  });

  it('502s when the actor details fetch hangs after a scene resolved', async () => {
    relay.scene = squareScene([tok('t1', 'a1', 300, 200)]);
    relay.hangSystemDetails = true;
    const res = await (app as FastifyInstance).inject({ method: 'GET', url: '/api/actors/a1/movement', headers: asAnna });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('UPSTREAM');
  });

  describe('POST /api/actors/:id/movement', () => {
    beforeEach(() => {
      withSpeed(relay, 'a1', 30);
      relay.scene = squareScene([tok('t1', 'a1', 300, 200), tok('t2', 'm1', 500, 200)]);
    });

    // Explicit content-type + stringify: a bare string payload (the 'nope'
    // malformed-body case) has no object shape for light-my-request to infer
    // a content-type from, and would otherwise 415 before reaching the route.
    const post = (id: string, body: unknown, headers = asAnna) =>
      (app as FastifyInstance).inject({
        method: 'POST',
        url: `/api/actors/${id}/movement`,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: JSON.stringify(body),
      });

    it('404s (not 403) on a foreign actor', async () => {
      expect((await post('b1', { cx: 1, cy: 1 })).statusCode).toBe(404);
    });

    it('422s on a malformed body', async () => {
      expect((await post('a1', { cx: 1.5, cy: 2 })).statusCode).toBe(422);
      expect((await post('a1', { cx: 1 })).statusCode).toBe(422);
      expect((await post('a1', 'nope')).statusCode).toBe(422);
    });

    it('422s when the destination is out of range', async () => {
      const res = await post('a1', { cx: 10, cy: 2 });   // chebyshev 7 > radius 6
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('INVALID_INTENT');
    });

    it('409s when the destination cell is occupied by a VISIBLE token', async () => {
      const res = await post('a1', { cx: 5, cy: 2 });    // t2's cell
      expect(res.statusCode).toBe(409);
    });

    it('does NOT block a cell occupied only by a hidden token (no leak)', async () => {
      relay.scene = squareScene([tok('t1', 'a1', 300, 200), tok('t3', 'm2', 500, 200, { hidden: true })]);
      const res = await post('a1', { cx: 5, cy: 2 });
      expect(res.statusCode).toBe(200);
    });

    it('409s when the actor has no token on the active scene', async () => {
      relay.scene = squareScene([]);
      expect((await post('a1', { cx: 4, cy: 2 })).statusCode).toBe(409);
    });

    it('502s (not 409) on a relay stall fetching the scene', async () => {
      relay.hangScene = true;
      const res = await post('a1', { cx: 4, cy: 2 });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('UPSTREAM');
    });

    it('moves the token: relay gets Scene.<id>.Token.<id> + px, response has the new cell', async () => {
      const res = await post('a1', { cx: 5, cy: 1 });    // chebyshev 2, free
      expect(res.statusCode).toBe(200);
      expect(relay.moveTokenCalls).toEqual([{ tokenUuid: 'Scene.s1.Token.t1', x: 500, y: 100 }]);
      const movement = res.json().movement;
      expect(movement.token).toEqual({ cx: 5, cy: 1 });
      expect(movement.onScene).toBe(true);
    });

    it('502s when the relay move call hangs', async () => {
      relay.hangMove = true;
      expect((await post('a1', { cx: 5, cy: 1 })).statusCode).toBe(502);
    });
  });
});

describe('secret hygiene', () => {
  it('never leaks the relay api key or url in any response body', async () => {
    const { app, relay } = setup();
    relay.failUuid = 'Actor.a2'; // upstream error path
    relay.listClientsError = true; // healthz degraded path
    const responses = [
      await app.inject({ method: 'GET', url: '/healthz' }),
      await app.inject({ method: 'GET', url: '/api/me' }), // 401
      await app.inject({ method: 'GET', url: '/api/me', headers: asAnna }),
      await app.inject({ method: 'GET', url: '/api/actors/a2/sheet', headers: asAnna }), // 502 upstream
      await app.inject({ method: 'GET', url: '/api/actors/a1/sheet', headers: asAnna }),
      await app.inject({ method: 'GET', url: '/api/nope', headers: asAnna }), // 404 handler
      await app.inject({
        method: 'POST',
        url: '/api/actors/a2/intents',
        headers: asAnna,
        payload: { kind: 'set', resourceId: 'hp', value: 1 },
      }), // 502 upstream on fetch
    ];
    for (const res of responses) {
      expect(res.body).not.toContain(FAKE_API_KEY);
      expect(res.body).not.toContain(FAKE_RELAY_URL);
    }
    const upstream = responses[3]!;
    expect(upstream.statusCode).toBe(502);
    expect(upstream.json().error.code).toBe('UPSTREAM');
    const health = responses[0]!;
    expect(health.json()).toEqual({ ok: true, relay: 'disconnected' });
  });

  it('reports relay connected when listClients succeeds', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, relay: 'connected' });
  });
});

describe('dice tray (/api/actors/:id/roll)', () => {
  it('isSafeDiceFormula accepts simple pools, rejects anything else', () => {
    for (const ok of ['1d20', 'd20', '2d6 + 1d8 + 3', '4d6 - 1', '100d1000']) {
      expect(isSafeDiceFormula(ok)).toBe(true);
    }
    // reject: no-die (pure modifier), refs, injection, bad tokens, over caps
    for (const bad of ['', '   ', '3', '@abilities.str.mod', '1d20; drop', '1d20 + x', '2 d6', '101d6', '1d1001', '1d20 +', 'kaboom()']) {
      expect(isSafeDiceFormula(bad)).toBe(false);
    }
  });

  const roll = (appInst: FastifyInstance, actorId: string, payload: unknown) =>
    appInst.inject({ method: 'POST', url: `/api/actors/${actorId}/roll`, headers: asAnna, payload: payload as object });

  it('rolls a valid pool as the actor and returns the result', async () => {
    const { app, relay } = setup();
    relay.rollResult = { formula: '2d6 + 3', total: 11 };
    const res = await roll(app, 'a1', { formula: '2d6 + 3', flavor: 'Custom roll' });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({ total: 11, formula: '2d6 + 3' });
    expect(relay.rollCalls.at(-1)).toMatchObject({ actorUuid: 'Actor.a1', formula: '2d6 + 3', flavor: 'Custom roll' });
  });

  it('rejects an unsafe formula (422) without touching the relay', async () => {
    const { app, relay } = setup();
    const res = await roll(app, 'a1', { formula: '@abilities.str.mod + 1d20' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_INTENT');
    expect(relay.rollCalls).toHaveLength(0);
  });

  it('404s on a foreign actor', async () => {
    const { app } = setup();
    expect((await roll(app, 'b1', { formula: '1d20' })).statusCode).toBe(404);
  });
});

describe('intents', () => {
  const post = (appInst: FastifyInstance, actorId: string, payload: unknown) =>
    appInst.inject({ method: 'POST', url: `/api/actors/${actorId}/intents`, headers: asAnna, payload: payload as object });

  it('404s on a foreign actor before anything else', async () => {
    const { app } = setup();
    const res = await post(app, 'b1', { kind: 'set', resourceId: 'hp', value: 1 });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('403 FORBIDDEN_RESOURCE for an unknown resource', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'set', resourceId: 'nope', value: 1 });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN_RESOURCE');
    expect(relay.updates).toHaveLength(0);
  });

  it('403 FORBIDDEN_RESOURCE for a read-only resource', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'set', resourceId: 'ac', value: 20 });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN_RESOURCE');
    expect(relay.updates).toHaveLength(0);
  });

  it('422 INVALID_INTENT for a bad payload (unknown kind / non-finite value)', async () => {
    const { app, relay } = setup();
    for (const payload of [
      { kind: 'wibble', resourceId: 'hp', value: 1 },
      { kind: 'set', resourceId: 'hp' },
      { kind: 'set', resourceId: 'hp', value: 'seven' },
      { kind: 'delta', resourceId: 'hp', amount: 1, expected: 'x' },
    ]) {
      const res = await post(app, 'a1', payload);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('INVALID_INTENT');
    }
    expect(relay.updates).toHaveLength(0);
  });

  it('409 CONFLICT with fresh sheet on expected mismatch, and no write', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'delta', resourceId: 'hp', amount: -7, expected: 10 });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe('CONFLICT');
    expect(body.sheet.actorId).toBe('a1');
    expect(body.sheet.resources.find((r: { id: string }) => r.id === 'hp').value).toBe(24);
    expect(relay.updates).toHaveLength(0);
  });

  it('clamps a set over max and writes the dotted path to the actor uuid', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'set', resourceId: 'hp', value: 999, expected: 24 });
    expect(res.statusCode).toBe(200);
    expect(relay.updates).toEqual([{ uuid: 'Actor.a1', data: { 'system.hp.value': 30 } }]);
    expect(res.json().sheet.resources.find((r: { id: string }) => r.id === 'hp').value).toBe(30);
  });

  it('applies a delta (damage) and returns the fresh sheet', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'delta', resourceId: 'hp', amount: -7, expected: 24 });
    expect(res.statusCode).toBe(200);
    expect(relay.updates).toEqual([{ uuid: 'Actor.a1', data: { 'system.hp.value': 17 } }]);
    expect(res.json().sheet.resources.find((r: { id: string }) => r.id === 'hp').value).toBe(17);
  });

  it('clamps below min (heal past 0 stays >= 0)', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'delta', resourceId: 'hp', amount: -100 });
    expect(res.statusCode).toBe(200);
    expect(relay.updates).toEqual([{ uuid: 'Actor.a1', data: { 'system.hp.value': 0 } }]);
  });

  it('targets Actor.<id>.Item.<itemId> for item updates', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'set', resourceId: 'item.i1.qty', value: 150 });
    expect(res.statusCode).toBe(200);
    expect(relay.updates).toEqual([{ uuid: 'Actor.a1.Item.i1', data: { 'system.quantity': 99 } }]);
    expect(res.json().sheet.resources.find((r: { id: string }) => r.id === 'item.i1.qty').value).toBe(99);
  });

  it('429 RATE_LIMITED on the 31st write intent in a minute', async () => {
    const { app } = setup();
    for (let i = 0; i < 30; i++) {
      const res = await post(app, 'a1', { kind: 'delta', resourceId: 'hp', amount: 0 });
      expect(res.statusCode).toBe(200);
    }
    const res31 = await post(app, 'a1', { kind: 'delta', resourceId: 'hp', amount: 0 });
    expect(res31.statusCode).toBe(429);
    expect(res31.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('actions', () => {
  const post = (appInst: FastifyInstance, actorId: string, payload: unknown) =>
    appInst.inject({ method: 'POST', url: `/api/actors/${actorId}/actions`, headers: asAnna, payload: payload as object });

  it('404s on a foreign actor', async () => {
    const { app } = setup();
    const res = await post(app, 'b1', { kind: 'check', actionId: 'skill.ath' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('403 FORBIDDEN_RESOURCE for an actionId not in the adapter list', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'check', actionId: 'skill.nope' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN_RESOURCE');
    expect(relay.rollCalls).toHaveLength(0);
  });

  it('403 FORBIDDEN_RESOURCE when the kind does not match the descriptor', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'attack', actionId: 'skill.ath' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN_RESOURCE');
    expect(relay.rollCalls).toHaveLength(0);
    expect(relay.useAbilityCalls).toHaveLength(0);
  });

  it('403 for every action when the adapter has no action support', async () => {
    await app?.close();
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 24, 30));
    app = buildApp({
      relay,
      players: memoryPlayers(makePlayers()),
      registry: createRegistry([actionlessAdapter]),
      defaultSystemId: 'fake',
      livePollMs: 10_000,
      pingMs: 60_000,
    });
    const res = await post(app, 'a1', { kind: 'check', actionId: 'skill.ath' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN_RESOURCE');
  });

  it('422 INVALID_INTENT for bad payloads (each shape rule)', async () => {
    const { app, relay } = setup();
    for (const payload of [
      { kind: 'check' }, // actionId missing
      { kind: 'check', actionId: 'skill.ath', mode: 'lucky' }, // unknown mode
      { kind: 'cast', actionId: 'spell.s1.cast', slotLevel: 1.5 }, // non-integer
      { kind: 'cast', actionId: 'spell.s1.cast', slotLevel: -1 }, // negative
      { kind: 'cast', actionId: 'spell.s1.cast', slotLevel: 'two' }, // non-number
      { kind: 'equip', actionId: 'item.i1.equip' }, // equipped missing
      { kind: 'equip', actionId: 'item.i1.equip', equipped: 'yes' }, // non-boolean
      { kind: 'attune', actionId: 'item.i1.attune' }, // attuned missing
      { kind: 'attune', actionId: 'item.i1.attune', attuned: 'yes' }, // non-boolean
      { kind: 'damage', actionId: 'item.i1.damage', critical: 'yes' }, // non-boolean crit flag
    ]) {
      const res = await post(app, 'a1', payload);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('INVALID_INTENT');
    }
    expect(relay.rollCalls).toHaveLength(0);
    expect(relay.useAbilityCalls).toHaveLength(0);
    expect(relay.equipCalls).toHaveLength(0);
    expect(relay.attuneCalls).toHaveLength(0);
  });

  it('422 INVALID_INTENT when the adapter rejects an illegal slot level', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.s1.cast', slotLevel: 3 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_INTENT');
    expect(relay.useAbilityCalls).toHaveLength(0);
  });

  it('check -> relay roll speaking as the actor, returns result + fresh sheet', async () => {
    const { app, relay } = setup();
    relay.rollResult = { formula: '1d20 + 6', total: 23, isCritical: false, isFumble: false };
    const res = await post(app, 'a1', { kind: 'check', actionId: 'skill.ath', mode: 'advantage' });
    expect(res.statusCode).toBe(200);
    expect(relay.rollCalls).toEqual([{ actorUuid: 'Actor.a1', formula: '1d20 + 6', flavor: 'Athletics' }]);
    const body = res.json();
    expect(body.result).toEqual({ formula: '1d20 + 6', total: 23, isCritical: false, isFumble: false });
    expect(body.sheet.actorId).toBe('a1');
  });

  it('cast at base slotLevel -> use-spell wire shape, no cast-at-slot call', async () => {
    const { app, relay } = setup();
    relay.useAbilityResult = { roll: { total: 11, formula: '4d6', isCritical: false, isFumble: false } };
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.s1.cast', slotLevel: 1 });
    expect(res.statusCode).toBe(200);
    expect(relay.useAbilityCalls).toEqual([
      { endpoint: 'use-spell', actorUuid: 'Actor.a1', itemUuid: 'Actor.a1.Item.s1', opts: {} },
    ]);
    expect(relay.castAtSlotCalls).toEqual([]);
    expect(res.json().result).toEqual({ total: 11, formula: '4d6', isCritical: false, isFumble: false });
  });

  it('cast with a higher slotLevel routes through cast-at-slot', async () => {
    const { app, relay } = setup();
    relay.castAtSlotResult = { roll: { total: 18, formula: '1d20 + 7', isCritical: false, isFumble: false } };
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.s1.cast', slotLevel: 2 });
    expect(res.statusCode).toBe(200);
    expect(relay.castAtSlotCalls).toEqual([
      { actorUuid: 'Actor.a1', itemUuid: 'Actor.a1.Item.s1', slotKey: 'spell2' },
    ]);
    expect(res.json().result).toEqual({ total: 18, formula: '1d20 + 7', isCritical: false, isFumble: false });
  });

  it('execute-js disabled on the module -> 422 naming the setting', async () => {
    const { app, relay } = setup();
    const err = new Error('execute-js is disabled in REST API module settings. A GM must enable it…');
    err.name = 'RelayError';
    relay.castAtSlotError = err;
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.s1.cast', slotLevel: 2 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/Allow Execute JS/);
  });

  it('MF-1: a generic execute-js failure (script error, not the disabled setting) -> 502, never the disabled toast', async () => {
    const { app, relay } = setup();
    const err = new Error('relay /execute-js -> 500: Error: item not found') as Error & { status: number };
    err.name = 'RelayError';
    err.status = 500;
    relay.castAtSlotError = err;
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.s1.cast', slotLevel: 2 });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).not.toMatch(/Allow Execute JS/);
  });

  it('MF-4a: use-and-roll upcast heal -> 200, castAtSlot called, display roll fires, heal write applied', async () => {
    const { app, relay } = setup();
    relay.rollResult = { formula: '2d8 + 3', total: 14, isCritical: false, isFumble: false };
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.h1.cast', slotLevel: 2 });
    expect(res.statusCode).toBe(200);
    expect(relay.castAtSlotCalls).toEqual([
      { actorUuid: 'Actor.a1', itemUuid: 'Actor.a1.Item.h1', slotKey: 'spell2' },
    ]);
    expect(relay.rollCalls).toEqual([{ actorUuid: 'Actor.a1', formula: '2d8 + 3', flavor: 'Heal' }]);
    expect(res.json().result).toEqual({ total: 14, formula: '2d8 + 3', isCritical: false, isFumble: false });
    expect(relay.updates).toEqual([{ uuid: 'Actor.a1', data: { 'system.attributes.hp.value': 20 } }]);
  });

  it('MF-4a/MF-1: a 408 on the cast-at-slot leg of use-and-roll still returns 200 with the display roll (slot-consumed desync)', async () => {
    const { app, relay } = setup();
    const err = new Error('relay /execute-js -> 408: request timed out') as Error & { status: number };
    err.name = 'RelayError';
    err.status = 408;
    relay.castAtSlotError = err;
    relay.rollResult = { formula: '2d8 + 3', total: 14, isCritical: false, isFumble: false };
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.h1.cast', slotLevel: 2 });
    expect(res.statusCode).toBe(200);
    expect(relay.rollCalls).toEqual([{ actorUuid: 'Actor.a1', formula: '2d8 + 3', flavor: 'Heal' }]);
  });

  it('MF-4a: the disabled-wording error on the cast-at-slot leg of use-and-roll -> 422 naming the setting', async () => {
    const { app, relay } = setup();
    const err = new Error('execute-js is disabled in REST API module settings. A GM must enable it…');
    err.name = 'RelayError';
    relay.castAtSlotError = err;
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.h1.cast', slotLevel: 2 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/Allow Execute JS/);
  });

  describe('noTemplate routing (M-daylight: headless template-cast, 2026-07-20)', () => {
    let relay: FakeRelay;

    /** Minimal caster with one leveled utility spell whose activity carries
     *  an area template (Daylight's live shape: sphere/60) — the same shape
     *  proven in packages/adapter-dnd5e/test/actions.test.ts to make the
     *  REAL dnd5e adapter emit `noTemplate: true`. Using the real adapter
     *  here (not the local fakeAdapter, which has no notion of activities)
     *  means the cast-descriptor gates (prepared: 1, a payable spell3 slot)
     *  are genuinely satisfied, not hand-wired. */
    function templateCasterDoc(): Record<string, unknown> {
      return {
        _id: 'a1',
        name: 'Template Caster',
        type: 'character',
        system: {
          attributes: { hp: { value: 20, max: 20 } },
          spells: { spell3: { value: 2, max: 3 }, spell4: { value: 1, max: 1 } },
        },
        items: [
          {
            _id: 'spellDaylight001',
            name: 'Daylight',
            type: 'spell',
            system: {
              level: 3,
              school: 'evo',
              prepared: 1,
              method: 'spell',
              activities: {
                a1: { _id: 'a1', type: 'utility', target: { template: { type: 'sphere', size: 60 } } },
              },
            },
          },
        ],
      };
    }

    beforeEach(() => {
      relay = new FakeRelay();
      relay.entities.set('Actor.a1', templateCasterDoc());
      app = buildApp({
        relay,
        players: memoryPlayers(makePlayers()),
        registry: createRegistry([dnd5eAdapter]),
        defaultSystemId: 'dnd5e',
        livePollMs: 10_000,
        pingMs: 60_000,
      });
    });

    /** Base-level cast (no slotLevel) of the template spell above — mirrors
     *  the :428 cast test's call shape. */
    const castTemplateSpell = () =>
      post(app as FastifyInstance, 'a1', { kind: 'cast', actionId: 'spell.spellDaylight001.cast' });

    it('a noTemplate use-spell routes through useWithoutTemplate (no module use-* call)', async () => {
      relay.useWithoutTemplateResult = { roll: { total: 12, formula: '1d20 + 5' } };
      const res = await castTemplateSpell();
      expect(res.statusCode).toBe(200);
      expect(relay.useWithoutTemplateCalls).toEqual([
        { actorUuid: expect.stringMatching(/^Actor\./), itemUuid: expect.stringMatching(/\.Item\./) },
      ]);
      expect(relay.useAbilityCalls).toEqual([]);
    });

    it('falls back to the module use-* endpoint when execute-js is unavailable (base-level cast never 422s)', async () => {
      const err = new Error('execute-js is disabled in REST API module settings. A GM must enable it…');
      err.name = 'RelayError';
      relay.useWithoutTemplateError = err;
      const res = await castTemplateSpell();
      expect(res.statusCode).toBe(200);
      expect(relay.useWithoutTemplateCalls).toHaveLength(1); // proves execute-js path was attempted first
      expect(relay.useAbilityCalls).toHaveLength(1); // fell back
    });

    it('a non-config execute-js failure on the noTemplate path stays fatal (502), no silent fallback double-cast risk', async () => {
      const err = new Error('relay /execute-js -> 500: boom');
      err.name = 'RelayError';
      (err as unknown as { status: number }).status = 500;
      relay.useWithoutTemplateError = err;
      const res = await castTemplateSpell();
      expect(res.statusCode).toBe(502);
      expect(relay.useAbilityCalls).toEqual([]);
    });

    it('a 408 on the noTemplate path is tolerated exactly like the module path (200, null result)', async () => {
      const err = new Error('relay /execute-js -> 408: Request timed out');
      err.name = 'RelayError';
      (err as unknown as { status: number }).status = 408;
      relay.useWithoutTemplateError = err;
      const res = await castTemplateSpell();
      expect(res.statusCode).toBe(200);
      expect((res.json() as { result: unknown }).result).toBeNull();
      expect(relay.useAbilityCalls).toEqual([]); // a timeout means it likely executed — never re-cast
    });
  });

  it('damage accepts an integer slotLevel and rejects junk', async () => {
    const { app } = setup();
    const bad = await post(app, 'a1', { kind: 'damage', actionId: 'item.i1.damage', slotLevel: 1.5 });
    expect(bad.statusCode).toBe(422);
  });

  it('damage with critical: true reaches the adapter and rolls the doubled formula', async () => {
    const { app, relay } = setup();
    relay.rollResult = { formula: '2d8 + 3', total: 14, isCritical: false, isFumble: false };
    const res = await post(app, 'a1', { kind: 'damage', actionId: 'item.i1.damage', critical: true });
    expect(res.statusCode).toBe(200);
    expect(relay.rollCalls).toEqual([{ actorUuid: 'Actor.a1', formula: '2d8 + 3', flavor: 'Arrows' }]);
  });

  it('MF-4b: damage forwards slotLevel to the adapter', async () => {
    const { app, relay } = setup();
    relay.rollResult = { formula: '3d8 + 3', total: 16, isCritical: false, isFumble: false };
    const res = await post(app, 'a1', { kind: 'damage', actionId: 'item.i1.damage', slotLevel: 3 });
    expect(res.statusCode).toBe(200);
    expect(relay.rollCalls[0]?.formula).toBe('3d8 + 3');
  });

  it('damage without the flag rolls the plain formula', async () => {
    const { app, relay } = setup();
    relay.rollResult = { formula: '1d8 + 3', total: 7, isCritical: false, isFumble: false };
    const res = await post(app, 'a1', { kind: 'damage', actionId: 'item.i1.damage' });
    expect(res.statusCode).toBe(200);
    expect(relay.rollCalls).toEqual([{ actorUuid: 'Actor.a1', formula: '1d8 + 3', flavor: 'Arrows' }]);
  });

  it('attack -> use-item without a slot level, null result when nothing rolled', async () => {
    const { app, relay } = setup();
    relay.useAbilityResult = { success: true }; // no roll in the response
    const res = await post(app, 'a1', { kind: 'attack', actionId: 'item.i1.attack' });
    expect(res.statusCode).toBe(200);
    expect(relay.useAbilityCalls).toEqual([
      { endpoint: 'use-item', actorUuid: 'Actor.a1', itemUuid: 'Actor.a1.Item.i1', opts: {} },
    ]);
    expect(res.json().result).toBeNull();
  });

  it('attack with mode:advantage forwards to relay as an explicit 2d20kh1 roll, not use-item (PR4 Task 1b)', async () => {
    const { app, relay } = setup();
    relay.rollResult = { formula: '2d20kh1 + 5', total: 19, isCritical: false, isFumble: false };
    const res = await post(app, 'a1', { kind: 'attack', actionId: 'item.i1.attack', mode: 'advantage' });
    expect(res.statusCode).toBe(200);
    expect(relay.rollCalls).toEqual([{ actorUuid: 'Actor.a1', formula: '2d20kh1 + 5', flavor: 'Arrows' }]);
    expect(relay.useAbilityCalls).toHaveLength(0);
    const body = res.json();
    expect(body.result).toEqual({ formula: '2d20kh1 + 5', total: 19, isCritical: false, isFumble: false });
  });

  it('attack with mode:disadvantage forwards to relay as an explicit 2d20kl1 roll (PR4 Task 1b)', async () => {
    const { app, relay } = setup();
    relay.rollResult = { formula: '2d20kl1 + 5', total: 8, isCritical: false, isFumble: false };
    const res = await post(app, 'a1', { kind: 'attack', actionId: 'item.i1.attack', mode: 'disadvantage' });
    expect(res.statusCode).toBe(200);
    expect(relay.rollCalls).toEqual([{ actorUuid: 'Actor.a1', formula: '2d20kl1 + 5', flavor: 'Arrows' }]);
    expect(relay.useAbilityCalls).toHaveLength(0);
  });

  it('422 INVALID_INTENT for an unknown attack mode', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'attack', actionId: 'item.i1.attack', mode: 'lucky' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_INTENT');
    expect(relay.rollCalls).toHaveLength(0);
    expect(relay.useAbilityCalls).toHaveLength(0);
  });

  it('equip -> equip-item with the desired state, result null', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'equip', actionId: 'item.i1.equip', equipped: true });
    expect(res.statusCode).toBe(200);
    expect(relay.equipCalls).toEqual([{ actorUuid: 'Actor.a1', itemUuid: 'Actor.a1.Item.i1', equipped: true }]);
    const body = res.json();
    expect(body.result).toBeNull();
    expect(body.sheet.actorId).toBe('a1');
  });

  it('attune -> attune-item with the desired state, result null', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'attune', actionId: 'item.i1.attune', attuned: true });
    expect(res.statusCode).toBe(200);
    expect(relay.attuneCalls).toEqual([{ actorUuid: 'Actor.a1', itemUuid: 'Actor.a1.Item.i1', attuned: true }]);
    const body = res.json();
    expect(body.result).toBeNull();
    expect(body.sheet.actorId).toBe('a1');
  });

  it('move -> update-item writing system.container, result null', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'move', actionId: 'item.i1.move', containerId: 'c9' });
    expect(res.statusCode).toBe(200);
    expect(relay.updates).toEqual([{ uuid: 'Actor.a1.Item.i1', data: { 'system.container': 'c9' } }]);
    expect((res.json() as { result: unknown }).result).toBeNull();
  });

  it('move to carried sends an empty string; malformed containerId is 422', async () => {
    const { app, relay } = setup();
    const ok = await post(app, 'a1', { kind: 'move', actionId: 'item.i1.move', containerId: null });
    expect(ok.statusCode).toBe(200);
    expect(relay.updates).toEqual([{ uuid: 'Actor.a1.Item.i1', data: { 'system.container': '' } }]);
    for (const bad of [{}, { containerId: '' }, { containerId: 7 }]) {
      const res = await post(app, 'a1', { kind: 'move', actionId: 'item.i1.move', ...bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(422);
    }
  });

  it('rest.short -> short-rest actor command, result null + fresh sheet', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'rest', actionId: 'rest.short' });
    expect(res.statusCode).toBe(200);
    expect(relay.actorCommandCalls).toEqual([{ endpoint: 'short-rest', actorUuid: 'Actor.a1' }]);
    const body = res.json();
    expect(body.result).toBeNull();
    expect(body.sheet.actorId).toBe('a1');
  });

  it('rest.long -> long-rest actor command', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'rest', actionId: 'rest.long' });
    expect(res.statusCode).toBe(200);
    expect(relay.actorCommandCalls).toEqual([{ endpoint: 'long-rest', actorUuid: 'Actor.a1' }]);
    expect(res.json().result).toBeNull();
  });

  it('deathsave.roll -> death-save actor command, result null (no roll total)', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'deathsave', actionId: 'deathsave.roll' });
    expect(res.statusCode).toBe(200);
    expect(relay.actorCommandCalls).toEqual([{ endpoint: 'death-save', actorUuid: 'Actor.a1' }]);
    expect(res.json().result).toBeNull();
  });

  it('concentration.end -> break-concentration actor command', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'endconcentration', actionId: 'concentration.end' });
    expect(res.statusCode).toBe(200);
    expect(relay.actorCommandCalls).toEqual([{ endpoint: 'break-concentration', actorUuid: 'Actor.a1' }]);
    const body = res.json();
    expect(body.result).toBeNull();
    expect(body.sheet.actorId).toBe('a1');
  });

  it('403 when an actor-command kind does not match its descriptor', async () => {
    const { app, relay } = setup();
    // rest.short exists but as kind 'rest', not 'deathsave'.
    const res = await post(app, 'a1', { kind: 'deathsave', actionId: 'rest.short' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN_RESOURCE');
    expect(relay.actorCommandCalls).toHaveLength(0);
  });

  it('actor commands count against the shared write rate limit', async () => {
    const { app } = setup({ rateLimitMax: 2 });
    expect((await post(app, 'a1', { kind: 'rest', actionId: 'rest.short' })).statusCode).toBe(200);
    expect((await post(app, 'a1', { kind: 'deathsave', actionId: 'deathsave.roll' })).statusCode).toBe(200);
    const res3 = await post(app, 'a1', { kind: 'rest', actionId: 'rest.long' });
    expect(res3.statusCode).toBe(429);
    expect(res3.json().error.code).toBe('RATE_LIMITED');
  });

  it('502 UPSTREAM on an actor-command relay failure without leaking secrets', async () => {
    const { app, relay } = setup();
    relay.actionError = true;
    for (const payload of [
      { kind: 'rest', actionId: 'rest.short' },
      { kind: 'deathsave', actionId: 'deathsave.roll' },
      { kind: 'endconcentration', actionId: 'concentration.end' },
    ]) {
      const res = await post(app, 'a1', payload);
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('UPSTREAM');
      expect(res.body).not.toContain(FAKE_API_KEY);
      expect(res.body).not.toContain(FAKE_RELAY_URL);
    }
  });

  it('shares the write rate limit with intents', async () => {
    const { app } = setup({ rateLimitMax: 5 });
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/actors/a1/intents',
        headers: asAnna,
        payload: { kind: 'delta', resourceId: 'hp', amount: 0 },
      });
      expect(res.statusCode).toBe(200);
    }
    for (let i = 0; i < 2; i++) {
      const res = await post(app, 'a1', { kind: 'check', actionId: 'skill.ath' });
      expect(res.statusCode).toBe(200);
    }
    const res6 = await post(app, 'a1', { kind: 'check', actionId: 'skill.ath' });
    expect(res6.statusCode).toBe(429);
    expect(res6.json().error.code).toBe('RATE_LIMITED');
  });

  it('502 UPSTREAM on a relay failure without leaking secrets', async () => {
    const { app, relay } = setup();
    relay.actionError = true;
    for (const payload of [
      { kind: 'check', actionId: 'skill.ath' },
      { kind: 'cast', actionId: 'spell.s1.cast', slotLevel: 1 },
      { kind: 'equip', actionId: 'item.i1.equip', equipped: true },
      { kind: 'attune', actionId: 'item.i1.attune', attuned: true },
    ]) {
      const res = await post(app, 'a1', payload);
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('UPSTREAM');
      expect(res.body).not.toContain(FAKE_API_KEY);
      expect(res.body).not.toContain(FAKE_RELAY_URL);
    }
  });

  /** Adapter stub whose buildAction returns a fixed use-and-roll action. */
  function useAndRollAdapter(action: Record<string, unknown>, actionId = 'feature.sw.use'): SystemAdapter {
    return {
      systemId: 'fake',
      toViewModel: (actor) => ({
        actorId: actor._id,
        systemId: 'fake',
        name: actor.name,
        headline: [],
        sections: [],
        resources: [],
      }),
      resources: () => [],
      buildUpdate: () => {
        throw new IntentError('not used in this test', 'UNKNOWN_RESOURCE');
      },
      actions: () => [{ id: actionId, label: 'Stub', kind: 'use', effectType: 'heal' }],
      buildAction: () => action as never,
    };
  }

  function useAndRollApp(relay: FakeRelay, adapter: SystemAdapter): FastifyInstance {
    return buildApp({
      relay,
      players: memoryPlayers(makePlayers()),
      registry: createRegistry([adapter]),
      defaultSystemId: 'fake',
      livePollMs: 10_000,
      pingMs: 60_000,
    });
  }

  it('use-and-roll -> activates via Foundry first (consumption is its job), rolls, then writes clamped HP', async () => {
    await app?.close();
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 20, 30));
    relay.rollResult = { formula: '1d10 + 5', total: 8, isCritical: false, isFumble: false };
    app = useAndRollApp(
      relay,
      useAndRollAdapter({
        endpoint: 'use-and-roll',
        use: 'use-feature',
        itemId: 'ft1',
        formula: '1d10 + 5',
        flavor: 'Second Wind — Healing',
        heal: { path: 'system.attributes.hp.value', current: 20, max: 30 },
      }),
    );
    const res = await post(app, 'a1', { kind: 'use', actionId: 'feature.sw.use' });
    expect(res.statusCode).toBe(200);
    // Foundry's own activation ran (it consumes the use/slot) BEFORE the roll.
    expect(relay.useAbilityCalls).toEqual([
      { endpoint: 'use-feature', actorUuid: 'Actor.a1', itemUuid: 'Actor.a1.Item.ft1', opts: {} },
    ]);
    expect(relay.rollCalls).toEqual([{ actorUuid: 'Actor.a1', formula: '1d10 + 5', flavor: 'Second Wind — Healing' }]);
    expect(relay.updates).toEqual([{ uuid: 'Actor.a1', data: { 'system.attributes.hp.value': 28 } }]);
    expect(res.json().result).toEqual({ total: 8, formula: '1d10 + 5', isCritical: false, isFumble: false });
  });

  it('use-and-roll clamps the written HP to max, never overhealing', async () => {
    await app?.close();
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 28, 30));
    relay.rollResult = { formula: '1d10 + 5', total: 8, isCritical: false, isFumble: false };
    app = useAndRollApp(
      relay,
      useAndRollAdapter({
        endpoint: 'use-and-roll',
        use: 'use-feature',
        itemId: 'ft1',
        formula: '1d10 + 5',
        flavor: 'Second Wind — Healing',
        heal: { path: 'system.attributes.hp.value', current: 28, max: 30 },
      }),
    );
    const res = await post(app, 'a1', { kind: 'use', actionId: 'feature.sw.use' });
    expect(res.statusCode).toBe(200);
    expect(relay.updates).toEqual([{ uuid: 'Actor.a1', data: { 'system.attributes.hp.value': 30 } }]);
  });

  it('use-and-roll without a heal field activates and rolls but never writes HP (target-chosen heal)', async () => {
    await app?.close();
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 20, 30));
    relay.rollResult = { formula: '1d8 + 2', total: 7, isCritical: false, isFumble: false };
    app = useAndRollApp(
      relay,
      useAndRollAdapter(
        {
          endpoint: 'use-and-roll',
          use: 'use-spell',
          itemId: 's1',
          formula: '1d8 + 2',
          flavor: 'Cure Wounds — Healing',
        },
        'spell.cw.cast',
      ),
    );
    // The stub descriptor still uses kind 'use' — reuse it for the POST.
    const res = await post(app, 'a1', { kind: 'use', actionId: 'spell.cw.cast' });
    expect(res.statusCode).toBe(200);
    // Slot consumption is Foundry's job via the use-spell activation…
    expect(relay.useAbilityCalls).toEqual([
      { endpoint: 'use-spell', actorUuid: 'Actor.a1', itemUuid: 'Actor.a1.Item.s1', opts: {} },
    ]);
    // …and no HP (or any other) write happens for a target-chosen heal.
    expect(relay.updates).toEqual([]);
    expect(relay.deleteCalls).toEqual([]);
    expect(res.json().result).toEqual({ total: 7, formula: '1d8 + 2', isCritical: false, isFumble: false });
  });

  it('use-and-roll tolerates a relay 408 on the activation and still rolls (M16: Foundry UI wait)', async () => {
    // Live-verified 2026-07-10: Bead of Force's use-item times out at the
    // relay while Foundry waits on the area-template prompt — consumption
    // has already completed by then, so the display roll must still fire.
    await app?.close();
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 20, 30));
    relay.useAbilityTimeout = true;
    relay.rollResult = { formula: '5d4', total: 11, isCritical: false, isFumble: false };
    app = useAndRollApp(
      relay,
      useAndRollAdapter(
        { endpoint: 'use-and-roll', use: 'use-item', itemId: 'i1', formula: '5d4', flavor: 'Bead of Force — Damage' },
        'item.i1.use',
      ),
    );
    const res = await post(app, 'a1', { kind: 'use', actionId: 'item.i1.use' });
    expect(res.statusCode).toBe(200);
    expect(relay.useAbilityCalls).toHaveLength(1);
    expect(res.json().result).toEqual({ total: 11, formula: '5d4', isCritical: false, isFumble: false });
  });

  it('use-and-roll stays fatal on non-timeout activation failures', async () => {
    await app?.close();
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 20, 30));
    relay.actionError = true; // generic relay failure, not a 408
    app = useAndRollApp(
      relay,
      useAndRollAdapter(
        { endpoint: 'use-and-roll', use: 'use-item', itemId: 'i1', formula: '5d4', flavor: 'Bead of Force — Damage' },
        'item.i1.use',
      ),
    );
    const res = await post(app, 'a1', { kind: 'use', actionId: 'item.i1.use' });
    expect(res.statusCode).toBe(502);
    // The roll never fires when the activation genuinely failed.
    expect(relay.rollCalls).toEqual([]);
    expect(res.body).not.toContain(FAKE_API_KEY);
  });

  it('casting a self-buff activates then applies a flagged effect', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.b1.cast', slotLevel: 1 });
    expect(res.statusCode).toBe(200);
    expect(relay.useAbilityCalls).toEqual([
      { endpoint: 'use-spell', actorUuid: 'Actor.a1', itemUuid: 'Actor.a1.Item.b1', opts: {} },
    ]);
    expect(relay.applyEffectCalls).toHaveLength(1);
    const eff = relay.applyEffectCalls[0]!.effect;
    expect(eff.name).toBe('Shield');
    expect(/^[A-Za-z0-9]{16}$/.test(String(eff._id))).toBe(true);
    expect((eff.flags as Record<string, Record<string, unknown>>)['unseen-servent']!.appliedBy).toBe('app');
  });

  it('endeffect removes the active effect by uuid', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'endeffect', actionId: 'effect.aeFake0000000001.remove' });
    expect(res.statusCode).toBe(200);
    expect(relay.deleteCalls).toContain('Actor.a1.ActiveEffect.aeFake0000000001');
  });

  it('endeffect surfaces a failed removal as a 502, not a false-success toast', async () => {
    const { app, relay } = setup();
    relay.deleteEntityResult = false;
    const res = await post(app, 'a1', { kind: 'endeffect', actionId: 'effect.aeFake0000000001.remove' });
    expect(res.statusCode).toBe(502);
  });

  it('casting a self-buff tolerates a relay 408 on activation and still applies the effect (M16)', async () => {
    const { app, relay } = setup();
    relay.useAbilityTimeout = true;
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.b1.cast', slotLevel: 1 });
    expect(res.statusCode).toBe(200);
    expect(relay.applyEffectCalls).toHaveLength(1);
  });

  it('cast-and-apply-effect applies to a party targetActorId', async () => {
    const { app, relay } = setup(); // players own a1 (Anna, caster) and b1 (Bob) — both in the party union
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.b1.cast', slotLevel: 1, targetActorId: 'b1' });
    expect(res.statusCode).toBe(200);
    expect(relay.applyEffectCalls.at(-1)!.actorUuid).toBe('Actor.b1');
  });

  it('a targetActorId outside combat + party is refused 403', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.b1.cast', slotLevel: 1, targetActorId: 'STRANGERACTORXX' });
    expect(res.statusCode).toBe(403);
    expect(relay.applyEffectCalls.every((c) => c.actorUuid !== 'Actor.STRANGERACTORXX')).toBe(true);
    // The gate runs before activation: a forbidden target must never burn the caster's slot.
    expect(relay.useAbilityCalls).toHaveLength(0);
    expect(relay.castAtSlotCalls).toHaveLength(0);
    expect(relay.applyEffectCalls).toHaveLength(0);
  });

  it('cast-and-apply-effect applies to a combatant that is not a party member', async () => {
    const encounters = {
      view: () => ({ active: true, combatants: [{ id: 'c1', actorId: 'monsterX000000001' }] }),
    } as unknown as EncounterManagerPort;
    const { app, relay } = setup({ encounters });
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.b1.cast', slotLevel: 1, targetActorId: 'monsterX000000001' });
    expect(res.statusCode).toBe(200);
    expect(relay.applyEffectCalls.at(-1)!.actorUuid).toBe('Actor.monsterX000000001');
  });

  it('no targetActorId applies to the caster', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.b1.cast', slotLevel: 1 });
    expect(res.statusCode).toBe(200);
    expect(relay.applyEffectCalls.at(-1)!.actorUuid).toBe('Actor.a1');
  });

  it('rejects a malformed targetActorId (422)', async () => {
    const { app } = setup();
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.b1.cast', slotLevel: 1, targetActorId: 'bad id!' });
    expect(res.statusCode).toBe(422);
  });

  it('a bare base-slot cast tolerates a relay 408 on useAbility and returns 200 with a null result (2026-07-19 fix)', async () => {
    // Live-confirmed: the cast DID execute in Foundry, but the relay's
    // response was slow — this must not surface as a 502 (which would
    // invite a double-cast retry). No roll pill to show, but the re-fetched
    // sheet reflects the new state.
    const { app, relay } = setup();
    relay.useAbilityTimeout = true;
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.s1.cast', slotLevel: 1 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result).toBeNull();
    expect(body.sheet.actorId).toBe('a1');
  });

  it('cast-at-slot tolerates a relay 408 and returns 200 with a null result (2026-07-19 fix)', async () => {
    const { app, relay } = setup();
    const err = new Error('relay /execute-js -> 408: request timed out') as Error & { status: number };
    err.name = 'RelayError';
    err.status = 408;
    relay.castAtSlotError = err;
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.s1.cast', slotLevel: 2 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result).toBeNull();
    expect(body.sheet.actorId).toBe('a1');
  });
});

// ---------------------------------------------------------------------------
// 2026-07-22 in-combat targeting: use-on-targets action route. The visible
// encounter roster (tokenUuid-keyed) is the whole legal target surface —
// hidden combatants never reach view(), so they're untargetable by
// construction. Every relay leg here is side-effecting (Foundry may already
// have applied damage) so a 408 must map to 502 with NO retry, never a bare
// timeout that invites a double-execution.
describe('targeted actions (use-on-targets)', () => {
  let mgr: EncounterManager | null = null;

  const post = (appInst: FastifyInstance, actorId: string, payload: unknown) =>
    appInst.inject({ method: 'POST', url: `/api/actors/${actorId}/actions`, headers: asAnna, payload: payload as object });

  afterEach(() => {
    if (mgr) mgr.stop();
    mgr = null;
  });

  /** Gateway app wired to a live encounter: Hero (a1, the caster's own
   *  combatant) and Skeleton, both with tokenUuids — the roster use-on-targets
   *  validates against. */
  async function setupWithEncounter(): Promise<{ app: FastifyInstance; relay: FakeRelay }> {
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 24, 30));
    relay.encounters = [
      {
        id: 'c1',
        round: 1,
        turn: 0,
        current: true,
        combatants: [
          { id: 'comb1', name: 'Hero', actorUuid: 'Actor.a1', tokenUuid: 'Scene.s1.Token.t1', initiative: 15 },
          { id: 'comb2', name: 'Skeleton', tokenUuid: 'Scene.s1.Token.t2', initiative: 10 },
        ],
      },
    ];
    mgr = new EncounterManager({ relay, fetchTimeoutMs: 50 });
    await mgr.start();
    app = buildApp({
      relay,
      players: memoryPlayers(makePlayers()),
      registry: createRegistry([fakeAdapter]),
      defaultSystemId: 'fake',
      livePollMs: 10_000,
      pingMs: 60_000,
      encounters: mgr,
    });
    return { app, relay };
  }

  it('POST actions with targets executes use-on-targets and returns the outcome', async () => {
    const { app, relay } = await setupWithEncounter();
    relay.useOnTargetsResult = {
      attack: { total: 19, formula: '1d20+7', isCritical: false, isFumble: false },
      targets: [
        {
          tokenUuid: 'Scene.s1.Token.t2',
          name: 'Skeleton',
          outcome: 'hit',
          damage: { rolled: [{ type: 'slashing', value: 12 }], applied: 6 },
        },
      ],
    };
    const res = await post(app, 'a1', {
      kind: 'attack',
      actionId: 'item.i1.tattack',
      targetTokenUuids: ['Scene.s1.Token.t2'],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { outcome?: { targets: Array<{ outcome: string }> }; result: unknown };
    expect(body.outcome?.targets[0]?.outcome).toBe('hit');
    expect((body.result as { total: number }).total).toBe(19); // attack feeds the roll pill
    expect(relay.useOnTargetsCalls[0]?.opts.targetTokenUuids).toEqual(['Scene.s1.Token.t2']);
  });

  it('a multi-target save spell forwards slotKey through use-on-targets', async () => {
    const { app, relay } = await setupWithEncounter();
    relay.useOnTargetsResult = {
      attack: null,
      targets: [{ tokenUuid: 'Scene.s1.Token.t2', name: 'Skeleton', outcome: 'save-failed' }],
    };
    const res = await post(app, 'a1', {
      kind: 'cast',
      actionId: 'spell.f1.cast',
      slotLevel: 4,
      targetTokenUuids: ['Scene.s1.Token.t2'],
    });
    expect(res.statusCode).toBe(200);
    expect(relay.useOnTargetsCalls[0]?.opts).toEqual({ targetTokenUuids: ['Scene.s1.Token.t2'], slotKey: 'spell4' });
    const body = res.json() as { outcome?: unknown; result: unknown };
    expect(body.outcome).toEqual({
      attack: null,
      targets: [{ tokenUuid: 'Scene.s1.Token.t2', name: 'Skeleton', outcome: 'save-failed' }],
    });
    expect(body.result).toBeNull(); // no attack roll on a save spell -> no roll pill
  });

  it('rejects a target not in the visible encounter roster (403)', async () => {
    const { app, relay } = await setupWithEncounter();
    const res = await post(app, 'a1', {
      kind: 'attack',
      actionId: 'item.i1.tattack',
      targetTokenUuids: ['Scene.s1.Token.tX'],
    });
    expect(res.statusCode).toBe(403);
    expect(relay.useOnTargetsCalls).toHaveLength(0); // gate BEFORE the relay call
  });

  it('rejects targeted actions when no encounter is active (409)', async () => {
    const { app } = setup(); // harness without encounters wired at all
    const res = await post(app, 'a1', {
      kind: 'attack',
      actionId: 'item.i1.tattack',
      targetTokenUuids: ['Scene.s1.Token.t2'],
    });
    expect(res.statusCode).toBe(409);
  });

  it('maps a relay 408 to 502 with the check-Foundry-chat message and NO retry', async () => {
    const { app, relay } = await setupWithEncounter();
    relay.useOnTargetsTimeout = true;
    const res = await post(app, 'a1', {
      kind: 'attack',
      actionId: 'item.i1.tattack',
      targetTokenUuids: ['Scene.s1.Token.t2'],
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: { message: string } }).error.message).toBe(
      'Timed out — check the Foundry chat before retrying.',
    );
    expect(relay.useOnTargetsCalls).toHaveLength(1); // exactly one attempt
  });

  it('parseActionIntent rejects malformed target lists (422)', async () => {
    const { app } = setup();
    for (const bad of [
      ['not-a-uuid'],
      [],
      ['Scene.s1.Token.t2', 'Scene.s1.Token.t2'],
      Array.from({ length: 13 }, (_, i) => `Scene.s1.Token.t${i}`),
    ]) {
      const res = await post(app, 'a1', { kind: 'attack', actionId: 'item.i1.tattack', targetTokenUuids: bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(422);
    }
  });

  it('a single-target action rejects more than one target (422 via IntentError INVALID)', async () => {
    const { app } = await setupWithEncounter();
    const res = await post(app, 'a1', {
      kind: 'attack',
      actionId: 'item.i1.tattack',
      targetTokenUuids: ['Scene.s1.Token.t1', 'Scene.s1.Token.t2'],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_INTENT');
  });
});

// ---------------------------------------------------------------------------
// 2026-07-22 in-combat targeting: end-turn route. Only the acting combatant's
// owner may advance the turn — the GM keeps NPC turns in Foundry. The relay
// script itself re-checks who's acting (race-guard), so a stale end-turn
// (e.g. a double-tap) must degrade to 409, not silently skip someone else.
describe('turn flow (POST /api/encounter/turn/end)', () => {
  let mgr: EncounterManager | null = null;
  const asBob = { authorization: `Bearer ${BOB_TOKEN}` };

  afterEach(() => {
    if (mgr) mgr.stop();
    mgr = null;
  });

  /** Gateway app wired to a live encounter with comb1 (actor a1, owned by
   *  Anna) as the acting combatant — same seed shape as the targeted-actions
   *  harness above. */
  async function setupWithEncounter(): Promise<{ app: FastifyInstance; relay: FakeRelay }> {
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 24, 30));
    relay.encounters = [
      {
        id: 'c1',
        round: 1,
        turn: 0,
        current: true,
        combatants: [
          { id: 'comb1', name: 'Hero', actorUuid: 'Actor.a1', tokenUuid: 'Scene.s1.Token.t1', initiative: 15 },
          { id: 'comb2', name: 'Skeleton', tokenUuid: 'Scene.s1.Token.t2', initiative: 10 },
        ],
      },
    ];
    mgr = new EncounterManager({ relay, fetchTimeoutMs: 50 });
    await mgr.start();
    const encApp = buildApp({
      relay,
      players: memoryPlayers(makePlayers()),
      registry: createRegistry([fakeAdapter]),
      defaultSystemId: 'fake',
      livePollMs: 10_000,
      pingMs: 60_000,
      encounters: mgr,
      // Final-review Fix 4: turnEndTimeoutMs defaults to 15s (execute-js is
      // slower than a REST fetch) — kept small here so the stalled-relay
      // test below doesn't have to actually wait 15s.
      turnEndTimeoutMs: 50,
    });
    return { app: encApp, relay };
  }

  it('the acting player ends their turn', async () => {
    const { app: encApp, relay } = await setupWithEncounter();
    const res = await encApp.inject({ method: 'POST', url: '/api/encounter/turn/end', headers: asAnna });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(relay.endTurnCalls).toEqual(['comb1']);
  });

  it('a player who does not own the acting combatant gets 403', async () => {
    const { app: encApp, relay } = await setupWithEncounter();
    const res = await encApp.inject({ method: 'POST', url: '/api/encounter/turn/end', headers: asBob });
    expect(res.statusCode).toBe(403);
    expect(relay.endTurnCalls).toHaveLength(0);
  });

  it('no active encounter -> 409', async () => {
    // Manager constructed and wired, but relay has no combats -> inactive
    // (distinct from encounterManager being entirely absent, which would
    // 404 instead — the turn/end route lives inside `if (encounterManager)`).
    const relay = new FakeRelay();
    mgr = new EncounterManager({ relay, fetchTimeoutMs: 50 });
    await mgr.start();
    const encApp = buildApp({
      relay,
      players: memoryPlayers(makePlayers()),
      registry: createRegistry([fakeAdapter]),
      defaultSystemId: 'fake',
      livePollMs: 10_000,
      pingMs: 60_000,
      encounters: mgr,
    });
    const res = await encApp.inject({ method: 'POST', url: '/api/encounter/turn/end', headers: asAnna });
    expect(res.statusCode).toBe(409);
  });

  it('turn race (script refuses) -> 409', async () => {
    const { app: encApp, relay } = await setupWithEncounter();
    relay.endTurnResult = { advanced: false, reason: 'not-your-turn' };
    const res = await encApp.inject({ method: 'POST', url: '/api/encounter/turn/end', headers: asAnna });
    expect(res.statusCode).toBe(409);
  });

  it('stalled relay -> 502 (bounded)', async () => {
    const { app: encApp, relay } = await setupWithEncounter();
    relay.hangEndTurn = true;
    const res = await encApp.inject({ method: 'POST', url: '/api/encounter/turn/end', headers: asAnna });
    expect(res.statusCode).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// 2026-07-22 combat-targeting §F4: per-turn movement budget, dash, and
// own-turn move gating. Combines the movement-route scene/token harness
// (GET/POST /api/actors/:id/movement above) with the EncounterManager-over-
// FakeRelay harness (turn flow above) — actor a1 is combatant comb1, acting
// first (initiative 15 > comb2's 10), token at grid cell (3,2), speed 30ft.
describe('movement budget + dash (in combat)', () => {
  let mgr: EncounterManager | null = null;

  afterEach(() => {
    if (mgr) mgr.stop();
    mgr = null;
  });

  const tok = (id: string, actorId: string | null, x: number, y: number, extra: Record<string, unknown> = {}) =>
    ({ _id: id, name: `tok-${id}`, x, y, width: 1, height: 1, hidden: false, disposition: 0, actorId, ...extra });
  const squareScene = (tokens: Array<ReturnType<typeof tok>>) =>
    ({ _id: 's1', name: 'Crypt', grid: { type: 1, size: 100, distance: 5, units: 'ft' }, tokens });

  /** Raw Foundry Combat doc combatant shape for updateCombat hook frames
   *  (bare actorId — see encounters.ts normalizeHookCombatant). */
  const combatant = (id: string, actorId: string | undefined, initiative: number) =>
    ({ _id: id, actorId, initiative, hidden: false, defeated: false, img: null, tokenId: null });

  async function setupWithEncounter(): Promise<{ app: FastifyInstance; relay: FakeRelay }> {
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 24, 30));
    relay.systemDetails = { stats: { speed: 30 } };
    relay.scene = squareScene([tok('t1', 'a1', 300, 200), tok('t2', 'm1', 500, 200)]);
    relay.encounters = [
      {
        id: 'c1',
        round: 1,
        turn: 0,
        current: true,
        combatants: [
          { id: 'comb1', name: 'Hero', actorUuid: 'Actor.a1', tokenUuid: 'Scene.s1.Token.t1', initiative: 15 },
          { id: 'comb2', name: 'Skeleton', tokenUuid: 'Scene.s1.Token.t2', initiative: 10 },
        ],
      },
    ];
    mgr = new EncounterManager({ relay, fetchTimeoutMs: 50 });
    await mgr.start();
    const encApp = buildApp({
      relay,
      players: memoryPlayers(makePlayers()),
      registry: createRegistry([fakeAdapter]),
      defaultSystemId: 'fake',
      livePollMs: 10_000,
      pingMs: 60_000,
      movementTimeoutMs: 50,
      encounters: mgr,
    });
    return { app: encApp, relay };
  }

  const post = (appInst: FastifyInstance, id: string, body: unknown) =>
    appInst.inject({
      method: 'POST',
      url: `/api/actors/${id}/movement`,
      headers: { ...asAnna, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });

  it('GET movement reports combat budget fields', async () => {
    const { app: encApp } = await setupWithEncounter();
    const res = await encApp.inject({ method: 'GET', url: '/api/actors/a1/movement', headers: asAnna });
    const mv = (res.json() as { movement: Record<string, unknown> }).movement;
    expect(mv.inCombat).toBe(true);
    expect(mv.yourTurn).toBe(true);
    expect(mv.remainingFt).toBe(30);
    expect(mv.dashed).toBe(false);
  });

  it('moves consume the budget; beyond remaining -> 422, exactly-remaining -> 200', async () => {
    const { app: encApp } = await setupWithEncounter();
    // FakeRelay.moveToken never mutates relay.scene, so the token's cell as
    // read back by fetchMovementContext stays at its original (3,2) for every
    // POST in this test — only the budget tracker's spend advances. First
    // move: 4 cells (20ft) from (3,2) to (7,2), leaving 10ft (2 cells) of the
    // 30ft budget.
    const moved = await post(encApp, 'a1', { cx: 7, cy: 2 });
    expect(moved.statusCode).toBe(200);
    const after = await encApp.inject({ method: 'GET', url: '/api/actors/a1/movement', headers: asAnna });
    expect((after.json() as { movement: { remainingFt: number } }).movement.remainingFt).toBe(10);
    // Every subsequent move is still measured from the same origin (3,2) —
    // moving along cy avoids the occupied (5,2) cell (tok t2). A 3-cell move
    // (15ft) exceeds the 10ft (2-cell) remaining budget -> 422.
    const tooFar = await post(encApp, 'a1', { cx: 3, cy: 5 });
    expect(tooFar.statusCode).toBe(422);
    // A 2-cell move (10ft) exactly consumes what's left -> 200 (tight boundary).
    const exact = await post(encApp, 'a1', { cx: 3, cy: 4 });
    expect(exact.statusCode).toBe(200);
  });

  it('moving off-turn in combat -> 409', async () => {
    const { app: encApp, relay } = await setupWithEncounter();
    // flip the turn to comb2 (Skeleton) — Anna's actor a1/comb1 is no longer acting.
    relay.emitUpdateCombat({
      _id: 'c1',
      round: 1,
      turn: 1,
      scene: 's1',
      combatants: [combatant('comb1', 'a1', 15), combatant('comb2', undefined, 10)],
    });
    const res = await post(encApp, 'a1', { cx: 4, cy: 2 });
    expect(res.statusCode).toBe(409);
  });

  // Final-review Fix 1: current() (and thus mgr.current()) is null whenever
  // the acting combatant is hidden, not only when combat is inactive. Before
  // the fix, combatMoveContext conflated the two and returned
  // {inCombat:false} — free movement, no budget spend, no own-turn 409 —
  // during a hidden NPC's turn. It must behave exactly like off-turn instead.
  it('moving during a hidden NPC turn -> 409 (POST) and inCombat/yourTurn:false (GET)', async () => {
    const { app: encApp, relay } = await setupWithEncounter();
    // Acting combatant (turn index 0 in initiative-desc order) is a hidden
    // NPC with higher initiative than Anna's comb1 (15) — comb1 stays visible.
    relay.emitUpdateCombat({
      _id: 'c1',
      round: 1,
      turn: 0,
      scene: 's1',
      combatants: [
        { _id: 'hiddenNpc', actorId: 'npc1', initiative: 20, hidden: true, defeated: false, img: null, tokenId: null },
        combatant('comb1', 'a1', 15),
      ],
    });
    const res = await post(encApp, 'a1', { cx: 4, cy: 2 });
    expect(res.statusCode).toBe(409);
    const get = await encApp.inject({ method: 'GET', url: '/api/actors/a1/movement', headers: asAnna });
    const mv = (get.json() as { movement: Record<string, unknown> }).movement;
    expect(mv.inCombat).toBe(true);
    expect(mv.yourTurn).toBe(false);
  });

  it('dash doubles the budget once and posts a chat note', async () => {
    const { app: encApp, relay } = await setupWithEncounter();
    const res = await encApp.inject({ method: 'POST', url: '/api/actors/a1/movement/dash', headers: asAnna });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { movement: { remainingFt: number; dashed: boolean } }).movement)
      .toMatchObject({ remainingFt: 60, dashed: true });
    expect(relay.chatNoteCalls).toHaveLength(1);
    const again = await encApp.inject({ method: 'POST', url: '/api/actors/a1/movement/dash', headers: asAnna });
    expect(again.statusCode).toBe(409);
  });

  it('dash still succeeds when the best-effort chat note rejects', async () => {
    const { app: encApp, relay } = await setupWithEncounter();
    relay.chatNoteError = true;
    const res = await encApp.inject({ method: 'POST', url: '/api/actors/a1/movement/dash', headers: asAnna });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { movement: { remainingFt: number; dashed: boolean } }).movement)
      .toMatchObject({ remainingFt: 60, dashed: true });
  });

  it('a new round refills the budget (lazy reset)', async () => {
    const { app: encApp, relay } = await setupWithEncounter();
    await post(encApp, 'a1', { cx: 7, cy: 2 });
    relay.emitUpdateCombat({
      _id: 'c1',
      round: 2,
      turn: 0,
      scene: 's1',
      combatants: [combatant('comb1', 'a1', 15), combatant('comb2', undefined, 10)],
    });
    const res = await encApp.inject({ method: 'GET', url: '/api/actors/a1/movement', headers: asAnna });
    expect((res.json() as { movement: { remainingFt: number } }).movement.remainingFt).toBe(30);
  });

  it('out of combat the movement view carries no budget fields', async () => {
    const { app: plainApp, relay } = setup({ movementTimeoutMs: 50 });
    relay.systemDetails = { stats: { speed: 30 } };
    relay.scene = squareScene([tok('t1', 'a1', 300, 200)]);
    const res = await plainApp.inject({ method: 'GET', url: '/api/actors/a1/movement', headers: asAnna });
    const mv = (res.json() as { movement: Record<string, unknown> }).movement;
    expect(mv).toEqual({
      onScene: true, sceneId: 's1', gridDistance: 5, gridUnits: 'ft', speedFt: 30,
      token: { cx: 3, cy: 2 }, others: [],
    });
    expect(mv.inCombat).toBeUndefined();
    expect(mv.remainingFt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// M23 review fix: parseActionIntent had no 'pool'/'rouse' cases, so the real
// wod5e adapter's pool rolls and rouse checks 422'd at the gateway before
// ever reaching buildAction. Uses the REAL wod5eAdapter (not fakeAdapter)
// against the Task 0 captured fixture so the asserted formulas are exact,
// not fake-adapter stand-ins.
describe('actions (M23 wod5e) — pool/rouse intent parsing (review fix)', () => {
  const MARIUS_UUID_ID = 'SGeXzzb4NApPhTJf';
  const marius = (vampireCapturedJson as { data: Record<string, unknown> }).data;

  function setupWod5e(): { app: FastifyInstance; relay: FakeRelay } {
    const relay = new FakeRelay();
    relay.entities.set(`Actor.${MARIUS_UUID_ID}`, structuredClone(marius));
    const players: Player[] = [{ name: 'Anna', tokenHash: sha256Hex(ANNA_TOKEN), actorIds: [MARIUS_UUID_ID] }];
    const wod5eApp = buildApp({
      relay,
      players: memoryPlayers(players),
      registry: createRegistry([wod5eAdapter]),
      defaultSystemId: 'wod5e',
      livePollMs: 10_000,
      pingMs: 60_000,
    });
    return { app: wod5eApp, relay };
  }

  const post = (appInst: FastifyInstance, payload: unknown) =>
    appInst.inject({
      method: 'POST',
      url: `/api/actors/${MARIUS_UUID_ID}/actions`,
      headers: asAnna,
      payload: payload as object,
    });

  it('pool by attribute -> 200, relay roll formula matches the adapter (strength 3 dice, hunger 2)', async () => {
    const { app: wod5eApp, relay } = setupWod5e();
    const res = await post(wod5eApp, { kind: 'pool', actionId: 'pool.attr.strength', attribute: 'attr.strength' });
    expect(res.statusCode).toBe(200);
    // Fixture: attributes.strength.value 3, no skill/discipline component ->
    // dice = max(1, 3+0+0) = 3. hunger.value 2, actor.type 'vampire' ->
    // hunger dice = min(2, 3) = 2; normal = 3 - 2 = 1 -> "1d10cs>=6 + 2d10cs>=6".
    expect(relay.rollCalls).toEqual([
      {
        actorUuid: `Actor.${MARIUS_UUID_ID}`,
        formula: '1d10cs>=6 + 2d10cs>=6',
        flavor: 'Strength (3 dice, 2 hunger)',
      },
    ]);
    await wod5eApp.close();
  });

  it('pool with skill + modifier -> 200, exact formula', async () => {
    const { app: wod5eApp, relay } = setupWod5e();
    // pool.skill.brawl's default pairing is attr.dexterity + skill.brawl
    // (no override sent): dexterity.value 2 + brawl.value 2 + modifier 3 =
    // 7 dice. hunger.value 2 -> hunger dice = min(2, 7) = 2; normal = 5 ->
    // "5d10cs>=6 + 2d10cs>=6".
    const res = await post(wod5eApp, { kind: 'pool', actionId: 'pool.skill.brawl', modifier: 3 });
    expect(res.statusCode).toBe(200);
    expect(relay.rollCalls).toEqual([
      {
        actorUuid: `Actor.${MARIUS_UUID_ID}`,
        formula: '5d10cs>=6 + 2d10cs>=6',
        flavor: 'Dexterity + Brawl (7 dice, 2 hunger)',
      },
    ]);
    await wod5eApp.close();
  });

  it('rouse -> 200, relay roll formula "1d10cs>=6"', async () => {
    const { app: wod5eApp, relay } = setupWod5e();
    const res = await post(wod5eApp, { kind: 'rouse', actionId: 'rouse' });
    expect(res.statusCode).toBe(200);
    expect(relay.rollCalls).toEqual([
      { actorUuid: `Actor.${MARIUS_UUID_ID}`, formula: '1d10cs>=6', flavor: 'Rouse Check' },
    ]);
    await wod5eApp.close();
  });

  it('422 INVALID_INTENT when modifier is not a number', async () => {
    const { app: wod5eApp, relay } = setupWod5e();
    const res = await post(wod5eApp, {
      kind: 'pool',
      actionId: 'pool.attr.strength',
      modifier: 'lots',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_INTENT');
    expect(relay.rollCalls).toHaveLength(0);
    await wod5eApp.close();
  });

  it('403 FORBIDDEN_RESOURCE for an unknown pool actionId (gateway allow-list, before buildAction)', async () => {
    const { app: wod5eApp, relay } = setupWod5e();
    const res = await post(wod5eApp, { kind: 'pool', actionId: 'pool.attr.nope' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN_RESOURCE');
    expect(relay.rollCalls).toHaveLength(0);
    await wod5eApp.close();
  });
});

describe('SSE events', () => {
  async function readUntil(stream: EventStream, predicate: (buf: string) => boolean, timeoutMs = 3000): Promise<string> {
    let buf = '';
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SSE timeout; got: ${buf}`)), timeoutMs);
      const onData = (chunk: unknown): void => {
        buf += String(chunk);
        if (predicate(buf)) {
          clearTimeout(timer);
          stream.off('data', onData);
          resolve(buf);
        }
      };
      stream.on('data', onData);
      stream.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      stream.on('end', () => {
        clearTimeout(timer);
        if (predicate(buf)) resolve(buf);
        else reject(new Error(`SSE stream ended; got: ${buf}`));
      });
    });
  }

  it('401s without a token', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/actors/a1/events' });
    expect(res.statusCode).toBe(401);
  });

  it('404s for a foreign actor', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: `/api/actors/b1/events?token=${ANNA_TOKEN}` });
    expect(res.statusCode).toBe(404);
  });

  it('accepts ?token=, streams the initial sheet event, then pushes changes', async () => {
    const { app, relay } = setup();
    const res = await app.inject({
      method: 'GET',
      url: `/api/actors/a1/events?token=${ANNA_TOKEN}`,
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const stream = res.stream() as unknown as EventStream;

    const initial = await readUntil(stream, (b) => b.includes('event: sheet') && b.includes('"actorId":"a1"'));
    expect(initial).toContain('"actorId":"a1"');
    expect(initial).not.toContain(FAKE_API_KEY);

    // Wait for the shared world-level hooks stream, then simulate a GM edit + relay push.
    for (let i = 0; i < 100 && relay.hookSubscribers.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(relay.hookSubscribers.size).toBe(1);
    expect(relay.hookSubscriptions[0]).toEqual(['updateActor', 'createItem', 'updateItem', 'deleteItem']);
    relay.mutate('Actor.a1', 'system.hp.value', 5);
    relay.emitUpdateActor('a1');

    const updated = await readUntil(stream, (b) => b.includes('"value":5'));
    expect(updated).toContain('event: sheet');

    stream.destroy();
  });

  // inject() cannot simulate a client hang-up (destroying its payload stream
  // never reaches the server socket), so this one runs over a real socket.
  it('releases the shared relay subscription when the last SSE client disconnects', async () => {
    const { app, relay } = setup();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as { port: number };

    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/actors/a1/events?token=${ANNA_TOKEN}`, {
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    await reader.read(); // initial sheet event

    for (let i = 0; i < 100 && relay.hookSubscribers.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(relay.hookSubscribers.size).toBe(1);

    ac.abort(); // client disconnects
    await reader.closed.catch(() => undefined);
    for (let i = 0; i < 100 && relay.hookSubscribers.size > 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // Last client gone -> shared world-level hooks stream aborted.
    expect(relay.hookSubscribers.size).toBe(0);
  });
});

describe('adapter enrichment', () => {
  function setupEnriched(opts: { failDetails?: boolean } = {}): { app: FastifyInstance; relay: FakeRelay } {
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 24, 30));
    relay.systemDetails = { hpMaxOverride: 55 };
    relay.systemDetailsError = opts.failDetails ?? false;
    const enrichingAdapter = {
      ...fakeAdapter,
      async enrich(actor: Parameters<typeof fakeAdapter.toViewModel>[0], io: { getSystemDetails(d: string[]): Promise<unknown> }) {
        const derived = (await io.getSystemDetails(['hp'])) as { hpMaxOverride?: number };
        if (typeof derived.hpMaxOverride !== 'number') return actor;
        const system = actor.system as { hp: { value: number; max: number } };
        return { ...actor, system: { ...system, hp: { ...system.hp, max: derived.hpMaxOverride } } };
      },
    };
    app = buildApp({
      relay,
      players: memoryPlayers(makePlayers()),
      registry: createRegistry([enrichingAdapter]),
      defaultSystemId: 'fake',
      livePollMs: 10_000,
      pingMs: 60_000,
    });
    return { app, relay };
  }

  it('sheets and descriptor bounds use the enriched document', async () => {
    const { app, relay } = setupEnriched();
    const res = await app.inject({ method: 'GET', url: '/api/actors/a1/sheet', headers: asAnna });
    expect(res.statusCode).toBe(200);
    const hp = res.json().sheet.resources.find((r: { id: string }) => r.id === 'hp');
    expect(hp.max).toBe(55);
    expect(relay.systemDetailCalls).toContainEqual(['fake', 'Actor.a1', ['hp']]);
    // clamp uses the enriched max, and the write goes through
    const set = await app.inject({
      method: 'POST',
      url: '/api/actors/a1/intents',
      headers: asAnna,
      payload: { kind: 'set', resourceId: 'hp', value: 999 },
    });
    expect(set.statusCode).toBe(200);
    expect(relay.updates[0]?.data['system.hp.value']).toBe(55);
  });

  it('serves the unenriched document when enrichment IO fails (no secret leak)', async () => {
    const { app } = setupEnriched({ failDetails: true });
    const res = await app.inject({ method: 'GET', url: '/api/actors/a1/sheet', headers: asAnna });
    expect(res.statusCode).toBe(200);
    const hp = res.json().sheet.resources.find((r: { id: string }) => r.id === 'hp');
    expect(hp.max).toBe(30);
    expect(res.body).not.toContain(FAKE_API_KEY);
    expect(res.body).not.toContain(FAKE_RELAY_URL);
  });

  // 2026-07-22 Mage Armor (Task 8): the io object handed to enrich() carries
  // getDerivedAc, wired to relay.getDerivedAc bounded by encounterFetchTimeoutMs.
  // fakeAdapter itself has no enrich (registry test double), so this proves the
  // wiring reaches an adapter that opts in, using a locally-scoped adapter like
  // the hp-override test above.
  it('passes getDerivedAc through to enrich() and lets it override the AC resource', async () => {
    const relay = new FakeRelay();
    const doc = actorDoc('a1', 'Sariel', 24, 30);
    (doc as Record<string, unknown>).effects = [{
      _id: 'ae1', name: 'Mage Armor', disabled: false,
      changes: [{ key: 'system.attributes.ac.calc', mode: 5, value: 'mage' }],
    }];
    relay.entities.set('Actor.a1', doc);
    relay.derivedAc = 14;
    const acAwareAdapter = {
      ...fakeAdapter,
      async enrich(
        actor: Parameters<typeof fakeAdapter.toViewModel>[0],
        io: { getSystemDetails(d: string[]): Promise<unknown>; getDerivedAc?(): Promise<number | null> },
      ) {
        const effects = Array.isArray((actor as Record<string, unknown>).effects)
          ? ((actor as Record<string, unknown>).effects as unknown[])
          : [];
        if (effects.length === 0 || io.getDerivedAc === undefined) return actor;
        const live = await io.getDerivedAc();
        if (live === null) return actor;
        const system = actor.system as { ac: number };
        return { ...actor, system: { ...system, ac: live } };
      },
    };
    app = buildApp({
      relay,
      players: memoryPlayers(makePlayers()),
      registry: createRegistry([acAwareAdapter]),
      defaultSystemId: 'fake',
      livePollMs: 10_000,
      pingMs: 60_000,
    });
    const res = await app.inject({ method: 'GET', url: '/api/actors/a1/sheet', headers: asAnna });
    expect(res.statusCode).toBe(200);
    const ac = res.json().sheet.resources.find((r: { id: string }) => r.id === 'ac');
    expect(ac.value).toBe(14);
    expect(relay.getDerivedAcCalls).toEqual(['Actor.a1']);
  });
});

describe('library endpoints', () => {
  it('searches a collection with the adapter filter and maps results', async () => {
    const { app, relay } = setup();
    relay.searchResults = [
      { uuid: 'Compendium.x.Item.f1', id: 'f1', name: 'Fireball', img: 'f.webp', documentType: 'Item', subType: 'spell', packageName: 'dnd5e.spells' },
    ];
    const res = await app.inject({ method: 'GET', url: '/api/actors/a1/library/spells/search?q=fire', headers: asAnna });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      results: [{ uuid: 'Compendium.x.Item.f1', name: 'Fireball', img: 'f.webp', pack: 'dnd5e.spells' }],
    });
    expect(relay.searchCalls[0]).toMatchObject({ query: 'fire', filter: 'documentType:Item,subType:spell' });
  });

  it('uses the feats collection filter for the feats route', async () => {
    const { app, relay } = setup();
    relay.searchResults = [
      { uuid: 'Compendium.x.Item.l1', id: 'l1', name: 'Lucky', documentType: 'Item', subType: 'feat' },
    ];
    const res = await app.inject({ method: 'GET', url: '/api/actors/a1/library/feats/search?q=luck', headers: asAnna });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [{ uuid: 'Compendium.x.Item.l1', name: 'Lucky' }] });
    expect(relay.searchCalls[0]).toMatchObject({ query: 'luck', filter: 'documentType:Item,subType:feat' });
  });

  it('drops non-members from a broad (gear) search so only addable hits survive', async () => {
    const { app, relay } = setup();
    // The gear filter is the bare `documentType:Item`, so the relay returns
    // spells and feats alongside real gear; only the physical items may be added.
    relay.searchResults = [
      { uuid: 'Compendium.x.Item.fb', id: 'fb', name: 'Fireball', documentType: 'Item', subType: 'spell' },
      { uuid: 'Compendium.x.Item.sw', id: 'sw', name: 'Firebrand Sword', documentType: 'Item', subType: 'weapon', packageName: 'dnd5e.items' },
      { uuid: 'Compendium.x.Item.lk', id: 'lk', name: 'Lucky', documentType: 'Item', subType: 'feat' },
      { uuid: 'Compendium.x.Item.po', id: 'po', name: 'Fire Potion', documentType: 'Item', subType: 'consumable' },
    ];
    const res = await app.inject({ method: 'GET', url: '/api/actors/a1/library/gear/search?q=fire', headers: asAnna });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      results: [
        { uuid: 'Compendium.x.Item.sw', name: 'Firebrand Sword', pack: 'dnd5e.items' },
        { uuid: 'Compendium.x.Item.po', name: 'Fire Potion' },
      ],
    });
    // The broad filter is still sent verbatim; narrowing happens server-side here.
    expect(relay.searchCalls[0]).toMatchObject({ query: 'fire', filter: 'documentType:Item' });
  });

  it('404s an unknown collection id', async () => {
    const { app, relay } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/actors/a1/library/potions/search?q=x', headers: asAnna });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(relay.searchCalls).toHaveLength(0);
  });

  it('returns empty results for a blank query without hitting the relay', async () => {
    const { app, relay } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/actors/a1/library/spells/search?q=%20', headers: asAnna });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [] });
    expect(relay.searchCalls).toHaveLength(0);
  });

  it('previews an addable spell and rejects non-members with 422', async () => {
    const { app, relay } = setup();
    relay.entities.set('Compendium.x.Item.f1', { _id: 'f1', name: 'Fireball', type: 'spell', system: {} });
    relay.entities.set('Compendium.x.Item.w1', { _id: 'w1', name: 'Sword', type: 'weapon', system: {} });
    const ok = await app.inject({ method: 'GET', url: '/api/actors/a1/library/spells/preview?uuid=Compendium.x.Item.f1', headers: asAnna });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().preview).toMatchObject({ label: 'Fireball' });
    const bad = await app.inject({ method: 'GET', url: '/api/actors/a1/library/spells/preview?uuid=Compendium.x.Item.w1', headers: asAnna });
    expect(bad.statusCode).toBe(422);
  });

  it('adds a spell via relay give and returns a fresh sheet', async () => {
    const { app, relay } = setup();
    relay.entities.set('Compendium.x.Item.f1', { _id: 'f1', name: 'Fireball', type: 'spell', system: {} });
    const res = await app.inject({
      method: 'POST',
      url: '/api/actors/a1/library/spells/add',
      headers: asAnna,
      payload: { uuid: 'Compendium.x.Item.f1' },
    });
    expect(res.statusCode).toBe(200);
    expect(relay.giveCalls).toEqual([{ toUuid: 'Actor.a1', itemUuid: 'Compendium.x.Item.f1' }]);
    expect(res.json().sheet).toBeDefined();
  });

  it('rejects adding a non-member with 422 and no give call', async () => {
    const { app, relay } = setup();
    relay.entities.set('Compendium.x.Item.w1', { _id: 'w1', name: 'Sword', type: 'weapon', system: {} });
    const res = await app.inject({
      method: 'POST',
      url: '/api/actors/a1/library/spells/add',
      headers: asAnna,
      payload: { uuid: 'Compendium.x.Item.w1' },
    });
    expect(res.statusCode).toBe(422);
    expect(relay.giveCalls).toEqual([]);
  });

  it('adds a feat via the feats collection and validates against the feats filter', async () => {
    const { app, relay } = setup();
    relay.entities.set('Compendium.x.Item.l1', { _id: 'l1', name: 'Lucky', type: 'feat', system: {} });
    const res = await app.inject({
      method: 'POST',
      url: '/api/actors/a1/library/feats/add',
      headers: asAnna,
      payload: { uuid: 'Compendium.x.Item.l1' },
    });
    expect(res.statusCode).toBe(200);
    expect(relay.giveCalls).toEqual([{ toUuid: 'Actor.a1', itemUuid: 'Compendium.x.Item.l1' }]);
    expect(res.json().sheet).toBeDefined();
    // a spell is not a feat -> the feats collection rejects it.
    relay.entities.set('Compendium.x.Item.f1', { _id: 'f1', name: 'Fireball', type: 'spell', system: {} });
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/actors/a1/library/feats/add',
      headers: asAnna,
      payload: { uuid: 'Compendium.x.Item.f1' },
    });
    expect(wrong.statusCode).toBe(422);
    expect(relay.giveCalls).toHaveLength(1);
  });

  it('removes a spell via relay delete; non-members and unknown items are 403', async () => {
    const { app, relay } = setup();
    const ok = await app.inject({ method: 'DELETE', url: '/api/actors/a1/library/spells/s1', headers: asAnna });
    expect(ok.statusCode).toBe(200);
    expect(relay.deleteCalls).toEqual(['Actor.a1.Item.s1']);
    expect(ok.json().sheet).toBeDefined();
    const nonSpell = await app.inject({ method: 'DELETE', url: '/api/actors/a1/library/spells/i1', headers: asAnna });
    expect(nonSpell.statusCode).toBe(403);
    const missing = await app.inject({ method: 'DELETE', url: '/api/actors/a1/library/spells/nope', headers: asAnna });
    expect(missing.statusCode).toBe(403);
    expect(relay.deleteCalls).toHaveLength(1);
  });

  it('502s when the relay delete fails (M23 review: no longer lies with a 200)', async () => {
    const { app, relay } = setup();
    relay.deleteEntityResult = false;
    const res = await app.inject({ method: 'DELETE', url: '/api/actors/a1/library/spells/s1', headers: asAnna });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('UPSTREAM');
    expect(relay.deleteCalls).toEqual(['Actor.a1.Item.s1']);
  });

  it('removes a feat via the feats collection; a spell is not removable there (403)', async () => {
    const { app, relay } = setup();
    const ok = await app.inject({ method: 'DELETE', url: '/api/actors/a1/library/feats/ft1', headers: asAnna });
    expect(ok.statusCode).toBe(200);
    expect(relay.deleteCalls).toEqual(['Actor.a1.Item.ft1']);
    expect(ok.json().sheet).toBeDefined();
    // s1 is a spell, not a feat -> not removable via the feats collection.
    const wrong = await app.inject({ method: 'DELETE', url: '/api/actors/a1/library/feats/s1', headers: asAnna });
    expect(wrong.statusCode).toBe(403);
    expect(relay.deleteCalls).toHaveLength(1);
  });

  it('hides library routes for unowned actors (404) and unauthenticated callers (401)', async () => {
    const { app } = setup();
    const unowned = await app.inject({ method: 'GET', url: '/api/actors/b1/library/spells/search?q=x', headers: asAnna });
    expect(unowned.statusCode).toBe(404);
    const anon = await app.inject({ method: 'GET', url: '/api/actors/a1/library/spells/search?q=x' });
    expect(anon.statusCode).toBe(401);
  });

  it('404s every library route when the adapter has no library support', async () => {
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 24, 30));
    const { library: _library, ...libraryless } = fakeAdapter;
    const bare = buildApp({
      relay,
      players: memoryPlayers(makePlayers()),
      registry: createRegistry([libraryless]),
      defaultSystemId: 'fake',
      livePollMs: 10_000,
      pingMs: 60_000,
    });
    try {
      for (const [method, url] of [
        ['GET', '/api/actors/a1/library/spells/search?q=x'],
        ['GET', '/api/actors/a1/library/spells/preview?uuid=y'],
        ['POST', '/api/actors/a1/library/spells/add'],
        ['DELETE', '/api/actors/a1/library/spells/s1'],
      ] as const) {
        const res = await bare.inject({ method, url, headers: asAnna, ...(method === 'POST' ? { payload: { uuid: 'y' } } : {}) });
        expect(res.statusCode).toBe(404);
      }
    } finally {
      await bare.close();
    }
  });

  it('executes prepare actions as an item-field update', async () => {
    const { app, relay } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/actors/a1/actions',
      headers: asAnna,
      payload: { kind: 'prepare', actionId: 'spell.s1.prepare', prepared: true },
    });
    expect(res.statusCode).toBe(200);
    expect(relay.updates.at(-1)).toEqual({ uuid: 'Actor.a1.Item.s1', data: { 'system.prepared': 1 } });
  });

  it('never leaks relay secrets through library errors', async () => {
    const { app, relay } = setup();
    relay.actionError = true;
    const res = await app.inject({ method: 'GET', url: '/api/actors/a1/library/spells/search?q=fire', headers: asAnna });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain(FAKE_API_KEY);
    expect(res.body).not.toContain(FAKE_RELAY_URL);
  });
});

describe('custom items (M23) — POST /api/actors/:id/items', () => {
  it('creates via the create -> give -> delete chain, forwarding the ADAPTER-BUILT payload verbatim', async () => {
    const { app, relay } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/actors/a1/items',
      headers: asAnna,
      // Extra client field ("hax") must never reach the relay — only the
      // adapter's whitelisted output may.
      payload: { name: 'Stake', type: 'weapon', damage: 2, description: 'Sharp.', hax: 'ignored' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sheet).toBeDefined();

    expect(relay.createWorldItemCalls).toEqual([
      { name: 'Stake', type: 'weapon', system: { damage: 2, description: 'Sharp.' } },
    ]);
    expect(relay.giveCalls).toEqual([{ toUuid: 'Actor.a1', itemUuid: 'Item.world1' }]);
    expect(relay.deleteCalls).toEqual(['Item.world1']);
  });

  it('rejects a bad type with 422 and never calls the relay', async () => {
    const { app, relay } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/actors/a1/items',
      headers: asAnna,
      payload: { name: 'Thing', type: 'spell' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_INTENT');
    expect(relay.createWorldItemCalls).toEqual([]);
  });

  it('rejects an out-of-range damage value with 422', async () => {
    const { app, relay } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/actors/a1/items',
      headers: asAnna,
      payload: { name: 'Cannon', type: 'weapon', damage: 99 },
    });
    expect(res.statusCode).toBe(422);
    expect(relay.createWorldItemCalls).toEqual([]);
  });

  it('404s for an actor whose adapter has no buildCustomItem (mirrors dnd5e today)', async () => {
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 24, 30));
    const bare = buildApp({
      relay,
      players: memoryPlayers(makePlayers()),
      registry: createRegistry([customItemlessAdapter]),
      defaultSystemId: 'fake',
      livePollMs: 10_000,
      pingMs: 60_000,
    });
    try {
      const res = await bare.inject({
        method: 'POST',
        url: '/api/actors/a1/items',
        headers: asAnna,
        payload: { name: 'Stake', type: 'weapon', damage: 2 },
      });
      expect(res.statusCode).toBe(404);
      expect(relay.createWorldItemCalls).toEqual([]);
    } finally {
      await bare.close();
    }
  });

  it('hides the route for unowned actors (404) and unauthenticated callers (401)', async () => {
    const { app } = setup();
    const unowned = await app.inject({
      method: 'POST',
      url: '/api/actors/b1/items',
      headers: asAnna,
      payload: { name: 'Stake', type: 'weapon', damage: 2 },
    });
    expect(unowned.statusCode).toBe(404);
    const anon = await app.inject({
      method: 'POST',
      url: '/api/actors/a1/items',
      payload: { name: 'Stake', type: 'weapon', damage: 2 },
    });
    expect(anon.statusCode).toBe(401);
  });

  it('502s (bounded) when createWorldItem never settles, without leaking secrets', async () => {
    const { app, relay } = setup({ customItemTimeoutMs: 20 });
    relay.hangCreateWorldItem = true;
    const res = await app.inject({
      method: 'POST',
      url: '/api/actors/a1/items',
      headers: asAnna,
      payload: { name: 'Stake', type: 'weapon', damage: 2 },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('UPSTREAM');
    expect(res.body).not.toContain(FAKE_API_KEY);
    expect(res.body).not.toContain(FAKE_RELAY_URL);
    expect(relay.giveCalls).toEqual([]);
  });

  it('502s (bounded) when giveItem never settles, and still attempts the cleanup delete', async () => {
    const { app, relay } = setup({ customItemTimeoutMs: 20 });
    relay.hangGiveItem = true;
    const res = await app.inject({
      method: 'POST',
      url: '/api/actors/a1/items',
      headers: asAnna,
      payload: { name: 'Stake', type: 'weapon', damage: 2 },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('UPSTREAM');
    expect(res.body).not.toContain(FAKE_API_KEY);
    expect(res.body).not.toContain(FAKE_RELAY_URL);
    expect(relay.deleteCalls).toEqual(['Item.world1']);
  });

  it('502s when give fails, and still attempts the cleanup delete', async () => {
    const { app, relay } = setup();
    relay.giveItemResult = false;
    const res = await app.inject({
      method: 'POST',
      url: '/api/actors/a1/items',
      headers: asAnna,
      payload: { name: 'Stake', type: 'weapon', damage: 2 },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('UPSTREAM');
    expect(relay.giveCalls).toEqual([{ toUuid: 'Actor.a1', itemUuid: 'Item.world1' }]);
    expect(relay.deleteCalls).toEqual(['Item.world1']);
  });

  it('still returns 200 when the best-effort cleanup delete fails', async () => {
    const { app, relay } = setup();
    relay.deleteEntityResult = false;
    const res = await app.inject({
      method: 'POST',
      url: '/api/actors/a1/items',
      headers: asAnna,
      payload: { name: 'Stake', type: 'weapon', damage: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(relay.deleteCalls).toEqual(['Item.world1']);
  });

  it('counts against the shared write rate limiter', async () => {
    const { app } = setup({ rateLimitMax: 1 });
    const first = await app.inject({
      method: 'POST',
      url: '/api/actors/a1/items',
      headers: asAnna,
      payload: { name: 'Stake', type: 'weapon', damage: 2 },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/api/actors/a1/items',
      headers: asAnna,
      payload: { name: 'Lockpicks', type: 'gear' },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('RATE_LIMITED');
  });
});
