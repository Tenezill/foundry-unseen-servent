import { describe, expect, it } from 'vitest';
import { MovementBudgetTracker } from '../src/movement-budget.js';

describe('MovementBudgetTracker', () => {
  it('accumulates moves per key and defaults to zero', () => {
    const t = new MovementBudgetTracker();
    const k = MovementBudgetTracker.key('c1', 1, 'comb1');
    expect(t.state(k)).toEqual({ movedFt: 0, dashed: false });
    t.addMove(k, 10); t.addMove(k, 5);
    expect(t.state(k).movedFt).toBe(15);
  });

  it('a new round is a new key — lazy reset', () => {
    const t = new MovementBudgetTracker();
    t.addMove(MovementBudgetTracker.key('c1', 1, 'comb1'), 30);
    expect(t.state(MovementBudgetTracker.key('c1', 2, 'comb1')).movedFt).toBe(0);
  });

  it('markDashed arms once per key', () => {
    const t = new MovementBudgetTracker();
    const k = MovementBudgetTracker.key('c1', 1, 'comb1');
    expect(t.markDashed(k)).toBe(true);
    expect(t.markDashed(k)).toBe(false);
    expect(t.state(k).dashed).toBe(true);
  });

  it('prune drops other rounds/combats but keeps the current one', () => {
    const t = new MovementBudgetTracker();
    t.addMove(MovementBudgetTracker.key('c1', 1, 'comb1'), 10);
    t.addMove(MovementBudgetTracker.key('c1', 2, 'comb1'), 5);
    t.addMove(MovementBudgetTracker.key('cOld', 2, 'combX'), 5);
    t.prune('c1', 2);
    expect(t.state(MovementBudgetTracker.key('c1', 2, 'comb1')).movedFt).toBe(5);
    expect(t.state(MovementBudgetTracker.key('c1', 1, 'comb1')).movedFt).toBe(0);
    expect(t.state(MovementBudgetTracker.key('cOld', 2, 'combX')).movedFt).toBe(0);
  });
});
