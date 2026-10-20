/**
 * The progress watcher of an agent attempt: plain rules over the attempt's own steps that notice
 * a stuck loop. The step controller turns a first signal into one steering message and a repeat
 * into an early, reasoned stop, instead of letting the attempt burn its step or token cap.
 */
import { canonical } from "../specs/hash.js";

export type WatchSignal =
  | "repeated-reads"
  | "no-edits"
  | "same-failure"
  | "no-edit-tool"
  | "unchecked-spend";
export interface WatchFinding {
  signal: WatchSignal;
  /** One sentence for the steering message, the event and the activity feed. */
  detail: string;
}
export interface WatchStep {
  /** The step's own text, where a worker says what it cannot do. */
  text?: string;
  toolCalls?: readonly { toolName: string; input?: unknown }[];
  toolResults?: readonly { toolName: string; output?: unknown }[];
}

const READ_TOOLS = new Set(["read", "navigate", "bake_find", "bake_impact"]);
export const EDIT_TOOLS = new Set([
  "edit_file",
  "multi_edit",
  "delete_file",
  "write_file",
  "write_test",
  "apply_fix",
]);
const CHECK_TOOLS = new Set(["request_check", "run_probe", "run_repro"]);
/** The same read since the last edit, this many times. */
export const REPEATED_READS = 3;
/** Steps with tool calls and no edit, for an attempt that must edit. */
export const NO_EDIT_STEPS = 10;
/** The same check output in a row, this many times. */
export const SAME_FAILURES = 3;
/** The share of its token cap an attempt may spend before it checks or submits its edits. */
export const UNCHECKED_SPEND_SHARE = 0.5;

const short = (value: unknown): string => {
  const text = canonical(value ?? null);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
};

/** The first rule the steps break, checked in a fixed order; null while the attempt progresses. */
export function watchSteps(
  steps: readonly WatchStep[],
  options: {
    mustEdit: boolean;
    /** Capped tokens the attempt used so far and its cap, for `unchecked-spend`. */
    spend?: { used: number; cap: number };
  },
): WatchFinding | null {
  let lastEdit = -1;
  steps.forEach((step, index) => {
    if (step.toolCalls?.some((call) => EDIT_TOOLS.has(call.toolName))) lastEdit = index;
  });
  const since = steps.slice(lastEdit + 1);
  const reads = new Map<string, number>();
  for (const step of since)
    for (const call of step.toolCalls ?? []) {
      if (!READ_TOOLS.has(call.toolName)) continue;
      const key = `${call.toolName} ${canonical(call.input ?? null)}`;
      const count = (reads.get(key) ?? 0) + 1;
      reads.set(key, count);
      if (count >= REPEATED_READS)
        return {
          signal: "repeated-reads",
          detail: `${call.toolName} ${short(call.input)} was called ${count} times with the same input since the last edit`,
        };
    }
  const checks = steps
    .flatMap((step) => step.toolResults ?? [])
    .filter((result) => CHECK_TOOLS.has(result.toolName));
  const tail = checks.slice(-SAME_FAILURES);
  if (
    tail.length === SAME_FAILURES &&
    tail.every(
      (r) => r.toolName === tail[0]?.toolName && canonical(r.output) === canonical(tail[0]?.output),
    )
  )
    return {
      signal: "same-failure",
      detail: `${tail[0]?.toolName} returned the same result ${SAME_FAILURES} times in a row`,
    };
  if (options.mustEdit) {
    const busy = since.filter((step) => (step.toolCalls ?? []).length > 0).length;
    if (busy >= NO_EDIT_STEPS)
      return {
        signal: "no-edits",
        detail: `${busy} steps without an edit${lastEdit >= 0 ? " since the last one" : ""}`,
      };
  }
  // Half the cap spent with edits no check has run on since: md-site T075 (bench round 52) ended
  // at its uncached cap after 1.22M tokens, 2 edits and no submission, and its restart spent as
  // much again for a 710-byte fix (#1764).
  const spend = options.spend;
  if (
    options.mustEdit &&
    spend &&
    spend.cap > 0 &&
    spend.used >= UNCHECKED_SPEND_SHARE * spend.cap
  ) {
    let lastCheck = -1;
    steps.forEach((step, index) => {
      if (step.toolCalls?.some((call) => CHECK_TOOLS.has(call.toolName))) lastCheck = index;
    });
    if (lastEdit >= 0 && lastCheck < lastEdit)
      return {
        signal: "unchecked-spend",
        detail: `${Math.round((100 * spend.used) / spend.cap)}% of this attempt's token cap is spent and the latest edits were never checked`,
      };
  }
  return null;
}

/** The steering message for a first signal. */
export function steeringNotice(finding: WatchFinding): string {
  const advice: Record<WatchSignal, string> = {
    "repeated-reads":
      "What you read is already in your context; do not read it again. Apply the change now, or call submit_result with what is unresolved.",
    "no-edits":
      "Apply the edits the task needs now with multi_edit or edit_file, or call submit_result with what blocks you as unresolved.",
    "same-failure":
      "Running it again will not change the result. Change the code or the approach before the next run, or call submit_result with the failure as unresolved.",
    "no-edit-tool":
      "Call one of these tools now to apply the change; they are in this session's tool list.",
    "unchecked-spend":
      "Do not read more. Run request_check (or run_repro on the finding's repro) on your edits now, then call submit_result; when a check still fails, submit with the failure as unresolved so the next attempt continues from your edits.",
  };
  return `Progress watcher: ${finding.detail}. ${advice[finding.signal]} If the same pattern continues, the host ends this attempt early.`;
}

/**
 * Whether the pattern the watcher steered on went on in the steps after the steering message:
 * an edit counts as progress and clears it (a check, for `unchecked-spend`); otherwise a repeated read of the same input, the same
 * check result again, or `stopAfter` more steps without an edit for `no-edits`.
 */
export function stillStuck(
  finding: WatchFinding,
  steps: readonly WatchStep[],
  steeredAt: number,
  stopAfter: number,
): "stuck" | "progress" | "waiting" {
  const before = steps.slice(0, steeredAt);
  const after = steps.slice(steeredAt);
  // Only a check clears unchecked spend; another edit without one is more of the same.
  if (finding.signal === "unchecked-spend")
    return after.some((step) => step.toolCalls?.some((call) => CHECK_TOOLS.has(call.toolName)))
      ? "progress"
      : after.filter((step) => (step.toolCalls ?? []).length > 0).length >= stopAfter
        ? "stuck"
        : "waiting";
  if (after.some((step) => step.toolCalls?.some((call) => EDIT_TOOLS.has(call.toolName))))
    return "progress";
  if (after.length < 1) return "waiting";
  if (finding.signal === "no-edits")
    return after.filter((step) => (step.toolCalls ?? []).length > 0).length >= stopAfter
      ? "stuck"
      : "waiting";
  if (finding.signal === "repeated-reads") {
    const key = (call: { toolName: string; input?: unknown }) =>
      `${call.toolName} ${canonical(call.input ?? null)}`;
    const seen = new Set(
      before.flatMap((step) =>
        (step.toolCalls ?? []).filter((c) => READ_TOOLS.has(c.toolName)).map(key),
      ),
    );
    return after.some((step) =>
      (step.toolCalls ?? []).some((call) => READ_TOOLS.has(call.toolName) && seen.has(key(call))),
    )
      ? "stuck"
      : after.length >= stopAfter
        ? "progress"
        : "waiting";
  }
  const last = before
    .flatMap((step) => step.toolResults ?? [])
    .filter((r) => CHECK_TOOLS.has(r.toolName))
    .at(-1);
  return after.some((step) =>
    (step.toolResults ?? []).some(
      (r) =>
        r.toolName === last?.toolName &&
        canonical(r.output ?? null) === canonical(last?.output ?? null),
    ),
  )
    ? "stuck"
    : after.length >= stopAfter
      ? "progress"
      : "waiting";
}

/**
 * The steps whose text says an edit tool is missing although none was called since, for a
 * session that has edit tools (#1360). md-site 4b08acf6 T006 (bench round 35): a restarted
 * session read for 805k tokens and ended blocked with "This runtime exposes no BAKED edit_file or
 * multi_edit tool", although the attempt before it had used both.
 */
export function missingToolClaims(
  steps: readonly WatchStep[],
  claims: (text: string) => boolean,
): number[] {
  const found: number[] = [];
  steps.forEach((step, index) => {
    if (step.toolCalls?.some((call) => EDIT_TOOLS.has(call.toolName))) found.length = 0;
    else if (step.text && claims(step.text)) found.push(index);
  });
  return found;
}
