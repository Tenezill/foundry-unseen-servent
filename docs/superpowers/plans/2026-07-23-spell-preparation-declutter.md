# Spell Preparation Declutter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Spells-tab busyness — kill the triple "prepared" signalling, sort prepared spells to the top of each level (dimming the unprepared), and add a "Prepared X / Y" budget summary with a player-adjustable offset.

**Architecture:** Three prongs across two layers. The dnd5e adapter (a) stops emitting the redundant `prepared` sub/tag, (b) sorts each level's spells prepared-first at grouping time, and (c) computes a best-effort `spellPrep` budget onto the view model. The PWA (d) dims unprepared spell rows and (e) renders a summary component with a localStorage-persisted offset stepper. No relay/Foundry changes; the preparation mechanic (`system.prepared` 0/1/2 via the existing `prepare` action) is untouched.

**Tech Stack:** TypeScript, Vitest (adapter tests), Vue 3 / Nuxt 4 (PWA, no unit harness — `nuxt typecheck` + running stack), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-07-23-spell-preparation-declutter-design.md`

**Branch:** `feat/spell-prep-declutter` (already created off `main`; the spec is already committed on it).

## Global Constraints

- No relay/Foundry-client changes; no changes to the `prepare` intent path.
- Adapter tests: `pnpm --filter @companion/adapter-dnd5e test` (runs `vitest run`); filter to one file with `pnpm --filter @companion/adapter-dnd5e exec vitest run test/spell-ux.test.ts`.
- Web has **no** unit-test harness (`apps/web` `test` script is a stub) — do NOT add one. Web verification = `pnpm --filter @companion/web typecheck` + visual check in the running stack.
- Web component styling: reuse only existing CSS custom properties (`--gold`, `--gold-bright`, `--ink-dim`, `--ink-faint`, `--panel`, `--panel-2`, `--line`, `--tap`, `color-mix(...)`). Introduce no new color literals.
- Offset persistence: `localStorage` key `fc:prepoffset:<actorId>`, wrapped in try/catch (private-mode safe), matching the section-collapse precedent in `SectionList.vue`.
- `base` is best-effort, never a rules engine — the player offset is the correctness backstop (spec §3).
- Every commit message ends with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `packages/adapter-dnd5e/src/index.ts` | dnd5e → view model | drop redundant sub/tag in `spellListItem`; store raw spell docs + sort prepared-first at section build; add `preparedRank`, `spellPrepBudget`, `preparedBase`; populate `spellPrep` in `toViewModel` |
| `packages/adapter-dnd5e/test/spell-ux.test.ts` | adapter behaviour tests | new `spellDoc` helper + tests for redundancy, ordering, budget |
| `packages/adapter-sdk/src/index.ts` | shared view-model types | add optional `SheetViewModel.spellPrep` |
| `apps/web/app/components/SectionList.vue` | list rows | dim rows whose Prepare toggle is off |
| `apps/web/app/components/SpellPrepSummary.vue` (new) | budget summary + offset stepper | new component |
| `apps/web/app/pages/actor/[id].vue` | actor page | render `SpellPrepSummary` atop the Spells tab |

---

### Task 1: Adapter — remove the redundant "prepared" sub-line and tag

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` (in `spellListItem`, ~`:1372` and `:1376`)
- Test: `packages/adapter-dnd5e/test/spell-ux.test.ts`

**Interfaces:**
- Consumes: `dnd5eAdapter.toViewModel`, `spellSections`, `withSpell` (all already in the test file); `FoundryItemDoc` (from `@companion/adapter-sdk`).
- Produces: a `spellDoc(id, overrides)` test helper reused by Tasks 2–3.

- [ ] **Step 1: Add the `spellDoc` helper + failing tests**

Add this helper near the top of `spell-ux.test.ts` (below the existing `freeUseSpell`/`withSpell` helpers):

```ts
/** Minimal leveled spell doc for preparation tests. Defaults: level 2,
 *  method "spell" (not free-use), unprepared. */
function spellDoc(id: string, overrides: Record<string, unknown> = {}): FoundryItemDoc {
  return {
    _id: id,
    name: id,
    type: 'spell',
    system: { level: 2, school: 'evo', method: 'spell', prepared: 0, properties: [], ...overrides },
  };
}
```

Add a new `describe` block at the end of the file:

```ts
describe('prepared spells: no redundant signalling', () => {
  it('a prepared leveled spell drops the "prepared" sub segment and tag but keeps its toggle + distinct tags', () => {
    const actor = withSpell(casterCaptured, spellDoc('PrepBolt00000001', { level: 1, prepared: 1, properties: ['concentration'] }));
    const row = spellSections(actor).flatMap((s) => s.items).find((r) => r.id === 'PrepBolt00000001');
    expect(row).toBeDefined();
    expect(row!.tags ?? []).not.toContain('prepared');
    expect(row!.sub ?? '').not.toMatch(/prepared/i);
    expect(row!.toggleActionId).toBe('spell.PrepBolt00000001.prepare');
    expect(row!.tags ?? []).toContain('concentration');
  });

  it('an always-prepared (prepared: 2) spell keeps its "always prepared" sub and gets no toggle', () => {
    const actor = withSpell(casterCaptured, spellDoc('DomainWard000001', { level: 1, prepared: 2 }));
    const row = spellSections(actor).flatMap((s) => s.items).find((r) => r.id === 'DomainWard000001');
    expect(row!.sub ?? '').toMatch(/always prepared/i);
    expect(row!.toggleActionId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @companion/adapter-dnd5e exec vitest run test/spell-ux.test.ts`
Expected: FAIL — the first test fails on `not.toContain('prepared')` / `not.toMatch(/prepared/i)` (the sub is currently `"1st level · Evocation · prepared"` and tags currently include `"prepared"`). The second test already passes (it documents unchanged behaviour).

- [ ] **Step 3: Remove the two redundant emissions**

In `spellListItem`, delete the `prepared` sub branch. It currently reads:

```ts
  } else if (always) subParts.push('always prepared');
  else if (isPrepared) subParts.push('prepared');
```

Change it to (drop the final `else if`):

```ts
  } else if (always) subParts.push('always prepared');
```

Then delete the redundant tag line entirely:

```ts
  if (freeUse === undefined && isPrepared) tags.push('prepared');
```

(Leave the `concentration`/`ritual`/`free use`/`innate` tag pushes and the `always prepared` sub intact.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @companion/adapter-dnd5e exec vitest run test/spell-ux.test.ts`
Expected: PASS (both new tests). Also run the full adapter suite to confirm no regression:
Run: `pnpm --filter @companion/adapter-dnd5e test`
Expected: PASS (existing per-level/free-use tests still green — they assert counts, not the removed sub/tag).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/spell-ux.test.ts
git commit -m "$(cat <<'EOF'
feat(adapter): drop redundant "prepared" sub/tag on preparable spells

The Prepare/Prepared toggle already carries the state; the sub-line and
tag restated it. Removed both (only preparable-and-prepared rows hit
them); always-prepared sub and concentration/ritual/free-use tags stay.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Adapter — order each level prepared-first

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` (spell grouping ~`:2649-2659`; section build ~`:2741-2751`; new `preparedRank` helper near `isPreparableSpell` ~`:1400`)
- Test: `packages/adapter-dnd5e/test/spell-ux.test.ts`

**Interfaces:**
- Consumes: `spellDoc` (Task 1), `withSpell`, `spellSections`; `FoundryItemDoc`, `getPath`, `spellListItem`, `ordinal` (all already in `index.ts`).
- Produces: `preparedRank(item: FoundryItemDoc): number` (0 = prepared/always, 1 = unprepared).

- [ ] **Step 1: Write the failing test**

Append to `spell-ux.test.ts`:

```ts
describe('prepared-first ordering within a level', () => {
  it('prepared and always-prepared sort before unprepared, stable within each group', () => {
    let actor = casterCaptured;
    for (const s of [
      spellDoc('z_unprep_a'),                    // rank 1
      spellDoc('z_prep_b', { prepared: 1 }),      // rank 0
      spellDoc('z_unprep_c'),                    // rank 1
      spellDoc('z_always_d', { prepared: 2 }),    // rank 0
    ]) {
      actor = withSpell(actor, s);
    }
    const l2 = spellSections(actor).find((s) => s.id === 'spells.l2');
    expect(l2).toBeDefined();
    expect(l2!.items.map((i) => i.id)).toEqual(['z_prep_b', 'z_always_d', 'z_unprep_a', 'z_unprep_c']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @companion/adapter-dnd5e exec vitest run test/spell-ux.test.ts`
Expected: FAIL — current insertion order yields `['z_unprep_a','z_prep_b','z_unprep_c','z_always_d']`.

- [ ] **Step 3: Add the `preparedRank` helper**

Add near `isPreparableSpell` (after its closing brace, ~`:1404`):

```ts
/** Sort key for prepared-first ordering: prepared (1) and always-prepared (2)
 *  spells rank 0; unprepared rank 1. Array#sort is stable, so same-rank spells
 *  keep insertion order. */
function preparedRank(item: FoundryItemDoc): number {
  const raw = getPath(item.system, 'prepared');
  return raw === 2 || raw === 1 || raw === true ? 0 : 1;
}
```

- [ ] **Step 4: Group raw docs (not rows), then sort + map at section build**

Change the grouping map to hold raw docs. The declaration + comment (~`:2649`) currently:

```ts
  /** Spell rows grouped by level, insertion-ordered within a level. */
  const spellsByLevel = new Map<number, ListItem[]>();
```

becomes:

```ts
  /** Raw spell docs grouped by level; sorted prepared-first and mapped to rows
   *  at section-build time (2026-07-23 declutter — raw system.prepared is only
   *  in hand here). */
  const spellsByLevel = new Map<number, FoundryItemDoc[]>();
```

The grouping loop body (~`:2656-2658`) currently:

```ts
      const list = spellsByLevel.get(level);
      if (list) list.push(spellListItem(item, resourceIds));
      else spellsByLevel.set(level, [spellListItem(item, resourceIds)]);
```

becomes:

```ts
      const list = spellsByLevel.get(level);
      if (list) list.push(item);
      else spellsByLevel.set(level, [item]);
```

The section-build loop (~`:2741-2750`) currently:

```ts
  for (const level of [...spellsByLevel.keys()].sort((a, b) => a - b)) {
    const items = spellsByLevel.get(level) ?? [];
    const label = level === 0 ? 'Cantrips' : `${ordinal(level)} Level`;
    sections.push({
      kind: 'list',
      id: `spells.l${level}`,
      label,
      header: { id: `spells.l${level}.header`, label, sub: `${items.length} ${items.length === 1 ? 'spell' : 'spells'}` },
      items,
    });
  }
```

becomes:

```ts
  for (const level of [...spellsByLevel.keys()].sort((a, b) => a - b)) {
    const raw = spellsByLevel.get(level) ?? [];
    const items = [...raw]
      .sort((a, b) => preparedRank(a) - preparedRank(b))
      .map((it) => spellListItem(it, resourceIds));
    const label = level === 0 ? 'Cantrips' : `${ordinal(level)} Level`;
    sections.push({
      kind: 'list',
      id: `spells.l${level}`,
      label,
      header: { id: `spells.l${level}.header`, label, sub: `${items.length} ${items.length === 1 ? 'spell' : 'spells'}` },
      items,
    });
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @companion/adapter-dnd5e test`
Expected: PASS — the new ordering test plus all existing tests (per-level counts/labels unchanged; free-use spell still found by id).

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/spell-ux.test.ts
git commit -m "$(cat <<'EOF'
feat(adapter): order spells prepared-first within each level

Group raw spell docs per level and sort prepared/always-prepared ahead of
unprepared at section-build time (stable within each group), so the spells
a player actually readied float to the top.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: SDK + adapter — compute the `spellPrep` budget

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts` (`SheetViewModel`, after the `concentration?` field ~`:214`)
- Modify: `packages/adapter-dnd5e/src/index.ts` (new `spellPrepBudget`/`preparedBase` helpers; populate in `toViewModel` return ~`:2765-2779`)
- Test: `packages/adapter-dnd5e/test/spell-ux.test.ts`

**Interfaces:**
- Consumes: `isPreparableSpell`, `getPath`, `numAt`, `strAt`, `abilityMod` (all in `index.ts`); `spellDoc`, `withSpell` (test).
- Produces: `SheetViewModel.spellPrep?: { prepared: number; base: number }`; `spellPrepBudget(actor): { prepared: number; base: number } | undefined`.

- [ ] **Step 1: Add the SDK field**

In `packages/adapter-sdk/src/index.ts`, inside `interface SheetViewModel`, immediately after the `concentration?` line, add:

```ts
  /** Prepared-caster budget (2026-07-23). Present only when the actor has at
   *  least one preparable spell. `base` is a best-effort rules maximum; the PWA
   *  adds a persisted, player-set offset on top of it. */
  spellPrep?: { prepared: number; base: number };
```

- [ ] **Step 2: Write the failing tests**

Append to `spell-ux.test.ts`:

```ts
describe('prepared-spell budget (spellPrep)', () => {
  const vm = (a: FoundryActorDoc) => dnd5eAdapter.toViewModel(a);

  it('a prepared caster reports current prepared count and a computed base', () => {
    // Akra, Cleric 5, WIS 15 (+2): base = 2 + 5 = 7; prepared leveled (===1) = 3
    // (Guiding Bolt, Detect Magic, Cure Wounds); always-prepared (===2) excluded.
    expect(vm(casterCaptured).spellPrep).toEqual({ prepared: 3, base: 7 });
  });

  it('an actor with no preparable spells has no budget', () => {
    expect(vm(martialCaptured).spellPrep).toBeUndefined();
  });

  it('toggling a spell to prepared raises the count', () => {
    const actor = withSpell(casterCaptured, spellDoc('BudgetAdd0000001', { level: 1, prepared: 1 }));
    expect(vm(actor).spellPrep).toEqual({ prepared: 4, base: 7 });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @companion/adapter-dnd5e exec vitest run test/spell-ux.test.ts`
Expected: FAIL — `spellPrep` is `undefined` for the caster (not yet populated).

- [ ] **Step 4: Add the budget helpers**

Add near `spellListItem`/`isPreparableSpell` in `index.ts`:

```ts
/** Best-effort prepared-spell budget (spec §3). Present only when the actor has
 *  ≥1 preparable spell. `base` mirrors dnd5e's preparation-formula shape but is
 *  deliberately not a rules engine — multiclass/homebrew is the PWA offset's job. */
function spellPrepBudget(actor: FoundryActorDoc): { prepared: number; base: number } | undefined {
  const preparable = (actor.items ?? []).filter((i) => i.type === 'spell' && isPreparableSpell(i));
  if (preparable.length === 0) return undefined;
  const prepared = preparable.filter((i) => {
    const raw = getPath(i.system, 'prepared');
    return raw === 1 || raw === true;
  }).length;
  return { prepared, base: preparedBase(actor) };
}

/** Prepared-spell ceiling: spellcasting-ability modifier + a level contribution
 *  (full = levels, half = ⌊levels/2⌋, third = ⌊levels/3⌋) of the highest-level
 *  preparing class. Prefers classes with a non-empty
 *  spellcasting.preparation.formula (the real preparers), else any spellcasting
 *  class; 0 when none is found (the offset compensates). */
function preparedBase(actor: FoundryActorDoc): number {
  const casters = (actor.items ?? [])
    .filter((i) => i.type === 'class')
    .map((i) => ({
      levels: numAt(i.system, 'levels') ?? 1,
      ability: strAt(i.system, 'spellcasting.ability'),
      progression: strAt(i.system, 'spellcasting.progression'),
      formula: strAt(i.system, 'spellcasting.preparation.formula') ?? '',
    }))
    .filter((c) => c.ability !== undefined && c.progression !== undefined && c.progression !== 'none');
  if (casters.length === 0) return 0;
  const preparers = casters.filter((c) => c.formula.trim() !== '');
  const pool = preparers.length > 0 ? preparers : casters;
  const primary = [...pool].sort((a, b) => b.levels - a.levels)[0]!;
  const contribution =
    primary.progression === 'half'
      ? Math.floor(primary.levels / 2)
      : primary.progression === 'third'
        ? Math.floor(primary.levels / 3)
        : primary.levels;
  return Math.max(0, abilityMod(actor.system, primary.ability!) + contribution);
}
```

- [ ] **Step 5: Populate `spellPrep` in `toViewModel`**

In `toViewModel`, just before the `return {` (after the `const { concentration, conditions } = parseEffects(actor);` line), add:

```ts
  const spellPrep = spellPrepBudget(actor);
```

Then in the returned object, add a spread right after the `conditions` spread:

```ts
    ...(conditions.length > 0 ? { conditions } : {}),
    ...(spellPrep !== undefined ? { spellPrep } : {}),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @companion/adapter-dnd5e test`
Expected: PASS (all three budget tests + full suite). Then confirm the SDK type compiles:
Run: `pnpm --filter @companion/adapter-sdk typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/adapter-sdk/src/index.ts packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/spell-ux.test.ts
git commit -m "$(cat <<'EOF'
feat(adapter): compute best-effort prepared-spell budget (spellPrep)

New optional SheetViewModel.spellPrep { prepared, base }, populated only
when preparable spells exist. base = ability mod + preparing-class level
contribution (half/third aware); prepared counts preparable spells with
prepared===1 (excludes always-prepared and cantrips).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Web — dim unprepared spell rows

**Files:**
- Modify: `apps/web/app/components/SectionList.vue` (script: new `isUnprepared`; template: bind class on `.row-main` ~`:50`; style: `.row-main.dim`)

**Interfaces:**
- Consumes: `toggleOf(item)` (already in the component), `ListItem`, `ActionDescriptor`.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Add the `isUnprepared` helper**

In the `<script setup>` of `SectionList.vue`, next to the existing `toggleOf`/`toggleOn` helpers, add:

```ts
/** A spell row is "unprepared" when it has a Prepare toggle that is currently
 *  off. Inventory/feature rows (no prepare toggle) are never dimmed. */
function isUnprepared(item: ListItem): boolean {
  const a = toggleOf(item)
  return !!a && a.kind === 'prepare' && a.prepared === false
}
```

- [ ] **Step 2: Bind the dim class on the row body**

In the template, the row body is `<div class="row-main">` (~`:50`). Change it to:

```html
        <div class="row-main" :class="{ dim: isUnprepared(item) }">
```

(Only `.row-main` — the name/sub/tags — dims. `.row-controls` is a sibling and stays fully bright/interactive.)

- [ ] **Step 3: Add the dim style**

In the `<style scoped>` block, add after the `.row-main` rule:

```css
.row-main.dim {
  opacity: 0.5;
}
```

- [ ] **Step 4: Verify typecheck**

Run: `pnpm --filter @companion/web typecheck`
Expected: exit 0, no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/SectionList.vue
git commit -m "$(cat <<'EOF'
feat(web): dim unprepared spell rows in the list

A row whose Prepare toggle is off renders its name/sub at reduced opacity
so prepared spells stand out; the toggle and Cast button stay bright.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Web — SpellPrepSummary component + Spells-tab wiring

**Files:**
- Create: `apps/web/app/components/SpellPrepSummary.vue`
- Modify: `apps/web/app/pages/actor/[id].vue` (render above the spell filter chips ~`:147`)

**Interfaces:**
- Consumes: `SheetViewModel.spellPrep` (Task 3); `sheet` ref, `spellSectionsOnTab` computed, `actorId` (all already in `[id].vue`). Nuxt auto-imports components, so no manual import.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Create the component**

Create `apps/web/app/components/SpellPrepSummary.vue`:

```vue
<template>
  <div class="prep">
    <div class="prep-text">
      <span class="lab">Prepared</span>
      <span class="tally tabular" :class="{ over }">
        <span class="cur">{{ prepared }}</span>
        <span class="sep">/</span>
        <span class="max">{{ denom }}</span>
      </span>
    </div>
    <div class="prep-adjust">
      <button
        class="step"
        type="button"
        aria-label="Lower prepared limit"
        @click="bump(-1)"
      >
        −
      </button>
      <button
        class="step"
        type="button"
        aria-label="Raise prepared limit"
        @click="bump(1)"
      >
        +
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  prepared: number
  base: number
  actorId: string
}>()

const storageKey = computed(() => `fc:prepoffset:${props.actorId}`)
const offset = ref(0)

onMounted(() => {
  try {
    const raw = localStorage.getItem(storageKey.value)
    if (raw !== null) {
      const n = Number.parseInt(raw, 10)
      if (Number.isFinite(n)) offset.value = n
    }
  } catch {
    /* private mode — default offset 0 */
  }
})

const denom = computed(() => Math.max(0, props.base + offset.value))
const over = computed(() => props.prepared > denom.value)

function bump(delta: number): void {
  offset.value += delta
  try {
    localStorage.setItem(storageKey.value, String(offset.value))
  } catch {
    /* noop */
  }
}
</script>

<style scoped>
.prep {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--panel-2) 70%, transparent);
}

.prep-text {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.lab {
  font-size: 0.7rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-dim);
}

.tally {
  font-size: 1.2rem;
  font-weight: 700;
  color: var(--ink);
}

.tally .cur {
  color: var(--gold-bright);
}

.tally .sep,
.tally .max {
  color: var(--ink-faint);
}

.tally.over .cur {
  color: var(--garnet);
}

.prep-adjust {
  display: flex;
  gap: 6px;
}

.step {
  min-width: var(--tap);
  min-height: var(--tap);
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink);
  font-size: 1.1rem;
  font-weight: 700;
  line-height: 1;
}

.step:active {
  transform: scale(0.95);
}
</style>
```

Note: `useRuntimeConfig`-style auto-imports (`ref`, `computed`, `onMounted`) are Nuxt globals — no import lines needed, matching the other components.

- [ ] **Step 2: Wire it into the Spells tab**

In `apps/web/app/pages/actor/[id].vue`, immediately BEFORE the spell filter chips block (`<div v-if="spellChips.length > 0" class="filter-chips spell-filters">`, ~`:147`), add:

```html
          <SpellPrepSummary
            v-if="sheet?.spellPrep && spellSectionsOnTab.length > 0"
            :prepared="sheet.spellPrep.prepared"
            :base="sheet.spellPrep.base"
            :actor-id="actorId"
          />
```

(`spellSectionsOnTab` is only non-empty on the Spells tab, so the summary shows there and nowhere else; `sheet?.spellPrep` gates out non-preparing casters.)

- [ ] **Step 3: Verify typecheck**

Run: `pnpm --filter @companion/web typecheck`
Expected: exit 0. `sheet.spellPrep` resolves because the web imports the updated `SheetViewModel` from `@companion/adapter-sdk`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/components/SpellPrepSummary.vue "apps/web/app/pages/actor/[id].vue"
git commit -m "$(cat <<'EOF'
feat(web): prepared-spell budget summary on the Spells tab

New SpellPrepSummary shows "Prepared X / Y" atop the Spells tab, where Y is
the adapter's best-effort base plus a per-actor offset the player adjusts
with a +/- stepper (persisted in localStorage). Over-budget tints the count.
Shown only when the actor has a spellPrep budget.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Run the whole workspace typecheck + adapter tests**

Run: `pnpm -r typecheck`
Expected: exit 0 across all packages.

Run: `pnpm --filter @companion/adapter-dnd5e test`
Expected: PASS, all suites.

- [ ] **Step 2: Visual check in the running stack (manual)**

Confirm on a prepared caster (e.g. the Cleric): the Spells tab shows "Prepared 3 / 7" atop the level sections; the `+/−` stepper changes the denominator and survives a page reload; unprepared rows render dimmed with prepared ones on top of each level; prepared rows show no "prepared" sub text or tag but keep their Prepared toggle and Cast button. Confirm a martial actor shows no summary and no change.

## Self-Review

**1. Spec coverage:**
- §1 Redundancy removal → Task 1. ✓
- §2 Prepared-first ordering → Task 2; dimming → Task 4. ✓
- §3 Budget (SDK field, adapter base+count, when-it-shows) → Task 3; web summary + offset stepper + over-budget tint + placement → Task 5. ✓
- §3 "when it shows" = preparable spells exist → `spellPrepBudget` returns `undefined` otherwise (Task 3), and the summary is additionally gated on `spellSectionsOnTab` (Task 5). ✓
- Scope non-goals (no relay change, no disclosure control, per-device offset, mechanic untouched) → respected; no task touches the relay or the `prepare` intent. ✓

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; no "add error handling"-style vagueness. ✓

**3. Type consistency:** `spellPrep: { prepared: number; base: number }` is identical in the SDK field (Task 3 Step 1), the adapter helper return (Task 3 Step 4), the test (`toEqual({ prepared, base })`), and the component props (Task 5). `preparedRank`/`spellPrepBudget`/`preparedBase`/`isUnprepared` names are used consistently. `spellSectionsOnTab` and `actorId` are pre-existing in `[id].vue` (verified). ✓
