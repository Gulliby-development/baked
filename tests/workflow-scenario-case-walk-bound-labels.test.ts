import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { criterionCases, missingCases } from "../src/core/verification/criteria-cases.js";
import { caseEvidence } from "../src/core/verification/criteria-evidence.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// R50 (#1663): the case walk refused 8 of 24 selwhy test tasks (61 items) for labels the Given
// defines ("E1 through E9", "DOC1") and for expression cells such as `Position("nth-child", E4)`,
// which no Go test that picks elements by index spells.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Criterion = Spec["criteria"][number];
const criterion = (given: string, then: string, when = "the tests run"): Criterion =>
  ({ ...fixtureSpec.criteria[0], id: "AC-003", given, when, then }) as Criterion;
const cases = (c: Criterion) => criterionCases({ criteria: [c] }, { criterionIds: ["AC-003"] }).map((x) => x.literal);

const MATCHING = [
  "Input | Kind | Expected",
  "--- | --- | ---",
  '`Position("nth-child", E4)` | siblings | 2',
  '`ListMatches(Parse("b, a"), E2)` | list | true',
  '`Select(Parse("b, a, a, *"), doc)` | select | 3 elements',
  "`E7` | element | matched",
].join("\n");

describe("labels a Given binds and expression cells (#1663)", () => {
  test("labels a range binds are not cases, and an expression asks for its literal arguments", () => {
    const given = "a document with E1 through E9 in document order";
    expect(cases(criterion(given, MATCHING))).toEqual(["nth-child", "b, a", "b, a, a, *"]);
  });

  test("a label a definition binds is left out of a quoted command", () => {
    const given = "DOC1 is the document `<ul><li class=on>a</li><li>b</li></ul>`";
    const then = "running `tree DOC1` prints the tree and `select 'ul > li:not(.on)' DOC1` prints one element";
    expect(cases(criterion(given, then))).toEqual(["tree", "select 'ul > li:not(.on)'"]);
    expect(cases(criterion("a document called DOC1", then))).toEqual(["tree", "select 'ul > li:not(.on)'"]);
  });

  test("a label the Given does not bind stays a case", () => {
    expect(cases(criterion("a markdown file", 'the heading `h1` renders and `h6` is the deepest'))).toEqual(["h1", "h6"]);
    // E1..E3 are bound; E4 is not.
    expect(cases(criterion("elements E1-E3", "`E2` and `E4` match"))).toEqual(["E4"]);
  });

  test("a case found only in an assertion message is still missing", () => {
    const [nth] = criterionCases({ criteria: [criterion("elements E1 through E9", MATCHING)] }, { criterionIds: ["AC-003"] });
    const decoy = caseEvidence("matching_test.go", 'if Position(kind, elems[3]) != 2 {\n\tt.Errorf("nth-child")\n}\n');
    const real = caseEvidence("matching_test.go", 'if Position("nth-child", elems[3]) != 2 {\n\tt.Errorf("want 2")\n}\n');
    expect(nth?.literal).toBe("nth-child");
    expect(missingCases(nth ? [nth] : [], [decoy])).toHaveLength(1);
    expect(missingCases(nth ? [nth] : [], [real])).toEqual([]);
  });
});

// Scripted scenario: a test task whose criterion binds E1..E9 and lists expression cells passes
// the case walk with a test that picks elements by index, and is refused only for a literal
// argument it leaves out.
test("a test task passes the case walk without spelling the labels its Given binds", async () => {
  const spec: Spec = { ...fixtureSpec, criteria: [{ ...criterion("a document with E1 through E9 in document order", MATCHING), id: "AC-001" }] };
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
      plan.taskGraph.tasks[0]?.writes.push({ path: "tests/matching_test.go", action: "create" });
    }
    if (request.profile.output === "implementation") {
      mkdirSync(join(root, "tests"), { recursive: true });
      const write = (body: string) => writeFileSync(join(root, "tests/matching_test.go"), body);
      const test = (third: string) =>
        [
          "func TestMatching(t *testing.T) {",
          "\telems := parseDoc(t)",
          '\tif Position("nth-child", elems[3]) != 2 { t.Error("want 2") }',
          '\tif !ListMatches(Parse("b, a"), elems[1]) { t.Error("want match") }',
          `\tif len(Select(Parse(${third}), doc)) != 3 { t.Error("want 3") }`,
          "\tif !Matches(elems[6]) { t.Error(\"want E7\") }",
          "}",
          "",
        ].join("\n");
      write(test('"b, a, a, *"'));
      found.push((await request.caseCheck?.(root)) ?? ["no case check"]);
      write(test('"b, a"'));
      found.push((await request.caseCheck?.(root)) ?? ["no case check"]);
      write(test('"b, a, a, *"'));
    }
    return out;
  };
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  await fixture.service.drive(run.runId, new AbortController().signal);
  expect(found[0]).toEqual([]);
  expect(found[1]).toEqual(['AC-001 names "b, a, a, *", and no test file this task writes (tests/matching_test.go) contains it.']);
}, 60000);
