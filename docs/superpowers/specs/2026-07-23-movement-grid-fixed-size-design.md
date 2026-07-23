# Movement grid — fixed square size with greyed surroundings — design

**Date:** 2026-07-23
**Status:** approved (brainstormed with user)

## Problem

`MoveSheet.vue` renders the reachable area as a `(2·radius+1)²` grid where
`radius = floor(range / gridDistance)`, and the squares are `1fr` with
`aspect-ratio: 1` — so they **shrink to fit the modal width**. The more range a
player has (a fast creature, or after Dash, which doubles the budget), the more
squares are packed into the same width and the tinier each becomes, making it
hard to see exactly which square you're moving to. The grid also renders *only*
the reachable squares, so an enemy just outside your reach is invisible — you
can't tell what's around you.

## Goal

Keep each square at a constant, readable, tappable size regardless of range, and
show the surrounding battlefield (including squares you can't reach) so the
player can read enemy/ally positions before committing a move.

## Scope

**Web-only, one component:** `apps/web/app/components/MoveSheet.vue`. No gateway,
API, wire-type, or mock changes — the gateway's `MovementView.others` already
includes **every visible token on the scene** (not range-filtered, verified in
`apps/gateway/src/movement.ts:87`), so greyed out-of-range squares can show
enemies with no backend change.

## Design decisions (from brainstorming)

- **Fixed square size** — squares no longer scale to fit; they are a constant
  size (a CSS var, ~40px). The grid scrolls inside the sheet when wider than the
  modal.
- **Greyed surroundings** — squares beyond reach render greyed and
  non-selectable but still show occupant dots.
- **Window extent = full walking speed + a 2-square margin, fixed for the whole
  turn** — it does not shrink as movement is spent (spent squares grey out
  instead) and does not grow for Dash.
- **Dash stays simple** — the grid doesn't grow for Dash; if the dashed reach
  runs past the shown window, the player moves once and reopens.

## Behavior

### Two radii (replace the single `radius`)

- **`windowRadius`** (what the grid renders, fixed for the turn):
  `floor(speedFt / gridDistance) + MARGIN`, `MARGIN = 2`. Based on full walking
  speed, so it is stable regardless of remaining budget or Dash. `side = windowRadius*2 + 1`.
- **`reachRadius`** (what is selectable/highlighted): `floor(rangeFt / gridDistance)`
  where `rangeFt = inCombat ? remainingFt : speedFt` (the existing `rangeFt`).

A cell's Chebyshev distance in squares from the token is
`max(|dx|, |dy|)`. A cell is **reachable** when that distance `≤ reachRadius`.

### Cells

`cells` iterates `dx,dy` over `-windowRadius..windowRadius` (was `-radius..radius`).
Each `GridCell` gains `reachable: boolean` (`max(|dx|,|dy|) <= reachRadius`).
`selectable = reachable && !isCenter && !other` (was `!isCenter && !other`).

### Styling & interaction

- New `out-of-range` class on cells where `!reachable && !isCenter`: greyed
  background, reduced opacity, no hover/press affordance. These cells remain
  `:disabled` (already the case for non-selectable cells) but **still render the
  occupant dot** (`cell.other`) so enemies/allies are visible.
- Reachable, unoccupied, non-center cells look and behave exactly as today
  (selectable, gold-tinted, tappable).
- `.grid` uses `grid-template-columns: repeat(side, var(--move-cell))` and each
  `.cell` is `width/height: var(--move-cell)` (fixed) instead of `1fr` +
  `min-width: 0`. `aspect-ratio: 1` may stay or be replaced by the explicit
  height. `--move-cell: 40px` (tunable).
- `.grid-wrap` keeps `overflow: auto; max-height: 55vh` (already scrolls both
  axes); the wider grid now scrolls horizontally too.

### Auto-center on open

On mount, after the DOM paints, scroll `.grid-wrap` so the ★ token (always at
the exact grid center) is centered:
`el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2`,
`el.scrollTop = (el.scrollHeight - el.clientHeight) / 2`. The sheet is mounted
fresh each open (`v-if` in `actor/[id].vue`), so a one-time `onMounted` +
`nextTick` centering is sufficient.

### Aria

`cellAria` gains an out-of-range branch: an unreachable empty cell reads
"Out of range"; an unreachable occupied cell keeps "Occupied by …". Reachable
cells are unchanged ("Move N ft" / "Your position" / "Occupied by …").

## Edge cases

- **Budget spent to 0** (in combat): `reachRadius = 0` → only the center is
  reachable; the whole window greys out. Center is the player (not selectable),
  so no bad state.
- **Dashed** (`remainingFt = 2·speed`): `reachRadius > windowRadius` → every
  shown square is reachable (nothing greyed); the extra dash reach beyond the
  window isn't shown — move once and reopen, as designed.
- **Out of combat**: `rangeFt = speedFt` → `reachRadius = speedRadius`, so the
  2-square margin ring is greyed and shows any enemies just past a full move.
- **speedFt 0 / tiny**: `windowRadius = MARGIN` → a small 5×5 grid; center
  reachable, ring greyed. No crash.

## Testing

- `pnpm --filter @companion/web typecheck` (the web app has no unit runner).
- Visual smoke against the dev stack with a live combat:
  - Squares are a constant size and do not shrink with a large range; the grid
    scrolls and opens centered on the ★.
  - Squares within the remaining budget are gold/tappable; squares beyond it are
    greyed and not tappable; an out-of-range enemy still shows its dot.
  - Move partway → reopen: fewer squares reachable (more greyed), window extent
    unchanged.
