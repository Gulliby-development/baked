import { afterEach, describe, expect, test } from "bun:test";
import { canonical } from "../src/core/specs/hash.js";
import { INVALID_OUTPUT_KEY, repeatsInvalidOutput } from "../src/core/workflows/invalid-output-repeat.js";
import { ROW_CLAIM_RESUME_DIR } from "../src/core/workflows/row-claim-repair.js";
import { ROW_CLAIM_KIND, type RowClaimRecord } from "../src/core/workflows/row-claims.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

// The repeat guard of a resume after `invalid_output` (#1348) keys a diagnostic without refused
// writes by the diagnostic and needs the prompt to hold its note. A run with an overridden row
// claim (#2561) has the note rewritten from the request's rows as soon as it goes in (#2563), so
// the prompt never holds the note as written: every later stop with the same diagnostic was a
// `first`, and a plain resume could repeat the same attempt without end. The key was recorded
// before that repair too, so the repair's own record made the next stop look like progress.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const TEST = "tests/deflate_match_test.c";
const REQUEST = ["Create ready value.", "", "```text", `deflate_match_test in ${TEST} (1 row)`, `run "deflate" "--hex" stdin="61" => 0 "ab1805440300\\n" ""`, "```", ""].join("\n");
const DIAGNOSTIC = `Task T002 did not complete its implementation: Set the expected stream of row 2 in ${TEST} to ab1805240200.`;

describe("the invalid-output repeat guard on a run whose row claims were overridden", () => {
  test("the same diagnostic after a resume that repaired its note is a repeat", async () => {
    const f = workflowFixture();
    cleanups.push(f.dispose);
    const original = f.executor.execute.bind(f.executor);
    let attempts = 0;
    f.executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output !== "analysis") return original(request);
      attempts++;
      return { output: { schemaVersion: 1, verdict: "maybe", findings: [] }, inputTokens: 25, outputTokens: 25 };
    };
    const { service } = f;
    const store = service.store;
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy: f.policy });
    const runId = run.runId;
    expect(await service.drive(runId, signal())).toMatchObject({ status: "blocked", reason: "invalid_output" });
    // An earlier resume overrode a restatement that gave the row another stream (#2561).
    const record: RowClaimRecord = {
      schemaVersion: 1,
      site: "resume",
      ref: "decisions/clarification-T002.json",
      mode: "on",
      verdict: "overridden",
      conflicts: [{ path: TEST, row: 1, kind: "literal", claimed: "ab1805240200", prescribed: "ab1805440300\\n" }],
    };
    store.artifact(runId, ROW_CLAIM_KIND, `${ROW_CLAIM_RESUME_DIR}decisions-clarification-T002.json`, canonical(record));
    // The stop's diagnostic restates the overridden stream.
    store.artifact(runId, "diagnostic", `errors/${newId()}.txt`, DIAGNOSTIC);

    await f.resume(runId);
    // The note went in with the request's stream (#2563).
    const prompt = store.state(runId).prompt;
    expect(prompt).toContain("ab1805440300");
    expect(prompt).not.toContain("ab1805240200");
    expect(store.latestArtifact(runId, INVALID_OUTPUT_KEY)).not.toBeNull();

    // The next attempt stops with the same diagnostic; nothing a person can change has changed.
    expect(await service.drive(runId, signal())).toMatchObject({ status: "blocked", reason: "invalid_output" });
    store.artifact(runId, "diagnostic", `errors/${newId()}.txt`, DIAGNOSTIC);
    expect(repeatsInvalidOutput(store, runId)).toBe(true);
    const before = attempts;
    const refused = await f.resume(runId).then(
      () => null,
      (error: Error & { code?: string }) => error,
    );
    expect(refused?.code).toBe("STALE_DECISION");
    expect(attempts).toBe(before);
    // The note went into the prompt once.
    expect(store.state(runId).prompt.split("The previous attempt of this stage was rejected as invalid output")).toHaveLength(2);
  });
});
