import type { RunSnapshot } from "../../shared/api.js";
import { call } from "./api.js";

/**
 * Workflow run actions over `/v1/workflow/runs/:id/*`. Every mutation carries a fresh command ID
 * and the revision the person looked at, so a stale screen gets a 409 instead of acting on a run
 * that moved on. Shared by the run screens and "Needs you".
 */

export interface RunStatus extends RunSnapshot {
  approvalDigest: string | null;
  /** Durable requests of the run, as `baked workflow status` returns them. */
  requests: { request_id: string; kind: string; status: string; body_json: string | null }[];
}

const commandId = (): string => crypto.randomUUID();
const runPath = (runId: string, action?: string): string =>
  `/v1/workflow/runs/${encodeURIComponent(runId)}${action ? `/${action}` : ""}`;
const command = (run: Pick<RunSnapshot, "revision">) => ({
  commandId: commandId(),
  expectedRevision: run.revision,
});

export const workflow = {
  status: (key: string, runId: string) => call<RunStatus>(key, "GET", runPath(runId)),
  approve: (
    key: string,
    run: Pick<RunStatus, "runId" | "revision" | "approvalDigest">,
    requestId: string,
    excludeUserChanges = false,
  ) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "approve"), {
      ...command(run),
      requestId,
      digest: run.approvalDigest ?? "",
      ...(excludeUserChanges ? { excludeUserChanges } : {}),
    }),
  reject: (
    key: string,
    run: Pick<RunSnapshot, "runId" | "revision">,
    requestId: string,
    reason: string,
  ) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "reject"), {
      ...command(run),
      requestId,
      reason,
    }),
  answer: (
    key: string,
    run: Pick<RunSnapshot, "runId" | "revision">,
    requestId: string,
    answers: Record<string, string>,
  ) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "answer"), {
      ...command(run),
      requestId,
      answers,
    }),
  resume: (key: string, run: Pick<RunSnapshot, "runId" | "revision">) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "resume"), command(run)),
  pause: (key: string, run: Pick<RunSnapshot, "runId" | "revision">) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "pause"), command(run)),
  cancel: (key: string, run: Pick<RunSnapshot, "runId" | "revision">) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "cancel"), command(run)),
  /** Raises the limits of a run that stopped on its budget; omitted limits take BAKED's proposal. */
  extend: (
    key: string,
    run: Pick<RunSnapshot, "runId" | "revision">,
    limits: { tokens?: number; calls?: number; timeMs?: number } = {},
  ) => call<RunSnapshot>(key, "POST", runPath(run.runId, "extend"), { ...command(run), ...limits }),
  /**
   * Stages a revision of the run's accepted inputs. With no field it adopts the current
   * instruction files, which is how a run continues after one of them changed.
   */
  candidate: (key: string, runId: string) =>
    call<{ candidateHash: string; reportArtifactId: string }>(
      key,
      "POST",
      runPath(runId, "candidate"),
      { commandId: commandId() },
    ),
  /** Applies a staged candidate; the plan then waits for approval again before the run resumes. */
  revise: (key: string, run: Pick<RunSnapshot, "runId" | "revision">, candidateHash: string) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "revise"), {
      ...command(run),
      candidate: candidateHash,
    }),
  /** The SSE path of a run's durable event log; event IDs are sequence numbers. */
  eventsPath: (runId: string) => runPath(runId, "events"),
};
