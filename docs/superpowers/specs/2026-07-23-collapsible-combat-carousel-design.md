# Collapsible combat carousel — design

**Date:** 2026-07-23
**Status:** approved (brainstormed with user; fully client-side approach)

## Problem

During combat the initiative carousel is docked as a fixed bar above the tab
bar (`.carousel-dock`, `bottom: 68px`) and is always shown whenever combat is
active and the combat stream is live (`showCarousel`). It reserves ~70px of
extra bottom padding on the sheet (`.frame.with-carousel`: 170px vs the normal
100px) and pushes the dice FAB up to `bottom: 230px`. On a phone that is a lot
of permanently-occupied vertical space, and the player has no way to reclaim it
while combat runs.

## Goal

Let a player hide the carousel to reclaim the space, and restore it with one
tap. The hidden state resets to expanded when combat ends (so a new combat
always starts expanded) and auto-reopens the moment it becomes that player's
own turn.

## Scope

**Fully client-side, in the web app only.** No gateway, API, wire-type, or
mock-server changes. Two files:

- `apps/web/app/pages/actor/[id].vue` — state, layout wiring, restore pill,
  auto-expand watchers.
- `apps/web/app/components/InitiativeCarousel.vue` — the collapse affordance.

## Design decisions (from brainstorming)

- **Collapse style:** the whole dock hides; a small floating pill restores it
  (chosen over a slim always-visible handle bar or a top-toolbar toggle).
- **Reset behavior:** reset to expanded when combat *ends*, rather than keying
  a persisted flag to a combat id. Because the reset fires on combat-end, the
  next combat naturally starts expanded with no combat identity needed.
- **Auto-expand:** only when it becomes the viewing player's own turn.
- **No persistence:** in-memory ref only (see Trade-off).

## Behavior

### State (`[id].vue`)

- `const carouselCollapsed = ref(false)` — in-memory, defaults to expanded.
- `carouselDockVisible = computed(() => showCarousel.value && !carouselCollapsed.value)`
- `carouselPillVisible = computed(() => showCarousel.value && carouselCollapsed.value)`

`showCarousel` (`encounterActive && combatConn === 'live'`) is unchanged; the two
new computeds layer the collapse state on top of it.

### Layout wiring

The three current consumers of `showCarousel` retarget to the effective flag:

- Dock `v-if` → `carouselDockVisible`.
- `.frame` `with-carousel` class → `carouselDockVisible` — collapsing drops the
  bottom-padding reserve from `calc(170px + safe)` back to the normal `100px`,
  so the sheet reclaims the freed space.
- `<DiceTray :raised>` → `carouselDockVisible` — the dice FAB drops from
  `bottom: 230px` back to its normal `bottom: 84px` when the dock is gone.

### Collapse affordance (`InitiativeCarousel.vue`)

- A compact ghost icon button (down-chevron / minimize glyph), `flex: none`, as
  the trailing control at the carousel's right edge, after the optional
  End-turn button. `aria-label="Hide turn order"`.
- Emits a new `collapse` event. `[id].vue` handles `@collapse` by setting
  `carouselCollapsed = true`.

### Restore pill (`[id].vue`)

- A floating round pill reusing the existing shield combat glyph (`ICONS.combat`), positioned bottom-**right**
  (`right: 14px`, `bottom: ~84px` above the tab bar) so it is clear of the
  bottom-**left** dice FAB. Styled consistently with the existing `.fab`.
  `aria-label="Show turn order"`.
- Rendered when `carouselPillVisible`. Tapping it sets `carouselCollapsed = false`.
- Shows a subtle "your turn" glow/badge when `canEndTurn` is true, so a hidden
  carousel still signals when the player needs to act (covers the
  reload/reconnect-while-your-turn case where no fresh transition fires).

### Auto-expand watchers (`[id].vue`)

- **Combat ends** — `watch(encounterActive, (now, was) => { if (was && !now) carouselCollapsed.value = false })`.
  `encounter.value` is only ever overwritten by a real SSE frame; disconnects
  merely flip `combatConn`, never the `active` flag (verified in
  `connectCombatEvents`/`closeCombatEvents`). So `encounterActive` going
  `true → false` is a genuine combat-end signal, immune to reconnect blips.
- **Your turn** — `watch(myTurnActive, (now, prev) => { if (now && !prev) carouselCollapsed.value = false })`.
  Edge-triggered on `false → true`, so it reopens once when the turn arrives but
  does not fight the player who re-collapses mid-turn.

## Edge cases

- **Reconnect blips:** `combatConn` flaps but `encounter.value.active` stays
  true, so `encounterActive` does not transition and the collapse state is
  preserved. The in-memory ref also survives the blip (component stays mounted).
- **Combat ends while collapsed:** the combat-end watcher resets to expanded;
  both dock and pill are hidden anyway (both gated on `showCarousel`), and the
  next combat opens expanded.
- **Your turn while collapsed:** auto-expands once via the `canEndTurn` watcher.

## Trade-off

No `localStorage` persistence: a **full page reload** mid-combat re-expands the
carousel. This is the deliberate simplification behind "reset on combat end" —
it avoids needing a combat identity or a persisted, per-actor flag that could go
stale across a combat boundary the page never witnessed. Reconnect blips (the
motivating case for surviving interruptions) are still handled by the in-memory
ref.

## Testing

- `pnpm --filter @companion/web typecheck`.
- Visual smoke against the dev stack with the fixture combat:
  - Collapse → dock disappears, dice FAB drops to its normal position, the sheet
    reclaims the bottom space, and the combat-glyph pill appears bottom-right.
  - Tap the pill → carousel returns.
  - Advance the fixture turn to the viewed actor → carousel auto-expands.
  - End the fixture combat → collapse state resets (next combat is expanded).
