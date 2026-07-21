# Token Movement v1 ("Move sheet") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Players move their own token on the active Foundry scene from the PWA: a toolbar button opens a Move sheet showing a relative grid of reachable cells (speed-based, other tokens plotted), tap a cell → confirm → token animates in Foundry.

**Architecture:** Three new relay wrappers in `foundry-client` (`getScene`, `getCanvasDocuments`, `moveToken`) → two new gateway endpoints (`GET`/`POST /api/actors/:id/movement`) that compose scene + tokens + actor speed into a cell-based `MovementView` and validate moves (ownership, range, occupancy) → a `MoveSheet.vue` bottom-sheet in the web app. All grid math and validation live in a pure gateway module (`movement.ts`) for easy testing.

**Tech Stack:** TypeScript, Fastify 5 (gateway), vitest (foundry-client + gateway), Nuxt 4 / Vue 3.5 (web, typecheck only — no web unit tests exist), ThreeHats foundry-rest-api relay 3.4.1.

**Spec:** `docs/superpowers/specs/2026-07-21-token-movement-design.md`. One deliberate deviation: the spec wrote `GET/POST /movement/:actorId`; every existing route is namespaced `/api/...` and actor-scoped routes are `/api/actors/:id/...`, so the endpoints are **`GET /api/actors/:id/movement`** and **`POST /api/actors/:id/movement`**.

## Global Constraints

- dnd5e only; **square grids only** (Foundry `grid.type === 1`); gridless/hex → `onScene: false`.
- Ownership check on every route: `if (!player.actorIds.includes(id)) return sendError(reply, 404, 'NOT_FOUND', 'actor not found')` — **404, never 403** (do not leak actor existence).
- Error bodies always `{ error: { code, message } }` via the existing `sendError` helper; codes from the existing `ErrorCode` union only.
- **Every relay await is bounded** by `Promise.race` against a `movementTimeoutMs` sentinel (new `GatewayDeps` field, default `3_000`) — the M18 pattern (`app.ts:719-722`).
- **Hidden tokens (`hidden === true`) never leave the gateway** — stripped from `others` AND excluded from occupancy checks (blocking on a hidden token would leak its presence).
- The phone never sees canvas pixels — the gateway converts px ↔ grid cells; the wire uses cell coords (`cx`, `cy`).
- Distance rule: **Chebyshev** (`max(|dx|,|dy|)`), the dnd5e default 5-5-5 diagonal.
- Relay wire facts (verified in the module bundle): HTTP path = actionType; `GET /get-scene` with `active=true` returns `{ data: Scene.toObject(true) }` incl. `grid.{type,size,distance,units}`; `GET /get-canvas-documents?documentType=tokens` returns `{ data: TokenDocument.toObject()[] }` (top-level `x,y,width,height,hidden,disposition,actorId,name,_id`, px are token top-left); `POST /move-token` body `{ uuid, x, y, animate }` (animate defaults true), success `{ data: { tokenUuid, name, x, y, sceneId } }`, failures may arrive as `{ error }` in a 200.
- Work on branch `feat/token-movement` in the main checkout (live stack — no worktree).
- TDD: failing test → run → implement → run → commit. Conventional commits, end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/foundry-client/src/index.ts` (modify) | `RelayScene`/`RelayCanvasToken` types + 3 relay wrappers |
| `packages/foundry-client/test/client.test.ts` (modify) | wrapper unit tests (mocked fetch) |
| `apps/gateway/src/movement.ts` (create) | pure grid math: view building, occupancy, validation, walk speed |
| `apps/gateway/test/movement.test.ts` (create) | pure-module tests |
| `apps/gateway/src/app.ts` (modify) | `RelayPort` additions, `movementTimeoutMs` dep, GET+POST routes |
| `apps/gateway/test/fakes.ts` (modify) | `FakeRelay` additions (scene/tokens/move + hang flags) |
| `apps/gateway/test/app.test.ts` (modify) | route tests |
| `docs/API.md` (modify) | document the two endpoints |
| `apps/web/app/types/api.ts` (modify) | `MovementView`/`MovementResponse` types |
| `apps/web/app/components/MoveSheet.vue` (create) | the movement grid bottom-sheet |
| `apps/web/app/pages/actor/[id].vue` (modify) | toolbar button, fetch/POST wiring, sheet mount |

---

### Task 1: foundry-client relay wrappers

**Files:**
- Modify: `packages/foundry-client/src/index.ts`
- Test: `packages/foundry-client/test/client.test.ts`

**Interfaces:**
- Consumes: existing `private request<T>(method, path, params, body)` (`index.ts:186`) and `RelayError` (`index.ts:51`).
- Produces (used by Tasks 2–4):
  - `export interface RelayScene { _id: string; name?: string; grid?: { type?: number; size?: number; distance?: number; units?: string }; [key: string]: unknown }`
  - `export interface RelayCanvasToken { _id: string; name?: string; x: number; y: number; width?: number; height?: number; hidden?: boolean; disposition?: number; actorId?: string | null; [key: string]: unknown }`
  - `getScene(): Promise<RelayScene | null>` — the **active** scene, `null` when none.
  - `getCanvasDocuments<T = Record<string, unknown>>(documentType: string, sceneId?: string): Promise<T[]>`
  - `moveToken(tokenUuid: string, x: number, y: number): Promise<void>` — always `animate: true`.

- [ ] **Step 0: Create the branch**

```bash
git checkout -b feat/token-movement
```

- [ ] **Step 1: Write the failing tests**

Append to `packages/foundry-client/test/client.test.ts` (reuse the existing `mockFetch` module setup; import the new types from `../src/index.js`):

```ts
describe('FoundryRelayClient movement wrappers', () => {
  let client: FoundryRelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FoundryRelayClient({
      baseUrl: 'http://relay:3010',
      apiKey: 'test-api-key',
      clientId: 'fvtt_test123',
    });
  });

  it('getScene() GETs /get-scene with active=true and returns data', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, text: vi.fn(),
      json: vi.fn().mockResolvedValueOnce({
        type: 'get-scene-result', requestId: 'r1',
        data: { _id: 's1', name: 'Crypt', grid: { type: 1, size: 100, distance: 5, units: 'ft' } },
      }),
    });
    const scene = await client.getScene();
    const [url, init] = mockFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toContain('/get-scene');
    expect(url).toContain('active=true');
    expect((init.method as string)).toBe('GET');
    expect(scene?.grid?.size).toBe(100);
  });

  it('getScene() returns null on relay error-in-200 (no active scene)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, text: vi.fn(),
      json: vi.fn().mockResolvedValueOnce({ type: 'get-scene-result', requestId: 'r1', error: 'Scene not found', data: null }),
    });
    expect(await client.getScene()).toBeNull();
  });

  it('getCanvasDocuments() GETs /get-canvas-documents with documentType and sceneId', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, text: vi.fn(),
      json: vi.fn().mockResolvedValueOnce({
        type: 'get-canvas-documents-result', requestId: 'r2', sceneId: 's1', documentType: 'tokens',
        data: [{ _id: 't1', x: 300, y: 200, hidden: false }],
      }),
    });
    const docs = await client.getCanvasDocuments('tokens', 's1');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('/get-canvas-documents');
    expect(url).toContain('documentType=tokens');
    expect(url).toContain('sceneId=s1');
    expect(docs).toHaveLength(1);
  });

  it('getCanvasDocuments() throws RelayError on error-in-200', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, text: vi.fn(),
      json: vi.fn().mockResolvedValueOnce({ type: 'get-canvas-documents-result', requestId: 'r2', error: 'No active scene', data: null }),
    });
    await expect(client.getCanvasDocuments('tokens')).rejects.toThrow('No active scene');
  });

  it('moveToken() POSTs /move-token with uuid, px coords, animate true', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, text: vi.fn(),
      json: vi.fn().mockResolvedValueOnce({
        type: 'move-token-result', requestId: 'r3',
        data: { tokenUuid: 'Scene.s1.Token.t1', name: 'Sariel', x: 500, y: 100, sceneId: 's1' },
      }),
    });
    await client.moveToken('Scene.s1.Token.t1', 500, 100);
    const [url, init] = mockFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toContain('/move-token');
    expect((init.method as string)).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ uuid: 'Scene.s1.Token.t1', x: 500, y: 100, animate: true });
  });

  it('moveToken() throws RelayError on error-in-200', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, text: vi.fn(),
      json: vi.fn().mockResolvedValueOnce({ type: 'move-token-result', requestId: 'r3', error: 'Token not found: X' }),
    });
    await expect(client.moveToken('Scene.s1.Token.tX', 0, 0)).rejects.toThrow('Token not found');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @companion/foundry-client test`
Expected: FAIL — `client.getScene is not a function` (and siblings).

- [ ] **Step 3: Implement types + wrappers**

In `packages/foundry-client/src/index.ts`, add the two interfaces near the other exported relay types (e.g. next to `RelayEncounter`):

```ts
/** Scene document subset from GET /get-scene (relay returns Scene.toObject(true)). */
export interface RelayScene {
  _id: string;
  name?: string;
  /** Foundry v13 nests grid config: type 1 = square; size = px per cell. */
  grid?: { type?: number; size?: number; distance?: number; units?: string };
  [key: string]: unknown;
}

/** TokenDocument.toObject() subset from GET /get-canvas-documents (documentType "tokens").
 *  x/y are canvas px of the token's TOP-LEFT corner; width/height are in grid squares. */
export interface RelayCanvasToken {
  _id: string;
  name?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  hidden?: boolean;
  /** -1 hostile, 0 neutral, 1 friendly, -2 secret. */
  disposition?: number;
  actorId?: string | null;
  [key: string]: unknown;
}
```

Add the three methods next to the other GET wrappers (near `getEncounters`, ~line 305), mimicking their style:

```ts
/** GET /get-scene — the currently ACTIVE scene, or null when there is none.
 *  The relay reports "no active scene" as an error-in-200; that maps to null
 *  (callers treat it as "movement unavailable", not a failure). */
async getScene(): Promise<RelayScene | null> {
  const body = await this.request<{ data?: RelayScene | null; error?: string }>('GET', '/get-scene', { active: true });
  if (typeof body.error === 'string' && body.error !== '') return null;
  return body.data ?? null;
}

/** GET /get-canvas-documents — placeable documents of one type on a scene
 *  (active scene when sceneId is omitted). Raw toObject() docs. */
async getCanvasDocuments<T = Record<string, unknown>>(documentType: string, sceneId?: string): Promise<T[]> {
  const body = await this.request<{ data?: T[] | null; error?: string }>(
    'GET', '/get-canvas-documents', { documentType, sceneId },
  );
  if (typeof body.error === 'string' && body.error !== '') {
    throw new RelayError(`relay /get-canvas-documents: ${body.error}`, 200, '/get-canvas-documents');
  }
  return Array.isArray(body.data) ? body.data : [];
}

/** POST /move-token — reposition a token (canvas px, top-left), always animated.
 *  tokenUuid form: `Scene.<sceneId>.Token.<tokenId>`. */
async moveToken(tokenUuid: string, x: number, y: number): Promise<void> {
  const body = await this.request<{ data?: unknown; error?: string }>(
    'POST', '/move-token', {}, { uuid: tokenUuid, x, y, animate: true },
  );
  if (typeof body.error === 'string' && body.error !== '') {
    throw new RelayError(`relay /move-token: ${body.error}`, 200, '/move-token');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @companion/foundry-client test`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add packages/foundry-client/src/index.ts packages/foundry-client/test/client.test.ts
git commit -m "feat(foundry-client): getScene/getCanvasDocuments/moveToken relay wrappers"
```

---

### Task 2: gateway movement module (pure grid math)

**Files:**
- Create: `apps/gateway/src/movement.ts`
- Test: `apps/gateway/test/movement.test.ts`

**Interfaces:**
- Consumes: `RelayScene`, `RelayCanvasToken` from `@companion/foundry-client` (Task 1).
- Produces (used by Tasks 3–4):
  - `export interface MovementCell { cx: number; cy: number }`
  - `export interface MovementOther extends MovementCell { disposition: number; name?: string }`
  - `export interface MovementView { onScene: boolean; sceneId?: string; gridDistance?: number; gridUnits?: string; speedFt?: number; token?: MovementCell; others?: MovementOther[] }`
  - `export interface MovementContext { view: MovementView; own?: RelayCanvasToken; gridSize?: number }`
  - `export function walkSpeedOf(doc: { system?: unknown } | null): number`
  - `export function chebyshev(a: MovementCell, b: MovementCell): number`
  - `export function buildMovementContext(scene: RelayScene | null, tokens: RelayCanvasToken[], actorId: string, speedFt: number): MovementContext`
  - `export function occupiedCells(tokens: RelayCanvasToken[], gridSize: number, excludeTokenId?: string): Set<string>` — keys `"cx,cy"`, **skips hidden tokens**.
  - `export function validateMove(view: MovementView, target: MovementCell, occupied: Set<string>): MoveValidation` where `export type MoveValidation = { ok: true } | { ok: false; status: 409 | 422; code: 'CONFLICT' | 'INVALID_INTENT'; message: string }`

- [ ] **Step 1: Write the failing tests**

Create `apps/gateway/test/movement.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RelayCanvasToken, RelayScene } from '@companion/foundry-client';
import {
  buildMovementContext, chebyshev, occupiedCells, validateMove, walkSpeedOf,
} from '../src/movement.js';

const scene = (grid: RelayScene['grid']): RelayScene => ({ _id: 's1', name: 'Crypt', grid });
const squareScene = (): RelayScene => scene({ type: 1, size: 100, distance: 5, units: 'ft' });
const tok = (id: string, actorId: string | null, x: number, y: number, extra: Partial<RelayCanvasToken> = {}): RelayCanvasToken =>
  ({ _id: id, name: `tok-${id}`, x, y, width: 1, height: 1, hidden: false, disposition: 0, actorId, ...extra });

describe('walkSpeedOf', () => {
  it('reads system.attributes.movement.walk', () => {
    expect(walkSpeedOf({ system: { attributes: { movement: { walk: 30 } } } })).toBe(30);
  });
  it('returns 0 for missing/invalid speed', () => {
    expect(walkSpeedOf(null)).toBe(0);
    expect(walkSpeedOf({ system: {} })).toBe(0);
    expect(walkSpeedOf({ system: { attributes: { movement: { walk: 'fast' } } } })).toBe(0);
  });
});

describe('chebyshev', () => {
  it('is max of axis deltas (5-5-5 diagonals)', () => {
    expect(chebyshev({ cx: 0, cy: 0 }, { cx: 3, cy: -2 })).toBe(3);
    expect(chebyshev({ cx: 5, cy: 5 }, { cx: 5, cy: 5 })).toBe(0);
  });
});

describe('buildMovementContext', () => {
  it('builds the full view: cells from px, others filtered and mapped', () => {
    const tokens = [
      tok('t1', 'a1', 300, 200),
      tok('t2', 'm1', 500, 200, { disposition: -1 }),
      tok('t3', 'm2', 700, 200, { hidden: true }),   // GM-hidden: stripped
    ];
    const { view, own, gridSize } = buildMovementContext(squareScene(), tokens, 'a1', 30);
    expect(view).toEqual({
      onScene: true, sceneId: 's1', gridDistance: 5, gridUnits: 'ft', speedFt: 30,
      token: { cx: 3, cy: 2 },
      others: [{ cx: 5, cy: 2, disposition: -1, name: 'tok-t2' }],
    });
    expect(own?._id).toBe('t1');
    expect(gridSize).toBe(100);
  });

  it('onScene false when no scene, non-square grid, or no token for the actor', () => {
    expect(buildMovementContext(null, [], 'a1', 30).view).toEqual({ onScene: false });
    expect(buildMovementContext(scene({ type: 0, size: 100, distance: 5 }), [tok('t1', 'a1', 0, 0)], 'a1', 30).view)
      .toEqual({ onScene: false });
    expect(buildMovementContext(squareScene(), [tok('t2', 'someone-else', 0, 0)], 'a1', 30).view)
      .toEqual({ onScene: false });
  });

  it('defaults gridDistance 5 / units ft when scene omits them', () => {
    const { view } = buildMovementContext(scene({ type: 1, size: 100 }), [tok('t1', 'a1', 0, 0)], 'a1', 30);
    expect(view.gridDistance).toBe(5);
    expect(view.gridUnits).toBe('ft');
  });
});

describe('occupiedCells', () => {
  it('marks all cells of multi-square tokens, excludes self and hidden', () => {
    const tokens = [
      tok('t1', 'a1', 300, 200),                                  // self — excluded
      tok('t2', 'm1', 500, 200, { width: 2, height: 2 }),          // large: 4 cells
      tok('t3', 'm2', 100, 100, { hidden: true }),                 // hidden: no leak
    ];
    const occ = occupiedCells(tokens, 100, 't1');
    expect(occ.has('3,2')).toBe(false);   // self
    expect(occ.has('5,2')).toBe(true);    // large token cells
    expect(occ.has('6,3')).toBe(true);
    expect(occ.has('1,1')).toBe(false);   // hidden
  });
});

describe('validateMove', () => {
  const view = buildMovementContext(squareScene(), [tok('t1', 'a1', 300, 200)], 'a1', 30).view;
  it('accepts an in-range free cell', () => {
    expect(validateMove(view, { cx: 6, cy: 4 }, new Set())).toEqual({ ok: true });  // chebyshev 3 ≤ 6
  });
  it('rejects out of range with 422', () => {
    const v = validateMove(view, { cx: 10, cy: 2 }, new Set());                     // chebyshev 7 > 6
    expect(v).toMatchObject({ ok: false, status: 422, code: 'INVALID_INTENT' });
  });
  it('rejects the current cell with 422', () => {
    expect(validateMove(view, { cx: 3, cy: 2 }, new Set())).toMatchObject({ ok: false, status: 422 });
  });
  it('rejects an occupied cell with 409', () => {
    const v = validateMove(view, { cx: 4, cy: 2 }, new Set(['4,2']));
    expect(v).toMatchObject({ ok: false, status: 409, code: 'CONFLICT' });
  });
  it('rejects when not on scene with 409', () => {
    expect(validateMove({ onScene: false }, { cx: 1, cy: 1 }, new Set())).toMatchObject({ ok: false, status: 409 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @companion/gateway test -- movement`
Expected: FAIL — cannot resolve `../src/movement.js`.

- [ ] **Step 3: Implement the module**

Create `apps/gateway/src/movement.ts`:

```ts
/**
 * Pure grid math for token movement (spec:
 * docs/superpowers/specs/2026-07-21-token-movement-design.md).
 *
 * Everything here is relay-shape → wire-shape conversion and validation; no
 * I/O. The phone only ever sees grid CELL coordinates (cx/cy) — px↔cell
 * conversion happens here. Hidden tokens are stripped from the view AND from
 * occupancy (blocking on a hidden token would leak its presence).
 */
import type { RelayCanvasToken, RelayScene } from '@companion/foundry-client';

export interface MovementCell { cx: number; cy: number }
export interface MovementOther extends MovementCell { disposition: number; name?: string }

export interface MovementView {
  onScene: boolean;
  sceneId?: string;
  gridDistance?: number;
  gridUnits?: string;
  speedFt?: number;
  token?: MovementCell;
  others?: MovementOther[];
}

export interface MovementContext {
  view: MovementView;
  /** The actor's own token doc — POST needs its _id for the move uuid. */
  own?: RelayCanvasToken;
  /** Grid cell size in px — POST needs it for cell→px conversion. */
  gridSize?: number;
}

/** Foundry CONST.GRID_TYPES.SQUARE. */
const SQUARE_GRID = 1;

/** dnd5e walk speed off a raw actor doc; 0 when absent/invalid. */
export function walkSpeedOf(doc: { system?: unknown } | null): number {
  const attrs = (doc?.system as { attributes?: { movement?: { walk?: unknown } } } | undefined)?.attributes;
  const walk = attrs?.movement?.walk;
  return typeof walk === 'number' && Number.isFinite(walk) && walk > 0 ? walk : 0;
}

/** Chebyshev distance — dnd5e's default 5-5-5 diagonal rule. */
export function chebyshev(a: MovementCell, b: MovementCell): number {
  return Math.max(Math.abs(a.cx - b.cx), Math.abs(a.cy - b.cy));
}

function cellOf(t: RelayCanvasToken, gridSize: number): MovementCell {
  return { cx: Math.round(t.x / gridSize), cy: Math.round(t.y / gridSize) };
}

export function buildMovementContext(
  scene: RelayScene | null,
  tokens: RelayCanvasToken[],
  actorId: string,
  speedFt: number,
): MovementContext {
  const grid = scene?.grid;
  const gridSize = typeof grid?.size === 'number' && grid.size > 0 ? grid.size : 0;
  if (!scene || grid?.type !== SQUARE_GRID || gridSize === 0) return { view: { onScene: false } };
  const own = tokens.find((t) => t.actorId === actorId);
  if (!own) return { view: { onScene: false } };

  const others: MovementOther[] = tokens
    .filter((t) => t._id !== own._id && t.hidden !== true)
    .map((t) => ({
      ...cellOf(t, gridSize),
      disposition: typeof t.disposition === 'number' ? t.disposition : 0,
      ...(typeof t.name === 'string' && t.name !== '' ? { name: t.name } : {}),
    }));

  return {
    own,
    gridSize,
    view: {
      onScene: true,
      sceneId: scene._id,
      gridDistance: typeof grid.distance === 'number' && grid.distance > 0 ? grid.distance : 5,
      gridUnits: typeof grid.units === 'string' && grid.units !== '' ? grid.units : 'ft',
      speedFt,
      token: cellOf(own, gridSize),
      others,
    },
  };
}

/** Cells covered by visible tokens (multi-square aware), keyed "cx,cy". */
export function occupiedCells(tokens: RelayCanvasToken[], gridSize: number, excludeTokenId?: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    if (t._id === excludeTokenId || t.hidden === true) continue;
    const { cx, cy } = cellOf(t, gridSize);
    const w = Math.max(1, Math.ceil(typeof t.width === 'number' ? t.width : 1));
    const h = Math.max(1, Math.ceil(typeof t.height === 'number' ? t.height : 1));
    for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) out.add(`${cx + dx},${cy + dy}`);
  }
  return out;
}

export type MoveValidation =
  | { ok: true }
  | { ok: false; status: 409 | 422; code: 'CONFLICT' | 'INVALID_INTENT'; message: string };

export function validateMove(view: MovementView, target: MovementCell, occupied: Set<string>): MoveValidation {
  if (!view.onScene || !view.token || view.gridDistance === undefined || view.speedFt === undefined) {
    return { ok: false, status: 409, code: 'CONFLICT', message: 'no token on the active scene' };
  }
  const radius = Math.floor(view.speedFt / view.gridDistance);
  const dist = chebyshev(view.token, target);
  if (dist === 0) return { ok: false, status: 422, code: 'INVALID_INTENT', message: 'already on that cell' };
  if (dist > radius) return { ok: false, status: 422, code: 'INVALID_INTENT', message: 'destination out of range' };
  if (occupied.has(`${target.cx},${target.cy}`)) {
    return { ok: false, status: 409, code: 'CONFLICT', message: 'destination occupied' };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @companion/gateway test -- movement`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/movement.ts apps/gateway/test/movement.test.ts
git commit -m "feat(gateway): pure movement grid math (view, occupancy, validation)"
```

---

### Task 3: gateway GET /api/actors/:id/movement

**Files:**
- Modify: `apps/gateway/src/app.ts` (RelayPort ~line 55-126, deps defaults ~507-510, route after the sheet route ~line 936ff)
- Modify: `apps/gateway/test/fakes.ts` (FakeRelay)
- Test: `apps/gateway/test/app.test.ts`
- Modify: `docs/API.md`

**Interfaces:**
- Consumes: Task 1 wrapper signatures (via `RelayPort`), Task 2 `buildMovementContext`/`walkSpeedOf`, existing `auth`, `sendError`, `Player`.
- Produces:
  - `RelayPort` gains: `getScene(): Promise<RelayScene | null>`, `getCanvasDocuments<T = Record<string, unknown>>(documentType: string, sceneId?: string): Promise<T[]>`, `moveToken(tokenUuid: string, x: number, y: number): Promise<void>` (moveToken is used by Task 4 but declared here in one edit).
  - `GatewayDeps` gains `movementTimeoutMs?: number` (default `3_000`).
  - `GET /api/actors/:id/movement` → 200 `{ movement: MovementView }` | 404 | 502.
  - `FakeRelay` gains: `scene: RelayScene | null`, `canvasTokens: RelayCanvasToken[]`, `moveTokenCalls: Array<{ tokenUuid: string; x: number; y: number }>`, hang flags `hangScene`/`hangCanvas`/`hangMove`, `moveError: string | null`.

Behavior decisions (locked): no active scene OR relay-stall on `getScene` → 200 `{ movement: { onScene: false } }` (button hides, degrades gracefully); actor doc or tokens fetch failing/hanging **after** a scene resolved → 502 UPSTREAM.

- [ ] **Step 1: Extend FakeRelay**

In `apps/gateway/test/fakes.ts`, import the types and add to `FakeRelay`:

```ts
import type { RelayCanvasToken, RelayScene } from '@companion/foundry-client';

// inside FakeRelay:
scene: RelayScene | null = null;
canvasTokens: RelayCanvasToken[] = [];
moveTokenCalls: Array<{ tokenUuid: string; x: number; y: number }> = [];
hangScene = false;
hangCanvas = false;
hangMove = false;
moveError: string | null = null;

async getScene(): Promise<RelayScene | null> {
  if (this.hangScene) return new Promise<never>(() => {});
  return this.scene;
}

async getCanvasDocuments<T = Record<string, unknown>>(documentType: string, sceneId?: string): Promise<T[]> {
  if (this.hangCanvas) return new Promise<never>(() => {});
  if (documentType !== 'tokens') return [];
  void sceneId;
  return this.canvasTokens as unknown as T[];
}

async moveToken(tokenUuid: string, x: number, y: number): Promise<void> {
  if (this.hangMove) return new Promise<never>(() => {});
  if (this.moveError) throw new Error(this.moveError);
  this.moveTokenCalls.push({ tokenUuid, x, y });
}
```

- [ ] **Step 2: Write the failing route tests**

In `apps/gateway/test/app.test.ts`, add a describe block. Reuse the existing `setup()`, token headers (`asAnna` etc.), and fixture ids (`a1` is Anna's, `b1` foreign). Local fixtures:

```ts
describe('GET /api/actors/:id/movement', () => {
  const squareScene = () => ({ _id: 's1', name: 'Crypt', grid: { type: 1, size: 100, distance: 5, units: 'ft' } });
  const tok = (id: string, actorId: string | null, x: number, y: number, extra: Record<string, unknown> = {}) =>
    ({ _id: id, name: `tok-${id}`, x, y, width: 1, height: 1, hidden: false, disposition: 0, actorId, ...extra });

  /** Anna's a1 with a 30ft walk speed merged into the fixture doc. */
  function withSpeed(relay: FakeRelay, actorId: string, walk: number): void {
    const doc = relay.entities.get(`Actor.${actorId}`) as { system?: Record<string, unknown> };
    const system = { ...(doc.system ?? {}) } as Record<string, unknown>;
    system.attributes = { ...((system.attributes as Record<string, unknown>) ?? {}), movement: { walk } };
    relay.entities.set(`Actor.${actorId}`, { ...doc, system });
  }

  it('404s (not 403) on a foreign actor', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/actors/b1/movement', headers: asAnna });
    expect(res.statusCode).toBe(404);
  });

  it('returns onScene:false when there is no active scene', async () => {
    const { relay } = setupRefs; // however setup() exposes the relay in this file
    relay.scene = null;
    const res = await app.inject({ method: 'GET', url: '/api/actors/a1/movement', headers: asAnna });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ movement: { onScene: false } });
  });

  it('returns onScene:false on a relay stall fetching the scene (bounded)', async () => {
    const { relay } = setupRefs;
    relay.hangScene = true;
    const res = await app.inject({ method: 'GET', url: '/api/actors/a1/movement', headers: asAnna });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ movement: { onScene: false } });
  });

  it('returns the full view: cells, speed, visible others; hidden stripped', async () => {
    const { relay } = setupRefs;
    withSpeed(relay, 'a1', 30);
    relay.scene = squareScene();
    relay.canvasTokens = [
      tok('t1', 'a1', 300, 200),
      tok('t2', 'm1', 500, 200, { disposition: -1 }),
      tok('t3', 'm2', 700, 200, { hidden: true }),
    ];
    const res = await app.inject({ method: 'GET', url: '/api/actors/a1/movement', headers: asAnna });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      movement: {
        onScene: true, sceneId: 's1', gridDistance: 5, gridUnits: 'ft', speedFt: 30,
        token: { cx: 3, cy: 2 },
        others: [{ cx: 5, cy: 2, disposition: -1, name: 'tok-t2' }],
      },
    });
  });

  it('502s when the canvas-token fetch hangs after a scene resolved', async () => {
    const { relay } = setupRefs;
    relay.scene = squareScene();
    relay.hangCanvas = true;
    const res = await app.inject({ method: 'GET', url: '/api/actors/a1/movement', headers: asAnna });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('UPSTREAM');
  });
});
```

Note: `setupRefs` above is shorthand — use whatever mechanism this test file already uses to hold the `relay` returned by `setup()` (the explorer report shows `setup()` returns `{ app, relay }`; most blocks destructure it in `beforeEach`). Use a **short `movementTimeoutMs`** (e.g. `50`) in the `setup()` overrides for this block so hang tests don't wait 3s — mirror how existing timeout tests configure `encounterFetchTimeoutMs`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @companion/gateway test -- app`
Expected: FAIL — 404 route-not-found on `/api/actors/a1/movement` (and FakeRelay type errors until Step 1 compiles — do Step 1 first).

- [ ] **Step 4: Implement RelayPort + deps + route**

In `apps/gateway/src/app.ts`:

1. Import from `@companion/foundry-client`: add `RelayScene`, `RelayCanvasToken` to the existing type imports.
2. Import from `./movement.js`: `buildMovementContext, occupiedCells, validateMove, walkSpeedOf` (occupied/validate used in Task 4; import once).
3. Add to `RelayPort`:

```ts
/** Active scene, null when none (or relay reported none). */
getScene(): Promise<RelayScene | null>;
/** Placeable docs of one type on a scene (active when sceneId omitted). */
getCanvasDocuments<T = Record<string, unknown>>(documentType: string, sceneId?: string): Promise<T[]>;
/** Move a token to canvas px (top-left), animated. */
moveToken(tokenUuid: string, x: number, y: number): Promise<void>;
```

4. Add `movementTimeoutMs?: number;` to `GatewayDeps` (next to `encounterFetchTimeoutMs`) and the default next to the others (~line 507):

```ts
const movementTimeoutMs = deps.movementTimeoutMs ?? 3_000;
```

5. Add a small shared helper near `fetchActor` (~line 523) plus the movement context fetch used by both routes:

```ts
/** M18-style bounded await: relay stall → null sentinel instead of a hang. */
const boundedMs = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

/** Scene + tokens + walk speed for one actor, every leg bounded.
 *  Returns null when a leg AFTER a resolved scene fails (→ 502);
 *  an unresolved scene is a normal offScene result, not an error. */
const fetchMovementContext = async (actorId: string) => {
  const scene = await boundedMs(relay.getScene(), movementTimeoutMs);
  if (!scene) return { offScene: true as const };
  const [doc, tokens] = await Promise.all([
    boundedMs(relay.getEntity(`Actor.${actorId}`), movementTimeoutMs),
    boundedMs(relay.getCanvasDocuments<RelayCanvasToken>('tokens', scene._id), movementTimeoutMs),
  ]);
  if (doc === null || tokens === null) return null;
  return { offScene: false as const, ctx: buildMovementContext(scene, tokens, actorId, walkSpeedOf(doc as { system?: unknown })), tokens };
};
```

6. Register the route after the sheet route:

```ts
app.get<{ Params: { id: string } }>(
  '/api/actors/:id/movement',
  { preHandler: auth(false) },
  async (req, reply) => {
    const player = req.player as Player;
    const { id } = req.params;
    // Ownership (404, never 403 — do not leak actor existence).
    if (!player.actorIds.includes(id)) return sendError(reply, 404, 'NOT_FOUND', 'actor not found');
    const result = await fetchMovementContext(id);
    if (result === null) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
    if (result.offScene) return reply.code(200).send({ movement: { onScene: false } });
    return reply.code(200).send({ movement: result.ctx.view });
  },
);
```

- [ ] **Step 5: Run gateway tests**

Run: `pnpm --filter @companion/gateway test`
Expected: PASS (new block + all pre-existing; `FakeRelay` now satisfies the widened `RelayPort`).

- [ ] **Step 6: Document + commit**

Add to `docs/API.md` next to the other actor routes:

```markdown
### GET /api/actors/:id/movement

Movement context for the actor's token on the ACTIVE scene (square grids only).
`{ movement: { onScene, sceneId?, gridDistance?, gridUnits?, speedFt?, token?: {cx,cy}, others?: [{cx,cy,disposition,name?}] } }`
`onScene:false` when there is no active scene, the grid is not square, or the
actor has no token there. Coordinates are grid cells, never pixels. GM-hidden
tokens are stripped server-side. 404 foreign/unknown actor; 502 relay failure.
```

```bash
git add apps/gateway/src/app.ts apps/gateway/test/fakes.ts apps/gateway/test/app.test.ts docs/API.md
git commit -m "feat(gateway): GET /api/actors/:id/movement — movement view endpoint"
```

---

### Task 4: gateway POST /api/actors/:id/movement

**Files:**
- Modify: `apps/gateway/src/app.ts` (directly under the GET route)
- Test: `apps/gateway/test/app.test.ts`
- Modify: `docs/API.md`

**Interfaces:**
- Consumes: Task 3's `fetchMovementContext`, `RelayPort.moveToken`, Task 2's `occupiedCells`/`validateMove`/`chebyshev` types, existing `limiter` (`SlidingWindowLimiter` keyed on `player.tokenHash`).
- Produces: `POST /api/actors/:id/movement` body `{ cx: number, cy: number }` → 200 `{ movement: MovementView }` (token at the new cell) | 404 | 409 | 422 | 429 | 502.

- [ ] **Step 1: Write the failing tests**

Append inside the movement describe block (same fixtures; `withSpeed(relay,'a1',30)`, `relay.scene = squareScene()`, own token `tok('t1','a1', 300, 200)` → cell (3,2), radius 6):

```ts
describe('POST /api/actors/:id/movement', () => {
  beforeEach(() => {
    withSpeed(relay, 'a1', 30);
    relay.scene = squareScene();
    relay.canvasTokens = [tok('t1', 'a1', 300, 200), tok('t2', 'm1', 500, 200)];
  });

  const post = (id: string, body: unknown, headers = asAnna) =>
    app.inject({ method: 'POST', url: `/api/actors/${id}/movement`, headers, payload: body as Record<string, unknown> });

  it('404s (not 403) on a foreign actor', async () => {
    expect((await post('b1', { cx: 1, cy: 1 })).statusCode).toBe(404);
  });

  it('422s on a malformed body', async () => {
    expect((await post('a1', { cx: 1.5, cy: 2 })).statusCode).toBe(422);
    expect((await post('a1', { cx: 1 })).statusCode).toBe(422);
    expect((await post('a1', 'nope')).statusCode).toBe(422);
  });

  it('422s when the destination is out of range', async () => {
    const res = await post('a1', { cx: 10, cy: 2 });   // chebyshev 7 > radius 6
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_INTENT');
  });

  it('409s when the destination cell is occupied by a VISIBLE token', async () => {
    const res = await post('a1', { cx: 5, cy: 2 });    // t2's cell
    expect(res.statusCode).toBe(409);
  });

  it('does NOT block a cell occupied only by a hidden token (no leak)', async () => {
    relay.canvasTokens = [tok('t1', 'a1', 300, 200), tok('t3', 'm2', 500, 200, { hidden: true })];
    const res = await post('a1', { cx: 5, cy: 2 });
    expect(res.statusCode).toBe(200);
  });

  it('409s when the actor has no token on the active scene', async () => {
    relay.canvasTokens = [];
    expect((await post('a1', { cx: 4, cy: 2 })).statusCode).toBe(409);
  });

  it('moves the token: relay gets Scene.<id>.Token.<id> + px, response has the new cell', async () => {
    const res = await post('a1', { cx: 5, cy: 1 });    // chebyshev 2, free
    expect(res.statusCode).toBe(200);
    expect(relay.moveTokenCalls).toEqual([{ tokenUuid: 'Scene.s1.Token.t1', x: 500, y: 100 }]);
    const movement = res.json().movement;
    expect(movement.token).toEqual({ cx: 5, cy: 1 });
    expect(movement.onScene).toBe(true);
  });

  it('502s when the relay move call hangs', async () => {
    relay.hangMove = true;
    expect((await post('a1', { cx: 5, cy: 1 })).statusCode).toBe(502);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @companion/gateway test -- app`
Expected: FAIL — 404 route-not-found on POST.

- [ ] **Step 3: Implement the route**

Directly below the GET route in `apps/gateway/src/app.ts`:

```ts
app.post<{ Params: { id: string } }>(
  '/api/actors/:id/movement',
  { preHandler: auth(false) },
  async (req, reply) => {
    const player = req.player as Player;
    const { id } = req.params;
    // Ownership (404, never 403 — do not leak actor existence).
    if (!player.actorIds.includes(id)) return sendError(reply, 404, 'NOT_FOUND', 'actor not found');
    if (!limiter.allow(player.tokenHash)) return sendError(reply, 429, 'RATE_LIMITED', 'too many write intents');

    const body = req.body as { cx?: unknown; cy?: unknown } | null;
    const cx = body && typeof body === 'object' ? body.cx : undefined;
    const cy = body && typeof body === 'object' ? body.cy : undefined;
    if (!Number.isInteger(cx) || !Number.isInteger(cy)) {
      return sendError(reply, 422, 'INVALID_INTENT', 'cx and cy must be integers');
    }
    const target = { cx: cx as number, cy: cy as number };

    const result = await fetchMovementContext(id);
    if (result === null) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
    if (result.offScene || !result.ctx.own || !result.ctx.gridSize || !result.ctx.view.sceneId) {
      return sendError(reply, 409, 'CONFLICT', 'no token on the active scene');
    }
    const { ctx, tokens } = result;

    const occupied = occupiedCells(tokens, ctx.gridSize, ctx.own._id);
    const verdict = validateMove(ctx.view, target, occupied);
    if (!verdict.ok) return sendError(reply, verdict.status, verdict.code, verdict.message);

    const tokenUuid = `Scene.${ctx.view.sceneId}.Token.${ctx.own._id}`;
    const moved = await boundedMs(
      relay.moveToken(tokenUuid, target.cx * ctx.gridSize, target.cy * ctx.gridSize).then(() => true),
      movementTimeoutMs,
    );
    if (moved === null) return sendError(reply, 502, 'UPSTREAM', 'upstream error');

    // Confirmed view: same context with the token at its new cell (no refetch —
    // the relay echoed the destination; a fresh GET runs on the next sheet open).
    return reply.code(200).send({ movement: { ...ctx.view, token: target } });
  },
);
```

Note: a **thrown** `RelayError` from `moveToken` (relay error-in-200, e.g. token deleted mid-flight) intentionally bubbles to the existing `app.setErrorHandler` → 502 UPSTREAM. Only the hang needs the race.

- [ ] **Step 4: Run gateway tests**

Run: `pnpm --filter @companion/gateway test`
Expected: PASS (all).

- [ ] **Step 5: Document + commit**

Add to `docs/API.md` under the GET entry:

```markdown
### POST /api/actors/:id/movement

Body `{ cx, cy }` (grid cell). Validates ownership (404), range (422
INVALID_INTENT, Chebyshev ≤ floor(speed/gridDistance)), occupancy by visible
tokens (409 CONFLICT), token-on-scene (409). On success moves the token in
Foundry (animated, straight line) and returns `{ movement }` with the token at
the new cell. 429 rate-limited; 502 relay failure/stall.
```

```bash
git add apps/gateway/src/app.ts apps/gateway/test/app.test.ts docs/API.md
git commit -m "feat(gateway): POST /api/actors/:id/movement — validated token move"
```

---

### Task 5: web — Move toolbar button + MoveSheet

**Files:**
- Modify: `apps/web/app/types/api.ts`
- Create: `apps/web/app/components/MoveSheet.vue`
- Modify: `apps/web/app/pages/actor/[id].vue` (toolbar ~line 5-38, sheet mounts ~line 223-310, script)

**Interfaces:**
- Consumes: gateway endpoints from Tasks 3–4; existing `useApi()` (`api<T>(path, {method, body})`, `errorStatus`, `errorData`), `useToast()`, `offline` computed (`[id].vue:456`), `.scrim`/`.modal-sheet` global classes, gold-button idiom (`linear-gradient(180deg, var(--gold-bright), var(--gold))`, `color: var(--accent-ink)`, `border: 1px solid var(--gold-deep)`).
- Produces: `MoveSheet.vue` with props `{ movement: MovementView; busy: boolean }`, emits `submit(cell: {cx, cy})`, `refresh`, and `close`.

No web unit tests exist (`apps/web` test script is a stub) — the gate is `pnpm --filter @companion/web typecheck`.

- [ ] **Step 1: Add the wire types**

In `apps/web/app/types/api.ts`:

```ts
/** GET/POST /api/actors/:id/movement (docs/API.md). Coordinates are grid cells. */
export interface MovementCell {
  cx: number
  cy: number
}

export interface MovementOther extends MovementCell {
  /** -1 hostile, 0 neutral, 1 friendly, -2 secret. */
  disposition: number
  name?: string
}

export interface MovementView {
  onScene: boolean
  sceneId?: string
  gridDistance?: number
  gridUnits?: string
  speedFt?: number
  token?: MovementCell
  others?: MovementOther[]
}

export interface MovementResponse {
  movement: MovementView
}
```

- [ ] **Step 2: Create MoveSheet.vue**

Create `apps/web/app/components/MoveSheet.vue`:

```vue
<template>
  <div class="scrim" @click.self="emit('close')">
    <div class="modal-sheet" role="dialog" aria-modal="true" aria-label="Move token">
      <div class="head">
        <div class="head-text">
          <span class="title">Move</span>
          <span class="note">{{ speedFt }} {{ units }} speed · tap a square</span>
        </div>
        <button class="refresh" type="button" aria-label="Refresh positions" :disabled="busy" @click="emit('refresh')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M4 12a8 8 0 1 0 2-5.3M4 4v3h3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>

      <div class="grid-wrap">
        <div class="grid" :style="{ gridTemplateColumns: `repeat(${side}, 1fr)` }">
          <button
            v-for="cell in cells"
            :key="`${cell.cx},${cell.cy}`"
            type="button"
            class="cell"
            :class="cellClass(cell)"
            :disabled="!cell.selectable || busy"
            :aria-label="cellAria(cell)"
            @click="select(cell)"
          >
            <span v-if="cell.isCenter" class="me" aria-hidden="true">★</span>
            <span v-else-if="cell.other" class="dot" :class="dotClass(cell.other.disposition)" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div class="foot">
        <span class="dist">{{ selected ? `${distanceOf(selected)} ${units}` : '—' }}</span>
        <button class="move-btn" type="button" :disabled="!selected || busy" @click="confirm()">
          Move
        </button>
      </div>
      <button class="cancel" type="button" @click="emit('close')">Cancel</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MovementCell, MovementOther, MovementView } from '~/types/api'

const props = defineProps<{ movement: MovementView; busy: boolean }>()
const emit = defineEmits<{
  (e: 'submit', cell: MovementCell): void
  (e: 'refresh'): void
  (e: 'close'): void
}>()

interface GridCell extends MovementCell {
  isCenter: boolean
  other?: MovementOther
  selectable: boolean
}

const speedFt = computed(() => props.movement.speedFt ?? 0)
const gridDistance = computed(() => props.movement.gridDistance ?? 5)
const units = computed(() => props.movement.gridUnits ?? 'ft')
/** Reachable radius in cells; the grid is (2r+1)². */
const radius = computed(() => Math.floor(speedFt.value / gridDistance.value))
const side = computed(() => radius.value * 2 + 1)

const selected = ref<MovementCell | null>(null)

const center = computed<MovementCell>(() => props.movement.token ?? { cx: 0, cy: 0 })

/** Occupied lookup: visible tokens by absolute cell. */
const otherAt = computed(() => {
  const map = new Map<string, MovementOther>()
  for (const o of props.movement.others ?? []) map.set(`${o.cx},${o.cy}`, o)
  return map
})

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

function distanceOf(cell: MovementCell): number {
  const c = center.value
  return Math.max(Math.abs(cell.cx - c.cx), Math.abs(cell.cy - c.cy)) * gridDistance.value
}

function select(cell: GridCell): void {
  if (!cell.selectable) return
  selected.value = { cx: cell.cx, cy: cell.cy }
}

function confirm(): void {
  if (selected.value) emit('submit', selected.value)
}

function cellClass(cell: GridCell): Record<string, boolean> {
  return {
    center: cell.isCenter,
    occupied: !!cell.other,
    selected: selected.value?.cx === cell.cx && selected.value?.cy === cell.cy,
  }
}

function dotClass(disposition: number): string {
  if (disposition === 1) return 'friendly'
  if (disposition === -1) return 'hostile'
  return 'neutral'
}

function cellAria(cell: GridCell): string {
  if (cell.isCenter) return 'Your position'
  if (cell.other) return `Occupied by ${cell.other.name ?? 'a creature'}`
  return `Move ${distanceOf(cell)} ${units.value}`
}
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.head-text { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.refresh { width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel-2); color: var(--text-dim); display: flex; align-items: center; justify-content: center; }
.refresh svg { width: 18px; height: 18px; }
.title { font-weight: 700; font-size: 1.05rem; }
.note { color: var(--text-dim); font-size: 0.8rem; }

.grid-wrap { overflow: auto; max-height: 55vh; }
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
.cell.selected {
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  border-color: var(--gold-deep);
}
.me { color: var(--accent-ink); font-size: 0.7rem; }
.dot { width: 55%; height: 55%; border-radius: 50%; }
.dot.friendly { background: var(--success); }
.dot.hostile { background: var(--danger); }
.dot.neutral { background: var(--ink-dim); }

.foot { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.dist { flex: 1; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.move-btn {
  min-height: 36px; padding: 0 20px; border-radius: 999px;
  font-weight: 700; font-size: 0.78rem; letter-spacing: 0.02em;
  border: 1px solid var(--gold-deep);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  color: var(--accent-ink);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--gold) 30%, transparent);
}
.move-btn:disabled { opacity: 0.55; box-shadow: none; }
.move-btn:active:not(:disabled) { transform: scale(0.96); }
.cancel {
  width: 100%; margin-top: 10px; min-height: var(--tap);
  background: none; border: none; color: var(--text-dim); font-weight: 600;
}
</style>
```

- [ ] **Step 3: Wire the page**

In `apps/web/app/pages/actor/[id].vue`:

1. Toolbar button — insert after the roll-history button (`~line 16`), a four-way move-cross icon:

```vue
<button
  v-if="movement?.onScene"
  class="tool"
  type="button"
  aria-label="Move token"
  :disabled="offline"
  @click="openMoveSheet()"
>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</button>
```

2. Sheet mount — with the other sheets (~line 236):

```vue
<MoveSheet
  v-if="showMoveSheet && movement"
  :movement="movement"
  :busy="moveBusy"
  @submit="onMoveSubmit"
  @refresh="refreshMovement"
  @close="showMoveSheet = false"
/>
```

3. Script — import the types (`import type { MovementCell, MovementResponse, MovementView } from '~/types/api'` — extend the existing type-import line), then state + handlers near the other sheet toggles:

```ts
/* ---- token movement (Move sheet) ---------------------------------------- */
const movement = ref<MovementView | null>(null)
const showMoveSheet = ref(false)
const moveBusy = ref(false)

/** Silent refresh: failure just hides/keeps the toolbar button — movement is
 *  an optional affordance, never an error the player must see. */
async function refreshMovement(): Promise<void> {
  try {
    const res = await api<MovementResponse>(`/api/actors/${actorId.value}/movement`)
    movement.value = res.movement
  } catch {
    movement.value = null
  }
}

function openMoveSheet(): void {
  if (offline.value) return
  showMoveSheet.value = true
  void refreshMovement()   // stale-while-revalidate: sheet opens on cached view
}

async function onMoveSubmit(cell: MovementCell): Promise<void> {
  if (offline.value || moveBusy.value) return
  moveBusy.value = true
  try {
    const res = await api<MovementResponse>(`/api/actors/${actorId.value}/movement`, {
      method: 'POST',
      body: cell,
    })
    movement.value = res.movement
    showMoveSheet.value = false
    toast.show('Move sent to the table')
  } catch (err) {
    const status = errorStatus(err)
    if (status === 409) {
      toast.show('That square is taken or the scene changed — refreshed')
      void refreshMovement()
    } else if (status === 422) {
      toast.show('Out of range')
    } else if (status === 401) {
      clearToken()
      await navigateTo('/join', { replace: true })
    } else {
      toast.show('Move didn’t go through. Try again.')
    }
  } finally {
    moveBusy.value = false
  }
}
```

4. Call `void refreshMovement()` once after the initial sheet load succeeds — inside `fetchSheet()`'s success path (after `applySheet(res.sheet)` in the initial-load call site, ~line 934) or wherever the page runs its post-load hooks (mirror how the party/encounter fetches are kicked off).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @companion/web typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/types/api.ts apps/web/app/components/MoveSheet.vue "apps/web/app/pages/actor/[id].vue"
git commit -m "feat(web): Move sheet — movement grid, toolbar entry, gateway wiring"
```

---

### Task 6: full verification + live check

**Files:** none created — verification only (plus a findings note).

- [ ] **Step 1: Full test + typecheck sweep**

```bash
pnpm -r test
pnpm -r typecheck
```
Expected: all green (foundry-client, gateway, bootstrap suites; typecheck exit 0 everywhere).

- [ ] **Step 2: Live verification on the stack (per repo convention)**

With the stack running (Foundry world open, a scene with a square grid active, the paired player's token placed on it):

1. `GET /api/actors/<id>/movement` with a player Bearer token → `onScene: true`, `token` cell matches the token's position in Foundry (token px ÷ grid size), `speedFt` matches the sheet, GM-hidden tokens absent from `others`.
2. In the PWA: Move button appears in the toolbar; open it; grid shows radius `speed/5` with other tokens plotted.
3. Tap a free cell → Move → token **animates** to the cell in Foundry; response/grid re-centers.
4. Negative checks: tap-target another player's actor id via curl → 404; POST an out-of-range cell via curl → 422; POST onto a visible occupied cell → 409.
5. Switch Foundry to a gridless scene → GET returns `onScene: false`, button hides after reload.

- [ ] **Step 3: Record findings**

Add a short findings note (any surprises: relay latency of the 3-call chain, grid rounding on odd token placement, animation behavior) to `docs/` per the repo's live-check convention (see VERSIONS.md / existing `docs/M*-findings.md` style), commit it, and report results.

```bash
git add docs/
git commit -m "docs: token movement live-check findings"
```
