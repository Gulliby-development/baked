/**
 * The progress watcher of an agent attempt: plain rules over the attempt's own steps that notice
 * a stuck loop. The step controller turns a first signal into one steering message and a repeat
 * into an early, reasoned stop, instead of letting the attempt burn its step or token cap.
 */
import { canonical, hashJson } from "../specs/hash.js";
import { normalizeCheckOutput } from "./repeated-failure.js";

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
  toolResults?: readonly { toolName: string; input?: unknown; output?: unknown }[];
}

const READ_TOOLS = new Set(["read", "navigate", "bake_find", "bake_impact"]);
export const EDIT_TOOLS = new Set([
  "edit_file",
  "multi_edit",
  "delete_file",
  "write_file",
  "write_test",
  "apply_fix",
  "restore_file",
]);
/**
 * The tools whose result is a check result the watcher compares (`checkResultKey`); `apply_fix`
 * also returns one, as its `check` part. A tool added here adds its real result shape to the
 * fixtures of `tests/workflow-progress-watch.test.ts`, which fails without it (#2437).
 */
export const CHECK_TOOLS: ReadonlySet<string> = new Set([
  "request_check",
  "run_probe",
  "run_repro",
  "replay_rows",
]);
/** An edit tool whose result carries the check it ran after the edit (`check`). */
const FIX_TOOL = "apply_fix";
/** The same read since the last edit, this many times. */
export const REPEATED_READS = 3;
/** Steps with tool calls and no edit, for an attempt that must edit. */
export const NO_EDIT_STEPS = 10;
/** The same check output in a row, this many times. */
export const SAME_FAILURES = 3;
/** The share of its token cap an attempt may spend before it checks or submits its edits. */
export const UNCHECKED_SPEND_SHARE = 0.5;
/**
 * Steps after the steering message that never count toward a stop (#1978). The watcher measures
 * time in model steps: the step sent with the steering is the worker's first answer to it, and
 * may re-read the file it now edits or re-run the check once. md-site 54da0241 (bench round 63)
 * was stopped 14 s after the steering, before one full step had followed it.
 */
export const STEER_GRACE_STEPS = 1;

const short = (value: unknown): string => {
  const text = canonical(value ?? null);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
};

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;

/**
 * What two results of one check have in common when they fail the same way: the tool, the check
 * (its id, or the probe's input), the status and the hash of the output as `normalizeCheckOutput`
 * reads it. Never the whole result: a `request_check` result carries an `evidenceId` and a
 * `snapshotId` new for every run, and the output timings (sbt's `elapsed time: 4 s`), so two
 * identical failures never compared equal and `same-failure` never fired (R77 pairwick, #2437).
 * The `check` part of an `apply_fix` result counts as a `request_check` result of its check. Null
 * for a result that is no check result.
 */
export function checkResultKey(result: {
  toolName: string;
  input?: unknown;
  output?: unknown;
}): string | null {
  const fix = result.toolName === FIX_TOOL;
  if (!fix && !CHECK_TOOLS.has(result.toolName)) return null;
  const output = fix ? field(result.output, "check") : result.output;
  if (fix && output === undefined) return null;
  const named = field(output, "checkId") ?? field(result.input, "checkId");
  const checkId = typeof named === "string" ? named : canonical(result.input ?? null);
  const text = (() => {
    if (typeof output === "string") return output;
    const shown = field(output, "output");
    if (typeof shown === "string") return shown;
    const findings = field(output, "findings");
    if (Array.isArray(findings)) return findings.map(String).join("\n");
    const reason = field(output, "reason") ?? field(output, "note");
    return typeof reason === "string" ? reason : canonical(output ?? null);
  })();
  const status = field(output, "status");
  return hashJson({
    tool: fix ? "request_check" : result.toolName,
    checkId,
    status: typeof status === "string" ? status : null,
    output: hashJson(normalizeCheckOutput(text)),
  });
}

/** The check results of the steps, keyed by `checkResultKey`, in order. */
const checkResults = (steps: readonly WatchStep[]): { toolName: string; key: string }[] =>
  steps.flatMap((step) =>
    (step.toolResults ?? []).flatMap((result) => {
      const key = checkResultKey(result);
      return key === null ? [] : [{ toolName: result.toolName, key }];
    }),
  );

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
  const tail = checkResults(steps).slice(-SAME_FAILURES);
  if (tail.length === SAME_FAILURES && tail.every((r) => r.key === tail[0]?.key))
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

/** A file the attempt's edits left unparsable, with its `path:line:column: message` lines. */
export interface BrokenFile {
  path: string;
  errors: readonly string[];
}

/**
 * What the steering says about files the attempt's edits left unparsable, when `restore_file` is
 * on (#1835). negotiate T004 and md-site T005 (bench round 56) reread the broken lines of a test
 * file until the watcher stopped them, then reported that they had no edit tool, and the restart
 * began from the same broken file.
 */
function brokenNote(broken: readonly BrokenFile[]): string {
  const files = broken
    .slice(0, 3)
    .map(({ path, errors }) => `${path} (${errors.slice(0, 3).join("; ")})`)
    .join(", ");
  return ` Your edits left ${files} not parsing; rereading the file will not show more than these lines. Fix them with one edit_file whose newString writes each quote and backslash once as the language needs, or call restore_file with the path to put back its last version that parsed, then make the change again.`;
}

/** The steering message for a first signal. */
export function steeringNotice(finding: WatchFinding, broken: readonly BrokenFile[] = []): string {
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
  const note = broken.length && finding.signal !== "unchecked-spend" ? brokenNote(broken) : "";
  return `Progress watcher: ${finding.detail}. ${advice[finding.signal]}${note} If the same pattern continues, the host ends this attempt early.`;
}

/**
 * Whether the pattern the watcher steered on went on in the steps after the steering message:
 * an edit counts as progress and clears it (a check, for `unchecked-spend`); otherwise a repeated
 * read of the same input, the same check result again, or `stopAfter` more steps without an edit
 * for `no-edits`. The first `STEER_GRACE_STEPS` steps after the steering can show progress but
 * never a stop: the stop comes at the earliest one full step after the step that answered it.
 */
export function stillStuck(
  finding: WatchFinding,
  steps: readonly WatchStep[],
  steeredAt: number,
  stopAfter: number,
): "stuck" | "progress" | "waiting" {
  const before = steps.slice(0, steeredAt);
  const after = steps.slice(steeredAt);
  // Steps past the grace: only they can show the pattern going on.
  const later = after.slice(STEER_GRACE_STEPS);
  const minimum = Math.max(stopAfter, STEER_GRACE_STEPS + 1);
  // Only a check clears unchecked spend; another edit without one is more of the same.
  if (finding.signal === "unchecked-spend")
    return after.some((step) => step.toolCalls?.some((call) => CHECK_TOOLS.has(call.toolName)))
      ? "progress"
      : later.length > 0 &&
          after.filter((step) => (step.toolCalls ?? []).length > 0).length >= minimum
        ? "stuck"
        : "waiting";
  // An `apply_fix` is an edit, but for `same-failure` its result is one more run of the check: a
  // fixer that cannot change the failure is the loop itself (R77 pairwick, #2437).
  const edits =
    finding.signal === "same-failure"
      ? (name: string) => EDIT_TOOLS.has(name) && name !== FIX_TOOL
      : (name: string) => EDIT_TOOLS.has(name);
  if (after.some((step) => step.toolCalls?.some((call) => edits(call.toolName)))) return "progress";
  if (later.length < 1) return "waiting";
  if (finding.signal === "no-edits")
    return after.filter((step) => (step.toolCalls ?? []).length > 0).length >= minimum
      ? "stuck"
      : "waiting";
  if (finding.signal === "repeated-reads") {
    const key = (call: { toolName: string; input?: unknown }) =>
      `${call.toolName} ${canonical(call.input ?? null)}`;
    // A read in the grace step is remembered, so reading it once more after the grace is a stop.
    const seen = new Set(
      [...before, ...after.slice(0, STEER_GRACE_STEPS)].flatMap((step) =>
        (step.toolCalls ?? []).filter((c) => READ_TOOLS.has(c.toolName)).map(key),
      ),
    );
    return later.some((step) =>
      (step.toolCalls ?? []).some((call) => READ_TOOLS.has(call.toolName) && seen.has(key(call))),
    )
      ? "stuck"
      : after.length >= stopAfter
        ? "progress"
        : "waiting";
  }
  const last = checkResults(before).at(-1);
  return last !== undefined && checkResults(later).some((r) => r.key === last.key)
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
