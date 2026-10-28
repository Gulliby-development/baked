import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { type CaseWalk, caseCheck } from "../src/core/verification/criteria-cases.js";
import { bannedGeneratedKinds, generatedCaseDecision, generatedValues } from "../src/core/verification/generated-values.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import { exportTrace, replayCaseWalks, replayTrace } from "../src/core/workflows/trace.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 74 (#2344). callmend's request said "every test is a literal example: no
// loops, no interpolation, no generated inputs", and its specs built inputs with `"\\" * 3`, `pack`,
// interpolation and `each`; the case walk found the expected outputs and passed, and a reviewer's
// family finding named the construct one file per round (4.25M tokens). The walk now records each
// generated value in a test file that holds a case, and the `generated_case` would-stop in shadow.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const R74_REQUEST = "Every test is a literal example: no loops, no interpolation, no generated inputs.";
const ALL = new Set(["repeat", "format", "interpolate", "pack", "loop"] as const);

describe("the literal-example ban (#2344)", () => {
  test("R74's request rules out every kind, a literal criterion all but loops, and a plain request none", () => {
    expect([...bannedGeneratedKinds(R74_REQUEST, "")].sort()).toEqual(["format", "interpolate", "loop", "pack", "repeat"]);
    expect([...bannedGeneratedKinds("Build a CLI", "the tests use the literal inputs `a` and `b`")].sort()).toEqual(["format", "interpolate", "pack", "repeat"]);
    expect([...bannedGeneratedKinds("Plain example tests only, please", "")].sort()).toEqual(["format", "interpolate", "pack", "repeat"]);
    expect([...bannedGeneratedKinds("Build a CLI that escapes backslashes", "it prints `ok`")]).toEqual([]);
  });
});

/** A generated value marked and its literal twin not, per language row (one per row in `tests/language-parity.test.ts`). */
const TWINS: readonly [path: string, generated: string, literal: string][] = [
  ["spec/a_spec.rb", 'x = "\\\\" * 3', 'x = "\\\\\\\\\\\\"'],
  ["tests/test_a.py", 'x = "\\\\" * 3', 'x = "\\\\\\\\\\\\"'],
  ["tests/a.test.ts", 'const x = "\\\\".repeat(3);', 'const x = "\\\\\\\\\\\\";'],
  ["a_test.go", 'x := strings.Repeat("\\\\", 3)', 'x := "\\\\\\\\\\\\"'],
  ["src/test/java/ATest.java", 'String x = "\\\\".repeat(3);', 'String x = "\\\\\\\\\\\\";'],
  ["tests/ATests.cs", "var x = new string('\\\\', 3);", 'var x = "\\\\\\\\\\\\";'],
  ["tests/a.rs", 'let x = "\\\\".repeat(3);', 'let x = "\\\\\\\\\\\\";'],
  ["tests/ATest.php", '$x = str_repeat("\\\\", 3);', '$x = "\\\\\\\\\\\\";'],
  ["tests/testthat/test-a.R", 'x <- strrep("\\\\", 3)', 'x <- "\\\\\\\\\\\\"'],
  ["spec/a_spec.lua", 'local x = string.rep("\\\\", 3)', 'local x = "\\\\\\\\\\\\"'],
];

describe("GENERATED_VALUE_SHAPES marks a generated value and not its literal twin (#2344)", () => {
  for (const [path, generated, literal] of TWINS)
    test(path, () => {
      expect(generatedValues(path, `${generated}\n${literal}\n`, ALL)).toEqual([{ path, line: 1, kind: "repeat" }]);
    });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-generated-values-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const CRITERION = {
  ...fixtureSpec.criteria[0],
  id: "AC-001",
  given: "three backslashes as a literal example",
  when: "the user runs `escape`",
  then: "it prints `ok-7`",
} as Spec["criteria"][number];

const GENERATED_SPEC = 'def test_escape():\n    slashes = "\\\\" * 3\n    assert run("escape", slashes) == "ok-7"\n';
const LITERAL_SPEC = 'def test_escape():\n    assert run("escape", "\\\\\\\\\\\\") == "ok-7"\n';

describe("the task-end case walk records generated values in a file that holds a case (#2344)", () => {
  const T001 = { id: "T001", description: "Write the escape tests.", criterionIds: ["AC-001"], writes: [{ path: "tests/test_escape.py", action: "create" as const }], dependsOn: [] };
  const walk = async (files: Record<string, string>, kinds = bannedGeneratedKinds(R74_REQUEST, "")) => {
    const walks: (CaseWalk & { refused: number[] })[] = [];
    const check = caseCheck({ criteria: [CRITERION] }, T001, { checks: [], tasks: [T001], generatedKinds: kinds, record: (w) => walks.push(w) });
    if (!check) throw new Error("no case check");
    const refusals = await check(workspace(files));
    return { refusals, walk: walks[0] };
  };

  test("the R74 shape: the case is held, the walk refuses nothing and records the repetition", async () => {
    const { refusals, walk: found } = await walk({ "tests/test_escape.py": GENERATED_SPEC });
    expect(refusals).toEqual([]);
    expect(found?.generated).toEqual([{ path: "tests/test_escape.py", line: 2, kind: "repeat" }]);
    expect(found && generatedCaseDecision(found)).toBe(true);
    // No test code in the record.
    expect(JSON.stringify(found)).not.toContain("slashes");
  });

  test("its literal twin, a request without a ban, and a file that holds no case record none", async () => {
    expect((await walk({ "tests/test_escape.py": LITERAL_SPEC })).walk?.generated).toEqual([]);
    expect((await walk({ "tests/test_escape.py": GENERATED_SPEC }, new Set())).walk?.generated).toBeUndefined();
    const elsewhere = 'def test_other():\n    slashes = "\\\\" * 3\n    assert run("other", slashes) == "no"\n';
    expect((await walk({ "tests/test_escape.py": elsewhere })).walk?.generated).toEqual([]);
  });
});

// Scripted scenario: the R74 callmend shape through a run. The criterion asks for a literal example
// and the task's test builds it by repetition: the walk passes, records the `generated_case`
// would-stop in shadow and opens nothing; the trace replays the walk unchanged.
test("scenario: R74 callmend, a generated test input records the generated_case would-stop in shadow and opens nothing", async () => {
  const spec: Spec = { ...fixtureSpec, criteria: [CRITERION] };
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
      plan.taskGraph.tasks[0]?.writes.push({ path: "tests/test_escape.py", action: "create" });
    }
    if (request.profile.output === "implementation" && request.task?.origin === "planned") {
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "tests/test_escape.py"), GENERATED_SPEC);
      found.push((await request.caseCheck?.(root)) ?? ["no case check"]);
    }
    return out;
  };
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  const done = await fixture.service.drive(run.runId, new AbortController().signal);
  expect(done.status).toBe("completed");
  expect(found).toEqual([[]]);
  const stops = fixture.service.store
    .eventsOfType(run.runId, "decision.would_stop")
    .flatMap((e) => (e.type === "decision.would_stop" && e.payload.reason === "generated_case" ? [e.payload] : []));
  expect(stops.map((s) => [s.mode, s.key, s.inputs])).toEqual([["shadow", "task-T001", { taskId: "T001", generated: [{ path: "tests/test_escape.py", line: 2, kind: "repeat" }] }]]);
  expect(replayCaseWalks(fixture.service.store, run.runId).map((b) => [b.recorded, b.replayed])).toEqual([[["generated_case"], ["generated_case"]]]);

  const dir = mkdtempSync(join(tmpdir(), "baked-generated-values-trace-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "trace.sqlite.gz");
  exportTrace(root, out);
  expect(replayTrace(out).runs.find((r) => r.runId === run.runId)?.newCaseRefusals).toBe(0);
}, 60_000);
