# Movement Grid Fixed-Size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Movement squares keep a constant readable size (scroll instead of shrink), and the grid shows a full-speed+margin window with out-of-range squares greyed but still displaying enemy/ally dots.

**Architecture:** One Vue component (`apps/web/app/components/MoveSheet.vue`). Split the single reachable `radius` into a fixed-per-turn `windowRadius` (what renders) and a `reachRadius` (what's selectable). Cells beyond `reachRadius` render greyed/non-selectable but still show occupant dots. Squares become a fixed CSS size; the grid scrolls inside the sheet and opens centered on the token.

**Tech Stack:** Nuxt 4 / Vue 3.5 `<script setup lang="ts">`, scoped CSS with existing design tokens. No new dependencies. No gateway/API/wire-type/mock changes — `MovementView.others` already carries every visible scene token.

## Global Constraints

- **Web-only; one file** (`MoveSheet.vue`). No gateway/API/mock changes.
- **No unit test runner** for `apps/web` (`test` is a stub echo). Binding gate: `pnpm --filter @companion/web typecheck` (vue-tsc). Acceptance beyond typecheck is visual smoke against the dev stack.
- `WINDOW_MARGIN = 2`; `--move-cell: 40px` (both are the tunable knobs — use these exact values).
- Reachable-cell appearance and selection behavior must be **unchanged** from today; only add the greyed out-of-range treatment and the fixed sizing/scroll/centering.
- `windowRadius` is based on **full `speedFt`** (fixed for the turn); `reachRadius` is based on the existing `rangeFt` (`inCombat ? remainingFt : speedFt`).

---

### Task 1: Fixed-size grid with greyed out-of-range squares

**Files:**
- Modify: `apps/web/app/components/MoveSheet.vue`

**Interfaces:**
- Consumes: existing `MovementView` props (`speedFt`, `remainingFt`, `gridDistance`, `token`, `others`, `inCombat`).
- Produces: none (leaf component).

- [ ] **Step 1: Split `radius` into `reachRadius` + `windowRadius`**

Replace this block:

```ts
/** Reachable range in feet: the per-turn budget while in combat, else the
 *  full walk speed. */
const rangeFt = computed(() => (inCombat.value ? remainingFt.value : speedFt.value))
/** Reachable radius in cells; the grid is (2r+1)². */
const radius = computed(() => Math.floor(rangeFt.value / gridDistance.value))
const side = computed(() => radius.value * 2 + 1)
```

with:

```ts
/** Reachable range in feet: the per-turn budget while in combat, else the
 *  full walk speed. */
const rangeFt = computed(() => (inCombat.value ? remainingFt.value : speedFt.value))
/** Selectable/highlighted radius in cells — how far the player can actually
 *  move this action (remaining budget in combat, full speed otherwise). */
const reachRadius = computed(() => Math.floor(rangeFt.value / gridDistance.value))
/** Squares of greyed context shown around the full-speed reach so the player
 *  can read nearby enemies (2026-07-23). */
const WINDOW_MARGIN = 2
/** Rendered radius — full WALKING speed + margin, fixed for the whole turn: it
 *  does not shrink as budget is spent (spent squares grey out) nor grow on
 *  Dash. The grid is (2·windowRadius+1)²; squares beyond reachRadius render
 *  greyed. */
const windowRadius = computed(() => Math.floor(speedFt.value / gridDistance.value) + WINDOW_MARGIN)
const side = computed(() => windowRadius.value * 2 + 1)
```

- [ ] **Step 2: Add `reachable` to `GridCell` and compute it in `cells`**

Change the interface:

```ts
interface GridCell extends MovementCell {
  isCenter: boolean
  other?: MovementOther
  selectable: boolean
}
```

to:

```ts
interface GridCell extends MovementCell {
  isCenter: boolean
  other?: MovementOther
  reachable: boolean
  selectable: boolean
}
```

Replace the `cells` computed:

```ts
const cells = computed<GridCell[]>(() => {
  const out: GridCell[] = []
  const c = center.value
  for (let dy = -radius.value; dy <= radius.value; dy++) {
    for (let dx = -radius.value; dx <= radius.value; dx++) {
      const cx = c.cx + dx
      const cy = c.cy + dy
      const other = otherAt.value.get(`${cx},${cy}`)
      const isCenter = dx === 0 && dy === 0
      out.push({ cx, cy, isCenter, other, selectable: !isCenter && !other })
    }
  }
  return out
})
```

with:

```ts
const cells = computed<GridCell[]>(() => {
  const out: GridCell[] = []
  const c = center.value
  const wr = windowRadius.value
  const rr = reachRadius.value
  for (let dy = -wr; dy <= wr; dy++) {
    for (let dx = -wr; dx <= wr; dx++) {
      const cx = c.cx + dx
      const cy = c.cy + dy
      const other = otherAt.value.get(`${cx},${cy}`)
      const isCenter = dx === 0 && dy === 0
      const reachable = Math.max(Math.abs(dx), Math.abs(dy)) <= rr
      out.push({ cx, cy, isCenter, other, reachable, selectable: reachable && !isCenter && !other })
    }
  }
  return out
})
```

- [ ] **Step 3: Add the `out-of-range` class and aria branch**

Replace `cellClass`:

```ts
function cellClass(cell: GridCell): Record<string, boolean> {
  return {
    center: cell.isCenter,
    occupied: !!cell.other,
    selected: selected.value?.cx === cell.cx && selected.value?.cy === cell.cy,
  }
}
```

with (add the `'out-of-range'` entry):

```ts
function cellClass(cell: GridCell): Record<string, boolean> {
  return {
    center: cell.isCenter,
    occupied: !!cell.other,
    'out-of-range': !cell.reachable && !cell.isCenter,
    selected: selected.value?.cx === cell.cx && selected.value?.cy === cell.cy,
  }
}
```

Replace `cellAria`:

```ts
function cellAria(cell: GridCell): string {
  if (cell.isCenter) return 'Your position'
  if (cell.other) return `Occupied by ${cell.other.name ?? 'a creature'}`
  return `Move ${distanceOf(cell)} ${units.value}`
}
```

with (add the out-of-range branch, after the occupant check so occupied cells still name the creature):

```ts
function cellAria(cell: GridCell): string {
  if (cell.isCenter) return 'Your position'
  if (cell.other) return `Occupied by ${cell.other.name ?? 'a creature'}`
  if (!cell.reachable) return 'Out of range'
  return `Move ${distanceOf(cell)} ${units.value}`
}
```

- [ ] **Step 4: Auto-center the grid on the token when the sheet opens**

Change the import line:

```ts
import { computed, ref } from 'vue'
```

to:

```ts
import { computed, nextTick, onMounted, ref } from 'vue'
```

Add a ref + centering effect (place right after `const selected = ref<MovementCell | null>(null)`):

```ts
const gridWrap = ref<HTMLElement | null>(null)
/** Open centered on the ★ token (always the exact grid center) — the fixed-
 *  size grid can be wider/taller than the sheet, and the sheet mounts fresh on
 *  each open (2026-07-23). */
onMounted(async () => {
  await nextTick()
  const el = gridWrap.value
  if (!el) return
  el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
  el.scrollTop = (el.scrollHeight - el.clientHeight) / 2
})
```

Add the ref to the grid-wrap element in the template — change:

```html
      <div class="grid-wrap">
```

to:

```html
      <div ref="gridWrap" class="grid-wrap">
```

(The occupant-dot markup already renders for any cell with `cell.other` via the existing `v-else-if="cell.other"`, so greyed out-of-range enemies show their dot with no template change.)

- [ ] **Step 5: Make squares a fixed size and grey the out-of-range ones (CSS)**

Replace:

```css
.grid { display: grid; gap: 2px; }
.cell {
  aspect-ratio: 1;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: color-mix(in srgb, var(--gold) 10%, var(--panel-2));
  display: flex; align-items: center; justify-content: center;
  padding: 0;
}
.cell:disabled { opacity: 0.9; }
.cell.center { background: color-mix(in srgb, var(--gold) 35%, var(--panel-2)); }
.cell.occupied { background: var(--panel); }
```

with:

```css
.grid { display: grid; gap: 2px; width: max-content; --move-cell: 40px; }
.cell {
  width: var(--move-cell);
  height: var(--move-cell);
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: color-mix(in srgb, var(--gold) 10%, var(--panel-2));
  display: flex; align-items: center; justify-content: center;
  padding: 0;
}
.cell:disabled { opacity: 0.9; }
.cell.center { background: color-mix(in srgb, var(--gold) 35%, var(--panel-2)); }
.cell.occupied { background: var(--panel); }
/* Greyed context beyond reach (2026-07-23): still shows the occupant dot so
   the player can read nearby enemies; declared last so it wins the background
   over .occupied for an out-of-range occupied cell. */
.cell.out-of-range {
  background: var(--panel-2);
  border-color: color-mix(in srgb, var(--line) 60%, transparent);
  opacity: 0.5;
}
```

(`width: max-content` on `.grid` makes it size to `side × --move-cell` so the fixed grid overflows and `.grid-wrap`'s existing `overflow: auto` scrolls it; `.grid-wrap { overflow: auto; max-height: 55vh; }` is unchanged.)

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @companion/web typecheck`
Expected: PASS, no new errors (note any pre-existing ones; do not fix unrelated code).

- [ ] **Step 7: Visual smoke against the dev stack**

With a live combat, open the Move sheet on the acting PC and verify:
- Squares are a constant size and do NOT shrink when the reachable range is large; the grid scrolls and opens centered on the ★.
- Squares within the remaining budget are gold/tappable; squares beyond it are greyed and not tappable; an out-of-range enemy still shows its dot.
- Move partway, reopen: fewer squares reachable (more greyed), the window extent unchanged.
- Out of combat: the outer ~2-square ring is greyed (beyond a full move) and shows any nearby enemies.

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/components/MoveSheet.vue
git commit -m "feat(web): fixed-size movement grid with greyed surroundings

Squares keep a constant, readable size (the grid scrolls and opens centered on
the token) instead of shrinking to fit. Render a full-speed + 2-square window;
squares beyond the remaining budget are greyed and non-selectable but still show
enemy/ally dots so the player can read the battlefield.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Fixed square size + scroll → Step 5 (`--move-cell`, `width: max-content`) + existing `.grid-wrap` overflow. ✓
- Greyed non-reachable squares still showing dots → Steps 2, 3, 5 (`reachable`, `out-of-range` class + CSS; dot markup unchanged). ✓
- Window = full speed + 2-square margin, fixed for the turn → Step 1 (`windowRadius` off `speedFt`, `WINDOW_MARGIN = 2`). ✓
- Reachable = remaining budget in combat / full speed otherwise → Step 1 (`reachRadius` off `rangeFt`). ✓
- Auto-center on the token → Step 4. ✓
- Dash not special-cased → falls out of Step 1 (windowRadius ignores `dashed`/`remainingFt`). ✓
- Aria for out-of-range → Step 3. ✓
- Testing (typecheck + visual smoke) → Steps 6–7. ✓

**Placeholder scan:** none — all code shown in full.

**Type consistency:** `reachRadius`, `windowRadius`, `WINDOW_MARGIN`, `side`, `GridCell.reachable`, `--move-cell`, and the `out-of-range` class name are used identically across script, template, and CSS.
