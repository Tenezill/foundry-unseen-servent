# Attack Advantage/Disadvantage (fallback variant) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let players roll an attack with advantage or disadvantage from the companion, using the spec's DEFINED FALLBACK (companion-built `2d20kh1/kl1 + to-hit` formula) — no execute-JS, no live-world spike. The native execute-JS path is deferred to a later session.

**Architecture:** A plain "Roll" on an attack keeps today's Foundry-native `use-item` (ammo/uses consumed, real to-hit). Advantage/Disadvantage emit a companion-built d20 formula via the existing generic `/roll` endpoint, with a best-effort to-hit bonus computed in the adapter (reusing `weaponAbilityMod`), mirroring the honesty of `weaponDamageFormula` (documented gaps: weapon mastery, non-numeric @-formula bonuses, active effects; no ammo consumption or auto-crit on the adv/disadv path). The ActionSheet gains Roll/Advantage/Disadvantage buttons for attacks, exactly like checks/saves.

**Tech Stack:** TypeScript, Vitest (adapter). Vue/Nuxt (web — verified by `nuxt typecheck`).

## Global Constraints

- FALLBACK ONLY — do NOT add execute-JS or any `rollAttack` script in this PR. That native path is a separate, later change.
- Plain "Roll" (no mode) on an attack MUST keep the current `use-item` behavior byte-for-byte (existing test `actions.test.ts:370` asserts it).
- The adv/disadv to-hit is a best-effort estimate (mirror `weaponDamageFormula`'s documented-gaps honesty). Do not attempt a full roll-data evaluator.
- SDK import in tests is `@companion/adapter-sdk`; strict `noUncheckedIndexedAccess` is on.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

- Modify: `packages/adapter-sdk/src/index.ts` — split the `attack` intent out to carry `mode?`.
- Modify: `packages/adapter-dnd5e/src/index.ts` — add `weaponAttackBonus`; rework `buildAction`'s `case 'attack'`.
- Modify: `packages/adapter-dnd5e/test/actions.test.ts` — add adv/disadv/invalid-mode attack cases (keep the existing no-mode case).
- Modify: `apps/web/app/pages/actor/[id].vue` — `onAction` opens the ActionSheet for `attack`.
- Modify: `apps/web/app/components/ActionSheet.vue` — show the Roll/Adv/Disadv block for `attack`; `roll()` accepts `attack`.

---

### Task 1: Adapter — attack `mode` + to-hit fallback

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts:297-299`
- Modify: `packages/adapter-dnd5e/src/index.ts` (`weaponAttackBonus` near `weaponAbilityMod` ~1650; `buildAction` attack branch ~2070)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`

**Interfaces:**
- Produces: `ActionIntent` attack variant `{ kind: 'attack'; actionId: string; mode?: 'advantage' | 'disadvantage' }`; `weaponAttackBonus(actor, item): number`.
- Consumes: existing `weaponAbilityMod`, `proficiency`, `numAt`, `getPath`, `rec`, `d20Formula`, `IntentError`.

- [ ] **Step 1: Split the attack intent in the SDK**

In `packages/adapter-sdk/src/index.ts`, change the `ActionIntent` union (currently `| { kind: 'attack' | 'use'; actionId: string }` at line 299) to:
```ts
  | { kind: 'attack'; actionId: string; mode?: 'advantage' | 'disadvantage' }
  | { kind: 'use'; actionId: string }
```

- [ ] **Step 2: Write the failing tests**

In `packages/adapter-dnd5e/test/actions.test.ts`, inside the `describe('buildAction — attack / cast / use / equip', …)` block (the no-mode case is at line 370), add:

```ts
  it('attack with advantage builds a 2d20kh1 to-hit formula (fallback, no execute-JS)', () => {
    const actor = {
      system: { attributes: { prof: 2 }, abilities: { str: { mod: 3 }, dex: { mod: 1 } } },
      items: [
        {
          _id: 'wpn1',
          type: 'weapon',
          name: 'Longsword',
          system: { equipped: true, proficient: 1, damage: { base: { number: 1, denomination: 8 } } },
        },
      ],
    } as unknown as Parameters<typeof build>[0];
    expect(build(actor, { kind: 'attack', actionId: 'item.wpn1.attack', mode: 'advantage' })).toEqual({
      endpoint: 'roll',
      formula: '2d20kh1 + 5', // STR +3 + proficiency +2
      flavor: 'Longsword — Attack',
    });
    expect(build(actor, { kind: 'attack', actionId: 'item.wpn1.attack', mode: 'disadvantage' })).toMatchObject({
      formula: '2d20kl1 + 5',
    });
  });

  it('attack with no mode still maps to native use-item', () => {
    const actor = {
      system: { attributes: { prof: 2 }, abilities: { str: { mod: 3 }, dex: { mod: 1 } } },
      items: [
        {
          _id: 'wpn1',
          type: 'weapon',
          name: 'Longsword',
          system: { equipped: true, proficient: 1, damage: { base: { number: 1, denomination: 8 } } },
        },
      ],
    } as unknown as Parameters<typeof build>[0];
    expect(build(actor, { kind: 'attack', actionId: 'item.wpn1.attack' })).toEqual({
      endpoint: 'use-item',
      itemId: 'wpn1',
    });
  });

  it('attack rejects an unknown roll mode', () => {
    const actor = {
      system: { attributes: { prof: 2 }, abilities: { str: { mod: 3 }, dex: { mod: 1 } } },
      items: [
        {
          _id: 'wpn1',
          type: 'weapon',
          name: 'Longsword',
          system: { equipped: true, proficient: 1, damage: { base: { number: 1, denomination: 8 } } },
        },
      ],
    } as unknown as Parameters<typeof build>[0];
    expect(() =>
      build(actor, { kind: 'attack', actionId: 'item.wpn1.attack', mode: 'sideways' as never }),
    ).toThrow(/roll mode/);
  });
```

> The existing `build` helper is `actions.test.ts:35`. If `Parameters<typeof build>[0]` is awkward, cast the actor via `as unknown as FoundryActorDoc` (import the type if not already). The synthetic weapon needs `type:'weapon'` + `system.equipped:true` so `buildActions` emits `item.wpn1.attack` (see `index.ts:1902`).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/adapter-dnd5e/test/actions.test.ts -t "attack"`
Expected: the two new mode tests FAIL (attack currently ignores mode and returns `use-item`); the no-mode test PASSES; the invalid-mode test FAILS (no validation yet). A TS error on `mode` in the intent is also expected until Step 1 is saved.

- [ ] **Step 4: Add `weaponAttackBonus`**

In `packages/adapter-dnd5e/src/index.ts`, immediately after `weaponAbilityMod` (ends line 1650), add:

```ts
/**
 * Best-effort attack to-hit bonus for the companion-built attack roll — used
 * ONLY when the player picks advantage/disadvantage (a plain Roll goes through
 * Foundry's native use-item). Mirrors weaponDamageFormula's honesty: resolved
 * ability mod (finesse/ranged/override via weaponAbilityMod) + proficiency
 * (unless the item is explicitly non-proficient) + the weapon's magical bonus +
 * a flat activity attack bonus. NOT modelled (documented gaps, same as damage):
 * weapon-mastery bonuses, non-numeric @-formula attack bonuses, active effects.
 */
function weaponAttackBonus(actor: FoundryActorDoc, item: FoundryItemDoc): number {
  const ability = weaponAbilityMod(actor, item);
  const proficientRaw = numAt(item.system, 'proficient');
  const prof = proficientRaw === 0 ? 0 : proficiency(actor);
  const magic = numAt(item.system, 'magicalBonus') ?? 0;
  const activities = rec(getPath(item.system, 'activities'));
  const first = rec(Object.values(activities)[0]);
  const rawAtk = getPath(first, 'attack.bonus');
  const flat = typeof rawAtk === 'number' ? rawAtk : typeof rawAtk === 'string' ? Number(rawAtk) : Number.NaN;
  const atk = Number.isFinite(flat) ? flat : 0;
  return ability + prof + magic + atk;
}
```

- [ ] **Step 5: Rework the `buildAction` attack branch**

Replace the `case 'attack':` branch (`index.ts:2070-2071`) with:

```ts
    case 'attack': {
      const mode = intent.mode;
      if (mode !== undefined && mode !== 'advantage' && mode !== 'disadvantage') {
        throw new IntentError(`unknown roll mode "${String(mode)}"`, 'INVALID');
      }
      const itemId = intent.actionId.slice('item.'.length, -'.attack'.length);
      // Plain Roll: Foundry-native item use (consumes ammo/uses, rolls to hit).
      if (mode === undefined) return { endpoint: 'use-item', itemId };
      // Advantage/disadvantage: companion-built to-hit (the relay's use-item
      // path exposes no advantage without execute-JS). Best-effort bonus;
      // ammo/uses and auto-crit are NOT modelled on this path.
      const item = (actor.items ?? []).find((i) => i._id === itemId);
      if (!item) throw new IntentError(`unknown weapon "${itemId}"`, 'UNKNOWN_RESOURCE');
      return {
        endpoint: 'roll',
        formula: d20Formula(weaponAttackBonus(actor, item), mode),
        flavor: `${item.name} — Attack`,
      };
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/adapter-dnd5e/test/actions.test.ts` then `npx vitest run packages/adapter-dnd5e`
Expected: PASS (all, including the untouched no-mode attack case).

- [ ] **Step 7: Typecheck**

Run: `cd packages/adapter-sdk && npx tsc --noEmit; cd ../..` and `cd packages/adapter-dnd5e && npx tsc --noEmit; cd ../..`
Expected: both exit 0. (The SDK intent split may surface any code that assumed `kind:'attack'|'use'` shared a shape — fix by narrowing on `kind` if the compiler flags a use site.)

- [ ] **Step 8: Commit**

```bash
git add packages/adapter-sdk/src/index.ts packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/actions.test.ts
git commit -m "$(printf 'feat(adapter-dnd5e): attack advantage/disadvantage via companion to-hit formula\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Web — ActionSheet Roll/Adv/Disadv for attacks

**Files:**
- Modify: `apps/web/app/pages/actor/[id].vue:1310-1312`
- Modify: `apps/web/app/components/ActionSheet.vue:9,62`

**Interfaces:**
- Consumes: `ActionIntent` attack variant with `mode?` (Task 1).

- [ ] **Step 1: Open the ActionSheet for attacks**

In `apps/web/app/pages/actor/[id].vue`, replace the `case 'attack'` body (lines 1310-1312):
```ts
    case 'attack':
      actionSheetFor.value = actionId
      break
```

- [ ] **Step 2: Confirm the ActionSheet submit handler forwards attack intents**

Read the `@submit` handler wired to `<ActionSheet>` in `[id].vue` (search `@submit` near the `<ActionSheet` usage around line 271). Verify it forwards the emitted `ActionIntent` to `submitAction(intent, …)` generically (it does so for check/save). If — and only if — it switches on `intent.kind` and would drop `attack`, add `attack` to the forwarded kinds. (Expected: it is generic; no change needed. Note the result in the report.)

- [ ] **Step 3: Show the Roll/Adv/Disadv block for attacks in ActionSheet.vue**

In `apps/web/app/components/ActionSheet.vue`, change the options `v-if` (line 9) to include attack:
```vue
      <div v-if="action.kind === 'check' || action.kind === 'save' || action.kind === 'attack'" class="options">
```

And widen the `roll()` guard (line 62):
```ts
function roll(mode?: 'advantage' | 'disadvantage'): void {
  if (props.action.kind !== 'check' && props.action.kind !== 'save' && props.action.kind !== 'attack') return
  emit('submit', {
    kind: props.action.kind,
    actionId: props.action.id,
    ...(mode !== undefined ? { mode } : {}),
  })
}
```

- [ ] **Step 4: Typecheck the web app**

Run: `cd apps/web && npx nuxt typecheck 2>&1 | tail -20; cd ../..`
Expected: exit 0. (`roll()` now emits `kind: 'check'|'save'|'attack'` — all valid `ActionIntent` variants.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/pages/actor/[id].vue apps/web/app/components/ActionSheet.vue
git commit -m "$(printf 'feat(web): Roll/Advantage/Disadvantage sheet for attacks\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: Verification

**Files:** none.

- [ ] **Step 1: Suites + typechecks**

Run:
```bash
npx vitest run packages/adapter-dnd5e
cd apps/gateway && npx vitest run && npx tsc --noEmit; cd ../..
cd packages/adapter-sdk && npx tsc --noEmit; cd ../..
cd packages/adapter-dnd5e && npx tsc --noEmit; cd ../..
cd apps/web && npx nuxt typecheck; cd ../..
```
Expected: adapter + gateway suites PASS; all typechecks exit 0.

- [ ] **Step 2:** Fix any failure under systematic-debugging and re-run before declaring done.

---

## Self-Review

**Spec coverage (Feature 2, fallback path):**
- `mode?` on the attack intent → Task 1 Step 1.
- ActionSheet Roll/Adv/Disadv for attacks; `onAction` opens the sheet → Task 2 Steps 1, 3.
- Adapter emits companion `2d20kh1/kl1 + to-hit` for adv/disadv; plain Roll keeps `use-item` → Task 1 Step 5, tested Step 2.
- Best-effort to-hit mirroring `weaponDamageFormula` honesty → `weaponAttackBonus` (Task 1 Step 4), documented gaps in its doc-comment.
- No execute-JS in this PR (explicit constraint) → nothing in the plan adds a script; native path deferred.

**Placeholder scan:** none — all code complete; the one NOTE (Task 2 Step 2) is a verify-then-maybe-edit instruction with the expected outcome stated.

**Type consistency:** the SDK attack variant `{ kind:'attack'; actionId; mode? }` matches `buildAction`'s `intent.mode` read and `ActionSheet.roll()`'s emit; `weaponAttackBonus(actor,item):number` feeds `d20Formula(bonus, mode)` (existing signature). Synthetic test weapon (`type:'weapon'`, `equipped:true`) satisfies the attack-descriptor gate at `index.ts:1902`.

**Deferred (documented):** native execute-JS `rollAttack({advantage})` with ammo/crit fidelity — a later PR requiring the live world + "Allow Execute JS". Best-effort to-hit gaps: weapon mastery, @-formula attack bonuses, active effects, ammo consumption, auto-crit on the adv/disadv path.
