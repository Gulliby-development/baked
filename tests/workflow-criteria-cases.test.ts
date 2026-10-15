import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { criterionCases, missingCases, testsHold } from "../src/core/verification/criteria-cases.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 28 (#1250): leaguetab 53a9b06f's tests left out the table case the criteria name and
// cochange-update ee8cef0a's the `--path src/cli` and `--path SRC` no-match cases; review found
// both, and the corrections cost 0.2M to 0.5M tokens each. The host now walks the quoted cases of a
// test task's criteria against its test files inside the attempt.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const criterion = (id: string, then: string, method: "automated" | "manual" = "automated"): Spec["criteria"][number] => ({
  id,
  requirementIds: ["FR-001"],
  given: "the README history",
  when: "`cochange --path src/cli` and `cochange --path SRC` run",
  then,
  method,
});

describe("the quoted cases of a task's criteria", () => {
  test("are the quoted and backticked spans of its automated criteria, each once", () => {
    const spec = {
      criteria: [
        criterion("AC-001", 'it prints "no matching files" and exits 1'),
        criterion("AC-002", 'it prints "manual only"', "manual"),
        criterion("AC-003", 'it prints "other task"'),
      ],
    };
    const cases = criterionCases(spec, { criterionIds: ["AC-001", "AC-002"] });
    expect(cases.map((c) => c.literal)).toEqual(["cochange --path src/cli", "cochange --path SRC", "no matching files"]);
  });

  test("leave out one-character spans and spans that are only a placeholder", () => {
    const spec = { criteria: [criterion("AC-001", 'the separator "," and "<file>" and "<file>: invalid name"')] };
    const literals = criterionCases(spec, { criterionIds: ["AC-001"] }).map((c) => c.literal);
    expect(literals).toContain("<file>: invalid name");
    expect(literals).not.toContain(",");
    expect(literals).not.toContain("<file>");
  });

  test("are found as written, through string escapes, as argument lists and around placeholders", () => {
    expect(testsHold('run(["cochange", "--path", "src/cli"])', "cochange --path src/cli")).toBe(true);
    expect(testsHold("assert out == 'invalid name \\\"1A\\\"'", 'invalid name "1A"')).toBe(true);
    expect(testsHold('assert err == "fixture.txt:3: invalid name"', "<file>:3: invalid name")).toBe(true);
    // Case matters: `--path SRC` is its own case beside `--path src`.
    expect(testsHold('run(["cochange", "--path", "src"])', "cochange --path SRC")).toBe(false);
    const cases = [
      { criterionId: "AC-001", literal: "--path src/cli" },
      { criterionId: "AC-001", literal: "--path SRC" },
    ];
    expect(missingCases(cases, ['run(["--path", "src/cli"])']).map((c) => c.literal)).toEqual(["--path SRC"]);
  });
});

test("a task that writes tests gets the walk of its criteria's cases in its attempt", async () => {
  const spec: Spec = {
    ...fixtureSpec,
    criteria: [{ ...fixtureSpec.criteria[0], then: 'value is ready and `--path SRC` prints "no matching files"' } as Spec["criteria"][number]],
  };
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { executor, root } = fixture;
  const original = executor.execute.bind(executor);
  const found: string[][] = [];
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
    const out = await original(request);
    if (request.profile.output === "plan") {
      const plan = out.output as { markdown: string; taskGraph: { specHash: string; planHash: string; tasks: { writes: { path: string; action: string }[] }[] } };
      plan.taskGraph.specHash = hashJson(spec);
      plan.taskGraph.planHash = hashBytes(plan.markdown);
      plan.taskGraph.tasks[0]?.writes.push({ path: "tests/test_cli.py", action: "create" });
    }
    if (request.profile.output === "implementation") {
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "tests/test_cli.py"), 'assert run(["--path", "SRC"]).out == "no matching files"\n');
      found.push((await request.caseCheck?.(root)) ?? ["no case check"]);
      writeFileSync(join(root, "tests/test_cli.py"), 'assert run(["--path", "src"]).out == "no matching files"\n');
      found.push((await request.caseCheck?.(root)) ?? ["no case check"]);
    }
    return out;
  };
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  await fixture.service.drive(run.runId, new AbortController().signal);
  expect(found[0]).toEqual([]);
  expect(found[1]).toEqual([
    'AC-001 names "--path SRC", and no test file this task writes (tests/test_cli.py) contains it.',
  ]);
}, 60000);
