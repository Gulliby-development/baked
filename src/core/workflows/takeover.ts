import { InitiativeStore } from "./initiatives/store.js";
import { processAlive } from "./leases.js";
import type { NativeWorkflowService } from "./service.js";
import { driverRuns, type StalledDriver } from "./supervisor.js";

/** A run after its stopped driver was taken over, and what continues it. */
export interface TakenOverRun {
  runId: string;
  /** False past `workflows.stall.autoResumes`: the run is blocked `step_stalled` for a person. */
  resumed: boolean;
  revision: number;
  /** The initiative whose drive continues the run, when it is one of its features. */
  initiativeId: string | null;
}

/**
 * Takes over the running runs of a driver its supervisor stopped (#1533, #1541): the given runs,
 * or every run with a lease the driver holds. Call it only once that driver is gone.
 */
export async function takeOverDriver(
  service: NativeWorkflowService,
  driver: StalledDriver,
  runIds: readonly string[] = driverRuns(service.store.leases(), driver),
): Promise<TakenOverRun[]> {
  // A process that still runs is not taken over; a worker thread's process is the caller's own.
  if (driver.owner === undefined && processAlive(driver.pid) === true) return [];
  const initiatives = new InitiativeStore(service.store);
  const out: TakenOverRun[] = [];
  for (const runId of runIds) {
    if (service.store.run(runId).status !== "running") continue;
    const resumed = await service.takeOverStalledDriver(runId, driver);
    out.push({
      runId,
      resumed,
      revision: service.store.run(runId).revision,
      initiativeId: initiatives.available() ? initiatives.initiativeOfRun(runId) : null,
    });
  }
  return out;
}
