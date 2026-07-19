# Saving Throws + Hide XP + Gear Row Overlap Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface rollable saving throws on the dnd5e sheet, hide the XP headline stat, and fix the Gear-tab row layout that collapses an item's name when it carries a quantity stepper plus Equip and Attune pills.

**Architecture:** The PWA already renders any `kind: 'stats'` section as a tappable card grid, and the offline mock (`apps/web/mock/server.mjs`) already emits a `saves` section with `ability.<id>.save` actions — only the real dnd5e adapter never emits it. So saves are a pure adapter change (new section reusing the existing `saveBonus()` used by the roll path, so the displayed number is exactly what rolls). XP is a one-line headline removal in the same adapter. The overlap bug is web-only: `SectionList.vue` rows are a non-wrapping flex line, so ~310px of fixed-width controls squeeze the name block (`flex: 1; min-width: 0`) to zero width; grouping controls into a wrapping container fixes every current and future control combination.

**Tech Stack:** TypeScript monorepo (pnpm), Vitest (adapter tests), Vue 3 / Nuxt 4 PWA, Node mock server for offline dev, chrome-devtools MCP for visual verification.

## Global Constraints

- Data paths pinned to dnd5e **5.3.3** on Foundry **v13** (VERSIONS.md); derived paths preferred, presentation-only fallbacks otherwise (adapter file header).
- The relay may serialize **source data without derived fields** — every displayed number must have a source-data fallback.
- Displayed bonuses must equal rolled bonuses (single source of truth — `saveBonus()`).
- The repo ships **no game-rules content** — labels/vocabulary only.
- Run adapter tests with `pnpm --filter @companion/adapter-dnd5e test`; typecheck with `pnpm typecheck` (run `pnpm --filter @companion/web typecheck` for web changes).
- Commit style: conventional commits (`feat(adapter-dnd5e): …`, `fix(web): …`), each ending with the Co-Authored-By Claude trailer.

---

### Task 1: Saving Throws section in the dnd5e adapter

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` (function `saveBonus` ~line 872; add `saveStats` next to it; sections array in `toViewModel` ~line 2121)
- Test: `packages/adapter-dnd5e/test/adapter.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: existing `saveBonus(actor, abilityId): number`, `ABILITIES`, `signed()`, `numAt()`, `Stat` from `@companion/adapter-sdk`, existing actions `ability.<id>.save` (emitted in `buildActions`, rolled by `buildAbilityRoll` line ~1811).
- Produces: a `SheetSection` `{ kind: 'stats', id: 'saves', label: 'Saving Throws', stats: Stat[] }` inserted directly after the `abilities` section. Each stat: `{ id: 'save.<abl>', label: '<Ability>', value: '<signed bonus>', sub?: '● proficient', actionId: 'ability.<abl>.save' }`. The PWA needs no changes: `[id].vue` renders non-`abilities`/non-`traits` stats sections as the `cards` variant, and section ids not matching the spell/gear tab regexes route to Overview.

- [ ] **Step 1: Write the failing tests**

Append to `packages/adapter-dnd5e/test/adapter.test.ts` (mirror the file's existing import/fixture conventions — `martial` and `caster` fixtures are already loaded at the top):

```ts
describe('Saving Throws section (2026-07-19)', () => {
  it('emits a saves stats section directly after abilities', () => {
    const vm = dnd5eAdapter.toViewModel(martial);
    const ids = vm.sections.map((s) => s.id);
    expect(ids.indexOf('saves')).toBe(ids.indexOf('abilities') + 1);
    const saves = vm.sections.find((s) => s.id === 'saves');
    expect(saves?.kind).toBe('stats');
    if (saves?.kind !== 'stats') throw new Error('unreachable');
    expect(saves.label).toBe('Saving Throws');
    expect(saves.stats).toHaveLength(6);
  });

  it('save cards show the exact bonus the save roll uses, with proficiency marker', () => {
    const vm = dnd5eAdapter.toViewModel(martial);
    const saves = vm.sections.find((s) => s.id === 'saves');
    if (saves?.kind !== 'stats') throw new Error('saves must be a stats section');
    const str = saves.stats.find((s) => s.id === 'save.str')!;
    // martial fixture: STR 16 (mod +3), proficient 1, prof +3 -> +6.
    // IMPORTANT: verify the +3 prof against the fixture before trusting this
    // constant (existing headline tests assert Proficiency '+3' for martial).
    expect(str.value).toBe('+6');
    expect(str.sub).toBe('● proficient');
    expect(str.actionId).toBe('ability.str.save');
    const dex = saves.stats.find((s) => s.id === 'save.dex')!;
    // DEX 14 (mod +2), not proficient -> +2, no marker.
    expect(dex.value).toBe('+2');
    expect(dex.sub).toBeUndefined();
  });

  it('prefers derived abilities.<id>.save.value when the relay provides it', () => {
    const system = martial.system as Record<string, unknown>;
    const abilities = (system.abilities ?? {}) as Record<string, Record<string, unknown>>;
    const withDerived: FoundryActorDoc = {
      ...martial,
      system: {
        ...system,
        abilities: { ...abilities, str: { ...abilities.str, save: { value: 9 } } },
      },
    };
    const saves = dnd5eAdapter.toViewModel(withDerived).sections.find((s) => s.id === 'saves');
    if (saves?.kind !== 'stats') throw new Error('saves must be a stats section');
    expect(saves.stats.find((s) => s.id === 'save.str')?.value).toBe('+9');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @companion/adapter-dnd5e test`
Expected: the three new tests FAIL (no `saves` section found); every pre-existing test still passes. If the `+6`/`+2` constants disagree with the fixture, re-derive them from `martial.json` (`abilities.str.value` 16 → mod +3; proficiency from `attributes.prof` or 2 + floor((level−1)/4)) — do NOT bend the implementation to a wrong constant.

- [ ] **Step 3: Implement**

In `packages/adapter-dnd5e/src/index.ts`, extend `saveBonus` (~line 872) to prefer the derived path, keeping the documented fallback:

```ts
/** Save bonus: derived `abilities.<id>.save.value` when the relay provides
 * it (active-effect bonuses included), else ability mod + prof when
 * save-proficient (`abilities.<id>.proficient` >= 1). Single source of truth
 * for the Saving Throws cards AND buildAbilityRoll — the sheet never shows a
 * number it won't roll. */
function saveBonus(actor: FoundryActorDoc, abilityId: string): number {
  const derived = numAt(actor.system, `abilities.${abilityId}.save.value`);
  if (derived !== undefined) return derived;
  const proficient = numAt(actor.system, `abilities.${abilityId}.proficient`) ?? 0;
  return abilityMod(actor.system, abilityId) + (proficient >= 1 ? proficiency(actor) : 0);
}
```

Add `saveStats` directly below `saveBonus`:

```ts
/** One card per ability save (2026-07-19), rendered by the PWA's stats-card
 * grid like skills. Marker mirrors abilityStats' threshold (>= 1). */
function saveStats(actor: FoundryActorDoc): Stat[] {
  return ABILITIES.map((a) => {
    const proficient = (numAt(actor.system, `abilities.${a.id}.proficient`) ?? 0) >= 1;
    return {
      id: `save.${a.id}`,
      label: a.label,
      value: signed(saveBonus(actor, a.id)),
      ...(proficient ? { sub: '● proficient' } : {}),
      actionId: `ability.${a.id}.save`,
    };
  });
}
```

In `toViewModel` insert the section right after abilities (~line 2122):

```ts
  const sections: SheetSection[] = [
    { kind: 'stats', id: 'abilities', label: 'Abilities', stats: abilityStats(actor) },
    { kind: 'stats', id: 'saves', label: 'Saving Throws', stats: saveStats(actor) },
    { kind: 'stats', id: 'skills', label: 'Skills', stats: skillStats(actor) },
    { kind: 'stats', id: 'passives', label: 'Passive Senses', stats: passiveStats(actor) },
  ];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @companion/adapter-dnd5e test`
Expected: ALL tests pass (new ones plus the whole existing suite — watch for section-index-sensitive tests; if an existing test asserts section order/count, update it to include `saves`).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @companion/adapter-dnd5e typecheck` (or `pnpm typecheck`)

```bash
git add packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/adapter.test.ts
git commit -m "feat(adapter-dnd5e): Saving Throws stats section

Emits the saves section the PWA and mock already support; card values
reuse saveBonus() so display always equals the rolled bonus, now
preferring derived abilities.<id>.save.value when the relay provides it.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Hide the XP headline stat

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` (headline array ~line 2087-2094)
- Modify: `apps/web/app/components/SheetHero.vue` (comment ~lines 326-328 only)
- Test: `packages/adapter-dnd5e/test/adapter.test.ts` (replace the `describe('XP headline stat (M10)')` block, ~lines 1529-1542)

**Interfaces:**
- Consumes: the `headline: Stat[]` array in `toViewModel`.
- Produces: headline WITHOUT the `xp` stat (`ac`, `class`, `speed`, `prof`, `init` remain). The PWA's hero cluster just renders whatever headline stats arrive — no web logic change.

- [ ] **Step 1: Replace the XP tests with a hidden-XP test**

In `packages/adapter-dnd5e/test/adapter.test.ts`, delete the whole `describe('XP headline stat (M10)', …)` block (~lines 1529-1542) and add:

```ts
describe('XP hidden from headline (2026-07-19)', () => {
  it('emits no xp headline stat — most tables level by milestone', () => {
    for (const actor of [martial, martialCaptured]) {
      const ids = dnd5eAdapter.toViewModel(actor).headline.map((s) => s.id);
      expect(ids).not.toContain('xp');
    }
  });
});
```

- [ ] **Step 2: Run tests to verify the new test fails**

Run: `pnpm --filter @companion/adapter-dnd5e test`
Expected: new test FAILS (headline still contains `xp`); old XP tests are gone.

- [ ] **Step 3: Remove the xp headline stat**

In `packages/adapter-dnd5e/src/index.ts` delete this line from the headline array (~line 2093):

```ts
    { id: 'xp', label: 'XP', value: numAt(actor.system, 'details.xp.value') ?? 0 },
```

Leave `details.xp.value` reading nowhere else — the stat is hidden for now (milestone tables), not repurposed.

In `apps/web/app/components/SheetHero.vue`, update the stale cluster comment (~lines 326-328) — it justifies flex-wrap with "5 cluster stats … 6-digit XP":

```
/* Flex-wrap instead of a fixed 4-column grid: wrapped tiles grow to fill
 * their row so the cluster stays balanced however many headline stats an
 * adapter emits (XP is hidden for now — milestone leveling, 2026-07-19). */
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @companion/adapter-dnd5e test`
Expected: ALL pass. Also `pnpm --filter @companion/web typecheck` (comment-only change, must stay green).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/adapter.test.ts apps/web/app/components/SheetHero.vue
git commit -m "feat(adapter-dnd5e): hide XP headline stat (milestone tables)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Gear row overlap — wrap controls instead of collapsing the name

**Files:**
- Modify: `apps/web/app/components/SectionList.vue` (template rows + styles)
- Modify: `apps/web/mock/server.mjs` (repro item: qty stepper + equip + attune on one row; attune action support)

**Interfaces:**
- Consumes: existing `ResourceStepper` (`compact` prop), `toggleOf/attuneOf/verbOf` helpers, mock `buildActions`/`listItem`/`buildSheet`, mock action POST handler (mirrors `kind: 'equip'` toggling — find it by searching `equip` in `server.mjs`).
- Produces: no API change. Mock gains `attune: { attuned: boolean }` on inventory item defs → emits `item.<id>.attune` action (`kind: 'attune'`, `attuned` flag) + `attuneActionId` on the row, exactly the shape the real adapter emits (see `attuneOf`/`ActionDescriptor` usage in `SectionList.vue`).

**Root cause (verified against the code):** `.row` is `display: flex` without wrapping; `.row-main` is `flex: 1; min-width: 0`. A row with a qty stepper AND Equip AND Attune pills (attunable magic weapon/armor — the "Miterdandes Eisenseele" item) has more fixed-width controls than a phone viewport, so `.row-main` collapses to 0 width: the name (`overflow: hidden`) disappears and the unclipped `.tags` overflow underneath the stepper.

- [ ] **Step 1: Add the repro item to the mock**

In `apps/web/mock/server.mjs`:

Add to `a-marisol`'s (the wizard's) `resources` array:

```js
    r('item.i-eisenseele.qty', 'Eisenseele', 1, { max: 9, group: 'items' }),
```

Add to `a-marisol`'s `staticSections.inventory`:

```js
      { id: 'i-eisenseele', label: 'Eisenseele, Blade of the Iron Soul', sub: '1d8 slashing · 3 lb', attackMod: 7, resourceId: 'item.i-eisenseele.qty', equip: { equipped: true, acBonus: 0 }, attune: { attuned: true } },
```

In `buildActions`, next to the `it.equip` branch:

```js
    if (it.attune) {
      actions.push({ id: `item.${it.id}.attune`, label: it.label, kind: 'attune', attuned: it.attune.attuned })
    }
```

In `listItem`, add the attuned tag and give inventory rows their attune toggle — follow how `equip`/`toggleActionId` flows from `buildSheet` into `listItem` and mirror it (e.g. after the tags block):

```js
  if (def.equip?.equipped) tags.push('equipped')
  if (def.attune?.attuned) tags.push('attuned')
  ...
  if (def.attune) item.attuneActionId = `item.${def.id}.attune`
```

In the action POST handler, mirror the `equip` toggle for attune (search for where `kind === 'equip'` or the `.equip` actionId suffix is handled; add the same state-flip for `.attune` → `it.attune.attuned = !it.attune.attuned`).

- [ ] **Step 2: Reproduce visually (mock + chrome-devtools)**

Run: `pnpm --filter @companion/web dev:mock` (background) and `pnpm --filter @companion/web dev` (background). Check `apps/web/mock/server.mjs` header/`nuxt.config.ts` for how the PWA points at the mock (port/env) and follow it.
With chrome-devtools MCP: `resize_page` to 390×844, navigate to the wizard actor's sheet, open the Gear tab, screenshot.
Expected BEFORE fix: the Eisenseele row shows no name; stepper overlaps the tags — matching the bug report.

- [ ] **Step 3: Fix SectionList.vue**

Template — group the four trailing controls (ResourceStepper, toggle pill, attune pill, act button; lines ~71-113) inside one container:

```html
        <div class="row-controls">
          <ResourceStepper ... unchanged ... />
          <button v-if="toggleOf(item)" class="equip-btn" ...>...</button>
          <button v-if="attuneOf(item)" class="equip-btn" ...>...</button>
          <button v-if="verbOf(item)" class="act-btn" ...>...</button>
        </div>
```

Styles:

```css
.row {
  display: flex;
  flex-wrap: wrap; /* controls wrap below the name instead of crushing it */
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  min-height: 60px;
}

.row-main {
  flex: 1 1 160px; /* name keeps a readable minimum before controls wrap */
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  align-items: flex-start;
}

.row-controls {
  flex: none;
  max-width: 100%;
  margin-left: auto; /* stays flush-right, on either line */
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}

.row-controls:empty {
  display: none; /* rows without controls keep their old spacing */
}
```

(`.act-btn`/`.equip-btn` keep their own rules; the old sibling layout had `gap: 12px` between controls — the grouped container uses 8px, matching the pill pair visually; adjust to 12px if the diff looks cramped in the screenshot.)

- [ ] **Step 4: Verify visually**

Same chrome-devtools flow as Step 2 (390×844, Gear tab).
Expected AFTER fix: "Eisenseele, Blade of the Iron Soul" name + sub + EQUIPPED/ATTUNED tags fully visible; stepper + Equipped + Attuned (+ any action button) sit right-aligned, wrapped to a second line inside the row; no overlap. Also spot-check rows that previously fit (Potion of Healing, Longsword on the fighter, spell rows with Cast buttons, container sections on the real-adapter path if reachable) — they must look unchanged, controls still flush-right. Take screenshots at 390px AND a wide viewport (≥768px) to confirm desktop is unchanged.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @companion/web typecheck`
Expected: green.

```bash
git add apps/web/app/components/SectionList.vue apps/web/mock/server.mjs
git commit -m "fix(web): wrap gear-row controls instead of collapsing the item name

A row carrying qty stepper + Equip + Attune pills exceeded phone width;
.row-main (flex:1, min-width:0) collapsed to zero so the name vanished
and tags overflowed under the stepper. Controls now group into a
wrapping flush-right container; mock gains an attunable+equippable+
stackable item to keep the repro.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
