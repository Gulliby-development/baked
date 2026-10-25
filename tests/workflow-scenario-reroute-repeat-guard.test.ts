import { afterEach, describe, expect, test } from "bun:test";
import { errorRecovery } from "../src/core/workflows/remedies.js";
import type { ExecutionRequest, RunSnapshot } from "../src/core/workflows/types.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { expectRecovery } from "./helpers/workflow-remedies.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 69, commitbump-update 0894df2d (#2191). Converge was blocked
// `invalid_output` twice with the same diagnostic. The loop ran `baked workflow reroute RUN
// --route converge=OTHER --resume`: the routing was written, and the resume half was refused with
// STALE_DECISION `repeated_invalid_output`, because the repeat guard keyed "the input changed" by
// the prompt alone. Here the analysis stands for the stage: the fixture model keeps submitting a
// verdict the schema does not know, and the spare model answers well.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;

function fixture() {
  const f = workflowFixture();
  cleanups.push(f.dispose);
  const original = f.executor.execute.bind(f.executor);
  const models: string[] = [];
  f.executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output !== "analysis") return original(request);
    models.push(request.profile.model);
    if (request.profile.model === "fixture/model")
      return { output: { schemaVersion: 1, verdict: "maybe", findings: [] }, inputTokens: 25, outputTokens: 25 };
    return original(request);
  };
  return { ...f, models };
}

/** The run blocked `invalid_output` twice with one diagnostic, and a plain resume refused. */
async function blockedTwice(f: ReturnType<typeof fixture>): Promise<string> {
  const run = await f.start();
  expect(await f.service.drive(run.runId, signal())).toMatchObject({ status: "blocked", reason: "invalid_output" });
  await f.resume(run.runId);
  expect(await f.service.drive(run.runId, signal())).toMatchObject({ status: "blocked", reason: "invalid_output" });
  return run.runId;
}

const refusal = (f: ReturnType<typeof fixture>, runId: string) =>
  f.resume(runId).then(() => null, (error: Error & { code?: string }) => error);

const cli = (f: ReturnType<typeof fixture>, argv: string[]) =>
  executeWorkflowCommand(f.service, parseWorkflowArgs(argv), signal()) as Promise<RunSnapshot>;

describe("scenario: commitbump-update 0894df2d, reroute --resume after a repeated invalid output (#2191)", () => {
  test("reroute --resume drives the stage on the new model", async () => {
    const f = fixture();
    const runId = await blockedTwice(f);
    const revision = f.service.store.run(runId).revision;
    const driven = await cli(f, ["reroute", runId, "--expected-revision", String(revision), "--route", "analyze=spare/model", "--resume"]);
    expect(driven).toMatchObject({ status: "waiting", reason: "approval" });
    expect(f.models).toEqual(["fixture/model", "fixture/model", "spare/model"]);
    expect(f.service.store.latestArtifact(runId, "routing.json")?.revision).toBe(2);
    // The note went into the prompt once; the reroute did not add it again.
    const note = "The previous attempt of this stage was rejected as invalid output";
    expect(f.service.store.state(runId).prompt.split(note)).toHaveLength(2);
  });

  test("a plain resume with an unchanged route is still refused, before and after a reroute", async () => {
    const f = fixture();
    const runId = await blockedTwice(f);
    const before = await refusal(f, runId);
    expect(before?.code).toBe("STALE_DECISION");
    expect(before?.message).toContain("stopped again with the same diagnostic");
    // A reroute that leaves the stage on the failing model still changes the routing revision:
    // the stage runs once more, then the same stop with the same routing is refused again.
    const revision = f.service.store.run(runId).revision;
    await cli(f, ["reroute", runId, "--expected-revision", String(revision), "--route", "review=spare/model", "--resume"]);
    expect(f.service.store.run(runId)).toMatchObject({ status: "blocked", reason: "invalid_output" });
    const after = await refusal(f, runId);
    expect(after?.code).toBe("STALE_DECISION");
    expect(f.models).toEqual(["fixture/model", "fixture/model", "fixture/model"]);
    expect(f.service.store.run(runId)).toMatchObject({ status: "blocked", reason: "invalid_output" });
  });

  test("the refusal names reroute as a way out, in the CLI text and the remedies", async () => {
    const f = fixture();
    const runId = await blockedTwice(f);
    const refused = await refusal(f, runId);
    expect(refused?.message).toContain(`baked workflow reroute ${runId} --route STAGE=MODEL --resume`);
    expectRecovery(refused?.message ?? "", errorRecovery(refused), "reroute");
    expect(errorRecovery(refused)?.remedies.map((r) => r.action)).toEqual(["reroute", "revise", "replan", "cancel"]);
  });
});
