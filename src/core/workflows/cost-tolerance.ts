import type { RunPolicy } from "./schemas.js";
import type { WorkflowStore } from "./store.js";

/**
 * A dollar cap with a tolerance band (#1263): `maxCostUsd` is the soft cap the run aims at, and
 * `maxCostUsd × (1 + tolerance)` the hard ceiling every cost check stops at. Bench runs priced
 * 2-3x low stopped a few percent short of finishing: cfgtrace b4427c85 at $11.92 of $12 with two
 * tasks and the final review left, where the whole run needed about $14. A band lets such a run
 * finish without a person while the ceiling still bounds it; past the soft cap the run winds up
 * (`inCostWrapUp`): it finishes its planned tasks and the review but starts corrections only for
 * critical and high findings.
 */

/**
 * The `auto` tolerance for a plan of this many tasks: bigger plans miss their price by more, so
 * they get a wider band. The count is the plan's, never a provider's token price, so the band
 * means the same on every provider.
 */
export function autoCostTolerance(plannedTasks: number): number {
  if (plannedTasks <= 8) return 0.1;
  if (plannedTasks <= 16) return 0.15;
  if (plannedTasks <= 24) return 0.2;
  if (plannedTasks <= 32) return 0.25;
  return 0.3;
}

/** Planned tasks of the run: the latest plan sizing, else the planned task rows. */
function plannedTasks(store: WorkflowStore, runId: string): number {
  const latest = store
    .artifacts(runId)
    .filter((a) => a.kind === "sizing" && a.logical_path.startsWith("sizing/plan-"))
    .at(-1);
  if (latest) {
    try {
      const body = JSON.parse(store.readArtifact(runId, latest.id)) as { tasks?: unknown };
      if (Array.isArray(body.tasks) && body.tasks.length > 0) return body.tasks.length;
    } catch {
      // An unreadable sizing falls back to the task rows.
    }
  }
  return store
    .tasks(runId)
    .filter((t) => (JSON.parse(t.definition_json) as { origin?: string }).origin === "planned")
    .length;
}

/** The run's tolerance as a share of its cap; 0 without a cap or with `costTolerance` off. */
export function costToleranceOf(store: WorkflowStore, runId: string, policy: RunPolicy): number {
  const setting = policy.costTolerance ?? "off";
  if (policy.maxCostUsd === null || setting === "off") return 0;
  return setting === "auto" ? autoCostTolerance(plannedTasks(store, runId)) : setting;
}

/** The dollars every cost check stops at: the cap plus its tolerance; null without a cap. */
export function costCeilingUsd(
  store: WorkflowStore,
  runId: string,
  policy: RunPolicy,
): number | null {
  const cap = policy.maxCostUsd;
  if (cap === null) return null;
  return Math.round(cap * (1 + costToleranceOf(store, runId, policy)) * 100) / 100;
}

/** Whether the run has a tolerance band and has spent and reserved past its soft cap. */
export function inCostWrapUp(store: WorkflowStore, runId: string, policy: RunPolicy): boolean {
  const cap = policy.maxCostUsd;
  if (cap === null || costToleranceOf(store, runId, policy) === 0) return false;
  const { spentUsd, reservedUsd } = store.costUsage(runId);
  return spentUsd + reservedUsd >= cap;
}
