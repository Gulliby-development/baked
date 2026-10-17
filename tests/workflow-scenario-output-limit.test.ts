import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { lowerEffort } from "../src/core/llm/model-routing.js";
import { outputLimitUsage } from "../src/core/workflows/agent-executor.js";
import { isCapacityError, isOutputLimit, isTransient } from "../src/core/workflows/retry.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 41 (fpbits, #1479): task T003 of the numbers feature ran 10 minutes at xhigh and
// ended "Incomplete response returned, reason: max_output_tokens". The call was wrapped as
// provider_unavailable, the run blocked on the outage ladder for a minute, and the same prompt
// ran again at the same effort.

const OUTPUT_LIMIT = "Incomplete response returned, reason: max_output_tokens";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Implementation calls past the output cap `failures` times, then succeed. */
class OutputLimitExecutor extends FixtureExecutor {
  tries: { effort: string | undefined; notice: boolean }[] = [];
  failures = 1;
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "implementation") {
      this.tries.push({ effort: request.effort, notice: request.prompt.includes("ran past the provider's output limit") });
      if (this.tries.length <= this.failures) throw new Error(OUTPUT_LIMIT);
    }
    return super.execute(request);
  }
}

async function implement(failures: number, effort?: string) {
  const fixture = workflowFixture({ executor: (root) => new OutputLimitExecutor(root) });
  cleanups.push(fixture.dispose);
  fixture.executor.failures = failures;
  if (effort) {
    const implementer = builtinProfiles.find((profile) => profile.id === "implementer");
    const agents = join(fixture.root, "baked", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "implementer.json"), JSON.stringify({ ...implementer, effort }));
  }
  const run = await fixture.start();
  const signal = new AbortController().signal;
  await fixture.service.drive(run.runId, signal);
  await fixture.approve(run.runId);
  const done = await fixture.service.drive(run.runId, signal);
  const events = fixture.service.store.events(run.runId, 0, 10000);
  return { fixture, runId: run.runId, done, events };
}

describe("scenario: a response past the provider's output cap (#1479, R41)", () => {
  test("is retried at once one effort step lower and told why, without blocking the run", async () => {
    const { fixture, done, events } = await implement(1, "xhigh");
    expect(done.status).toBe("completed");
    expect(fixture.executor.tries).toEqual([
      { effort: "xhigh", notice: false },
      { effort: "high", notice: true },
    ]);
    // No outage block and no lost worker: the retry is part of the same task attempt.
    expect(JSON.stringify(events)).not.toContain("provider_unavailable");
    expect(JSON.stringify(events)).not.toContain("worker_lost");
  }, 60000);

  test("a route without effort gets one retry with the notice", async () => {
    const { fixture, done } = await implement(1);
    expect(done.status).toBe("completed");
    expect(fixture.executor.tries).toEqual([
      { effort: undefined, notice: false },
      { effort: undefined, notice: true },
    ]);
  }, 60000);

  test("steps down twice at most before the failure takes the usual path", async () => {
    const { fixture } = await implement(10, "xhigh");
    expect(fixture.executor.tries.slice(0, 3).map((c) => c.effort)).toEqual(["xhigh", "high", "medium"]);
  }, 60000);
});

describe("isOutputLimit", () => {
  test("recognises each provider's output cap error and nothing else", () => {
    expect(isOutputLimit(new Error(OUTPUT_LIMIT))).toBe(true);
    expect(
      isOutputLimit(new Error("API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.")),
    ).toBe(true);
    expect(isOutputLimit(new Error("Invalid 'max_output_tokens': integer below minimum value"))).toBe(false);
    expect(isOutputLimit(new Error("socket hang up"))).toBe(false);
    expect(isTransient(new Error(OUTPUT_LIMIT))).toBe(false);
    expect(isCapacityError(new Error(OUTPUT_LIMIT))).toBe(false);
  });

  test("the effort steps down to low and no further, and default has nothing to lower", () => {
    expect(["max", "xhigh", "high", "medium", "low"].map((e) => lowerEffort(e as "max"))).toEqual(["xhigh", "high", "medium", "low", null]);
    expect(lowerEffort("default")).toBeNull();
    expect(lowerEffort(undefined)).toBeNull();
  });

  test("a call past the cap is estimated at the messages it was sent and a full response", () => {
    expect(outputLimitUsage(40_001, 32_000)).toEqual({ inputTokens: 10_001, outputTokens: 32_000 });
  });
});
