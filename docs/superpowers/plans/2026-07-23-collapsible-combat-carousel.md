# Collapsible Combat Carousel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a player hide the initiative carousel during combat and restore it with a floating pill, resetting to expanded when combat ends and auto-expanding on the viewer's own turn.

**Architecture:** Fully client-side in the Nuxt web app. `InitiativeCarousel.vue` gains a collapse button that emits `collapse`. `actor/[id].vue` holds an in-memory `carouselCollapsed` ref, derives `carouselDockVisible`/`carouselPillVisible` on top of the existing `showCarousel`, retargets the three current `showCarousel` layout consumers to the dock-visible flag, renders a floating restore pill, and resets the flag via two watchers (combat-end and your-turn).

**Tech Stack:** Nuxt 4 / Vue 3.5 `<script setup lang="ts">`, scoped CSS with the app's Gilded Tome design tokens (`--gold`, `--gold-bright`, `--gold-deep`, `--accent-ink`, `--ink-faint`, `--safe-bottom`). No new dependencies.

## Global Constraints

- **No gateway, API, wire-type, or mock-server changes** — this feature is web-only.
- **No unit test runner exists** for `apps/web` (`pnpm --filter @companion/web test` is a stub echo). The binding automated gate is `pnpm --filter @companion/web typecheck` (vue-tsc). Acceptance beyond typecheck is visual smoke against the dev stack, matching repo convention.
- **In-memory only** — do NOT add `localStorage`/persistence. The reset-on-combat-end behavior is deliberate.
- Reuse existing design tokens and the existing `ICONS.combat` shield glyph; do not introduce new SVG paths for the pill.

---

### Task 1: InitiativeCarousel collapse affordance

**Files:**
- Modify: `apps/web/app/components/InitiativeCarousel.vue`

**Interfaces:**
- Consumes: nothing new (existing props `combatants`, `round`, `turnCombatantId`, `actorId`, `canEndTurn`).
- Produces: component emits a new `collapse` event (no payload), alongside the existing `endTurn`. Task 2's `[id].vue` binds `@collapse`.

- [ ] **Step 1: Add the `collapse` emit**

In the `<script setup>` block, extend the emits definition from:

```ts
const emit = defineEmits<{
  (e: 'endTurn'): void
}>()
```

to:

```ts
const emit = defineEmits<{
  (e: 'endTurn'): void
  (e: 'collapse'): void
}>()
```

- [ ] **Step 2: Add the collapse button to the template**

In `<template>`, immediately after the existing end-turn button block:

```html
    <button v-if="canEndTurn" type="button" class="end-turn" @click="emit('endTurn')">
      End turn <span aria-hidden="true">▸</span>
    </button>
```

insert the collapse button as the final child of `.carousel` (before `</div>`):

```html
    <button type="button" class="collapse-btn" aria-label="Hide turn order" @click="emit('collapse')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="m6 9 6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
```

The button always renders while the carousel is mounted; `.carousel` is a flex row with `.track` at `flex: 1`, so this `flex: none` control pins to the right edge after the optional End-turn button.

- [ ] **Step 3: Add the collapse-button styles**

At the end of the `<style scoped>` block, after the `.end-turn:active` rule, append:

```css
/* ---- collapse button (2026-07-23) ---- */

.collapse-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  color: var(--ink-faint);
}

.collapse-btn svg {
  width: 18px;
  height: 18px;
}

.collapse-btn:active {
  color: var(--gold);
  transform: scale(0.95);
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @companion/web typecheck`
Expected: PASS (no new errors). The component now compiles with the added `collapse` emit and button.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/InitiativeCarousel.vue
git commit -m "feat(web): add hide button to InitiativeCarousel

Emits a collapse event; parent wiring lands in the next task.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Wire collapse state, restore pill & auto-expand into the actor page

**Files:**
- Modify: `apps/web/app/pages/actor/[id].vue`

**Interfaces:**
- Consumes: `InitiativeCarousel`'s `collapse` event (Task 1); existing `showCarousel`, `encounterActive`, `canEndTurn` computeds; existing `ICONS.combat` shield path.
- Produces: nothing consumed downstream (terminal feature).

- [ ] **Step 1: Add collapse state, derived flags, and watchers (script)**

In `<script setup>`, immediately after the `canEndTurn` computed block (which ends at `})` before `const turnEndBusy = ref(false)`), insert:

```ts
/** Combat carousel collapse (2026-07-23): the player can hide the initiative
 *  dock to reclaim vertical space; a floating pill restores it. In-memory only
 *  — reset to expanded when combat ends (so a new combat opens expanded) and
 *  auto-expanded once when it becomes the viewer's own turn. */
const carouselCollapsed = ref(false)
const carouselDockVisible = computed(() => showCarousel.value && !carouselCollapsed.value)
const carouselPillVisible = computed(() => showCarousel.value && carouselCollapsed.value)

/* Combat ended -> next combat opens expanded. encounter.value only changes on a
 * real SSE frame (disconnects flip combatConn, never the active flag), so this
 * true->false edge is a genuine end, not a reconnect blip. */
watch(encounterActive, (now, was) => {
  if (was && !now) carouselCollapsed.value = false
})

/* Your turn arrived -> reopen once (edge-triggered, so re-collapsing mid-turn
 * sticks until the next turn). */
watch(canEndTurn, (now, prev) => {
  if (now && !prev) carouselCollapsed.value = false
})
```

(`ref`, `computed`, and `watch` are Nuxt auto-imports already used throughout this file — no import statement needed.)

- [ ] **Step 2: Retarget the frame padding class (template)**

Change the frame root binding from:

```html
      <div class="frame" :class="{ 'with-carousel': showCarousel }">
```

to:

```html
      <div class="frame" :class="{ 'with-carousel': carouselDockVisible }">
```

This drops the `.frame.with-carousel` 170px bottom reserve back to the normal 100px when the dock is collapsed, so the sheet reclaims the space.

- [ ] **Step 3: Retarget the dock and handle `@collapse` (template)**

Change the dock wrapper and carousel usage from:

```html
      <div v-if="showCarousel" class="carousel-dock">
        <InitiativeCarousel
          :combatants="encounter.combatants ?? []"
          :round="encounter.round"
          :turn-combatant-id="encounter.turn?.combatantId ?? null"
          :actor-id="actorId"
          :can-end-turn="canEndTurn"
          @end-turn="onEndTurn"
        />
      </div>
```

to:

```html
      <div v-if="carouselDockVisible" class="carousel-dock">
        <InitiativeCarousel
          :combatants="encounter.combatants ?? []"
          :round="encounter.round"
          :turn-combatant-id="encounter.turn?.combatantId ?? null"
          :actor-id="actorId"
          :can-end-turn="canEndTurn"
          @end-turn="onEndTurn"
          @collapse="carouselCollapsed = true"
        />
      </div>

      <button
        v-if="carouselPillVisible"
        type="button"
        class="carousel-pill"
        :class="{ 'your-turn': canEndTurn }"
        aria-label="Show turn order"
        @click="carouselCollapsed = false"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path :d="ICONS.combat" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
```

- [ ] **Step 4: Retarget the dice FAB raise (template)**

In the `<DiceTray>` usage, change:

```html
      :raised="showCarousel"
```

to:

```html
      :raised="carouselDockVisible"
```

so the dice FAB drops from `bottom: 230px` back to `bottom: 84px` when the dock is collapsed.

- [ ] **Step 5: Add the restore-pill styles (style)**

In `<style scoped>`, immediately after the `.carousel-dock { ... }` rule (the block ending with `border-top: 1px solid var(--line);` then `}`), insert:

```css
/* ---- collapsed-carousel restore pill (2026-07-23) ---- */

.carousel-pill {
  position: fixed;
  right: 14px;
  bottom: calc(84px + var(--safe-bottom));
  z-index: 39;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 999px;
  border: 1px solid var(--gold-deep);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  color: var(--accent-ink);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--gold) 34%, transparent);
}

.carousel-pill svg {
  width: 24px;
  height: 24px;
}

.carousel-pill:active {
  transform: scale(0.94);
}

.carousel-pill.your-turn {
  animation: pill-pulse 1.4s ease-in-out infinite;
}

@keyframes pill-pulse {
  0%, 100% {
    box-shadow: 0 4px 14px color-mix(in srgb, var(--gold) 34%, transparent);
  }
  50% {
    box-shadow: 0 4px 14px color-mix(in srgb, var(--gold) 34%, transparent),
      0 0 0 4px color-mix(in srgb, var(--gold-bright) 45%, transparent);
  }
}
```

The pill sits bottom-**right** (`right: 14px`) opposite the bottom-**left** dice FAB, so they never collide.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @companion/web typecheck`
Expected: PASS (no new errors).

- [ ] **Step 7: Visual smoke against the dev stack**

With the dev stack running and the fixture combat active (mock server exposes a permanently-active fixture encounter; the live stack shows one when a Foundry combat runs), open an actor sheet during combat and verify:
- Tap the carousel's hide (down-chevron) button → the dock disappears, the dice FAB drops to its normal position, the sheet content reclaims the bottom space, and the `⚔` pill appears bottom-right.
- Tap the pill → the carousel returns.
- Collapse, then advance the fixture turn to the viewed actor → the carousel auto-expands (and while collapsed and it is the viewer's turn, the pill pulses).
- Collapse, then end the fixture combat and start a new one → it opens expanded.

Expected: all behaviors as described; no layout overlap between the pill and the dice FAB or tab bar.

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/pages/actor/[id].vue
git commit -m "feat(web): collapsible combat carousel with restore pill

Hide the initiative dock (reclaims bottom space, drops the dice FAB),
restore via a bottom-right pill that pulses on your turn. In-memory
state resets to expanded on combat-end and auto-expands on your turn.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- State (`carouselCollapsed`, `carouselDockVisible`, `carouselPillVisible`) → Task 2 Step 1. ✓
- Layout wiring (frame class, dock `v-if`, dice `:raised`) → Task 2 Steps 2–4. ✓
- Collapse affordance (`collapse` emit + button) → Task 1. ✓
- Restore pill (bottom-right, `⚔`, your-turn glow) → Task 2 Steps 3 & 5. ✓
- Combat-end + your-turn watchers → Task 2 Step 1. ✓
- Trade-off (no localStorage) → honored by keeping state in-memory (Global Constraints + Task 2 Step 1). ✓
- Testing (typecheck + visual smoke) → Task 1 Step 4; Task 2 Steps 6–7. ✓

**Placeholder scan:** No TBD/TODO; all code shown in full. ✓

**Type consistency:** `carouselCollapsed`/`carouselDockVisible`/`carouselPillVisible` used identically across script and template; `collapse` emit name matches `@collapse` handler; `ICONS.combat` matches the existing const. ✓
