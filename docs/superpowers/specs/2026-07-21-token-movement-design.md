# Token movement v1 ("Move sheet") — design

Date: 2026-07-21 · Status: approved by user (chat) · Systems: dnd5e only

## Problem

Players cannot move their character tokens from the companion app; only the GM
can drag tokens in Foundry. Players sit at the table with the battlemap on a
shared screen — the phone is the input device, not the map display. They need
a way to say "move me 3 squares up-left" without handing the GM instructions
verbally every turn.

## Sanity check (verified against the relay module on disk)

The ThreeHats foundry-rest-api module (3.4.1, grepped in
`stack/foundry-data/Data/modules/foundry-rest-api/scripts/module.js`) exposes
everything v1 needs; none of it is wrapped in `foundry-client` yet:

| Need | Relay action | Verified behavior |
|---|---|---|
| Move the token | `move-token` | Accepts `x,y` (canvas px), optional `waypoints[]`, `animate`. Does a raw `token.update()` per waypoint — **no wall collision checking**. Asserts **GM** (our relay key is GM, so Foundry enforces nothing per-player). |
| Grid geometry | `get-scene` | Returns grid size (px) and distance-per-square + units. |
| Other tokens | `get-canvas-documents` (`documentType: "tokens"`) | All token positions incl. `hidden` flag and `disposition`. |
| Walls/doors (v2) | `get-canvas-documents` (`walls`) | Wall segments incl. door state. |
| Grid distance (if needed) | `measure-distance` | Foundry's own ruler rules. |

Consequences baked into this design:
- **Ownership must be enforced in the gateway** — Foundry sees every relay
  move as a GM move.
- Wall-aware reachability would be **our own geometry**, not Foundry's — hence
  deferred to v2.
- Traps are Foundry-side (Regions, GM-placed); whether they trigger on a
  scripted `token.update()` needs a live test someday, but it is not our code.

## Approved decisions

- **v1 = bare movement** (approach A): reachable cells by distance only, no
  wall awareness. Structured so v2's wall geometry drops in behind the same UI.
- **Abstract relative grid**, no map imagery — players see the real map on the
  shared screen. Map-image underlay (`scene-raw-image`) deferred to v2/3.
- **Other tokens shown on the grid** (positions + disposition color); hidden
  tokens stripped server-side.
- **Tap → confirm** interaction (not drag-release): tap a reachable cell,
  see the distance, press an explicit Move button.
- **Toolbar entry point** (next to roll history), not a tab and not gated on a
  running encounter — movement happens during exploration too.
- **Movement budget per turn** (ft used, reset on round change; manual
  "next round" fallback button) is a priority for the end product but **not
  v1** — v1 shows full speed every time the sheet opens.

## Entry point (web)

A Move icon button in the actor-page top toolbar (`apps/web/app/pages/actor/[id].vue`,
next to the roll-history button). Visible only when the gateway reports the
actor has a token on the **active scene** with a **square grid** (gridless and
hex scenes: button hidden — out of scope for v1). The page calls
`GET /movement/:actorId` once on load to decide visibility; the sheet reuses
the same endpoint for fresh data when opened. Tapping opens
`MoveSheet.vue`, a full-screen bottom-sheet following the `ActionSheet`
pattern.

## Gateway API (new)

Both endpoints enforce that the actor belongs to the requesting player's
pairing (player-store), because Foundry will not.

### `GET /movement/:actorId`

Composed from relay `get-scene` + `get-canvas-documents(tokens)` + the actor's
walk speed (dnd5e `system.attributes.movement.walk`).

```
{
  onScene: boolean,          // false → PWA hides the toolbar button
  sceneId: string,
  gridDistance: number,      // e.g. 5
  gridUnits: string,         // e.g. "ft"
  speedFt: number,           // walk speed
  token: { cx, cy },         // the actor's token, in grid-cell coords
  others: [{ cx, cy, disposition, name? }]
}
```

- Pixel coords are converted to **grid cell coords server-side**; the phone
  never sees canvas pixels.
- **Hidden tokens are stripped in the gateway** — they never reach the phone
  (no invisible-ambusher leaks).
- Non-square grid or no token on the active scene → `onScene: false`.

### `POST /movement/:actorId` — body `{ cx, cy }`

Validation order: actor owned by this player → target cell within speed
radius (**Chebyshev distance / 5-5-5 diagonals**, the dnd5e default) → cell
not occupied. Converts cell → pixels, calls relay `move-token` with
`animate: true` and no waypoints (straight line). Returns the confirmed new
position.

All relay calls get bounded timeouts (relay-stall pattern, as in M18
`adminNameTimeoutMs`).

**Multiple tokens per actor:** v1 moves the first token found (mirrors relay
`move-token` actor-uuid resolution). Player characters almost always have
exactly one; pets/companions are v2.

## foundry-client (new wrappers)

`getScene()`, `getCanvasDocuments(type)`, `moveToken()` — thin typed wrappers
over the three relay actions in `packages/foundry-client/src/index.ts`,
matching existing wrapper style and error normalization.

## Move sheet UI

- Grid centered on the player's token; radius =
  `floor(speedFt / gridDistance)` cells (30 ft → 6). Reachable cells tinted;
  center marked with the character.
- Other tokens as dots: green (friendly), grey (neutral), red (hostile).
  Occupied cells are not selectable.
- Tap a cell → highlight + distance label ("15 ft") → **Move** button
  (flush-right, yellow primary per the action-button convention) fires the
  POST.
- After a confirmed move the grid re-centers via a fresh GET. Manual refresh
  button; no live push in v1.
- Errors (relay timeout, scene changed, cell occupied meanwhile) → toast +
  grid refresh.

## Testing

- Unit tests: grid math (radius, Chebyshev distance, px↔cell conversion both
  directions) and gateway validation (ownership, out-of-range, occupied cell,
  hidden-token stripping, non-square-grid → `onScene: false`) against fixture
  relay responses.
- Live verification on the stack per repo convention (VERSIONS.md /
  docs findings): move a real token on a real scene, confirm animation and
  final position in Foundry.

## Explicitly deferred

- **v1.x (priority):** movement budget per turn — ft used this round, reset on
  encounter round change, manual "next round" fallback button.
- **v2:** wall/door-aware reachable cells (flood-fill over wall segments from
  `get-canvas-documents(walls)`); drag-a-path interaction sending
  `waypoints[]`; pet/companion token movement for pet classes.
- **v2/3:** map-image underlay via `scene-raw-image` / `scene-screenshot`
  (weight + fog/visibility concerns).
- **Someday:** "thieves' tools on a door" (door state is writable via
  `update-canvas-document`, but the skill-check flow is its own feature);
  traps remain Foundry/GM-side (Regions).
- **UI debt:** burger menu when the toolbar overflows.
