/**
 * M22 EncounterManager + gateway routes: the manager builds and re-emits
 * EncounterView state from FakeRelay hook pushes (Task 0 §2b shaped combat
 * docs), and the three /api/encounter* routes surface it. Global Constraints
 * (docs/superpowers/plans/2026-07-11-encounters.md): exact NPC hp never
 * leaves the manager; health thresholds; hidden combatants dropped but the
 * turn pointer computed before the drop; every relay await bounded.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { dnd5eAdapter } from '@companion/adapter-dnd5e';
import { buildApp } from '../src/app.js';
import { EncounterManager } from '../src/encounters.js';
import { sha256Hex, type Player } from '../src/players.js';
import { createRegistry } from '../src/registry.js';
import { FakeRelay, memoryPlayers } from './fakes.js';

/** Minimal structural type for the injected SSE response stream (mirrors app.test.ts). */
interface EventStream {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  off(event: 'data', listener: (chunk: unknown) => void): unknown;
  destroy(): void;
}

const ANNA_TOKEN = 'anna-invite-token-123';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makePlayers(): Player[] {
  return [{ name: 'Anna', tokenHash: sha256Hex(ANNA_TOKEN), actorIds: ['a1'] }];
}

/** Minimal dnd5e-shaped actor doc — enough for buildResources/buildUpdate
 *  (all other fields are read via `numAt`/`getPath`, which tolerate absence)
 *  and for the manager's own hp/type extraction. */
function dnd5eActor(
  id: string,
  name: string,
  type: 'character' | 'npc',
  hpValue: number,
  hpMax: number,
  hpTemp = 0,
): Record<string, unknown> {
  return {
    _id: id,
    uuid: `Actor.${id}`,
    name,
    type,
    systemId: 'dnd5e',
    system: {
      attributes: {
        hp: { value: hpValue, max: hpMax, temp: hpTemp },
        death: { success: 0, failure: 0 },
        exhaustion: 0,
      },
      abilities: {},
      currency: {},
    },
    items: [],
  };
}

let currentApp: FastifyInstance | null = null;
let currentManager: EncounterManager | null = null;

function setup(overrides: { rateLimitMax?: number; fetchTimeoutMs?: number } = {}): {
  app: FastifyInstance;
  relay: FakeRelay;
  manager: EncounterManager;
} {
  const relay = new FakeRelay();
  const manager = new EncounterManager({
    relay,
    fetchTimeoutMs: overrides.fetchTimeoutMs ?? 50,
    reconnectMinMs: 20,
    reconnectMaxMs: 40,
  });
  const app = buildApp({
    relay,
    players: memoryPlayers(makePlayers()),
    registry: createRegistry([dnd5eAdapter]),
    defaultSystemId: 'dnd5e',
    livePollMs: 10_000,
    pingMs: 60_000,
    encounters: manager,
    ...(overrides.rateLimitMax !== undefined ? { rateLimitMax: overrides.rateLimitMax } : {}),
  });
  currentApp = app;
  currentManager = manager;
  return { app, relay, manager };
}

afterEach(async () => {
  currentManager?.stop();
  if (currentApp) await currentApp.close();
  currentApp = null;
  currentManager = null;
});

const asAnna = { authorization: `Bearer ${ANNA_TOKEN}` };

/** Task 0 §2b shaped raw Foundry Combat doc (what emitUpdateCombat pushes). */
function combatDoc(opts: {
  id?: string;
  round?: number;
  turn?: number | null;
  combatants: Array<{
    id: string;
    actorId?: string;
    initiative?: number | null;
    hidden?: boolean;
    defeated?: boolean;
  }>;
}): Record<string, unknown> {
  return {
    _id: opts.id ?? 'combat1',
    active: false, // Task 0: unreliable — the manager keys off round instead
    round: opts.round ?? 1,
    turn: opts.turn ?? null,
    combatants: opts.combatants.map((c) => ({
      _id: c.id,
      actorId: c.actorId,
      initiative: c.initiative ?? null,
      hidden: c.hidden === true,
      defeated: c.defeated === true,
      img: null,
      tokenId: null,
    })),
  };
}

describe('no active encounter', () => {
  it('GET /api/encounter -> {active:false}', async () => {
    const { app, manager } = setup();
    await manager.start();
    const res = await app.inject({ method: 'GET', url: '/api/encounter', headers: asAnna });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false });
  });

  it('POST hp -> 409 CONFLICT regardless of the combatant id', async () => {
    const { app, manager } = setup();
    await manager.start();
    const res = await app.inject({
      method: 'POST',
      url: '/api/encounter/combatants/whatever/hp',
      headers: asAnna,
      payload: { kind: 'delta', amount: -1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });

  it('404s the whole surface without a manager wired', async () => {
    const relay = new FakeRelay();
    const app = buildApp({
      relay,
      players: memoryPlayers(makePlayers()),
      registry: createRegistry([dnd5eAdapter]),
      defaultSystemId: 'dnd5e',
    });
    currentApp = app;
    const res = await app.inject({ method: 'GET', url: '/api/encounter', headers: asAnna });
    expect(res.statusCode).toBe(404);
  });
});

describe('active encounter — serialization', () => {
  it('PCs carry exact hp; NPCs carry a health state and never hp (no leak)', async () => {
    const { app, relay, manager } = setup();
    relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal', 'character', 24, 30, 5));
    relay.entities.set('Actor.a2', dnd5eActor('a2', 'Akra', 'character', 12, 40));
    relay.entities.set('Actor.n1', dnd5eActor('n1', 'Goblin', 'npc', 8, 30));
    await manager.start();

    relay.emitUpdateCombat(
      combatDoc({
        round: 2,
        turn: 0,
        combatants: [
          { id: 'cB', actorId: 'a2', initiative: 10 },
          { id: 'cA', actorId: 'a1', initiative: 6 },
          { id: 'cN', actorId: 'n1', initiative: 3 },
        ],
      }),
    );

    // Actor-cache fetches are fire-and-forget; wait for the NPC's real state
    // (its cache-miss default would also read as a valid, if wrong, state).
    let view = manager.view();
    for (let i = 0; i < 100 && view.combatants?.find((c) => c.id === 'cN')?.health !== 'bloodied'; i++) {
      await sleep(5);
      view = manager.view();
    }

    expect(view.active).toBe(true);
    expect(view.round).toBe(2);
    const npc = view.combatants?.find((c) => c.id === 'cN');
    expect(npc?.hp).toBeUndefined();
    expect(npc?.health).toBe('bloodied');
    expect(npc?.isPC).toBe(false);

    const pc1 = view.combatants?.find((c) => c.id === 'cA');
    expect(pc1?.hp).toEqual({ value: 24, max: 30 });
    expect(pc1?.health).toBeUndefined();
    expect(pc1?.isPC).toBe(true);

    // Belt-and-suspenders: scan the raw HTTP response for any NPC-hp leak.
    const res = await app.inject({ method: 'GET', url: '/api/encounter', headers: asAnna });
    const body = res.json();
    const npcInBody = body.combatants.find((c: { id: string }) => c.id === 'cN');
    expect(npcInBody.hp).toBeUndefined();
    expect(npcInBody.health).toBe('bloodied');
    expect(res.body).not.toContain('"value":30'); // n1's max would only appear via a leaked hp
  });

  it('0/0 hp -> down; hidden combatant dropped; hidden acting combatant -> turn.combatantId null; initiative-desc order', async () => {
    const { relay, manager } = setup();
    relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal', 'character', 20, 20));
    relay.entities.set('Actor.a2', dnd5eActor('a2', 'Akra', 'character', 20, 20));
    relay.entities.set('Actor.n1', dnd5eActor('n1', 'Bare NPC', 'npc', 0, 0));
    await manager.start();

    relay.emitUpdateCombat(
      combatDoc({
        round: 1,
        turn: 0, // sorted desc -> idx 0 is the hidden combatant
        combatants: [
          { id: 'hidden1', actorId: 'a1', initiative: 20, hidden: true },
          { id: 'seen1', actorId: 'a2', initiative: 15 },
          { id: 'seen2', actorId: 'n1', initiative: 5 },
        ],
      }),
    );

    let view = manager.view();
    for (let i = 0; i < 100 && view.combatants?.find((c) => c.id === 'seen2')?.health !== 'down'; i++) {
      await sleep(5);
      view = manager.view();
    }

    expect(view.combatants).toHaveLength(2); // hidden1 dropped
    expect(view.combatants?.map((c) => c.id)).toEqual(['seen1', 'seen2']); // initiative desc
    expect(view.turn?.combatantId).toBeNull(); // acting combatant (hidden1) is hidden
    expect(view.combatants?.find((c) => c.id === 'seen2')?.health).toBe('down');
  });

  it('turn pointer resolves to the correct visible combatant', async () => {
    const { relay, manager } = setup();
    relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal', 'character', 20, 20));
    relay.entities.set('Actor.a2', dnd5eActor('a2', 'Akra', 'character', 20, 20));
    await manager.start();

    relay.emitUpdateCombat(
      combatDoc({
        round: 1,
        turn: 1, // sorted desc: [a1(15), a2(10)] -> idx1 = a2
        combatants: [
          { id: 'c1', actorId: 'a1', initiative: 15 },
          { id: 'c2', actorId: 'a2', initiative: 10 },
        ],
      }),
    );

    const view = manager.view();
    expect(view.turn?.combatantId).toBe('c2');
  });

  it('a never-settling actor fetch degrades that combatant without blocking the view', async () => {
    const { relay, manager } = setup({ fetchTimeoutMs: 30 });
    relay.hangUuid = 'Actor.stuck';
    relay.entities.set('Actor.a2', dnd5eActor('a2', 'Akra', 'character', 20, 20));
    await manager.start();

    relay.emitUpdateCombat(
      combatDoc({
        round: 1,
        turn: 0,
        combatants: [
          { id: 'c1', actorId: 'stuck', initiative: 20 },
          { id: 'c2', actorId: 'a2', initiative: 5 },
        ],
      }),
    );

    // Give the bounded fetch (30ms timeout) time to give up.
    await sleep(150);
    const view = manager.view();
    expect(view.active).toBe(true); // still renders
    const stuckCombatant = view.combatants?.find((c) => c.id === 'c1');
    expect(stuckCombatant?.isPC).toBe(false); // degraded default
    expect(stuckCombatant?.health).toBe('healthy'); // degraded default
    const okCombatant = view.combatants?.find((c) => c.id === 'c2');
    expect(okCombatant?.hp).toEqual({ value: 20, max: 20 });
  });
});

describe('hp write', () => {
  async function seedActiveEncounter(relay: FakeRelay, manager: EncounterManager): Promise<void> {
    relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal', 'character', 24, 30, 5));
    relay.entities.set('Actor.n1', dnd5eActor('n1', 'Goblin', 'npc', 15, 15));
    await manager.start();
    relay.emitUpdateCombat(
      combatDoc({
        round: 1,
        turn: 0,
        combatants: [
          { id: 'cA', actorId: 'a1', initiative: 10 },
          { id: 'cGhost', initiative: 5 }, // no actorId
        ],
      }),
    );
    // Let the actor cache settle so the response reflects real state.
    let view = manager.view();
    for (let i = 0; i < 100 && view.combatants?.find((c) => c.id === 'cA')?.hp === undefined; i++) {
      await sleep(5);
      view = manager.view();
    }
  }

  it('applies -7 damage to a temp-carrying PC via temp-first paths (M20) and returns fresh hp', async () => {
    const { app, relay, manager } = setup();
    await seedActiveEncounter(relay, manager);

    const res = await app.inject({
      method: 'POST',
      url: '/api/encounter/combatants/cA/hp',
      headers: asAnna,
      payload: { kind: 'delta', amount: -7 },
    });
    expect(res.statusCode).toBe(200);

    const update = relay.updates.find((u) => u.uuid === 'Actor.a1');
    expect(update).toBeDefined();
    // temp(5) absorbs first: 7 damage -> 5 from temp, 2 from value (24 -> 22).
    expect(update?.data['system.attributes.hp.value']).toBe(22);
    expect(update?.data['system.attributes.hp.temp']).toBe(0);

    const { encounter } = res.json();
    const pc = encounter.combatants.find((c: { id: string }) => c.id === 'cA');
    expect(pc.hp).toEqual({ value: 22, max: 30 });
  });

  it('404s an unknown combatant id', async () => {
    const { app, relay, manager } = setup();
    await seedActiveEncounter(relay, manager);
    const res = await app.inject({
      method: 'POST',
      url: '/api/encounter/combatants/nope/hp',
      headers: asAnna,
      payload: { kind: 'delta', amount: -1 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('422s a combatant with no linked actor', async () => {
    const { app, relay, manager } = setup();
    await seedActiveEncounter(relay, manager);
    const res = await app.inject({
      method: 'POST',
      url: '/api/encounter/combatants/cGhost/hp',
      headers: asAnna,
      payload: { kind: 'delta', amount: -1 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_INTENT');
  });

  it('422s a malformed body (wrong kind / non-finite / zero amount)', async () => {
    const { app, relay, manager } = setup();
    await seedActiveEncounter(relay, manager);
    for (const payload of [
      { kind: 'set', amount: -1 },
      { kind: 'delta', amount: 'seven' },
      { kind: 'delta', amount: 0 },
      { kind: 'delta' },
      {},
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/encounter/combatants/cA/hp',
        headers: asAnna,
        payload: payload as object,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('INVALID_INTENT');
    }
  });

  it('429 RATE_LIMITED once the shared write limiter trips', async () => {
    const { app } = setup({ rateLimitMax: 2 });
    // No encounter is even seeded — the limiter check runs before the 409
    // active-encounter check, so this alone is enough to prove the limit.
    const post = () =>
      app.inject({
        method: 'POST',
        url: '/api/encounter/combatants/whatever/hp',
        headers: asAnna,
        payload: { kind: 'delta', amount: -1 },
      });
    expect((await post()).statusCode).toBe(409);
    expect((await post()).statusCode).toBe(409);
    const res3 = await post();
    expect(res3.statusCode).toBe(429);
    expect(res3.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('SSE /api/encounter/events', () => {
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

  it('streams the initial (inactive) frame, then a second frame after emitUpdateCombat', async () => {
    const { app, relay, manager } = setup();
    relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal', 'character', 20, 20));
    await manager.start();

    const res = await app.inject({
      method: 'GET',
      url: `/api/encounter/events?token=${ANNA_TOKEN}`,
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const stream = res.stream() as unknown as EventStream;

    const initial = await readUntil(stream, (b) => b.includes('event: encounter'));
    expect(initial).toContain('"active":false');

    relay.emitUpdateCombat(
      combatDoc({ round: 1, turn: 0, combatants: [{ id: 'c1', actorId: 'a1', initiative: 12 }] }),
    );

    const updated = await readUntil(stream, (b) => b.includes('"active":true'));
    expect(updated).toContain('event: encounter');

    stream.destroy();
  });
});
