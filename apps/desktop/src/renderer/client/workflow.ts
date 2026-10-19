import type { RecoveryAdvice } from "../../../../../src/core/workflows/remedies-model.js";
import type { RunSnapshot } from "../../shared/api.js";
import { call } from "./api.js";

/**
 * Workflow run actions over `/v1/workflow/runs/:id/*`. Every mutation carries a fresh command ID
 * and the revision the person looked at, so a stale screen gets a 409 instead of acting on a run
 * that moved on. Shared by the run screens and "Needs you".
 */

export interface RunStatus extends RunSnapshot {
  /** Set once a plan is approved; an approval sends the request's own digest. */
  approvalDigest: string | null;
  /** Durable requests of the run, as `baked workflow status` returns them. */
  requests: {
    id: string;
    kind: string;
    status: string;
    digest: string;
    body_json: string | null;
  }[];
  /** For a blocked or failed run, the error the runtime recorded when it stopped it. */
  stopDetail?: string | null;
  recovery?: RecoveryAdvice;
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
  /** `acceptWorkspace` keeps the files a person changed outside a run blocked on `input_changed`. */
  resume: (
    key: string,
    run: Pick<RunSnapshot, "runId" | "revision">,
    options: { acceptWorkspace?: boolean } = {},
  ) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "resume"), {
      ...command(run),
      ...(options.acceptWorkspace ? { acceptWorkspace: true } : {}),
    }),
  repair: (key: string, run: Pick<RunSnapshot, "runId" | "revision">, rounds = 1) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "repair"), { ...command(run), rounds }),
  pause: (key: string, run: Pick<RunSnapshot, "runId" | "revision">) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "pause"), command(run)),
  cancel: (key: string, run: Pick<RunSnapshot, "runId" | "revision">) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "cancel"), command(run)),
  /** Undoes the run's uncommitted task edits; refused while the run is created or running. */
  undo: (key: string, run: Pick<RunSnapshot, "runId" | "revision">) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "undo"), command(run)),
  /** Raises the limits of a run that stopped on its budget; omitted limits take BAKED's proposal. */
  extend: (
    key: string,
    run: Pick<RunSnapshot, "runId" | "revision">,
    limits: { tokens?: number; calls?: number; timeMs?: number; costUsd?: number } = {},
  ) => call<RunSnapshot>(key, "POST", runPath(run.runId, "extend"), { ...command(run), ...limits }),
  /**
   * Moves a stopped run to another run model and/or stage routes (stage ID to model). Completed
   * work stays; the run keeps its status, so a blocked or paused run is resumed after it.
   */
  reroute: (
    key: string,
    run: Pick<RunSnapshot, "runId" | "revision">,
    change: { model?: string; routes?: Record<string, string> },
  ) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "reroute"), { ...command(run), ...change }),
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
