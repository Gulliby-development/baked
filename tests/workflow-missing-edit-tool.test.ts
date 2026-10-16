import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { unchangedRereads } from "../src/core/workflows/agent-executor.js";
import { steeringNotice } from "../src/core/workflows/progress-watch.js";
import { AttemptStepController, finalizeNotice } from "../src/core/workflows/step-budget.js";

// md-site 4b08acf6 T006, attempt 2 (bench round 35, #1360): a restarted session read one 27 KB
// test file five times and an 87 KB file once, never edited, and ended blocked with "This runtime
// exposes no BAKED edit_file or multi_edit tool" after 805k tokens, although the attempt before
// it had used both tools.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };
const messages: ModelMessage[] = [{ role: "user", content: "task" }];
const read = (path: string) => ({ usage, toolCalls: [{ toolName: "read", input: { files: [{ path }] } }] });
const claim = { usage, text: "This runtime exposes no BAKED edit_file or multi_edit tool, so I cannot apply the change.", toolCalls: [] };
const edit = { usage, toolCalls: [{ toolName: "multi_edit", input: { path: "a.ts" } }] };

function controller(signals: [string, string, string][], editTools = ["edit_file", "multi_edit"]) {
  return new AttemptStepController({
    maxSteps: 40,
    maxTokens: 1_000_000,
    submitTools: ["submit_result"],
    fallbackStepTokens: 100,
    watch: { mustEdit: true, editTools, onSignal: (f, action) => signals.push([f.signal, action, f.detail]) },
  });
}

describe("a worker that says it has no edit tool while its session has them (#1360)", () => {
  test("is told which edit tools it has, and a second claim ends the attempt with the tool list", () => {
    const signals: [string, string, string][] = [];
    const steps = controller(signals);
    const first = [read("tests/build.property.test.ts"), claim];
    const told = steps.prepare({ stepNumber: 2, steps: first, messages });
    expect(told.activeTools).toBeUndefined();
    const detail = "the worker said it has no edit tool, while this session has edit_file, multi_edit";
    expect(told.messages?.at(-1)).toEqual({ role: "user", content: steeringNotice({ signal: "no-edit-tool", detail }) });
    expect(signals).toEqual([["no-edit-tool", "steered", detail]]);

    const second = [...first, read("tests/build.property.test.ts"), claim];
    const stopped = steps.prepare({ stepNumber: 4, steps: second, messages: told.messages ?? messages });
    expect(stopped.activeTools).toEqual(["submit_result"]);
    const stop = { signal: "no-edit-tool" as const, detail: "the worker said twice that it has no edit tool, while this session has edit_file, multi_edit" };
    expect(stopped.messages?.at(-1)).toEqual({ role: "user", content: finalizeNotice("watcher", stop) });
    expect(signals.at(-1)).toEqual(["no-edit-tool", "stopped", stop.detail]);
    expect(steps.record(second, false, { profileId: "implementer", taskId: "T006" }).finalizedBy).toBe("watcher");
  });

  test("an edit after the first claim clears it, and a session without edit tools is left alone", () => {
    const signals: [string, string, string][] = [];
    const steps = controller(signals);
    steps.prepare({ stepNumber: 1, steps: [claim], messages });
    const next = steps.prepare({ stepNumber: 3, steps: [claim, edit, claim], messages });
    expect(next.activeTools).toBeUndefined();
    expect(signals.map((s) => s[1])).toEqual(["steered"]);

    const none: [string, string, string][] = [];
    const without = controller(none, []);
    without.prepare({ stepNumber: 1, steps: [claim], messages });
    const later = without.prepare({ stepNumber: 2, steps: [claim, claim], messages });
    expect(later.activeTools).toBeUndefined();
    expect(none).toEqual([]);
  });
});

describe("unchangedRereads (#1360)", () => {
  test("from the fourth read until the first edit, a same-span read of an unchanged file is answered short", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-rereads-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const test = join(root, "build.property.test.ts");
    const other = join(root, "build.ts");
    writeFileSync(test, "test('a', () => {});\n");
    writeFileSync(other, "export {};\n");
    const earlier = new Map<string, { hash: string | null; read: number }>();
    expect(unchangedRereads([{ path: test }], earlier, 1, false)).toEqual({ files: [{ path: test }], unchanged: [] });
    expect(unchangedRereads([{ path: other }], earlier, 2, false).unchanged).toEqual([]);
    // Up to the third read a repeat is still served: a fresh session reads what it needs first.
    expect(unchangedRereads([{ path: test }], earlier, 3, false).unchanged).toEqual([]);
    const fourth = unchangedRereads([{ path: test }, { path: other, ranges: [{ start: 1, end: 1 }] }], earlier, 4, false);
    expect(fourth.files).toEqual([{ path: other, ranges: [{ start: 1, end: 1 }] }]);
    expect(fourth.unchanged).toEqual([`[${test} is unchanged since your read #3 in this attempt; its content is in your context above. Apply your edit now.]`]);
    writeFileSync(test, "test('b', () => {});\n");
    expect(unchangedRereads([{ path: test }], earlier, 5, false).unchanged).toEqual([]);
    expect(unchangedRereads([{ path: test }], earlier, 6, true).unchanged).toEqual([]);
    expect(unchangedRereads([{ path: test, ifHash: "x" }], earlier, 7, false).unchanged).toEqual([]);
  });
});
