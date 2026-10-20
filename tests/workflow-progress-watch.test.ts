import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  NO_EDIT_STEPS,
  steeringNotice,
  UNCHECKED_SPEND_SHARE,
  stillStuck,
  type WatchFinding,
  type WatchSignal,
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

describe("stillStuck", () => {
  const reads: WatchFinding = { signal: "repeated-reads", detail: "x" };
  const steps = [read("a.ts"), read("a.ts"), read("a.ts")];

  test("waits, then sees the steered pattern continue", () => {
    expect(stillStuck(reads, steps, 3, WATCH_STOP_AFTER)).toBe("waiting");
    expect(stillStuck(reads, [...steps, read("b.ts")], 3, WATCH_STOP_AFTER)).toBe("waiting");
    expect(stillStuck(reads, [...steps, read("a.ts")], 3, WATCH_STOP_AFTER)).toBe("stuck");
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
    expect(stillStuck(finding, [failing, failing, failing, check("same")], 3, 3)).toBe("stuck");
    expect(stillStuck(finding, [failing, failing, failing, check("new")], 3, 3)).toBe("waiting");
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
    const later = [...steps, step(read("a.ts"))];
    const stopped = controller.prepare({ stepNumber: 4, steps: later, messages: steered.messages ?? messages });
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
