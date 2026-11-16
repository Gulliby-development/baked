import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import {
  type ClaudeCodeProcessFactory,
  ClaudeCodeSessionRunner,
  createClaudeCodeLanguageModel,
} from "../src/core/llm/providers/claude-code.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { accountRefusal, usageLimitReset } from "../src/core/workflows/retry.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor } from "../src/core/workflows/types.js";
import { resolveUsageLimitReset } from "../src/core/workflows/usage-limit-reset.js";

// Follow-up of R110 (#3055, #3056). A Claude session limit blocked the run `provider_account`
// with "resets 9:10pm (Europe/Warsaw)", and the run waited for a person past the reset. Claude
// Code also reports the limit as a structured `rate_limit_event` with `status: "rejected"`, which
// BAKED kept only for the limits panel: a turn whose own words named no limit was retried.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const OPTIONS: LanguageModelV3CallOptions = {
  prompt: [
    { role: "system", content: "You are baked." },
    { role: "user", content: [{ type: "text", text: "Plan the feature" }] },
  ],
};

/** A `claude -p` stand-in that answers every turn with `events`. */
function claudeAnswering(events: Record<string, unknown>[]): ClaudeCodeProcessFactory {
  return () => {
    const lines: ((line: string) => void)[] = [];
    return {
      send() {
        queueMicrotask(() => {
          for (const event of events) for (const listener of lines) listener(JSON.stringify(event));
        });
      },
      onLine(listener) {
        lines.push(listener);
      },
      onExit() {},
      kill() {},
    };
  };
}

const RESET = Date.parse("2026-11-15T20:10:00Z") / 1000;
const rejected = {
  type: "rate_limit_event",
  rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: RESET, utilization: 1 },
};
const failedTurn = { type: "result", subtype: "error_during_execution", is_error: true, result: "Request failed" };

async function turnError(events: Record<string, unknown>[]): Promise<unknown> {
  const model = createClaudeCodeLanguageModel("sonnet", new ClaudeCodeSessionRunner(claudeAnswering(events)));
  try {
    await model.doGenerate(OPTIONS);
  } catch (error) {
    return error;
  }
  throw new Error("the turn did not fail");
}

describe("scenario: Claude usage limit with a stated reset (#3056)", () => {
  test("a failed turn after a rejected rate_limit_event is a usage limit with its reset", async () => {
    const error = await turnError([rejected, failedTurn]);
    expect(accountRefusal(error)).toBe("limit");
    expect(usageLimitReset(error)).toBe("2026-11-15T20:10:00.000Z");
  });

  test("a failed turn after an allowed rate_limit_event is not a limit", async () => {
    const allowed = { ...rejected, rate_limit_info: { ...rejected.rate_limit_info, status: "allowed" } };
    const error = await turnError([allowed, failedTurn]);
    expect(accountRefusal(error)).toBeNull();
  });

  test("the provider's reset words resolve in their own time zone", () => {
    const now = new Date("2026-11-15T18:00:00Z");
    const at = (words: string) => resolveUsageLimitReset(words, now, "Europe/Warsaw")?.at.toISOString() ?? null;
    expect(at("9:10pm (Europe/Warsaw)")).toBe("2026-11-15T20:10:00.000Z");
    expect(at("3pm (America/New_York)")).toBe("2026-11-15T20:00:00.000Z");
    // A wall time already past today is tomorrow's (19:00 in Warsaw now).
    expect(at("6pm")).toBe("2026-11-16T17:00:00.000Z");
    expect(at("Nov 20, 10am")).toBe("2026-11-20T09:00:00.000Z");
    expect(at("Oct 22nd, 2026 10:55 AM")).toBe("2026-10-22T08:55:00.000Z");
    expect(at("2026-11-01 at 00:00 UTC")).toBe("2026-11-01T00:00:00.000Z");
    expect(at("4 days 3 hours")).toBe("2026-11-19T21:00:00.000Z");
    expect(at("2026-11-15T20:10:00.000Z")).toBe("2026-11-15T20:10:00.000Z");
    // Summer time: 9:10pm in Warsaw is 19:10 UTC in July.
    expect(resolveUsageLimitReset("9:10pm (Europe/Warsaw)", new Date("2026-07-01T12:00:00Z"))?.at.toISOString()).toBe("2026-07-01T19:10:00.000Z");
    expect(at("soon")).toBeNull();
    expect(at("10am (Mars/Base)")).toBeNull();
  });

  test("a run blocked on a session limit records the resume at the reset, in shadow", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-limit-reset-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const limit = new Error("You've hit your session limit · resets 9:10pm (Europe/Warsaw)");
    let calls = 0;
    const executor: AgentExecutor = {
      async execute() {
        calls++;
        throw limit;
      },
    };
    const policy: RunPolicy = {
      ...defaultWorkflowPolicy,
      checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }],
    };
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
    const before = Date.now();
    const final = await service.drive(run.runId, new AbortController().signal);
    expect(final.status).toBe("blocked");
    expect(service.store.run(run.runId).reason).toBe("provider_account");
    expect(calls).toBe(1);
    const resumes = service.store
      .eventsOfType(run.runId, "decision.would_resume")
      .flatMap((e) => (e.type === "decision.would_resume" ? [e.payload] : []));
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({ reason: "host-resume-on-usage-limit-reset", mode: "shadow" });
    const inputs = resumes[0]?.inputs as { words: string; zone: string; resetAt: string; resumeAt: string; marginMs: number };
    expect(inputs.words).toBe("9:10pm (Europe/Warsaw)");
    expect(inputs.zone).toBe("Europe/Warsaw");
    const reset = Date.parse(inputs.resetAt);
    expect(reset).toBeGreaterThan(before);
    expect(reset - before).toBeLessThanOrEqual(24 * 3_600_000);
    expect(Date.parse(inputs.resumeAt) - reset).toBe(inputs.marginMs);
    // Shadow: the run stays blocked for a person.
    expect(service.store.run(run.runId).status).toBe("blocked");
  });
});
