import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { reproEnv } from "../src/core/verification/repro.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A required reviewer that cannot establish AC-001 however it is asked (endfix 2295dbbd, AC-001). */
class UnsureReviewer extends FixtureExecutor {
  reviewPrompts: string[] = [];
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output !== "review") return result;
    this.reviewPrompts.push(request.prompt);
    const review = result.output as { verdict: string; coverage: Record<string, unknown>[] };
    review.verdict = "inconclusive";
    review.coverage = [
      {
        criterionId: "AC-001",
        verdict: "inconclusive",
        evidenceIds: [],
        explanation: "installed console-script execution not verified",
      },
    ];
    return result;
  }
}

describe("a required reviewer that returns inconclusive", () => {
  test("is asked once more with the open criteria, then its gap goes to converge", async () => {
    const fixture = workflowFixture({ executor: (root) => new UnsureReviewer(root) });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const done = await fixture.service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    const asked = fixture.executor.reviewPrompts;
    expect(asked).toHaveLength(2);
    expect(asked[0]).not.toContain("inconclusiveCriteria");
    expect(asked[1]).toContain("inconclusiveCriteria");
    expect(asked[1]).toContain("installed console-script execution not verified");
    const convergence = fixture.executor.prompts.convergence?.at(-1) ?? "";
    expect(convergence).toContain("evidenceGaps");
    expect(convergence).toContain("AC-001");
  });
});

describe("reviewer repros with the project importable", () => {
  const dir = () => {
    const root = mkdtempSync(join(tmpdir(), "baked-repro-env-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return root;
  };

  test("a src-layout Python project gets its src directory on PYTHONPATH", () => {
    const root = dir();
    writeFileSync(join(root, "pyproject.toml"), "[project]\nname = 'endfix'\n");
    mkdirSync(join(root, "src", "endfix"), { recursive: true });
    const path = reproEnv(root).PYTHONPATH ?? "";
    expect(path.split(delimiter)).toContain(join(root, "src"));
  });

  test("other projects keep the plain environment", () => {
    const root = dir();
    mkdirSync(join(root, "src"));
    const before = process.env.PYTHONPATH;
    expect(reproEnv(root).PYTHONPATH).toBe(before);
  });
});
