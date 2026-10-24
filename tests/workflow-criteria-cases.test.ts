import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { criterionCases, isCheckCommand, missingCases, normalizeLiteral, testsHold } from "../src/core/verification/criteria-cases.js";
import { cellSamples, cellSpec, omittedCellInput, withoutCellInput } from "./helpers/criteria-cell-fixtures.js";
import { caseEvidence } from "../src/core/verification/criteria-evidence.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 28 (#1250): leaguetab 53a9b06f's tests left out the table case the criteria name and
// cochange-update ee8cef0a's the `--path src/cli` and `--path SRC` no-match cases; review found
// both, and the corrections cost 0.2M to 0.5M tokens each. The host now walks the quoted cases of a
// test task's criteria against its test files inside the attempt.

const cleanups: (() => void | Promise<void>)[] = [];

describe("literal-cell residual boundaries (#1629)", () => {
  test("keeps numeric inputs and explicitly introduced path values, but drops written scope files", () => {
    const spec = { criteria: [{ ...fixtureSpec.criteria[0]!,
      given: 'modify `README.md`; at least `30` tests; input "src/example.rs"',
      when: 'at least "22" tests; input "30"', then: 'Input | Expected\n42 | answer' }] };
    const task = { criterionIds: ["AC-001"], writes: [{ path: "README.md", action: "modify" as const }] };
    expect(criterionCases(spec, task, { checks: [] }).map((c) => c.literal)).toEqual(["src/example.rs", "30", "42"]);
  });

  test("retains field values that are actual inputs rather than expected properties", () => {
    const spec = { criteria: [{ ...fixtureSpec.criteria[0]!, then: 'Input | Expected\nx=42 | accepted\nmagic=true | accepted' }] };
    expect(criterionCases(spec, { criterionIds: ["AC-001"] }, { checks: [] }).map((c) => c.literal)).toEqual(["42", "true"]);
  });

  test("formatted lists still require the right bytes, signs and candidate text", () => {
    expect(testsHold('check([0x65, 0x63, 0xFF, 0x0A])', "[0x65,0x63,0xFF,0x0A]")).toBe(true);
    expect(testsHold('check([0x65, 0x63, 0xFE, 0x0A])', "[0x65,0x63,0xFF,0x0A]")).toBe(false);
    expect(testsHold("run(['ls', 'a.txt'])", '["ls","a.txt"]')).toBe(true);
    expect(testsHold("run(['ls', 'b.txt'])", '["ls","a.txt"]')).toBe(false);
    expect(testsHold('assert_eq!(ShError("oops".into()).0, "oops");', 'ShError( "oops".into() ).0')).toBe(true);
    expect(testsHold('assert_eq!(ShError("oops".into()).1, "oops");', 'ShError( "oops".into() ).0')).toBe(false);
    expect(testsHold('usage("single|double")', 'usage: tool quote [--style single | double] ...')).toBe(false);
    expect(testsHold('assert_eq!(out, "usage: tool quote [--style single|double] ...")', 'usage: tool quote [--style single | double] ...')).toBe(true);
  });

  test("filters only diagnostic arguments, retaining expected strings and other uses", () => {
    const rust = 'assert_eq!(actual(), "--case-42", "missing --other-9");';
    const evidence = caseEvidence("tests/cases.rs", rust);
    expect(testsHold(evidence, "--case-42")).toBe(true);
    expect(testsHold(evidence, "--other-9")).toBe(false);
    expect(testsHold(caseEvidence("tests/cases.rs", 'assert!(check("--case-42"), "--case-42");'), "--case-42")).toBe(true);
    expect(testsHold(caseEvidence("tests/cases.rs", 'let input = "--case-42"; assert!(ok, "--case-42");'), "--case-42")).toBe(true);
    expect(testsHold(caseEvidence("tests/cases.rs", 'assert!(\ncheck((1, 2), &[3, 4]),\n"--case-42"\n);'), "--case-42")).toBe(false);
    const json = '[{"input": "assert!(true, \\\"--case-42\\\")"}]';
    expect(caseEvidence("tests/rows.json", json)).toBe(json);
  });
});
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

describe("multi-input table cells and escape spellings (#1614)", () => {
  test("input spans become separate cases without context words", () => {
    const cases = criterionCases(cellSpec, { criterionIds: ["AC-001"] }, { checks: [] });
    expect(cases.map((c) => c.literal)).toEqual([
      "https://user:pass@example.com/a", "https://\u4f8b\u3048.\u30c6\u30b9\u30c8/\u9053", "https://example.com/a%20b", "HTTPS://example.com/a",
      '"0 R."', '"00 R."', omittedCellInput, '"001 R."', '"+1 R."', '"\\u0661 R."',
      "0001ALICE 0015{\\n0002BOB   0120}\\n...", "layout.json", "ALT", "caf\\u00e9\\tend\\r",
    ]);
    for (const sample of cellSamples) {
      expect(missingCases(cases, [sample.text])).toEqual([]);
      expect(missingCases(cases, [withoutCellInput(sample.text)]).map((c) => c.literal)).toEqual([omittedCellInput]);
    }
  });

  test("normalizes one layer of supported escapes on both sides", () => {
    expect(normalizeLiteral(String.raw`\u00e9\u{1f600}\x21\n\t\r\\`)).toBe("\u00e9\u{1f600}!\n\t\r\\");
    for (const spelling of [String.raw`caf\u00e9`, String.raw`caf\u{e9}`, String.raw`caf\xe9`, "caf\u00e9"]) {
      expect(testsHold(`"${spelling}"`, "caf\u00e9")).toBe(true);
      expect(testsHold('"caf\u00e9"', spelling)).toBe(true);
      expect(testsHold('"cafe"', spelling)).toBe(false);
    }
    expect(normalizeLiteral(String.raw`\u{110000}\uZZZZ\xZZ\q`)).toBe(String.raw`\u{110000}\uZZZZ\xZZ\q`);
    expect(testsHold(String.raw`"root\leaf"`, "leaf")).toBe(true);
    expect(testsHold('"caf\u00e9Extra"', "caf\u00e9")).toBe(false);
    expect(testsHold('"caf\u00c9"', "caf\u00e9")).toBe(false);
    expect(testsHold('"0 R."', '"\\u0661 R."')).toBe(false);
    expect(testsHold('LayoutCommand.run(new String[] {""})', 'LayoutCommand.run([""])')).toBe(true);
    expect(normalizeLiteral(String.raw`\\n`)).toBe(String.raw`\n`);
    expect(testsHold(String.raw`"\\n"`, String.raw`\n`)).toBe(false);
    expect(testsHold(String.raw`"\\n"`, String.raw`\\n`)).toBe(true);
    expect(testsHold(String.raw`"\\u00e9"`, String.raw`\u00e9`)).toBe(false);
  });

  test("deduplicates alternate literal spellings and preserves escaped quotes in prose", () => {
    const text = 'input "caf\\u00e9" and "caf\u00e9"; output "invalid \\"name\\""';
    const spec = { criteria: [{ ...cellSpec.criteria[0]!, given: text, when: "run", then: "done" }] };
    expect(criterionCases(spec, { criterionIds: ["AC-001"] }, { checks: [] }).map((c) => c.literal)).toEqual(["caf\\u00e9", 'invalid \\"name\\"']);
  });

  test("preserves concrete quoted expected outputs beside the split inputs", () => {
    const spec = { criteria: [{ ...cellSpec.criteria[0]!, then: '| Input | Expected |\n| --- | --- |\n| `input-1`, `input-2` | `error-42` |' }] };
    expect(criterionCases(spec, { criterionIds: ["AC-001"] }, { checks: [] }).map((c) => c.literal)).toEqual(["error-42", "input-1", "input-2"]);
  });

  test("standalone quoted table labels still belong to review (#1565)", () => {
    const spec = { criteria: [{ ...cellSpec.criteria[0]!, then: '| Input | Expected |\n| --- | --- |\n| `success` | zero status |\n| "repeated flag" | last value |\n| `--path src/cli` | selected |' }] };
    expect(criterionCases(spec, { criterionIds: ["AC-001"] }, { checks: [] }).map((c) => c.literal)).toEqual(["--path src/cli"]);
  });
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
    const cases = criterionCases(spec, { criterionIds: ["AC-001", "AC-002"] }, { checks: [] });
    expect(cases.map((c) => c.literal)).toEqual(["cochange --path src/cli", "cochange --path SRC", "no matching files"]);
  });

  test("leave out one-character spans and spans that are only a placeholder", () => {
    const spec = { criteria: [criterion("AC-001", 'the separator "," and "<file>" and "<file>: invalid name"')] };
    const literals = criterionCases(spec, { criterionIds: ["AC-001"] }, { checks: [] }).map((c) => c.literal);
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

  test("scenario labels stay with the reviewer while concrete table inputs stay cases (#1565)", () => {
    const table = [
      "| Input | expected |", "| --- | --- |",
      "| repeated flag | last value |", "| success | zero status |",
      "| no arguments | usage |", "| Show(empty) | empty text |",
      "| Join(nil) or Join(empty) | empty text |", "| TEXT | a placeholder |",
      "| rank/unrank | inverse operations |",
      "| --max-part=5 and --max-part 5 | same option |",
      "| Join([3,0,-2]) | joined values |",
    ].join("\n");
    const spec = { criteria: [{ ...criterion("AC-001", table), given: 'input scenarios include "repeated flag", `success`, and \u201crank/unrank\u201d', when: "tests run" }] };
    expect(criterionCases(spec, { criterionIds: ["AC-001"] }, { checks: [] }).map((c) => c.literal)).toEqual([
      // An expression cell asks for its literal arguments (#1663).
      "--max-part=5 and --max-part 5", "[3,0,-2]",
    ]);
    // Plain English remains a case when the criterion explicitly names output text.
    expect(criterionCases({ criteria: [{ ...spec.criteria[0]!, then: 'it prints "no matching files" and returns "success"' }] }, { criterionIds: ["AC-001"] }, { checks: [] }).map((c) => c.literal)).toEqual(["no matching files", "success"]);
  });

  test("significant tokens can move or change grouping but cannot disappear (#1565)", () => {
    expect(testsHold('const path = "src/cli"; run(["--path", path])', "--path src/cli")).toBe(true);
    expect(testsHold('run(["--max-part", "5"]); run(["--max-part=5"])', "--max-part=5 and --max-part 5")).toBe(true);
    expect(testsHold("Join([]int{3, 0, -2})", "Join([3,0,-2])")).toBe(true);
    expect(testsHold('"/tmp/cli"', "/tmp/cli")).toBe(true);
    expect(testsHold('"C:\\src\\cli"', "C:\\src\\cli")).toBe(true);
    expect(testsHold("Join([]int{3, 0, 2})", "Join([3,0,-2])")).toBe(false);
    expect(testsHold('run(["--path", "src/cliExtra"])', "--path src/cli")).toBe(false);
    expect(testsHold('run(["--path", "src/cli"])', "--path SRC")).toBe(false);
    expect(testsHold("", "<file>")).toBe(false);
    expect(missingCases([{ criterionId: "AC-001", literal: "--path src/cli" }], ['"--path"', '"src/cli"'])).toHaveLength(1);
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
    const literals = criterionCases(spec, { criterionIds: ["AC-002", "AC-009"] }, { checks: [] }).map((c) => c.literal);
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
    expect(criterionCases(spec, { criterionIds: ["AC-002", "AC-009"] }, { checks: [], tasks }).map((c) => c.criterionId)).toEqual(["AC-002", "AC-002", "AC-002"]);
    // With the criterion on half of the tasks or fewer, its literals stay cases.
    const fewer = [{ criterionIds: ["AC-009"] }, { criterionIds: ["AC-002"] }, { criterionIds: ["AC-003"] }];
    expect(criterionCases(spec, { criterionIds: ["AC-009"] }, { checks: [], tasks: fewer }).map((c) => c.literal)).toEqual(["ready", "--path"]);
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
    // A bare capitalised name of the code under test is not a case (#1820).
    when: "`Steps` walks toward zero",
    then,
    method: "automated",
  });

  test("a criterion naming members of a closed set asks for each one", () => {
    const spec = { inScope: [formats], criteria: [steps("it crosses zero for bf16, f32 or e5m2")] };
    const cases = criterionCases(spec, { criterionIds: ["AC-004"] }, { checks: [] });
    expect(cases.map((c) => c.literal)).toEqual(["bf16", "f32", "e5m2"]);
    const missing = missingCases(cases, ['test("Steps", () => { steps("bf16"); steps("f32x"); })']);
    expect(missing.map((c) => c.literal)).toEqual(["f32", "e5m2"]);
  });

  test("all N things takes the set of that size", () => {
    const spec = { requirements: [{ id: "FR-001", text: formats, priority: "must" as const, verification: "automated" as const, sourceRefs: [] }], criteria: [steps("it is exact for all six formats")] };
    const literals = criterionCases(spec, { criterionIds: ["AC-004"] }, { checks: [] }).map((c) => c.literal);
    expect(literals).toEqual(["f16", "bf16", "f32", "f64", "e4m3", "e5m2"]);
    // A whole word: bf16 does not stand for f16.
    const cases = criterionCases(spec, { criterionIds: ["AC-004"] }, { checks: [] });
    expect(missingCases(cases, ["Steps bf16 f32 f64 e4m3 e5m2"]).map((c) => c.literal)).toEqual(["f16"]);
    // A count that matches no set, or two sets, asks for nothing.
    expect(criterionCases({ ...spec, criteria: [steps("it is exact for all five formats")] }, { criterionIds: ["AC-004"] }, { checks: [] }).map((c) => c.literal)).toEqual([]);
  });

  test("plain words, ids, file names and sets the spec does not spell out elsewhere are not cases", () => {
    const spec = {
      inScope: [formats, "Cover AC-001, AC-002 and AC-003", "Write test_a.py, test_b.py and test_c.py"],
      criteria: [
        steps("lint, typecheck and test pass; AC-001, AC-002 and AC-003 hold; test_a.py and test_b.py run"),
        { ...steps("f16 or bf16 round"), id: "AC-005" },
      ],
    };
    expect(criterionCases(spec, { criterionIds: ["AC-004"] }, { checks: [] }).map((c) => c.literal)).toEqual([]);
    // Without a spelled-out set elsewhere, a list is left to the review.
    expect(criterionCases({ criteria: spec.criteria }, { criterionIds: ["AC-005"] }, { checks: [] }).map((c) => c.literal)).toEqual([]);
    // The defining list itself is not asked for by its own text.
    expect(criterionCases({ criteria: [steps(formats)] }, { criterionIds: ["AC-004"] }, { checks: [] }).map((c) => c.literal)).toEqual([]);
  });

  test("each data row's input cell is a case, not the header or the separator", () => {
    const table = "it prints:\n| input | expected |\n| --- | --- |\n| `0x3c00` | 1 |\n| 0x7bff | 65504 |\n| <bits> | any |";
    const cases = criterionCases({ criteria: [steps(table)] }, { criterionIds: ["AC-004"] }, { checks: [] });
    // `0x3c00` is also a quoted span; a case is listed once.
    expect(cases.map((c) => c.literal)).toEqual(["0x3c00", "0x7bff"]);
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

describe("table cells with a pipe (#2044)", () => {
  // R66 nodepluck AC-007: a JSONPath query with `||` in a code span was cut at the first pipe.
  const cases = (then: string) =>
    criterionCases({ criteria: [{ ...fixtureSpec.criteria[0]!, then }] }, { criterionIds: ["AC-001"] }, { checks: [] }).map((c) => c.literal);

  test("a code span, a JSON string and an escaped pipe keep the whole literal", () => {
    expect(cases('| Input | Expected |\n| --- | --- |\n| `"$[?@[0,0]==2 || @.b[?-1<0]]"` | `[1]` |\n| "$.a[?@ > 1 || @ < -1]" | `[2]` |\n| `ls -1 \\| wc -l` | 3 |'))
      .toEqual(['"$[?@[0,0]==2 || @.b[?-1<0]]"', "$.a[?@ > 1 || @ < -1]", "ls -1 | wc -l"]);
  });

  test("a row that does not split to the header's width is skipped, never demanded", () => {
    expect(cases('| Input | Expected |\n| --- | --- |\n| "a1" | ok |\n| `x | "y 2 | z" | 3 |')).toEqual(["a1"]);
  });
});
