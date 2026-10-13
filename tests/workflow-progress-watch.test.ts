import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  NO_EDIT_STEPS,
  steeringNotice,
  stillStuck,
  type WatchFinding,
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

  test("the same check result again is stuck, a different one is not", () => {
    const finding: WatchFinding = { signal: "same-failure", detail: "x" };
    const failing = check("same");
    expect(stillStuck(finding, [failing, failing, failing, check("same")], 3, 3)).toBe("stuck");
    expect(stillStuck(finding, [failing, failing, failing, check("new")], 3, 3)).toBe("waiting");
  });
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
