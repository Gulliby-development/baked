import { afterEach, describe, expect, test } from "bun:test";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { isRateLimit, isTransient, retryDelay } from "../src/core/workflows/retry.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 21 (#1068): indentree had three short, independent provider outages. Each resumed
// by itself, but the resume counter lived for the whole run, so the third waited 9 minutes for an
// outage that had cleared and a fourth would have blocked the run for good.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const outage = () =>
  new WorkflowFault("OUTPUT_INVALID", "fetch failed: socket hang up", {
    reason: "provider_unavailable",
  });

/** The implementer's first call fails, then the first model call after the implementation does. */
function twoOutages() {
  const outputs: string[] = [];
  let implementerFailed = false;
  let laterFailed = false;
  const fixture = workflowFixture({
    executor: (root) =>
      new (class extends FixtureExecutor {
        override async execute(request: ExecutionRequest) {
          const output = request.profile.output;
          outputs.push(output);
          if (output === "implementation" && !implementerFailed) {
            implementerFailed = true;
            throw outage();
          }
          if (implementerFailed && output !== "implementation" && !laterFailed) {
            laterFailed = true;
            throw outage();
          }
          return super.execute(request);
        }
      })(root),
  });
  (fixture.config.workflows as { stall?: Record<string, number> }).stall = {
    providerWaitMs: 0,
    providerResumes: 1,
  };
  cleanups.push(() => fixture.dispose());
  return { fixture, outputs, failedTwice: () => implementerFailed && laterFailed };
}

describe("independent provider outages in one run", () => {
  test("each outage gets its own automatic resumes once an attempt completed between them", async () => {
    const { fixture, failedTwice } = twoOutages();
    const run = await fixture.start();
    const signal = new AbortController().signal;
    await fixture.service.drive(run.runId, signal);
    await fixture.approve(run.runId);
    const snapshot = await fixture.service.drive(run.runId, signal);
    expect(failedTwice()).toBe(true);
    expect(snapshot.status).toBe("completed");
    const store = fixture.service.store;
    const resume = store.latestArtifact(run.runId, "provider/resume-1.json");
    expect(resume?.revision).toBe(2);
    const failed = store
      .events(run.runId, 0, 5000)
      .filter((e) => e.type === "attempt.finished" && e.payload.status === "failed");
    expect(failed).toHaveLength(2);
    for (const event of failed)
      expect(event.payload).toMatchObject({
        error: { code: "OUTPUT_INVALID", message: "fetch failed: socket hang up" },
      });
  });
});

describe("a rate limit", () => {
  const codex429 = new Error("429 Too Many Requests: exceeded retry limit");

  test("is told apart from spent credits and capacity", () => {
    expect(isRateLimit(codex429)).toBe(true);
    expect(isRateLimit({ statusCode: 429, message: "Rate limit reached for requests" })).toBe(true);
    expect(isTransient(codex429)).toBe(true);
    expect(
      isRateLimit({ statusCode: 429, message: "You have no credits remaining. Add credits." }),
    ).toBe(false);
    expect(isRateLimit(new Error("Selected model is at capacity"))).toBe(false);
  });

  test("backs off 5, 15 and 45 seconds instead of retrying within seconds", () => {
    const waits = [0, 1, 2].map((retry) => retryDelay(codex429, retry) ?? 0);
    expect(waits[0]).toBeGreaterThanOrEqual(5_000);
    expect(waits[1]).toBeGreaterThanOrEqual(15_000);
    expect(waits[2]).toBeGreaterThanOrEqual(45_000);
    expect(retryDelay(codex429, 3)).toBeNull();
  });

  test("honours a longer retry-after", () => {
    const limited = {
      statusCode: 429,
      message: "Too Many Requests",
      responseHeaders: { "retry-after": "120" },
    };
    expect(retryDelay(limited, 0)).toBe(120_000);
  });
});
