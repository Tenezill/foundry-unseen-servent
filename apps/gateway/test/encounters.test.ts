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
import { actorDoc, FakeRelay, memoryPlayers } from './fakes.js';

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

function setup(
  overrides: { rateLimitMax?: number; fetchTimeoutMs?: number; encounterFetchTimeoutMs?: number } = {},
): {
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
    encounterFetchTimeoutMs: overrides.encounterFetchTimeoutMs ?? 3_000,
    ...(overrides.rateLimitMax !== undefined ? { rateLimitMax: overrides.rateLimitMax } : {}),
  });
  currentApp = app;
  currentManager = manager;
  return { app, relay, manager };
}

/**
 * Structural NPC-hp-privacy walk (Global Constraints): EVERY non-PC
 * combatant must carry a valid `health` and no `hp`; every PC the inverse.
 * Applied to parsed views/frames — string scans over the raw body can't
 * distinguish an NPC leak from a PC's legitimate hp numbers.
 */
function assertHpPrivacy(view: unknown): void {
  const combatants = (view as { combatants?: unknown[] }).combatants ?? [];
  expect(combatants.length).toBeGreaterThan(0); // walking nothing proves nothing
  for (const raw of combatants) {
    const c = raw as { id: string; isPC: boolean; health?: string; hp?: unknown };
    if (c.isPC) {
      expect(c.hp, `PC ${c.id} must carry hp`).toBeDefined();
      expect(c.health, `PC ${c.id} must not carry health`).toBeUndefined();
    } else {
      expect(c.hp, `non-PC ${c.id} must never carry hp`).toBeUndefined();
      expect(['healthy', 'wounded', 'bloodied', 'down']).toContain(c.health);
    }
  }
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

    // Belt-and-suspenders: walk the actual HTTP response structurally —
    // every non-PC hp-free with a valid health, every PC the inverse.
    const res = await app.inject({ method: 'GET', url: '/api/encounter', headers: asAnna });
    const body = res.json();
    expect(body.combatants).toHaveLength(3);
    assertHpPrivacy(body);
    const npcInBody = body.combatants.find((c: { id: string }) => c.id === 'cN');
    expect(npcInBody.health).toBe('bloodied');
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

  it('an out-of-range turn index yields turn.combatantId null without crashing', async () => {
    const { relay, manager } = setup();
    relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal', 'character', 20, 20));
    await manager.start();

    relay.emitUpdateCombat(
      combatDoc({
        round: 1,
        turn: 5, // only one combatant — index 5 points past the list
        combatants: [{ id: 'c1', actorId: 'a1', initiative: 15 }],
      }),
    );

    const view = manager.view();
    expect(view.active).toBe(true);
    expect(view.turn?.combatantId).toBeNull();
    expect(view.combatants).toHaveLength(1);
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

  it(
    'a cross-wired actor fetch (relay returns the OTHER concurrently-seeded actor\'s doc) ' +
      'degrades that combatant instead of poisoning the cache with the wrong name/hp',
    async () => {
      // M22 cache-swap bug reproduction: live-verified against the dev
      // relay, concurrently seeding two PCs' actor caches produced a 200
      // response whose doc._id belonged to the OTHER actor (see
      // foundry-client's getEntity comment for the raw evidence). FakeRelay
      // is instant/correctly-keyed by construction, so `crossWire` simulates
      // the bug directly rather than relying on real concurrency.
      const { relay, manager } = setup();
      relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal (Human Fighter)', 'character', 44, 44));
      relay.entities.set('Actor.a2', dnd5eActor('a2', 'Akra (Dragonborn Cleric)', 'character', 38, 38));
      relay.crossWire = { when: 'Actor.a2', returnUuidInstead: 'Actor.a1' };
      await manager.start();

      relay.emitUpdateCombat(
        combatDoc({
          round: 1,
          turn: 0,
          combatants: [
            { id: 'cA', actorId: 'a1', initiative: 10 },
            { id: 'cB', actorId: 'a2', initiative: 5 },
          ],
        }),
      );

      // Wait for both actor-cache entries to settle (cA resolves normally;
      // cB's fetch is the cross-wired one and must degrade).
      let view = manager.view();
      for (
        let i = 0;
        i < 100 && (view.combatants?.find((c) => c.id === 'cA')?.hp === undefined || view.combatants?.find((c) => c.id === 'cB')?.isPC !== false);
        i++
      ) {
        await sleep(5);
        view = manager.view();
      }

      const randal = view.combatants?.find((c) => c.id === 'cA');
      expect(randal?.isPC).toBe(true);
      expect(randal?.hp).toEqual({ value: 44, max: 44 });
      expect(randal?.name).toBe('Randal (Human Fighter)');

      // The cross-wired combatant must NOT show Randal's name/hp/isPC — it
      // must degrade exactly like a timed-out fetch (never poison the cache
      // with a mismatched entity).
      const akra = view.combatants?.find((c) => c.id === 'cB');
      expect(akra?.isPC).toBe(false);
      expect(akra?.hp).toBeUndefined();
      expect(akra?.health).toBe('healthy');
      expect(akra?.name).not.toBe('Randal (Human Fighter)');
    },
  );
});

describe('REST seeding — start() → reseed() → getEncounters (production boot path)', () => {
  /** Task 0 §2a shaped REST encounter (combatants carry actorUuid, not actorId). */
  function restEncounter(opts: {
    id: string;
    round: number;
    turn?: number;
    current: boolean;
    combatants?: Array<{ id: string; name: string; actorUuid?: string; initiative?: number | null }>;
  }): {
    id: string;
    name: string;
    round: number;
    turn: number;
    current: boolean;
    combatants: Array<{
      id: string;
      name: string;
      tokenUuid?: string;
      actorUuid?: string;
      img?: string | null;
      initiative?: number | null;
      hidden?: boolean;
      defeated?: boolean;
    }>;
  } {
    return {
      id: opts.id,
      name: 'Combat Encounter',
      round: opts.round,
      turn: opts.turn ?? 0,
      current: opts.current,
      combatants: (opts.combatants ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        ...(c.actorUuid !== undefined ? { actorUuid: c.actorUuid } : {}),
        img: null,
        initiative: c.initiative ?? null,
        hidden: false,
        defeated: false,
      })),
    };
  }

  it('seeds from the current:true entry among multiple, slicing actorUuid to actorId', async () => {
    const { relay, manager } = setup();
    relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal', 'character', 24, 30));
    relay.entities.set('Actor.n1', dnd5eActor('n1', 'Goblin', 'npc', 8, 30));
    relay.encounters = [
      restEncounter({ id: 'old', round: 0, current: false }),
      restEncounter({
        id: 'live',
        round: 2,
        turn: 0,
        current: true,
        combatants: [
          { id: 'cA', name: 'Randal', actorUuid: 'Actor.a1', initiative: 12 },
          { id: 'cN', name: 'Goblin', actorUuid: 'Actor.n1', initiative: 5 },
        ],
      }),
    ];
    await manager.start();
    expect(relay.getEncountersCalls).toHaveLength(1); // exactly one seed read

    // Slicing 'Actor.a1' -> 'a1' is proven end-to-end: the combatant carries
    // the bare actorId AND the actor cache resolved via GET Actor.a1.
    let view = manager.view();
    for (let i = 0; i < 100 && view.combatants?.find((c) => c.id === 'cA')?.hp === undefined; i++) {
      await sleep(5);
      view = manager.view();
    }
    expect(view.active).toBe(true);
    expect(view.round).toBe(2);
    const pc = view.combatants?.find((c) => c.id === 'cA');
    expect(pc?.actorId).toBe('a1');
    expect(pc?.hp).toEqual({ value: 24, max: 30 });
    expect(relay.getEntityCalls).toContain('Actor.a1');
    assertHpPrivacy(view);
  });

  it('falls back to the single round>=1 entry when nothing is current', async () => {
    const { relay, manager } = setup();
    relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal', 'character', 24, 30));
    relay.encounters = [
      restEncounter({ id: 'unstarted', round: 0, current: false }),
      restEncounter({
        id: 'started',
        round: 3,
        current: false,
        combatants: [{ id: 'cA', name: 'Randal', actorUuid: 'Actor.a1', initiative: 12 }],
      }),
    ];
    await manager.start();
    const view = manager.view();
    expect(view.active).toBe(true);
    expect(view.round).toBe(3);
  });

  it('stays inactive when nothing is current and nothing has started', async () => {
    const { relay, manager } = setup();
    relay.encounters = [restEncounter({ id: 'unstarted', round: 0, current: false })];
    await manager.start();
    expect(manager.view()).toEqual({ active: false });
    expect(relay.getEncountersCalls).toHaveLength(1);
  });

  it('treats a non-Actor actorUuid (token-synthetic Scene.x.Token.y.Actor.z) as no linked actor — degraded view, no fetch, 422 on write', async () => {
    // Intentional: actorIdFromUuid only slices uuids that START with
    // 'Actor.' — a token-synthetic actor is not addressable as a world
    // Actor.<id>, so the combatant degrades (isPC false, health healthy)
    // and the hp-write route 422s it, per the plan's "linked actors only" v1.
    const { app, relay, manager } = setup();
    relay.encounters = [
      restEncounter({
        id: 'live',
        round: 1,
        current: true,
        combatants: [{ id: 'cT', name: 'Token Goblin', actorUuid: 'Scene.s1.Token.t1.Actor.z9', initiative: 7 }],
      }),
    ];
    await manager.start();
    await sleep(20); // any (wrong) actor fetch would have been kicked off by now

    const view = manager.view();
    const tokenCombatant = view.combatants?.find((c) => c.id === 'cT');
    expect(tokenCombatant?.actorId).toBeUndefined();
    expect(tokenCombatant?.isPC).toBe(false);
    expect(tokenCombatant?.health).toBe('healthy');
    expect(relay.getEntityCalls.filter((u) => u.includes('z9'))).toHaveLength(0);

    const res = await app.inject({
      method: 'POST',
      url: '/api/encounter/combatants/cT/hp',
      headers: asAnna,
      payload: { kind: 'delta', amount: -1 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_INTENT');
  });

  it('combatant hooks trigger a full REST re-read (reseed) that updates state', async () => {
    const { relay, manager } = setup();
    relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal', 'character', 24, 30));
    relay.entities.set('Actor.n1', dnd5eActor('n1', 'Goblin', 'npc', 8, 30));
    relay.encounters = [
      restEncounter({
        id: 'live',
        round: 1,
        current: true,
        combatants: [{ id: 'cA', name: 'Randal', actorUuid: 'Actor.a1', initiative: 12 }],
      }),
    ];
    await manager.start();
    expect(relay.getEncountersCalls).toHaveLength(1);
    expect(manager.view().combatants).toHaveLength(1);

    // GM adds a goblin: the createCombatant frame carries only the combatant,
    // so the manager re-reads the whole combat over REST.
    relay.encounters = [
      restEncounter({
        id: 'live',
        round: 1,
        current: true,
        combatants: [
          { id: 'cA', name: 'Randal', actorUuid: 'Actor.a1', initiative: 12 },
          { id: 'cN', name: 'Goblin', actorUuid: 'Actor.n1', initiative: 5 },
        ],
      }),
    ];
    for (const onEvent of relay.hookSubscribers) {
      onEvent({ event: 'createCombatant', data: { data: { args: [{ _id: 'cN' }, {}, {}, 'gm'] } } });
    }

    let view = manager.view();
    for (let i = 0; i < 100 && (view.combatants?.length ?? 0) < 2; i++) {
      await sleep(5);
      view = manager.view();
    }
    expect(view.combatants?.map((c) => c.id)).toEqual(['cA', 'cN']);
    expect(relay.getEncountersCalls).toHaveLength(2); // seed + reseed
  });
});

describe('hook handling — deleteCombat + updateActor', () => {
  it('deleteCombat with the matching id flips the view inactive and emits to subscribers', async () => {
    const { relay, manager } = setup();
    relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal', 'character', 24, 30));
    await manager.start();
    relay.emitUpdateCombat(
      combatDoc({ id: 'combat1', round: 1, turn: 0, combatants: [{ id: 'c1', actorId: 'a1', initiative: 9 }] }),
    );
    expect(manager.view().active).toBe(true);

    const frames: Array<{ active: boolean }> = [];
    const detach = manager.attach((view) => frames.push(view));
    relay.emitDeleteCombat('combat1');

    expect(manager.view()).toEqual({ active: false });
    expect(frames.some((f) => f.active === false)).toBe(true);
    detach();
  });

  it('deleteCombat with a non-matching id keeps the tracked combat', async () => {
    const { relay, manager } = setup();
    relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal', 'character', 24, 30));
    await manager.start();
    relay.emitUpdateCombat(
      combatDoc({ id: 'combat1', round: 1, turn: 0, combatants: [{ id: 'c1', actorId: 'a1', initiative: 9 }] }),
    );

    relay.emitDeleteCombat('someOtherCombat');
    const view = manager.view();
    expect(view.active).toBe(true);
    expect(view.combatants).toHaveLength(1);
  });

  it('an id-less deleteCombat frame never blind-clears state — it reseeds to settle the uncertainty', async () => {
    const { relay, manager } = setup();
    relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal', 'character', 24, 30));
    await manager.start();
    relay.emitUpdateCombat(
      combatDoc({ id: 'combat1', round: 1, turn: 0, combatants: [{ id: 'c1', actorId: 'a1', initiative: 9 }] }),
    );
    expect(manager.view().round).toBe(1);

    // The REST fixture restores DIFFERENTLY (round 5) so the final state
    // proves the reseed path ran — an incidental restore of identical state
    // could not fake this (round-2 review: the old survival test was masked
    // exactly that way).
    relay.encounters = [
      {
        id: 'combat1',
        name: 'Combat Encounter',
        round: 5,
        turn: 0,
        current: true,
        combatants: [
          { id: 'c1', name: 'c1', actorUuid: 'Actor.a1', img: null, initiative: 9, hidden: false, defeated: false },
        ],
      },
    ];

    for (const onEvent of [...relay.hookSubscribers]) {
      onEvent({ event: 'deleteCombat', data: { data: { args: [{ noId: true }, {}, {}, 'gm'] } } });
    }
    // Synchronous: the malformed frame must not have cleared the live state.
    expect(manager.view().active).toBe(true);
    expect(manager.view().round).toBe(1);

    // Async: the bounded reseed settles what actually happened (round 5).
    let view = manager.view();
    for (let i = 0; i < 100 && view.round !== 5; i++) {
      await sleep(5);
      view = manager.view();
    }
    expect(view).toMatchObject({ active: true, round: 5 });
  });

  it('updateActor for a cached NPC updates health from the frame — no re-fetch — and emits', async () => {
    const { relay, manager } = setup();
    relay.entities.set('Actor.n1', dnd5eActor('n1', 'Goblin', 'npc', 8, 30));
    await manager.start();
    relay.emitUpdateCombat(
      combatDoc({ round: 1, turn: 0, combatants: [{ id: 'cN', actorId: 'n1', initiative: 4 }] }),
    );

    // Wait for the initial cache fill (bloodied at 8/30).
    let view = manager.view();
    for (let i = 0; i < 100 && view.combatants?.find((c) => c.id === 'cN')?.health !== 'bloodied'; i++) {
      await sleep(5);
      view = manager.view();
    }

    const fetchesBefore = relay.getEntityCalls.length;
    const frames: Array<{ combatants?: Array<{ id: string; health?: string }> }> = [];
    const detach = manager.attach((v) => frames.push(v));

    // GM heals the goblin in Foundry: the updateActor frame carries the full
    // doc — the manager must consume it directly, without a getEntity call.
    relay.mutate('Actor.n1', 'system.attributes.hp.value', 25);
    relay.emitUpdateActor('n1');

    expect(manager.view().combatants?.find((c) => c.id === 'cN')?.health).toBe('wounded');
    expect(relay.getEntityCalls.length).toBe(fetchesBefore); // frame-driven, no re-fetch
    expect(frames.some((f) => f.combatants?.find((c) => c.id === 'cN')?.health === 'wounded')).toBe(true);
    detach();
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

  it(
    '502s (bounded) when the target actor fetch never settles instead of hanging the route',
    async () => {
      const { app, relay, manager } = setup({ encounterFetchTimeoutMs: 40 });
      await seedActiveEncounter(relay, manager);
      relay.hangUuid = 'Actor.a1'; // set AFTER seeding so the cache filled normally

      const res = await app.inject({
        method: 'POST',
        url: '/api/encounter/combatants/cA/hp',
        headers: asAnna,
        payload: { kind: 'delta', amount: -1 },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('UPSTREAM');
      expect(relay.updates).toHaveLength(0); // no blind write on a stale/missing doc
    },
    // Tight per-test timeout: if the bound regresses, this hangs — fail fast
    // and visibly rather than riding vitest's default budget.
    2_000,
  );
});

describe('stream resilience (fix round 2 — live-verified failure modes)', () => {
  /** Minimal REST encounter for reseed-driven tests (Task 0 §2a shape). */
  function activeRestEncounter(combatants: Array<{ id: string; actorUuid: string; initiative: number }>) {
    return [
      {
        id: 'liveCombat',
        name: 'Combat Encounter',
        round: 1,
        turn: 0,
        current: true,
        combatants: combatants.map((c) => ({
          ...c,
          name: c.id,
          img: null,
          hidden: false,
          defeated: false,
        })),
      },
    ];
  }

  it('survives the real wire: connected greeting, combatant-doc frame, garbage frames — then still handles a good frame', async () => {
    const { relay, manager } = setup();
    relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal', 'character', 20, 20));
    // The createCombatant frame below legitimately triggers a REST reseed —
    // give it the same active combat so state survives the re-read.
    relay.encounters = activeRestEncounter([{ id: 'c1', actorUuid: 'Actor.a1', initiative: 12 }]);
    await manager.start();
    relay.emitUpdateCombat(
      combatDoc({ id: 'liveCombat', round: 1, turn: 0, combatants: [{ id: 'c1', actorId: 'a1', initiative: 12 }] }),
    );
    expect(manager.view().active).toBe(true);

    const emit = (event: string, data: unknown): void => {
      for (const onEvent of [...relay.hookSubscribers]) onEvent({ event, data });
    };
    // (a) the relay's greeting — sent on every (re)connect, NOT hook-shaped
    // (live capture: `event: connected`, data `{"clientId":"fvtt_…"}`).
    emit('connected', { clientId: 'fvtt_779f197009ce8c97' });
    // (b) a real createCombatant frame: args[0] is a COMBATANT doc, not a Combat.
    emit('createCombatant', {
      data: {
        args: [
          { _id: 'c9', actorId: 'a1', defeated: false, flags: {}, group: null, hidden: false,
            img: null, initiative: 3, sceneId: null, system: {}, tokenId: null, type: 'base' },
          {},
          {},
          'gm',
        ],
        hook: 'createCombatant',
      },
      type: 'hook-event',
    });
    // (c) garbage in every position the wire could produce it. The two
    // id-less deleteCombat frames are asserted SYNCHRONOUSLY: the round-2
    // code blind-cleared state right in the handler and only an in-flight
    // reseed restored it later — that masking must never pass again
    // (round-2 review finding).
    emit('updateCombat', 'unparsed raw string data');
    emit('updateCombat', { data: { args: null } });
    emit('updateCombat', { data: { args: [42] } });
    emit('deleteCombat', {});
    expect(manager.view().active).toBe(true); // not blind-cleared (sync)
    emit('deleteCombat', null);
    expect(manager.view().active).toBe(true); // not blind-cleared (sync)
    emit('updateActor', { data: { args: [null] } });
    emit('whatEvenIsThis', { some: 'thing' });

    await sleep(100); // let the reseeds from (b) and the id-less deletes settle
    expect(relay.hookSubscribers.size).toBe(1); // stream never died
    expect(manager.view().active).toBe(true); // state never corrupted

    // A subsequent good frame still lands — the stream is genuinely alive.
    relay.emitUpdateCombat(
      combatDoc({ id: 'liveCombat', round: 3, turn: 0, combatants: [{ id: 'c1', actorId: 'a1', initiative: 12 }] }),
    );
    expect(manager.view().round).toBe(3);
  });

  it('re-seeds from REST after the stream drops (TypeError: terminated) — missed frames recovered', async () => {
    const { relay, manager } = setup();
    relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal', 'character', 20, 20));
    await manager.start(); // relay.encounters is [] -> seeds inactive
    expect(manager.view()).toEqual({ active: false });
    expect(relay.getEncountersCalls).toHaveLength(1);

    // A combat starts exactly while the relay drops the stream (the
    // live-observed failure): its frames are lost forever.
    relay.encounters = activeRestEncounter([{ id: 'c1', actorUuid: 'Actor.a1', initiative: 12 }]);
    relay.failHookStreams(); // undici-style TypeError: terminated

    // The loop must back off (reconnectMinMs=20), RE-SEED, then resubscribe.
    let view = manager.view();
    for (let i = 0; i < 200 && !view.active; i++) {
      await sleep(10);
      view = manager.view();
    }
    expect(view.active).toBe(true);
    expect(view.combatants?.map((c) => c.id)).toEqual(['c1']);
    expect(relay.getEncountersCalls.length).toBeGreaterThanOrEqual(2); // seed + reconnect reseed
    expect(relay.hookSubscribers.size).toBe(1); // resubscribed
  });

  it('a stalled getEncounters during a reseed keeps the last good state (never clobbers to inactive)', async () => {
    const { relay, manager } = setup({ fetchTimeoutMs: 30 });
    relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal', 'character', 20, 20));
    await manager.start();
    relay.emitUpdateCombat(
      combatDoc({ round: 1, turn: 0, combatants: [{ id: 'c1', actorId: 'a1', initiative: 12 }] }),
    );
    expect(manager.view().active).toBe(true);

    // The live-observed corruption: a combatant hook triggers a reseed, the
    // relay stalls (/encounters 408 after 10s in the relay's own log), our
    // bound fires first — the old code turned that into [] and cleared a
    // perfectly good combat back to {active:false}.
    relay.hangEncounters = true;
    for (const onEvent of [...relay.hookSubscribers]) {
      onEvent({ event: 'createCombatant', data: { data: { args: [{ _id: 'cX' }, {}, {}, 'gm'] } } });
    }
    await sleep(150); // well past the 30ms bound

    expect(manager.view().active).toBe(true); // state kept, not clobbered
    expect(manager.view().combatants).toHaveLength(1);
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

    // Wait past the immediate (cache-miss) frame for the one where the PC's
    // actor resolved, then apply the same structural hp-privacy walk the
    // snapshot route gets — SSE frames are just as much a leak surface.
    const updated = await readUntil(stream, (b) => b.includes('"isPC":true'));
    expect(updated).toContain('event: encounter');
    const dataLines = updated
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice('data: '.length)) as { active: boolean; combatants?: unknown[] });
    const lastActive = dataLines.filter((f) => f.active).pop();
    expect(lastActive).toBeDefined();
    assertHpPrivacy(lastActive);

    stream.destroy();
  });
});

describe('tokenUuid plumbing + turn accessors', () => {
  it('carries tokenUuid from REST combatants into the view', async () => {
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', actorDoc('a1', 'Hero', 10, 10));
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
    const manager = new EncounterManager({ relay, fetchTimeoutMs: 50 });
    await manager.start();
    const view = manager.view();
    expect(view.combatants?.[0]?.tokenUuid).toBe('Scene.s1.Token.t1');
    expect(view.combatants?.[1]?.tokenUuid).toBe('Scene.s1.Token.t2');
    manager.stop();
  });

  it('drops a tokenUuid that is not a full Scene.*.Token.* uuid', async () => {
    const relay = new FakeRelay();
    relay.encounters = [
      {
        id: 'c1',
        round: 1,
        turn: 0,
        current: true,
        combatants: [{ id: 'comb1', name: 'X', tokenUuid: 't1-bare-id', initiative: 5 }],
      },
    ];
    const manager = new EncounterManager({ relay, fetchTimeoutMs: 50 });
    await manager.start();
    expect(manager.view().combatants?.[0]?.tokenUuid).toBeUndefined();
    manager.stop();
  });

  it('builds tokenUuid from hook-frame tokenId + the combat doc scene', async () => {
    const relay = new FakeRelay();
    const manager = new EncounterManager({ relay, fetchTimeoutMs: 50 });
    await manager.start();
    relay.emitUpdateCombat({
      _id: 'c1',
      round: 1,
      turn: 0,
      scene: 's1',
      combatants: [{ _id: 'comb1', name: 'Hero', actorId: 'a1', tokenId: 't1', initiative: 12 }],
    });
    expect(manager.view().combatants?.[0]?.tokenUuid).toBe('Scene.s1.Token.t1');
    manager.stop();
  });

  // Live relay shape (task0 §2b + live dump 2026-07-23): the Combat document's
  // OWN `scene` field is `null` — the authoritative scene id lives on each
  // combatant's `sceneId`. A turn-advance `updateCombat` frame must still
  // yield a full tokenUuid, or the combat target picker (rows disabled without
  // one) goes inert after the first turn advances. Regression guard: casting
  // worked on the first attack (REST-seeded view) then broke once a hook frame
  // replaced it — because the reconstruction keyed only on the null combat scene.
  it('rebuilds tokenUuid from the per-combatant sceneId when the combat doc scene is null', async () => {
    const relay = new FakeRelay();
    const manager = new EncounterManager({ relay, fetchTimeoutMs: 50 });
    await manager.start();
    relay.emitUpdateCombat({
      _id: 'c1',
      round: 5,
      turn: 0,
      scene: null,
      combatants: [
        { _id: 'comb1', name: 'Hero', actorId: 'a1', tokenId: 't1', sceneId: 's9', initiative: 12 },
        { _id: 'comb2', name: 'Dragon', actorId: 'a2', tokenId: 't2', sceneId: 's9', initiative: 8 },
      ],
    });
    const combatants = manager.view().combatants ?? [];
    expect(combatants.find((c) => c.id === 'comb1')?.tokenUuid).toBe('Scene.s9.Token.t1');
    expect(combatants.find((c) => c.id === 'comb2')?.tokenUuid).toBe('Scene.s9.Token.t2');
    manager.stop();
  });

  it('current() returns the acting combatant; combatantByActorId finds by actor', async () => {
    const relay = new FakeRelay();
    relay.encounters = [
      {
        id: 'c1',
        round: 2,
        turn: 0,
        current: true,
        combatants: [
          { id: 'comb1', name: 'Hero', actorUuid: 'Actor.a1', initiative: 15 },
          { id: 'comb2', name: 'Skel', initiative: 10 },
        ],
      },
    ];
    const manager = new EncounterManager({ relay, fetchTimeoutMs: 50 });
    await manager.start();
    expect(manager.current()).toEqual({ combatId: 'c1', round: 2, combatantId: 'comb1', actorId: 'a1' });
    expect(manager.combatantByActorId('a1')?.id).toBe('comb1');
    expect(manager.combatantByActorId('nope')).toBeUndefined();
    manager.stop();
  });

  it('current() is null when inactive', () => {
    const manager = new EncounterManager({ relay: new FakeRelay(), fetchTimeoutMs: 50 });
    expect(manager.current()).toBeNull();
  });

  // Final-review Fix 1 (c): current() must apply the same visibility rule as
  // view().turn — a hidden acting combatant means "no visible acting
  // combatant", not "combat inactive".
  it('current() returns null when the acting combatant is hidden', async () => {
    const relay = new FakeRelay();
    relay.encounters = [
      {
        id: 'c1',
        round: 2,
        turn: 0, // sorted desc -> idx 0 is the hidden combatant (initiative 15)
        current: true,
        combatants: [
          { id: 'hidden1', name: 'Hidden NPC', actorUuid: 'Actor.npc1', initiative: 15, hidden: true },
          { id: 'comb2', name: 'Hero', actorUuid: 'Actor.a1', initiative: 10 },
        ],
      },
    ];
    const manager = new EncounterManager({ relay, fetchTimeoutMs: 50 });
    await manager.start();
    expect(manager.current()).toBeNull();
    manager.stop();
  });

  // Final-review Fix 1 (d): combatantByActorId must skip a hidden combatant
  // to find a later visible one sharing the same actorId (e.g. a stealthed
  // duplicate token doesn't shadow the player's own visible combatant).
  it('combatantByActorId skips a hidden combatant to find a later visible one with the same actorId', async () => {
    const relay = new FakeRelay();
    relay.encounters = [
      {
        id: 'c1',
        round: 1,
        turn: 0,
        current: true,
        combatants: [
          { id: 'hiddenDupe', name: 'Hidden Dupe', actorUuid: 'Actor.a1', initiative: 20, hidden: true },
          { id: 'comb1', name: 'Hero', actorUuid: 'Actor.a1', initiative: 10 },
        ],
      },
    ];
    const manager = new EncounterManager({ relay, fetchTimeoutMs: 50 });
    await manager.start();
    expect(manager.combatantByActorId('a1')?.id).toBe('comb1');
    manager.stop();
  });
});
