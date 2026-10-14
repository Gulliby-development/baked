import { afterEach, describe, expect, test } from "bun:test";
import { asksUnsupportedMethod } from "../src/core/workflows/analysis-notes.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Bench round 21, indentree: the analyzer asked in 4 generations for a method the schema lacks.
const INSPECTION =
  "AC-011 and FR-011 say automated, but plan and tasks require reviewer inspection of LICENSE; set both to the schema's inspection method";

describe("an analysis finding that asks for a verification method the schema lacks (#1065)", () => {
  test("is recognised; findings about the allowed methods are kept", () => {
    expect(asksUnsupportedMethod(INSPECTION)).toBe(true);
    expect(asksUnsupportedMethod("Change the verification method to 'review' for AC-002")).toBe(true);
    expect(asksUnsupportedMethod("FR-003 needs the demonstration method")).toBe(true);
    expect(asksUnsupportedMethod("AC-004 has method manual but a test can check it; use automated")).toBe(false);
    expect(asksUnsupportedMethod("AC-005 is automated but no task writes a test for it")).toBe(false);
    expect(asksUnsupportedMethod("The review of T003 is missing a criterion")).toBe(false);
  });

  test("is a note, so the spec is not returned and no person is asked", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    let analyses = 0;
    let instructions = "";
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "analysis") {
        analyses++;
        instructions = request.profile.instructions;
        const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
        return {
          output: {
            schemaVersion: 1,
            inputHash: data.inputHash,
            verdict: "needs_revision",
            findings: [
              { id: "F001", kind: "inconsistency", refs: ["spec.json", "AC-001"], description: INSPECTION, blocking: true },
            ],
          },
          inputTokens: 25,
          outputTokens: 25,
        };
      }
      return original(request);
    };
    const run = await fixture.start();
    const snapshot = await service.drive(run.runId, new AbortController().signal);
    expect(snapshot).toMatchObject({ status: "waiting", reason: "approval" });
    expect(analyses).toBe(1);
    expect(service.store.state(run.runId)).toMatchObject({ analysisPassed: true, analysisReplans: 0 });
    // The analyzer is told the vocabulary, so it does not raise the finding in the first place.
    expect(instructions).toContain("only automated, manual or post-release");
  });
});
