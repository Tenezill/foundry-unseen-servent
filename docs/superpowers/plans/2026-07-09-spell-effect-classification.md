# Spell/Item Effect Classification & Self-Heal Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify spells/features as damage/heal/utility (data already exists in Foundry's activity `type`), surface that as filter chips + effect-aware roll wording on the Actions tab, and fix self-targeted heals (Second Wind) to actually roll and apply — they currently do nothing but consume a use, because the relay only auto-executes `attack`-type activities.

**Architecture:** Extends the exact pattern used for M14 weapon damage: the adapter computes a formula client-side and returns it via a `RelayAction`; the gateway executes it generically. Self-heals get one new `RelayAction` variant (`roll-and-heal`) that rolls, then writes the resulting HP — the only new gateway-side behavior in this plan. Everything else is adapter-side classification + frontend display.

**Tech Stack:** TypeScript, Fastify (gateway), Vue 3 / Nuxt (apps/web), Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-09-spell-effect-classification-design.md` — read it before starting; this plan implements it exactly.
- `apps/web` has no unit tests in v1 ("e2e via stack, no unit tests in v1" per its `test` script) — frontend tasks are verified by live browser check via chrome-devtools, not automated tests.
- `packages/adapter-sdk` is types-only ("covered by consumers" per its `test` script) — its task is verified by typecheck, not a test file.
- Gateway must stay system-agnostic: no dnd5e-specific field paths in `apps/gateway/src/app.ts` — the adapter supplies `path`/`current`/`max` as plain data.
- Formula resolution is best-effort, not a rules engine (matches the existing weapon-damage disclaimer) — document every simplification in a comment, do not silently guess.
- Every task ends green: `pnpm -r typecheck` and `pnpm test` from the repo root must both pass before moving to the next task.

---

### Task 1: `adapter-sdk` — effectType field + roll-and-heal RelayAction

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts:197-215` (ActionDescriptor), `packages/adapter-sdk/src/index.ts:232-243` (RelayAction)

**Interfaces:**
- Produces: `ActionDescriptor.effectType?: 'damage' | 'heal' | 'utility'` — consumed by Task 3 (dnd5e adapter sets it) and Tasks 5-6 (frontend reads it).
- Produces: `RelayAction` variant `{ endpoint: 'roll-and-heal'; formula: string; flavor: string; path: string; current: number; max: number }` — consumed by Task 2 (gateway executor) and Task 4 (dnd5e adapter returns it).

- [ ] **Step 1: Add `effectType` to `ActionDescriptor`**

In `packages/adapter-sdk/src/index.ts`, find:

```ts
  /** attune only: current state (the intent carries the desired state). */
  attuned?: boolean;
}
```

Replace with:

```ts
  /** attune only: current state (the intent carries the desired state). */
  attuned?: boolean;
  /** cast/use only: what this spell/feature mechanically does, for grouping
   *  and roll-result wording on the Actions tab (M15). System-agnostic:
   *  'damage' (deals damage, whether via an attack roll or a save), 'heal'
   *  (restores HP), 'utility' (neither — buffs, debuffs, information). */
  effectType?: 'damage' | 'heal' | 'utility';
}
```

- [ ] **Step 2: Add the `roll-and-heal` RelayAction variant**

In the same file, find:

```ts
  /** Generic embedded-item field write (e.g. prepared state); executed via
   *  the same entity-update path as quantity/uses. */
  | { endpoint: 'update-item'; itemId: string; data: Record<string, number | string | boolean> }
  | { endpoint: 'short-rest' | 'long-rest' | 'death-save' | 'break-concentration' };
```

Replace with:

```ts
  /** Generic embedded-item field write (e.g. prepared state); executed via
   *  the same entity-update path as quantity/uses. */
  | { endpoint: 'update-item'; itemId: string; data: Record<string, number | string | boolean> }
  /** M15: roll a formula, then write the result into the actor (self-heals
   *  only — see the dnd5e adapter's buildHealAction). `path`/`current`/`max`
   *  are resolved by the adapter so this stays system-agnostic here: the
   *  gateway just computes `min(max, current + total)` and writes `path`. */
  | { endpoint: 'roll-and-heal'; formula: string; flavor: string; path: string; current: number; max: number }
  | { endpoint: 'short-rest' | 'long-rest' | 'death-save' | 'break-concentration' };
```

- [ ] **Step 3: Typecheck (this package has no test file — types-only, verified by consumers)**

Run: `cd packages/adapter-sdk && npx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 4: Typecheck the whole monorepo (consumers will show errors here first)**

Run: `cd ../.. && pnpm -r typecheck`
Expected: every workspace prints `Done`. Some may already fail if Tasks 2-4 aren't done yet — that's expected until this plan completes; for THIS step, only `packages/adapter-sdk` and `apps/adapter-sdk`'s direct consumers matter. If `apps/gateway` or `packages/adapter-dnd5e` fail with errors about `effectType`/`roll-and-heal` being unused or missing switch cases, that's fine — Tasks 2-4 fix those. If they fail for any OTHER reason, stop and investigate before continuing.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-sdk/src/index.ts
git commit -m "feat(adapter-sdk): add effectType field and roll-and-heal RelayAction"
```

---

### Task 2: `apps/gateway` — execute `roll-and-heal`

**Files:**
- Modify: `apps/gateway/src/app.ts:628-664` (the action-execution switch)
- Test: `apps/gateway/test/app.test.ts` (add to the existing `describe('actions', ...)` block)

**Interfaces:**
- Consumes: `RelayAction` variant `{ endpoint: 'roll-and-heal'; formula; flavor; path; current; max }` (Task 1).
- Consumes: `RelayPort.rollFormula(actorUuid, formula, flavor)` and `RelayPort.updateEntity(uuid, data)` — both already exist on `RelayPort` (`apps/gateway/src/app.ts:36-58`), no interface changes needed.
- Produces: nothing new for later tasks — this is a leaf; Task 4 will exercise this executor indirectly once the real dnd5e adapter returns `roll-and-heal`, but Task 4 does not need to know anything about the gateway's internals beyond the `RelayAction` shape from Task 1.

- [ ] **Step 1: Write the failing test**

Open `apps/gateway/test/app.test.ts` and find the `describe('actions', ...)` block (it starts around line 243, right after the `post` helper is defined at the top of that block). Add this test inside the block, after the last existing `it(...)` in that describe (find the closing `});` of the describe block and insert before it):

```ts
  it('roll-and-heal -> rolls the formula, then writes clamped HP into the actor', async () => {
    await app?.close();
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 20, 30));
    relay.rollResult = { formula: '1d10 + 5', total: 8, isCritical: false, isFumble: false };
    const healAdapter: SystemAdapter = {
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
      actions: () => [{ id: 'feature.sw.use', label: 'Second Wind', kind: 'use', effectType: 'heal' }],
      buildAction: () => ({
        endpoint: 'roll-and-heal',
        formula: '1d10 + 5',
        flavor: 'Second Wind — Healing',
        path: 'system.attributes.hp.value',
        current: 20,
        max: 30,
      }),
    };
    app = buildApp({
      relay,
      players: makePlayers(),
      registry: createRegistry([healAdapter]),
      defaultSystemId: 'fake',
      livePollMs: 10_000,
      pingMs: 60_000,
    });
    const res = await post(app, 'a1', { kind: 'use', actionId: 'feature.sw.use' });
    expect(res.statusCode).toBe(200);
    expect(relay.rollCalls).toEqual([{ actorUuid: 'Actor.a1', formula: '1d10 + 5', flavor: 'Second Wind — Healing' }]);
    expect(relay.updates).toEqual([{ uuid: 'Actor.a1', data: { 'system.attributes.hp.value': 28 } }]);
    const body = res.json();
    expect(body.result).toEqual({ total: 8, formula: '1d10 + 5', isCritical: false, isFumble: false });
  });

  it('roll-and-heal clamps the written HP to max, never overhealing', async () => {
    await app?.close();
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', actorDoc('a1', 'Sariel', 28, 30));
    relay.rollResult = { formula: '1d10 + 5', total: 8, isCritical: false, isFumble: false };
    const healAdapter: SystemAdapter = {
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
      actions: () => [{ id: 'feature.sw.use', label: 'Second Wind', kind: 'use', effectType: 'heal' }],
      buildAction: () => ({
        endpoint: 'roll-and-heal',
        formula: '1d10 + 5',
        flavor: 'Second Wind — Healing',
        path: 'system.attributes.hp.value',
        current: 28,
        max: 30,
      }),
    };
    app = buildApp({
      relay,
      players: makePlayers(),
      registry: createRegistry([healAdapter]),
      defaultSystemId: 'fake',
      livePollMs: 10_000,
      pingMs: 60_000,
    });
    const res = await post(app, 'a1', { kind: 'use', actionId: 'feature.sw.use' });
    expect(res.statusCode).toBe(200);
    expect(relay.updates).toEqual([{ uuid: 'Actor.a1', data: { 'system.attributes.hp.value': 30 } }]);
  });
```

Check the top of `apps/gateway/test/app.test.ts` for its existing imports — `SystemAdapter`, `IntentError`, `buildApp`, `createRegistry`, `makePlayers`, `FakeRelay`, `actorDoc` should already be imported for the other tests in this file (they're used throughout `describe('actions', ...)`already). If any is missing, add it to the existing `import` statements at the top rather than creating new ones — check with:

```bash
grep -n "^import" apps/gateway/test/app.test.ts
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/gateway && npx vitest run test/app.test.ts -t "roll-and-heal"`
Expected: FAIL — the switch in `app.ts` has no `case 'roll-and-heal'`, so `result` stays `null` and `relay.updates`/`relay.rollCalls` stay empty. TypeScript may also fail to compile the test file itself because the `RelayAction` union (once Task 1 lands) includes `roll-and-heal`, but `app.ts`'s switch doesn't handle it — that's fine, it's the same failure signal.

- [ ] **Step 3: Implement the executor**

In `apps/gateway/src/app.ts`, find:

```ts
        case 'update-item':
          // Generic item-field write (e.g. prepared state) — same entity-update
          // path as quantity/uses; no chat card, no roll.
          await relay.updateEntity(`Actor.${id}.Item.${action.itemId}`, action.data);
          break;
        case 'short-rest':
```

Replace with:

```ts
        case 'update-item':
          // Generic item-field write (e.g. prepared state) — same entity-update
          // path as quantity/uses; no chat card, no roll.
          await relay.updateEntity(`Actor.${id}.Item.${action.itemId}`, action.data);
          break;
        case 'roll-and-heal': {
          // M15: the relay only auto-executes attack-type activities — a
          // heal-type use/cast just posts an inert card (live-verified
          // 2026-07-09: Second Wind consumed its use but rolled/applied
          // nothing). So the adapter computed the formula itself; roll it,
          // then write the result — clamped to max — directly onto the
          // actor. `path` is adapter-supplied so this stays system-agnostic.
          const rolled = extractRoll(await relay.rollFormula(`Actor.${id}`, action.formula, action.flavor));
          result = rolled;
          if (rolled !== null) {
            const newValue = Math.min(action.max, action.current + rolled.total);
            await relay.updateEntity(`Actor.${id}`, { [action.path]: newValue });
          }
          break;
        }
        case 'short-rest':
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/gateway && npx vitest run test/app.test.ts -t "roll-and-heal"`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full gateway suite (regression check)**

Run: `npx vitest run`
Expected: all existing suites still pass (config/players/registry/live/app — 81+ tests before this task; should now be 83).

- [ ] **Step 6: Typecheck**

Run: `cd .. && cd .. && pnpm --filter @companion/gateway typecheck`
Expected: `Done`, no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/app.ts apps/gateway/test/app.test.ts
git commit -m "feat(gateway): execute roll-and-heal — roll a formula, then write clamped HP"
```

---

### Task 3: `adapter-dnd5e` — activity-type classification (`effectType`)

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` (add helpers near `weaponDamageFormula` at line ~1160; wire into `buildActions`' spell block at line ~1248 and feature-use push at line ~1281-1283)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`

**Interfaces:**
- Consumes: `rec`, `getPath`, `strAt` helpers already defined at the top of `packages/adapter-dnd5e/src/index.ts` (lines 49-72).
- Produces: `activityType(item: FoundryItemDoc): string | undefined`, `firstActivity(item: FoundryItemDoc): Record<string, unknown>`, `effectTypeOf(item: FoundryItemDoc): 'damage' | 'heal' | 'utility'` — `firstActivity`/`activityType` are consumed by Task 4 (heal formula + self-target check); `effectTypeOf` is consumed only within this task's own `buildActions` wiring.

- [ ] **Step 1: Write the failing test**

Open `packages/adapter-dnd5e/test/actions.test.ts`. Find the `describe('buildAction — weapon damage (M14)', ...)` block (it ends with the `'unknown damage action id -> UNKNOWN_RESOURCE'` test, right before `describe('buildAction — rejections', ...)`). Insert this new describe block right after the M14 block's closing `});` and before `describe('buildAction — rejections', ...)`:

```ts
describe('effectType classification (M15)', () => {
  it('heal-type activities classify as heal', () => {
    expect(action(casterCaptured, 'spell.LjT1wf4D38c9Ieuo.cast').effectType).toBe('heal'); // Cure Wounds
    expect(action(casterCaptured, 'spell.HpjaVMLEU14tJG7y.cast').effectType).toBe('heal'); // Healing Word
  });

  it('attack-type activities classify as damage', () => {
    expect(action(casterCaptured, 'spell.pZMrJb3AXiRYO5E8.cast').effectType).toBe('damage'); // Guiding Bolt
  });

  it('a save-type activity that deals damage classifies as damage (Sacred Flame)', () => {
    expect(action(casterCaptured, 'spell.P97npemu7j70IZAQ.cast').effectType).toBe('damage');
  });

  it('a save-type activity with no damage parts classifies as utility (Bane — a debuff, no damage)', () => {
    // Bane is unprepared in the fixture (prepared: 0), so the M14 spell
    // filter gives it no cast action by default — prepare it in a clone to
    // reach the classification path directly (same technique as the M14
    // finesse-weapon synthetic-actor test).
    const prepared: FoundryActorDoc = {
      ...casterCaptured,
      items: (casterCaptured.items ?? []).map((i) =>
        i._id === '9FrgmKwWCYPhlZ5w'
          ? { ...i, system: { ...(i.system as Record<string, unknown>), prepared: 1 } }
          : i,
      ),
    };
    expect(action(prepared, 'spell.9FrgmKwWCYPhlZ5w.cast').effectType).toBe('utility');
  });

  it('a plain utility activity classifies as utility (Detect Magic)', () => {
    expect(action(casterCaptured, 'spell.a7IlF5H2ZPsB4VWm.cast').effectType).toBe('utility');
  });

  it('Second Wind (feature, heal-type) classifies as heal', () => {
    expect(action(martialCaptured, 'feature.7r63kurEAM3GdEec.use').effectType).toBe('heal');
  });

  it('weapon attack/damage descriptors carry no effectType (out of scope — Attacks stays its own section)', () => {
    expect(action(martialCaptured, 'item.gta26ORvqC323k3r.attack').effectType).toBeUndefined();
    expect(action(martialCaptured, 'item.gta26ORvqC323k3r.damage').effectType).toBeUndefined();
  });
});
```

This references `spell.P97npemu7j70IZAQ.cast` (Sacred Flame) and `spell.5yH69xkqge3u7to7.cast` (Thaumaturgy) and `spell.a7IlF5H2ZPsB4VWm.cast` (Detect Magic) — confirm these ids match the caster fixture by checking the comment block near the top of the test file (`// Akra's items (caster-captured): ...`) or by re-running the id-listing script used earlier in this session:

```bash
cd packages/adapter-dnd5e && node -e "
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('test/fixtures/caster-captured.json','utf8'));
for (const s of raw.items.filter(i => i.type === 'spell')) console.log(s._id, s.name);
"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/adapter-dnd5e && npx vitest run test/actions.test.ts -t "effectType classification"`
Expected: FAIL — `effectType` is `undefined` everywhere (property doesn't exist yet on any descriptor).

- [ ] **Step 3: Implement `activityType`, `firstActivity`, `effectTypeOf`**

In `packages/adapter-dnd5e/src/index.ts`, find (this is right before `function weaponAbilityMod`):

```ts
/**
 * The ability modifier dnd5e would add to this weapon's attack/damage roll.
 * An explicit activity `attack.ability` override wins; otherwise a finesse
 * weapon picks the better of STR/DEX, a ranged weapon uses DEX, and anything
 * else — including a thrown-but-not-finesse weapon, which by RAW keeps its
 * melee ability — uses STR.
 */
function weaponAbilityMod(actor: FoundryActorDoc, item: FoundryItemDoc): number {
```

Replace with:

```ts
/** This item's first activity, or an empty record if it has none. Foundry
 *  stores activities as an object keyed by activity id; every dnd5e
 *  spell/feature/weapon relevant to actions has at most one. */
function firstActivity(item: FoundryItemDoc): Rec {
  const activities = rec(getPath(item.system, 'activities'));
  return rec(Object.values(activities)[0]);
}

/** The dnd5e activity `type` this item's first activity carries, e.g.
 *  "attack", "heal", "save", "utility", "check". Undefined for items with
 *  no activities (most physical gear). */
function activityType(item: FoundryItemDoc): string | undefined {
  const type = firstActivity(item).type;
  return typeof type === 'string' ? type : undefined;
}

/**
 * Classify a spell/feature for the Actions tab (M15): 'heal' for heal
 * activities, 'damage' for attacks AND for save activities that still carry
 * damage parts (e.g. Sacred Flame — mechanically a `save` activity, not an
 * `attack`, but it deals radiant damage on a failed save; verified against
 * the caster fixture: Sacred Flame's `damage.parts` has one entry, the pure
 * debuff saves Bane/Command/Sanctuary's are empty), 'utility' for everything
 * else (pure debuff saves, utility, check). Not exposed on weapon
 * attack/damage descriptors — Attacks is already its own unfiltered section.
 */
function effectTypeOf(item: FoundryItemDoc): 'damage' | 'heal' | 'utility' {
  const type = activityType(item);
  if (type === 'heal') return 'heal';
  if (type === 'attack') return 'damage';
  if (type === 'save') {
    const damageParts = getPath(firstActivity(item), 'damage.parts');
    if (Array.isArray(damageParts) && damageParts.length > 0) return 'damage';
  }
  return 'utility';
}

/**
 * The ability modifier dnd5e would add to this weapon's attack/damage roll.
 * An explicit activity `attack.ability` override wins; otherwise a finesse
 * weapon picks the better of STR/DEX, a ranged weapon uses DEX, and anything
 * else — including a thrown-but-not-finesse weapon, which by RAW keeps its
 * melee ability — uses STR.
 */
function weaponAbilityMod(actor: FoundryActorDoc, item: FoundryItemDoc): number {
```

Note: `weaponAbilityMod` and `weaponDamageFormula` (right below it) currently compute `firstActivity` inline with their own `rec(...)`/`Object.values(...)` logic — leave those two functions exactly as they are for this task (don't refactor them to call the new `firstActivity` helper; that's an unrelated change and out of scope). Task 4 will touch `weaponAbilityMod` only if needed — it isn't.

- [ ] **Step 4: Wire `effectType` into the spell and feature-use descriptors**

In the same file, find (inside `buildActions`, the spell block):

```ts
      if (level === 0 || isPrepared) {
        // The bridge casts at base level only (no upcast), so a spell is either
        // castable now (single Cast) or not (disabled). We signal this with
        // slotLevels: absent = castable directly (cantrip or a base slot is
        // free); [] = no slot, render disabled. No per-level picker — the
        // module cannot honour a chosen higher level.
        out.push({
          id: `spell.${item._id}.cast`,
          label: item.name,
          kind: 'cast',
          ...(level > 0 && !canCastAtBase(actor, level) ? { slotLevels: [] } : {}),
        });
      }
```

Replace with:

```ts
      if (level === 0 || isPrepared) {
        // The bridge casts at base level only (no upcast), so a spell is either
        // castable now (single Cast) or not (disabled). We signal this with
        // slotLevels: absent = castable directly (cantrip or a base slot is
        // free); [] = no slot, render disabled. No per-level picker — the
        // module cannot honour a chosen higher level.
        out.push({
          id: `spell.${item._id}.cast`,
          label: item.name,
          kind: 'cast',
          effectType: effectTypeOf(item),
          ...(level > 0 && !canCastAtBase(actor, level) ? { slotLevels: [] } : {}),
        });
      }
```

Then find (a few lines later, the feature-use push):

```ts
    if (isUsableFeature(item)) {
      out.push({ id: `feature.${item._id}.use`, label: item.name, kind: 'use' });
    }
```

Replace with:

```ts
    if (isUsableFeature(item)) {
      out.push({ id: `feature.${item._id}.use`, label: item.name, kind: 'use', effectType: effectTypeOf(item) });
    }
```

Note: the item-use push (`item.${item._id}.use`, `group: 'items'`, physical consumables) is deliberately left untouched — magic items with effects are out of scope for this plan (see spec).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/adapter-dnd5e && npx vitest run test/actions.test.ts -t "effectType classification"`
Expected: PASS (7 tests).

- [ ] **Step 6: Run the full adapter-dnd5e suite and fix the two known breakages**

Run: `npx vitest run`
Expected: 2 pre-existing failures — both are strict `toEqual` on a full descriptor object, which now gains `effectType`. Fix both exactly (do not loosen to `toMatchObject` or drop fields):

In `packages/adapter-dnd5e/test/actions.test.ts`, find:

```ts
  it('usable feature (Second Wind, has an activity) gets a use action; passive feat (Grappler) gets none', () => {
    expect(action(martialCaptured, 'feature.7r63kurEAM3GdEec.use')).toEqual({
      id: 'feature.7r63kurEAM3GdEec.use',
      label: 'Second Wind',
      kind: 'use',
    });
```

Replace with:

```ts
  it('usable feature (Second Wind, has an activity) gets a use action; passive feat (Grappler) gets none', () => {
    expect(action(martialCaptured, 'feature.7r63kurEAM3GdEec.use')).toEqual({
      id: 'feature.7r63kurEAM3GdEec.use',
      label: 'Second Wind',
      kind: 'use',
      effectType: 'heal',
    });
```

Then find:

```ts
  it('a leveled spell with a base-level slot is directly castable (no slotLevels — the bridge casts at base only)', () => {
    // Guiding Bolt (level 1); raw capture has spell1.value > 0.
    expect(action(casterCaptured, 'spell.pZMrJb3AXiRYO5E8.cast')).toEqual({
      id: 'spell.pZMrJb3AXiRYO5E8.cast',
      label: 'Guiding Bolt',
      kind: 'cast',
    });
  });
```

Replace with:

```ts
  it('a leveled spell with a base-level slot is directly castable (no slotLevels — the bridge casts at base only)', () => {
    // Guiding Bolt (level 1); raw capture has spell1.value > 0.
    expect(action(casterCaptured, 'spell.pZMrJb3AXiRYO5E8.cast')).toEqual({
      id: 'spell.pZMrJb3AXiRYO5E8.cast',
      label: 'Guiding Bolt',
      kind: 'cast',
      effectType: 'damage',
    });
  });
```

Re-run `npx vitest run` — expect one further failure, in `describe('item use actions (inventory/actions split)', ...)`: `'still maps feature use intents to use-feature'`. Leave that one for Task 4 (it's a `buildAction` behavior change, not a descriptor-field change — Task 4 replaces it).

- [ ] **Step 7: Typecheck**

Run: `cd .. && .. && pnpm --filter @companion/adapter-dnd5e typecheck`
Expected: `Done`.

- [ ] **Step 8: Commit**

```bash
git add packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/actions.test.ts
git commit -m "feat(adapter-dnd5e): classify spells/features as damage/heal/utility"
```

---

### Task 4: `adapter-dnd5e` — heal formula + self-heal write-through

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` (add helpers after `weaponDamageFormula`, ~line 1208; modify `buildAction`'s `'use'` and `'cast'` cases, ~lines 1359-1375)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`

**Interfaces:**
- Consumes: `activityType`, `firstActivity` (Task 3); `abilityMod`, `characterLevel`, `strAt`, `numAt`, `rec`, `getPath` (existing helpers, lines 49-273); `IntentError` (from `@companion/adapter-sdk`, already imported).
- Produces: `healFormula(actor, item): string | undefined`, `isSelfTargeted(item): boolean`, `buildHealAction(actor, item, actionId): RelayAction` — used only within this file's own `buildAction`.

- [ ] **Step 1: Write the failing tests**

In `packages/adapter-dnd5e/test/actions.test.ts`, add a new describe block right after the `describe('effectType classification (M15)', ...)` block added in Task 3 (before `describe('buildAction — rejections', ...)`):

```ts
describe('buildAction — heal formulas & self-heal write-through (M15)', () => {
  it('Second Wind (self-targeted) rolls 1d10 + fighter level and writes HP directly', () => {
    // Randal's fixture HP is 35/44 (system.attributes.hp — verified directly
    // against martial-captured.json; do not assume live-session values,
    // they drift as the test campaign is played).
    expect(build(martialCaptured, { kind: 'use', actionId: 'feature.7r63kurEAM3GdEec.use' })).toEqual({
      endpoint: 'roll-and-heal',
      formula: '1d10 + 5',
      flavor: 'Second Wind — Healing',
      path: 'system.attributes.hp.value',
      current: 35,
      max: 44,
    });
  });

  it('Cure Wounds (target-chosen, not self) rolls 1d8 + spellcasting mod but does NOT auto-apply', () => {
    // Akra: WIS 15 (+2), Cleric spellcasting ability is "wis" in the fixture.
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.LjT1wf4D38c9Ieuo.cast' })).toEqual({
      endpoint: 'roll',
      formula: '1d8 + 2',
      flavor: 'Cure Wounds — Healing',
    });
  });

  it('Healing Word (target-chosen, not self) rolls 1d4 + spellcasting mod', () => {
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.HpjaVMLEU14tJG7y.cast' })).toEqual({
      endpoint: 'roll',
      formula: '1d4 + 2',
      flavor: 'Healing Word — Healing',
    });
  });

  it('non-heal use/cast actions are unaffected (Guiding Bolt still maps to use-spell)', () => {
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: 'pZMrJb3AXiRYO5E8',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/adapter-dnd5e && npx vitest run test/actions.test.ts -t "heal formulas"`
Expected: FAIL — `build()` for Second Wind/Cure Wounds/Healing Word still returns `{endpoint:'use-feature',...}`/`{endpoint:'use-spell',...}` (the old behavior), not the new roll/roll-and-heal shapes.

- [ ] **Step 3: Implement `healFormula`, `isSelfTargeted`, `buildHealAction`**

In `packages/adapter-dnd5e/src/index.ts`, find (right after `weaponDamageFormula`'s closing brace, before `function buildActions`):

```ts
function weaponDamageFormula(actor: FoundryActorDoc, item: FoundryItemDoc): string | undefined {
  const base = rec(getPath(item.system, 'damage.base'));
  const number = typeof base.number === 'number' && Number.isFinite(base.number) ? base.number : undefined;
  const denomination =
    typeof base.denomination === 'number' && Number.isFinite(base.denomination) ? base.denomination : undefined;
  if (number === undefined || denomination === undefined || number <= 0 || denomination <= 0) return undefined;
  const dice = `${number}d${denomination}`;
  const rawBonus = typeof base.bonus === 'string' ? Number(base.bonus) : 0;
  const staticBonus = Number.isFinite(rawBonus) ? rawBonus : 0;
  const bonus = staticBonus + weaponAbilityMod(actor, item);
  if (bonus === 0) return dice;
  return `${dice} ${bonus < 0 ? '-' : '+'} ${Math.abs(bonus)}`;
}

function buildActions(actor: FoundryActorDoc): ActionDescriptor[] {
```

Replace with:

```ts
function weaponDamageFormula(actor: FoundryActorDoc, item: FoundryItemDoc): string | undefined {
  const base = rec(getPath(item.system, 'damage.base'));
  const number = typeof base.number === 'number' && Number.isFinite(base.number) ? base.number : undefined;
  const denomination =
    typeof base.denomination === 'number' && Number.isFinite(base.denomination) ? base.denomination : undefined;
  if (number === undefined || denomination === undefined || number <= 0 || denomination <= 0) return undefined;
  const dice = `${number}d${denomination}`;
  const rawBonus = typeof base.bonus === 'string' ? Number(base.bonus) : 0;
  const staticBonus = Number.isFinite(rawBonus) ? rawBonus : 0;
  const bonus = staticBonus + weaponAbilityMod(actor, item);
  if (bonus === 0) return dice;
  return `${dice} ${bonus < 0 ? '-' : '+'} ${Math.abs(bonus)}`;
}

/** True only for activities whose target is unconditionally the caster
 *  (Second Wind). Cure Wounds/Healing Word have no `target.affects.type` at
 *  all — they're cast at a creature the player chooses in Foundry, which is
 *  usually NOT the caster — so this must be the sole signal for whether a
 *  heal auto-applies to the actor's own HP (verified against both fixtures:
 *  Second Wind's `target.affects.type` is `"self"`; Cure Wounds/Healing
 *  Word's `target.affects` has no `type` field at all). */
function isSelfTargeted(item: FoundryItemDoc): boolean {
  return getPath(firstActivity(item), 'target.affects.type') === 'self';
}

/**
 * Heal formula for a heal-type activity: base dice + a resolved bonus.
 * Mirrors weaponDamageFormula. `bonus` is a Foundry roll-data reference
 * string; only two shapes appear in dnd5e content and are resolved
 * explicitly — anything else falls back to +0 (documented gap, not a
 * roll-data evaluator, same honesty as weaponDamageFormula):
 *   "@mod"                  -> the actor's spellcasting ability modifier
 *                              (`actor.system.attributes.spellcasting`).
 *   "@classes.<id>.levels"  -> approximated with total character level
 *                              (ignores multiclass split — same caveat
 *                              already accepted for weapon ability lookups).
 * Undefined when the activity carries no healing dice.
 */
function healFormula(actor: FoundryActorDoc, item: FoundryItemDoc): string | undefined {
  const healing = rec(getPath(firstActivity(item), 'healing'));
  const number = typeof healing.number === 'number' && Number.isFinite(healing.number) ? healing.number : undefined;
  const denomination =
    typeof healing.denomination === 'number' && Number.isFinite(healing.denomination) ? healing.denomination : undefined;
  if (number === undefined || denomination === undefined || number <= 0 || denomination <= 0) return undefined;
  const dice = `${number}d${denomination}`;
  const rawBonus = typeof healing.bonus === 'string' ? healing.bonus.trim() : '';
  let bonus: number;
  if (rawBonus === '@mod') {
    const ability = strAt(actor.system, 'attributes.spellcasting') ?? 'wis';
    bonus = abilityMod(actor.system, ability);
  } else if (/^@classes\.[a-z]+\.levels$/.test(rawBonus)) {
    bonus = characterLevel(actor);
  } else {
    const flat = Number(rawBonus);
    bonus = Number.isFinite(flat) ? flat : 0;
  }
  if (bonus === 0) return dice;
  return `${dice} ${bonus < 0 ? '-' : '+'} ${Math.abs(bonus)}`;
}

/**
 * A heal-type use/cast: the relay only auto-executes attack-type activities
 * (live-verified 2026-07-09 — Second Wind's "Use" consumed its use but
 * rolled/applied nothing), so the roll is computed client-side, same as
 * weapon damage. Self-targeted heals (Second Wind) also write the resulting
 * HP directly, since there's no card-click step to rely on; heals that
 * target a chosen creature (Cure Wounds, Healing Word) only roll and
 * display — applying them to whichever creature was healed stays a manual
 * step in Foundry, exactly like weapon damage today.
 */
function buildHealAction(actor: FoundryActorDoc, item: FoundryItemDoc, actionId: string): RelayAction {
  const formula = healFormula(actor, item);
  if (formula === undefined) {
    throw new IntentError(`no heal formula for "${actionId}"`, 'UNKNOWN_RESOURCE');
  }
  const flavor = `${item.name} — Healing`;
  if (!isSelfTargeted(item)) {
    return { endpoint: 'roll', formula, flavor };
  }
  const current = numAt(actor.system, 'attributes.hp.value') ?? 0;
  const max = numAt(actor.system, 'attributes.hp.max') ?? current;
  return { endpoint: 'roll-and-heal', formula, flavor, path: 'system.attributes.hp.value', current, max };
}

function buildActions(actor: FoundryActorDoc): ActionDescriptor[] {
```

- [ ] **Step 4: Wire `buildHealAction` into `buildAction`'s `'use'` and `'cast'` cases**

In the same file, find:

```ts
    case 'use': {
      // Items and features share the kind; the id prefix picks the endpoint.
      if (intent.actionId.startsWith('item.')) {
        return { endpoint: 'use-item', itemId: intent.actionId.slice('item.'.length, -'.use'.length) };
      }
      return { endpoint: 'use-feature', itemId: intent.actionId.slice('feature.'.length, -'.use'.length) };
    }
    case 'cast': {
      const itemId = intent.actionId.slice('spell.'.length, -'.cast'.length);
      // slotLevels === [] means no slot is available at the spell's base
      // level. The bridge casts at base only (no upcast), so intent.slotLevel
      // is intentionally ignored — Foundry consumes the base-level slot.
      if (descriptor.slotLevels !== undefined && descriptor.slotLevels.length === 0) {
        throw new IntentError(`no spell slot available for "${intent.actionId}"`, 'INVALID');
      }
      return { endpoint: 'use-spell', itemId };
    }
```

Replace with:

```ts
    case 'use': {
      // Items and features share the kind; the id prefix picks the endpoint.
      if (intent.actionId.startsWith('item.')) {
        return { endpoint: 'use-item', itemId: intent.actionId.slice('item.'.length, -'.use'.length) };
      }
      const itemId = intent.actionId.slice('feature.'.length, -'.use'.length);
      const item = (actor.items ?? []).find((i) => i._id === itemId);
      if (item && activityType(item) === 'heal') {
        return buildHealAction(actor, item, intent.actionId);
      }
      return { endpoint: 'use-feature', itemId };
    }
    case 'cast': {
      const itemId = intent.actionId.slice('spell.'.length, -'.cast'.length);
      // slotLevels === [] means no slot is available at the spell's base
      // level. The bridge casts at base only (no upcast), so intent.slotLevel
      // is intentionally ignored — Foundry consumes the base-level slot.
      if (descriptor.slotLevels !== undefined && descriptor.slotLevels.length === 0) {
        throw new IntentError(`no spell slot available for "${intent.actionId}"`, 'INVALID');
      }
      const item = (actor.items ?? []).find((i) => i._id === itemId);
      if (item && activityType(item) === 'heal') {
        return buildHealAction(actor, item, intent.actionId);
      }
      return { endpoint: 'use-spell', itemId };
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/adapter-dnd5e && npx vitest run test/actions.test.ts -t "heal formulas"`
Expected: PASS (4 tests).

- [ ] **Step 6: Fix the known-broken `use-feature` fallback test**

`npx vitest run` will now fail one test left over from Task 3's Step 6:
`'still maps feature use intents to use-feature'` — its whole premise (Second
Wind maps to `use-feature`) is exactly what this task changed. Second Wind no
longer exercises the plain fallback path at all, so cover it with a cloned
non-heal feature instead.

In `packages/adapter-dnd5e/test/actions.test.ts`, find:

```ts
  it('still maps feature use intents to use-feature', () => {
    expect(build(martialCaptured, { kind: 'use', actionId: 'feature.7r63kurEAM3GdEec.use' })).toEqual({
      endpoint: 'use-feature',
      itemId: '7r63kurEAM3GdEec',
    });
  });
```

Replace with:

```ts
  it('still maps feature use intents to use-feature (non-heal features are unaffected by M15)', () => {
    // Second Wind is heal-type and now maps to roll-and-heal (see the M15
    // 'buildAction — heal formulas & self-heal write-through' describe
    // block) — clone it with a non-heal activity type to keep covering the
    // plain use-feature fallback path.
    const nonHeal: FoundryActorDoc = {
      ...martialCaptured,
      items: (martialCaptured.items ?? []).map((i) => {
        if (i._id !== '7r63kurEAM3GdEec') return i;
        const system = i.system as Record<string, unknown>;
        const activities = system.activities as Record<string, unknown>;
        const activityId = Object.keys(activities)[0] as string;
        const activity = activities[activityId] as Record<string, unknown>;
        return {
          ...i,
          system: { ...system, activities: { ...activities, [activityId]: { ...activity, type: 'utility' } } },
        };
      }),
    };
    expect(build(nonHeal, { kind: 'use', actionId: 'feature.7r63kurEAM3GdEec.use' })).toEqual({
      endpoint: 'use-feature',
      itemId: '7r63kurEAM3GdEec',
    });
  });
```

- [ ] **Step 7: Run the full adapter-dnd5e suite (regression check)**

Run: `npx vitest run`
Expected: all suites pass — 256 tests total (245 from before this plan, + 7 from Task 3, + 4 from this task; the one modified test in this step doesn't change the count).

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @companion/adapter-dnd5e typecheck` (from repo root)
Expected: `Done`.

- [ ] **Step 9: Commit**

```bash
git add packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/actions.test.ts
git commit -m "fix(adapter-dnd5e): self-heals (Second Wind) actually roll and apply HP"
```

---

### Task 5: `apps/web` — filter chips on the Spells list

**Files:**
- Modify: `apps/web/app/components/SectionActions.vue`

**Interfaces:**
- Consumes: `ActionDescriptor.effectType` (Task 3), already flowing through `combatActions` in `actor/[id].vue` (no changes needed there — `combatActions` already passes every `cast`/`use`/`attack`/`damage` descriptor through unfiltered, `effectType` just rides along on the ones that have it).

- [ ] **Step 1: Add the filter-chip state and filtering logic**

In `apps/web/app/components/SectionActions.vue`, find:

```ts
/** Non-empty groups only — kind AND group hint must match. */
const groups = computed(() =>
  GROUP_DEFS.map((def) => ({
    ...def,
    actions: props.actions.filter((a) => a.kind === def.kind && a.group === def.group),
  })).filter((g) => g.actions.length > 0),
)

function noSlots(action: ActionDescriptor): boolean {
  return action.kind === 'cast' && action.slotLevels !== undefined && action.slotLevels.length === 0
}
```

Replace with:

```ts
/** Non-empty groups only — kind AND group hint must match. */
const groups = computed(() =>
  GROUP_DEFS.map((def) => ({
    ...def,
    actions: props.actions.filter((a) => a.kind === def.kind && a.group === def.group),
  })).filter((g) => g.actions.length > 0),
)

function noSlots(action: ActionDescriptor): boolean {
  return action.kind === 'cast' && action.slotLevels !== undefined && action.slotLevels.length === 0
}

/** Filter chips on the Spells list only (M15) — single-select, default All. */
const SPELL_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'damage', label: '⚔️ Atk' },
  { id: 'heal', label: '⚕️ Heal' },
  { id: 'utility', label: '⚙️ Util' },
] as const

const spellFilter = ref<(typeof SPELL_FILTERS)[number]['id']>('all')

function visibleActions(group: (typeof groups.value)[number]): ActionDescriptor[] {
  if (group.id !== 'spells' || spellFilter.value === 'all') return group.actions
  return group.actions.filter((a) => a.effectType === spellFilter.value)
}
```

- [ ] **Step 2: Render the chips and use `visibleActions` in the template**

Find:

```html
<template>
  <section v-for="group in groups" :key="group.id">
    <h2 class="section-title">{{ group.label }}</h2>
    <div class="list card">
      <div v-for="action in group.actions" :key="action.id" class="row">
```

Replace with:

```html
<template>
  <section v-for="group in groups" :key="group.id">
    <h2 class="section-title">{{ group.label }}</h2>
    <div v-if="group.id === 'spells'" class="filter-chips">
      <button
        v-for="chip in SPELL_FILTERS"
        :key="chip.id"
        type="button"
        class="chip"
        :class="{ active: spellFilter === chip.id }"
        @click="spellFilter = chip.id"
      >
        {{ chip.label }}
      </button>
    </div>
    <div class="list card">
      <div v-for="action in visibleActions(group)" :key="action.id" class="row">
```

- [ ] **Step 3: Add chip styling**

Find:

```css
.act-btn.secondary {
  padding: 0 12px;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink-dim);
  box-shadow: none;
}
```

Replace with:

```css
.act-btn.secondary {
  padding: 0 12px;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink-dim);
  box-shadow: none;
}

.filter-chips {
  display: flex;
  gap: 8px;
  padding: 0 2px 10px;
  overflow-x: auto;
}

.chip {
  flex: none;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 0.76rem;
  font-weight: 600;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink-dim);
}

.chip.active {
  border-color: var(--gold-deep);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  color: var(--accent-ink);
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @companion/web typecheck` (from repo root)
Expected: `Done`, no errors. `ref` and `computed` are Nuxt auto-imports — this file already uses `computed` without an explicit import, so no new import statement is needed for `ref` either.

- [ ] **Step 5: Manual live verification**

This app has no unit tests in v1 — verify live, the same way the M14 weapon-damage feature was verified in this session:

1. Ensure the dev stack is up (`pnpm dev:gateway`, `pnpm dev:web` — or confirm they're already running: `curl -s http://localhost:8090/healthz` should show `{"ok":true,"relay":"connected"}`).
2. Open the PWA, sign in, select Akra (Dragonborn Cleric), go to the Actions tab.
3. Confirm the Spells section now shows 4 chips above the list: `All`, `⚔️ Atk`, `⚕️ Heal`, `⚙️ Util`, with `All` visually active.
4. Tap `⚕️ Heal` — confirm the list narrows to exactly Healing Word and Cure Wounds.
5. Tap `⚙️ Util` — confirm the list shows Thaumaturgy, Guidance, Detect Magic, Bless (no Guiding Bolt, no heals).
6. Tap `⚔️ Atk` — confirm only Guiding Bolt shows (plus Sacred Flame once Task 3's classification is live — Sacred Flame is a save-type activity with damage parts, classified as `damage`).
7. Tap `All` — confirm the full list returns.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/components/SectionActions.vue
git commit -m "feat(web): filter chips on the Spells list by damage/heal/utility"
```

---

### Task 6: `apps/web` — effect-aware roll-result wording

**Files:**
- Modify: `apps/web/app/components/RollResultPill.vue`
- Modify: `apps/web/app/pages/actor/[id].vue`

**Interfaces:**
- Consumes: `ActionDescriptor.effectType` (Task 3), `ActionRollResult` (existing type, `apps/web/app/types/api.ts`).
- Produces: `showRoll(result, label, effectType?)` — extends the existing 2-arg function; all four existing call sites listed below must be updated in the same task so none are left passing only 2 args to a meaningfully-3-arg function (TypeScript won't error since the param stays optional, but leaving a call site un-updated silently loses the wording feature for that action — the "Run test/verify" step below manually re-checks the diff, not a compiler check).

- [ ] **Step 1: Add a `display` prop to `RollResultPill.vue`**

In `apps/web/app/components/RollResultPill.vue`, find:

```html
      <span class="total-wrap">
        <span v-if="result.isCritical || result.isFumble" class="burst" aria-hidden="true" />
        <span class="total tabular">{{ result.total }}</span>
      </span>
```

Replace with:

```html
      <span class="total-wrap">
        <span v-if="result.isCritical || result.isFumble" class="burst" aria-hidden="true" />
        <span class="total tabular">{{ display ?? result.total }}</span>
      </span>
```

Find:

```ts
defineProps<{ result: ActionRollResult; label: string }>()
```

Replace with:

```ts
defineProps<{ result: ActionRollResult; label: string; display?: string }>()
```

- [ ] **Step 2: Compute the wording in `showRoll` and pass it through**

In `apps/web/app/pages/actor/[id].vue`, find:

```ts
const lastRoll = ref<{ result: ActionRollResult; label: string } | null>(null)
```

Replace with:

```ts
const lastRoll = ref<{ result: ActionRollResult; label: string; display?: string } | null>(null)
```

Find:

```ts
function showRoll(result: ActionRollResult, label: string): void {
  lastRoll.value = { result, label }
```

Replace with:

```ts
type EffectType = 'damage' | 'heal' | 'utility'

/** M15: heal -> "+N HP", damage (weapon or spell) -> "N dmg", everything
 *  else keeps today's plain total. Only the displayed label changes —
 *  haptics/history/critical styling below are untouched. */
function effectDisplay(result: ActionRollResult, effectType: EffectType | undefined): string | undefined {
  if (effectType === 'heal') return `+${result.total} HP`
  if (effectType === 'damage') return `${result.total} dmg`
  return undefined
}

function showRoll(result: ActionRollResult, label: string, effectType?: EffectType): void {
  lastRoll.value = { result, label, display: effectDisplay(result, effectType) }
```

- [ ] **Step 3: Pass `display` through to the template**

Find:

```html
      <RollResultPill
        v-if="lastRoll"
        :result="lastRoll.result"
        :label="lastRoll.label"
        @dismiss="dismissRoll"
      />
```

Replace with:

```html
      <RollResultPill
        v-if="lastRoll"
        :result="lastRoll.result"
        :label="lastRoll.label"
        :display="lastRoll.display"
        @dismiss="dismissRoll"
      />
```

- [ ] **Step 4: Update `submitAction` to resolve the effect type from the intent/descriptor**

Find:

```ts
async function submitAction(intent: ActionIntent, label: string): Promise<void> {
  if (offline.value || actionBusy.value) return
  actionBusy.value = intent.actionId
  try {
    const res = await api<ActionResponse>(`/api/actors/${actorId.value}/actions`, {
      method: 'POST',
      body: intent,
    })
    applySheet(res.sheet)
    if (res.result) {
      showRoll(res.result, label)
      return
    }
```

Replace with:

```ts
async function submitAction(intent: ActionIntent, label: string, effectType?: EffectType): Promise<void> {
  if (offline.value || actionBusy.value) return
  actionBusy.value = intent.actionId
  try {
    const res = await api<ActionResponse>(`/api/actors/${actorId.value}/actions`, {
      method: 'POST',
      body: intent,
    })
    applySheet(res.sheet)
    if (res.result) {
      // Weapon damage rolls carry their effect via the intent kind itself
      // (no effectType on 'damage' descriptors — Attacks stays unfiltered);
      // cast/use heals and damage-save spells carry it via the descriptor.
      showRoll(res.result, label, intent.kind === 'damage' ? 'damage' : effectType)
      return
    }
```

- [ ] **Step 5: Pass `effectType` from every call site**

Find:

```ts
    case 'use':
      void submitAction({ kind: 'use', actionId }, action.label)
      break
```

Replace with:

```ts
    case 'use':
      void submitAction({ kind: 'use', actionId }, action.label, action.effectType)
      break
```

Find (inside `onCombatAction`):

```ts
  if (action.kind === 'cast') {
    if (action.slotLevels === undefined) {
      void submitAction({ kind: 'cast', actionId }, action.label)
      return
    }
    if (action.slotLevels.length === 0) return
  }
```

Replace with:

```ts
  if (action.kind === 'cast') {
    if (action.slotLevels === undefined) {
      void submitAction({ kind: 'cast', actionId }, action.label, action.effectType)
      return
    }
    if (action.slotLevels.length === 0) return
  }
```

Find (`onActionSubmit`, used by the check/save/cast action-sheet flow):

```ts
function onActionSubmit(intent: ActionIntent): void {
  const label = actionMap.value[intent.actionId]?.label ?? 'Roll'
  actionSheetFor.value = null
  void submitAction(intent, label)
}
```

Replace with:

```ts
function onActionSubmit(intent: ActionIntent): void {
  const action = actionMap.value[intent.actionId]
  actionSheetFor.value = null
  void submitAction(intent, action?.label ?? 'Roll', action?.effectType)
}
```

Leave the `case 'attack':` call site (`void submitAction({ kind: 'attack', actionId }, action.label)`) and the `case 'damage':` call site unchanged — attack rolls have no effect wording (stay a plain total), and damage rolls already get `'damage'` wording for free inside `submitAction` via the `intent.kind === 'damage'` check added in Step 4.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @companion/web typecheck` (from repo root)
Expected: `Done`, no errors.

- [ ] **Step 7: Manual live verification**

1. On Randal's Actions tab, tap Longsword's "Dmg" button — confirm the popup shows `12 dmg` (or whatever the roll lands on) instead of a bare number, labeled "Longsword — Damage".
2. On Randal's Actions tab, tap Second Wind's "Use" button — confirm the popup shows `+N HP`, and confirm HP actually increases on the sheet (check the Hit Points display at the top updates, capped at max).
3. On Akra's Actions tab, tap Cure Wounds' "Cast" button — confirm the popup shows `+N HP` (Healing wording), but confirm Akra's OWN Hit Points value does NOT change (Cure Wounds targets a chosen creature, not the caster — verify via `curl -s "http://localhost:8090/api/actors/pTvtx5dm2AuYqeX2/sheet" -H "Authorization: Bearer <token>"` before and after, comparing the `hp` resource value).
4. Tap a Check/Save action (e.g. Athletics) — confirm the popup still shows the plain total, unchanged from before this plan.

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/components/RollResultPill.vue apps/web/app/pages/actor/[id].vue
git commit -m "feat(web): effect-aware roll wording (+N HP / N dmg)"
```

---

### Task 7: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Full monorepo typecheck**

Run: `pnpm -r typecheck` (from repo root)
Expected: every workspace prints `Done`.

- [ ] **Step 2: Full monorepo test suite**

Run: `pnpm test` (from repo root)
Expected: all suites green — `adapter-dnd5e` (245 + 7 + 4 = 256 tests), `gateway` (81 + 2 = 83 tests), `foundry-client` (3 tests unchanged), `adapter-sdk`/`web` (no test files, print their placeholder message).

- [ ] **Step 3: Restart the gateway process to pick up the code changes**

The gateway dev process does not hot-reload adapter/gateway source changes made outside its own watch scope in this environment (confirmed earlier in this session — restarting was required after the M14 damage-button change). Find and restart it:

```bash
# PowerShell
Get-NetTCPConnection -LocalPort 8090 -State Listen | Select-Object -ExpandProperty OwningProcess
# Stop-Process -Id <that PID> -Force -Confirm:$false
```

Then relaunch it the same way it's already running in this environment (check `pnpm dev:gateway` or the equivalent `node --env-file=... tsx .../loader.mjs src/server.ts` invocation already in use), and confirm:

```bash
curl -s http://localhost:8090/healthz
```

Expected: `{"ok":true,"relay":"connected"}`.

- [ ] **Step 4: Re-run every manual verification step from Tasks 5 and 6 against the restarted gateway**

(Filter chips on Akra's Spells list; Second Wind heals and updates HP; Cure Wounds/Healing Word show `+N HP` without touching Akra's own HP; weapon damage still shows `N dmg`; checks/saves unchanged.)

- [ ] **Step 5: Final commit (only if any fixes were needed in this task)**

```bash
git add -A
git commit -m "chore: post-implementation regression fixes for M15 effect classification"
```

If no fixes were needed, skip this step — Tasks 1-6 already committed everything.
