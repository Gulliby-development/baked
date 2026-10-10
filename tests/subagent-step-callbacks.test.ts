import { describe, expect, test } from "bun:test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { isStepCount, ToolLoopAgent, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { onSubagentStep, type SubagentStep } from "../src/core/agents/subagent-events.js";
import { buildStepCallbacks } from "../src/core/agents/subagent-tools.js";

function result(call?: { name: string; input: unknown }): LanguageModelV3GenerateResult {
  return {
    content: call
      ? [
          {
            type: "tool-call",
            toolCallId: crypto.randomUUID(),
            toolName: call.name,
            input: JSON.stringify(call.input),
          },
        ]
      : [{ type: "text", text: "done" }],
    finishReason: { unified: call ? "tool-calls" : "stop", raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    },
    warnings: [],
  };
}

describe("buildStepCallbacks through ToolLoopAgent.generate", () => {
  test("reports tool execution start and end to the subagent step stream", async () => {
    const script = [
      result({ name: "grep", input: { pattern: "needle" } }),
      result({ name: "read", input: { path: "missing.ts" } }),
      result(),
    ];
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        const next = script.shift();
        if (!next) throw new Error("script exhausted");
        return next;
      },
    });
    const agent = new ToolLoopAgent({
      model,
      stopWhen: isStepCount(5),
      tools: {
        grep: tool({
          inputSchema: z.object({ pattern: z.string() }),
          execute: async () => ({ success: true, output: "hit", backend: "ripgrep" }),
        }),
        read: tool({
          inputSchema: z.object({ path: z.string() }),
          execute: async (): Promise<never> => {
            throw new Error("not found");
          },
        }),
      },
    });

    const steps: SubagentStep[] = [];
    const off = onSubagentStep((step) => {
      if (step.parentToolCallId === "parent-1") steps.push(step);
    });
    const callbacks = buildStepCallbacks("parent-1", "agent-1");
    try {
      await agent.generate({ prompt: "find it", ...callbacks });
    } finally {
      off();
    }

    expect(steps.map((s) => [s.toolName, s.args, s.state])).toEqual([
      ["grep", "/needle/", "running"],
      ["grep", "/needle/", "done"],
      ["read", "missing.ts", "running"],
      ["read", "missing.ts", "error"],
    ]);
    expect(steps[1]?.backend).toBe("ripgrep");
    expect(callbacks._acc.stepCount).toBe(3);
    expect(callbacks._acc.toolUses).toBe(2);
    expect(callbacks._acc.input).toBe(30);
  });
});
