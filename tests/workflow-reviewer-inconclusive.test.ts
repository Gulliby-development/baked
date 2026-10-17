import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { reaskableCriteria } from "../src/core/verification/convergence-stop.js";
import { reproEnv } from "../src/core/verification/repro.js";
import { workspaceInventory } from "../src/core/workflows/workspace-facts.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A required reviewer that cannot establish AC-001 however it is asked (endfix 2295dbbd, AC-001). */
class UnsureReviewer extends FixtureExecutor {
  reviewPrompts: string[] = [];
  reviewSteps: (number | undefined)[] = [];
  explanation = "installed console-script execution not verified";
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output !== "review") return result;
    this.reviewPrompts.push(request.prompt);
    this.reviewSteps.push(request.maxSteps);
    const review = result.output as { verdict: string; coverage: Record<string, unknown>[] };
    review.verdict = "inconclusive";
    review.coverage = [
      {
        criterionId: "AC-001",
        verdict: "inconclusive",
        evidenceIds: [],
        explanation: this.explanation,
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
    // The second question gets half the steps of the first (#1506).
    const [first, second] = fixture.executor.reviewSteps;
    expect(second).toBeLessThan(first ?? 0);
    const convergence = fixture.executor.prompts.convergence?.at(-1) ?? "";
    expect(convergence).toContain("evidenceGaps");
    expect(convergence).toContain("AC-001");
  });
});

// Bench round 42, fecsmith release 7430a492 (#1506): AC-006 counted the repository's production
// and test files. The reviewer had no file list, answered inconclusive, was asked again with the
// same tools for 583k tokens and gave the same answer; the criterion was accepted unverified.
describe("criteria that count files (#1506)", () => {
  test("a criterion whose explanation names evidence the reviewer cannot produce is not asked again", async () => {
    const fixture = workflowFixture({
      executor: (root) => {
        const executor = new UnsureReviewer(root);
        executor.explanation = "a recursive reviewer-side Java-file inventory would settle the remaining uncertainty";
        return executor;
      },
    });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const done = await fixture.service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(fixture.executor.reviewPrompts).toHaveLength(1);
    expect(fixture.executor.prompts.convergence?.at(-1) ?? "").toContain("evidenceGaps");
  });

  test("the reviewer gets the workspace's file list and settles the count from it", async () => {
    const fixture = workflowFixture({ executor: (root) => new CountingReviewer(root) });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const done = await fixture.service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    const inventory = fixture.executor.inventories[0];
    expect(inventory?.paths).toContain("value.txt");
    expect(inventory?.totalFiles).toBe(inventory?.paths.length);
    // Settled on the first question: no second ask and no evidence gap.
    expect(fixture.executor.inventories).toHaveLength(1);
    expect(fixture.executor.prompts.convergence?.at(-1) ?? "").not.toContain("evidenceGaps");
  });

  test("only criteria without such an explanation are asked again", () => {
    const item = (criterionId: string, explanation: string) => ({ criterionId, verdict: "inconclusive" as const, evidenceIds: [], explanation });
    const open = reaskableCriteria([
      item("AC-001", "installed console-script execution not verified"),
      item("AC-002", "I cannot list the files of the repository"),
      item("AC-003", "a dedicated test that runs the CLI would establish it"),
      item("AC-004", "requires running the server against a real database"),
      { ...item("AC-005", "covered by E2"), verdict: "pass" as const },
    ]);
    expect(open.map((c) => c.criterionId)).toEqual(["AC-001"]);
  });

  test("the inventory lists git's tracked and untracked files, not ignored or deleted ones", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-inventory-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root });
    git("init", "-q");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, ".gitignore"), "out/\n");
    writeFileSync(join(root, "src", "a.ts"), "");
    writeFileSync(join(root, "src", "b.ts"), "");
    writeFileSync(join(root, "tests", "a.test.ts"), "");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    rmSync(join(root, "src", "b.ts"));
    writeFileSync(join(root, "src", "c.ts"), "");
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "out", "bundle.js"), "");
    const inventory = workspaceInventory(root);
    expect(inventory.paths).toEqual([".gitignore", "src/a.ts", "src/c.ts", "tests/a.test.ts"]);
    expect(inventory.totalFiles).toBe(4);
    expect(inventory.testFiles).toBe(1);
    expect(inventory.truncated).toBe(false);
  });
});

/** A reviewer that settles AC-001 only from the host's file list. */
class CountingReviewer extends FixtureExecutor {
  inventories: { paths: string[]; totalFiles: number }[] = [];
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output !== "review") return result;
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { extra?: { workspaceInventory?: { paths: string[]; totalFiles: number } } };
    const inventory = data.extra?.workspaceInventory;
    if (!inventory) {
      const review = result.output as { verdict: string; coverage: Record<string, unknown>[] };
      review.verdict = "inconclusive";
      review.coverage = [{ criterionId: "AC-001", verdict: "inconclusive", evidenceIds: [], explanation: "file count not checked" }];
      return result;
    }
    this.inventories.push(inventory);
    return result;
  }
}

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
