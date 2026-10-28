import { WorkflowFault } from "./errors.js";
import { InitiativeStore } from "./initiatives/store.js";
import { PARALLEL_CAP } from "./leases.js";
import type { WorkflowStore } from "./store.js";

/**
 * The answer to a change that was applied and then resumed while the workspace was at its
 * parallel-run cap (#2415, R76 schemamask: `extend --resume` exited 5 with `WORKSPACE_BUSY`
 * although the extension took effect). The change stays; the run is paused and starts when a
 * slot is free: its initiative's drive starts a feature run, a person resumes any other run.
 */
export interface QueuedResume {
  reason: typeof PARALLEL_CAP;
  /** What was applied before the refused start, in the words of the message. */
  change: string;
  message: string;
  maxParallelRuns: number | null;
  /** The runs that hold the slots. */
  executing: string[];
  /** The initiative whose drive continues the run, or null for a run outside one. */
  initiativeId: string | null;
  /** The command that resumes the run once a slot is free, or null when the drive does. */
  next: string | null;
}

/** Whether a refusal is the parallel-run cap's: the run was not started, nothing else failed. */
export function isParallelCapBusy(error: unknown): error is WorkflowFault {
  return (
    error instanceof WorkflowFault &&
    error.code === "WORKSPACE_BUSY" &&
    error.details.reason === PARALLEL_CAP
  );
}

/**
 * The queued answer for a resume that `error` refused at the parallel-run cap after `change` was
 * applied, or null for any other error. Every surface that applies a change and then drives the
 * run (the headless CLI, the TUI) answers with it instead of the bare refusal.
 */
export function queuedResume(
  error: unknown,
  store: WorkflowStore,
  runId: string,
  change: string,
): QueuedResume | null {
  if (!isParallelCapBusy(error)) return null;
  const executing = Array.isArray(error.details.executing)
    ? error.details.executing.filter((id): id is string => typeof id === "string")
    : [];
  const cap = error.details.maxParallelRuns;
  const maxParallelRuns = typeof cap === "number" ? cap : null;
  const initiativeId = new InitiativeStore(store).initiativeOfRun(runId);
  const run = store.run(runId);
  const next = initiativeId
    ? null
    : `baked workflow resume ${runId} --expected-revision ${String(run.revision)}`;
  const busy = `${String(executing.length)} run${executing.length === 1 ? " is" : "s are"} executing${maxParallelRuns === null ? "" : ` (workflows.maxParallelRuns is ${String(maxParallelRuns)})`}${executing.length ? `: ${executing.join(", ")}` : ""}`;
  const message = initiativeId
    ? `${change}; the run is ${run.status} and continues when a slot is free, started by initiative ${initiativeId}'s drive (${busy}).`
    : `${change}; the run is ${run.status} and continues when a slot is free: resume it then with \`${next}\` (${busy}).`;
  return {
    reason: PARALLEL_CAP,
    change,
    message,
    maxParallelRuns,
    executing,
    initiativeId,
    next,
  };
}
