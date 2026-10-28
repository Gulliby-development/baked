import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { TEST_CAP_DIR, type TestCapMeasure, testCapsOf } from "../src/core/verification/test-cap.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { scanTestIntegrity } from "../src/core/workflows/test-integrity.js";
import { exportTrace, replayTestCaps, replayTrace } from "../src/core/workflows/trace.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// #2368: R75 latcell's commands feature (Dart) wrote 15 and 13 `test(...)` blocks under the brief's
// "No file has more than 12 `test(...)` blocks"; only the reviewer counted them, and three
// correctives (1.86M tokens) fought the integrity guard's `test-count` rule over the count. The host
// now reads the cap from the brief, counts each written test file's declarations at task end, and
// the integrity guard lets a correction drop the tests above the cap.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const FILE_CAP = "No file has more than 12 `test(...)` blocks.";
const CLASS_CAP = "Keep at most 12 test methods per class.";

/** A test file of `n` tests in each language the issue names, and the cap sentence its brief uses. */
const LANGUAGES: Record<string, { path: string; cap: string; file: (n: number) => string }> = {
  dart: {
    path: "test/cli_test.dart",
    cap: FILE_CAP,
    file: (n) =>
      `import 'package:test/test.dart';\n\nvoid main() {\n${range(n, (i) => `  test('case ${i}', () => expect(${i}, ${i}));\n`)}}\n`,
  },
  csharp: {
    path: "Cli.Tests/CliTests.cs",
    cap: CLASS_CAP,
    file: (n) =>
      `using Xunit;\n\npublic class CliTests\n{\n${range(n, (i) => `    [Fact]\n    public void Case${i}() => Assert.Equal(${i}, ${i});\n`)}}\n`,
  },
  typescript: {
    path: "tests/cli.test.ts",
    cap: FILE_CAP,
    file: (n) =>
      `import { expect, test } from "bun:test";\n\n${range(n, (i) => `test("case ${i}", () => expect(${i}).toBe(${i}));\n`)}`,
  },
  python: {
    path: "tests/test_cli.py",
    cap: "Each test file has at most 12 tests.",
    file: (n) => range(n, (i) => `def test_case_${i}():\n    assert ${i} == ${i}\n\n`),
  },
  rust: {
    path: "tests/cli.rs",
    cap: FILE_CAP,
    file: (n) => range(n, (i) => `#[test]\nfn case_${i}() {\n    assert_eq!(${i}, ${i});\n}\n\n`),
  },
  go: {
    path: "cli/cli_test.go",
    cap: "No more than 12 tests per file.",
    file: (n) =>
      `package cli\n\nimport "testing"\n\n${range(n, (i) => `func TestCase${i}(t *testing.T) {\n\tif ${i} != ${i} {\n\t\tt.Fatal("differs")\n\t}\n}\n\n`)}`,
  },
  java: {
    path: "src/test/java/CliTest.java",
    cap: CLASS_CAP,
    file: (n) =>
      `import org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n\nclass CliTest {\n${range(n, (i) => `    @Test\n    void case${i}() {\n        assertEquals(${i}, ${i});\n    }\n`)}}\n`,
  },
};

function range(n: number, line: (i: number) => string): string {
  return Array.from({ length: n }, (_, i) => line(i + 1)).join("");
}

interface Scenario {
  path: string;
  /** The brief's requirement text; no cap sentence when absent. */
  cap?: string;
  policy?: RunPolicy;
}

/** A test task writes 13 tests, then 12, and asks the host's cap check after each. */
async function capScenario({ path, cap, policy }: Scenario) {
  const language = Object.values(LANGUAGES).find((l) => l.path === path);
  if (!language) throw new Error(`no language for ${path}`);
  const spec: Spec = {
    ...fixtureSpec,
    requirements: [
      { ...fixtureSpec.requirements[0], text: `Value is ready.${cap ? ` ${cap}` : ""}` } as Spec["requirements"][number],
    ],
  };
  const fixture = workflowFixture(policy ? { policy } : {});
  cleanups.push(fixture.dispose);
  const { executor, root } = fixture;
  const original = executor.execute.bind(executor);
  const checks: (string[] | "no cap check")[] = [];
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
    const out = await original(request);
    if (request.profile.output === "plan") {
      const plan = out.output as {
        markdown: string;
        taskGraph: { specHash: string; planHash: string; tasks: { writes: { path: string; action: string }[] }[] };
      };
      plan.taskGraph.specHash = hashJson(spec);
      plan.taskGraph.planHash = hashBytes(plan.markdown);
      plan.taskGraph.tasks[0]?.writes.push({ path, action: "create" });
    }
    if (request.profile.output === "implementation" && request.task?.origin === "planned") {
      const write = (n: number) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), language.file(n));
      };
      write(13);
      checks.push(request.testCapCheck ? await request.testCapCheck(root) : "no cap check");
      write(12);
      checks.push(request.testCapCheck ? await request.testCapCheck(root) : "no cap check");
    }
    return out;
  };
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  await fixture.service.drive(run.runId, new AbortController().signal);
  const store = fixture.service.store;
  const wouldStops = store
    .eventsOfType(run.runId, "decision.would_stop")
    .flatMap((e) => (e.type === "decision.would_stop" && e.payload.reason === "test_cap" ? [e.payload] : []));
  return { fixture, run, checks, wouldStops, store };
}

const enforce: RunPolicy = { ...fixturePolicy, stopModes: { test_cap: "enforce" } };

describe("a test file over the brief's test cap is named at task end (#2368)", () => {
  for (const [language, { path, cap }] of Object.entries(LANGUAGES))
    test(`${language}: 13 tests under a cap of 12 go back to the task under enforce, then 12 pass`, async () => {
      const { checks, wouldStops } = await capScenario({ path, cap, policy: enforce });
      const scope = cap === CLASS_CAP ? `class 1 of ${path}` : path;
      expect(checks).toEqual([
        [expect.stringContaining(`${scope} declares 13 tests; the spec allows at most 12 per ${cap === CLASS_CAP ? "class" : "file"}`)],
        [],
      ]);
      expect(String(checks[0]?.[0])).toContain(`("${testCapsOf(cap)[cap === CLASS_CAP ? "class" : "file"]?.phrase}")`);
      expect(wouldStops).toEqual([]);
    });

  test("in shadow (the default) the submission is accepted and the file over its cap is a would-stop, recorded and replayed", async () => {
    const { path, cap } = LANGUAGES.dart as { path: string; cap: string };
    const { checks, wouldStops, store, run, fixture } = await capScenario({ path, cap });
    expect(checks).toEqual([[], []]);
    expect(wouldStops).toEqual([
      expect.objectContaining({
        mode: "shadow",
        key: `${TEST_CAP_DIR}T001.json#${path}`,
        inputs: { taskId: "T001", path, scope: "file", tests: 13, cap: 12 },
      }),
    ]);
    // Both checks are recorded (the latest record of the task) and replay unchanged.
    const replayed = replayTestCaps(store, run.runId);
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every((b) => JSON.stringify(b.recorded) === JSON.stringify(b.replayed))).toBe(true);
    expect(replayed.at(-1)).toEqual({ taskId: "T001", mode: "shadow", recorded: [], replayed: [] });

    const dir = mkdtempSync(join(tmpdir(), "baked-test-cap-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "trace.sqlite.gz");
    exportTrace(fixture.root, out);
    expect(Buffer.from(Bun.gunzipSync(readFileSync(out))).includes("case 13")).toBe(false);
    const runOf = (replay: ReturnType<typeof replayTrace>) => replay.runs.find((r) => r.runId === run.runId);
    expect(runOf(replayTrace(out))?.newTestCapRefusals).toBe(0);
    // A rule that refuses every count finds the passing check's 12-test file.
    const every = (measures: readonly TestCapMeasure[]) => measures.map((_, i) => i);
    expect(runOf(replayTrace(out, { testCapRule: every }))?.newTestCapRefusals).toBe(1);
  });

  test("a brief without a cap changes nothing: no check, no record, no would-stop", async () => {
    const { path } = LANGUAGES.dart as { path: string };
    const { checks, wouldStops, store, run } = await capScenario({ path, policy: enforce });
    expect(checks).toEqual(["no cap check", "no cap check"]);
    expect(wouldStops).toEqual([]);
    expect(replayTestCaps(store, run.runId)).toEqual([]);
  });
});

describe("the integrity guard reads the same cap (#2368)", () => {
  for (const [language, { path, cap, file }] of Object.entries(LANGUAGES))
    test(`${language}: a correction that brings 13 tests down to 12 is accepted; 11 or no cap is a test-count finding`, () => {
      const drop = (to: number, specText: string) =>
        scanTestIntegrity([{ path, before: file(13), after: file(to) }], { specText }).map((f) => f.rule);
      expect(drop(12, cap)).toEqual([]);
      expect(drop(11, cap)).toContain("test-count");
      expect(drop(12, "Value is ready.")).toContain("test-count");
    });

  test("the drop past the cap names how much of it the cap covers", () => {
    const { path, cap, file } = LANGUAGES.dart as { path: string; cap: string; file: (n: number) => string };
    const [finding] = scanTestIntegrity([{ path, before: file(13), after: file(11) }], { specText: cap });
    expect(finding?.detail).toContain("test count dropped from 13 to 11");
    expect(finding?.detail).toContain("the brief's test cap covers only 1 of the drop");
  });
});
