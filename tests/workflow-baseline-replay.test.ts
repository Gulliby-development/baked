import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failedTests } from "../src/core/verification/output-counts.js";
import {
  BASELINE_REPLAY_NOTE,
  type BaselineReplay,
  QUALITY_BASELINE_REPLAY,
  replayEdits,
} from "../src/core/workflows/quality/baseline-replay.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench rounds 60 and 61 (#1945). Update briefs asked for proof that the new tests fail on the code
// before the change (taskplan, ignorewhy, tplfill, modeplan). No check of the run produced it, so
// convergence answered inconclusive, then fail, and stopped no_progress. With `baselineReplay: on`
// the host runs the test checks once more with the changed non-test files put back.

/** One failing test per runner, in the shape each runner prints it. */
const FAILURES = [
  { runner: "bun", output: "tests/a.test.ts:\n(pass) keeps lines [0.1ms]\n(fail) parser > keeps blank lines [0.2ms]\n\n 1 pass\n 1 fail\nRan 2 tests across 1 file. [5ms]", name: "parser > keeps blank lines" },
  { runner: "jest", output: "FAIL tests/a.test.js\n  ● parser › keeps blank lines\n\nTests:       1 failed, 1 passed, 2 total", name: "parser › keeps blank lines" },
  { runner: "vitest", output: " FAIL  tests/a.test.ts > parser > keeps blank lines\n Test Files  1 failed (1)\n      Tests  1 failed | 1 passed (2)", name: "tests/a.test.ts > parser > keeps blank lines" },
  { runner: "tap", output: "TAP version 13\nok 1 - plain\nnot ok 2 - keeps blank lines\nnot ok 3 - later # TODO\n1..3", name: "keeps blank lines" },
  { runner: "pytest", output: "FAILED tests/test_parser.py::test_blank_lines - AssertionError\n==== 1 failed, 3 passed in 0.12s ====", name: "tests/test_parser.py::test_blank_lines" },
  { runner: "cargo", output: "test parser::blank_lines ... FAILED\ntest parser::plain ... ok\n\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out", name: "parser::blank_lines" },
  { runner: "go", output: "--- FAIL: TestBlankLines (0.00s)\nFAIL\nFAIL\texample.com/taskplan\t0.002s", name: "TestBlankLines" },
  { runner: "dotnet", output: "  Failed Parser.Tests.BlankLines [12 ms]\nFailed!  - Failed:     1, Passed:     3, Skipped:     0, Total:     4", name: "Parser.Tests.BlankLines" },
  { runner: "maven", output: "[ERROR] app.ParserTest.blankLines -- Time elapsed: 0.01 s <<< FAILURE!\n[ERROR] Tests run: 4, Failures: 1, Errors: 0, Skipped: 0", name: "app.ParserTest.blankLines" },
] as const;

describe("baseline replay (#1945)", () => {
  for (const row of FAILURES)
    test(`${row.runner}: the failed test is read from the output`, () => {
      expect(failedTests(row.output)?.names).toContain(row.name);
    });

  test("a passing run reads no failed test, and output no runner prints reads nothing", () => {
    expect(failedTests("(pass) a [0.1ms]\n\n 1 pass\n 0 fail\nRan 1 test across 1 file. [5ms]")?.names ?? []).toEqual([]);
    expect(failedTests("Segmentation fault")).toBeNull();
  });

  test("non-test files go back, created ones are removed, and tests stay as delivered", () => {
    const edits = replayEdits([
      { path: "src/sign.ts", before: "old\n", after: "new\n" },
      { path: "src/added.ts", before: null, after: "x\n" },
      { path: "src/lost.ts", before: undefined, after: "y\n" },
      { path: "tests/sign.test.ts", before: null, after: "t\n" },
    ] as never);
    expect(edits).toEqual({ revert: [{ path: "src/sign.ts", content: "old\n" }], remove: ["src/added.ts"], unknown: ["src/lost.ts"] });
  });

  test("the review is told how to read the record", () => {
    expect(BASELINE_REPLAY_NOTE.review).toContain(QUALITY_BASELINE_REPLAY);
    expect(BASELINE_REPLAY_NOTE.spec).toContain("automated");
  });

  const OLD = "export const sign = (n: number) => (n < 0 ? -1 : 0);\n";
  const NEW = "export const sign = (n: number) => (n < 0 ? -1 : 1);\n";

  class SignExecutor extends FixtureExecutor {
    reviews: string[] = [];
    constructor(private readonly dir: string) {
      super(dir);
    }
    override async execute(request: ExecutionRequest) {
      if (request.profile.output === "review") this.reviews.push(request.prompt);
      if (request.profile.output === "plan") {
        const result = await super.execute(request);
        const plan = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.push({ path: "src/sign.ts", action: "modify" }, { path: "tests/sign.test.ts", action: "create" });
        return result;
      }
      if (request.profile.output === "implementation") {
        writeFileSync(join(this.dir, "src/sign.ts"), NEW);
        writeFileSync(
          join(this.dir, "tests/sign.test.ts"),
          ['import { expect, test } from "bun:test";', 'import { sign } from "../src/sign";', 'test("zero is positive", () => {', "  expect(sign(0)).toBe(1);", "});", ""].join("\n"),
        );
      }
      return super.execute(request);
    }
  }

  async function replay(on: boolean) {
    const first = fixturePolicy.checks[0] as (typeof fixturePolicy.checks)[number];
    const fixture = workflowFixture({
      policy: { ...fixturePolicy, ...(on ? { baselineReplay: "on" as const } : {}), checks: [...fixturePolicy.checks, { ...first, id: "unit", args: ["test", "tests/"] }] },
      executor: (root) => new SignExecutor(root),
    });
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: fixture.root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    };
    try {
      const { service, root } = fixture;
      git("init", "-q", "-b", "main");
      git("config", "user.name", "Test User");
      git("config", "user.email", "test@example.test");
      git("config", "commit.gpgsign", "false");
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, ".gitignore"), ".baked/\n");
      writeFileSync(join(root, "src/sign.ts"), OLD);
      writeFileSync(
        join(root, "tests/old.test.ts"),
        ['import { expect, test } from "bun:test";', 'import { sign } from "../src/sign";', 'test("negatives are negative", () => {', "  expect(sign(-5)).toBe(-1);", "});", ""].join("\n"),
      );
      git("add", ".");
      git("commit", "-q", "-m", "Initial");
      const run = await fixture.start();
      await service.drive(run.runId, new AbortController().signal);
      await fixture.approve(run.runId);
      const done = await service.drive(run.runId, new AbortController().signal);
      expect(done.status).toBe("completed");
      // The run's own tree is untouched and the copy is gone.
      expect(readFileSync(join(root, "src/sign.ts"), "utf8")).toBe(NEW);
      expect(existsSync(join(root, ".baked/worktrees", run.runId, "quality-baseline-replay"))).toBe(false);
      const artifact = service.store.latestArtifact(run.runId, QUALITY_BASELINE_REPLAY);
      return {
        record: artifact ? (JSON.parse(service.store.readArtifact(run.runId, artifact.id)) as BaselineReplay) : null,
        reviews: (fixture.executor as SignExecutor).reviews,
      };
    } finally {
      await fixture.dispose();
    }
  }

  test("the new test fails on the code before the change and the old one still passes", async () => {
    const { record, reviews } = await replay(true);
    expect(record?.reverted).toEqual(["src/sign.ts"]);
    expect(record?.removed).toContain("value.txt");
    const unit = record?.checks.find((c) => c.id === "unit");
    expect(unit).toMatchObject({ status: "failed", runner: "bun" });
    expect(unit?.failedTests).toEqual(["zero is positive"]);
    expect(reviews.some((p) => p.includes("quality/baseline-replay.json is the baseline replay"))).toBe(true);
  }, 60_000);

  test("off by default: no replay and no note", async () => {
    const { record, reviews } = await replay(false);
    expect(record).toBeNull();
    expect(reviews.some((p) => p.includes("baseline replay"))).toBe(false);
  }, 60_000);
});
