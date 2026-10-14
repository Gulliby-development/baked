import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

/**
 * Bench round 21, cfgtrace 424e275b (#1067): a ruff failure at the end of T005 opened a corrective
 * task with T005's whole scope. T013 spent 1.56M tokens on three ruff rules, rewrote code and
 * created two test files. The planned task here writes a module, its tests and a README and leaves
 * a lint diagnostic in the module; the correction may write only that module.
 */
class LintExecutor extends FixtureExecutor {
  implementations: ExecutionRequest[] = [];
  constructor(private dir: string) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const markdown = "# Plan\n## Context\nWrite the parser.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nsrc/cfg.py\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture";
      const writes = ["src/cfg.py", "tests/test_cfg.py", "README.md", "value.txt"].map((path) => ({ path, action: "create" as const }));
      return {
        output: {
          schemaVersion: 1,
          markdown,
          taskGraph: {
            schemaVersion: 1,
            featureId: "fixture",
            revision: 1,
            specHash: hashJson(fixtureSpec),
            planHash: hashBytes(markdown),
            tasks: [{ id: "T001", title: "Write the parser", description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes, readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }],
          },
        },
        inputTokens: 25,
        outputTokens: 25,
      };
    }
    if (request.profile.output !== "implementation") return super.execute(request);
    this.implementations.push(request);
    mkdirSync(join(this.dir, "src"), { recursive: true });
    mkdirSync(join(this.dir, "tests"), { recursive: true });
    if (this.implementations.length === 1) {
      writeFileSync(join(this.dir, "src", "cfg.py"), "if a:\n    if b:\n        pass\n");
      writeFileSync(join(this.dir, "tests", "test_cfg.py"), "def test_cfg():\n    assert True\n");
      writeFileSync(join(this.dir, "README.md"), "# cfg\n");
      writeFileSync(join(this.dir, "value.txt"), "ready");
    } else writeFileSync(join(this.dir, "src", "cfg.py"), "if a and b:\n    pass\n");
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote the parser", evidenceIds: [], unresolved: [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  }
}

// ruff names the file and line of each diagnostic.
const lint = {
  id: "lint",
  executable: "bun",
  args: [
    "-e",
    "const f = Bun.file('src/cfg.py'); if ((await f.exists()) && (await f.text()).includes('    if b:')) { console.log('src/cfg.py:1:1: SIM102 Use a single `if` statement instead of nested `if` statements\\nFound 1 error.'); process.exit(1) } console.log('All checks passed!')",
  ],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "feature" as const,
  envNames: [],
  writes: [],
};

describe("a lint-only failure", () => {
  test("is corrected in the files the linter names, without their tests or the task's other files", async () => {
    const fx = workflowFixture({
      policy: { ...fixturePolicy, checks: [...fixturePolicy.checks, lint] },
      executor: (root) => new LintExecutor(root),
    });
    cleanups.push(() => fx.dispose());
    const started = await fx.start();
    await fx.service.drive(started.runId, signal());
    await fx.approve(started.runId);
    const final = await fx.service.drive(started.runId, signal());

    expect(final.status).toBe("completed");
    const [planned, correction] = fx.executor.implementations;
    expect(planned?.task?.writes.map((w) => w.path)).toEqual(["src/cfg.py", "tests/test_cfg.py", "README.md", "value.txt"]);
    expect(correction?.task?.writes.map((w) => w.path)).toEqual(["src/cfg.py"]);
    expect(correction?.task?.description).toContain("no behavior changes and no new tests");
    const extra = (JSON.parse(correction?.prompt.split("\n").at(-1) ?? "{}") as { extra: { correctionFocus?: { files: string[]; diagnostics?: string } } }).extra;
    expect(extra.correctionFocus?.files).toEqual(["src/cfg.py"]);
    expect(extra.correctionFocus?.diagnostics).toContain("do not probe the task's criteria");
    expect(fx.executor.implementations).toHaveLength(2);
  }, 120000);
});
