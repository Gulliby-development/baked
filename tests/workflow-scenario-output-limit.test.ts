import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { lowerEffort } from "../src/core/llm/model-routing.js";
import { outputLimitUsage } from "../src/core/workflows/agent-executor.js";
import { isCapacityError, isOutputLimit, isTransient } from "../src/core/workflows/retry.js";
import { OUTPUT_LIMIT_CEILING, raisedOutputCap } from "../src/core/workflows/scheduler.js";
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

// Bench round R103 (md-site e0ffee1e, #2961): the spec author ran on Claude Code under
// CLAUDE_CODE_MAX_OUTPUT_TOKENS=8192, its spec ran past it, and every retry was told to split
// into smaller tool calls at the same 8192 cap: four failed attempts before a shorter sample fit.

/** The spec step fails at Claude Code's output cap while its limit is below `fits`. */
class SpecCapExecutor extends FixtureExecutor {
  specCalls: { cap: number; effort: string | undefined; notice: string | undefined }[] = [];
  fits = 16384;
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "spec") {
      const cap = request.profile.maxOutputTokens;
      this.specCalls.push({
        cap,
        effort: request.effort,
        notice: request.prompt.match(/The host raised this step's output limit[^.]*\./)?.[0],
      });
      if (cap < this.fits)
        throw new Error(
          `API Error: Claude's response exceeded the ${cap} output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`,
        );
    }
    return super.execute(request);
  }
}

async function specify(fits: number, effort = "high") {
  const fixture = workflowFixture({ executor: (root) => new SpecCapExecutor(root) });
  cleanups.push(fixture.dispose);
  fixture.executor.fits = fits;
  const author = builtinProfiles.find((profile) => profile.id === "spec-author");
  const agents = join(fixture.root, "baked", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "spec-author.json"), JSON.stringify({ ...author, maxOutputTokens: 8192, effort }));
  const run = await fixture.start();
  const done = await fixture.service.drive(run.runId, new AbortController().signal);
  return { fixture, done };
}

describe("scenario: a spec past the output cap (#2961, R103 md-site)", () => {
  test("the retry doubles the cap at the same effort, so the step ends after one failed attempt", async () => {
    const { fixture, done } = await specify(16384);
    expect(done.status).not.toBe("failed");
    expect(fixture.executor.specCalls).toEqual([
      { cap: 8192, effort: "high", notice: undefined },
      { cap: 16384, effort: "high", notice: "The host raised this step's output limit from 8192 to 16384 tokens." },
    ]);
  }, 60000);

  test("a spec still too long gets a second doubling, and no more than the retry budget", async () => {
    const { fixture } = await specify(1_000_000);
    expect(fixture.executor.specCalls.slice(0, 3).map((call) => call.cap)).toEqual([8192, 16384, 32768]);
  }, 60000);
});

describe("raisedOutputCap", () => {
  test("doubles a document step's cap up to the ceiling and leaves implementation steps alone", () => {
    expect(raisedOutputCap({ output: "spec", maxOutputTokens: 8192 })).toBe(16384);
    expect(raisedOutputCap({ output: "review", maxOutputTokens: 20000 })).toBe(OUTPUT_LIMIT_CEILING);
    expect(raisedOutputCap({ output: "plan", maxOutputTokens: OUTPUT_LIMIT_CEILING })).toBeNull();
    expect(raisedOutputCap({ output: "implementation", maxOutputTokens: 8192 })).toBeNull();
  });
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
