import { afterEach, describe, expect, it } from 'vitest';
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
import { wod5eAdapter } from '@companion/adapter-wod5e';
import { buildApp, isSafeDiceFormula } from '../src/app.js';
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
  overrides: { rateLimitMax?: number; customItemTimeoutMs?: number } = {},
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
