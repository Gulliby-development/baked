import { ACCEPTANCE_REFUSAL } from "../workflows/acceptance-refusal.js";
import { WorkflowFault } from "../workflows/errors.js";
import { forkStageOfKind } from "../workflows/fork-stage.js";
import { type RecoveryAdvice, type Remedy, recoveryAdvice } from "../workflows/remedies.js";
import type { WorkflowErrorCode } from "../workflows/schemas.js";
import type { FindingRow, RequestRow, WorkflowStore } from "../workflows/store.js";

/**
 * The host predicates of acceptance (`acceptance()` in `acceptance.ts`): each refusal carries the
 * remedy that changes what its predicate reads (#2879). A model switch changes none of them, so
 * none offers one, and the repeat guard leaves these refusals alone (`acceptanceRefused`).
 */
export type AcceptancePredicate =
  | "authority"
  | "task"
  | "check"
  | "task-checks"
  | "review"
  | "decision"
  | "findings"
  | "manual"
  | "criterion"
  | "effects";

/** At most this many ids are named in one refusal; the rest are counted. */
const NAMED = 10;

function named(ids: readonly string[]): string {
  const shown = ids.slice(0, NAMED).join(", ");
  return ids.length > NAMED ? `${shown} and ${String(ids.length - NAMED)} more` : shown;
}

/** An acceptance refusal: its diagnostic, its advice and the predicate that refused. */
export function acceptanceRefusal(
  code: WorkflowErrorCode,
  predicate: AcceptancePredicate,
  advice: RecoveryAdvice,
  details: Record<string, unknown> = {},
): WorkflowFault {
  return new WorkflowFault(code, advice, {
    ...details,
    hostPredicate: ACCEPTANCE_REFUSAL,
    predicate,
  });
}

/** The stage a fork of the run starts at to run a stage of these kinds again, as a CLI flag. */
function forkCommand(store: WorkflowStore, runId: string, kinds: readonly string[]): string {
  const stage = forkStageOfKind(store.run(runId).definition_json, kinds);
  return `baked workflow fork ${runId}${stage ? ` --from-stage ${stage}` : ""}`;
}

/** What else a person can do with a refused run: revise its input, or cancel it. */
const reviseOrCancel = (runId: string): Remedy[] => [
  { action: "revise", runId },
  { action: "cancel", runId },
];

/** The correction chain or the approved artifacts do not authorize what the run holds. */
export function authorityAdvice(runId: string, diagnostic: string): RecoveryAdvice {
  return recoveryAdvice(
    `${diagnostic}. The approved plan no longer covers what the run holds, and no resume changes that: fork the run to plan and approve it again (\`baked workflow fork ${runId}\`), revise it (\`baked workflow revise ${runId}\`), or cancel it`,
    `${diagnostic}. The approved plan no longer covers this run: fork it to plan again, revise it or cancel it.`,
    { action: "fork", runId },
    ...reviseOrCancel(runId),
  );
}

/** A planned task whose row is not implemented. */
export function taskAdvice(runId: string, taskId: string, status: string | null): RecoveryAdvice {
  const diagnostic = `Task ${taskId} is not implemented`;
  const was = status ? ` (its status is ${status})` : "";
  return recoveryAdvice(
    `${diagnostic}${was}. A resume runs acceptance again on the same tasks: fork the run to implement it again (\`baked workflow fork ${runId}\`), revise it (\`baked workflow revise ${runId}\`), or cancel it`,
    `${diagnostic}${was}. Fork the run to implement it again, revise it or cancel it.`,
    { action: "fork", runId },
    ...reviseOrCancel(runId),
  );
}

/** A required check with no current pass. */
export function checkAdvice(store: WorkflowStore, runId: string, checkId: string): RecoveryAdvice {
  const diagnostic = `Required check ${checkId} has not passed on current sources`;
  return recoveryAdvice(
    `${diagnostic}. A resume runs acceptance again without running the check: fork the run from its checks to run ${checkId} on the current changes (\`${forkCommand(store, runId, ["checks"])}\`), revise the run (\`baked workflow revise ${runId}\`), or cancel it`,
    `${diagnostic}. Fork the run from its checks to run ${checkId} again, revise it or cancel it.`,
    { action: "fork", runId },
    ...reviseOrCancel(runId),
  );
}

/** A task whose required task checks have not passed. */
export function taskChecksAdvice(
  store: WorkflowStore,
  runId: string,
  taskId: string,
): RecoveryAdvice {
  const diagnostic = `Task checks of ${taskId} have not passed`;
  return recoveryAdvice(
    `${diagnostic}. A resume runs acceptance again without running them: fork the run from its checks (\`${forkCommand(store, runId, ["checks"])}\`), revise it (\`baked workflow revise ${runId}\`), or cancel it`,
    `${diagnostic}. Fork the run from its checks to run them again, revise it or cancel it.`,
    { action: "fork", runId },
    ...reviseOrCancel(runId),
  );
}

/** A required review that is missing or inconclusive. */
export function reviewAdvice(
  store: WorkflowStore,
  runId: string,
  review: string,
  verdict: string | null,
): RecoveryAdvice {
  const diagnostic = `Required ${review} review did not pass`;
  const was = verdict ? ` (its verdict is ${verdict})` : " (no review was recorded)";
  return recoveryAdvice(
    `${diagnostic}${was}. A resume runs acceptance again on the same review: fork the run from its review to review the current changes again (\`${forkCommand(store, runId, ["review"])}\`), revise it (\`baked workflow revise ${runId}\`), or cancel it`,
    `${diagnostic}${was}. Fork the run from its review to review it again, revise it or cancel it.`,
    { action: "fork", runId },
    ...reviseOrCancel(runId),
  );
}

/** The command that answers a pending request of each kind. */
function decisionCommand(runId: string, request: RequestRow): string {
  const id = request.id;
  switch (request.kind) {
    case "approval":
    case "delivery":
      return `baked workflow approve ${runId} --request ${id} --digest ${request.digest}`;
    case "clarification":
      return `baked workflow answer ${runId} --request ${id} --answers-file FILE`;
    case "manual_evidence":
      return `baked workflow evidence ${runId} --request ${id} --file FILE --accept`;
    case "recovery":
      return `baked workflow recover ${runId} --request ${id} --effect EFFECT --resolution RESOLUTION`;
    case "checkpoint":
    case "convergence":
      return `baked workflow continue ${runId} --request ${id}`;
  }
}

/** Decisions that still wait for a person. */
export function decisionAdvice(runId: string, pending: readonly RequestRow[]): RecoveryAdvice {
  const ids = named(pending.map((r) => `${r.id} (${r.kind})`));
  const commands = pending
    .slice(0, NAMED)
    .map((r) => `\`${decisionCommand(runId, r)}\``)
    .join(", ");
  const recovery = pending.some((r) => r.kind === "recovery");
  return recoveryAdvice(
    `Pending decisions remain: ${ids}. Answer them, and the run goes on: ${commands}`,
    `Pending decisions remain: ${ids}. Answer them, and the run goes on.`,
    ...(recovery ? [{ action: "recover" as const, runId }] : []),
    { action: "cancel", runId },
  );
}

/** Findings neither resolved nor refuted. */
export function findingsAdvice(
  store: WorkflowStore,
  runId: string,
  open: readonly FindingRow[],
): RecoveryAdvice {
  const ids = named(open.map((f) => `${f.id} (${f.status})`));
  const diagnostic = `Unresolved findings remain: ${ids}`;
  return recoveryAdvice(
    `${diagnostic}. No repair round is left to correct them and a resume runs acceptance on the same findings: fork the run from its review to correct and review the current changes again (\`${forkCommand(store, runId, ["review", "converge"])}\`), revise it (\`baked workflow revise ${runId}\`), or cancel it`,
    `${diagnostic}. Fork the run from its review to correct them, revise it or cancel it.`,
    { action: "fork", runId },
    ...reviseOrCancel(runId),
  );
}

/** A manual criterion without trusted evidence on the current snapshot. */
export function manualAdvice(
  store: WorkflowStore,
  runId: string,
  criterionId: string,
): RecoveryAdvice {
  const diagnostic = `Missing trusted manual evidence for ${criterionId}`;
  const request = store
    .requests(runId)
    .find(
      (r) =>
        r.kind === "manual_evidence" &&
        r.status === "pending" &&
        (JSON.parse(r.body_json) as { criterionId?: string }).criterionId === criterionId,
    );
  const give = request
    ? `give it with \`baked workflow evidence ${runId} --request ${request.id} --file FILE --accept\``
    : `fork the run to ask for it again (\`baked workflow fork ${runId}\`)`;
  return recoveryAdvice(
    `${diagnostic}. A person confirms this criterion: ${give}, revise the run (\`baked workflow revise ${runId}\`), or cancel it`,
    `${diagnostic}. Give the evidence a person confirms, revise the run or cancel it.`,
    ...(request ? [] : [{ action: "fork" as const, runId }]),
    ...reviseOrCancel(runId),
  );
}

/** A criterion acceptance does not count as met. */
export function criterionAdvice(
  store: WorkflowStore,
  runId: string,
  criterionId: string,
  diagnostic: string,
): RecoveryAdvice {
  return recoveryAdvice(
    `${diagnostic}. A resume runs acceptance again on the same evidence: revise the spec or the checks (\`baked workflow revise ${runId}\`), fork the run from its convergence to check ${criterionId} again (\`${forkCommand(store, runId, ["converge", "review"])}\`), or cancel it`,
    `${diagnostic}. Revise the spec or checks, fork the run to check ${criterionId} again, or cancel it.`,
    { action: "revise", runId },
    { action: "fork", runId },
    { action: "cancel", runId },
  );
}

/** Side effects whose outcome the run never recorded. */
export function effectsAdvice(
  store: WorkflowStore,
  runId: string,
  effectIds: readonly string[],
): RecoveryAdvice {
  const diagnostic = `Unreconciled effects remain: ${named(effectIds)}`;
  const asked = store.requests(runId).some((r) => r.kind === "recovery" && r.status === "pending");
  return recoveryAdvice(
    `${diagnostic}. Record whether each one applied with \`baked workflow recover ${runId} --request ID --effect EFFECT --resolution record-applied\` (or \`record-not-applied\`) once its recovery decision is asked, fork the run (\`baked workflow fork ${runId}\`), or cancel it`,
    `${diagnostic}. Record whether each effect applied, fork the run or cancel it.`,
    ...(asked ? [{ action: "recover" as const, runId }] : []),
    { action: "fork", runId },
    { action: "cancel", runId },
  );
}
