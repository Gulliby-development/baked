/**
 * Whether a person can raise a run's limits with `extend`: a run blocked on its budget, or blocked
 * for another reason with its spending within `NEAR_COST_CAP` of its dollar cap, where the next
 * step is a cost stop anyway. Spending is what finished attempts cost plus what open attempts
 * still reserve (`reservedCostUsd`), the sum every cost check holds to the cap (#1435). Bench
 * round 35 (narrowfit sum): the run blocked `invalid_output` with $1.45 of its $1.46 cap spent,
 * extend was refused, and it took a resume to reach the budget stop before the same extend worked
 * (#1353). A run stopped at an attempt's token cap resumes instead. Pure, so every front end
 * decides the same way.
 */
export const NEAR_COST_CAP = 0.95;

export function canExtendRun(run: {
  status: string;
  reason?: string | undefined;
  estimatedCostUsd: number | null;
  reservedCostUsd?: number | undefined;
  maxCostUsd?: number | null | undefined;
}): boolean {
  if (run.status !== "blocked" || run.reason === "attempt_cap") return false;
  if (run.reason === "budget_exhausted") return true;
  if (run.maxCostUsd == null || (run.estimatedCostUsd === null && !run.reservedCostUsd))
    return false;
  return (run.estimatedCostUsd ?? 0) + (run.reservedCostUsd ?? 0) >= NEAR_COST_CAP * run.maxCostUsd;
}
