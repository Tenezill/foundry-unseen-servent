/**
 * Per-turn movement budget (2026-07-22 combat-targeting spec §F4). Pure
 * in-memory state keyed `combatId:round:combatantId` — a new round is a new
 * key, so budgets reset lazily with no reset logic. Deliberately NOT
 * persisted: a gateway restart refills budgets (soft-cap philosophy).
 */
export interface BudgetState { movedFt: number; dashed: boolean }

export class MovementBudgetTracker {
  private readonly entries = new Map<string, BudgetState>();

  static key(combatId: string, round: number, combatantId: string): string {
    return `${combatId}:${round}:${combatantId}`;
  }

  state(key: string): BudgetState {
    return this.entries.get(key) ?? { movedFt: 0, dashed: false };
  }

  addMove(key: string, ft: number): void {
    const cur = this.state(key);
    this.entries.set(key, { ...cur, movedFt: cur.movedFt + ft });
  }

  /** true when dash armed now; false when already dashed this turn. */
  markDashed(key: string): boolean {
    const cur = this.state(key);
    if (cur.dashed) return false;
    this.entries.set(key, { ...cur, dashed: true });
    return true;
  }

  /** Keep only the current combat+round (called lazily on access). */
  prune(combatId: string, round: number): void {
    const prefix = `${combatId}:${round}:`;
    for (const k of this.entries.keys()) if (!k.startsWith(prefix)) this.entries.delete(k);
  }

  clear(): void {
    this.entries.clear();
  }
}
