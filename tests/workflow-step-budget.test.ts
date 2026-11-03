import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  ALL_TOKENS_FACTOR,
  AttemptStepController,
  allTokensCapFor,
  compactToolHistory,
  finalizeNotice,
  finalizeReason,
  KEEP_RECENT_TOOL_MESSAGES,
  editNudgeNotice,
  truncationNotice,
} from "../src/core/workflows/step-budget.js";

const BIG = "x".repeat(4000);

function call(id: string, toolName: string, input: Record<string, unknown>): ModelMessage {
  return { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName, input }] };
}

function result(id: string, toolName: string, value: unknown): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName,
        output: { type: "json", value: value as never },
      },
    ],
  };
}

function history(reads: number): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: "user", content: "task" }];
  for (let i = 0; i < reads; i++) {
    messages.push(call(`c${String(i)}`, "read", { files: [{ path: `f${String(i)}.ts` }] }));
    messages.push(
      result(`c${String(i)}`, "read", { result: BIG, evidenceId: `ev-${String(i)}` }),
    );
  }
  return messages;
}

function output(message: ModelMessage | undefined): unknown {
  if (!message || message.role !== "tool") throw new Error("Expected a tool message");
  const part = message.content[0];
  if (part?.type !== "tool-result") throw new Error("Expected a tool result");
  return part.output;
}

describe("compactToolHistory", () => {
  test("keeps the most recent tool results verbatim", () => {
    const messages = history(KEEP_RECENT_TOOL_MESSAGES);
    const compacted = compactToolHistory(messages);
    expect(compacted.messages).toBe(messages);
    expect(compacted.savedBytes).toBe(0);
  });

  test("replaces older large observations with a stub that keeps evidence IDs", () => {
    const messages = history(KEEP_RECENT_TOOL_MESSAGES + 2);
    const compacted = compactToolHistory(messages);
    expect(compacted.savedBytes).toBeGreaterThan(2 * 3000);
    const first = output(compacted.messages[2]) as { type: string; value: Record<string, unknown> };
    expect(first.type).toBe("json");
    expect(first.value.compacted).toBe(true);
    expect(first.value.evidenceIds).toEqual(["ev-0"]);
    expect(first.value.input).toEqual({ files: [{ path: "f0.ts" }] });
    expect(JSON.stringify(first.value).length).toBeLessThan(1000);
    expect(compacted.messages.at(-1)).toBe(messages.at(-1));
    // The input history is never mutated.
    expect(JSON.stringify(output(messages[2]))).toContain(BIG);
  });

  test("is stable as the history grows, so compacted prefixes replay identically", () => {
    const short = compactToolHistory(history(KEEP_RECENT_TOOL_MESSAGES + 1)).messages;
    const long = compactToolHistory(history(KEEP_RECENT_TOOL_MESSAGES + 3)).messages;
    expect(JSON.stringify(long.slice(0, 3))).toBe(JSON.stringify(short.slice(0, 3)));
  });

  test("leaves edit, check and small results untouched", () => {
    const messages: ModelMessage[] = [
      call("e", "edit_file", { path: "a.ts" }),
      result("e", "edit_file", { output: BIG }),
      call("k", "request_check", { checkId: "unit" }),
      result("k", "request_check", { stdout: BIG, evidenceId: "ev-k" }),
      call("s", "read", { files: [] }),
      result("s", "read", { result: "short", evidenceId: "ev-s" }),
      ...history(KEEP_RECENT_TOOL_MESSAGES).slice(1),
    ];
    const compacted = compactToolHistory(messages);
    expect(compacted.messages).toBe(messages);
  });
});

describe("finalizeReason", () => {
  const base = { stepNumber: 2, maxSteps: 14, consumed: 0, lastStepTokens: 0, maxTokens: 1000 };
  test("finalizes two steps before the end so a rejected submission can be corrected", () => {
    expect(finalizeReason({ ...base, stepNumber: 11 })).toBeNull();
    expect(finalizeReason({ ...base, stepNumber: 12 })).toBe("steps");
    expect(finalizeReason({ ...base, stepNumber: 13 })).toBe("steps");
    expect(finalizeReason({ ...base, maxSteps: 2, stepNumber: 0 })).toBeNull();
    expect(finalizeReason({ ...base, maxSteps: 2, stepNumber: 1 })).toBe("steps");
  });
  test("finalizes while two more steps of the current size still fit", () => {
    expect(finalizeReason({ ...base, consumed: 500, lastStepTokens: 250 })).toBeNull();
    expect(finalizeReason({ ...base, consumed: 501, lastStepTokens: 250 })).toBe("tokens");
  });
});

test("reads of line ranges or symbols stay verbatim", () => {
  const messages: ModelMessage[] = [];
  const ranged = { files: [{ path: "a.ts", ranges: [{ start: 1, end: 90 }] }, { path: "b.ts", target: "function", name: "f" }] };
  messages.push(call("r", "read", ranged), result("r", "read", { result: BIG, evidenceId: "ev-r" }));
  for (let i = 0; i < KEEP_RECENT_TOOL_MESSAGES; i++)
    messages.push(call(`c${String(i)}`, "read", { files: [{ path: "c.ts" }] }), result(`c${String(i)}`, "read", { result: "short" }));
  expect(compactToolHistory(messages).messages).toBe(messages);
  const mixed = [call("r", "read", { files: [{ path: "a.ts", ranges: [{ start: 1, end: 9 }] }, { path: "d.ts" }] }), ...messages.slice(1)];
  expect(compactToolHistory(mixed).savedBytes).toBeGreaterThan(0);
});

describe("AttemptStepController", () => {
  const usage = (inputTokens: number, outputTokens: number) => ({
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    toolCalls: [{}],
  });

  test("restricts the final step to submit tools and keeps the notice in place", () => {
    const controller = new AttemptStepController({
      maxSteps: 14,
      maxTokens: 1000,
      submitTools: ["submit_result"],
      fallbackStepTokens: 100,
    });
    const messages = history(1);
    expect(controller.prepare({ stepNumber: 1, steps: [usage(100, 10)], messages })).toEqual({});
    const steps = [usage(100, 10), usage(300, 20)];
    const first = controller.prepare({ stepNumber: 2, steps, messages });
    expect(first.activeTools).toEqual(["submit_result"]);
    expect(first.toolChoice).toBe("required");
    expect(first.messages?.at(-1)).toEqual({ role: "user", content: finalizeNotice("tokens") });
    const longer = [...messages, call("retry", "submit_result", {})];
    const second = controller.prepare({
      stepNumber: 3,
      steps: [...steps, usage(350, 20)],
      messages: longer,
    });
    expect(second.messages?.[messages.length]).toEqual(first.messages?.at(-1));
    expect(second.messages?.at(-1)).toEqual(longer.at(-1));
  });

  test("a step floor lets an expensive provider take its minimum steps within the ceiling", () => {
    const options = { maxSteps: 30, maxTokens: 150_000, submitTools: ["submit_result"], fallbackStepTokens: 100 };
    // Codex-like steps of 50k: a 150k cap alone finalizes after two steps.
    const steps = [usage(48_000, 2000), usage(48_000, 2000)];
    const plain = new AttemptStepController(options);
    expect(plain.prepare({ stepNumber: 2, steps, messages: history(1) }).activeTools).toEqual(["submit_result"]);
    const floored = new AttemptStepController({ ...options, minSteps: 10, ceilingTokens: 400_000 });
    expect(floored.tokenCap(steps)).toBe(400_000);
    expect(floored.prepare({ stepNumber: 2, steps, messages: history(1) }).activeTools).toBeUndefined();
    expect(new AttemptStepController({ ...options, minSteps: 10, ceilingTokens: 1_000_000 }).tokenCap(steps)).toBe(500_000);
    // Cheap steps keep the sized cap.
    expect(floored.tokenCap([usage(9000, 1000)])).toBe(150_000);
    expect(floored.record(steps, false, { profileId: "implementer", taskId: "T001" }).maxTokens).toBe(400_000);
  });

  test("the step floor counts model requests: a step that reported no tokens is not one (#1987)", () => {
    // Codex reports a response's usage once its tool call is answered, so every other step reads 0.
    const options = { maxSteps: 30, maxTokens: 150_000, submitTools: ["submit_result"], fallbackStepTokens: 100, minSteps: 10, ceilingTokens: 2_000_000 };
    const steps = [usage(48_000, 2000), usage(0, 0), usage(48_000, 2000), usage(0, 0)];
    const controller = new AttemptStepController(options);
    expect(controller.tokenCap(steps)).toBe(500_000);
    // The all-token floor is one request past the 30-step limit at the 50k average request (#2650).
    expect(controller.allTokensCap(steps)).toBe(1_550_000);
    // Without a reported step there is nothing to average: the sized cap stands.
    expect(controller.tokenCap([usage(0, 0)])).toBe(150_000);
  });

  test("tells the agent once that a step was cut off at the output cap, and keeps it in place", () => {
    const controller = new AttemptStepController({
      maxSteps: 14,
      maxTokens: 100_000,
      submitTools: ["submit_result"],
      fallbackStepTokens: 100,
      maxOutputTokens: 4096,
    });
    const messages = history(1);
    const cut = { ...usage(100, 4096), finishReason: "length" };
    const first = controller.prepare({ stepNumber: 1, steps: [cut], messages });
    const notice = { role: "user", content: truncationNotice(4096) };
    expect(first.messages?.at(-1)).toEqual(notice);
    expect(first.activeTools).toBeUndefined();
    const longer = [...messages, call("retry", "edit_file", {})];
    const second = controller.prepare({
      stepNumber: 2,
      steps: [cut, { ...usage(120, 50), finishReason: "tool-calls" }],
      messages: longer,
    });
    expect(second.messages?.[messages.length]).toEqual(notice);
    expect(second.messages?.filter((m) => m.role === "user" && m.content === notice.content)).toHaveLength(1);
    expect(second.messages?.at(-1)).toEqual(longer.at(-1));
  });

  test("tells an attempt that must edit to edit after several read-only steps, once", () => {
    const controller = new AttemptStepController({
      maxSteps: 20,
      maxTokens: 100_000,
      submitTools: ["submit_result"],
      fallbackStepTokens: 100,
      editNudgeAfterReads: 3,
    });
    const reading = { ...usage(100, 10), toolCalls: [{ toolName: "read" }] };
    const editing = { ...usage(100, 10), toolCalls: [{ toolName: "multi_edit" }] };
    const messages = history(1);
    expect(
      controller.prepare({ stepNumber: 3, steps: [editing, reading, reading], messages }),
    ).toEqual({});
    const nudged = controller.prepare({
      stepNumber: 4,
      steps: [editing, reading, reading, reading],
      messages,
    });
    expect(nudged.messages?.at(-1)).toEqual({ role: "user", content: editNudgeNotice(3) });
    expect(nudged.activeTools).toBeUndefined();
    const later = controller.prepare({
      stepNumber: 5,
      steps: [editing, reading, reading, reading, reading],
      messages,
    });
    expect(later.messages?.filter((m) => m.role === "user" && m.content === editNudgeNotice(3))).toHaveLength(1);
  });

  test("records per-step usage and the stop reason", () => {
    const controller = new AttemptStepController({
      maxSteps: 2,
      maxTokens: 10_000,
      submitTools: ["submit_result"],
      fallbackStepTokens: 100,
    });
    const steps = [
      usage(100, 10),
      { usage: { inputTokens: undefined, outputTokens: undefined }, toolCalls: [] },
    ];
    const record = controller.record(steps, false, { profileId: "implementer", taskId: "T001" });
    expect(record.totalTokens).toBe(210);
    expect(record.stopReason).toBe("steps");
    expect(record.steps[1]).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      toolCalls: 0,
      compactedBytes: 0,
    });
    expect(controller.record([usage(9000, 1000)], false, record).stopReason).toBe("tokens");
    expect(controller.record(steps, true, record).stopReason).toBe("submitted");
    expect(record.modelRequests).toBeUndefined();
  });

  // #1978: md-site T012 re-sent a ~107k-token prompt on every call; the usage record keeps the
  // prompt size so a corrective's cost per call reads from it.
  test("records the size of the prompt each step sent", () => {
    const controller = new AttemptStepController({
      maxSteps: 4,
      maxTokens: 100_000,
      submitTools: ["submit_result"],
      fallbackStepTokens: 100,
    });
    expect(controller.record([], false, { profileId: "implementer", taskId: "T001" }).prompt).toBeUndefined();
    const first = history(1);
    controller.prepare({ stepNumber: 0, steps: [], messages: first });
    const second = history(3);
    controller.prepare({ stepNumber: 1, steps: [usage(100, 10)], messages: second });
    const record = controller.record([usage(100, 10), usage(100, 10)], false, { profileId: "implementer", taskId: "T001" });
    const sent = [Buffer.byteLength(JSON.stringify(first)), Buffer.byteLength(JSON.stringify(second))];
    expect(record.steps.map((step) => step.sentBytes)).toEqual(sent);
    expect(record.prompt).toEqual({ firstBytes: sent[0] ?? 0, largestBytes: Math.max(...sent) });
  });

  test("records the names of each step's tool calls (#750)", () => {
    const controller = new AttemptStepController({
      maxSteps: 4,
      maxTokens: 100_000,
      submitTools: ["submit_result"],
      fallbackStepTokens: 100,
    });
    const record = controller.record(
      [
        { ...usage(100, 10), toolCalls: [{ toolName: "run_repro" }, { toolName: "read" }] },
        { ...usage(100, 10), toolCalls: [{}] },
      ],
      true,
      { profileId: "reviewer", taskId: null },
    );
    expect(record.steps.map((step) => step.tools)).toEqual([["run_repro", "read"], ["unknown"]]);
  });

  test("records responses whose usage a provider never reported (#820)", () => {
    const controller = new AttemptStepController({
      maxSteps: 4,
      maxTokens: 100_000,
      submitTools: ["submit_result"],
      fallbackStepTokens: 100,
    });
    const record = controller.record(
      [
        { ...usage(100, 10), providerMetadata: { codex: { responses: 1, unreportedResponses: 2 } } },
        { ...usage(100, 10), providerMetadata: { codex: { responses: 1 } } },
      ],
      true,
      { profileId: "implementer", taskId: "T001" },
    );
    expect(record.unreportedResponses).toBe(2);
    expect(record.steps.map((step) => step.unreportedResponses)).toEqual([2, undefined]);
    const clean = controller.record([usage(100, 10)], true, record);
    expect(clean.unreportedResponses).toBeUndefined();
  });

  test("records the model requests a provider reports per step and their sum", () => {
    const controller = new AttemptStepController({
      maxSteps: 4,
      maxTokens: 100_000,
      submitTools: ["submit_result"],
      fallbackStepTokens: 100,
    });
    const steps = [
      { ...usage(100, 10), providerMetadata: { codex: { responses: 3 } } },
      usage(100, 10),
      { ...usage(100, 10), providerMetadata: { codex: { responses: 1 } } },
    ];
    const record = controller.record(steps, true, { profileId: "implementer", taskId: "T001" });
    expect(record.modelRequests).toBe(4);
    expect(record.steps.map((s) => s.modelRequests)).toEqual([3, undefined, 1]);
  });
});

/** `n` requests that together spend `total` tokens, `uncached` of them outside the cache. */
function cachedRequests(n: number, total: number, uncached: number) {
  return Array.from({ length: n }, (_, i) => {
    const input = Math.floor(total / n) + (i === 0 ? total % n : 0);
    const fresh = Math.floor(uncached / n) + (i === 0 ? uncached % n : 0);
    return { usage: { inputTokens: input, outputTokens: 0, inputTokenDetails: { cacheReadTokens: input - fresh } }, toolCalls: [] };
  });
}

describe("the all-token cap's floor follows the step limit (#2650)", () => {
  const implementer = { maxSteps: 20, maxTokens: 250_000, minSteps: 10, submitTools: ["submit_result"], fallbackStepTokens: 100 };

  test("50k cached requests reach a 20-step limit instead of stopping at request 15", () => {
    const controller = new AttemptStepController(implementer);
    let finalizedAt: number | null = null;
    const steps: ReturnType<typeof cachedRequests> = [];
    for (let stepNumber = 0; stepNumber < implementer.maxSteps && finalizedAt === null; stepNumber++) {
      if (controller.prepare({ stepNumber, steps, messages: history(1) }).toolChoice === "required") finalizedAt = stepNumber;
      steps.push({ usage: { inputTokens: 50_000, outputTokens: 0, inputTokenDetails: { cacheReadTokens: 45_000 } }, toolCalls: [] });
    }
    // Three times the 250k cap is 750k, 15 such requests: the step limit finalizes, not the tokens.
    expect(finalizedAt).toBe(18);
    expect(controller.record(steps, true, { profileId: "implementer", taskId: "T009" })).toMatchObject({
      stopReason: "submitted",
      finalizedBy: "steps",
      allTokensCap: 21 * 50_000,
      allTokensInputs: { requests: 19, averageRequestTokens: 50_000, firstRequestTokens: 50_000 },
    });
  });

  test("an attempt that ends at its step limit without a result stops on its steps, not this cap", () => {
    const controller = new AttemptStepController(implementer);
    const steps = cachedRequests(20, 1_000_000, 100_000);
    expect(controller.record(steps, false, { profileId: "implementer", taskId: "T009" }).stopReason).toBe("steps");
  });

  test("a looping attempt on a growing context is bounded by its step limit at its own request size (#1300)", () => {
    // Read, edit and check cycles: each request resends the last one's context and adds 8k.
    const controller = new AttemptStepController(implementer);
    const steps: ReturnType<typeof cachedRequests> = [];
    let finalizedAt: number | null = null;
    for (let stepNumber = 0; stepNumber < implementer.maxSteps && finalizedAt === null; stepNumber++) {
      if (controller.prepare({ stepNumber, steps, messages: history(1) }).toolChoice === "required") finalizedAt = stepNumber;
      const input = 60_000 + 8_000 * stepNumber;
      steps.push({ usage: { inputTokens: input, outputTokens: 500, inputTokenDetails: { cacheReadTokens: input - 3_000 } } });
    }
    expect(finalizedAt).not.toBeNull();
    expect(finalizedAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(implementer.maxSteps - 2);
    const total = controller.consumed(steps);
    // The cap that bounds it never passes one request past the step limit at its average request.
    expect(controller.allTokensCap(steps)).toBe(Math.ceil((total / steps.length) * 21));
    expect(total).toBeLessThan(controller.allTokensCap(steps));
  });

  test("without a request the cap is the factor alone", () => {
    expect(allTokensCapFor(250_000)).toBe(ALL_TOKENS_FACTOR * 250_000);
    expect(new AttemptStepController(implementer).allTokensCap([])).toBe(750_000);
  });

  // Replay of the attempts R88 md-site (run 351323db) lost at the all-token cap: T009 d454e35b and
  // T013 a087a466, both implementer correctives with a 250k cap and a 20-step limit.
  test.each([
    ["T009 d454e35b", 14, 790_154, 103_818],
    ["T013 a087a466", 16, 822_492, 183_900],
  ])("R88 md-site %s would not have been ended by the all-token cap", (_, requests, total, uncached) => {
    const steps = cachedRequests(requests, total, uncached);
    // What the old cap was: three times 250k, below what the attempt had spent.
    expect(ALL_TOKENS_FACTOR * implementer.maxTokens).toBeLessThan(total);
    const controller = new AttemptStepController(implementer);
    expect(controller.capped(steps)).toBe(uncached);
    expect(controller.consumed(steps)).toBe(total);
    const cap = controller.allTokensCap(steps);
    expect(cap).toBe(allTokensCapFor(implementer.maxTokens, { maxSteps: 20, consumed: total, requests }));
    expect(cap).toBeGreaterThan(total + 2 * Math.ceil(total / requests));
    // The next step is neither forced to submit nor counted as an attempt at its cap.
    expect(controller.prepare({ stepNumber: requests, steps, messages: history(1) }).toolChoice).toBeUndefined();
    expect(controller.overBudget(steps)).toBe(false);
  });
});
