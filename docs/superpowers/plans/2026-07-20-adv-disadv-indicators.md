# Advantage/Disadvantage Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a passive, display-only advantage (green **A**) / disadvantage (red **D**) badge on skill, ability-check, and saving-throw rows, driven by dnd5e effect flags, equipped-armor stealth, and per-roll overrides — without auto-applying it to the roll.

**Architecture:** Adapter computes a `{advantage, disadvantage}` bias per d20 row and attaches optional `advantage?`/`disadvantage?` booleans to the `Stat` view-model object (only when set, so unaffected rows stay byte-identical). The web renders a small `RollBadges` component in the stat card (skills/saves) and the ability gem (checks). No auto-application: the player still chooses Roll/Advantage/Disadvantage in the ActionSheet.

**Tech Stack:** TypeScript, Vitest (adapter). Vue 3 / Nuxt (web — no unit tests in v1; verified by typecheck + visual on redeploy).

## Global Constraints

- Foundry 13 / dnd5e 5.3.3. Detection is display-only and MUST NOT change the rolled formula.
- Detection sources (OR'd): `flags.dnd5e.advantage|disadvantage.{all, skill.all, skill.<id>, ability.all, ability.check.all, ability.check.<id>, ability.save.all, ability.save.<id>}`; equipped-armor `system.properties` containing `'stealthDisadvantage'` (skill `ste` only); per-roll `roll.mode` (`1`→adv, `-1`→disadv).
- Both `advantage` and `disadvantage` may be true at once → both badges shown (5e cancellation is the player's call, not ours).
- Emit `advantage`/`disadvantage` on a `Stat` ONLY when true — never `false` — so existing stat snapshots/objects for unaffected rows are unchanged.
- Flags live on the ACTOR document root (`actor.flags…`), not `actor.system`.
- SDK package import is `@companion/adapter-sdk`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- Modify: `packages/adapter-sdk/src/index.ts` — add `advantage?`/`disadvantage?` to the `Stat` interface (after `max?`, line 88).
- Modify: `packages/adapter-dnd5e/src/index.ts` — add `isFlagSet`, `hasStealthDisadvantageArmor`, `rollBias`, `biasFields` helpers; call `biasFields(rollBias(...))` in `skillStats` (1016), `saveStats` (888), `abilityStats` (680).
- Create: `packages/adapter-dnd5e/test/roll-bias.test.ts` — unit tests for all three kinds and sources.
- Create: `apps/web/app/components/RollBadges.vue` — the A/D badge component.
- Modify: `apps/web/app/components/SectionStats.vue` — render `<RollBadges>` in the card (2 branches) and gem (2 branches).

---

### Task 1: Adapter — rollBias + Stat fields

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts:88`
- Modify: `packages/adapter-dnd5e/src/index.ts` (helpers near line 725; calls in `abilityStats`/`saveStats`/`skillStats`)
- Test: `packages/adapter-dnd5e/test/roll-bias.test.ts` (new)

**Interfaces:**
- Produces: `rollBias(actor, kind: 'skill'|'check'|'save', id): { advantage: boolean; disadvantage: boolean }` and `biasFields(bias): { advantage?: true; disadvantage?: true }`. `Stat.advantage?: boolean`, `Stat.disadvantage?: boolean`.
- Consumes: existing `getPath`, `numAt`, `FoundryActorDoc`, `dnd5eAdapter.toViewModel`.

- [ ] **Step 1: Add the SDK fields**

In `packages/adapter-sdk/src/index.ts`, after the `max?: number;` line (88) inside `interface Stat`, add:

```ts
  /** Passive d20 roll indicators (display-only; never auto-applied to the
   *  roll). Set only when a source grants it; both may be true at once. */
  advantage?: boolean;
  disadvantage?: boolean;
```

- [ ] **Step 2: Write the failing test**

Create `packages/adapter-dnd5e/test/roll-bias.test.ts`:

```ts
/**
 * Feature: passive advantage/disadvantage indicators on d20 rows. Display-only
 * bias derived from dnd5e flags, equipped stealth-disadvantage armor, and the
 * per-roll `roll.mode` override — attached to skill/check/save Stats.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dnd5eAdapter } from '../src/index.js';
import type { FoundryActorDoc } from '@companion/adapter-sdk';

function fixture(name: string): FoundryActorDoc {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as FoundryActorDoc;
}
const martialCaptured = fixture('martial-captured.json');

type BiasStat = { id: string; advantage?: boolean; disadvantage?: boolean };

/** Pull a stat from a stats section of the built sheet. */
function stat(actor: FoundryActorDoc, sectionId: string, statId: string): BiasStat | undefined {
  const sheet = dnd5eAdapter.toViewModel(actor) as {
    sections: Array<{ id: string; stats?: BiasStat[] }>;
  };
  return sheet.sections.find((s) => s.id === sectionId)?.stats?.find((s) => s.id === statId);
}

/** Graft dnd5e flags onto the capture (preserving its existing dnd5e flags). */
function withFlags(actor: FoundryActorDoc, dnd5e: Record<string, unknown>): FoundryActorDoc {
  const prev = (actor.flags as { dnd5e?: Record<string, unknown> })?.dnd5e ?? {};
  return { ...actor, flags: { ...(actor.flags as object), dnd5e: { ...prev, ...dnd5e } } };
}

describe('roll bias — equipped stealth-disadvantage armor', () => {
  it('flags Stealth as disadvantage when heavy armor is equipped (real capture)', () => {
    // martial-captured has Chain Mail equipped with properties ['stealthDisadvantage'].
    const ste = stat(martialCaptured, 'skills', 'skill.ste');
    expect(ste?.disadvantage).toBe(true);
    expect(ste?.advantage).toBeUndefined();
  });

  it('leaves an unaffected skill with neither field', () => {
    const acr = stat(martialCaptured, 'skills', 'skill.acr');
    expect(acr?.advantage).toBeUndefined();
    expect(acr?.disadvantage).toBeUndefined();
  });
});

describe('roll bias — dnd5e flags', () => {
  it('advantage.skill.<id> sets advantage on that skill', () => {
    const actor = withFlags(martialCaptured, { advantage: { skill: { acr: 1 } } });
    expect(stat(actor, 'skills', 'skill.acr')?.advantage).toBe(true);
  });

  it('disadvantage.ability.save.<id> sets disadvantage on that save', () => {
    const actor = withFlags(martialCaptured, { disadvantage: { ability: { save: { wis: '1' } } } });
    expect(stat(actor, 'saves', 'save.wis')?.disadvantage).toBe(true);
  });

  it('advantage.ability.check.<id> sets advantage on that ability check (gem)', () => {
    const actor = withFlags(martialCaptured, { advantage: { ability: { check: { int: true } } } });
    expect(stat(actor, 'abilities', 'ability.int')?.advantage).toBe(true);
  });

  it('advantage.all sets advantage across a skill, a save, and an ability check', () => {
    const actor = withFlags(martialCaptured, { advantage: { all: 1 } });
    expect(stat(actor, 'skills', 'skill.arc')?.advantage).toBe(true);
    expect(stat(actor, 'saves', 'save.str')?.advantage).toBe(true);
    expect(stat(actor, 'abilities', 'ability.cha')?.advantage).toBe(true);
  });

  it('shows BOTH badges when an advantage flag and armor-disadvantage collide on Stealth', () => {
    const actor = withFlags(martialCaptured, { advantage: { skill: { ste: 1 } } });
    const ste = stat(actor, 'skills', 'skill.ste');
    expect(ste?.advantage).toBe(true);
    expect(ste?.disadvantage).toBe(true);
  });
});

describe('roll bias — per-roll mode override', () => {
  it('skills.<id>.roll.mode === 1 sets advantage', () => {
    const sys = martialCaptured.system as { skills: Record<string, { roll?: { mode?: number } }> };
    const actor: FoundryActorDoc = {
      ...martialCaptured,
      system: {
        ...martialCaptured.system,
        skills: { ...sys.skills, acr: { ...sys.skills.acr, roll: { mode: 1 } } },
      },
    };
    expect(stat(actor, 'skills', 'skill.acr')?.advantage).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/adapter-dnd5e/test/roll-bias.test.ts`
Expected: FAIL — bias fields are all `undefined` (helpers not yet added).

- [ ] **Step 4: Add the helpers**

In `packages/adapter-dnd5e/src/index.ts`, immediately after the `numericBonus` function (ends line 725), add:

```ts
/** True when a dnd5e advantage/disadvantage flag counts as set (Foundry
 *  writes "1", true, or 1). */
function isFlagSet(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s !== '' && s !== '0' && s !== 'false';
  }
  return false;
}

/** Any equipped equipment whose dnd5e properties impose stealth disadvantage. */
function hasStealthDisadvantageArmor(actor: FoundryActorDoc): boolean {
  for (const item of actor.items ?? []) {
    if (item.type !== 'equipment') continue;
    if (getPath(item.system, 'equipped') !== true) continue;
    const props = getPath(item.system, 'properties');
    if (Array.isArray(props) && props.includes('stealthDisadvantage')) return true;
  }
  return false;
}

/**
 * Passive advantage/disadvantage indicator for a d20 roll row. DISPLAY-ONLY:
 * never applied to the rolled formula, because other effects can flip the net.
 * OR of dnd5e bonus flags, the per-roll `roll.mode` override, and (Stealth
 * only) equipped stealth-disadvantage armor.
 */
function rollBias(
  actor: FoundryActorDoc,
  kind: 'skill' | 'check' | 'save',
  id: string,
): { advantage: boolean; disadvantage: boolean } {
  const flagPaths = (dir: 'advantage' | 'disadvantage'): string[] => {
    const base = `flags.dnd5e.${dir}`;
    if (kind === 'skill') return [`${base}.all`, `${base}.skill.all`, `${base}.skill.${id}`];
    if (kind === 'check')
      return [`${base}.all`, `${base}.ability.all`, `${base}.ability.check.all`, `${base}.ability.check.${id}`];
    return [`${base}.all`, `${base}.ability.all`, `${base}.ability.save.all`, `${base}.ability.save.${id}`];
  };
  let advantage = flagPaths('advantage').some((p) => isFlagSet(getPath(actor, p)));
  let disadvantage = flagPaths('disadvantage').some((p) => isFlagSet(getPath(actor, p)));

  const modePath =
    kind === 'skill'
      ? `skills.${id}.roll.mode`
      : kind === 'check'
        ? `abilities.${id}.check.roll.mode`
        : `abilities.${id}.save.roll.mode`;
  const mode = numAt(actor.system, modePath);
  if (mode === 1) advantage = true;
  else if (mode === -1) disadvantage = true;

  if (kind === 'skill' && id === 'ste' && hasStealthDisadvantageArmor(actor)) disadvantage = true;

  return { advantage, disadvantage };
}

/** Emit advantage/disadvantage ONLY when set, so unaffected stat rows stay
 *  byte-identical to before this feature. */
function biasFields(bias: { advantage: boolean; disadvantage: boolean }): {
  advantage?: true;
  disadvantage?: true;
} {
  return {
    ...(bias.advantage ? { advantage: true as const } : {}),
    ...(bias.disadvantage ? { disadvantage: true as const } : {}),
  };
}
```

- [ ] **Step 5: Apply the bias in the three stat builders**

In `skillStats` (return object at `index.ts:1023-1029`), add the spread as the last property:
```ts
    return {
      id: `skill.${s.id}`,
      label: s.label,
      value: signed(total),
      sub: subParts.join(' · '),
      actionId: `skill.${s.id}`,
      ...biasFields(rollBias(actor, 'skill', s.id)),
    };
```

In `saveStats` (return object at `index.ts:891-897`), add:
```ts
      ...biasFields(rollBias(actor, 'save', a.id)),
```
as the last property (after `actionId: \`ability.${a.id}.save\``).

In `abilityStats` (return object at `index.ts:687-693`), add:
```ts
      ...biasFields(rollBias(actor, 'check', a.id)),
```
as the last property (after `actionId: \`ability.${a.id}.check\``).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/adapter-dnd5e/test/roll-bias.test.ts`
Expected: PASS (all).

- [ ] **Step 7: Run the full adapter suite (guard against snapshot drift)**

Run: `npx vitest run packages/adapter-dnd5e`
Expected: PASS. If any pre-existing skill/save/ability test broke, it means a `false`/always-present field leaked — confirm `biasFields` only emits when true and fix before committing.

- [ ] **Step 8: Typecheck**

Run: `cd packages/adapter-dnd5e && npx tsc --noEmit; cd ../..` and `cd packages/adapter-sdk && npx tsc --noEmit; cd ../..`
Expected: both exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/adapter-sdk/src/index.ts packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/roll-bias.test.ts
git commit -m "$(printf 'feat(adapter-dnd5e): passive advantage/disadvantage bias on d20 rows\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Web — RollBadges component + wiring

**Files:**
- Create: `apps/web/app/components/RollBadges.vue`
- Modify: `apps/web/app/components/SectionStats.vue` (import + 4 render sites)

**Interfaces:**
- Consumes: `Stat.advantage?`, `Stat.disadvantage?` from `@companion/adapter-sdk` (Task 1).
- Produces: `<RollBadges :advantage="..." :disadvantage="..." />`.

- [ ] **Step 1: Create the component**

Create `apps/web/app/components/RollBadges.vue`:

```vue
<template>
  <span v-if="advantage || disadvantage" class="roll-badges">
    <span v-if="advantage" class="badge adv" title="Advantage" aria-label="Advantage">A</span>
    <span v-if="disadvantage" class="badge dis" title="Disadvantage" aria-label="Disadvantage">D</span>
  </span>
</template>

<script setup lang="ts">
defineProps<{ advantage?: boolean; disadvantage?: boolean }>()
</script>

<style scoped>
.roll-badges {
  display: inline-flex;
  gap: 3px;
  margin-top: 2px;
}

.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  font-size: 0.58rem;
  font-weight: 800;
  line-height: 1;
  /* hex-die silhouette */
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
}

.badge.adv {
  background: #3fb950;
  color: #052e0e;
}

.badge.dis {
  background: #f85149;
  color: #2b0606;
}
</style>
```

- [ ] **Step 2: Wire it into SectionStats.vue**

Add the import in the `<script setup>` block (after the existing `import type … from '@companion/adapter-sdk'` at line 77):
```ts
import RollBadges from './RollBadges.vue'
```

In the **card tappable** branch, replace the sub `<span>` (line 55) block so the badges follow the sub:
```vue
          <template v-else>
            <span class="value">{{ stat.value }}</span>
            <span v-if="stat.sub" class="sub">{{ stat.sub }}</span>
            <RollBadges :advantage="stat.advantage" :disadvantage="stat.disadvantage" />
          </template>
```

Apply the identical change in the **card non-tappable** branch (the second `<template v-else>` at lines 66-69).

In the **gem tappable** branch, after the `.mod` span (line 18), add:
```vue
          <span class="mod">{{ stat.sub ?? stat.value }}</span>
          <RollBadges :advantage="stat.advantage" :disadvantage="stat.disadvantage" />
```
and the identical addition in the **gem non-tappable** branch (after line 23).

- [ ] **Step 3: Typecheck the web app**

Run: `cd apps/web && npx nuxt typecheck 2>&1 | tail -20; cd ../..`
Expected: exit 0, no type errors referencing `RollBadges`, `advantage`, or `disadvantage`.

> Web has no unit-test harness (v1: "e2e via stack, no unit tests"). Correctness of the badge logic is covered by Task 1's adapter tests; this task's gate is a clean typecheck. Visual confirmation happens on the user's redeploy.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/components/RollBadges.vue apps/web/app/components/SectionStats.vue
git commit -m "$(printf 'feat(web): render advantage/disadvantage badges on stat cards + gems\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: Verification

**Files:** none (verification only).

- [ ] **Step 1: Run suites + typechecks**

Run:
```bash
npx vitest run packages/adapter-dnd5e
cd apps/gateway && npx vitest run && npx tsc --noEmit; cd ../..
cd packages/adapter-dnd5e && npx tsc --noEmit; cd ../..
cd packages/adapter-sdk && npx tsc --noEmit; cd ../..
cd apps/web && npx nuxt typecheck; cd ../..
```
Expected: adapter + gateway suites PASS; all typechecks exit 0.

- [ ] **Step 2:** If anything fails, fix under systematic-debugging and re-run before declaring done.

---

## Self-Review

**Spec coverage (Feature 1):**
- Detection sources (flags / armor-stealth / roll.mode) → `rollBias` (Task 1 Step 4), tested (Task 1 Step 2).
- Applied to skills + ability checks + saves → Task 1 Step 5 (all three builders).
- `advantage?`/`disadvantage?` on `Stat`, emitted only when true → Task 1 Steps 1, 4 (`biasFields`), guarded by Step 7.
- Both badges when both present → tested (Task 1 "BOTH badges" case); rendered independently in `RollBadges` (Task 2).
- Sub-line placement on cards, gem placement on ability checks → Task 2 Step 2.
- Display-only (no roll change) → `rollBias` is read into the view model only; no change to `buildAction`/`d20Formula` anywhere in this plan.

**Placeholder scan:** none — all code blocks complete; the one prose NOTE explains the (real, pre-existing) absence of a web unit harness.

**Type consistency:** `rollBias`/`biasFields` signatures match between definition (Task 1 Step 4) and call sites (Step 5); `Stat.advantage?/disadvantage?` (Step 1) match `RollBadges` props and the `BiasStat` test type. Section ids used in tests (`skills`, `saves`, `abilities`) and stat ids (`skill.<id>`, `save.<id>`, `ability.<id>`) match the adapter's emitted ids (confirmed: `index.ts:688,892,1029`).
