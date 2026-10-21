import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { caseCheck, criterionCases } from "../src/core/verification/criteria-cases.js";
import { ReviewSchema, type Spec } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// R55 (#1820): 18 refusals with 131 items in 5 of 7 runs. routeshadow (Rust) stated its table
// rows as JSON call descriptors, youngkit-update (Go) named types, fields and its own program, and
// url-shortener (bun) quoted request and header lines. The three costliest test tasks of
// routeshadow were the refused ones, up to 2.1M tokens; their accepted files held none of the
// demanded strings.

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-case-structured-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

type Criterion = Spec["criteria"][number];
const criterion = (id: string, then: string, when = "it runs"): Criterion => ({
  id,
  requirementIds: ["FR-001"],
  given: "the tool",
  when,
  then,
  method: "automated",
});

async function refusals(c: Criterion, files: Record<string, string>, path: string): Promise<string[]> {
  const check = caseCheck({ criteria: [c] }, { criterionIds: [c.id], writes: [{ path, action: "create" }] }, { checks: [] });
  return check ? check(workspace(files)) : [];
}

// routeshadow model T005: the spec's rows are JSON; each toolchain builds the same value with its constructors.
const DESCRIPTOR = '{"op":"params","segs":[{"Lit":"a"},{"Param":{"name":"id","ty":"Int"}},{"Rest":{"name":"path"}}]}';
const ROWS = criterion("AC-001", `Input | Expected\n\`${DESCRIPTOR}\` | \`["id","path"]\`\n\`["GET /a n","GET","/A"]\` | \`[2,"","routeshadow: invalid path \\"/caf?\\"\\n"]\``);
const TOOLCHAINS: { tool: string; path: string; text: string }[] = [
  {
    tool: "cargo test (R55 routeshadow)",
    path: "tests/model_tests.rs",
    text: 'let segs = vec![Seg::Lit("a".into()), Seg::Param { name: "id".into(), ty: Ty::Int }, Seg::Rest { name: "path".into() }];\nassert_eq!(params(&segs), vec!["id", "path"]);\nassert_eq!(run(&["GET /a n", "GET", "/A"]), (2, String::new(), "routeshadow: invalid path \\"/caf?\\"\\n".to_string()));\n',
  },
  {
    tool: "go test",
    path: "model_test.go",
    text: 'segs := []Seg{Lit{"a"}, Param{Name: "id", Ty: Int}, Rest{Name: "path"}}\nif got := params(segs); !reflect.DeepEqual(got, []string{"id", "path"}) {}\ncode, out, errOut := run([]string{"GET /a n", "GET", "/A"})\nwant := 2; _ = out; if errOut != "routeshadow: invalid path \\"/caf?\\"\\n" || code != want {}\n',
  },
  {
    tool: "bun test",
    path: "tests/model.test.ts",
    text: 'expect(params([lit("a"), param("id", "Int"), rest("path")])).toEqual(["id", "path"]);\nexpect(run(["GET /a n", "GET", "/A"])).toEqual([2, "", \'routeshadow: invalid path "/caf?"\\n\']);\n',
  },
  {
    tool: "pytest",
    path: "tests/test_model.py",
    text: 'assert params([Lit("a"), Param(name="id", ty="Int"), Rest(name="path")]) == ["id", "path"]\nassert run(["GET /a n", "GET", "/A"]) == (2, "", \'routeshadow: invalid path "/caf?"\\n\')\n',
  },
  {
    tool: "maven",
    path: "src/test/java/app/ModelTest.java",
    text: 'assertEquals(List.of("id", "path"), params(List.of(new Lit("a"), new Param("id", Ty.Int), new Rest("path"))));\nassertEquals(new Result(2, "", "routeshadow: invalid path \\"/caf?\\"\\n"), run("GET /a n", "GET", "/A"));\n',
  },
  {
    tool: "gradle",
    path: "src/test/kotlin/app/ModelTest.kt",
    text: 'assertEquals(listOf("id", "path"), params(listOf(Lit("a"), Param("id", Ty.Int), Rest("path"))))\nassertEquals(Result(2, "", "routeshadow: invalid path \\"/caf?\\"\\n"), run("GET /a n", "GET", "/A"))\n',
  },
  {
    tool: "dotnet test",
    path: "tests/App.Tests/ModelTests.cs",
    text: 'Assert.Equal(new[] { "id", "path" }, Params(new Seg[] { new Lit("a"), new Param("id", Ty.Int), new Rest("path") }));\nAssert.Equal((2, "", "routeshadow: invalid path \\"/caf?\\"\\n"), Run("GET /a n", "GET", "/A"));\n',
  },
];

describe("a JSON value is held by its scalar leaves (#1820)", () => {
  for (const { tool, path, text } of TOOLCHAINS)
    test(tool, async () => {
      expect(await refusals(ROWS, { [path]: text }, path)).toEqual([]);
    });

  test("a test missing a leaf value is still refused", async () => {
    const c = criterion("AC-002", 'Input | Expected\n`[["x","2024-10-21"]]` | `1`');
    const path = "tests/dates.rs";
    expect(await refusals(c, { [path]: 'assert_eq!(count(&[("x", "2024-10-20")]), 1);\n' }, path)).toHaveLength(1);
    expect(await refusals(c, { [path]: 'assert_eq!(count(&[("x", "2024-10-21")]), 1);\n' }, path)).toEqual([]);
  });
});

describe("names the criterion uses to describe the test are not cases (#1820)", () => {
  test("R55 youngkit-update: a pointer type, a field, a function prefix and a token shape", () => {
    const c = criterion("AC-003", "the error is a `*base.Error` whose `Msg` names the part; the 8 `Test` functions pass; a token has the shape `PARTxCOUNT`");
    expect(criterionCases({ criteria: [c] }, { criterionIds: ["AC-003"] }, { checks: [] })).toEqual([]);
  });

  test("a capitalised word quoted as a value is still a case", () => {
    const c = criterion("AC-004", "it prints `Usage`");
    expect(criterionCases({ criteria: [c] }, { criterionIds: ["AC-004"] }, { checks: [] }).map((x) => x.literal)).toEqual(["Usage"]);
  });
});

// youngkit-update AC-007: 24 command lines led by the program; the tests call the entry function.
const COMMANDS = criterion("AC-007", "`youngkit rank 4,3x2,1` prints `7` and `youngkit conjugate 3x2` prints `2,2,1`");
const PROGRAMS: { tool: string; manifest: Record<string, string>; path: string; text: string }[] = [
  { tool: "go test (R55 youngkit-update)", manifest: { "go.mod": "module example.com/youngkit\n\ngo 1.23\n" }, path: "cmd_test.go", text: 'if out := run([]string{"rank", "4,3x2,1"}); out != "7" {}\nif out := run([]string{"conjugate", "3x2"}); out != "2,2,1" {}\n' },
  { tool: "cargo test", manifest: { "Cargo.toml": '[package]\nname = "youngkit"\nversion = "0.1.0"\n' }, path: "tests/cli.rs", text: 'assert_eq!(run(&["rank", "4,3x2,1"]), "7");\nassert_eq!(run(&["conjugate", "3x2"]), "2,2,1");\n' },
  { tool: "bun test", manifest: { "package.json": '{"name":"@acme/youngkit","bin":{"youngkit":"src/cli.ts"}}' }, path: "tests/cli.test.ts", text: 'expect(run(["rank", "4,3x2,1"])).toBe("7");\nexpect(run(["conjugate", "3x2"])).toBe("2,2,1");\n' },
  { tool: "pytest", manifest: { "pyproject.toml": '[project]\nname = "young-tools"\n\n[project.scripts]\nyoungkit = "young.cli:main"\n' }, path: "tests/test_cli.py", text: 'assert main(["rank", "4,3x2,1"]) == "7"\nassert main(["conjugate", "3x2"]) == "2,2,1"\n' },
  { tool: "maven", manifest: { "pom.xml": "<project><parent><artifactId>base</artifactId></parent><artifactId>youngkit</artifactId></project>" }, path: "src/test/java/app/CliTest.java", text: 'assertEquals("7", run("rank", "4,3x2,1"));\nassertEquals("2,2,1", run("conjugate", "3x2"));\n' },
  { tool: "gradle", manifest: { "settings.gradle.kts": 'rootProject.name = "youngkit"\n' }, path: "src/test/kotlin/app/CliTest.kt", text: 'assertEquals("7", run("rank", "4,3x2,1"))\nassertEquals("2,2,1", run("conjugate", "3x2"))\n' },
  { tool: "dotnet test", manifest: { "src/youngkit/youngkit.csproj": "<Project />" }, path: "tests/App.Tests/CliTests.cs", text: 'Assert.Equal("7", Program.Run("rank", "4,3x2,1"));\nAssert.Equal("2,2,1", Program.Run("conjugate", "3x2"));\n' },
];

describe("a command line led by the project's own program is held by its arguments (#1820)", () => {
  for (const { tool, manifest, path, text } of PROGRAMS)
    test(tool, async () => {
      expect(await refusals(COMMANDS, { ...manifest, [path]: text }, path)).toEqual([]);
    });

  test("another program's command line, or missing arguments, are still refused", async () => {
    const { manifest, path, text } = PROGRAMS[0]!;
    expect(await refusals(COMMANDS, { "go.mod": "module example.com/other\n", [path]: text }, path)).toHaveLength(2);
    expect(await refusals(COMMANDS, { ...manifest, [path]: text.replace('"rank"', '"size"') }, path)).toHaveLength(1);
  });
});

describe("request and header lines are held by their parts (#1820)", () => {
  const LINES = criterion("AC-005", "`GET /test_1` redirects with `Location: https://example.com/a`; `GET /links/test_1/stats` returns the count; `DELETE /links/test_1` removes it");
  const path = "tests/handler.test.ts";
  const text = [
    'const res = await handler(new Request("http://localhost/test_1"));',
    'expect(res.headers.get("location")).toBe("https://example.com/a");',
    'const stats = await handler(new Request("http://localhost/links/test_1/stats"));',
    'const gone = await handler(new Request("http://localhost/links/test_1", { method: "DELETE" }));',
  ].join("\n");

  test("R55 url-shortener (bun)", async () => {
    expect(await refusals(LINES, { [path]: text }, path)).toEqual([]);
  });

  test("a missing path, a missing method or another header value is still refused", async () => {
    expect(await refusals(LINES, { [path]: text.replace("links/test_1/stats", "links/test_2/stats") }, path)).toHaveLength(1);
    expect(await refusals(LINES, { [path]: text.replace(', { method: "DELETE" }', "") }, path)).toHaveLength(1);
    expect(await refusals(LINES, { [path]: text.replace("https://example.com/a", "https://example.com/b") }, path)).toHaveLength(1);
  });
});

// routeshadow model T006: the corrective's finding names AC-008 and the shared test file; the walk
// demanded its planned sibling's 24 items of AC-001..AC-004 as well. This pins the path the
// scheduler builds the corrective's walk on, not only the exported function.
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SHARED = "tests/value.test.ts";
const spec: Spec = {
  ...fixtureSpec,
  requirements: [
    ...fixtureSpec.requirements,
    { id: "FR-002", text: "Value reports its count", priority: "must", verification: "automated", sourceRefs: [] },
  ],
  criteria: [
    { ...fixtureSpec.criteria[0]!, then: "value is ready and `value --name alpha` prints `alpha 1`" },
    { id: "AC-002", requirementIds: ["FR-002"], given: "a workspace", when: "`value --count` runs", then: "it prints `beta 2`", method: "automated" },
  ],
};

class CorrectiveWalk extends FixtureExecutor {
  reviews = 0;
  walked: string[][] = [];
  override async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { snapshotHash: string; extra: { evidence?: { id: string }[] } };
    if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "refutation")
      return { output: { schemaVersion: 1, findingId: (data.extra as { finding?: { id: string } }).finding?.id, decision: "confirmed", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "The count is wrong" }, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "implementation" && request.task?.origin !== "planned") {
      this.calls.push("implementation");
      // The corrective rewrites the shared file for its own criterion only.
      writeFileSync(join(this.root, SHARED), 'expect(run("value --count")).toBe("beta 2");\n');
      this.walked.push((await request.caseCheck?.(this.root)) ?? []);
      return { output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Fixed the count", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output === "implementation") {
      mkdirSync(join(this.root, "tests"), { recursive: true });
      writeFileSync(join(this.root, SHARED), 'expect(run("value --name alpha")).toBe("alpha 1");\nexpect(run("value --count")).toBe("beta 2");\n');
    }
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const plan = result.output as { markdown: string; taskGraph: { specHash: string; planHash: string; tasks: { requirementIds: string[]; criterionIds: string[]; writes: { path: string; action: string }[] }[] } };
      const task = plan.taskGraph.tasks[0]!;
      task.requirementIds = ["FR-001", "FR-002"];
      task.criterionIds = ["AC-001", "AC-002"];
      task.writes.push({ path: SHARED, action: "create" });
      plan.taskGraph.specHash = hashJson(spec);
      plan.taskGraph.planHash = hashBytes(plan.markdown);
    }
    if (request.profile.output === "review" || request.profile.output === "convergence") {
      const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
      const review = ReviewSchema.parse(result.output);
      review.coverage = spec.criteria.map((c) => ({ criterionId: c.id, verdict: "pass" as const, evidenceIds, explanation: "Checked" }));
      if (request.profile.output === "review" && this.reviews++ === 0) {
        review.verdict = "changes_requested";
        review.findings = [{ id: "F1", kind: "correctness", severity: "high", requirementIds: ["FR-002"], criterionIds: ["AC-002"], file: SHARED, symbol: null, evidenceIds, claim: "The count case asserts the wrong stream", impact: "A wrong count passes", suggestedFix: "Assert stdout", repro: { executable: "bun", args: ["-e", "console.log(2)"], expected: "beta 2", actual: "2" } }];
      }
      result.output = review;
    }
    return result;
  }
}

describe("a corrective's walk through the scheduler owes only its finding's criterion (#1820)", () => {
  test("routeshadow model T006: the finding names AC-002 and the shared test file", async () => {
    const fixture = workflowFixture({ executor: (root) => new CorrectiveWalk(root) });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const done = await fixture.service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(fixture.executor.walked.length).toBeGreaterThan(0);
    expect(fixture.executor.walked[0]).toEqual([]);
  }, 60000);
});
