import { z } from "zod";
import { WorkflowFault } from "./errors.js";
import type { RunPolicy } from "./schemas.js";
import type { WorkflowStore } from "./store.js";

/**
 * How a stop reason acts (#1714). `enforce` stops the run or declines the approval. `shadow`
 * computes the decision, records a `decision.would_stop` event and goes on; `advisory` does the
 * same and the run screens show it to the person, who is not asked to act. A new or changed
 * reason ships in `shadow` and moves to `enforce` in a PR of its own after bench rounds with no
 * false would-stop, so its first false positive costs a record and not a parked run.
 */
export const STOP_MODES = ["shadow", "advisory", "enforce"] as const;
export type StopMode = (typeof STOP_MODES)[number];

interface StopReason {
  /** What the reason guards, for status and the run screens. */
  label: string;
  /**
   * The modes a policy may give the reason. A hard limit on money, tokens, time or storage that
   * the person set is only enforced: a shadow mode would spend past it.
   */
  modes: readonly StopMode[];
  /** The mode without a `stopModes` entry in the policy. */
  defaultMode: StopMode;
}

const ENFORCED = ["enforce"] as const;
/** A reason that records what it would do and is not enforced yet: its promotion adds `enforce`. */
const NOT_ENFORCED = ["shadow", "advisory"] as const;

/**
 * Every reason the host stops a run on (`BUDGET_EXHAUSTED` faults, made by `stopFault`) or
 * declines an auto-approval for. `tests/stop-reasons.test.ts` fails on a stopping fault made
 * outside `stopFault`, so a new stop site has to register here.
 */
export const STOP_REASONS = {
  "cost-forecast": {
    label: "The run's cost forecast passes its cap",
    modes: STOP_MODES,
    defaultMode: "enforce",
  },
  "approval-scope": {
    label: "The plan has more tasks or files than auto-approval allows",
    modes: STOP_MODES,
    defaultMode: "enforce",
  },
  "check-config-approval": {
    label:
      "A plan edits a linter, formatter or type checker config that auto-approval did not keep with a person before",
    // Shadow by default (#2221): tsconfig and biome were always enforced; every other check
    // config of `CHECK_CONFIGS` records a would-stop until two bench rounds show none false, and
    // `stopModes: { "check-config-approval": "enforce" }` keeps them with a person now.
    modes: STOP_MODES,
    defaultMode: "shadow",
  },
  "initiative-forecast": {
    label: "An initiative's cost or token forecast passes its budget",
    modes: STOP_MODES,
    defaultMode: "enforce",
  },
  "initiative-dollar-share": {
    label: "An initiative's spare dollars are below a starting feature's priced low estimate",
    modes: STOP_MODES,
    defaultMode: "shadow",
  },
  "initiative-dollar-cap": {
    label:
      "No dollars left under an initiative's cap after its open runs' needs pay for a starting feature's low estimate",
    // Shadow only until two bench rounds show no false would-stop (#2218, R70 evalpin's
    // report-cli is a true one); its promotion adds `enforce` and pauses the initiative with the
    // `dollar_cap` reason and its extend remedy instead of starting the feature.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  "initiative-time-share": {
    label:
      "An initiative's shared time left after the other waiting features' low estimates is below a starting feature's low estimate at the measured pace",
    // Shadow only (#2413): the pace counts silent provider time until #2414, which would make an
    // enforced park as wrong as R76's time notices. Its promotion, after #2414 and two bench
    // rounds with no false would-stop, adds `enforce` and parks the start with its extend remedy.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  "initiative-plan-share": {
    label:
      "A started initiative feature run's own sized plan needs more than its share of the token pool, before its first task",
    // Shadow only (#2488): the run goes on under assume as before and the record names the
    // extend that answers it. Its promotion adds `enforce` and parks the feature before its tasks.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  "initiative-row-owner": {
    label:
      "An initiative's split gives a prescribed row file to a feature although one of its rows cites a literal of a feature that depends on it",
    // Shadow by default (#2487): the initiative records `decision.would_stop` when the split is
    // proposed. `stopModes: { "initiative-row-owner": "enforce" }` returns the problem to the
    // decomposer and refuses a split that still has it; making that the default is a pull request
    // of its own after two bench rounds with no false would-stop.
    modes: STOP_MODES,
    defaultMode: "shadow",
  },
  "initiative-plan-charge": {
    label:
      "An initiative's token pool holds an open feature run with a sized plan at its plan's need instead of its run limit",
    // Enforced by default (#2245): it shipped in shadow (#2100, #2056) and R70 and R71 recorded
    // 39 `decision.would_release` records and one would-park, R71 xmlvet's canonical, which was
    // true (the pool ran short 65 minutes later). A charge that parks a feature parks it with the
    // share gate's extend remedy (#2042); `stopModes: { "initiative-plan-charge": "shadow" }`
    // keeps open runs at their limits and records again.
    modes: STOP_MODES,
    defaultMode: "enforce",
  },
  "initiative-pool-growth": {
    label:
      "An open feature run's growth bound is above what the initiative's token pool or dollar ceiling holds for it",
    // Shadow only until two bench rounds show no false would-stop (#2280, R73 flatelens'
    // commands grew to 12.9M with 5.7M left). A bound derived from a plan charge is capped at
    // what the pool and the ceiling hold (`chargeHold`), and the run's own token growth
    // (auto-growth, planning growth, auto-extend) is held at the pool less the other runs' use,
    // enforced since the pool is a limit the person set (`WorkflowStore.tokenHold`, #2468: R79
    // deltaglue's chunks auto-extended past it, which this reason had recorded, a true record).
    // This still records a bound above them (a start's sizing ceilings, a dollar bound, an
    // auto-extend hard ceiling the other runs' later use passed). Its promotion stops or caps
    // the run on those too.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  repeated_failure: {
    label:
      "A corrective's required checks fail exactly as the corrective's before it, or a task ends unfinished on the same failing checks as its previous unfinished end",
    // Shadow only until two bench rounds show no false would-stop (#1996, #2437); its promotion is
    // a pull request of its own that adds `enforce` and blocks the chain, or the unfinished task's
    // resume, before the next session.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  corrective_scope: {
    label: "A corrective cannot write a file its own failing check names",
    // Shadow only until two bench rounds show no false would-stop (#2094); its promotion blocks
    // the corrective at creation and before a resumed session, at 0 tokens.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  corrective_unowned_file: {
    label:
      "A corrective's evidence names a file it may not write: route to its owner, widen, park for an upstream change or block",
    // Shadow by default (#2133): the host's decision (`hostDecision` in corrective-scope.ts) is
    // recorded as a would-stop on a corrective's blocked or failed result and before each of its
    // sessions. `stopModes: { corrective_unowned_file: "enforce" }` acts on it; making that the
    // default is a pull request of its own after two bench rounds with no false would-stop.
    modes: STOP_MODES,
    defaultMode: "shadow",
  },
  upstream_stale_file: {
    label:
      "A corrective's evidence names only a test file of a closed upstream initiative feature: amend it in this feature instead of parking for that feature",
    // Shadow by default (#2485, R80 ratdec representations T007): the `amend` decision of
    // `unownedRule` is recorded as a would-stop and the enforced `corrective_unowned_file` keeps
    // its park. `stopModes: { upstream_stale_file: "enforce" }` (with `corrective_unowned_file`
    // enforced, or a person's `upstream` remedy) adds the file to the feature's boundary and the
    // corrective's writes (`hostAmend`); making that the default is a pull request of its own
    // after two bench rounds with no false would-stop.
    modes: STOP_MODES,
    defaultMode: "shadow",
  },
  upstream_symbol: {
    label:
      "A released planned-ahead feature's spec names a symbol of an upstream feature that the accepted upstream code does not have",
    // Shadow only until two bench rounds show no false would-stop (#2135); its promotion sends
    // the feature back to specify at release, before any implementer starts.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  repeat_without_change: {
    label: "A finding comes back after its corrective changed no file",
    // Shadow only until two bench rounds show no false would-stop (#2137); its promotion asks for
    // an owner or scope decision instead of opening another corrective of the same finding.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  chain_rewrite_repeat: {
    label:
      "A finding chain's next case comes after two rewrites of its symbol or family: the convergence ask instead of a third corrective",
    // Shadow only until two bench rounds show no false would-stop (#2568, R83 md-site's
    // `findDelimited`: T012 and T013 rewrote it and review found the next member); its promotion
    // asks the person to converge with `rewrites` and the family, and the convergence gate reads
    // `rewrites`, instead of opening the corrective.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  repro_blind: {
    label:
      "A corrective's repro prints the same output after the attempt changed the finding's file, and reads a path outside its root",
    // Shadow only until a bench round shows no false would-stop (#2287); its promotion makes such
    // a repro inconclusive for the attempt instead of reproduced, so it no longer sends it back.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  generated_case: {
    label:
      "A task's tests build their inputs from generated values where the request or a criterion asks for literal examples",
    // Enforced (#2469) after R77 and R79 recorded only true would-stops (#2344): R79 deltaglue
    // chunks T002's record preceded 8.28M tokens of correctives that a review finding opened for
    // the same generated inputs. The case walk refuses the task with the files and lines of the
    // generated values, in the session that wrote them; it applies only where the request or the
    // task's criteria ask for literal examples (`bannedGeneratedKinds`). R78 deltaglue cli T008's
    // record was false (expected stderr interpolating `mkdtemp` paths, the literal rows held), so a
    // value built only from a path made at run time is no longer generated (`RUNTIME_PATH_SOURCES`).
    // `shadow` records instead.
    modes: STOP_MODES,
    defaultMode: "enforce",
  },
  corrective_restores_removed: {
    label: "A corrective puts back what the previous corrective of the file removed",
    // Shadow only until two bench rounds show no false would-stop (#2277); its promotion opens a
    // spec conflict naming both correctives' findings instead of a third corrective.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  written_tests_unselected: {
    label:
      "A written-tests check selected by the test classes its files declare ran no test: the host's filter, not the task's tests",
    // Shadow only until two bench rounds show no false would-stop (#2363, R75 maskback's
    // `FullyQualifiedName~UnitTest1.` ran nothing for `FailureExceptionTests`); its promotion fails
    // the check as the host's (inconclusive, the filter in its message) instead of a corrective.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  edge_crash_finding: {
    label: "A probed case crashes inside a file the probed code's task writes",
    // Shadow only until two bench rounds show no false would-stop (#2136); its promotion makes
    // the crash a finding of that task (its first error line as actual), corrected at once.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  baseline_unrepairable: {
    label:
      "A required check fails before any change on files no task writes, and the host fixer cannot repair it",
    // Shadow only until two bench rounds show no false would-stop (#2215); its promotion stops
    // the run before its first task instead of at the checks stage after all of them.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  upstream_baseline_debt: {
    label:
      "A required check fails on the base a feature starts its tasks from, in files an accepted upstream feature owns",
    // Shadow only until two bench rounds show no false would-stop (#2228, R70 namesound docs); its
    // promotion asks the upstream owner for an amendment (`amendmentAnswer`) instead of releasing
    // or starting a feature that cannot pass.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  baseline_signature: {
    label:
      "A required check fails as before any change once durations, addresses, seeds and temporary paths are compared by shape",
    // Shadow only until two bench rounds show no false would-stop (#2295); its promotion makes the
    // shaped signature decide the `baseline_failure` stop (through `stopFault`) and the task-end
    // excuse, where the live signature still tells two runs of one failure apart.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  ci_check_drift: {
    label:
      "A CI workflow or README the run wrote runs a gate command that no configured check runs as written",
    // Shadow only until two bench rounds show no false would-stop (#2284, R73 evalpin's ci.yml ran
    // `cargo clippy --all-targets`, its clippy check did not); its promotion makes the drift a
    // finding of the task that wrote the file at the checks stage.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  host_content_conflict: {
    label:
      "A task-level corrective the host writes itself would write its files with the content they already hold",
    // Shadow only until two bench rounds show no false would-stop (#2456, R78 pairwick cli: three
    // host correctives rewrote a Main.scala that scalafmt cannot parse); its promotion blocks the
    // run at once with the conflict between the request's content and the project's check.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  fixer_unusable: {
    label:
      "A required check's fixer fails and changes nothing on a file of the base, where its check passes",
    // Shadow only until two bench rounds show no false would-stop (#2442, R77 pairwick's
    // `sbt scalafmtAll <file>`); its promotion stops the run before its first task with the
    // fixer's output, instead of letting implementers call a fixer that cannot run.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  worktree_environment: {
    label:
      "A run's task worktree path is longer than a project language's test tool handles on this platform",
    // Shadow only until two bench rounds show no false would-stop (#2454, R78 latcell-update's
    // `dart test` at a 94-character worktree on Windows); its promotion stops the run before its
    // first task with the path's length and the remedies, instead of paying correctives that
    // cannot shorten a path.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  supplied_drift: {
    label:
      "A file a task delivered differs from the block the request gives for it verbatim (a whole file, a Markdown section or an exact diff)",
    // Shadow only until two bench rounds show no false would-stop (#2332, R74 ewvet-update's README
    // printf example with a doubled backslash); its promotion makes the mismatch a finding of
    // severity high on the task's file at the checks stage, which a repair task rewrites.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  row_block_drift: {
    label:
      "A test file the run delivered lacks a quoted literal of a row the request prescribes for it, or holds a row beyond them",
    // Shadow only until two bench rounds show no false would-stop (#2486, R80 deltaglue cli T010
    // dropped row 2's final `data: [DONE]` event, ratdec core T014 rewrote a stdin row; #2503, R81
    // ratdec exact-cli T011 added a 14th row to 13 prescribed); its promotion makes the row a
    // finding of severity high on the file at the checks stage, which a repair task restores from
    // the request's row (or a host removal of the added line).
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  case_not_prescribed: {
    label:
      "A criterion cites a literal that no row the request prescribes holds, for a task that writes only prescribed row files",
    // Shadow only (#2501): the case walk no longer refuses such a task (it cannot add a row to a
    // file the request fixes row for row; R81 ratdec exact-cli T011 added one and a corrective
    // removed it, 368k), and records the criterion and literal instead; analysis lists them as a
    // note. Its promotion, after two bench rounds with no false would-stop, makes that analysis
    // finding blocking, so the spec author removes the example row from the criterion.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  committed_tree: {
    label:
      "A required static check that passed on the working tree fails on a clean worktree of the feature's commit",
    // Shadow only until two bench rounds show no false would-stop (#2225, R70 namesound's rubocop
    // passed on CRLF files whose committed LF form failed); its promotion makes the failure a
    // finding of the feature that blocks its acceptance.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  test_cap: {
    label:
      "A test file a task writes declares more tests than the brief's per-file or per-class cap",
    // Shadow by default (#2368, R75 latcell's commands spent 1.86M tokens on correctives over a
    // cap of 12 `test(...)` blocks per file that only the reviewer checked): the task-end check
    // records a would-stop per file or class over the cap. `stopModes: { test_cap: "enforce" }`
    // sends the submission back naming the file, its count and the cap; making that the default
    // is a pull request of its own after two bench rounds with no false would-stop.
    modes: STOP_MODES,
    defaultMode: "shadow",
  },
  silent_check_failure: {
    label:
      "A required check fails with no failure line of its toolchain in its output: the host would run it once more before opening a correction",
    // Shadow by default (#2418, R76 hintsieve: `swift test` exited 4 with SwiftPM progress lines
    // only, opened a 440k-token corrective whose diff was empty, and passed on the next run). The
    // checks stage records `decision.would_rerun`. `stopModes: { silent_check_failure: "enforce" }`
    // re-runs the check once: a pass is an inconclusive flake and opens nothing, a second failure
    // opens the correction as before. Making that the default is a pull request of its own.
    modes: STOP_MODES,
    defaultMode: "shadow",
  },
  attempt_green_checkpoint: {
    label:
      "An attempt ended unfinished after its required checks failed on edits past a state where every one passed: the host would finish the task from that state",
    // Shadow only (#2470, R79 deltaglue chunks T004: every required check passed at 23:19:17,
    // two more edits failed them and the attempt ended at its all-token cap at 23:19:40, the
    // run's third `attempt_cap` block). It records `decision.would_finish` from the attempt's
    // checkpoint; restoring that state and finishing the task is a pull request of its own after
    // a bench round with no false would-finish.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  "host-resume-on-stored-limit": {
    label:
      "A run blocked on its own active time, tokens or calls whose stored limits now exceed its usage: the host would resume it once",
    // Shadow only (#2226, R70 namesound soundex: the stored limit was raised 6 s after the
    // deadline stopped the attempt and the run waited 29 minutes 52 seconds for an owner's
    // plain resume). It records `decision.would_resume`; resuming for real is a pull request
    // of its own after two bench rounds with no false would-resume.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  "host-settle-interrupted-check": {
    label:
      "A check's command of unknown outcome whose process is gone: the host would settle it as not applied and run the check again at its stage",
    // Shadow only (#2415, R76 schemamask: the laptop slept mid-check and two feature runs sat
    // `waiting interrupted_effect` for a person's `recover --resolution retry`). It records
    // `decision.would_resume` from `noteInterruptedChecks` in recovery.ts and leaves the request
    // with the person; settling for real is a pull request of its own after two bench rounds
    // with no false would-resume.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  cost_refusal_wait: {
    label:
      "A run past its tasks refused a review or convergence call on its cost ceiling, with a priced extend remedy: it would wait for the extension instead of blocking",
    // Shadow only until two bench rounds show no false would-stop (#2249, R71 xmlvet get-command
    // blocked 24 minutes at its first review call while cli-release, planned ahead, waited on it).
    // The run still blocks; its promotion leaves it `waiting` on a request a person answers with
    // the extend remedy, and its planned-ahead dependants count it as waiting, not stalled.
    modes: NOT_ENFORCED,
    defaultMode: "shadow",
  },
  cost: {
    label: "Spent and reserved dollars reach the cost cap",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
  "run-budget": {
    label: "The run's token, call or active-time budget is used up",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
  budget_exhausted: {
    label: "A task is stopped by the run budget before its first edit",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
  attempt_cap: {
    label: "An attempt reaches its token cap without a result",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
  context_window: {
    label: "The required context exceeds the model's window",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
  deadline: {
    label: "The run's active deadline passes",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
  "evidence-size": {
    label: "An artifact or the run's evidence passes its size cap",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
  "walkthrough-steps": {
    label: "A walk-through passes its step limit",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
  "budget-share": {
    label: "An initiative has no budget share left for a feature",
    modes: ENFORCED,
    defaultMode: "enforce",
  },
} as const satisfies Record<string, StopReason>;

export type StopReasonId = keyof typeof STOP_REASONS;
const STOP_REASON_IDS = Object.keys(STOP_REASONS) as [StopReasonId, ...StopReasonId[]];
export const StopReasonIdSchema = z.enum(STOP_REASON_IDS);

/** A policy's `stopModes`: only modes a reason allows. Absent keeps every default. */
export const StopModesSchema = z
  .partialRecord(StopReasonIdSchema, z.enum(STOP_MODES))
  .superRefine((modes, ctx) => {
    for (const [id, mode] of Object.entries(modes) as [StopReasonId, StopMode][])
      if (!(STOP_REASONS[id].modes as readonly StopMode[]).includes(mode))
        ctx.addIssue({
          code: "custom",
          path: [id],
          message: (STOP_REASONS[id].modes as readonly StopMode[]).includes("enforce")
            ? `${id} is a hard limit and can only be enforced`
            : `${id} records what it would stop in shadow or advisory mode and cannot be enforced yet`,
        });
  });

/**
 * The mode of a reason under a policy. `costForecast: "advise"` (an initiative's feature runs,
 * #1659) is the advisory forecast; an explicit `stopModes` entry wins.
 */
export function stopMode(
  policy: Pick<RunPolicy, "stopModes" | "costForecast">,
  id: StopReasonId,
): StopMode {
  const explicit = policy.stopModes?.[id];
  if (explicit) return explicit;
  if (id === "cost-forecast" && policy.costForecast === "advise") return "advisory";
  return STOP_REASONS[id].defaultMode;
}

/** The fault that stops a run on a registered reason, as `details.reason`. */
export function stopFault(
  id: StopReasonId,
  message: string,
  details: Record<string, unknown> = {},
): WorkflowFault {
  return new WorkflowFault("BUDGET_EXHAUSTED", message, { reason: id, ...details });
}

export interface WouldStop {
  reason: StopReasonId;
  mode: Exclude<StopMode, "enforce">;
  /** One record per key and reason: a forecast is checked before every attempt. */
  key: string;
  /** What `enforce` would have done, in the words of its stop. */
  summary: string;
  inputs: Record<string, unknown>;
}

/**
 * Records that a reason in `shadow` or `advisory` would have stopped the run, once per key.
 * Returns whether it was recorded now.
 */
export function recordWouldStop(store: WorkflowStore, runId: string, stop: WouldStop): boolean {
  const seen = store
    .eventsOfType(runId, "decision.would_stop")
    .some(
      (e) =>
        e.type === "decision.would_stop" &&
        e.payload.reason === stop.reason &&
        e.payload.key === stop.key,
    );
  if (seen) return false;
  store.emit(runId, {
    type: "decision.would_stop",
    payload: {
      reason: stop.reason,
      mode: stop.mode,
      key: stop.key.slice(0, 200),
      summary: stop.summary.slice(0, 1000),
      inputs: stop.inputs,
    },
  });
  return true;
}

export interface WouldStopSummary {
  reason: StopReasonId;
  label: string;
  mode: Exclude<StopMode, "enforce">;
  count: number;
  /** The latest would-stop of the reason. */
  last: { at: string; summary: string };
}

/** The run's would-stop records by reason, for `workflow status` and the run view. */
export function wouldStopSummary(store: WorkflowStore, runId: string): WouldStopSummary[] {
  const byReason = new Map<StopReasonId, WouldStopSummary>();
  for (const event of store.eventsOfType(runId, "decision.would_stop")) {
    if (event.type !== "decision.would_stop") continue;
    const { reason, mode, summary } = event.payload;
    const entry = byReason.get(reason);
    byReason.set(reason, {
      reason,
      label: STOP_REASONS[reason].label,
      mode,
      count: (entry?.count ?? 0) + 1,
      last: { at: event.at, summary },
    });
  }
  return [...byReason.values()];
}

/** The state a cost refusal of a run past its tasks would leave it in (#2249). */
export interface CostRefusalWait {
  state: "waiting";
  /** The state the run takes today. */
  instead: "blocked";
  stageId: string | null;
  /** The stages after the tasks still to run, as the fault priced them. */
  stages: string[];
  suggestedUsd: number;
  spentUsd: number | null;
  requestedUsd: number | null;
  ceilingUsd: number | null;
}

/**
 * What a cost refusal of a run past its tasks would leave the run as (#2249): `waiting` on the
 * extend remedy its fault carries, instead of `blocked`. Decided only here, from the fault's
 * recovery and the stage it stopped in, and called only by the scheduler's fault handler, never
 * per stage: a review dimension, the review stage and convergence all reach it through the one
 * `cost` fault `assertCostFits` throws. Null for any other stop, for a refusal without a priced
 * `extend` remedy (the store names one only when the run finished its tasks and its remaining
 * stages have a price) and for a stage outside the stages the fault says remain.
 */
export function costRefusalWait(fault: unknown, stageId: string | null): CostRefusalWait | null {
  if (!(fault instanceof WorkflowFault) || fault.code !== "BUDGET_EXHAUSTED") return null;
  const details = fault.details;
  if (details.reason !== "cost") return null;
  const recovery = details.recovery as { remedies?: unknown } | undefined;
  const remedies = Array.isArray(recovery?.remedies) ? recovery.remedies : [];
  const extend = remedies.find(
    (r): r is { action: "extend"; suggestedUsd: number } =>
      typeof r === "object" &&
      r !== null &&
      (r as { action?: unknown }).action === "extend" &&
      typeof (r as { suggestedUsd?: unknown }).suggestedUsd === "number" &&
      (r as { suggestedUsd: number }).suggestedUsd > 0,
  );
  if (!extend) return null;
  const stages = Array.isArray(details.stages)
    ? details.stages.filter((s): s is string => typeof s === "string")
    : [];
  if (stageId && stages.length && !stages.includes(stageId)) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    state: "waiting",
    instead: "blocked",
    stageId,
    stages,
    suggestedUsd: extend.suggestedUsd,
    spentUsd: num(details.spentUsd),
    requestedUsd: num(details.requestedUsd),
    ceilingUsd: num(details.ceilingUsd),
  };
}

/** The `cost_refusal_wait` record of a blocked run's latest stop, or null (#2249). */
export function costRefusalWaitOf(
  store: WorkflowStore,
  runId: string,
): (CostRefusalWait & { mode: Exclude<StopMode, "enforce"> }) | null {
  const latest = store
    .artifacts(runId)
    .filter((a) => a.kind === "diagnostic" && a.logical_path.startsWith("errors/"))
    .at(-1);
  if (!latest) return null;
  for (const event of store.eventsOfType(runId, "decision.would_stop")) {
    if (event.type !== "decision.would_stop") continue;
    const { reason, key, mode, inputs } = event.payload;
    if (reason === "cost_refusal_wait" && key === `stop-${latest.id}`)
      return { ...(inputs as unknown as CostRefusalWait), mode };
  }
  return null;
}

/** The run's own limits a `budget_exhausted` block can be held by (#2226). */
export type HeldLimit = "active" | "tokens" | "calls";

/**
 * What a `budget_exhausted` block on the run's own limits held, recorded at the block under
 * `limit-blocks/<diagnostic id>.json` (#2226): the drive's limits it decided on, the run's usage
 * and the call it refused.
 */
export interface LimitBlock {
  /** The stop reason of the fault: the active-time deadline or the store's reservation. */
  stop: "deadline" | "run-budget";
  diagnosticId: string;
  blockedAt: string;
  limits: { maxActiveMs: number; maxTotalTokens: number; maxAgentCalls: number };
  usage: { activeMs: number; usedTokens: number; reservedTokens: number; agentCalls: number };
  /** Tokens the refused call asked for; 0 for a block that was not on tokens. */
  requestedTokens: number;
  held: HeldLimit[];
}

export const LIMIT_BLOCK_PREFIX = "limit-blocks/";

/**
 * The record of a block on the run's own active time, tokens or calls, or null for any other
 * stop (#2226). `limits` are the drive's copy the stop decided on, `run` the run's row.
 */
export function limitBlockOf(
  fault: unknown,
  diagnosticId: string,
  limits: LimitBlock["limits"],
  run: { active_ms: number; token_usage: number; agent_calls: number },
  at: Date = new Date(),
): LimitBlock | null {
  if (!(fault instanceof WorkflowFault) || fault.code !== "BUDGET_EXHAUSTED") return null;
  const d = fault.details;
  if (d.reason !== "deadline" && d.reason !== "run-budget") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const usage = {
    activeMs: Math.max(run.active_ms, num(d.activeMs)),
    usedTokens: Math.max(run.token_usage, num(d.usedTokens)),
    reservedTokens: num(d.reservedTokens),
    agentCalls: Math.max(run.agent_calls, num(d.agentCalls)),
  };
  const requestedTokens = num(d.requestedTokens);
  const held: HeldLimit[] = [];
  if (d.reason === "deadline" || usage.activeMs >= limits.maxActiveMs) held.push("active");
  if (d.reason === "run-budget") {
    if (usage.agentCalls >= limits.maxAgentCalls) held.push("calls");
    if (usage.usedTokens + usage.reservedTokens + requestedTokens > limits.maxTotalTokens)
      held.push("tokens");
  }
  if (!held.length) return null;
  return {
    stop: d.reason,
    diagnosticId,
    blockedAt: at.toISOString(),
    limits,
    usage,
    requestedTokens: held.includes("tokens") ? requestedTokens : 0,
    held,
  };
}

/** The decision over a limit block and the run's stored limits and usage now (#2226). */
export interface StoredLimitResume {
  wouldResume: boolean;
  held: HeldLimit[];
  /** The stored limits now, against which the run's usage now is compared. */
  stored: LimitBlock["limits"];
  usage: { activeMs: number; usedTokens: number; agentCalls: number };
  /** What the limits were when the run blocked. */
  atBlock: LimitBlock["limits"];
  requestedTokens: number;
  blockedAt: string;
}

/**
 * Whether the host would resume a run blocked on its own limits once (#2226): every stored limit
 * now exceeds the run's usage, and the token limit also fits the call the block refused. Decided
 * only here, from the block's record, the stored policy and the run's row, so the drive's block
 * and the initiative's round decide alike.
 */
export function storedLimitResume(
  block: LimitBlock,
  stored: Pick<RunPolicy, "maxActiveMs" | "maxTotalTokens" | "maxAgentCalls">,
  run: { active_ms: number; token_usage: number; agent_calls: number },
): StoredLimitResume {
  const usage = {
    activeMs: Math.max(run.active_ms, block.usage.activeMs),
    usedTokens: run.token_usage,
    agentCalls: Math.max(run.agent_calls, block.usage.agentCalls),
  };
  const limits = {
    maxActiveMs: stored.maxActiveMs,
    maxTotalTokens: stored.maxTotalTokens,
    maxAgentCalls: stored.maxAgentCalls,
  };
  const wouldResume =
    limits.maxActiveMs > usage.activeMs &&
    limits.maxAgentCalls > usage.agentCalls &&
    limits.maxTotalTokens > usage.usedTokens &&
    limits.maxTotalTokens >= usage.usedTokens + block.requestedTokens;
  return {
    wouldResume,
    held: block.held,
    stored: limits,
    usage,
    atBlock: block.limits,
    requestedTokens: block.requestedTokens,
    blockedAt: block.blockedAt,
  };
}

/**
 * Records `decision.would_resume` for a run blocked `budget_exhausted` on its own limits whose
 * stored limits now exceed its usage (`host-resume-on-stored-limit`, shadow, #2226), once per
 * block. Called where a blocked run is looked at again: the drive right after it blocks (a
 * growth that landed between the timer's stop and the block record) and the initiative's round
 * over its feature runs (a growth after the block). Never resumes. Returns whether it recorded.
 */
export function noteStoredLimitResume(
  store: WorkflowStore,
  runId: string,
  at: "drive" | "initiative-round",
): boolean {
  const run = store.run(runId);
  if (run.status !== "blocked" || run.reason !== "budget_exhausted") return false;
  const artifacts = store.artifacts(runId);
  const latest = artifacts
    .filter((a) => a.kind === "diagnostic" && a.logical_path.startsWith("errors/"))
    .at(-1);
  if (!latest) return false;
  const record = artifacts.find((a) => a.logical_path === `${LIMIT_BLOCK_PREFIX}${latest.id}.json`);
  if (!record) return false;
  const key = `stop-${latest.id}`;
  const seen = store
    .eventsOfType(runId, "decision.would_resume")
    .some(
      (e) =>
        e.type === "decision.would_resume" &&
        e.payload.reason === "host-resume-on-stored-limit" &&
        e.payload.key === key,
    );
  if (seen) return false;
  const policy = JSON.parse(run.policy_json) as RunPolicy;
  const mode = stopMode(policy, "host-resume-on-stored-limit");
  if (mode === "enforce") return false;
  const block = JSON.parse(store.readArtifact(runId, record.id)) as LimitBlock;
  const decision = storedLimitResume(block, policy, run);
  if (!decision.wouldResume) return false;
  const named = decision.held
    .map((limit) =>
      limit === "active"
        ? `${String(decision.usage.activeMs)} ms active of the stored ${String(decision.stored.maxActiveMs)} ms limit (${String(decision.atBlock.maxActiveMs)} ms at the block)`
        : limit === "calls"
          ? `${String(decision.usage.agentCalls)} calls of the stored ${String(decision.stored.maxAgentCalls)} (${String(decision.atBlock.maxAgentCalls)} at the block)`
          : `${String(decision.usage.usedTokens)} tokens and ${String(decision.requestedTokens)} asked of the stored ${String(decision.stored.maxTotalTokens)} (${String(decision.atBlock.maxTotalTokens)} at the block)`,
    )
    .join("; ");
  store.emit(runId, {
    type: "decision.would_resume",
    payload: {
      reason: "host-resume-on-stored-limit",
      mode,
      key,
      summary:
        `The host would resume the run once: its stored limits now exceed its usage (${named}).`.slice(
          0,
          1000,
        ),
      inputs: { ...decision, at, diagnosticId: latest.id },
    },
  });
  return true;
}

/**
 * Records `decision.would_rerun` for a required check whose failure printed no failure line
 * (`silent_check_failure`, shadow, #2418), once per check run. Returns whether it recorded now.
 */
export function recordWouldRerun(
  store: WorkflowStore,
  runId: string,
  rerun: Omit<WouldStop, "reason">,
): boolean {
  const seen = store
    .eventsOfType(runId, "decision.would_rerun")
    .some((e) => e.type === "decision.would_rerun" && e.payload.key === rerun.key);
  if (seen) return false;
  store.emit(runId, {
    type: "decision.would_rerun",
    payload: {
      reason: "silent_check_failure",
      mode: rerun.mode,
      key: rerun.key.slice(0, 200),
      summary: rerun.summary.slice(0, 1000),
      inputs: rerun.inputs,
    },
  });
  return true;
}

/**
 * Records `decision.would_finish` for an attempt that ended unfinished after a state on which
 * every required check passed (`attempt_green_checkpoint`, shadow, #2470), once per key. Returns
 * whether it recorded now.
 */
export function recordWouldFinish(
  store: WorkflowStore,
  runId: string,
  finish: Omit<WouldStop, "reason">,
): boolean {
  const seen = store
    .eventsOfType(runId, "decision.would_finish")
    .some((e) => e.type === "decision.would_finish" && e.payload.key === finish.key);
  if (seen) return false;
  store.emit(runId, {
    type: "decision.would_finish",
    payload: {
      reason: "attempt_green_checkpoint",
      mode: finish.mode,
      key: finish.key.slice(0, 200),
      summary: finish.summary.slice(0, 1000),
      inputs: finish.inputs,
    },
  });
  return true;
}
