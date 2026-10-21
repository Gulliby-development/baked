import { afterEach, describe, expect, test } from "bun:test";
import { ProviderUnreachableError } from "../src/core/llm/provider-health.js";
import { canonical } from "../src/core/specs/hash.js";
import { closeProviderCircuit, recordProviderOutcome } from "../src/core/workflows/retry.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 58, wheeltags base specify (#1875). Each Codex attempt answered its first call with
// a complete submit_artifact call and got no byte on the call that answered the refusal. Codex
// reports a step's usage only once its tool call is answered, so every attempt had 0 tokens and
// was counted as an outage: three opened the circuit with "returned no tokens in 3 consecutive
// unreachable attempts", and each of three resumes got exactly one attempt, since the resume left
// the counter at 3.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The usage record of an R58 attempt: call 1 answered in 92 s, call 2 got nothing in 216 s. */
const STALLED_FOLLOW_UP = [
  { provider: "codex", stage: "spec", firstByteMs: 92_000, durationMs: 92_400, transport: "app-server" },
  { provider: "codex", stage: "spec", firstByteMs: null, durationMs: 216_000, limitMs: 216_000, transport: "app-server", resumed: true },
];
const NO_RESPONSE = [{ provider: "codex", stage: "spec", firstByteMs: null, durationMs: 600_000 }];

function stallingFixture(calls: () => unknown[]) {
  let specAttempts = 0;
  const fixture = workflowFixture({
    executor: (root) =>
      new (class StallingSpecExecutor extends FixtureExecutor {
        override async execute(request: ExecutionRequest) {
          if (request.profile.output !== "spec") return super.execute(request);
          specAttempts++;
          fixture.service.store.artifact(
            request.runId,
            "usage",
            `attempts/${request.attemptId}/usage.json`,
            canonical({ schemaVersion: 1, totalTokens: 0, stopReason: "error", steps: [], calls: calls() }),
          );
          // The executor records every finished step's spend; Codex reported none of it (#820).
          fixture.service.store.recordAttemptUsage(request.runId, request.attemptId, 0);
          throw new ProviderUnreachableError(request.profile.model, "No model response within 216 seconds");
        }
      })(root),
  });
  cleanups.push(fixture.dispose);
  fixture.service.providerProbe = async () => ({});
  fixture.service.providerDelay = async () => {};
  return { fixture, attempts: () => specAttempts };
}

describe("scenario: wheeltags base specify, an answered call and a stalled follow-up (#1875)", () => {
  test("the stop says the model answered, and a resume gets a full window of attempts", async () => {
    const { fixture, attempts } = stallingFixture(() => STALLED_FOLLOW_UP);
    const run = await fixture.start();
    const signal = new AbortController().signal;
    const stopped = await fixture.service.drive(run.runId, signal);
    expect(stopped).toMatchObject({ status: "blocked", reason: "no_progress" });
    expect(attempts()).toBe(3);
    const diagnostics = fixture.service.store
      .artifacts(run.runId)
      .filter((a) => a.kind === "diagnostic")
      .map((a) => fixture.service.store.readArtifact(run.runId, a.id))
      .join("\n");
    expect(diagnostics).toContain(
      "answered 1 call(s) of spec-author, then gave no response within 216 s on call 2, in 3 consecutive attempts",
    );
    expect(diagnostics).not.toContain("returned no tokens");

    await fixture.service.resume(run.runId, {
      commandId: newId(),
      expectedRevision: fixture.service.store.run(run.runId).revision,
    });
    const again = await fixture.service.drive(run.runId, signal);
    expect(again).toMatchObject({ status: "blocked", reason: "no_progress" });
    // Three more attempts, not one.
    expect(attempts()).toBe(6);
  }, 60_000);

  test("attempts without any response still open the circuit as an outage", async () => {
    const { fixture, attempts } = stallingFixture(() => NO_RESPONSE);
    const run = await fixture.start();
    const stopped = await fixture.service.drive(run.runId, new AbortController().signal);
    expect(stopped).toMatchObject({ status: "blocked", reason: "no_progress" });
    expect(attempts()).toBe(3);
    const diagnostics = fixture.service.store
      .artifacts(run.runId)
      .filter((a) => a.kind === "diagnostic")
      .map((a) => fixture.service.store.readArtifact(run.runId, a.id))
      .join("\n");
    expect(diagnostics).toContain("returned no tokens in 3 consecutive unreachable attempts");
  }, 60_000);
});

describe("provider outcome counters (#1875)", () => {
  test("an answered call makes an attempt a stall; recorded usage (claude-code) counts nothing", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const store = fixture.service.store;
    const attempt = (calls: unknown[], tokens: number) => {
      const step = store.beginStep(run.runId, "specify");
      const id = store.reserve(run.runId, step, "fixture/model", 1, fixture.policy);
      store.artifact(run.runId, "usage", `attempts/${id}/usage.json`, canonical({ schemaVersion: 1, steps: [], calls }));
      const error = new ProviderUnreachableError("fixture/model");
      store.finishAttempt(run.runId, id, "failed", tokens, false, error);
      return recordProviderOutcome(store, run.runId, id, "specifier", undefined, error);
    };
    // Codex native: the answered call has no usage yet.
    expect(attempt(STALLED_FOLLOW_UP, 0)).toEqual({ failures: 0, stalls: 1, answered: 1, waitedSeconds: 216 });
    expect(attempt(STALLED_FOLLOW_UP, 0)).toMatchObject({ failures: 0, stalls: 2 });
    expect(attempt(NO_RESPONSE, 0)).toEqual({ failures: 1, stalls: 0, answered: 0, waitedSeconds: 600 });
    // claude-code reports each call's usage, so an answered call leaves tokens and counts nothing.
    expect(attempt(STALLED_FOLLOW_UP, 1200)).toMatchObject({ failures: 0, stalls: 0 });
    expect(attempt(NO_RESPONSE, 0)).toMatchObject({ failures: 1 });
    expect(attempt(NO_RESPONSE, 0)).toMatchObject({ failures: 2 });

    // A resume that did not follow the circuit's stop keeps counting.
    closeProviderCircuit(store, run.runId, newId());
    expect(attempt(NO_RESPONSE, 0)).toMatchObject({ failures: 3 });
    store.artifact(run.runId, "recovery", "provider/circuit.json", canonical({ open: true }));
    closeProviderCircuit(store, run.runId, newId());
    expect(attempt(NO_RESPONSE, 0)).toMatchObject({ failures: 1 });
  });
});
