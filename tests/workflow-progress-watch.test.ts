import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { modelCheckOutput } from "../src/core/verification/check-runner.js";
import {
  CHECK_TOOLS,
  checkResultKey,
  NO_EDIT_STEPS,
  STEER_GRACE_STEPS,
  steeringNotice,
  UNCHECKED_SPEND_SHARE,
  stillStuck,
  type WatchFinding,
  type WatchSignal,
  type WatchStep,
  watchSteps,
} from "../src/core/workflows/progress-watch.js";
import {
  AttemptStepController,
  finalizeNotice,
  WATCH_STOP_AFTER,
} from "../src/core/workflows/step-budget.js";

const read = (path: string) => ({ toolCalls: [{ toolName: "read", input: { path } }] });
const edit = () => ({ toolCalls: [{ toolName: "multi_edit", input: { path: "a.ts" } }] });
const check = (output: unknown) => ({
  toolCalls: [{ toolName: "request_check", input: { id: "unit" } }],
  toolResults: [{ toolName: "request_check", output }],
});
const other = () => ({ toolCalls: [{ toolName: "list", input: { path: "." } }] });

describe("watchSteps", () => {
  test("flags the same read three times since the last edit", () => {
    expect(watchSteps([read("a.ts"), read("b.ts"), read("a.ts")], { mustEdit: false })).toBeNull();
    const finding = watchSteps([read("a.ts"), read("a.ts"), read("a.ts")], { mustEdit: false });
    expect(finding?.signal).toBe("repeated-reads");
    expect(finding?.detail).toContain("read");
    // An edit resets the count.
    expect(
      watchSteps([read("a.ts"), read("a.ts"), edit(), read("a.ts")], { mustEdit: false }),
    ).toBeNull();
  });

  test("flags the same check result three times in a row", () => {
    const failing = { status: "failed", output: "1 failing" };
    expect(watchSteps([check(failing), check(failing)], { mustEdit: false })).toBeNull();
    expect(
      watchSteps([check(failing), check({ status: "failed", output: "2 failing" }), check(failing)], {
        mustEdit: false,
      }),
    ).toBeNull();
    expect(watchSteps([check(failing), check(failing), check(failing)], { mustEdit: false })?.signal).toBe(
      "same-failure",
    );
  });

  test("flags steps without an edit only for an attempt that must edit", () => {
    const busy = Array.from({ length: NO_EDIT_STEPS }, (_, i) => read(`f${i}.ts`));
    expect(watchSteps(busy, { mustEdit: false })).toBeNull();
    expect(watchSteps(busy, { mustEdit: true })?.signal).toBe("no-edits");
    expect(watchSteps(busy.slice(1), { mustEdit: true })).toBeNull();
    // Steps without tool calls are not counted.
    expect(watchSteps([...busy.slice(1), {}], { mustEdit: true })).toBeNull();
  });

  // #1764: md-site T075 (bench round 52) spent its whole uncached cap after two edits it never
  // checked, and ended with no submission.
  test("flags half the token cap spent with edits no check has run on", () => {
    const half = { used: UNCHECKED_SPEND_SHARE * 1000, cap: 1000 };
    const finding = watchSteps([read("a.ts"), edit(), read("b.ts")], { mustEdit: true, spend: half });
    expect(finding?.signal).toBe("unchecked-spend");
    expect(finding?.detail).toContain("50% of this attempt's token cap");
    // Less than half spent, no edit yet, a check after the latest edit, or an attempt that need
    // not edit: nothing to flag.
    expect(watchSteps([edit()], { mustEdit: true, spend: { used: 499, cap: 1000 } })).toBeNull();
    expect(watchSteps([read("a.ts"), read("b.ts")], { mustEdit: true, spend: half })).toBeNull();
    expect(watchSteps([edit(), check("ok")], { mustEdit: true, spend: half })).toBeNull();
    expect(watchSteps([edit()], { mustEdit: false, spend: half })).toBeNull();
    // A check before the latest edit does not cover it.
    expect(watchSteps([edit(), check("ok"), edit()], { mustEdit: true, spend: half })?.signal).toBe(
      "unchecked-spend",
    );
  });
});

// #2437: the results as the tools return them, with what changes between two runs of the same
// failure: a new evidence and snapshot id per check run, and timings in the output (sbt 2's
// `elapsed time` line, R77 pairwick). A tool whose result the watcher compares (`CHECK_TOOLS`)
// adds its real shape here; the test below fails without it.
const sbtFailure = (run: number) =>
  `[warn] /work/src/main/scala/pairwick/Rules.scala isn't formatted properly!\n[error] (Compile / scalafmtCheck) 1 files aren't formatted properly\n[error] elapsed time: ${run * 3 + 1} s, cache ${run * 10}%, ${run} disk cache hits, 3 onsite tasks`;
const checkRun = (run: number) => {
  const evidenceId = `ev_${run}`;
  const output = sbtFailure(run);
  return { status: "failed", evidenceId, snapshotId: `snap_${run}`, output, reason: "exit", ...modelCheckOutput(output, evidenceId) };
};
const REAL_SHAPES: Record<string, (run: number) => { input: unknown; output: unknown }> = {
  // `{ ...CheckRunner.run(), ...modelCheckOutput() }` (agent-executor.ts).
  request_check: (run) => ({ input: { checkId: "scalafmt" }, output: checkRun(run) }),
  // `ProbeOutcome` (repro.ts).
  run_probe: (run) => ({
    input: { executable: "sbt", args: ["scalafmtCheck"] },
    output: { status: "ran", exitCode: 1, timedOut: false, output: sbtFailure(run) },
  }),
  // The repro check's still-reproducing findings (scheduler.ts `reproCheck`).
  run_repro: (run) => ({
    input: {},
    output: {
      status: "reproduced",
      findings: [`Finding F001 still reproduces: \`sbt run\` prints "1" where "2" is expected. Output:\n1\n[success] elapsed time: ${run + 2} s, cache ${run}%, ${run} disk cache hits`],
    },
  }),
  // `ReplayResult` (acceptance-rows-replay.ts).
  replay_rows: (run) => ({
    input: { harness: "object Rules { def score(a: Int) = a }" },
    output: { status: "failed", failed: ["AC-1.2"], output: `AC-1.2 failed: got 1\n[error] elapsed time: ${run} s, cache ${run * 5}%, 2 disk cache hits` },
  }),
  // `apply_fix`: the fixer's exits and the check it ran after them (agent-executor.ts).
  apply_fix: (run) => ({
    input: { checkId: "scalafmt" },
    output: { fixed: ["src/main/scala/pairwick/Rules.scala: exit 1"], check: checkRun(run) },
  }),
};
const realStep = (toolName: string, run: number): WatchStep => {
  const shape = REAL_SHAPES[toolName];
  if (!shape) throw new Error(`no real-shape case for ${toolName}`);
  const { input, output } = shape(run);
  return { toolCalls: [{ toolName, input }], toolResults: [{ toolName, input, output }] };
};

describe("same-failure on real check results (#2437)", () => {
  // Maintainability: every tool the watcher compares has its real result shape here.
  test("every CHECK_TOOLS entry has a real-shape case", () => {
    expect([...CHECK_TOOLS, "apply_fix"].filter((tool) => !(tool in REAL_SHAPES))).toEqual([]);
  });

  test.each(Object.keys(REAL_SHAPES))("three %s results with new ids and timings steer, the next stops", (tool) => {
    const runs = [1, 2, 3].map((run) => realStep(tool, run));
    // The shapes differ run to run, as the tools return them.
    expect(new Set(runs.map((step) => JSON.stringify(step.toolResults))).size).toBe(3);
    expect(watchSteps(runs.slice(0, 2), { mustEdit: false })).toBeNull();
    const finding = watchSteps(runs, { mustEdit: false });
    expect(finding?.signal).toBe("same-failure");
    // The step answering the steering is a grace; the same failure one step later is the stop.
    expect(stillStuck(finding as WatchFinding, [...runs, realStep(tool, 4)], 3, WATCH_STOP_AFTER)).toBe("waiting");
    expect(stillStuck(finding as WatchFinding, [...runs, realStep(tool, 4), realStep(tool, 5)], 3, WATCH_STOP_AFTER)).toBe(
      "stuck",
    );
  });

  test("a check result's key is its tool, check, status and normalized output", () => {
    const key = (tool: string, run: number) => {
      const { input, output } = (REAL_SHAPES[tool] as (run: number) => { input: unknown; output: unknown })(run);
      return checkResultKey({ toolName: tool, input, output });
    };
    expect(key("request_check", 1)).toBe(key("request_check", 7));
    // apply_fix's check is one more run of the same check.
    expect(key("apply_fix", 1)).toBe(key("request_check", 2));
    const failing = checkRun(1);
    const other = (patch: object, input: unknown = { checkId: "scalafmt" }) =>
      checkResultKey({ toolName: "request_check", input, output: { ...failing, ...patch } });
    const base = other({});
    expect(other({ output: failing.output.replace("Rules.scala", "Score.scala") })).not.toBe(base);
    expect(other({ status: "passed" })).not.toBe(base);
    expect(other({}, { checkId: "compile" })).not.toBe(base);
    expect(checkResultKey({ toolName: "read", input: { path: "a" }, output: "x" })).toBeNull();
    // An apply_fix that ran no check is no check result.
    expect(checkResultKey({ toolName: "apply_fix", input: { checkId: "scalafmt" }, output: { fixed: [] } })).toBeNull();
  });

  // R77 pairwick: `apply_fix` returned the same failing scalafmt check again and again; as an
  // edit it cleared the steering at once.
  test("an apply_fix that returns the same failing check is no progress after the steering", () => {
    const runs = [1, 2, 3].map((run) => realStep("request_check", run));
    const finding = watchSteps(runs, { mustEdit: true }) as WatchFinding;
    expect(finding.signal).toBe("same-failure");
    expect(
      stillStuck(finding, [...runs, realStep("apply_fix", 4), realStep("apply_fix", 5)], 3, WATCH_STOP_AFTER),
    ).toBe("stuck");
    // A hand edit still is progress.
    expect(stillStuck(finding, [...runs, edit(), realStep("request_check", 5)], 3, WATCH_STOP_AFTER)).toBe("progress");
  });

  test("the step controller steers on three real results and stops on the next", () => {
    const signals: [string, string][] = [];
    const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };
    const controller = new AttemptStepController({
      maxSteps: 40,
      maxTokens: 1_000_000,
      submitTools: ["submit_result"],
      fallbackStepTokens: 100,
      watch: { mustEdit: true, onSignal: (f, action) => signals.push([f.signal, action]) },
    });
    const messages: ModelMessage[] = [{ role: "user", content: "task" }];
    const steps = [1, 2, 3].map((run) => ({ usage, ...realStep("request_check", run) }));
    controller.prepare({ stepNumber: 3, steps, messages });
    expect(signals).toEqual([["same-failure", "steered"]]);
    const later = [...steps, { usage, ...realStep("apply_fix", 4) }, { usage, ...realStep("request_check", 5) }];
    expect(controller.prepare({ stepNumber: 5, steps: later, messages }).activeTools).toEqual(["submit_result"]);
    expect(signals).toEqual([
      ["same-failure", "steered"],
      ["same-failure", "stopped"],
    ]);
  });
});

describe("stillStuck", () => {
  const reads: WatchFinding = { signal: "repeated-reads", detail: "x" };
  const steps = [read("a.ts"), read("a.ts"), read("a.ts")];

  test("waits, then sees the steered pattern continue", () => {
    expect(stillStuck(reads, steps, 3, WATCH_STOP_AFTER)).toBe("waiting");
    expect(stillStuck(reads, [...steps, read("b.ts")], 3, WATCH_STOP_AFTER)).toBe("waiting");
    expect(stillStuck(reads, [...steps, read("b.ts"), read("a.ts")], 3, WATCH_STOP_AFTER)).toBe("stuck");
  });

  // #1978: md-site 54da0241 (bench round 63) was stopped 14 s after the steering, by the step that
  // answered it. The watcher measures in model steps: that step is a grace and never a stop.
  test("no stop within one step of the steer", () => {
    expect(STEER_GRACE_STEPS).toBe(1);
    // The step sent with the steering re-reads the file it is about to edit.
    expect(stillStuck(reads, [...steps, read("a.ts")], 3, WATCH_STOP_AFTER)).toBe("waiting");
    // One full step later the same read again is a stop.
    expect(stillStuck(reads, [...steps, read("a.ts"), read("a.ts")], 3, WATCH_STOP_AFTER)).toBe("stuck");
    // A read first made in the grace step and made again later is a stop too.
    expect(stillStuck(reads, [...steps, read("b.ts"), read("b.ts")], 3, WATCH_STOP_AFTER)).toBe("stuck");
    // An edit in the grace step is progress at once.
    expect(stillStuck(reads, [...steps, edit()], 3, WATCH_STOP_AFTER)).toBe("progress");
    const same: WatchFinding = { signal: "same-failure", detail: "x" };
    const failing = check("same");
    expect(stillStuck(same, [failing, failing, failing, check("same")], 3, 3)).toBe("waiting");
    // Every signal, even with a stop after one step, waits for one full step past the grace.
    for (const signal of ["no-edits", "unchecked-spend"] as const)
      expect(stillStuck({ signal, detail: "x" }, [other(), other()], 1, 1)).toBe("waiting");
    expect(stillStuck({ signal: "no-edits", detail: "x" }, [other(), other(), other()], 1, 1)).toBe("stuck");
  });

  test("an edit, or enough steps without the pattern, is progress", () => {
    expect(stillStuck(reads, [...steps, edit(), read("a.ts")], 3, WATCH_STOP_AFTER)).toBe("progress");
    expect(
      stillStuck(reads, [...steps, read("b.ts"), read("c.ts"), read("d.ts")], 3, WATCH_STOP_AFTER),
    ).toBe("progress");
  });

  test("no edits stops after the given number of busy steps", () => {
    const finding: WatchFinding = { signal: "no-edits", detail: "x" };
    expect(stillStuck(finding, [other(), other(), other()], 1, 3)).toBe("waiting");
    expect(stillStuck(finding, [other(), other(), other(), other()], 1, 3)).toBe("stuck");
  });

  test("unchecked spend is cleared by a check, not by another edit", () => {
    const finding: WatchFinding = { signal: "unchecked-spend", detail: "x" };
    expect(stillStuck(finding, [edit(), edit()], 1, 3)).toBe("waiting");
    expect(stillStuck(finding, [edit(), check("ok")], 1, 3)).toBe("progress");
    expect(stillStuck(finding, [edit(), edit(), read("a.ts"), edit()], 1, 3)).toBe("stuck");
  });

  test("the same check result again is stuck, a different one is not", () => {
    const finding: WatchFinding = { signal: "same-failure", detail: "x" };
    const failing = check("same");
    expect(stillStuck(finding, [failing, failing, failing, check("new"), check("same")], 3, 3)).toBe("stuck");
    expect(stillStuck(finding, [failing, failing, failing, check("new"), check("new")], 3, 3)).toBe("waiting");
  });
});

// Maintainability (#1764): a new signal ships with its own steering advice.
test("every watch signal has its own steering advice", () => {
  const signals: WatchSignal[] = ["repeated-reads", "no-edits", "same-failure", "no-edit-tool", "unchecked-spend"];
  const notices = signals.map((signal) => steeringNotice({ signal, detail: "x" }));
  for (const notice of notices) expect(notice).not.toContain("undefined");
  expect(new Set(notices).size).toBe(signals.length);
});

describe("AttemptStepController progress watcher", () => {
  const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };
  const step = (s: object) => ({ usage, ...s });
  const messages: ModelMessage[] = [{ role: "user", content: "task" }];
  const make = (signals: [string, string][]) =>
    new AttemptStepController({
      maxSteps: 40,
      maxTokens: 1_000_000,
      submitTools: ["submit_result"],
      fallbackStepTokens: 100,
      watch: { mustEdit: false, onSignal: (f, action) => signals.push([f.signal, action]) },
    });

  test("steers once, then stops when the pattern goes on", () => {
    const signals: [string, string][] = [];
    const controller = make(signals);
    const steps = [step(read("a.ts")), step(read("a.ts")), step(read("a.ts"))];
    const steered = controller.prepare({ stepNumber: 3, steps, messages });
    const finding = { signal: "repeated-reads" as const, detail: watchSteps(steps, { mustEdit: false })?.detail ?? "" };
    expect(steered.messages?.at(-1)).toEqual({ role: "user", content: steeringNotice(finding) });
    expect(steered.activeTools).toBeUndefined();
    expect(signals).toEqual([["repeated-reads", "steered"]]);
    // The step that answered the steering is a grace (#1978): no stop yet.
    const answered = [...steps, step(read("a.ts"))];
    expect(controller.prepare({ stepNumber: 4, steps: answered, messages: steered.messages ?? messages }).activeTools).toBeUndefined();
    expect(signals).toEqual([["repeated-reads", "steered"]]);
    const later = [...answered, step(read("a.ts"))];
    const stopped = controller.prepare({ stepNumber: 5, steps: later, messages: steered.messages ?? messages });
    expect(stopped.activeTools).toEqual(["submit_result"]);
    expect(stopped.messages?.at(-1)).toEqual({ role: "user", content: finalizeNotice("watcher", finding) });
    expect(signals).toEqual([
      ["repeated-reads", "steered"],
      ["repeated-reads", "stopped"],
    ]);
    expect(controller.record(later, false, { profileId: "implementer", taskId: "T001" }).finalizedBy).toBe(
      "watcher",
    );
  });

  test("steers an attempt that spent half its cap on unchecked edits, and stops it without a check", () => {
    const signals: [string, string][] = [];
    const controller = new AttemptStepController({
      maxSteps: 40,
      maxTokens: 6000,
      submitTools: ["submit_result"],
      fallbackStepTokens: 100,
      watch: { mustEdit: true, onSignal: (f, action) => signals.push([f.signal, action]) },
    });
    const big = (s: object) => ({ usage: { inputTokens: 500, outputTokens: 10, totalTokens: 510 }, ...s });
    const early = [big(read("a.ts")), big(edit()), big(read("b.ts")), big(read("c.ts")), big(read("d.ts"))];
    expect(controller.prepare({ stepNumber: early.length, steps: early, messages }).messages).toBeUndefined();
    expect(signals).toEqual([]);
    const steps = [...early, big(read("e.ts"))];
    const steered = controller.prepare({ stepNumber: steps.length, steps, messages });
    expect(signals).toEqual([["unchecked-spend", "steered"]]);
    expect(String(steered.messages?.at(-1)?.content)).toContain("Run request_check");
    const later = [...steps, big(edit()), big(read("f.ts")), big(edit())];
    const stopped = controller.prepare({ stepNumber: later.length, steps: later, messages });
    expect(stopped.activeTools).toEqual(["submit_result"]);
    expect(signals.at(-1)).toEqual(["unchecked-spend", "stopped"]);
  });

  test("an edit after the steering message ends the watch without a stop", () => {
    const signals: [string, string][] = [];
    const controller = make(signals);
    const steps = [step(read("a.ts")), step(read("a.ts")), step(read("a.ts"))];
    controller.prepare({ stepNumber: 3, steps, messages });
    const after = [...steps, step(edit()), step(read("a.ts")), step(read("a.ts")), step(read("a.ts"))];
    const next = controller.prepare({ stepNumber: 7, steps: after, messages });
    expect(next.activeTools).toBeUndefined();
    expect(signals).toEqual([["repeated-reads", "steered"]]);
  });
});
