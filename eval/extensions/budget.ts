import type { ProfileId } from "./schemas.js";

export const BUDGET_USD = 10;
export const INITIAL_RUN_ESTIMATE_USD = 1;

/** Tracks catalog cost per run. A null cost (unmeasured usage) is not an observation and keeps the estimate. */
export class BudgetLedger {
  private spent = 0;
  private maxObserved = 0;
  private readonly observed = new Set<ProfileId>();
  constructor(private readonly limitUsd: number) {}
  record(profile: ProfileId, costUsd: number | null): void {
    if (costUsd === null) return;
    this.spent += costUsd;
    this.maxObserved = Math.max(this.maxObserved, costUsd);
    this.observed.add(profile);
  }
  estimate(profile: ProfileId): number {
    return this.observed.has(profile) ? this.maxObserved : Math.max(INITIAL_RUN_ESTIMATE_USD, this.maxObserved);
  }
  allows(profile: ProfileId): boolean { return this.spent + this.estimate(profile) <= this.limitUsd; }
  get spentUsd(): number { return this.spent; }
}
