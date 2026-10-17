import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { criterionCases, isCheckCommand, missingCases, testsHold } from "../src/core/verification/criteria-cases.js";
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

// Bench round 36, md-site 7b362eb4 (#1366): AC-009, the spec's repository-level criterion, quotes
// `bun run typecheck`, `bun run lint` and `bun test`, and the plan gave it to all six code and test
// tasks. The cases check refused the front matter property test T004 twice for not containing the
// commands, and the run stopped `invalid_output` after 1.33M tokens. The host runs those commands
// as checks; they are not cases a test file holds.
describe("quoted commands and repository-level criteria (#1366)", () => {
  const repositoryLevel = {
    id: "AC-009",
    requirementIds: ["FR-001"],
    given: "The completed repository and existing scaffold",
    when: "Repository structure, dependencies and execution-contract checks are executed",
    then: "`bun run typecheck`, `bun run lint`, and `bun test` pass",
    method: "automated" as const,
  };

  test("a quoted check command is not a case", () => {
    const spec = { criteria: [repositoryLevel, criterion("AC-002", 'it prints "no matching files"')] };
    const literals = criterionCases(spec, { criterionIds: ["AC-002", "AC-009"] }).map((c) => c.literal);
    expect(literals).toEqual(["cochange --path src/cli", "cochange --path SRC", "no matching files"]);
    expect(isCheckCommand("cargo test --all")).toBe(true);
    expect(isCheckCommand("python -m pytest -q")).toBe(true);
    // A command of the project that is not a usual check command is one when a policy check runs it.
    expect(isCheckCommand("make verify")).toBe(false);
    expect(isCheckCommand("make verify", [{ executable: "make", args: ["verify"] }])).toBe(true);
    // The tool the project builds stays a case.
    expect(isCheckCommand("cochange --path SRC")).toBe(false);
    expect(isCheckCommand("bun run src/cli.ts --help")).toBe(false);
  });

  test("check commands run through a package runner or another toolchain are not cases (#1427)", () => {
    for (const command of [
      "npx tsc --noEmit",
      "npx eslint .",
      "npx vitest run",
      "bunx biome check .",
      "pnpm exec tsc",
      "yarn jest",
      "uv run pytest",
      "poetry run pytest -q",
      "python -m unittest",
      "python3 -m mypy src",
      "node --test",
      "deno test",
      "dotnet format --verify-no-changes",
      "make test",
      "./mvnw -q verify",
      "gradlew check",
    ]) {
      expect(isCheckCommand(command)).toBe(true);
    }
    for (const literal of ["npx cochange --path src", "uv run cochange", "python -m cochange", "node dist/cli.js", "make verify", "testing"]) {
      expect(isCheckCommand(literal)).toBe(false);
    }
  });

  test("a criterion the plan gives to most tasks has no cases", () => {
    const spec = { criteria: [{ ...repositoryLevel, then: 'the build prints "ready" and the help lists "--path"' }, criterion("AC-002", 'it prints "no matching files"')] };
    const tasks = [{ criterionIds: ["AC-009"] }, { criterionIds: ["AC-009", "AC-002"] }, { criterionIds: ["AC-009"] }, { criterionIds: ["AC-003"] }];
    expect(criterionCases(spec, { criterionIds: ["AC-002", "AC-009"] }, { tasks }).map((c) => c.criterionId)).toEqual(["AC-002", "AC-002", "AC-002"]);
    // With the criterion on half of the tasks or fewer, its literals stay cases.
    const fewer = [{ criterionIds: ["AC-009"] }, { criterionIds: ["AC-002"] }, { criterionIds: ["AC-003"] }];
    expect(criterionCases(spec, { criterionIds: ["AC-009"] }, { tasks: fewer }).map((c) => c.literal)).toEqual(["ready", "--path"]);
  });
});

test("md-site 7b362eb4: a test task whose criteria quote the check commands is not refused for them (#1366)", async () => {
  const spec: Spec = {
    ...fixtureSpec,
    criteria: [{ ...fixtureSpec.criteria[0], then: 'value is ready; `bun run typecheck`, `bun run lint`, and `bun test` pass; `--path SRC` prints "no matching files"' } as Spec["criteria"][number]],
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
      plan.taskGraph.tasks[0]?.writes.push({ path: "tests/frontmatter.property.test.ts", action: "create" });
    }
    if (request.profile.output === "implementation") {
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "tests/frontmatter.property.test.ts"), 'expect(run(["--path", "SRC"]).out).toBe("no matching files");\n');
      found.push((await request.caseCheck?.(root)) ?? ["no case check"]);
    }
    return out;
  };
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  await fixture.service.drive(run.runId, new AbortController().signal);
  expect(found[0]).toEqual([]);
}, 60000);

// Bench round 41, fpbits (#1482): three of six features paid 1.63M tokens for review findings that
// a test file left out a member of a set or a table row its criteria list in plain words, not in
// quotes: analysis had no `Steps` case for bf16, f32 or e5m2. The walk now takes the members of a
// closed set the spec spells out and the input cells of a criterion's table.
describe("enumerated sets and table rows (#1482)", () => {
  const formats = "Support the six formats f16, bf16, f32, f64, e4m3 and e5m2.";
  const steps = (then: string): Spec["criteria"][number] => ({
    id: "AC-004",
    requirementIds: ["FR-001"],
    given: "a positive nonzero start",
    when: "`Steps` walks toward zero",
    then,
    method: "automated",
  });

  test("a criterion naming members of a closed set asks for each one", () => {
    const spec = { inScope: [formats], criteria: [steps("it crosses zero for bf16, f32 or e5m2")] };
    const cases = criterionCases(spec, { criterionIds: ["AC-004"] });
    expect(cases.map((c) => c.literal)).toEqual(["Steps", "bf16", "f32", "e5m2"]);
    const missing = missingCases(cases, ['test("Steps", () => { steps("bf16"); steps("f32x"); })']);
    expect(missing.map((c) => c.literal)).toEqual(["f32", "e5m2"]);
  });

  test("all N things takes the set of that size", () => {
    const spec = { requirements: [{ id: "FR-001", text: formats, priority: "must" as const, verification: "automated" as const, sourceRefs: [] }], criteria: [steps("it is exact for all six formats")] };
    const literals = criterionCases(spec, { criterionIds: ["AC-004"] }).map((c) => c.literal);
    expect(literals).toEqual(["Steps", "f16", "bf16", "f32", "f64", "e4m3", "e5m2"]);
    // A whole word: bf16 does not stand for f16.
    const cases = criterionCases(spec, { criterionIds: ["AC-004"] });
    expect(missingCases(cases, ["Steps bf16 f32 f64 e4m3 e5m2"]).map((c) => c.literal)).toEqual(["f16"]);
    // A count that matches no set, or two sets, asks for nothing.
    expect(criterionCases({ ...spec, criteria: [steps("it is exact for all five formats")] }, { criterionIds: ["AC-004"] }).map((c) => c.literal)).toEqual(["Steps"]);
  });

  test("plain words, ids, file names and sets the spec does not spell out elsewhere are not cases", () => {
    const spec = {
      inScope: [formats, "Cover AC-001, AC-002 and AC-003", "Write test_a.py, test_b.py and test_c.py"],
      criteria: [
        steps("lint, typecheck and test pass; AC-001, AC-002 and AC-003 hold; test_a.py and test_b.py run"),
        { ...steps("f16 or bf16 round"), id: "AC-005" },
      ],
    };
    expect(criterionCases(spec, { criterionIds: ["AC-004"] }).map((c) => c.literal)).toEqual(["Steps"]);
    // Without a spelled-out set elsewhere, a list is left to the review.
    expect(criterionCases({ criteria: spec.criteria }, { criterionIds: ["AC-005"] }).map((c) => c.literal)).toEqual(["Steps"]);
    // The defining list itself is not asked for by its own text.
    expect(criterionCases({ criteria: [steps(formats)] }, { criterionIds: ["AC-004"] }).map((c) => c.literal)).toEqual(["Steps"]);
  });

  test("each data row's input cell is a case, not the header or the separator", () => {
    const table = "it prints:\n| input | expected |\n| --- | --- |\n| `0x3c00` | 1 |\n| 0x7bff | 65504 |\n| <bits> | any |";
    const cases = criterionCases({ criteria: [steps(table)] }, { criterionIds: ["AC-004"] });
    // `0x3c00` is also a quoted span; a case is listed once.
    expect(cases.map((c) => c.literal)).toEqual(["Steps", "0x3c00", "0x7bff"]);
    expect(missingCases(cases, ['Steps(0x3c00) == "1"']).map((c) => c.literal)).toEqual(["0x7bff"]);
  });
});

test("a test task's attempt is told which set member its tests leave out (#1482)", async () => {
  const spec: Spec = {
    ...fixtureSpec,
    inScope: [...fixtureSpec.inScope, "Support the six formats f16, bf16, f32, f64, e4m3 and e5m2."],
    criteria: [{ ...fixtureSpec.criteria[0], then: "value is ready for bf16, f32 or e5m2" } as Spec["criteria"][number]],
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
      plan.taskGraph.tasks[0]?.writes.push({ path: "tests/steps.test.ts", action: "create" });
    }
    if (request.profile.output === "implementation") {
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "tests/steps.test.ts"), 'for (const f of ["bf16", "f32"]) test(f, () => {});\n');
      found.push((await request.caseCheck?.(root)) ?? ["no case check"]);
      writeFileSync(join(root, "tests/steps.test.ts"), 'for (const f of ["bf16", "f32", "e5m2"]) test(f, () => {});\n');
      found.push((await request.caseCheck?.(root)) ?? ["no case check"]);
    }
    return out;
  };
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  await fixture.service.drive(run.runId, new AbortController().signal);
  expect(found[0]).toEqual([
    'AC-001 names "e5m2", and no test file this task writes (tests/steps.test.ts) contains it.',
  ]);
  expect(found[1]).toEqual([]);
}, 60000);
