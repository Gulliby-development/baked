import type { WorkflowStore } from "../workflows/store.js";

/**
 * The failed check runs the host counts as passed, by evidence id, with why: a static check that
 * failed only on debt from before the run under `staticBaseline: "relative"` (#1222), and a test
 * check that collected no test in a run whose plan writes none (#1864). The checks stage records
 * each as a diagnostic; acceptance and every view of a run's checks read them here (#1894).
 */
export function hostPassedChecks(
  store: Pick<WorkflowStore, "artifacts" | "readArtifact">,
  runId: string,
): Map<string, string> {
  const passed = new Map<string, string>();
  for (const artifact of store.artifacts(runId)) {
    const debt = artifact.logical_path.startsWith("checks/baseline-debt/");
    if (!debt && !artifact.logical_path.startsWith("checks/no-tests/")) continue;
    try {
      const record = JSON.parse(store.readArtifact(runId, artifact.id)) as {
        evidenceId?: string;
        reason?: string;
      };
      if (record.evidenceId)
        passed.set(
          record.evidenceId,
          debt
            ? "it failed only on diagnostics from before the run"
            : (record.reason ?? "it collected no test"),
        );
    } catch {
      // An unreadable diagnostic exempts nothing.
    }
  }
  return passed;
}

/**
 * Check results as the host decided them: a failed run in `hostPassedChecks` reads `passed`, with
 * the reason in `hostPassed`. Every view of a run's checks reads them through this, so a report,
 * `workflow status`, the TUI and the desktop agree with acceptance (#1894).
 */
export function decidedChecks<T extends { status: string; evidence_id: string }>(
  store: Pick<WorkflowStore, "artifacts" | "readArtifact">,
  runId: string,
  rows: readonly T[],
): (T & { hostPassed?: string })[] {
  const passed = hostPassedChecks(store, runId);
  return rows.map((row) => {
    const reason = row.status === "failed" ? passed.get(row.evidence_id) : undefined;
    return reason ? { ...row, status: "passed", hostPassed: reason } : row;
  });
}
