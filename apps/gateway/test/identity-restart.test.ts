/**
 * Turnkey identity-change wiring (Task 4): a rotated relay key or a
 * (re)resolved clientId means every open relay-side stream was opened under
 * the OLD identity and must be aborted + re-opened. Covers LiveManager's and
 * EncounterManager's restartStream(), plus buildApp's relayIdentityChanged
 * fan-out (gm-rolls SSE connections closed so browsers reconnect and
 * re-subscribe under the new identity).
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { LiveManager } from '../src/live.js';
import { EncounterManager } from '../src/encounters.js';
import { createRegistry } from '../src/registry.js';
import { sha256Hex, type Player } from '../src/players.js';
import { FakeRelay, fakeAdapter, memoryPlayers } from './fakes.js';

const GM_TOKEN = 'gm-token';
const GM: Player = { name: 'Gm', tokenHash: sha256Hex(GM_TOKEN), actorIds: ['a1'], gm: true };

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('LiveManager.restartStream', () => {
  it('aborts the open hooks stream and opens a fresh one; no-op when idle', async () => {
    const relay = new FakeRelay();
    const live = new LiveManager({
      pollMs: 10_000,
      fetchSheetJson: async () => '{}',
      subscribeHooks: (hooks, onEvent, signal) => relay.subscribeHooks(hooks, onEvent, signal),
      reconnectMinMs: 10,
      reconnectMaxMs: 20,
    });
    live.restartStream(); // idle: must not throw, must not open anything
    expect(relay.hookSubscriptions).toHaveLength(0);

    const detach = live.attach('a1', () => undefined, '{}');
    await waitFor(() => relay.hookSubscribers.size === 1);
    live.restartStream();
    await waitFor(() => relay.hookSubscriptions.length === 2);
    expect(relay.hookSubscribers.size).toBe(1); // old aborted, exactly one live
    detach();
    await waitFor(() => relay.hookSubscribers.size === 0);
  });
});

describe('EncounterManager.restartStream', () => {
  it('re-seeds and re-subscribes; no-op before start()', async () => {
    const relay = new FakeRelay();
    const mgr = new EncounterManager({ relay, fetchTimeoutMs: 200, reconnectMinMs: 10, reconnectMaxMs: 20 });
    mgr.restartStream(); // not started: no-op
    expect(relay.hookSubscriptions).toHaveLength(0);

    await mgr.start();
    await waitFor(() => relay.hookSubscribers.size === 1);
    const seedsBefore = relay.getEncountersCalls.length;
    mgr.restartStream();
    await waitFor(() => relay.hookSubscriptions.length === 2);
    expect(relay.getEncountersCalls.length).toBeGreaterThan(seedsBefore); // re-seeded
    expect(relay.hookSubscribers.size).toBe(1);
    mgr.stop();
  });
});

describe('buildApp — relayIdentityChanged', () => {
  it('closes gm-rolls SSE connections so clients re-subscribe under the new identity', async () => {
    const relay = new FakeRelay();
    let fire: () => void = () => undefined;
    const app = buildApp({
      relay,
      players: memoryPlayers([GM]),
      registry: createRegistry([fakeAdapter]),
      relayIdentityChanged: (cb) => {
        fire = cb;
        return () => undefined;
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/gm/rolls/events?token=${GM_TOKEN}`,
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    await waitFor(() => relay.rollSubscribers.size === 1);
    fire();
    await waitFor(() => relay.rollSubscribers.size === 0); // relay-side stream aborted
    await app.close();
  });

  it('restarts the shared actor-hooks stream while actor SSE clients stay connected', async () => {
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', {
      _id: 'a1', name: 'Anna', type: 'character', systemId: 'fake',
      system: { hp: { value: 10, max: 10 }, ac: 15 }, items: [],
    });
    let fire: () => void = () => undefined;
    const app = buildApp({
      relay,
      players: memoryPlayers([GM]),
      registry: createRegistry([fakeAdapter]),
      liveReconnectMinMs: 10,
      liveReconnectMaxMs: 20,
      relayIdentityChanged: (cb) => {
        fire = cb;
        return () => undefined;
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/actors/a1/events?token=${GM_TOKEN}`,
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    await waitFor(() => relay.hookSubscribers.size === 1);
    const before = relay.hookSubscriptions.length;
    fire();
    await waitFor(() => relay.hookSubscriptions.length === before + 1); // fresh stream
    expect(relay.hookSubscribers.size).toBe(1);
    await app.close();
  });
});

describe('buildApp — defaultSystemId as a provider (turnkey auto-mode adapter selection)', () => {
  it('accepts a function and re-invokes it per request (resolved-world systemId fallback)', async () => {
    const relay = new FakeRelay();
    // No systemId on the doc itself -> systemIdOf falls back to defaultSystemId().
    relay.entities.set('Actor.a1', {
      _id: 'a1', name: 'Anna', type: 'character',
      system: { hp: { value: 10, max: 10 }, ac: 15 }, items: [],
    });
    let current = 'dnd5e';
    const app = buildApp({
      relay,
      players: memoryPlayers([GM]),
      registry: createRegistry([fakeAdapter]),
      defaultSystemId: () => current,
    });
    try {
      const res1 = await app.inject({ method: 'GET', url: '/api/actors', headers: { authorization: `Bearer ${GM_TOKEN}` } });
      expect(res1.json().actors[0].systemId).toBe('dnd5e');

      // Simulate the resolver resolving a wod5e world mid-run: the very next
      // request must reflect it without rebuilding the app.
      current = 'fake';
      const res2 = await app.inject({ method: 'GET', url: '/api/actors', headers: { authorization: `Bearer ${GM_TOKEN}` } });
      expect(res2.json().actors[0].systemId).toBe('fake');
    } finally {
      await app.close();
    }
  });
});
