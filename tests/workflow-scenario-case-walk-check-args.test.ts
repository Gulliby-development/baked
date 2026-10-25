import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashJson } from "../src/core/specs/hash.js";
import { caseCheck, type CaseContext, criterionCases, isCheckCommand } from "../src/core/verification/criteria-cases.js";
import { namesRequestSide } from "../src/core/workflows/analysis-notes.js";
import { quotedCheckCommands } from "../src/core/workflows/conflict-rows.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { sizePlan } from "../src/core/workflows/sizing.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 52, srcwhere `base` T007 (#1762). AC-012 said "C:/Project/baked-bench/
// R52/srcwhere/.venv/Scripts/python.exe with `-m ruff check .`, `-m ruff format --check .` and
// `-m pytest -q` exits successfully". The policy check runs the interpreter by its path, so the
// case walk did not see the quoted arguments as a check and demanded them in
// tests/test_options.py four times; the task reported spec_conflict three times, a person had to
// answer, and T007 used 1.02M tokens.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const PYTHON = "C:/Project/baked-bench/R52/srcwhere/.venv/Scripts/python.exe";
const check = (id: string, executable: string, args: string[]) => ({ id, executable, args });
const venvChecks = [
  check("lint", PYTHON, ["-m", "ruff", "check", "."]),
  check("format", PYTHON, ["-m", "ruff", "format", "--check", "."]),
  check("tests", PYTHON, ["-m", "pytest", "-q"]),
];
const ac012 = (python: string) => ({
  id: "AC-012",
  requirementIds: ["FR-001"],
  given: "the finished feature",
  when: "the host runs the executionContract checks",
  then: `${python} with \`-m ruff check .\`, \`-m ruff format --check .\` and \`-m pytest -q\` exits successfully`,
  method: "automated" as const,
});
const TEST = "tests/test_options.py";

describe("scenario: srcwhere base T007, a criterion quoting the arguments of host checks (#1762)", () => {
  test("the case walk asks the test file for none of the quoted check arguments", async () => {
    const spec = { criteria: [ac012(PYTHON)] };
    const task = { id: "T007", criterionIds: ["AC-012"], writes: [{ path: TEST, action: "create" as const }] };
    expect(criterionCases(spec, task, { checks: venvChecks })).toEqual([]);
    expect(caseCheck(spec, task, { checks: venvChecks })).toBeUndefined();
    // Without the run's checks only the `-m TOOL` spellings are known to be host commands.
    expect(criterionCases(spec, task, { checks: [] })).toEqual([]);
  });

  test("pricing does not count the check arguments as cases", () => {
    const policy: RunPolicy = { ...fixturePolicy, checks: venvChecks.map((c) => ({ ...fixturePolicy.checks[0]!, ...c })) };
    const graph = {
      schemaVersion: 1 as const,
      specHash: "x",
      tasks: [{ id: "T007", title: "Option tests", description: "Option tests", requirementIds: ["FR-001"], criterionIds: ["AC-012"], dependsOn: [], findingIds: [], writes: [{ path: TEST, action: "create" as const }], checks: [], risk: "low" as const, origin: "planned" as const }],
    };
    const sized = sizePlan({ graph, spec: { ...fixtureSpec, criteria: [ac012(PYTHON)] }, policy, samples: [], spent: 0 }).tasks[0]!;
    expect(sized).toMatchObject({ kind: "test", cases: 0 });
  });

  // The host runs this run's checks, so the scenario's interpreter is the Bun that runs the tests,
  // started by its absolute path like the virtualenv's python.exe.
  const policy: RunPolicy = {
    ...fixturePolicy,
    clarification: "ask",
    checks: [...fixturePolicy.checks, { ...fixturePolicy.checks[0]!, id: "lint", executable: process.execPath, args: ["-e", "0"] }],
  };
  const spec: Spec = {
    ...fixtureSpec,
    criteria: [...fixtureSpec.criteria, { ...ac012(process.execPath), then: `${process.execPath} with \`-e 0\` exits successfully` }],
  };

  async function run(conflictFirst: boolean) {
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const { service, executor, root } = fixture;
    const original = executor.execute.bind(executor);
    const prompts: string[] = [];
    const walks: string[][] = [];
    let conflicts = 0;
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
      if (request.profile.output === "plan") {
        const out = await original(request);
        const graph = (out.output as { taskGraph: { specHash: string; tasks: Record<string, unknown>[] } }).taskGraph;
        const code = graph.tasks[0] as Record<string, unknown> & { writes: { path: string; action: string }[] };
        graph.specHash = hashJson(spec);
        graph.tasks = [{ ...code, id: "T001", criterionIds: ["AC-001", "AC-012"], writes: [...code.writes, { path: TEST, action: "create" }] }];
        return out;
      }
      if (request.profile.output === "review" || request.profile.output === "convergence") {
        const out = await original(request);
        const review = out.output as { coverage: { criterionId: string }[] };
        review.coverage = [...review.coverage, ...review.coverage.map((c) => ({ ...c, criterionId: "AC-012" }))];
        return out;
      }
      if (request.profile.output !== "implementation") return original(request);
      const work = request.root ?? root;
      prompts.push(request.prompt);
      mkdirSync(join(work, dirname(TEST)), { recursive: true });
      const conflicting = conflictFirst && !/Settled spec conflict/.test(request.prompt);
      // The settled attempt changes the code, as a task that was stuck on the conflict would.
      writeFileSync(join(work, "value.txt"), conflicting ? "draft" : "ready");
      writeFileSync(join(work, TEST), "from options import parse_options\n\ndef test_dashes():\n    assert parse_options(['--path', 'src']).path == 'src'\n");
      walks.push((await request.caseCheck?.(work)) ?? []);
      if (conflicting) {
        conflicts++;
        return {
          output: { schemaVersion: 1, taskId: "T001", outcome: "spec_conflict", summary: 'AC-012 names "-e 0", and the accepted request expressly forbids tests that start the checks.', evidenceIds: [], unresolved: ["Should the test start the checks?"] },
          inputTokens: 25,
          outputTokens: 25,
        };
      }
      return { output: { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Option tests", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    };
    const started = await fixture.start();
    for (let i = 0; i < 10; i++) {
      const current = await service.get(started.runId);
      if (["completed", "blocked", "failed"].includes(current.status)) break;
      const pending = service.store.requests(started.runId).find((r) => r.status === "pending");
      if (pending?.kind === "approval") await fixture.approve(started.runId);
      else if (pending?.kind === "clarification") break;
      else if (current.status === "paused" || current.status === "created") await fixture.resume(started.runId);
      await service.drive(started.runId, signal());
    }
    const assumption = service.store.latestArtifact(started.runId, "assumptions/conflicts/T001-checks.json");
    return {
      status: (await service.get(started.runId)).status,
      asked: service.store.requests(started.runId).filter((r) => r.kind === "clarification"),
      assumption: assumption ? JSON.parse(service.store.readArtifact(started.runId, assumption.id)) : null,
      conflicts,
      prompts,
      walks,
    };
  }

  test("a run whose check is an interpreter by path accepts a test file without the quoted arguments", async () => {
    const result = await run(false);
    expect(result.walks).toEqual([[]]);
    expect(result.asked).toEqual([]);
    expect(result.status).toBe("completed");
  }, 90_000);

  test("a conflict that quotes only check commands is settled by the host, and nobody is asked", async () => {
    const result = await run(true);
    expect(result.conflicts).toBe(1);
    expect(result.asked).toEqual([]);
    expect(result.assumption).toMatchObject({ commands: ["-e 0"] });
    expect(result.prompts.at(-1)).toContain("Host-run checks are not test requirements");
    expect(result.status).toBe("completed");
  }, 90_000);
});

describe("check commands as each toolchain's spec quotes them (#1762)", () => {
  const cases: [string, CaseContext["checks"][number], string[], string[]][] = [
    ["python venv", check("lint", PYTHON, ["-m", "ruff", "check", "."]), ["-m ruff check .", "ruff check .", "python -m ruff check .", `${PYTHON} -m ruff check .`, "-m ruff check . --fix"], ["check .", "."]],
    ["python pytest", check("tests", ".venv/bin/python", ["-m", "pytest", "-q"]), ["-m pytest -q", "pytest -q", "pytest"], ["-q"]],
    ["bun", check("typecheck", "bun", ["run", "typecheck"]), ["run typecheck", "bun run typecheck", "bun run typecheck --pretty"], ["typecheck"]],
    ["go", check("tests", "go", ["test", "./..."]), ["test ./...", "go test ./...", "go test ./... -race"], ["./..."]],
    ["cargo", check("lint", "cargo", ["clippy", "--", "-D", "warnings"]), ["clippy -- -D warnings", "cargo clippy -- -D warnings"], ["warnings"]],
    ["dotnet", check("format", "dotnet", ["format", "--verify-no-changes"]), ["format --verify-no-changes", "dotnet format --verify-no-changes"], ["format"]],
    ["maven wrapper", check("tests", "cmd", ["/d", "/c", "mvnw.cmd", "-q", "verify"]), ["-q verify", "mvnw -q verify", "cmd /d /c mvnw.cmd -q verify"], ["verify"]],
    ["gradle wrapper", check("tests", "./gradlew", ["test", "--no-daemon"]), ["test --no-daemon", "./gradlew test --no-daemon", "gradlew test --no-daemon"], ["test"]],
    ["phpunit", check("tests", "vendor/bin/phpunit", []), ["vendor/bin/phpunit", "phpunit", "vendor/bin/phpunit --testdox"], ["--testdox"]],
    ["phpunit through php", check("tests", "php", ["vendor/bin/phpunit"]), ["php vendor/bin/phpunit", "vendor/bin/phpunit", "phpunit"], ["vendor"]],
    ["pint through php", check("format", "php", ["vendor/bin/pint", "--test"]), ["php vendor/bin/pint --test", "vendor/bin/pint --test", "pint --test"], ["--test"]],
  ];
  for (const [name, own, spellings, values] of cases) {
    test(`${name}: the command and its arguments are host checks, a fragment of them is a value`, () => {
      for (const spelled of spellings) expect([spelled, isCheckCommand(spelled, [own])]).toEqual([spelled, true]);
      for (const value of values) expect([value, isCheckCommand(value, [own])]).toEqual([value, false]);
    });
  }

  test("an ordinary argument value of the program under test is a case", () => {
    expect(isCheckCommand("--path src/cli", venvChecks)).toBe(false);
    expect(isCheckCommand("-m", venvChecks)).toBe(false);
  });
});

describe("a spec conflict about check commands (#1762)", () => {
  test("settles in the host only when everything the report quotes is a check command", () => {
    expect(quotedCheckCommands('AC-012 names "-m ruff check ." and `-m pytest -q`.', venvChecks)).toEqual(["-m ruff check .", "-m pytest -q"]);
    expect(quotedCheckCommands('AC-012 names "-m ruff check ." and AC-003 gives "--path src".', venvChecks)).toEqual([]);
    expect(quotedCheckCommands("AC-012 contradicts the brief.", venvChecks)).toEqual([]);
  });

  test("the accepted request expressly forbidding something is the request's side", () => {
    expect(namesRequestSide("the accepted request expressly forbids tests that start ruff")).toBe(true);
  });
});
