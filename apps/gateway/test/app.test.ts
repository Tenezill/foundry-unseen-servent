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
import { buildApp } from '../src/app.js';
import { sha256Hex, type Player } from '../src/players.js';
import { createRegistry } from '../src/registry.js';
import { actionlessAdapter, actorDoc, fakeAdapter, FakeRelay, FAKE_API_KEY, FAKE_RELAY_URL } from './fakes.js';

const ANNA_TOKEN = 'anna-invite-token-123';
const BOB_TOKEN = 'bob-invite-token-456';

function makePlayers(): Player[] {
  return [
    { name: 'Anna', tokenHash: sha256Hex(ANNA_TOKEN), actorIds: ['a1', 'a2', 'ghost'] },
    { name: 'Bob', tokenHash: sha256Hex(BOB_TOKEN), actorIds: ['b1'] },
  ];
}

let app: FastifyInstance | null = null;

function setup(overrides: { rateLimitMax?: number } = {}): { app: FastifyInstance; relay: FakeRelay } {
  const relay = new FakeRelay();
  relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 24, 30));
  relay.entities.set('Actor.a2', actorDoc('a2', 'Borin', 12, 40));
  relay.entities.set('Actor.b1', actorDoc('b1', 'Mysterious Stranger', 8, 8));
  app = buildApp({
    relay,
    players: makePlayers(),
    registry: createRegistry([fakeAdapter]),
    defaultSystemId: 'fake',
    livePollMs: 10_000,
    pingMs: 60_000,
    ...(overrides.rateLimitMax !== undefined ? { rateLimitMax: overrides.rateLimitMax } : {}),
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
    expect(res.json()).toEqual({ player: { name: 'Anna', actorIds: ['a1', 'a2', 'ghost'] } });
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
      players: makePlayers(),
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
    ]) {
      const res = await post(app, 'a1', payload);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('INVALID_INTENT');
    }
    expect(relay.rollCalls).toHaveLength(0);
    expect(relay.useAbilityCalls).toHaveLength(0);
    expect(relay.equipCalls).toHaveLength(0);
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

  it('cast with slotLevel 2 -> use-spell on the item uuid with the slot level', async () => {
    const { app, relay } = setup();
    relay.useAbilityResult = { roll: { total: 11, formula: '4d6', isCritical: false, isFumble: false } };
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.s1.cast', slotLevel: 2 });
    expect(res.statusCode).toBe(200);
    expect(relay.useAbilityCalls).toEqual([
      { endpoint: 'use-spell', actorUuid: 'Actor.a1', itemUuid: 'Actor.a1.Item.s1', opts: { slotLevel: 2 } },
    ]);
    const body = res.json();
    expect(body.result).toEqual({ total: 11, formula: '4d6', isCritical: false, isFumble: false });
    expect(body.sheet.actorId).toBe('a1');
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
    ]) {
      const res = await post(app, 'a1', payload);
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('UPSTREAM');
      expect(res.body).not.toContain(FAKE_API_KEY);
      expect(res.body).not.toContain(FAKE_RELAY_URL);
    }
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
    expect(relay.hookSubscriptions[0]).toEqual(['updateActor']);
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
      players: makePlayers(),
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
