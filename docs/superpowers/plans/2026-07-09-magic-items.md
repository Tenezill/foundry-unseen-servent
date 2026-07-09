# Magic Items — On-Use Effects, Attunement Enforcement, Charge/Recharge Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Physical magic items get the same on-use damage/heal wording and write-through M15 already built for spells/features, plus attunement-required-to-use enforcement and a recharge-period display — reusing existing classification/formula machinery instead of building parallel logic.

**Architecture:** Generalize `effectTypeOf`/`buildHealAction`/the weapon-damage-formula pattern (all in `packages/adapter-dnd5e/src/index.ts`) to also cover physical items, add one new `itemDamageFormula` helper for the "damage die lives on a sibling activity" shape real Foundry data turned out to have, and add a single attunement guard clause. No `adapter-sdk` or `apps/gateway` changes.

**Tech Stack:** TypeScript, Vitest, the existing `dnd5eAdapter` fixture-test harness (`packages/adapter-dnd5e/test/actions.test.ts`, `m12.test.ts`, `adapter.test.ts`).

## Global Constraints

- Data paths are pinned to dnd5e system **5.3.3** on Foundry **v13** (13.351) — same as every other file in this package.
- No `adapter-sdk` contract changes — `ActionDescriptor.effectType` and the `roll`/`roll-and-heal` `RelayAction` variants (M15) already cover everything this feature needs.
- No `apps/gateway` changes — every new `RelayAction` shape this feature returns (`roll`, `roll-and-heal`, the existing attunement-driven `IntentError` → 422 flow) is already wired end to end.
- Every new/changed function must keep the file's existing style: `Rec`/`getPath`/`rec`/`strAt`/`numAt` helpers, no new dependencies, doc comments only where a non-obvious real-data shape needs explaining (as several already do for M14/M15 gaps).
- Full monorepo test suite (`pnpm -r test` from the repo root) must stay green after every task.

---

## Prerequisite (already complete — commit `d0c97bf`)

Real magic items were added to the live Foundry world and captured into the fixtures, since neither fixture had any magic item before this feature (`system.rarity` was empty on every item in both files):

- **Bead of Force** (`iecfawCz0pIwcPVg`) added to Randal in `martial-captured.json`. Real shape: `rarity: "rare"`, `attunement: ""` (no attunement required), `uses: {max:"1", recovery:[], autoDestroy:true}`, two activities — `dnd5eactivity000` (`type: "save"`, DC 15 Dex, `damage.parts: []` — **empty**) and `dnd5eactivity300` (`type: "utility"`, `roll: {formula: "5d4"}`).
- **Potion of Healing** (`7vIZxvwGzmJgmugo`) added to Akra in `caster-captured.json`. Real shape: `rarity: "common"`, `attunement: ""`, `uses: {max:"1", recovery:[], autoDestroy:true}`, one activity — `dnd5eactivity000` (`type: "heal"`, `healing: {number:2, denomination:4, bonus:"2"}`, `target.affects: {type:"creature", count:"1"}` — **not** `"self"`).

The fixture-pinned action/weight counts that shifted as a result were already updated (`packages/adapter-dnd5e/test/actions.test.ts`, `packages/adapter-dnd5e/test/m12.test.ts`) and the full suite is green (256 adapter-dnd5e tests, 83 gateway tests). **Tasks below start from this baseline** — do not re-add these items or re-touch the pinned counts unless a task explicitly says to.

---

### Task 1: Extend `effectTypeOf` to items, wire `effectType` onto item-use descriptors

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts:1162-1197` (add `allActivities`, rewrite `effectTypeOf`), `packages/adapter-dnd5e/src/index.ts:1337` (add `effectType` to the `item.<id>.use` push)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`

**Interfaces:**
- Produces: `allActivities(item: FoundryItemDoc): Rec[]` — every activity on the item, in insertion order, empty array if none.
- Consumes: nothing new from other tasks (this task is self-contained and lands first).

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to `packages/adapter-dnd5e/test/actions.test.ts`, directly after the existing `describe('effectType classification (M15)', ...)` block (after its closing `});` — the fixtures already have Bead of Force at `iecfawCz0pIwcPVg` on `martialCaptured` and Potion of Healing at `7vIZxvwGzmJgmugo` on `casterCaptured` (added in the prerequisite step above):

```ts
describe('effectType classification — items (M16)', () => {
  it('Bead of Force (save DC on one activity, damage die on a separate utility activity) classifies as damage', () => {
    expect(action(martialCaptured, 'item.iecfawCz0pIwcPVg.use').effectType).toBe('damage');
  });

  it('Potion of Healing (heal-type activity) classifies as heal', () => {
    expect(action(casterCaptured, 'item.7vIZxvwGzmJgmugo.use').effectType).toBe('heal');
  });

  it('mundane items with no damage/heal activity stay utility (Torch)', () => {
    const torch = martialCaptured.items?.find((i) => i.name === 'Torch');
    if (!torch) throw new Error('Torch not found');
    expect(action(martialCaptured, `item.${torch._id}.use`).effectType).toBe('utility');
  });

  it('a lone save activity with no sibling utility roll still classifies as utility (regression: Bane/Command/Sanctuary unaffected)', () => {
    const prepared: FoundryActorDoc = {
      ...casterCaptured,
      items: (casterCaptured.items ?? []).map((i) =>
        i._id === '9FrgmKwWCYPhlZ5w'
          ? { ...i, system: { ...(i.system as Record<string, unknown>), prepared: 1 } }
          : i,
      ),
    };
    expect(action(prepared, 'spell.9FrgmKwWCYPhlZ5w.cast').effectType).toBe('utility'); // Bane
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/adapter-dnd5e && npx vitest run actions.test.ts`
Expected: the first three new tests FAIL — Bead of Force and Torch both currently classify as `'utility'` under the old first-activity-only rule (Bead of Force's first activity is `save` with empty `damage.parts`), and the item.use descriptor doesn't carry `effectType` at all yet (`undefined`, not `'damage'`/`'heal'`/`'utility'`). The fourth (Bane regression) test should already PASS unchanged — it's here to lock in the fix doesn't break it.

- [ ] **Step 3: Implement `allActivities` and the new `effectTypeOf` rule**

In `packages/adapter-dnd5e/src/index.ts`, right after `firstActivity` (currently ends at line 1168, just before the `activityType` function), add:

```ts
/** All of this item's activities, in insertion order, or empty if it has
 *  none. Some items split a single effect across more than one activity —
 *  Bead of Force's real data (live-captured 2026-07-09) has a `save`
 *  activity carrying the DC and a *separate* `utility` activity carrying
 *  the damage roll — so callers that need to find a specific activity
 *  type must scan all of them, not just the first. */
function allActivities(item: FoundryItemDoc): Rec[] {
  const activities = rec(getPath(item.system, 'activities'));
  return Object.values(activities).map(rec);
}
```

Replace the existing `effectTypeOf` function (lines 1188-1197) with:

```ts
/**
 * Classify a spell/feature/item for the Actions tab (M15/M16): 'heal' for
 * heal activities, 'damage' for attacks, for save activities that still
 * carry damage parts (e.g. Sacred Flame — mechanically a `save` activity,
 * not an `attack`, but it deals radiant damage on a failed save; verified
 * against the caster fixture: Sacred Flame's `damage.parts` has one entry,
 * the pure debuff saves Bane/Command/Sanctuary's are empty), and for items
 * that split DC and damage across two activities (Bead of Force: a `save`
 * activity for the DC, a separate `utility` activity whose `roll.formula`
 * carries the actual damage die — live-verified 2026-07-09, this item has
 * no non-empty `damage.parts` anywhere). 'utility' for everything else
 * (pure debuff saves, utility, check). Not exposed on weapon attack/damage
 * descriptors — Attacks is already its own unfiltered section.
 */
function effectTypeOf(item: FoundryItemDoc): 'damage' | 'heal' | 'utility' {
  const activities = allActivities(item);
  if (activities.some((a) => a.type === 'heal')) return 'heal';
  if (activities.some((a) => a.type === 'attack')) return 'damage';
  const hasSaveDamage = activities.some((a) => {
    if (a.type !== 'save') return false;
    const parts = getPath(a, 'damage.parts');
    return Array.isArray(parts) && parts.length > 0;
  });
  if (hasSaveDamage) return 'damage';
  const hasSave = activities.some((a) => a.type === 'save');
  const hasUtilityRoll = activities.some(
    (a) => a.type === 'utility' && typeof getPath(a, 'roll.formula') === 'string' && getPath(a, 'roll.formula') !== '',
  );
  if (hasSave && hasUtilityRoll) return 'damage';
  return 'utility';
}
```

Then, in `buildActions`, change the `item.<id>.use` push (currently line 1337):

```ts
      out.push({ id: `item.${item._id}.use`, label: item.name, kind: 'use', group: 'items' });
```

to:

```ts
      out.push({ id: `item.${item._id}.use`, label: item.name, kind: 'use', group: 'items', effectType: effectTypeOf(item) });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/adapter-dnd5e && npx vitest run`
Expected: all tests in `actions.test.ts` PASS, including the 4 new ones. Full package suite (256 tests before this task) now has 260 passing, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/actions.test.ts
git commit -m "feat: classify item on-use effects, covering Bead of Force's split-activity shape"
```

---

### Task 2: Item on-use damage and heal — formula computation and `buildAction` wiring

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` — add `itemDamageFormula` (near `weaponDamageFormula`/`healFormula`, e.g. right after `healFormula`, currently ending line 1291), add a `forceSelf` option to `buildHealAction` (lines 1303-1315), rewrite `buildAction`'s `'use'` case `item.` branch (lines 1469-1470)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`

**Interfaces:**
- Consumes: `allActivities(item)` (Task 1), `effectTypeOf(item)` (Task 1, now covers items).
- Produces: `itemDamageFormula(actor: FoundryActorDoc, item: FoundryItemDoc): string | undefined`. `buildHealAction(actor, item, actionId, opts?: { forceSelf?: boolean })` — the new 4th parameter is optional so Task 1's callers (unaffected, still spell/feature-only) and the M15 call sites in the `'cast'`/`feature.`-branch of `'use'` need no changes.

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `packages/adapter-dnd5e/test/actions.test.ts`, directly after `describe('buildAction — heal formulas & self-heal write-through (M15)', ...)`:

```ts
describe('buildAction — item on-use effects (M16)', () => {
  it('Bead of Force rolls its sibling-activity damage formula verbatim, display-only', () => {
    expect(build(martialCaptured, { kind: 'use', actionId: 'item.iecfawCz0pIwcPVg.use' })).toEqual({
      endpoint: 'roll',
      formula: '5d4',
      flavor: 'Bead of Force — Damage',
    });
  });

  it('Potion of Healing always self-heals, even though its real target.affects.type is "creature", not "self"', () => {
    // Akra's fixture HP is 38/38 (verified directly against caster-captured.json).
    expect(build(casterCaptured, { kind: 'use', actionId: 'item.7vIZxvwGzmJgmugo.use' })).toEqual({
      endpoint: 'roll-and-heal',
      formula: '2d4 + 2',
      flavor: 'Potion of Healing — Healing',
      path: 'system.attributes.hp.value',
      current: 38,
      max: 38,
    });
  });

  it('a mundane item with no damage/heal effect is unaffected (Torch still maps to use-item)', () => {
    const torch = martialCaptured.items?.find((i) => i.name === 'Torch');
    if (!torch) throw new Error('Torch not found');
    expect(build(martialCaptured, { kind: 'use', actionId: `item.${torch._id}.use` })).toEqual({
      endpoint: 'use-item',
      itemId: torch._id,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/adapter-dnd5e && npx vitest run actions.test.ts`
Expected: the first two new tests FAIL (both items currently fall through to `{ endpoint: 'use-item', itemId }` since `buildAction`'s item branch does no effect check yet). The third test should already PASS unchanged.

- [ ] **Step 3: Implement `itemDamageFormula`, `buildHealAction`'s `forceSelf`, and the `buildAction` wiring**

In `packages/adapter-dnd5e/src/index.ts`, right after `healFormula` (currently ends at line 1291, just before the `buildHealAction` doc comment), add:

```ts
/**
 * Damage formula for an item's on-use damage effect (M16), checked in the
 * order these two real shapes were confirmed to exist:
 *   1. Inline `damage.parts` on any activity (a future item shaped like
 *      Sacred Flame) — each part's `number`/`denomination` becomes a dice
 *      term, `bonus` resolves through the same two roll-data shapes
 *      `healFormula`/`weaponDamageFormula` already accept, parts join
 *      with `+`.
 *   2. A sibling `utility` activity's `roll.formula` string, used verbatim
 *      (Bead of Force's real shape — its `"5d4"` is already a complete
 *      dice formula with no roll-data references to resolve, unlike a
 *      spell/feature's healing/damage dice).
 * Undefined when neither shape is present.
 */
function itemDamageFormula(actor: FoundryActorDoc, item: FoundryItemDoc): string | undefined {
  const activities = allActivities(item);
  for (const activity of activities) {
    const rawParts = getPath(activity, 'damage.parts');
    if (!Array.isArray(rawParts) || rawParts.length === 0) continue;
    const terms: string[] = [];
    for (const rawPart of rawParts) {
      const part = rec(rawPart);
      const number = typeof part.number === 'number' && Number.isFinite(part.number) ? part.number : undefined;
      const denomination =
        typeof part.denomination === 'number' && Number.isFinite(part.denomination) ? part.denomination : undefined;
      if (number === undefined || denomination === undefined || number <= 0 || denomination <= 0) continue;
      const dice = `${number}d${denomination}`;
      const rawBonus = typeof part.bonus === 'string' ? part.bonus.trim() : '';
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
      terms.push(bonus === 0 ? dice : `${dice} ${bonus < 0 ? '-' : '+'} ${Math.abs(bonus)}`);
    }
    if (terms.length > 0) return terms.join(' + ');
  }
  const utilityRoll = activities.find(
    (a) => a.type === 'utility' && typeof getPath(a, 'roll.formula') === 'string' && getPath(a, 'roll.formula') !== '',
  );
  if (utilityRoll) return String(getPath(utilityRoll, 'roll.formula'));
  return undefined;
}
```

Change `buildHealAction`'s signature and self-check (lines 1303-1315) from:

```ts
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
```

to:

```ts
function buildHealAction(
  actor: FoundryActorDoc,
  item: FoundryItemDoc,
  actionId: string,
  opts?: { forceSelf?: boolean },
): RelayAction {
  const formula = healFormula(actor, item);
  if (formula === undefined) {
    throw new IntentError(`no heal formula for "${actionId}"`, 'UNKNOWN_RESOURCE');
  }
  const flavor = `${item.name} — Healing`;
  if (!opts?.forceSelf && !isSelfTargeted(item)) {
    return { endpoint: 'roll', formula, flavor };
  }
  const current = numAt(actor.system, 'attributes.hp.value') ?? 0;
  const max = numAt(actor.system, 'attributes.hp.max') ?? current;
  return { endpoint: 'roll-and-heal', formula, flavor, path: 'system.attributes.hp.value', current, max };
}
```

`opts?.forceSelf` short-circuits before `isSelfTargeted` runs at all — this is deliberate: physical items have no other-creature-targeting flow in this app (a potion is always drunk by its own holder), so an item's heal must always self-apply regardless of what `target.affects.type` says (Potion of Healing's real value is `"creature"`, not `"self"`). The existing `feature.`/`'cast'` call sites in `buildAction` are untouched — they call `buildHealAction(actor, item, intent.actionId)` with no 4th argument, so `opts` is `undefined` and behavior is identical to before this task.

Finally, change `buildAction`'s `'use'` case (lines 1467-1478) from:

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
```

to:

```ts
    case 'use': {
      // Items and features share the kind; the id prefix picks the endpoint.
      if (intent.actionId.startsWith('item.')) {
        const itemId = intent.actionId.slice('item.'.length, -'.use'.length);
        const item = (actor.items ?? []).find((i) => i._id === itemId);
        if (item) {
          const effect = effectTypeOf(item);
          if (effect === 'heal') {
            return buildHealAction(actor, item, intent.actionId, { forceSelf: true });
          }
          if (effect === 'damage') {
            const formula = itemDamageFormula(actor, item);
            if (!formula) throw new IntentError(`no damage formula for "${intent.actionId}"`, 'UNKNOWN_RESOURCE');
            return { endpoint: 'roll', formula, flavor: `${item.name} — Damage` };
          }
        }
        return { endpoint: 'use-item', itemId };
      }
      const itemId = intent.actionId.slice('feature.'.length, -'.use'.length);
      const item = (actor.items ?? []).find((i) => i._id === itemId);
      if (item && activityType(item) === 'heal') {
        return buildHealAction(actor, item, intent.actionId);
      }
      return { endpoint: 'use-feature', itemId };
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/adapter-dnd5e && npx vitest run`
Expected: all tests PASS, 263 total in the package (260 after Task 1 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/actions.test.ts
git commit -m "feat: item on-use damage/heal effects (Bead of Force, Potion of Healing)"
```

---

### Task 3: Attunement-required-to-use enforcement

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` — `buildAction`'s `'use'` case, `item.` branch (the block Task 2 just wrote)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`

**Interfaces:**
- Consumes: `isAttuneable(item)`, `isAttuned(item)` (existing M12 functions, unchanged).
- Produces: nothing new — this task only adds a guard clause inside `buildAction`.

Neither Bead of Force nor Potion of Healing requires attunement in their real captured data (`attunement: ""` on both), so this task's tests use a synthetic clone of an existing item with `system.attunement` patched to `"required"` — the same technique already used elsewhere in this file for the Bane-classification and non-heal-Second-Wind tests (clone the actor, patch one item's `system`, leave everything else untouched).

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `packages/adapter-dnd5e/test/actions.test.ts`, directly after the `describe('buildAction — item on-use effects (M16)', ...)` block Task 2 added:

```ts
describe('buildAction — attunement-required-to-use enforcement (M16)', () => {
  function withAttunement(attunement: string, attuned: boolean): FoundryActorDoc {
    return {
      ...martialCaptured,
      items: (martialCaptured.items ?? []).map((i) =>
        i._id === 'iecfawCz0pIwcPVg'
          ? { ...i, system: { ...(i.system as Record<string, unknown>), attunement, attuned } }
          : i,
      ),
    };
  }

  it('blocks use with a clear message when attunement is required but missing', () => {
    const actor = withAttunement('required', false);
    let caught: unknown;
    try {
      build(actor, { kind: 'use', actionId: 'item.iecfawCz0pIwcPVg.use' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IntentError);
    expect((caught as IntentError).code).toBe('INVALID');
    expect((caught as IntentError).message).toBe('"Bead of Force" requires attunement');
  });

  it('allows use normally once attuned', () => {
    const actor = withAttunement('required', true);
    expect(build(actor, { kind: 'use', actionId: 'item.iecfawCz0pIwcPVg.use' })).toEqual({
      endpoint: 'roll',
      formula: '5d4',
      flavor: 'Bead of Force — Damage',
    });
  });

  it('items that do not require attunement are unaffected (Bead of Force real data, Torch)', () => {
    expect(build(martialCaptured, { kind: 'use', actionId: 'item.iecfawCz0pIwcPVg.use' })).toEqual({
      endpoint: 'roll',
      formula: '5d4',
      flavor: 'Bead of Force — Damage',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/adapter-dnd5e && npx vitest run actions.test.ts`
Expected: the first two new tests FAIL (no attunement gate exists yet, so both calls return the damage roll instead of throwing / instead of behaving identically for both attuned states). The third test should already PASS unchanged (it's a regression guard for Task 2's behavior on the real, non-attuneable item).

- [ ] **Step 3: Implement the attunement gate**

In `packages/adapter-dnd5e/src/index.ts`, in `buildAction`'s `'use'` case, add the guard as the first statement inside the `item.` branch — change:

```ts
      if (intent.actionId.startsWith('item.')) {
        const itemId = intent.actionId.slice('item.'.length, -'.use'.length);
        const item = (actor.items ?? []).find((i) => i._id === itemId);
        if (item) {
          const effect = effectTypeOf(item);
```

to:

```ts
      if (intent.actionId.startsWith('item.')) {
        const itemId = intent.actionId.slice('item.'.length, -'.use'.length);
        const item = (actor.items ?? []).find((i) => i._id === itemId);
        if (item && isAttuneable(item) && !isAttuned(item)) {
          throw new IntentError(`"${item.name}" requires attunement`, 'INVALID');
        }
        if (item) {
          const effect = effectTypeOf(item);
```

(everything else in the branch — the `heal`/`damage`/fallback logic Task 2 wrote — is unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/adapter-dnd5e && npx vitest run`
Expected: all tests PASS, 266 total in the package (263 after Task 2 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/actions.test.ts
git commit -m "feat: block use of attunement-required items until attuned"
```

---

### Task 4: Recharge-period display on inventory rows

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` — add `RECOVERY_LABELS` + `recoveryLabel` (near `usesInfo`, e.g. right after it, currently ending line 333), extend `inventoryListItem` (currently lines 930-972)
- Test: `packages/adapter-dnd5e/test/adapter.test.ts`

**Interfaces:**
- Produces: `recoveryLabel(item: FoundryItemDoc): string | undefined` — a friendly recharge-period string (`"short rest"`, `"long rest"`, or the raw period value for anything else), or `undefined` when the item has no recovery period.
- Consumes: nothing from earlier tasks — independent of Tasks 1-3.

No real item in either fixture has both a recovery period AND is a physical item (Second Wind/Breath Weapon, the only items with recovery periods, are both feats — `PHYSICAL_ITEM_TYPES` doesn't include `feat`, so they never go through `inventoryListItem`). This task's "present" case therefore clones an existing physical item (Waterskin) with a patched `uses.recovery`, same synthetic-clone technique as Task 3. The "absent" case uses Bead of Force/Torch's real data unchanged (both have `uses.recovery: []`).

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `packages/adapter-dnd5e/test/adapter.test.ts`, near the existing inventory-row `sub` tests (e.g. directly after the test asserting `torch?.sub).toBe('×10 · consumable · 10 × 1 lb')` at line 566):

```ts
describe('inventory row recharge display (M16)', () => {
  function withWaterskinRecovery(period: string): FoundryActorDoc {
    return {
      ...martialCaptured,
      items: (martialCaptured.items ?? []).map((i) =>
        i._id === '4c3saZuHGHXb8Qlg' // Waterskin
          ? {
              ...i,
              system: {
                ...(i.system as Record<string, unknown>),
                uses: { max: '4', spent: 0, recovery: [{ period, type: 'recoverAll' }] },
              },
            }
          : i,
      ),
    };
  }

  it('shows a friendly recharge label when the item has a recovery period', () => {
    const inv = section(withWaterskinRecovery('dawn'), 'inventory');
    if (inv.kind !== 'list') throw new Error('inventory must be a list section');
    expect(inv.items.find((i) => i.label === 'Waterskin')?.sub).toBe('consumable · 5 lb · recharges: dawn');
  });

  it('maps the short rest period to a friendly label', () => {
    const inv = section(withWaterskinRecovery('sr'), 'inventory');
    if (inv.kind !== 'list') throw new Error('inventory must be a list section');
    expect(inv.items.find((i) => i.label === 'Waterskin')?.sub).toBe('consumable · 5 lb · recharges: short rest');
  });

  it('shows nothing extra for items with no recovery period (Bead of Force, real data)', () => {
    const inv = section(martialCaptured, 'inventory');
    if (inv.kind !== 'list') throw new Error('inventory must be a list section');
    expect(inv.items.find((i) => i.label === 'Bead of Force')?.sub).toBe('consumable · 0.06 lb');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/adapter-dnd5e && npx vitest run adapter.test.ts`
Expected: the first two new tests FAIL (`sub` is currently `'consumable · 5 lb'`, no `recharges:` suffix). The third test should already PASS unchanged (Bead of Force has no recovery period, so today's `sub` text is already exactly `'consumable · 0.06 lb'`).

- [ ] **Step 3: Implement `recoveryLabel` and wire it into `inventoryListItem`**

In `packages/adapter-dnd5e/src/index.ts`, right after `usesInfo` (currently ends at line 333, just before the `SlotInfo` interface), add:

```ts
const RECOVERY_LABELS: Record<string, string> = {
  sr: 'short rest',
  lr: 'long rest',
};

/** A friendly recharge-period string for an item's first uses-recovery
 *  entry (e.g. "dawn", "short rest"), or undefined when the item has no
 *  recovery period (most consumables — single-use, destroyed on use). */
function recoveryLabel(item: FoundryItemDoc): string | undefined {
  const recovery = getPath(item.system, 'uses.recovery');
  if (!Array.isArray(recovery) || recovery.length === 0) return undefined;
  const period = rec(recovery[0]).period;
  if (typeof period !== 'string' || period === '') return undefined;
  return RECOVERY_LABELS[period] ?? period;
}
```

Then, in `inventoryListItem` (currently lines 930-972), add the recovery line to `subParts` — change:

```ts
  const weight = numAt(item.system, 'weight.value');
  if (weight !== undefined && weight > 0) {
    const unit = strAt(item.system, 'weight.units') || 'lb';
    subParts.push(qty > 1 ? `${qty} × ${weight} ${unit}` : `${weight} ${unit}`);
  }
  const usesId = `item.${item._id}.uses`;
```

to:

```ts
  const weight = numAt(item.system, 'weight.value');
  if (weight !== undefined && weight > 0) {
    const unit = strAt(item.system, 'weight.units') || 'lb';
    subParts.push(qty > 1 ? `${qty} × ${weight} ${unit}` : `${weight} ${unit}`);
  }
  const recovery = recoveryLabel(item);
  if (recovery !== undefined) subParts.push(`recharges: ${recovery}`);
  const usesId = `item.${item._id}.uses`;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/adapter-dnd5e && npx vitest run`
Expected: all tests PASS, 269 total in the package (266 after Task 3 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/adapter.test.ts
git commit -m "feat: show recharge period on inventory rows"
```

---

### Task 5: Full-suite regression check and manual live verification

**Files:** none (verification-only task, no code changes expected)

- [ ] **Step 1: Run the full monorepo test suite**

Run: `pnpm -r test` from the repo root.
Expected: all workspaces pass — `packages/adapter-dnd5e` (269 tests per Task 4), `apps/gateway` (83 tests, unchanged — no gateway code was touched), `packages/foundry-client` (3 tests, unchanged), plus the two no-op `test` scripts (`apps/web`, `packages/adapter-sdk`).

- [ ] **Step 2: Manual live verification against the running stack**

With the dev stack up (Foundry on :30000, gateway on :8090, web on :3001/:3002 per the existing dev setup) and both characters' `system.attributes.hp` reset to fresh values if a prior manual test left them modified:

1. Open Akra's sheet, tap Potion of Healing's Use action. Expect: a rolled total appears as `+N HP` (N between 4 and 10), Akra's HP increases by that amount and is clamped to her max, and Potion of Healing disappears from her inventory (single-use, `autoDestroy: true`).
2. Open Randal's sheet, tap Bead of Force's Use action. Expect: a rolled total appears as `N dmg` (N between 5 and 20, i.e. `5d4`), and Bead of Force disappears from his inventory (same `autoDestroy: true`).
3. Attunement block: neither real item requires attunement, so this step confirms the *unit-tested* behavior (Task 3) has no live-only gap — in the Foundry GM tab, temporarily set an existing usable item's `system.attunement` to `"required"` via `game.actors.get(id).items.get(itemId).update({"system.attunement": "required"})`, confirm its Use action now surfaces the `"<name>" requires attunement` error as a toast, then revert the change (`"system.attunement": ""`) so the fixture-backing live world is left as it was before this check.

If any live behavior diverges from the unit tests, treat it as a real bug (same standard M14/M15 applied) — stop and fix before considering this feature done, do not just note the discrepancy.

- [ ] **Step 3: No commit** — this task only verifies; Task 4's commit already captured all code changes. If Step 2 uncovers a real bug, fix it as a new commit and re-run both steps.

---

## Self-Review Notes

- **Spec coverage:** on-use damage (Task 2) ✓, on-use heal + `forceSelf` correction (Task 2) ✓, attunement enforcement (Task 3) ✓, recharge display via `ListItem.sub` (Task 4) ✓, classification generalization incl. regression guard (Task 1) ✓, live data groundwork (Prerequisite, already done) ✓, live verification (Task 5) ✓. No spec section without a task.
- **Type consistency:** `buildHealAction`'s new `opts?: { forceSelf?: boolean }` parameter (Task 2) is additive and optional — the two pre-existing call sites in `buildAction` (`'cast'` case, `feature.` branch of `'use'`) are never modified in this plan and keep compiling unchanged. `itemDamageFormula` and `allActivities` names match between their Task 1/2 definitions and every later reference.
- **No placeholders:** every step has complete code and exact expected values (fixture-verified HP, exact formulas, exact test counts) — no "add tests for the above," no TBD.
