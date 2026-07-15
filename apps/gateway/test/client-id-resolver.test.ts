import { describe, expect, it } from 'vitest';
import type { RelayClientInfo } from '@companion/foundry-client';
import { ClientIdResolver } from '../src/client-id-resolver.js';

function info(
  clientId: string,
  worldId: string,
  isOnline: boolean,
  worldTitle = worldId,
  systemId = 'dnd5e',
): RelayClientInfo {
  return { clientId, worldId, worldTitle, foundryVersion: '13.351', systemId, isOnline };
}

function makeResolver(opts: {
  mode?: string;
  clients?: () => Promise<RelayClientInfo[]>;
  hasKey?: () => boolean;
}) {
  const changes: string[] = [];
  const resolver = new ClientIdResolver(opts.mode ?? 'auto', {
    listClients: opts.clients ?? (async () => []),
    hasKey: opts.hasKey ?? (() => true),
    probeTimeoutMs: 100,
  });
  resolver.onChange((id) => changes.push(id));
  return { resolver, changes };
}

describe('ClientIdResolver — explicit mode (back-compat)', () => {
  it('returns the explicit id, never probes, healthView is null', async () => {
    let called = 0;
    const { resolver, changes } = makeResolver({
      mode: 'fvtt_explicit',
      clients: async () => {
        called++;
        return [];
      },
    });
    await resolver.probeOnce();
    expect(resolver.current()).toBe('fvtt_explicit');
    expect(called).toBe(0);
    expect(resolver.healthView()).toBeNull();
    expect(changes).toEqual([]);
  });
});

describe('ClientIdResolver — auto mode', () => {
  it('0 online worlds: degrades, reports no-world-online, current() is empty', async () => {
    const { resolver, changes } = makeResolver({ clients: async () => [info('fvtt_a', 'w1', false)] });
    await resolver.probeOnce();
    expect(resolver.current()).toBe('');
    expect(resolver.healthView()).toEqual({ state: 'waiting', reason: 'no-world-online' });
    expect(changes).toEqual([]);
  });

  it('exactly 1 online: resolves, caches, emits once', async () => {
    const { resolver, changes } = makeResolver({
      clients: async () => [info('fvtt_a', 'w1', true, 'My World'), info('fvtt_b', 'w2', false)],
    });
    await resolver.probeOnce();
    await resolver.probeOnce(); // idempotent re-probe
    expect(resolver.current()).toBe('fvtt_a');
    expect(resolver.healthView()).toEqual({ state: 'online', worldTitle: 'My World' });
    expect(changes).toEqual(['fvtt_a']);
  });

  it('>1 online: refuses, reports multiple-worlds-online, resolves nothing', async () => {
    const { resolver, changes } = makeResolver({
      clients: async () => [info('fvtt_a', 'w1', true), info('fvtt_b', 'w2', true)],
    });
    await resolver.probeOnce();
    expect(resolver.current()).toBe('');
    expect(resolver.healthView()).toEqual({ state: 'blocked', reason: 'multiple-worlds-online' });
    expect(changes).toEqual([]);
  });

  it('never switches worlds: a different single online world is not adopted', async () => {
    let clients = [info('fvtt_a', 'w1', true, 'World One')];
    const { resolver, changes } = makeResolver({ clients: async () => clients });
    await resolver.probeOnce();
    expect(resolver.current()).toBe('fvtt_a');
    clients = [info('fvtt_x', 'wOTHER', true, 'Impostor')]; // w1 gone, another world online
    await resolver.probeOnce();
    expect(resolver.current()).toBe('fvtt_a'); // sticky — never switched
    expect(resolver.healthView()).toEqual({ state: 'waiting', reason: 'world-offline', worldTitle: 'World One' });
    expect(changes).toEqual(['fvtt_a']);
  });

  it('follows a NEW clientId for the SAME worldId (re-pair) and emits', async () => {
    let clients = [info('fvtt_a', 'w1', true)];
    const { resolver, changes } = makeResolver({ clients: async () => clients });
    await resolver.probeOnce();
    clients = [info('fvtt_repaired', 'w1', true)];
    await resolver.probeOnce();
    expect(resolver.current()).toBe('fvtt_repaired');
    expect(changes).toEqual(['fvtt_a', 'fvtt_repaired']);
  });

  it('key unavailable: reports without calling the relay', async () => {
    let called = 0;
    const { resolver } = makeResolver({
      hasKey: () => false,
      clients: async () => {
        called++;
        return [];
      },
    });
    await resolver.probeOnce();
    expect(called).toBe(0);
    expect(resolver.healthView()).toEqual({ state: 'waiting', reason: 'key-unavailable' });
  });

  it('bounded probe: a hanging listClients degrades to relay-unreachable within the budget', async () => {
    const { resolver } = makeResolver({ clients: () => new Promise(() => undefined) });
    const start = Date.now();
    await resolver.probeOnce();
    expect(Date.now() - start).toBeLessThan(1000); // probeTimeoutMs=100 + slack
    expect(resolver.healthView()).toEqual({ state: 'waiting', reason: 'relay-unreachable' });
  });

  it('a throwing listClients degrades to relay-unreachable', async () => {
    const { resolver } = makeResolver({
      clients: async () => {
        throw new Error('boom');
      },
    });
    await resolver.probeOnce();
    expect(resolver.healthView()).toEqual({ state: 'waiting', reason: 'relay-unreachable' });
  });

  // Task 4/5 need the resolved world's adapter identity (relay's per-actor
  // getEntity doc carries no systemId — Task 0 findings §6-2) — captured here
  // from the resolved /clients entry, exposed via a resolver getter so later
  // tasks can wire it into adapter selection without re-touching this class.
  it('captures the resolved worlds systemId and worldTitle', async () => {
    const { resolver } = makeResolver({
      clients: async () => [info('fvtt_a', 'w1', true, 'My World', 'wod5e')],
    });
    await resolver.probeOnce();
    expect(resolver.resolvedWorld()).toEqual({ worldId: 'w1', worldTitle: 'My World', systemId: 'wod5e' });
  });
});
