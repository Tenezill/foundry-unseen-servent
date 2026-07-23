# Combat Lifecycle Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the combat COMBAT-tab/carousel appear on combat start and disappear on combat end reliably — no manual app reloads — by adding time-based REST reconciliation to the gateway's `EncounterManager`.

## Root cause (from systematic debugging)

The gateway learns combat start (`updateCombat` with `round ≥ 1`) and end (`deleteCombat`) **only from individual relay hook frames**, which the relay is known to drop under bursts. Reseeds fire only on combatant hooks, stream reconnects, or startup — there is **no time-based reconciliation**. When the one lifecycle frame is dropped and nothing else happens, the mirror stays stale indefinitely. The SSE stream's 25 s re-emit only rebroadcasts the gateway's *own* (possibly stale) view, so it cannot fix a missed transition. A client reload appears to "fix" it only because some later hook eventually triggered a reseed — hence flaky, sometimes needing multiple reloads.

## Fix (approved)

1. **Periodic reconciliation** in `EncounterManager`: while ≥1 client is attached, re-read authoritative REST state (`reseed()`) on a modest cadence. A REST reseed already correctly detects both start (`round ≥ 1` → active) and end (no current/started combat → inactive). Gated on `listeners.size > 0` so an idle gateway with no viewers never polls.
2. **Emit-on-change dedup** in `emit()`: so the periodic reseed is silent when nothing changed (and redundant frames stop generally). The SSE route's direct initial-snapshot and 25 s re-emit bypass `emit()`, so client-side self-heal is unaffected.
3. **Reconcile-on-connect**: the SSE route kicks a fresh reseed when a client connects, so a reload reflects truth immediately rather than waiting for the next reconcile tick.

**Architecture:** `apps/gateway/src/encounters.ts` gains a `reconcileMs` dep (default 3000), a `reconcileLoop` launched alongside the hooks `subscribeLoop`, a public `reconcileNow()`, and dedup in `emit()`. `apps/gateway/src/app.ts` adds `reconcileNow()` to `EncounterManagerPort` and calls it on SSE connect.

**Tech Stack:** TypeScript, Fastify, vitest. No new dependencies. No web/client changes.

## Global Constraints

- **Gateway has a real vitest suite.** TDD is required. Gate for both tasks: `pnpm --filter @companion/gateway test` (and `pnpm --filter @companion/gateway typecheck`). Test output must be pristine.
- **Every relay await stays bounded** — reuse the existing `boundedGetEncounters()`/`reseed()` path; do not add an unbounded relay call.
- **NPC hp privacy is unchanged** — do not touch `view()`/`toCombatantView()` serialization; the reconcile path reuses `reseed()` which already routes through them.
- **`reconcileMs` default is 3000.** Existing tests construct the manager without `reconcileMs` and run listeners for well under 3000 ms, so the default must not perturb their `getEncountersCalls` counts or timing. New tests use a short `reconcileMs` (e.g. 20) to exercise the loop.
- **Poll only while watched** — the reconcile loop must skip the REST read when `listeners.size === 0`.
- Match existing file conventions: dated block comments (`/* ---- … (2026-07-23) ---- */` / `/** … (2026-07-23) */`), the `abortableDelay(ms, signal)` helper, and the single-`loopAc` lifecycle already used by `subscribeLoop`.

---

### Task 1: EncounterManager — periodic reconciliation, emit dedup, reconcileNow

**Files:**
- Modify: `apps/gateway/src/encounters.ts`
- Test: `apps/gateway/test/encounters.test.ts`

**Interfaces:**
- Consumes: existing `reseed()`, `emit()`, `abortableDelay()`, `this.listeners`, `this.loopAc`.
- Produces: `EncounterDeps.reconcileMs?: number` (default 3000); a public `reconcileNow(): void` (fire-and-forget coalesced reseed — Task 2's SSE route calls it); `emit()` becomes idempotent (suppresses an unchanged serialized view).

- [ ] **Step 1: Write failing tests**

Add this block at the end of `apps/gateway/test/encounters.test.ts` (it reuses the file's existing `sleep`, `dnd5eActor`, `setup`, `EventStream`, `ANNA_TOKEN`, and imports):

```ts
describe('time-based reconciliation (2026-07-23)', () => {
  /** REST encounter with one linked PC combatant (Task 0 §2a shape). */
  function liveRest(round: number) {
    return [
      {
        id: 'live',
        name: 'Combat Encounter',
        round,
        turn: 0,
        current: true,
        combatants: [
          { id: 'c1', name: 'Randal', actorUuid: 'Actor.a1', img: null, initiative: 12, hidden: false, defeated: false },
        ],
      },
    ];
  }

  it('reconciles a MISSED combat-start from REST while a client is attached (no hook frame)', async () => {
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal', 'character', 20, 20));
    const manager = new EncounterManager({ relay, fetchTimeoutMs: 50, reconcileMs: 20 });
    await manager.start(); // relay.encounters is [] -> inactive
    expect(manager.view()).toEqual({ active: false });

    const detach = manager.attach(() => {}); // reconcile only polls while watched
    relay.encounters = liveRest(1); // combat starts; its updateCombat frame is dropped

    let view = manager.view();
    for (let i = 0; i < 100 && !view.active; i++) {
      await sleep(5);
      view = manager.view();
    }
    expect(view.active).toBe(true);
    expect(view.combatants?.map((c) => c.id)).toEqual(['c1']);
    detach();
    manager.stop();
  });

  it('reconciles a MISSED combat-end from REST while a client is attached (no deleteCombat frame)', async () => {
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', dnd5eActor('a1', 'Randal', 'character', 20, 20));
    relay.encounters = liveRest(1);
    const manager = new EncounterManager({ relay, fetchTimeoutMs: 50, reconcileMs: 20 });
    await manager.start(); // seeds active
    expect(manager.view().active).toBe(true);

    const detach = manager.attach(() => {});
    relay.encounters = []; // combat ends; the deleteCombat frame is dropped

    let view = manager.view();
    for (let i = 0; i < 100 && view.active; i++) {
      await sleep(5);
      view = manager.view();
    }
    expect(view).toEqual({ active: false });
    detach();
    manager.stop();
  });

  it('does NOT poll REST when no client is attached', async () => {
    const relay = new FakeRelay();
    const manager = new EncounterManager({ relay, fetchTimeoutMs: 50, reconcileMs: 20 });
    await manager.start();
    const after = relay.getEncountersCalls.length;
    await sleep(120); // several reconcile ticks would fire if it were ungated
    expect(relay.getEncountersCalls.length).toBe(after); // no extra reads
    manager.stop();
  });

  it('emit() suppresses an unchanged view but still emits a genuine change', async () => {
    const relay = new FakeRelay();
    const manager = new EncounterManager({ relay, fetchTimeoutMs: 50, reconcileMs: 60_000 });
    await manager.start(); // inactive; lastEmitted = inactive
    const frames: Array<{ active: boolean; round?: number }> = [];
    const detach = manager.attach((v) => frames.push(v));

    // Ghost combatant (no actorId) -> no actor-cache fetch/emit to muddy the count.
    const doc = { _id: 'c1', round: 1, turn: 0, scene: 's1', combatants: [{ _id: 'x1', initiative: 5, tokenId: null }] };
    relay.emitUpdateCombat(doc);
    relay.emitUpdateCombat(doc); // identical -> deduped
    expect(frames).toHaveLength(1);
    expect(frames[0]?.active).toBe(true);

    relay.emitUpdateCombat({ ...doc, round: 2 }); // genuine change -> emits
    expect(frames).toHaveLength(2);
    expect(frames[1]?.round).toBe(2);
    detach();
    manager.stop();
  });

  it('reconcileNow() pulls fresh REST state on demand', async () => {
    const relay = new FakeRelay();
    const manager = new EncounterManager({ relay, fetchTimeoutMs: 50, reconcileMs: 60_000 });
    await manager.start(); // inactive
    relay.encounters = liveRest(1);
    manager.reconcileNow();

    let view = manager.view();
    for (let i = 0; i < 100 && !view.active; i++) {
      await sleep(5);
      view = manager.view();
    }
    expect(view.active).toBe(true);
    manager.stop();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @companion/gateway test -- encounters`
Expected: the new `time-based reconciliation` tests FAIL — `reconcileMs` is not a known dep (no reconcile loop), `reconcileNow` is not a function, and `emit()` does not dedup. Existing tests still pass.

- [ ] **Step 3: Add the `reconcileMs` dep**

In `EncounterDeps` (encounters.ts), after the `reconnectMaxMs` line:

```ts
  /** Hooks-stream reconnect backoff ceiling. Default 30000. */
  reconnectMaxMs?: number;
```

add:

```ts
  /** Time-based REST reconciliation cadence while ≥1 client is attached
   *  (2026-07-23). Default 3000. */
  reconcileMs?: number;
```

- [ ] **Step 4: Add the field + constructor assignment and the dedup cache**

Change the field/constructor block from:

```ts
  private loopAc: AbortController | null = null;
  private readonly fetchTimeoutMs: number;

  constructor(private readonly deps: EncounterDeps) {
    this.fetchTimeoutMs = deps.fetchTimeoutMs ?? 3_000;
  }
```

to:

```ts
  private loopAc: AbortController | null = null;
  private readonly fetchTimeoutMs: number;
  private readonly reconcileMs: number;
  /** Last serialized view fanned out to listeners — emit() suppresses an
   *  identical follow-up so the periodic reconcile is silent when nothing
   *  changed (2026-07-23). */
  private lastEmittedJson: string | undefined;

  constructor(private readonly deps: EncounterDeps) {
    this.fetchTimeoutMs = deps.fetchTimeoutMs ?? 3_000;
    this.reconcileMs = deps.reconcileMs ?? 3_000;
  }
```

- [ ] **Step 5: Launch the reconcile loop from start() and restartStream()**

Change `start()` from:

```ts
  async start(): Promise<void> {
    await this.reseed();
    this.loopAc = new AbortController();
    void this.subscribeLoop(this.loopAc);
  }
```

to:

```ts
  async start(): Promise<void> {
    await this.reseed();
    this.loopAc = new AbortController();
    void this.subscribeLoop(this.loopAc);
    void this.reconcileLoop(this.loopAc);
  }
```

Change `restartStream()` from:

```ts
  restartStream(): void {
    if (this.loopAc === null) return;
    this.loopAc.abort();
    this.loopAc = new AbortController();
    void this.reseed();
    void this.subscribeLoop(this.loopAc);
  }
```

to:

```ts
  restartStream(): void {
    if (this.loopAc === null) return;
    this.loopAc.abort();
    this.loopAc = new AbortController();
    this.lastEmittedJson = undefined; // force one authoritative emit under the new identity
    void this.reseed();
    void this.subscribeLoop(this.loopAc);
    void this.reconcileLoop(this.loopAc);
  }
```

- [ ] **Step 6: Add the public `reconcileNow()` (place it right after `restartStream()`)**

```ts
  /** Fire-and-forget coalesced REST reconcile (2026-07-23): the SSE route calls
   *  this on client connect so a reload reflects truth immediately, without
   *  waiting for the next reconcile tick. Coalesces with any in-flight reseed. */
  reconcileNow(): void {
    void this.reseed();
  }
```

- [ ] **Step 7: Make `emit()` idempotent**

Change:

```ts
  private emit(): void {
    const view = this.view();
    for (const send of this.listeners) send(view);
  }
```

to:

```ts
  private emit(): void {
    const view = this.view();
    const json = JSON.stringify(view);
    if (json === this.lastEmittedJson) return;
    this.lastEmittedJson = json;
    for (const send of this.listeners) send(view);
  }
```

- [ ] **Step 8: Add the `reconcileLoop` method (place it right after `subscribeLoop`)**

```ts
  /** Time-based reconciliation (2026-07-23): the relay drops hook frames under
   *  bursts and the SSE re-emit only rebroadcasts our own possibly-stale view,
   *  so a combat start (round→1) or end (delete) can be missed with no
   *  follow-up hook to trigger a reseed. While at least one client is attached,
   *  re-read the authoritative REST state on a modest cadence; emit() dedups so
   *  an unchanged poll is silent. Shares loopAc with subscribeLoop — stop() and
   *  restartStream() abort it. */
  private async reconcileLoop(ac: AbortController): Promise<void> {
    while (!ac.signal.aborted) {
      await abortableDelay(this.reconcileMs, ac.signal);
      if (ac.signal.aborted) return;
      if (this.listeners.size === 0) continue; // only poll while watched
      try {
        await this.reseed();
      } catch (err) {
        this.deps.log?.warn({ err: (err as Error).message }, 'encounter: reconcile reseed failed');
      }
    }
  }
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm --filter @companion/gateway test -- encounters`
Expected: the `time-based reconciliation` block PASSES and every pre-existing encounters test still passes (the 3000 ms default leaves their `getEncountersCalls` counts and timings untouched).

- [ ] **Step 10: Full gateway gate**

Run: `pnpm --filter @companion/gateway test` then `pnpm --filter @companion/gateway typecheck`
Expected: both green, output pristine.

- [ ] **Step 11: Commit**

```bash
git add apps/gateway/src/encounters.ts apps/gateway/test/encounters.test.ts
git commit -m "fix(gateway): time-based encounter reconciliation + emit dedup

The mirror learned combat start/end only from lossy relay hook frames, so a
dropped updateCombat(round>=1)/deleteCombat left the COMBAT tab stuck until an
unrelated hook happened to reseed. Add a listener-gated REST reconcile loop
(default 3s) and a reconcileNow() entry point; make emit() idempotent so the
poll is silent when nothing changed.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: SSE route — reconcile on connect

**Files:**
- Modify: `apps/gateway/src/app.ts`
- Test: `apps/gateway/test/encounters.test.ts`

**Interfaces:**
- Consumes: `EncounterManager.reconcileNow()` (Task 1).
- Produces: `EncounterManagerPort.reconcileNow(): void`; the `/api/encounter/events` route calls it once per connection.

- [ ] **Step 1: Write the failing test**

Add to the existing `describe('SSE /api/encounter/events', …)` block in `apps/gateway/test/encounters.test.ts`:

```ts
  it('a fresh SSE connection triggers a REST reconcile so a reload reflects truth', async () => {
    const { app, relay, manager } = setup();
    await manager.start();
    const before = relay.getEncountersCalls.length;

    const res = await app.inject({
      method: 'GET',
      url: `/api/encounter/events?token=${ANNA_TOKEN}`,
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    const stream = res.stream() as unknown as EventStream;

    // Opening the stream must kick reconcileNow() -> at least one extra REST read
    // (well before the default 3s reconcile tick could fire).
    await sleep(50);
    expect(relay.getEncountersCalls.length).toBeGreaterThan(before);
    stream.destroy();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @companion/gateway test -- encounters`
Expected: FAIL — opening the stream does not currently call `reconcileNow`, so `getEncountersCalls` does not grow within 50 ms.

- [ ] **Step 3: Add `reconcileNow` to the port interface**

In `EncounterManagerPort` (app.ts), after the `activeRound()` member:

```ts
  /** Active combat's id + round regardless of the acting combatant's
   *  visibility (final-review Fix 1) — null only when inactive. */
  activeRound(): { combatId: string; round: number } | null;
```

add:

```ts
  /** Fire-and-forget coalesced REST reconcile (2026-07-23) — the SSE route
   *  calls this on client connect so a reload reflects truth immediately. */
  reconcileNow(): void;
```

- [ ] **Step 4: Call `reconcileNow()` on SSE connect**

In the `/api/encounter/events` handler, change:

```ts
        writeEvent('encounter', JSON.stringify(encounterManager.view()));
        const detach = encounterManager.attach((view) => writeEvent('encounter', JSON.stringify(view)));
```

to:

```ts
        writeEvent('encounter', JSON.stringify(encounterManager.view()));
        const detach = encounterManager.attach((view) => writeEvent('encounter', JSON.stringify(view)));
        // A fresh connection re-reads authoritative REST state so a reload
        // reflects truth immediately (2026-07-23): if the mirror missed a
        // combat start/end hook, this reseed corrects it and the attached
        // listener above receives the corrected frame.
        encounterManager.reconcileNow();
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @companion/gateway test -- encounters`
Expected: the new SSE test PASSES; the existing SSE tests (`streams the initial (inactive) frame…`) still pass (the initial `active:false` frame is written directly and `reconcileNow` with empty `relay.encounters` produces no state change, so no spurious frame).

- [ ] **Step 6: Full gateway gate**

Run: `pnpm --filter @companion/gateway test` then `pnpm --filter @companion/gateway typecheck`
Expected: both green, output pristine.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/app.ts apps/gateway/test/encounters.test.ts
git commit -m "fix(gateway): reconcile encounter state on SSE connect

A fresh /api/encounter/events connection now kicks reconcileNow(), so a client
reload always reflects current combat state even if the mirror missed a start/
end hook — the last leg of the no-reload-needed combat lifecycle fix.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Periodic reconciliation (listener-gated, REST) → Task 1 Steps 3–5, 8; tests (missed-start, missed-end, not-polled-when-unwatched). ✓
- Emit-on-change dedup → Task 1 Steps 4, 7; test (suppress unchanged / emit genuine change). ✓
- Reconcile-on-connect → Task 1 Step 6 (`reconcileNow`) + Task 2 (port + route); tests (`reconcileNow()` on demand, fresh SSE connection reads REST). ✓
- Bounded relay awaits preserved (reuses `reseed()`/`boundedGetEncounters()`); NPC hp privacy untouched (reuses `view()`). ✓
- Default `reconcileMs` 3000 protects existing tests → Global Constraints + Task 1 Step 9. ✓

**Placeholder scan:** none — all code shown in full.

**Type consistency:** `reconcileMs` (dep + field), `reconcileNow(): void` (public method, port member, route call), `lastEmittedJson`, and `reconcileLoop(ac: AbortController)` are named identically across encounters.ts, app.ts, and the tests.
