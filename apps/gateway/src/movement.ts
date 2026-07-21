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

/** Cells covered by a token's footprint (multi-square aware): anchor cell
 *  plus width×height grid squares, each dimension ceil'd and floored at 1.
 *  Shared by buildMovementContext (others) and occupiedCells so the two
 *  can't drift apart on what "occupies" a cell means. */
function coveredCells(t: RelayCanvasToken, gridSize: number): MovementCell[] {
  const { cx, cy } = cellOf(t, gridSize);
  const w = Math.max(1, Math.ceil(typeof t.width === 'number' ? t.width : 1));
  const h = Math.max(1, Math.ceil(typeof t.height === 'number' ? t.height : 1));
  const cells: MovementCell[] = [];
  for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) cells.push({ cx: cx + dx, cy: cy + dy });
  return cells;
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
    .flatMap((t) => {
      const disposition = typeof t.disposition === 'number' ? t.disposition : 0;
      const name = typeof t.name === 'string' && t.name !== '' ? t.name : undefined;
      return coveredCells(t, gridSize).map((cell) => ({
        ...cell,
        disposition,
        ...(name !== undefined ? { name } : {}),
      }));
    });

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
    for (const { cx, cy } of coveredCells(t, gridSize)) out.add(`${cx},${cy}`);
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
