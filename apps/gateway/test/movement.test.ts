import { describe, expect, it } from 'vitest';
import type { RelayCanvasToken, RelayScene } from '@companion/foundry-client';
import {
  buildMovementContext, chebyshev, occupiedCells, speedFromStats, validateMove,
} from '../src/movement.js';

const scene = (grid: RelayScene['grid']): RelayScene => ({ _id: 's1', name: 'Crypt', grid });
const squareScene = (): RelayScene => scene({ type: 1, size: 100, distance: 5, units: 'ft' });
const tok = (id: string, actorId: string | null, x: number, y: number, extra: Partial<RelayCanvasToken> = {}): RelayCanvasToken =>
  ({ _id: id, name: `tok-${id}`, x, y, width: 1, height: 1, hidden: false, disposition: 0, actorId, ...extra });

describe('speedFromStats', () => {
  it('reads stats.speed off the derived get-actor-details response', () => {
    expect(speedFromStats({ stats: { speed: 30 } })).toBe(30);
  });
  it('returns 0 for missing/invalid speed', () => {
    expect(speedFromStats(null)).toBe(0);
    expect(speedFromStats(undefined)).toBe(0);
    expect(speedFromStats({})).toBe(0);
    expect(speedFromStats({ stats: {} })).toBe(0);
    expect(speedFromStats({ stats: { speed: 'fast' } })).toBe(0);
    expect(speedFromStats({ stats: { speed: -5 } })).toBe(0);
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

  it('expands a large visible token to one others entry per covered cell', () => {
    const tokens = [
      tok('t1', 'a1', 300, 200),
      tok('t2', 'm1', 500, 200, { disposition: -1, width: 2, height: 2 }),
    ];
    const { view } = buildMovementContext(squareScene(), tokens, 'a1', 30);
    expect(view.others).toHaveLength(4);
    const cells = view.others?.map(({ cx, cy }) => `${cx},${cy}`).sort();
    expect(cells).toEqual(['5,2', '5,3', '6,2', '6,3']);
    for (const other of view.others ?? []) {
      expect(other).toMatchObject({ disposition: -1, name: 'tok-t2' });
    }
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
