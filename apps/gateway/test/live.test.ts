/**
 * LiveManager unit tests: one shared world-level hooks subscription, actor-id
 * filtering, JSON-diff suppression, and the polling fallback with backoff
 * reconnect when the hooks stream fails.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  extractItemParentActorId,
  extractUpdatedActorId,
  LiveManager,
  type LiveOptions,
} from '../src/live.js';

type HookHandler = (ev: { event: string; data: unknown }) => void;

/** Controllable fake hooks stream + sheet store. */
class Harness {
  readonly sheets = new Map<string, string>();
  readonly fetches: string[] = [];
  readonly subscribeCalls: string[][] = [];
  private handler: HookHandler | null = null;
  private endStream: ((err?: Error) => void) | null = null;
  /** When true, subscribeHooks rejects immediately (relay down). */
  failSubscribe = false;

  readonly options: LiveOptions;

  constructor(overrides: Partial<LiveOptions> = {}) {
    this.options = {
      pollMs: 10,
      reconnectMinMs: 5,
      reconnectMaxMs: 40,
      fetchSheetJson: async (actorId) => {
        this.fetches.push(actorId);
        return this.sheets.get(actorId) ?? null;
      },
      subscribeHooks: (hooks, onEvent, signal) => {
        this.subscribeCalls.push([...hooks]);
        if (this.failSubscribe) return Promise.reject(new Error('relay down'));
        this.handler = onEvent;
        return new Promise<void>((resolve, reject) => {
          const finish = (err?: Error): void => {
            if (this.endStream === finish) this.endStream = null;
            if (this.handler === onEvent) this.handler = null;
            if (err) reject(err);
            else resolve();
          };
          this.endStream = finish;
          signal.addEventListener('abort', () => finish(), { once: true });
        });
      },
      ...overrides,
    };
  }

  get streamOpen(): boolean {
    return this.handler !== null;
  }

  emit(event: string, data: unknown): void {
    this.handler?.({ event, data });
  }

  emitUpdateActor(actorId: string): void {
    this.emit('updateActor', { data: { args: [{ _id: actorId }, { some: 'diff' }] } });
  }

  /** Kill the current stream as if the relay dropped it. */
  breakStream(): void {
    this.endStream?.(new Error('stream lost'));
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('extractUpdatedActorId', () => {
  it('finds args under data.args', () => {
    expect(extractUpdatedActorId({ args: [{ _id: 'x1' }, {}] })).toBe('x1');
  });

  it('finds args under data.data.args (M0 capture nesting)', () => {
    expect(extractUpdatedActorId({ data: { args: [{ _id: 'x2' }, {}] } })).toBe('x2');
  });

  it('returns null for malformed payloads', () => {
    expect(extractUpdatedActorId(null)).toBeNull();
    expect(extractUpdatedActorId('nope')).toBeNull();
    expect(extractUpdatedActorId({ data: {} })).toBeNull();
    expect(extractUpdatedActorId({ data: { args: [] } })).toBeNull();
    expect(extractUpdatedActorId({ data: { args: ['string-first'] } })).toBeNull();
    expect(extractUpdatedActorId({ data: { args: [{ name: 'no id' }] } })).toBeNull();
  });
});

describe('extractItemParentActorId', () => {
  it('resolves the parent actor from the item parent field', () => {
    expect(extractItemParentActorId({ data: { args: [{ _id: 'i1', parent: { _id: 'a9' } }, {}] } })).toBe('a9');
  });

  it('falls back to parsing the embedded item uuid', () => {
    expect(extractItemParentActorId({ data: { args: [{ _id: 'i1', uuid: 'Actor.a7.Item.i1' }, {}] } })).toBe('a7');
  });

  it('returns null for world-level items and malformed payloads', () => {
    expect(extractItemParentActorId({ data: { args: [{ _id: 'i1', uuid: 'Item.i1' }] } })).toBeNull();
    expect(extractItemParentActorId({ data: { args: [] } })).toBeNull();
    expect(extractItemParentActorId(null)).toBeNull();
  });
});

describe('LiveManager shared hooks subscription', () => {
  it('subscribes to actor AND embedded-item hooks (DM loot syncs live)', async () => {
    const h = new Harness();
    h.sheets.set('x', '{"items":1}');
    const live = new LiveManager(h.options);
    const got: string[] = [];
    const detach = live.attach('x', (json) => got.push(json), '{"items":1}');
    await waitFor(() => h.streamOpen);
    expect(h.subscribeCalls).toEqual([['updateActor', 'createItem', 'updateItem', 'deleteItem']]);

    // GM drags loot onto the character -> Foundry fires createItem for the
    // embedded item; the sheet must refresh from the parent actor.
    h.sheets.set('x', '{"items":2}');
    h.emit('createItem', { data: { args: [{ _id: 'i9', parent: { _id: 'x' } }, {}, 'gm'] } });
    await waitFor(() => got.length === 1);
    expect(got).toEqual(['{"items":2}']);

    // deleteItem with a uuid-only payload also maps to the parent actor.
    h.sheets.set('x', '{"items":1}');
    h.emit('deleteItem', { data: { args: [{ _id: 'i9', uuid: 'Actor.x.Item.i9' }, {}, 'gm'] } });
    await waitFor(() => got.length === 2);
    expect(got[1]).toBe('{"items":1}');

    detach();
    live.stopAll();
  });

  it('starts ONE stream on first attach and delivers updated sheets to the matching actor', async () => {
    const h = new Harness();
    h.sheets.set('x', '{"hp":10}');
    h.sheets.set('y', '{"mp":3}');
    const live = new LiveManager(h.options);

    const gotX: string[] = [];
    const gotY: string[] = [];
    const detachX = live.attach('x', (json) => gotX.push(json), '{"hp":10}');
    const detachY = live.attach('y', (json) => gotY.push(json), '{"mp":3}');

    await waitFor(() => h.streamOpen);
    // one shared subscription for both actors
    expect(h.subscribeCalls).toEqual([['updateActor', 'createItem', 'updateItem', 'deleteItem']]);

    h.sheets.set('x', '{"hp":5}');
    h.emitUpdateActor('x');
    await waitFor(() => gotX.length === 1);
    expect(gotX).toEqual(['{"hp":5}']);
    expect(gotY).toEqual([]); // event for x never fans out to y

    detachX();
    detachY();
    await waitFor(() => !h.streamOpen); // last detach aborts the stream
    live.stopAll();
  });

  it('ignores events for unwatched actor ids (no fetch, no send)', async () => {
    const h = new Harness();
    h.sheets.set('x', '{"hp":10}');
    const live = new LiveManager(h.options);
    const got: string[] = [];
    const detach = live.attach('x', (json) => got.push(json), '{"hp":10}');
    await waitFor(() => h.streamOpen);

    h.emitUpdateActor('stranger');
    h.emit('updateActor', { data: { args: [{ name: 'malformed, no _id' }] } });
    h.emit('someOtherHook', { data: { args: [{ _id: 'x' }] } });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.fetches).toEqual([]);
    expect(got).toEqual([]);

    detach();
    live.stopAll();
  });

  it('suppresses broadcasts when the rebuilt sheet JSON is unchanged', async () => {
    const h = new Harness();
    h.sheets.set('x', '{"hp":10}');
    const live = new LiveManager(h.options);
    const got: string[] = [];
    const detach = live.attach('x', (json) => got.push(json), '{"hp":10}');
    await waitFor(() => h.streamOpen);

    h.emitUpdateActor('x'); // sheet identical to primed baseline
    await waitFor(() => h.fetches.length === 1);
    expect(got).toEqual([]);

    h.sheets.set('x', '{"hp":9}');
    h.emitUpdateActor('x');
    await waitFor(() => got.length === 1);
    expect(got).toEqual(['{"hp":9}']);

    detach();
    live.stopAll();
  });

  it('falls back to polling while the stream is down, then resumes push after reconnect', async () => {
    const h = new Harness();
    h.sheets.set('x', '{"hp":10}');
    const live = new LiveManager(h.options);
    const got: string[] = [];
    const detach = live.attach('x', (json) => got.push(json), '{"hp":10}');
    await waitFor(() => h.streamOpen);

    // Relay starts refusing connections: current stream dies, reconnects fail.
    h.failSubscribe = true;
    h.breakStream();
    h.sheets.set('x', '{"hp":4}');
    await waitFor(() => got.includes('{"hp":4}')); // change arrived via polling

    // Relay recovers: backoff reconnect re-establishes the stream ...
    h.failSubscribe = false;
    await waitFor(() => h.streamOpen);
    expect(h.subscribeCalls.length).toBeGreaterThanOrEqual(2);

    // ... and push works again.
    h.sheets.set('x', '{"hp":2}');
    h.emitUpdateActor('x');
    await waitFor(() => got.includes('{"hp":2}'));

    detach();
    live.stopAll();
  });

  it('logs and keeps retrying with growing (capped) backoff while the relay stays down', async () => {
    const warn = vi.fn();
    const h = new Harness({ log: { warn } });
    h.failSubscribe = true;
    h.sheets.set('x', '{"hp":10}');
    const live = new LiveManager(h.options);
    const detach = live.attach('x', () => undefined, '{"hp":10}');

    await waitFor(() => h.subscribeCalls.length >= 4);
    expect(warn).toHaveBeenCalled();
    const backoffs = warn.mock.calls
      .map((c) => (c[0] as { backoffMs?: number }).backoffMs)
      .filter((b): b is number => typeof b === 'number');
    expect(Math.max(...backoffs)).toBeLessThanOrEqual(40); // reconnectMaxMs cap
    // backoff grows between consecutive failures until the cap
    expect(backoffs[1]).toBeGreaterThanOrEqual(backoffs[0] as number);

    detach();
    const callsAfterDetach = h.subscribeCalls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(h.subscribeCalls.length).toBe(callsAfterDetach); // no reconnects once idle
    live.stopAll();
  });

  it('suppresses a transient partial sheet whose content sections vanished (spells reappear bug)', async () => {
    // Foundry fires an item hook, the re-fetch lands mid-write, and the relay
    // returns an actor doc with empty `items` -> every item-derived section
    // (spells.*, inventory, ...) is gone at once. That partial sheet must NOT
    // clobber the last-known-good one; the next full refresh restores it.
    const h = new Harness();
    const full = JSON.stringify({
      sections: [{ id: 'core' }, { id: 'spells.l0' }, { id: 'spells.l1' }, { id: 'inventory' }],
    });
    const partial = JSON.stringify({ sections: [{ id: 'core' }] });
    h.sheets.set('x', full);
    const live = new LiveManager(h.options);
    const got: string[] = [];
    const detach = live.attach('x', (json) => got.push(json), full);
    await waitFor(() => h.streamOpen);

    h.sheets.set('x', partial);
    h.emitUpdateActor('x');
    await waitFor(() => h.fetches.length === 1);
    expect(got).toEqual([]); // the vanish is not broadcast

    // A genuinely changed FULL sheet still flows through normally.
    const fullChanged = JSON.stringify({
      sections: [{ id: 'core' }, { id: 'spells.l0' }, { id: 'spells.l1' }, { id: 'inventory' }],
      hp: 9,
    });
    h.sheets.set('x', fullChanged);
    h.emitUpdateActor('x');
    await waitFor(() => got.length === 1);
    expect(got).toEqual([fullChanged]);

    detach();
    live.stopAll();
  });

  it('broadcasts a confirmed section loss when the reduced sheet repeats (real bulk delete)', async () => {
    const h = new Harness();
    const full = JSON.stringify({ sections: [{ id: 'core' }, { id: 'spells.l0' }, { id: 'inventory' }] });
    const reduced = JSON.stringify({ sections: [{ id: 'core' }] });
    h.sheets.set('x', full);
    const live = new LiveManager(h.options);
    const got: string[] = [];
    const detach = live.attach('x', (json) => got.push(json), full);
    await waitFor(() => h.streamOpen);

    h.sheets.set('x', reduced);
    h.emitUpdateActor('x'); // first sighting -> held back as suspicious
    await waitFor(() => h.fetches.length === 1);
    expect(got).toEqual([]);

    h.emitUpdateActor('x'); // same reduced sheet again -> confirmed, broadcast
    await waitFor(() => got.length === 1);
    expect(got).toEqual([reduced]);

    detach();
    live.stopAll();
  });

  it('broadcasts a single dropped section immediately (normal edit, never freezes)', async () => {
    const h = new Harness();
    const full = JSON.stringify({ sections: [{ id: 'core' }, { id: 'spells.l0' }, { id: 'spells.l1' }] });
    const oneLess = JSON.stringify({ sections: [{ id: 'core' }, { id: 'spells.l0' }] });
    h.sheets.set('x', full);
    const live = new LiveManager(h.options);
    const got: string[] = [];
    const detach = live.attach('x', (json) => got.push(json), full);
    await waitFor(() => h.streamOpen);

    h.sheets.set('x', oneLess); // deleted the last 1st-level spell: one section gone
    h.emitUpdateActor('x');
    await waitFor(() => got.length === 1);
    expect(got).toEqual([oneLess]);

    detach();
    live.stopAll();
  });

  it('restarts the stream when a client attaches after everything went idle', async () => {
    const h = new Harness();
    h.sheets.set('x', '{"hp":10}');
    const live = new LiveManager(h.options);

    const detach1 = live.attach('x', () => undefined, '{"hp":10}');
    await waitFor(() => h.streamOpen);
    detach1();
    await waitFor(() => !h.streamOpen);

    const got: string[] = [];
    const detach2 = live.attach('x', (json) => got.push(json), '{"hp":10}');
    await waitFor(() => h.streamOpen);
    h.sheets.set('x', '{"hp":1}');
    h.emitUpdateActor('x');
    await waitFor(() => got.length === 1);

    detach2();
    live.stopAll();
  });
});
