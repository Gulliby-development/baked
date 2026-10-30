import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { type CaseWalk, caseCheck, generatedCaseRefusal } from "../src/core/verification/criteria-cases.js";
import { bannedGeneratedKinds, generatedCaseDecision, generatedValues } from "../src/core/verification/generated-values.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { exportTrace, replayCaseWalks, replayTrace } from "../src/core/workflows/trace.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

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

// #2469, R78 deltaglue cli T008: the shadow record named `tests/input.test.ts:173` and `:200`, two
// interpolations in an extra real-process test that wrote files into a `mkdtemp` folder and built
// the expected stderr from their paths. The criteria's literal rows were held elsewhere in the
// file, so the record was false. A value built only from a path made at run time is not generated.
describe("scenario: R78 deltaglue T008, an expected stderr built from a temporary path (#2469)", () => {
  const T008 = { id: "T008", description: "Write the input tests.", criterionIds: ["AC-001"], writes: [{ path: "tests/input.test.ts", action: "create" as const }], dependsOn: [] };
  const HELD = 'test("escape", () => {\n  expect(run("escape", "\\\\\\\\\\\\")).toBe("ok-7");\n});\n';
  const R78 = [
    'test("real files", () => {',
    '  const dir = mkdtempSync(join(tmpdir(), "deltaglue-"));',
    "  for (const item of invalid) {",
    "    const path = join(dir, item.name);",
    "    writeFileSync(path, Uint8Array.from(item.bytes));",
    '    expect(program("check", path)).toEqual({',
    '      code: 2, out: "", err: `deltaglue: ${path}: input is not valid UTF-8\\n`,',
    "    });",
    "  }",
    '  const doubleBom = join(dir, "double-bom.txt");',
    '  expect(program("check", doubleBom)).toEqual({ code: 1, out: "", err: `deltaglue: ${doubleBom}: stream ended without [DONE]\\n` });',
    "});",
    "",
  ].join("\n");
  const walkOf = async (text: string, refuseGenerated: boolean) => {
    const walks: CaseWalk[] = [];
    const check = caseCheck({ criteria: [CRITERION] }, T008, { checks: [], tasks: [T008], generatedKinds: bannedGeneratedKinds("Use the literal inputs", ""), refuseGenerated, record: (w) => walks.push(w) });
    if (!check) throw new Error("no case check");
    return { refusals: await check(workspace({ "tests/input.test.ts": text })), walk: walks[0] };
  };

  test("the temporary-path interpolations record nothing and are not refused", async () => {
    const { refusals, walk } = await walkOf(`${HELD}${R78}`, true);
    expect(walk?.cases.every((c) => c.held)).toBe(true);
    expect(walk?.generated).toEqual([]);
    expect(refusals).toEqual([]);
  });

  test("the same expected stderr built from a row's value is still refused by its line", async () => {
    const rows = R78.replace("err: `deltaglue: ${path}:", "err: `deltaglue: ${item.name}:");
    const { refusals, walk } = await walkOf(`${HELD}${rows}`, true);
    expect(walk?.generated).toEqual([{ path: "tests/input.test.ts", line: 10, kind: "interpolate" }]);
    expect(refusals).toEqual([generatedCaseRefusal(walk?.generated ?? [])]);
  });
});

// Scripted scenario: the R74 callmend shape through a run. The criterion asks for a literal example
// and the task's test builds it by repetition. In shadow the walk passes, records the
// `generated_case` would-stop and opens nothing; enforced (#2469) the walk refuses the submission
// naming the line, and the agent's literal rewrite passes. The trace replays the walk unchanged.
async function callmend(policy?: RunPolicy) {
  const spec: Spec = { ...fixtureSpec, criteria: [CRITERION] };
  const fixture = workflowFixture(policy ? { policy } : {});
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
      const refusals = (await request.caseCheck?.(root)) ?? ["no case check"];
      found.push(refusals);
      // The agent answers a refusal by writing the case as a literal row.
      if (refusals.length) {
        writeFileSync(join(root, "tests/test_escape.py"), LITERAL_SPEC);
        found.push((await request.caseCheck?.(root)) ?? ["no case check"]);
      }
    }
    return out;
  };
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  const done = await fixture.service.drive(run.runId, new AbortController().signal);
  const stops = fixture.service.store
    .eventsOfType(run.runId, "decision.would_stop")
    .flatMap((e) => (e.type === "decision.would_stop" && e.payload.reason === "generated_case" ? [e.payload] : []));
  return { fixture, root, run, done, found, stops };
}

test("scenario: R74 callmend in shadow, a generated test input records the generated_case would-stop and opens nothing", async () => {
  const { fixture, root, run, done, found, stops } = await callmend({ ...fixturePolicy, stopModes: { generated_case: "shadow" } });
  expect(done.status).toBe("completed");
  expect(found).toEqual([[]]);
  expect(stops.map((s) => [s.mode, s.key, s.inputs])).toEqual([["shadow", "task-T001", { taskId: "T001", generated: [{ path: "tests/test_escape.py", line: 2, kind: "repeat" }] }]]);
  expect(replayCaseWalks(fixture.service.store, run.runId).map((b) => [b.recorded, b.replayed])).toEqual([[["generated_case"], ["generated_case"]]]);

  const dir = mkdtempSync(join(tmpdir(), "baked-generated-values-trace-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "trace.sqlite.gz");
  exportTrace(root, out);
  expect(replayTrace(out).runs.find((r) => r.runId === run.runId)?.newCaseRefusals).toBe(0);
}, 60_000);

// #2469, R79 deltaglue chunks: the same shape cost 8.28M tokens in correctives after review.
test("scenario: R74 callmend enforced, the walk refuses the generated input by its line and the literal rewrite passes", async () => {
  const { done, found, stops } = await callmend();
  expect(found).toEqual([[generatedCaseRefusal([{ path: "tests/test_escape.py", line: 2, kind: "repeat" }])], []]);
  expect(found[0]?.[0]).toContain("tests/test_escape.py:2 (repeat)");
  expect(done.status).toBe("completed");
  // Enforced, the reason acts instead of recording a would-stop.
  expect(stops).toEqual([]);
}, 60_000);
