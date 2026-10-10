import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  AttemptStepController,
  compactToolHistory,
  finalizeNotice,
  finalizeReason,
  KEEP_RECENT_TOOL_MESSAGES,
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
  test("finalizes on the last allowed step", () => {
    expect(finalizeReason({ ...base, stepNumber: 12 })).toBeNull();
    expect(finalizeReason({ ...base, stepNumber: 13 })).toBe("steps");
  });
  test("finalizes while two more steps of the current size still fit", () => {
    expect(finalizeReason({ ...base, consumed: 500, lastStepTokens: 250 })).toBeNull();
    expect(finalizeReason({ ...base, consumed: 501, lastStepTokens: 250 })).toBe("tokens");
  });
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
      toolCalls: 0,
      compactedBytes: 0,
    });
    expect(controller.record([usage(9000, 1000)], false, record).stopReason).toBe("tokens");
    expect(controller.record(steps, true, record).stopReason).toBe("submitted");
  });
});
