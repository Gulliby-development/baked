import { literalPropertyProblems, rowFiles, rowsArtifact } from "../src/core/workflows/acceptance-rows.js";
import { clearBannedProperties } from "../src/core/verification/initiative-ownership.js";
import { CALL_COST_MODELS, NEXT_CALL, perCallCostScenario } from "./helpers/per-call-cost-scenario.js";
import { decoySamples, residualSamples, residualSpec } from "./helpers/criteria-residual-fixtures.js";
import { evaluateAutoApproval, planScopeAdvice } from "../src/core/workflows/auto-approval.js";
import { proseAfterRefusalScenario, refusalKinds } from "./helpers/prose-after-refusal-scenario.js";
import { runScanner } from "../src/core/workflows/quality/rules.js";
import { suspendClock } from "./helpers/suspend-clock.js";
import { caseCheck } from "../src/core/verification/criteria-cases.js";
import { fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";
import { cellSamples, cellSpec, omittedCellInput, withoutCellInput } from "./helpers/criteria-cell-fixtures.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import { canRepairRun, type RepairBlock } from "../src/core/workflows/repairable.js";
import { growthLimit, type InitiativeView, rebaseView, shareShortfall } from "../src/core/workflows/initiatives/service.js";
import { estimateInitiative } from "../src/core/workflows/initiatives/estimate.js";
import { hasExecutableFields, manifestFieldChanges } from "../src/core/workflows/quality/manifests.js";
import { REPLAY_TARGETS } from "../src/core/workflows/quality/baseline-replay.js";
import type { TestRunner } from "../src/core/verification/output-counts.js";
import { unrequestedManifestFields } from "../src/core/workflows/quality/dependencies.js";
import { historyFixture, plannedForecastScenario } from "./helpers/initiative-planned-forecast.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { directoryFixers, directoryFixerScenario } from "./helpers/directory-fixer-scenario.js";
import { baselineCreatedFilesScenario, FIRST_RUN_OUTPUTS } from "./helpers/baseline-created-files-scenario.js";
import { TOOL_CACHES } from "../src/core/verification/snapshot.js";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { syntaxErrors } from "../src/core/intelligence/syntax-check.js";
import { criterionCases, missingCases, testsHold, writtenTestPaths } from "../src/core/verification/criteria-cases.js";
import { INLINE_HARNESS, type InlineRowTest, inlineRowFile, withInlineRows } from "../src/core/workflows/acceptance-rows-inline.js";
import { reproExecutables } from "../src/core/verification/repro.js";
import { entryPointCommand } from "../src/core/verification/entry-points.js";
import { noteSiblingFindings, ownerOfFinding } from "../src/core/verification/initiative-ownership.js";
import { missingPlannedPaths, noTestsCollected } from "../src/core/verification/convergence.js";
import { exitStatus, timedOutFailure } from "../src/core/verification/check-runner.js";
import { noTestsCollected } from "../src/core/verification/convergence.js";
import { baselineRegression, buildRunner, diagnosticCount, failedTests, failureSignature, testCount, testsRan } from "../src/core/verification/output-counts.js";
import { baselineDebt, baselineKeys } from "../src/core/verification/task-end-check.js";
import { affectedTestCheck, plannedWrittenTests, writtenTestsCheck } from "../src/core/workflows/affected-tests.js";
import { launchedCommand } from "../src/core/workflows/launcher.js";
import { type HostEdit, hostOnlyEvidence, plannerGraph } from "../src/core/workflows/host-edits.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { sizePlan, splitTestTasks } from "../src/core/workflows/sizing.js";
import { withPerTestTimeout } from "../src/core/workflows/test-timeout.js";
import { detectProfile } from "../src/core/tools/project.js";
import { formatProbeCommand } from "../src/core/tools/auto-format.js";
import {
  coveringChecks,
  fixerCommand,
  fixerTierPaths,
  isStaticCheck,
  isWholeUnitCheck,
  styleClaimShown,
} from "../src/core/workflows/check-policy.js";
import { buildWrapper, detectGates, executeGate } from "../src/core/workflows/gates.js";
import { formatWrittenChecks } from "../src/core/workflows/format-written.js";
import { type LayoutResult, layoutVerdict } from "../src/core/workflows/layout-check.js";
import { addedDependencies, checkDependencies } from "../src/core/workflows/quality/dependencies.js";
import {
  detectMutationTool,
  type ToolShell,
  toolShellFiles,
} from "../src/core/workflows/quality/mutation-tools.js";
import { generateMutants, isTestCheck, proposalFiles } from "../src/core/workflows/quality/mutation.js";
import {
  libraryFiles,
  propertyLibraries,
  propertyTestKind,
} from "../src/core/workflows/quality/properties.js";
import {
  checkBuiltinRules,
  ruleClaimKey,
  ruleClaimText,
  ruleFindingKey,
} from "../src/core/workflows/quality/rules.js";
import { staticCorrection } from "../src/core/workflows/scheduler.js";
import { ASSERTION_FAILURES } from "./helpers/assertion-failures.js";
import { failureOwner } from "../src/core/workflows/task-graph.js";
import { type Check, type RunPolicy, type RuntimeState, type Spec, type TaskGraph, uncontractedBuildCriteria } from "../src/core/workflows/schemas.js";
import type { TaskRow, WorkflowStore } from "../src/core/workflows/store.js";
import { scanTestIntegrity, testChanges } from "../src/core/workflows/test-integrity.js";
import type { Task } from "../src/core/workflows/types.js";
import {
  createTaskWorktree,
  ensureRunWorktree,
  runContentCommit,
} from "../src/core/workflows/worktree.js";

test("#1643 initiative ceiling gate uses central stage prices from shared history", async () => {
  const history = await historyFixture(27.3 / 11);
  try {
    const { fixture, initiatives, view } = await plannedForecastScenario(12, 0.72, [history.root]);
    try {
      expect(view.budget.cost).toMatchObject({ capUsd: 30, tolerance: 0.25, ceilingUsd: 37.5, spentUsd: 0.72 });
      expect(view.next).toMatchObject({ kind: "start", featureId: "f2" });
      expect(shareShortfall(view, view.features[1]!)).toBeNull();
      // One accepted skeleton measures nothing: a forecast over the ceiling advises (#1659).
      expect(view.budget.cost).toMatchObject({ measuredFeatures: 0, forecastBinding: false });
      const advisory = { ...view, budget: { ...view.budget, cost: { ...view.budget.cost, forecastUsd: 37.51 } } };
      expect(shareShortfall(advisory, view.features[1]!)).toBeNull();
      const over = { ...view, budget: { ...view.budget, cost: { ...view.budget.cost, forecastUsd: 37.51, forecastBinding: true } } };
      expect(shareShortfall(over, view.features[1]!)?.message).toContain("above its $37.50 ceiling");
      const at = { ...view, budget: { ...view.budget, cost: { ...view.budget.cost, forecastUsd: 37.5, forecastBinding: true } } };
      expect(shareShortfall(at, view.features[1]!)).toBeNull();
      const estimate = initiatives.estimate("values", 0);
      expect(view.budget.cost.forecastUsd).toBeCloseTo(0.72 + estimate.features.slice(1)
        .reduce((sum, f) => sum + (f.costUsd!.low + f.costUsd!.high) / 2, 0), 2);
    } finally { await fixture.dispose(); }
  } finally { await history.dispose(); }
}, 60000);

/**
 * The gate matrix (#854): every supported stack against every quality gate's decision, without a
 * model. Bench rounds 12 and 13 lost whole rounds to gates that did not know a toolchain or a
 * project layout (#796, #835, #844, #840, #842); each of those is a cell here.
 *
 * A cell that is known to be wrong names its issue in `KNOWN` and is skipped; the PR that fixes the
 * issue removes the entry, so the cell runs from then on. A fix PR for a gate finding adds its
 * failing cell first.
 *
 * Worktree mode repeats the decisions in the run and task worktrees the loop runs in, created by
 * the scheduler's own worktree helpers with the working copy's `node_modules` linked (#835), and
 * reads them through the scheduler's tool shell and property-library probe.
 *
 * The toolchain tier at the end runs each stack's detected gates on a minimal valid project with
 * the real tools. It needs the toolchains, so it runs only with BAKED_GATE_MATRIX_TOOLCHAINS=1 (the
 * CI job `gate-matrix` sets it); the rest of the file is hermetic.
 */

type Stack = "bun" | "npm" | "python" | "go" | "rust" | "maven" | "dotnet";

describe("criterion cell classification and diagnostic decoys (#1629)", () => {
  for (const sample of residualSamples) test(`${sample.stack}: ${sample.name} in task-end and pricing walks`, async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-residual-cell-"));
    try {
      const task = { criterionIds: ["AC-001"], writes: [{ path: sample.path, action: "create" as const }] };
      const spec = residualSpec(sample);
      for (const includeBroad of [false, true]) {
        const cases = criterionCases(spec, task, { checks: [], includeBroad });
        expect(cases.map((c) => c.literal)).toEqual([...sample.cases]);
        expect(missingCases(cases, [sample.text])).toEqual([]);
        // A wrong byte or candidate must still be missing after formatting normalization.
        if (cases.length) expect(missingCases(cases, [""])).toHaveLength(cases.length);
      }
      const file = join(root, sample.path);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, sample.text);
      expect((await caseCheck(spec, task, { checks: [] })?.(root)) ?? []).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  for (const sample of decoySamples) test(`${sample.stack}: assertion messages cannot stand in for an input`, async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-decoy-cell-"));
    try {
      const task = { criterionIds: ["AC-001"], writes: [{ path: sample.path, action: "create" as const }] };
      const spec = { ...fixtureSpec, criteria: [{ ...fixtureSpec.criteria[0]!, then: 'input `--case-42` is accepted' }] };
      const file = join(root, sample.path);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, sample.decoy);
      const check = caseCheck(spec, task, { checks: [] })!;
      expect((await check(root))[0]).toContain("message alone is a decoy");
      writeFileSync(file, sample.text);
      expect(await check(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("submission gates followed by prose (#1615)", () => {
  test.each(refusalKinds)("%s keeps the refusal and permits repair in the same attempt", async (kind) => {
    await proseAfterRefusalScenario(kind);
  }, 60000);
});

describe("gate execution after host suspend (#1610)", () => {
  test("the mutation tool's shared budget clock excludes suspend", async () => {
    const fixture = workflowFixture();
    const scope = new ProcessScope();
    const wake = suspendClock();
    try {
      const scheduler = fixture.service.scheduler as unknown as {
        toolShell(runId: string, policy: RunPolicy, root: string, scope: ProcessScope, check: undefined, signal: AbortSignal): ToolShell;
      };
      const shell = scheduler.toolShell("sleep-test", fixture.policy, fixture.root, scope, undefined, new AbortController().signal);
      const before = shell.now();
      wake.jump();
      expect(shell.now() - before).toBeLessThan(5_000);
    } finally {
      wake.restore();
      await scope.stop();
      await fixture.dispose();
    }
  });

  test.each(["command", "scanner"] as const)("%s timeout excludes the sleep gap", async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "baked-gate-suspend-"));
    const wake = suspendClock();
    try {
      const args = ["-e", "await Bun.sleep(200); console.log('gate finished')"];
      const pending = kind === "command"
        ? executeGate(root, { id: "sleep", executable: "bun", args, cwd: ".", timeoutMs: 10_000, required: true, scope: "feature", envNames: [], writes: [] }, new AbortController().signal)
        : runScanner(process.execPath, args, root, 10_000);
      // Spawning and arming the timeout happen before the first await in both runners.
      wake.jump();
      const result = await pending;
      expect(result.status).toBe(kind === "command" ? "passed" : 0);
      if ("durationMs" in result) expect(result.durationMs).toBeLessThan(10_000);
      expect("stdout" in result ? result.stdout : result.outputTail).toContain("gate finished");
    } finally {
      wake.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("host-written acceptance rows in the case-walk and mutation gates (#1596)", () => {
  // #1660: every framework, including the Java and C# tests that hold the rows as literals.
  const layouts = {
    bun: { harness: "tests/harness.ts", test: "tests/rows.test.ts" },
    pytest: { harness: "tests/harness.py", test: "tests/test_rows.py" },
    go: { harness: "tests/harness.go", test: "tests/rows_test.go", package: "tests" },
    junit: { harness: "tests/Harness.java", test: "tests/RowsTest.java", package: "tests" },
    rust: { harness: "tests/harness.rs", test: "tests/rows.rs" },
    xunit: { harness: "tests/Harness.cs", test: "tests/RowsTest.cs", package: "Tests" },
  } as const;
  test.each(Object.keys(layouts) as (keyof typeof layouts)[])("%s retains every case in its JSON data and keeps generated tests out of mutation proposals", async (framework) => {
    const root = mkdtempSync(join(tmpdir(), "baked-row-gate-"));
    try {
      const spec = { ...fixtureSpec, criteria: [{ ...fixtureSpec.criteria[0]!, given: "a number", when: "it is doubled", then: "Input | Scenario | Expected\n12 | small | 24\n34 | large | 68" }] };
      const { harness, test: file } = layouts[framework];
      const task: Task = { id: "T001", title: "Rows", description: "Write actual(input)", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", origin: "planned", findingIds: [], rationale: "Test", readHints: [], checkIds: [],
        rows: ["AC-001"], rowTest: { ...layouts[framework], framework, data: "tests/rows.json" },
        writes: [harness, file, "tests/rows.json"].map((path) => ({ path, action: "create" })) };
      const graph = { schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [task] };
      const artifact = rowsArtifact(spec, graph, { schemaVersion: 1, inputHash: "a".repeat(64), verdict: "pass", findings: [] });
      const files = rowFiles(task, artifact);
      mkdirSync(join(root, "tests"));
      for (const generated of files) writeFileSync(join(root, generated.path), generated.content);
      const check = caseCheck(spec, task, { checks: [] });
      expect(check).toBeDefined();
      expect(await check?.(root)).toEqual([]);
      // Java and C# tests hold the rows themselves, and the host refuses any change to that file.
      if (framework === "junit" || framework === "xunit") expect(files[1]?.content).toMatch(/\b34L?\b.*\b68L?\b/);
      else {
        writeFileSync(join(root, "tests/rows.json"), JSON.stringify(artifact.rows.slice(0, 1)));
        expect((await check?.(root))?.join()).toContain("34");
      }
      const changes = files.map((generated) => ({ path: generated.path, before: "", content: generated.content }));
      expect(proposalFiles(changes)).toEqual([]);
      expect(generateMutants(changes)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  // #2045: a `property` flag on the table keeps it from the rows in every framework; the host
  // clears it under a request that bans generated inputs, and refuses it otherwise.
  test.each(Object.keys(layouts) as (keyof typeof layouts)[])("%s: a property-flagged table is refused, and cleared under a ban it yields its rows", (framework) => {
    const flagged: Spec = { ...fixtureSpec, criteria: [{ ...fixtureSpec.criteria[0]!, given: "a number", when: "it is doubled", then: "Input | Expected\n12 | 24\n34 | 68", property: "numbers" }] };
    const task: Task = { id: "T001", title: "Rows", description: "Write actual(input)", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", origin: "planned", findingIds: [], rationale: "Test", readHints: [], checkIds: [],
      rows: ["AC-001"], rowTest: { ...layouts[framework], framework, data: "tests/rows.json" },
      writes: [layouts[framework].harness, layouts[framework].test, "tests/rows.json"].map((path) => ({ path, action: "create" })) };
    const graph = { schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [task] };
    const analysis = { schemaVersion: 1 as const, inputHash: "a".repeat(64), verdict: "pass" as const, findings: [] };
    expect(literalPropertyProblems(flagged)).toEqual([expect.stringContaining("Remove property or the table")]);
    const { spec, cleared } = clearBannedProperties(flagged, "Every test is a literal example: no random values, no generated inputs.");
    expect(cleared).toEqual(["AC-001"]);
    expect(literalPropertyProblems(spec)).toEqual([]);
    const artifact = rowsArtifact(spec, graph, analysis);
    expect(artifact.rows.map((row) => row.input)).toEqual([12, 34]);
    expect(rowFiles(task, artifact).length).toBeGreaterThan(0);
  });
});

describe("gate matrix: inline rows block holds its own cells (#1997)", () => {
  // R64 cfgquill lint: 12 refusals of AC-004 cells the host's own Go block held. A new inline
  // framework or a new text shape adds its row here; the first test fails when a framework lacks one.
  const layouts: Record<string, InlineRowTest> = {
    bun: { mode: "inline", framework: "bun", test: "tests/text.test.ts" },
    pytest: { mode: "inline", framework: "pytest", test: "tests/test_text.py" },
    go: { mode: "inline", framework: "go", package: "calc", test: "calc/calc_test.go" },
    junit: { mode: "inline", framework: "junit", package: "com.ex.calc", test: "src/test/java/com/ex/calc/CalcTest.java" },
    rust: { mode: "inline", framework: "rust", test: "tests/calc.rs" },
    xunit: { mode: "inline", framework: "xunit", package: "Calc.Tests", test: "Calc.Tests/CalcTest.cs" },
  };
  const shapes: [string, unknown][] = [
    ["two-line CRLF text", ["[a]\r\nb=1\r\n", {}]],
    ["LF text", ["[a]\nb=1\n", {}]],
    ["text with a tab", ["k\tv\nnext", {}]],
    ["BOM, astral, LS and bare CR", ["\ufeff#\u{1f600}\r\r\n#\u2028\r", {}]],
  ];
  test("every inline framework has its row", () => {
    expect(Object.keys(layouts).sort()).toEqual(Object.keys(INLINE_HARNESS).sort());
  });
  for (const [framework, rowTest] of Object.entries(layouts))
    for (const [shape, input] of shapes)
      test(`${framework}: ${shape}`, async () => {
        const rows = [{ id: "AC-004:1", criterionId: "AC-004", source: "", input, expected: 1 }];
        const file = inlineRowFile(rowTest, rows);
        const text = withInlineRows(null, file);
        // The block's text holds the cell, decoded to a canonical form.
        expect(testsHold(text, JSON.stringify(input))).toBe(true);
        // And the task-end walk asks nothing of a task whose intact block holds its rows.
        const spec = { criteria: [{ id: "AC-004", requirementIds: ["FR-001"], given: "a config text", when: "it is linted", then: `Input | Expected\n${JSON.stringify(input)} | 1`, method: "automated" as const }] };
        const task = { id: "T003", criterionIds: ["AC-004"], rows: ["AC-004"], rowTest, writes: [{ path: rowTest.test, action: "modify" as const }] };
        const root = project({ [rowTest.test]: text });
        const check = caseCheck(spec, task, { checks: [], hostRows: [file] });
        expect(await check?.(root)).toEqual([]);
      });
});

describe("gate matrix: directory-wide fixer effects (#1593)", () => {
  for (const fixer of directoryFixers)
    test(`${fixer.name}: sibling edits are journaled before editing and resuming`, async () => {
      await directoryFixerScenario(fixer);
    }, 60000);
});
// #1815: the baseline checks before approval create what a first build writes; the run must reach
// approval with those files in its base, not stop `input_changed`.
describe("gate matrix: files a first check run creates (#1815)", () => {
  for (const [language, outputs] of Object.entries(FIRST_RUN_OUTPUTS))
    test(`${language}: ${outputs.join(", ")}`, async () => {
      const result = await baselineCreatedFilesScenario(outputs);
      expect(result.approval).toEqual({ status: "waiting", reason: "approval" });
      const base = outputs.filter((p) => !p.split("/").some((segment) => TOOL_CACHES.includes(segment)));
      expect(result.baseline?.createdByChecks ?? []).toEqual(base.sort());
      expect(result.final.status).toBe("completed");
    }, 60000);
});
const STACKS: Stack[] = ["bun", "npm", "python", "go", "rust", "maven", "dotnet"];

/** The gates a failure of which is corrected only in the files its output names (#1067). */
const STATIC_FIXES: Record<Stack, string[]> = {
  bun: ["typecheck", "lint"],
  npm: ["lint"],
  python: ["ruff"],
  go: ["gofmt", "go-vet"],
  rust: ["cargo-fmt", "cargo-clippy"],
  maven: [],
  dotnet: ["dotnet-format"],
};

/** The task-scope check that runs a test task's own file (#1271; compiled stacks #1396). */
const WRITTEN_TEST_ARGS: Record<Stack, string[] | null> = {
  // The detected JavaScript gates run a package script, whose arguments are up to the script.
  bun: null,
  npm: null,
  python: ["-m", "pytest", "-q", "./tests/test_sum.py"],
  go: ["test", "./."],
  rust: ["test", "--test", "sum"],
  maven: ["-B", "-q", "test", "-Dtest=com.example.SumTest", "-Dsurefire.failIfNoSpecifiedTests=false"],
  dotnet: ["test", "--nologo", "--filter", "FullyQualifiedName~SumTests."],
};

/** The program a README of the stack documents, which run_probe must be able to start (#1529). */
const DOCUMENTED_PROGRAM: Record<Stack, string> = {
  bun: "bun",
  npm: "node",
  python: process.platform === "win32" ? "python" : "python3",
  go: "go",
  rust: "cargo",
  maven: "java",
  dotnet: "dotnet",
};

/** Each stack's fixture declaring a `tool` command the way its manifest installs one (#1821). */
const WITH_ENTRY_POINT: Record<Stack, (files: Record<string, string>) => Record<string, string>> = {
  bun: (files) => ({ ...files, "package.json": JSON.stringify({ ...JSON.parse(files["package.json"]!), bin: { tool: "cli.js" } }) }),
  npm: (files) => ({ ...files, "package.json": JSON.stringify({ ...JSON.parse(files["package.json"]!), bin: { tool: "cli.js" } }) }),
  python: (files) => ({ ...files, "pyproject.toml": `${files["pyproject.toml"]}\n[project.scripts]\ntool = "fixture.cli:main"\n` }),
  go: (files) => ({ ...files, "cmd/tool/main.go": "package main\n\nfunc main() {}\n" }),
  rust: (files) => ({ ...files, "Cargo.toml": `${files["Cargo.toml"]}\n[[bin]]\nname = "tool"\npath = "src/main.rs"\n` }),
  maven: (files) => ({ ...files, "pom.xml": "<project><modelVersion>4.0.0</modelVersion><artifactId>tool</artifactId><properties><exec.mainClass>com.example.Main</exec.mainClass></properties></project>\n" }),
  dotnet: (files) => ({ ...files, "Fixture.csproj": files["Fixture.csproj"]!.replace("</Project>", "<PropertyGroup><PackAsTool>true</PackAsTool><ToolCommandName>tool</ToolCommandName></PropertyGroup></Project>") }),
};

/**
 * The edit tools' lint and per-file format commands (#1537): the Python profile read ruff only from
 * ruff.toml, so this fixture's `[tool.ruff]` project got flake8 and black while its gates ran ruff.
 */
const EDIT_PROFILE: Record<Stack, { lint: string | null; formatFile: string | null }> = {
  bun: { lint: "bun run lint", formatFile: null },
  npm: { lint: "npm run lint", formatFile: null },
  python: { lint: "ruff check", formatFile: "ruff format" },
  go: { lint: "go vet ./...", formatFile: "gofmt -w" },
  rust: { lint: "cargo clippy", formatFile: "rustfmt" },
  maven: { lint: "mvn checkstyle:check", formatFile: null },
  dotnet: { lint: "dotnet format --verify-no-changes", formatFile: null },
};

/** The launchers a project may start its checks through (#1507). */
const LAUNCHERS: [string, (executable: string, args: string[]) => { executable: string; args: string[] }][] = [
  ["cmd /c", (executable, args) => ({ executable: "cmd", args: ["/c", executable, ...args] })],
  ["cmd.exe /d /s /c", (executable, args) => ({ executable: "cmd.exe", args: ["/d", "/s", "/c", [executable, ...args].join(" ")] })],
  ["sh -c", (executable, args) => ({ executable: "sh", args: ["-c", [executable, ...args].join(" ")] })],
  ["pwsh -Command", (executable, args) => ({ executable: "pwsh", args: ["-NoProfile", "-Command", [executable, ...args].join(" ")] })],
];

/** A failed test as the stack's test runner prints it, before a hang (#1277, #1424). */
const FAILED_TEST_OUTPUT: Record<Stack, string> = {
  bun: "test/sum.test.ts:\n(fail) sum is commutative [0.31ms]",
  npm: " FAIL  src/sum.test.js > sum\n × sum 2ms",
  python: "FAILED tests/test_sum.py::test_sum_commutes - assert 3 == 4",
  go: "--- FAIL: TestSum (0.00s)",
  rust: "test sum_commutes ... FAILED",
  maven: "[ERROR] com.example.SumTest.commutes -- Time elapsed: 0.012 s <<< FAILURE!",
  dotnet: "  Failed SumTests.Commutes [8 ms]",
};

/**
 * A red baseline as the stack's test runner (and Python's type checker) prints it, with `n` files
 * checked or tests passing. A task that adds a file or a passing test changes `n` but not the
 * failure, which must keep its signature (#1221, #1425).
 */
const RED_BASELINE: Record<Stack, (n: number) => string> = {
  bun: (n) => `test/old.test.ts:\n(fail) old [1.00ms]\n\n ${n} pass\n 1 fail\n ${n + 1} expect() calls\nRan ${n + 1} tests across ${n} files. [12.00ms]`,
  npm: (n) => ` FAIL  src/old.test.js > old\n Test Files  1 failed | ${n} passed (${n + 1})\n      Tests  1 failed | ${n} passed (${n + 1})`,
  python: (n) => `FAILED tests/test_old.py::test_old - assert 1 == 2\n=== 1 failed, ${n} passed in 0.12s ===\nsrc/old.py:3: error: Incompatible return value type\nFound 1 error in 1 file (checked ${n} source files)`,
  go: (n) => `--- FAIL: TestOld (0.00s)\nFAIL\nFAIL\texample.com/fixture\t0.0${n}s`,
  rust: (n) => `running ${n + 1} tests\ntest old ... FAILED\ntest result: FAILED. ${n} passed; 1 failed; 0 ignored; 0 measured; 0 filtered out`,
  maven: (n) => `[ERROR] Tests run: ${n + 1}, Failures: 1, Errors: 0, Skipped: 0\n[ERROR] com.example.OldTest.old -- Time elapsed: 0.01 s <<< FAILURE!`,
  dotnet: (n) => `  Failed OldTests.Old [3 ms]\nFailed!  - Failed:     1, Passed:     ${n}, Skipped:     0, Total:     ${n + 1}`,
};

/**
 * A test run that exits 0 with no test run, as the stack's runner prints it: every test of the
 * file skipped, compiled out behind a feature or build tag, or matched by no filter (#1832).
 */
const ZERO_RUN_OUTPUT: Record<Stack, string> = {
  bun: "tests/sum.test.ts:\n\n 0 pass\n 1 skip\n 0 fail\nRan 1 test across 1 file. [17.00ms]",
  npm: " Test Files  1 skipped (1)\n      Tests  1 skipped (1)\n   Duration  210ms",
  python: "s                                                                        [100%]\n1 skipped in 0.01s",
  go: "testing: warning: no tests to run\nPASS\nok  \texample.com/fixture\t0.002s [no tests to run]",
  rust: "     Running tests/unicode_tests.rs (target/debug/deps/unicode_tests-1a2b)\n\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
  maven: "[WARNING] Tests run: 2, Failures: 0, Errors: 0, Skipped: 2, Time elapsed: 0.01 s -- in com.example.SumTest\n[WARNING] Tests run: 2, Failures: 0, Errors: 0, Skipped: 2",
  dotnet: "No test matches the given testcase filter `FullyQualifiedName~SumTests.` in /w/bin/Debug/net10.0/Sum.Tests.dll",
};

/**
 * The runner the baseline replay splits a stack's test check by when it does not build as a whole
 * (#2020): every stack's runner has a `REPLAY_TARGETS` row, runs or a reason it needs none.
 */
const REPLAY_RUNNER: Record<Stack, TestRunner> = { bun: "bun", npm: "vitest", python: "pytest", go: "go", rust: "cargo", maven: "maven", dotnet: "dotnet" };

describe("gate matrix: baseline replay per test target (#2020)", () => {
  test("each stack's runner has its replay-target row", () => {
    for (const stack of STACKS) expect({ stack, row: REPLAY_TARGETS[REPLAY_RUNNER[stack]] !== undefined }).toEqual({ stack, row: true });
    expect(STACKS.filter((stack) => typeof REPLAY_TARGETS[REPLAY_RUNNER[stack]] === "function").sort()).toEqual(["dotnet", "maven", "python", "rust"]);
  });
});

// Dependency readers do not imply Gradle or Ruby gate detection support (#1489, #1552).
describe("requested Gradle and Gemfile dependency checks (#1552)", () => {
  for (const path of ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "Gemfile"]) {
    test(`${path}: a requested edit still blocks an unrequested package without registry access`, async () => {
      const ruby = path === "Gemfile";
      const before = ruby ? 'gem "rack", "3"\n' : 'dependencies { implementation("org.example:core:1") }\n';
      const content = before + (ruby ? 'gem "rake", "13"\n' : 'dependencies { testImplementation("org.example:tests:1") }\n');
      const name = ruby ? "rake" : "org.example:tests";
      const files = [{ path, before, content }];
      const result = await checkDependencies(files, new Set(), { lookups: false, requested: `Update ${path}.` });
      expect(result.dependencies.map((d) => [d.name, d.verdict, d.blocking])).toEqual([[name, "unrequested", true]]);
      const requested = await checkDependencies(files, new Set(), { lookups: false, requested: `Update ${path} to use ${name}.` });
      expect(requested.dependencies.map((d) => [d.name, d.verdict, d.blocking])).toEqual([[name, "unknown", false]]);
    });
  }
});

/** Cells known to be wrong today: `<stack>:<cell>` -> issue. */
const KNOWN: Record<string, string> = {};

interface Fixture {
  /** Files that make the gate detector see the stack, as the bench loop's scaffolds write them. */
  files: Record<string, string>;
  /** The preselected gates detectGates proposes, in order. */
  gates: string[];
  /** The gates that analyze the whole compilation unit and so run at integration, not per task. */
  wholeUnit: string[];
  /** A manifest change that adds one dependency, and the dependency it adds. */
  manifest: { path: string; before: string; after: string; added: string };
  /**
   * A library-free property test (allowed when the project forbids new dependencies), one with the
   * library, and a deterministic one that enumerates a bounded domain (a request without random input, #1064).
   */
  property: { path: string; seeded: string; library: string; exhaustive: string };
  /** What makes the stack's mutation tool detectable (files and commands on PATH), or null when only the built-in engine exists. */
  mutation: { tool: string; source: string; files: Record<string, string>; on: string[] } | null;
}

const FIXTURES: Record<Stack, Fixture> = {
  bun: {
    files: {
      "package.json": JSON.stringify({
        name: "fixture",
        scripts: { test: "bun test", lint: "biome check .", typecheck: "tsc --noEmit" },
      }),
      "bun.lock": "{}",
    },
    gates: ["typecheck", "lint", "tests"],
    wholeUnit: ["typecheck"],
    manifest: {
      path: "package.json",
      before: JSON.stringify({ name: "fixture", dependencies: {} }),
      after: JSON.stringify({ name: "fixture", dependencies: { zod: "^3.0.0" } }),
      added: "zod",
    },
    property: {
      path: "test/sum.test.ts",
      exhaustive:
        "import { expect, test } from 'bun:test';\ntest('sum is commutative for every byte pair', () => {\n  for (let a = 0; a < 256; a++) for (let b = 0; b < 16; b++) expect(a + b).toBe(b + a);\n});\n",
      seeded:
        "import { expect, test } from 'bun:test';\nfunction mulberry32(a: number) { return () => (a = (a + 0x6d2b79f5) | 0) / 2 ** 32; }\ntest('sum is commutative', () => {\n  const rand = mulberry32(42);\n  for (let i = 0; i < 100; i++) {\n    const a = rand(), b = rand();\n    expect(a + b).toBe(b + a);\n  }\n});\n",
      library:
        "import fc from 'fast-check';\nimport { test } from 'bun:test';\ntest('sum', () => { fc.assert(fc.property(fc.integer(), fc.integer(), (a, b) => a + b === b + a)); });\n",
    },
    mutation: {
      tool: "stryker",
      source: "src/sum.ts",
      files: { "node_modules/@stryker-mutator/core/bin/stryker.js": "" },
      on: ["node"],
    },
  },
  npm: {
    files: {
      "package.json": JSON.stringify({
        name: "fixture",
        scripts: { test: "vitest run", lint: "eslint .", build: "vite build" },
      }),
      "package-lock.json": "{}",
    },
    gates: ["lint", "tests"],
    wholeUnit: [],
    manifest: {
      path: "package.json",
      before: JSON.stringify({ name: "fixture", devDependencies: {} }),
      after: JSON.stringify({ name: "fixture", devDependencies: { vitest: "^3.0.0" } }),
      added: "vitest",
    },
    property: {
      path: "src/sum.test.js",
      exhaustive:
        "import { expect, test } from 'vitest';\ntest('sum', () => {\n  for (let a = 0; a < 256; a++) expect(a + 0).toBe(a);\n});\n",
      seeded:
        "import { expect, test } from 'vitest';\nconst seed = 7;\nlet s = seed;\nconst prng = () => (s = (s * 1103515245 + 12345) % 2 ** 31);\ntest('sum', () => {\n  for (let i = 0; i < 50; i++) { const a = prng(), b = prng(); expect(a + b).toBe(b + a); }\n});\n",
      library:
        "const fc = require('fast-check');\ntest('sum', () => { fc.assert(fc.property(fc.nat(), (a) => a + 0 === a)); });\n",
    },
    mutation: {
      tool: "stryker",
      source: "src/sum.js",
      files: { "node_modules/@stryker-mutator/core/bin/stryker.js": "" },
      on: ["node"],
    },
  },
  python: {
    files: {
      "pyproject.toml":
        "[project]\nname = 'fixture'\nversion = '0.1.0'\n\n[tool.ruff]\nline-length = 100\n\n[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
    },
    gates: ["pytest", "ruff"],
    wholeUnit: [],
    manifest: {
      path: "pyproject.toml",
      before: "[project]\nname = 'fixture'\nversion = '0.1.0'\ndependencies = []\n",
      after: "[project]\nname = 'fixture'\nversion = '0.1.0'\ndependencies = ['requests>=2']\n",
      added: "requests",
    },
    property: {
      path: "tests/test_sum.py",
      exhaustive:
        "def test_sum_commutes_for_every_byte():\n    for a in range(256):\n        for b in range(16):\n            assert a + b == b + a\n",
      seeded:
        "import random\n\n\ndef test_sum_commutes():\n    rng = random.Random(42)\n    for _ in range(100):\n        a, b = rng.randint(0, 9), rng.randint(0, 9)\n        assert a + b == b + a\n",
      library:
        "from hypothesis import given, strategies as st\n\n\n@given(st.integers(), st.integers())\ndef test_sum(a, b):\n    assert a + b == b + a\n",
    },
    mutation: { tool: "mutmut", source: "fixture/sum.py", files: {}, on: ["mutmut"] },
  },
  go: {
    files: { "go.mod": "module example.com/fixture\n\ngo 1.22\n" },
    gates: ["gofmt", "go-vet", "go-test"],
    wholeUnit: ["go-vet"],
    manifest: {
      path: "go.mod",
      before: "module example.com/fixture\n\ngo 1.22\n",
      after: "module example.com/fixture\n\ngo 1.22\n\nrequire github.com/google/uuid v1.6.0\n",
      added: "github.com/google/uuid",
    },
    property: {
      path: "sum_test.go",
      exhaustive:
        "package fixture\n\nimport \"testing\"\n\nfunc TestSumForEveryMask(t *testing.T) {\n\tfor mask := 0; mask < 256; mask++ {\n\t\tif mask+0 != mask {\n\t\t\tt.Fatal(mask)\n\t\t}\n\t}\n}\n",
      seeded:
        'package fixture\n\nimport (\n\t"math/rand"\n\t"testing"\n)\n\nfunc TestSum(t *testing.T) {\n\tr := rand.New(rand.NewSource(42))\n\tfor i := 0; i < 100; i++ {\n\t\ta, b := r.Intn(9), r.Intn(9)\n\t\tif a+b != b+a {\n\t\t\tt.Fatal(a, b)\n\t\t}\n\t}\n}\n',
      library:
        'package fixture\n\nimport (\n\t"testing"\n\t"testing/quick"\n)\n\nfunc TestSum(t *testing.T) {\n\tif err := quick.Check(func(a, b int) bool { return a+b == b+a }, nil); err != nil {\n\t\tt.Fatal(err)\n\t}\n}\n',
    },
    mutation: { tool: "go-mutesting", source: "sum.go", files: {}, on: ["go-mutesting"] },
  },
  rust: {
    files: {
      "Cargo.toml": "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    },
    gates: ["cargo-fmt", "cargo-clippy", "cargo-test"],
    wholeUnit: ["cargo-fmt", "cargo-clippy"],
    manifest: {
      path: "Cargo.toml",
      before: '[package]\nname = "fixture"\nversion = "0.1.0"\n\n[dependencies]\n',
      after: '[package]\nname = "fixture"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n',
      added: "serde",
    },
    property: {
      path: "tests/sum.rs",
      exhaustive:
        "#[test]\nfn sum_commutes_for_every_byte() {\n    for a in 0..256u32 {\n        assert_eq!(a + 1, 1 + a);\n    }\n}\n",
      seeded:
        "#[test]\nfn sum_commutes() {\n    let mut x: u64 = 42;\n    for _ in 0..100 {\n        x = x.wrapping_mul(6364136223846793005).wrapping_add(1);\n        let (a, b) = (x % 10, (x >> 8) % 10);\n        assert_eq!(a + b, b + a);\n    }\n}\n",
      library:
        "use proptest::prelude::*;\nproptest! {\n    #[test]\n    fn sum(a in 0u32..10, b in 0u32..10) { prop_assert_eq!(a + b, b + a); }\n}\n",
    },
    mutation: { tool: "cargo-mutants", source: "src/lib.rs", files: {}, on: ["cargo", "cargo-mutants"] },
  },
  maven: {
    files: { "pom.xml": "<project><modelVersion>4.0.0</modelVersion></project>\n" },
    gates: ["maven-verify"],
    wholeUnit: [],
    manifest: {
      path: "pom.xml",
      before: "<project>\n  <dependencies>\n  </dependencies>\n</project>\n",
      after:
        "<project>\n  <dependencies>\n    <dependency>\n      <groupId>com.google.guava</groupId>\n      <artifactId>guava</artifactId>\n      <version>33.0.0-jre</version>\n    </dependency>\n  </dependencies>\n</project>\n",
      added: "com.google.guava:guava",
    },
    property: {
      path: "src/test/java/com/example/SumTest.java",
      exhaustive:
        "package com.example;\n\nimport org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n\nclass SumTest {\n    @Test\n    void commutesForEveryByte() {\n        for (int a = 0; a < 256; a++) {\n            assertEquals(a + 1, 1 + a);\n        }\n    }\n}\n",
      seeded:
        "package com.example;\n\nimport java.util.Random;\nimport org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n\nclass SumTest {\n    @Test\n    void commutes() {\n        Random r = new Random(42);\n        for (int i = 0; i < 100; i++) {\n            int a = r.nextInt(9), b = r.nextInt(9);\n            assertEquals(a + b, b + a);\n        }\n    }\n}\n",
      library:
        "package com.example;\n\nimport net.jqwik.api.*;\n\nclass SumProperties {\n    @Property\n    boolean commutes(@ForAll int a, @ForAll int b) { return a + b == b + a; }\n}\n",
    },
    mutation: {
      tool: "pit",
      source: "src/main/java/com/example/Sum.java",
      files: {
        "pom.xml":
          "<project><build><plugins><plugin><groupId>org.pitest</groupId><artifactId>pitest-maven</artifactId></plugin></plugins></build></project>\n",
      },
      on: ["mvn"],
    },
  },
  dotnet: {
    files: {
      "Fixture.csproj":
        '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n',
    },
    gates: ["dotnet-build", "dotnet-format", "dotnet-test"],
    wholeUnit: [],
    manifest: {
      path: "Fixture.csproj",
      before: '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n  </ItemGroup>\n</Project>\n',
      after:
        '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />\n  </ItemGroup>\n</Project>\n',
      added: "Newtonsoft.Json",
    },
    property: {
      path: "Tests/SumTests.cs",
      exhaustive:
        "using Xunit;\n\npublic class SumTests\n{\n    [Fact]\n    public void CommutesForEveryByte()\n    {\n        for (var a = 0; a < 256; a++)\n        {\n            Assert.Equal(a + 1, 1 + a);\n        }\n    }\n}\n",
      seeded:
        "using Xunit;\n\npublic class SumTests\n{\n    [Fact]\n    public void Commutes()\n    {\n        var r = new System.Random(42);\n        for (var i = 0; i < 100; i++)\n        {\n            int a = r.Next(9), b = r.Next(9);\n            Assert.Equal(a + b, b + a);\n        }\n    }\n}\n",
      library:
        "using FsCheck;\nusing FsCheck.Xunit;\n\npublic class SumProperties\n{\n    [Property]\n    public bool Commutes(int a, int b) => a + b == b + a;\n}\n",
    },
    // No mutation adapter for .NET: the gate runs the built-in engine.
    mutation: null,
  },
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-gate-matrix-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

/** A cell: skipped while `KNOWN` names an open issue for it. */
function cell(stack: Stack, name: string, body: () => void | Promise<void>, timeout?: number) {
  const issue = KNOWN[`${stack}:${name}`];
  if (issue) test.skip(`${name} (known: ${issue})`, body);
  else test(name, body, timeout);
}

// #1749: a Gradle project got no toolchain gate, a Maven project with a wrapper got `mvn` even
// where only the wrapper builds, and an sbt project got nothing.
describe("gate matrix: JVM build tools (#1749)", () => {
  const ids = (files: Record<string, string>) =>
    detectGates(project(files)).map((s) => [s.check.id, s.check.executable, s.check.args.join(" "), s.source]);
  const wrapped = (name: "mvnw" | "gradlew") =>
    process.platform === "win32" ? ["cmd", `/d /c ${name === "mvnw" ? "mvnw.cmd" : "gradlew.bat"} `] : [`./${name}`, ""];
  for (const build of ["build.gradle.kts", "build.gradle", "settings.gradle.kts"])
    cell("maven", `gradle-check from ${build}`, () => {
      expect(ids({ [build]: "plugins { java }\n" })).toEqual([["gradle-check", "gradle", "--console=plain -q check", build]]);
      const [exe, prefix] = wrapped("gradlew");
      const script = process.platform === "win32" ? "gradlew.bat" : "gradlew";
      expect(ids({ [build]: "plugins { java }\n", [script]: "#!/bin/sh\n" })).toEqual([["gradle-check", exe, `${prefix}--console=plain -q check`, build]]);
    });
  cell("maven", "maven-verify runs the project's wrapper", () => {
    const [exe, prefix] = wrapped("mvnw");
    const script = process.platform === "win32" ? "mvnw.cmd" : "mvnw";
    expect(ids({ "pom.xml": "<project/>", [script]: "#!/bin/sh\n" })).toEqual([["maven-verify", exe, `${prefix}-B -q verify`, "pom.xml"]]);
    expect(ids({ "pom.xml": "<project/>" })).toEqual([["maven-verify", "mvn", "-B -q verify", "pom.xml"]]);
  });
  cell("maven", "a Maven build with Gradle files gets the Maven gate once", () => {
    expect(ids({ "pom.xml": "<project/>", "build.gradle": "" }).map(([id]) => id)).toEqual(["maven-verify"]);
  });
  cell("maven", "sbt-test from build.sbt", () => {
    expect(ids({ "build.sbt": 'name := "fixture"\n' })).toEqual([["sbt-test", "sbt", "-batch test", "build.sbt"]]);
  });
  cell("maven", "a Windows wrapper runs through cmd, which the check routing unwraps", () => {
    const root = project({ "gradlew.bat": "@echo off\n", "mvnw.cmd": "@echo off\n" });
    const gradle = buildWrapper(root, "gradlew", "gradle", "win32");
    expect(gradle).toEqual({ executable: "cmd", args: ["/d", "/c", "gradlew.bat"], source: "gradlew.bat" });
    expect(launchedCommand(gradle.executable, [...gradle.args, "check"]).program).toBe("gradlew");
    expect(launchedCommand("cmd", ["/d", "/c", "mvnw.cmd", "verify"]).program).toBe("mvnw");
    expect(buildWrapper(project({}), "gradlew", "gradle", "win32").executable).toBe("gradle");
  });
});
// #1753: a plain SwiftPM, Mix, Dart, Zig, dune or Bundler project has no Makefile, justfile or CI
// run step, so the runner fallback found nothing and no test gate was suggested.
describe("gate matrix: SwiftPM, Mix, Dart, Zig, dune and Bundler (#1753)", () => {
  const ids = (files: Record<string, string>) =>
    detectGates(project(files)).map((s) => [s.check.id, s.check.executable, s.check.args.join(" "), s.source]);
  const checks = (files: Record<string, string>) => detectGates(project(files)).map((s) => s.check);
  test("each manifest gets its toolchain's build, format and test gates", () => {
    expect(ids({ "Package.swift": "// swift-tools-version:5.9\n" })).toEqual([
      ["swift-build", "swift", "build", "Package.swift"],
      ["swift-test", "swift", "test", "Package.swift"],
    ]);
    expect(ids({ "mix.exs": "defmodule Fixture.MixProject do\nend\n", ".formatter.exs": "[inputs: [\"lib/**/*.ex\"]]\n" })).toEqual([
      ["mix-format", "mix", "format --check-formatted", ".formatter.exs"],
      ["mix-compile", "mix", "compile --warnings-as-errors", "mix.exs"],
      ["mix-test", "mix", "test", "mix.exs"],
    ]);
    // mix format stops with an error without a .formatter.exs naming its inputs.
    expect(ids({ "mix.exs": "" }).map(([id]) => id)).toEqual(["mix-compile", "mix-test"]);
    expect(ids({ "pubspec.yaml": "name: fixture\n" })).toEqual([
      ["dart-format", "dart", "format --output=none --set-exit-if-changed .", "pubspec.yaml"],
      ["dart-analyze", "dart", "analyze", "pubspec.yaml"],
      ["dart-test", "dart", "test", "pubspec.yaml"],
    ]);
    expect(ids({ "pubspec.yaml": "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n" }).map(([id, exe]) => `${id} ${exe}`)).toEqual([
      "dart-format dart",
      "flutter-analyze flutter",
      "flutter-test flutter",
    ]);
    expect(ids({ "build.zig": "" })).toEqual([
      ["zig-fmt", "zig", "fmt --check .", "build.zig"],
      ["zig-build-test", "zig", "build test", "build.zig"],
    ]);
    expect(ids({ "dune-project": "(lang dune 3.0)\n" })).toEqual([
      ["dune-build", "dune", "build", "dune-project"],
      ["dune-test", "dune", "test", "dune-project"],
    ]);
  });

  test("a Bundler project runs RSpec when it uses it, else Rake's test task, else nothing", () => {
    expect(ids({ Gemfile: "gem 'rspec', '~> 3'\n" })).toEqual([["rspec", "bundle", "exec rspec", "Gemfile"]]);
    expect(ids({ Gemfile: "gem 'rake'\n", "spec/sum_spec.rb": "" })).toEqual([["rspec", "bundle", "exec rspec", "spec/"]]);
    expect(ids({ Gemfile: "gem 'minitest'\n", Rakefile: "task default: :test\n" })).toEqual([["rake-test", "bundle", "exec rake test", "Rakefile"]]);
    expect(ids({ Gemfile: "gem 'rake'\n" })).toEqual([["rake-test", "bundle", "exec rake test", "Gemfile"]]);
    // A Jekyll site's Gemfile has no tests to run; its Makefile target is still found.
    expect(ids({ Gemfile: "gem 'jekyll'\n" })).toEqual([]);
    expect(ids({ Gemfile: "gem 'jekyll'\n", Makefile: "test:\n\tbundle exec htmlproofer _site\n" })).toEqual([["tests", "make", "test", 'Makefile target "test"']]);
  });

  test("the formatters run per task with their fixer on the task's file; the analyzers wait for integration", () => {
    const all = [
      ...checks({ "mix.exs": "", ".formatter.exs": "[]\n" }),
      ...checks({ "pubspec.yaml": "name: fixture\n" }),
      ...checks({ "build.zig": "" }),
    ];
    const byId = (id: string) => all.find((c) => c.id === id) as Check;
    expect(fixerCommand(byId("mix-format").fix!, "lib/sum.ex")).toEqual({ executable: "mix", args: ["format", "lib/sum.ex"] });
    expect(fixerCommand(byId("dart-format").fix!, "lib/sum.dart")).toEqual({ executable: "dart", args: ["format", "lib/sum.dart"] });
    expect(fixerCommand(byId("zig-fmt").fix!, "src/sum.zig")).toEqual({ executable: "zig", args: ["fmt", "src/sum.zig"] });
    const covering = (path: string) =>
      coveringChecks({ checks: all.map((c) => ({ ...c, scope: "feature" as const })) } as RunPolicy, { writes: [{ path, action: "create" }] }).map((c) => c.id);
    expect(covering("lib/sum.dart")).toEqual(["mix-format", "dart-format", "zig-fmt"]);
    expect(isStaticCheck(byId("dart-analyze")) && isWholeUnitCheck(byId("dart-analyze"))).toBe(true);
    expect(["mix-compile", "mix-test", "dart-test", "zig-build-test"].some((id) => isStaticCheck(byId(id)))).toBe(false);
  });

  test("an empty test run of these runners reads as no tests collected, not as a failing suite", () => {
    expect(noTestsCollected("error: no tests found; create a target in the 'Tests' directory")).toBe(true);
    expect(noTestsCollected("Paths given to `mix test` did not match any directory/file: test")).toBe(true);
    expect(noTestsCollected("There are no tests to run")).toBe(true);
    expect(noTestsCollected('Test directory "test" not found.')).toBe(true);
    expect(noTestsCollected("1 test, 1 failure")).toBe(false);
  });
});

// #1493: a Ruby project got Bundler's test gate (#1753) but no lint gate, no test count, no
// skip markers of RSpec or Minitest and no language review. The outputs below are pasted from
// RSpec 3.13.6, Minitest 5.20, Rake 13.1 and RuboCop 1.92 on Ruby 3.3.
const RSPEC_FAILED = `.F**.

Pending: (Failures listed here are expected and do not affect your suite's status)

  1) Calc is skipped
     # Temporarily skipped with xit
     # ./spec/calc_spec.rb:9

Failures:

  1) Calc fails on purpose
     Failure/Error: expect(Calc.add(1, 2)).to eq(4)

       expected: 4
            got: 3

       (compared using ==)
     # ./spec/calc_spec.rb:7:in \`block (2 levels) in <top (required)>'

Finished in 0.00714 seconds (files took 0.09504 seconds to load)
5 examples, 1 failure, 2 pending

Failed examples:

rspec ./spec/calc_spec.rb:6 # Calc fails on purpose
`;
const MINITEST_FAILED = `Run options: --seed 1809

# Running:

SF.E

Finished in 0.001365s, 2931.0707 runs/s, 1465.5354 assertions/s.

  1) Failure:
CalcTest#test_fail [/repo/test/calc_test.rb:8]:
Expected: 4
  Actual: 3

  2) Error:
CalcTest#test_error:
RuntimeError: boom
    /repo/test/calc_test.rb:14:in \`test_error'

4 runs, 2 assertions, 1 failures, 1 errors, 1 skips

You have skipped tests. Run with --verbose for details.
rake aborted!
Command failed with status (1)
`;
const RSPEC_MISSING = `
An error occurred while loading ./spec/nope_spec.rb. - Did you mean?
                    rspec ./spec/calc_spec.rb

Failure/Error: __send__(method, file)

LoadError:
  cannot load such file -- /repo/spec/nope_spec.rb
# /gems/rspec-core-3.13.6/lib/rspec/core/configuration.rb:2144:in \`load'
No examples found.


Finished in 0.00004 seconds (files took 0.1556 seconds to load)
0 examples, 0 failures, 1 error occurred outside of examples
`;
describe("gate matrix: Bundler lint, RSpec and Minitest (#1493)", () => {
  const ids = (files: Record<string, string>) =>
    detectGates(project(files)).map((s) => [s.check.id, s.check.executable, s.check.args.join(" "), s.source]);
  test("Standard or RuboCop lints before the tests, from the Gemfile or the gemspec it names", () => {
    expect(ids({ Gemfile: "gem 'rubocop', require: false\ngem 'rspec'\n" })).toEqual([
      ["rubocop", "bundle", "exec rubocop", "Gemfile"],
      ["rspec", "bundle", "exec rspec", "Gemfile"],
    ]);
    expect(ids({ Gemfile: "group :development do\n  gem \"rubocop-rails\"\n  gem \"standard\"\nend\n", Rakefile: "" }).map(([id]) => id)).toEqual(["standardrb", "rake-test"]);
    const gem = { Gemfile: "source 'https://rubygems.org'\ngemspec\n", "calc.gemspec": 'Gem::Specification.new do |spec|\n  spec.add_development_dependency "rubocop", "~> 1.60"\n  spec.add_development_dependency("rspec", "~> 3.13")\nend\n' };
    expect(ids(gem)).toEqual([
      ["rubocop", "bundle", "exec rubocop", "calc.gemspec"],
      ["rspec", "bundle", "exec rspec", "calc.gemspec"],
    ]);
    // A gemspec the Gemfile does not load is not the bundle.
    expect(ids({ Gemfile: "gem 'rake'\n", "calc.gemspec": 'spec.add_development_dependency "rubocop"\n' }).map(([id]) => id)).toEqual(["rake-test"]);
  });

  test("the linter runs per task with its safe autocorrect on the task's file; `bundle exec` is unwrapped", () => {
    const [lint] = detectGates(project({ Gemfile: "gem 'rubocop'\n" })).map((s) => s.check);
    expect(isStaticCheck(lint!) && !isWholeUnitCheck(lint!)).toBe(true);
    expect(fixerCommand(lint!.fix!, "lib/calc.rb")).toEqual({ executable: "bundle", args: ["exec", "rubocop", "-a", "lib/calc.rb"] });
    const [standard] = detectGates(project({ Gemfile: "gem 'standard'\n" })).map((s) => s.check);
    expect(fixerCommand(standard!.fix!, "lib/calc.rb")).toEqual({ executable: "bundle", args: ["exec", "standardrb", "--fix", "lib/calc.rb"] });
    expect(launchedCommand("cmd", ["/d", "/c", "bundle.bat", "exec", "rspec"]).program).toBe("bundle");
  });

  test("RSpec and Minitest counts, the tests that ran, the failed tests and a stable signature", () => {
    expect(testCount(RSPEC_FAILED)).toEqual({ tool: "rspec", count: 5 });
    expect(testsRan(RSPEC_FAILED)).toEqual({ tool: "rspec", count: 3 });
    expect(failedTests(RSPEC_FAILED)).toEqual({ tool: "rspec", names: ["Calc fails on purpose"] });
    expect(testCount(MINITEST_FAILED)).toEqual({ tool: "minitest", count: 4 });
    expect(testsRan(MINITEST_FAILED)).toEqual({ tool: "minitest", count: 3 });
    expect(failedTests(MINITEST_FAILED)).toEqual({ tool: "minitest", names: ["CalcTest#test_fail", "CalcTest#test_error"] });
    // Another seed, another order, a test more that passes and other timings: the same failure.
    const later = MINITEST_FAILED.replace("--seed 1809", "--seed 52011").replace("SF.E", "S.F.E").replace("0.001365s, 2931.0707 runs/s, 1465.5354", "0.002001s, 2498.7 runs/s, 1499.2")
      .replace("4 runs, 2 assertions", "5 runs, 3 assertions");
    expect(failureSignature(later, "/repo")).toBe(failureSignature(MINITEST_FAILED, "/repo"));
    const rspecLater = RSPEC_FAILED.replace(".F**.", ".F**..").replace("0.00714", "0.00911").replace("0.09504", "0.1").replace("5 examples", "6 examples");
    expect(failureSignature(rspecLater, "/repo")).toBe(failureSignature(RSPEC_FAILED, "/repo"));
    expect(failureSignature(RSPEC_FAILED.replace("1 failure,", "2 failures,"), "/repo")).not.toBe(failureSignature(RSPEC_FAILED, "/repo"));
    expect(timedOutFailure(RSPEC_FAILED) && timedOutFailure(MINITEST_FAILED)).toBe(true);
  });

  test("a spec file that does not load is a build failure, and RSpec ran none", () => {
    expect(buildRunner(RSPEC_MISSING)).toBe("rspec");
    expect(testsRan(RSPEC_MISSING)).toEqual({ tool: "rspec", count: 0 });
  });

  test("an empty run reads as no tests collected; a missing path is the task's that creates it", () => {
    expect(noTestsCollected("No examples found.\n\n\nFinished in 0.00023 seconds (files took 0.04904 seconds to load)\n0 examples, 0 failures\n")).toBe(true);
    expect(noTestsCollected("Run options: include {:slow=>true}\n\nAll examples were filtered out\n")).toBe(true);
    expect(noTestsCollected("Finished in 0.000711s, 0.0000 runs/s, 0.0000 assertions/s.\n\n0 runs, 0 assertions, 0 failures, 0 errors, 0 skips\n")).toBe(true);
    expect(noTestsCollected("1 runs, 1 assertions, 0 failures, 0 errors, 0 skips")).toBe(false);
    const tasks = [{ id: "T002", writes: [{ path: "spec/nope_spec.rb", action: "create" }, { path: "test/nope_test.rb", action: "create" }, { path: "lib/nope.rb", action: "create" }] }] as Task[];
    expect(missingPlannedPaths(RSPEC_MISSING, tasks)).toEqual(["spec/nope_spec.rb"]);
    expect(missingPlannedPaths("ruby: No such file or directory -- test/nope_test.rb (LoadError)", tasks)).toEqual(["test/nope_test.rb"]);
    expect(missingPlannedPaths("\nFile does not exist: /repo/test/nope_test.rb\n\nrake aborted!", tasks)).toEqual(["test/nope_test.rb"]);
    expect(missingPlannedPaths("Error: No such file or directory: /repo/lib/nope.rb\nInspecting 1 file\n", tasks)).toEqual(["lib/nope.rb"]);
    // A `require` inside a spec file that loads is the spec's own failure.
    const required = "\nAn error occurred while loading ./spec/nope_spec.rb.\n\nFailure/Error: require_relative \"../lib/missing\"\n\nLoadError:\n  cannot load such file -- /repo/lib/missing\n";
    expect(missingPlannedPaths(required, tasks)).toEqual([]);
  });

  test("the affected tests run through RSpec's file arguments and Rake's TEST", () => {
    const check = (id: string, args: string[]): Check => ({ id, executable: "bundle", args, cwd: ".", timeoutMs: 600000, required: true, scope: "feature", envNames: [], writes: [] });
    expect(affectedTestCheck([check("rspec", ["exec", "rspec", "--format", "progress"])], ["spec/calc_spec.rb", "lib/calc.rb"])?.args).toEqual(["exec", "rspec", "--format", "progress", "./spec/calc_spec.rb"]);
    expect(affectedTestCheck([check("rake-test", ["exec", "rake", "test"])], ["test/calc_test.rb"])?.args).toEqual(["exec", "rake", "test", "TEST=test/calc_test.rb"]);
    expect(affectedTestCheck([check("rake-test", ["exec", "rake", "test"])], ["test/a_test.rb", "test/test_helper.rb", "test/test_b.rb"])?.args).toEqual(["exec", "rake", "test", "TEST={test/a_test.rb,test/test_b.rb}"]);
  });

  test("a new Ruby file is held to RuboCop's layout cops when the run leaves the gate out (#1837)", () => {
    const root = project({ Gemfile: "gem 'rubocop'\n", "lib/calc.rb": "def add(a, b) = a + b\n" });
    expect(formatWrittenChecks(root, [], [{ path: "lib/calc.rb", action: "create" }], (c) => `/usr/bin/${c}`).map((c) => [c.id, [c.executable, ...c.args].join(" "), [c.fix!.executable, ...c.fix!.args].join(" ")])).toEqual([
      ["rubocop-written", "bundle exec rubocop --only Layout lib/calc.rb", "bundle exec rubocop -a --only Layout"],
    ]);
  });

  test("RSpec and Minitest skips, focus and RuboCop suppressions are found; capability guards are not", () => {
    const before = 'RSpec.describe Calc do\n  it "adds" do\n    expect(Calc.add(1, 2)).to eq(3)\n  end\nend\n';
    const rules = (path: string, from: string, to: string) => scanTestIntegrity([{ path, before: from, after: to }]).map((f) => `${f.rule}: ${f.detail}`);
    expect(rules("spec/calc_spec.rb", before, before.replace('  it "adds"', '  xit "adds"'))).toEqual(["skip: added 1 skip, only, todo or ignore marker(s)"]);
    expect(rules("spec/calc_spec.rb", before, before.replace('it "adds" do', 'it "adds", skip: "later" do'))).toEqual(["skip: added 1 skip, only, todo or ignore marker(s)"]);
    expect(rules("spec/calc_spec.rb", before, before.replace("  it ", "  fit "))).toEqual(["skip: added 1 skip, only, todo or ignore marker(s)"]);
    expect(rules("spec/calc_spec.rb", before, before.replace("    expect", '    pending "rounding"\n    expect'))).toEqual(["skip: added 1 skip, only, todo or ignore marker(s)"]);
    expect(rules("spec/calc_spec.rb", before, before.replace("    expect", '    skip "no symlinks" if Gem.win_platform?\n    expect'))).toEqual([]);
    const mini = "class CalcTest < Minitest::Test\n  def test_add\n    assert_equal 3, Calc.add(1, 2)\n  end\nend\n";
    expect(rules("test/calc_test.rb", mini, mini.replace("    assert_equal", "    skip\n    assert_equal"))).toEqual(["skip: added 1 skip, only, todo or ignore marker(s)"]);
    expect(rules("test/calc_test.rb", mini, mini.replace("    assert_equal 3, Calc.add(1, 2)", "    skip = 3\n    assert_equal skip, Calc.add(1, 2)"))).toEqual([]);
    expect(rules("lib/calc.rb", "def add(a, b) = a + b\n", "def add(a, b) = a + b # rubocop:disable Style/EndlessMethod\n").map((r) => r.split(":")[0])).toEqual(["suppression"]);
    expect(rules("spec/calc_spec.rb", before, before.replace('  it "adds" do\n    expect(Calc.add(1, 2)).to eq(3)\n  end\n', ""))[0]).toStartWith("test-count");
  });

  test("Minitest and RSpec tests are named, and their assertions counted", () => {
    const before = 'RSpec.describe Calc do\n  it "adds" do\n    expect(Calc.add(1, 2)).to eq(3)\n  end\n  it("subtracts") { expect(Calc.sub(2, 1)).to eq(1) }\nend\n';
    const removed = scanTestIntegrity([{ path: "spec/calc_spec.rb", before, after: before.replace('  it("subtracts") { expect(Calc.sub(2, 1)).to eq(1) }\n', "") }]);
    expect(removed.map((f) => `${f.rule}: ${f.detail}`)).toEqual([
      'test-count: test count dropped from 2 to 1 (removed "subtracts")',
      "assertions: assertions dropped from 2 to 1 (removed or commented out)",
    ]);
    const mini = "class CalcTest < Minitest::Test\n  def test_add\n    assert_equal 3, Calc.add(1, 2)\n    refute_nil Calc\n  end\nend\n";
    const weaker = scanTestIntegrity([{ path: "test/calc_test.rb", before: mini, after: mini.replace("    refute_nil Calc\n", "") }]);
    expect(weaker.map((f) => f.rule)).toEqual(["assertions"]);
  });

  test("the agent profile tests a gem with rake, an RSpec project with rspec and only a Rails app with rails", async () => {
    expect((await detectProfile(project({ Gemfile: "gemspec\n", Rakefile: "" }))).test).toBe("bundle exec rake test");
    expect((await detectProfile(project({ Gemfile: "", "spec/a_spec.rb": "" }))).test).toBe("bundle exec rspec");
    expect((await detectProfile(project({ Gemfile: "gem 'rails'\n", Rakefile: "", "bin/rails": "" }))).test).toBe("bundle exec rails test");
  });

  test("a swallowed rescue is a quality finding; a handled one is not", () => {
    const found = (content: string) => checkBuiltinRules([{ path: "lib/load.rb", content, before: null }], {}).map((f) => `${f.rule}:${f.line}`);
    expect(found("def load(path)\n  File.read(path)\nrescue Errno::ENOENT\nend\n")).toEqual(["ruby-swallowed-exception:3"]);
    expect(found("def load(path)\n  File.read(path)\nrescue => e\n  nil\nend\n")).toEqual(["ruby-swallowed-exception:3"]);
    expect(found("value = Integer(text) rescue nil\n")).toEqual(["ruby-swallowed-exception:1"]);
    expect(found("def load(path)\n  File.read(path)\nrescue Errno::ENOENT => e\n  raise LoadFailed, e.message\nend\n")).toEqual([]);
    // Ruby's abstract method idiom is not a placeholder (#1679).
    expect(found("def area\n  raise NotImplementedError\nend\n")).toEqual([]);
  });
});

// #1494: a Dart package got its format, analyze and test gates (#1753) but no test count, no
// format-written check, no skip markers and no language review. The outputs below are pasted from
// Dart SDK 3.13.7 with package:test 1.26 (`dart test`, `dart analyze`, `dart format`).
const DART_FAILED = `00:00 +0: loading test/calc_test.dart
00:00 +0: test/calc_test.dart: adds
00:00 +1: test/calc_test.dart: fails on purpose
00:00 +1 -1: test/calc_test.dart: fails on purpose [E]
  Expected: <4>
    Actual: <3>
  
  package:matcher           expect
  test/calc_test.dart 6:34  main.<fn>
  
00:00 +1 -1: test/calc_test.dart: later
  Skip: not yet
00:00 +1 ~1 -1: test/calc_test.dart: nested works
00:00 +2 ~1 -1: Some tests failed.

Failing tests:
  test/calc_test.dart: fails on purpose

Consider enabling the flag chain-stack-traces to receive more detailed exceptions.
For example, 'dart test --chain-stack-traces'.
`;
const DART_BROKEN = `00:00 +0: loading test/broken_test.dart
00:00 +0 -1: loading test/broken_test.dart [E]
  Failed to load "test/broken_test.dart":
  test/broken_test.dart:3:26: Error: Undefined name 'undefinedThing'.
    test('x', () => expect(undefinedThing, 1));
                           ^^^^^^^^^^^^^^
00:00 +0 -1: test/calc_test.dart: adds
00:00 +1 -1: test/calc_test.dart: fails on purpose
00:00 +1 -2: test/calc_test.dart: fails on purpose [E]
  Expected: <4>
    Actual: <3>
  
  package:matcher           expect
  test/calc_test.dart 6:34  main.<fn>
  
00:00 +1 -2: test/calc_test.dart: later
  Skip: not yet
00:00 +1 ~1 -2: test/calc_test.dart: nested works
00:00 +2 ~1 -2: Some tests failed.

Failing tests:
  test/broken_test.dart: loading test/broken_test.dart
  test/calc_test.dart: fails on purpose
`;
const DART_MISSING = `00:00 +0: loading test/nope_test.dart
00:00 +0 -1: loading test/nope_test.dart [E]
  Failed to load "test/nope_test.dart": Does not exist.
00:00 +0 -1: Some tests failed.

Failing tests:
  test/nope_test.dart: loading test/nope_test.dart
`;
const DART_ANALYZE = `Analyzing calc...

  error - lib/bad.dart:3:14 - A value of type 'int' can't be assigned to a variable of type 'String'. Try changing the type of the variable, or casting the right-hand type to 'String'. - invalid_assignment
warning - lib/bad.dart:2:7 - The value of the local variable 'unused' isn't used. Try removing the variable or using it. - unused_local_variable
   info - lib/bad.dart:5:3 - Don't invoke 'print' in production code. Try using a logging framework. - avoid_print

3 issues found.
`;
describe("gate matrix: dart test, dart analyze and dart format (#1494)", () => {
  test("dart test counts, the tests that ran, the failed tests and a stable signature", () => {
    expect([testCount(DART_FAILED), testsRan(DART_FAILED), failedTests(DART_FAILED)]).toEqual([
      { tool: "dart", count: 4 }, { tool: "dart", count: 3 }, { tool: "dart", names: ["test/calc_test.dart: fails on purpose"] },
    ]);
    expect(testCount("00:00 +0: loading test/calc_test.dart\n00:00 +0: test/calc_test.dart: adds\n00:00 +1: All tests passed!\n")).toEqual({ tool: "dart", count: 1 });
    // A test file that does not load counts as a failure in dart test's summary, and is no test.
    expect([testCount(DART_BROKEN), testsRan(DART_BROKEN), failedTests(DART_BROKEN)]).toEqual([
      { tool: "dart", count: 4 }, { tool: "dart", count: 3 }, { tool: "dart", names: ["test/calc_test.dart: fails on purpose"] },
    ]);
    // A passing test more and other timings: the same failure. A second failure is not.
    const later = DART_FAILED.replace("00:00 +1 ~1 -1: test/calc_test.dart: nested works\n00:00 +2 ~1 -1: Some", "00:00 +1 ~1 -1: test/calc_test.dart: nested works\n00:01 +2 ~1 -1: test/calc_test.dart: nested more\n00:01 +3 ~1 -1: Some");
    expect(testCount(later)).toEqual({ tool: "dart", count: 5 });
    expect(failureSignature(later, "/repo")).toBe(failureSignature(DART_FAILED, "/repo"));
    expect(failureSignature(DART_BROKEN, "/repo")).not.toBe(failureSignature(DART_FAILED, "/repo"));
    expect(timedOutFailure(DART_FAILED)).toBe(true);
  });

  test("a test file that does not load is a build failure; an empty run reads as no tests collected", () => {
    expect(buildRunner(DART_BROKEN)).toBe("dart");
    expect(buildRunner(DART_FAILED)).toBeNull();
    expect(REPLAY_TARGETS.dart).toEqual({ none: "dart test loads and runs each test file on its own" });
    expect(noTestsCollected('00:00 +0: loading test/calc_test.dart\nNo tests ran.\nNo tests match regular expression "zzz".\n')).toBe(true);
    expect(noTestsCollected('No test files were passed and the default "test/" directory doesn\'t exist.\n\nUsage: dart test [files or directories...]\n')).toBe(true);
    expect(noTestsCollected(DART_FAILED)).toBe(false);
  });

  test("a missing path of dart test, dart analyze or dart format is the task's that creates it", () => {
    const tasks = [{ id: "T002", writes: [{ path: "test/nope_test.dart", action: "create" }, { path: "lib/src", action: "create" }] }] as Task[];
    expect(missingPlannedPaths(DART_MISSING, tasks)).toEqual(["test/nope_test.dart"]);
    expect(missingPlannedPaths("Directory or file doesn't exist: lib/src\n\nUsage: dart analyze [arguments] [<directory>]\n", tasks)).toEqual(["lib/src"]);
    // dart format exits 0 on a missing path.
    expect(missingPlannedPaths('No file or directory found at "lib/src".\nFormatted 1 file (0 changed) in 0.00 seconds.\n', tasks)).toEqual(["lib/src"]);
  });

  test("dart analyze counts errors and warnings; infos are lints it exits 0 on", () => {
    expect(diagnosticCount(DART_ANALYZE)).toEqual({ tool: "dart", count: 2, errors: 1 });
    expect(diagnosticCount("Analyzing calc...\nNo issues found!\n")).toEqual({ tool: "dart", count: 0, errors: 0 });
    expect(failureSignature("Changed lib/ugly.dart\nFormatted 3 files (1 changed) in 0.01 seconds.\n", "/repo")).toBe(failureSignature("Changed lib/ugly.dart\nFormatted 4 files (1 changed) in 0.00 seconds.\n", "/repo"));
  });

  test("the affected tests run through dart test's file arguments", () => {
    const check = (executable: string, args: string[]): Check => ({ id: `${executable}-test`, executable, args, cwd: ".", timeoutMs: 600000, required: true, scope: "feature", envNames: [], writes: [] });
    expect(affectedTestCheck([check("dart", ["test", "-r", "expanded", "test/"])], ["test/calc_test.dart", "lib/calc.dart"])?.args).toEqual(["test", "-r", "expanded", "./test/calc_test.dart"]);
    expect(affectedTestCheck([check("flutter", ["test"])], ["test/widget_test.dart"])?.args).toEqual(["test", "./test/widget_test.dart"]);
    expect(isStaticCheck(check("dart", ["test", "--reporter", "expanded"]))).toBe(false);
  });

  test("a new Dart file is held to dart format when the run leaves the gate out (#1837)", () => {
    const root = project({ "pubspec.yaml": "name: calc\n", "lib/calc.dart": "int add(int a, int b) => a + b;\n" });
    expect(formatWrittenChecks(root, [], [{ path: "lib/calc.dart", action: "create" }], (c) => `/usr/bin/${c}`).map((c) => [c.id, [c.executable, ...c.args].join(" "), [c.fix!.executable, ...c.fix!.args].join(" ")])).toEqual([
      ["dart-format-written", "dart format --output=none --set-exit-if-changed lib/calc.dart", "dart format"],
    ]);
  });

  test("package:test skips, solo and analyzer ignores are found; platform guards are not", () => {
    const before = "import 'package:test/test.dart';\n\nvoid main() {\n  test('adds', () {\n    expect(add(1, 2), 3);\n  });\n}\n";
    const rules = (path: string, from: string, to: string) => scanTestIntegrity([{ path, before: from, after: to }]).map((f) => `${f.rule}: ${f.detail}`);
    const skip = ["skip: added 1 skip, only, todo or ignore marker(s)"];
    expect(rules("test/calc_test.dart", before, before.replace("  });\n}", "  }, skip: 'later');\n}"))).toEqual(skip);
    expect(rules("test/calc_test.dart", before, before.replace("  });\n}", "  }, skip: false);\n}"))).toEqual([]);
    expect(rules("test/calc_test.dart", before, before.replace("  });\n}", "  }, solo: true);\n}"))).toEqual(skip);
    expect(rules("test/calc_test.dart", before, `@Skip('flaky')\n${before}`)).toEqual(skip);
    expect(rules("test/calc_test.dart", before, before.replace("  });\n}", "  }, skip: Platform.isWindows ? 'no symlinks' : null);\n}"))).toEqual([]);
    expect(rules("lib/calc.dart", "int add(int a, int b) => a + b;\n", "// ignore: avoid_print\nint add(int a, int b) => a + b;\n").map((r) => r.split(":")[0])).toEqual(["suppression"]);
    const two = before.replace("  });\n}", "  });\n  testWidgets('renders', (tester) async {\n    await expectLater(find.text('1'), findsOneWidget);\n  });\n}");
    expect(scanTestIntegrity([{ path: "test/calc_test.dart", before: two, after: before }]).map((f) => `${f.rule}: ${f.detail}`)).toEqual([
      'test-count: test count dropped from 2 to 1 (removed "renders")',
      "assertions: assertions dropped from 2 to 1 (removed or commented out)",
    ]);
  });

  test("the agent profile tests a Dart package with dart test and only a Flutter package with flutter", async () => {
    expect((await detectProfile(project({ "pubspec.yaml": "name: calc\ndev_dependencies:\n  test: ^1.25.0\n" }))).test).toBe("dart test");
    expect((await detectProfile(project({ "pubspec.yaml": "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n" }))).test).toBe("flutter test");
  });
});

// #1496: an sbt build got its test gate but no test count, no scalafmt gate, no skip markers of
// ScalaTest or munit and no language review. The outputs below are pasted from sbt 1.10.11 on
// Scala 3.6.4 with munit 1.1.0, ScalaTest 3.2.19 and sbt-scalafmt 2.5.4; munit colours its lines
// without a terminal too.
const E = "\u001b";
const MUNIT_FAILED = `[info] compiling 1 Scala source to /w/target/scala-3.6.4/test-classes ...
[info] done compiling
${E}[32mCalcSuite:${E}[0m
${E}[32m  + ${E}[0m${E}[32madds${E}[0m ${E}[90m0.011s${E}[0m
${E}[91m==> X ${E}[0m${E}[91mCalcSuite${E}[0m.${E}[91mfails on purpose${E}[0m  ${E}[90m0.038s${E}[0m munit.ComparisonFailException: src/test/scala/CalcSuite.scala:3
2:  test("adds") { assertEquals(Calc.add(1, 2), 3) }
${E}[7m3:  test("fails on purpose") { assertEquals(Calc.add(1, 2), 4) }${E}[0m
values are not the same
${E}[33m==> i ${E}[0m${E}[33mCalcSuite${E}[0m.${E}[33mlater${E}[0m${E}[33m ignored${E}[0m ${E}[90m0.0s${E}[0m
[error] Failed: Total 2, Failed 1, Errors 0, Passed 1, Ignored 1
[error] Failed tests:
[error] \tCalcSuite
[error] (Test / test) sbt.TestsFailedException: Tests unsuccessful
[error] Total time: 16 s, completed Oct 25, 2026, 2:40:35 AM
`;
const SCALATEST_FAILED = `[info] CalcFlatSpec:
[info] Calc
[info] - should add
[info] - should fail too *** FAILED ***
[info]   2 was not equal to 3 (CalcSpec.scala:13)
[info] CalcSpec:
[info] - adds
[info] - fails on purpose *** FAILED ***
[info]   3 did not equal 4 (CalcSpec.scala:7)
[info] - later !!! IGNORED !!!
[info] - pending one (pending)
[info] Run completed in 387 milliseconds.
[info] Total number of tests run: 4
[info] Suites: completed 2, aborted 0
[info] Tests: succeeded 2, failed 2, canceled 0, ignored 1, pending 1
[info] *** 2 TESTS FAILED ***
[error] Failed tests:
[error] \tCalcSpec
[error] \tCalcFlatSpec
[error] (Test / test) sbt.TestsFailedException: Tests unsuccessful
[error] Total time: 12 s, completed Oct 25, 2026, 2:43:17 AM
`;
const SBT_MULTI = `[info] compiling 1 Scala source to /w/b/target/scala-3.6.4/test-classes ...
[info] compiling 1 Scala source to /w/a/target/scala-3.6.4/test-classes ...
[error] -- [E006] Not Found Error: /w/b/src/test/scala/BSuite.scala:2:31 ---------------
[error] 2 |  test("three") { assertEquals(undefinedThing, 3) }
[error]   |                               ^^^^^^^^^^^^^^
[error]   |                               Not found: undefinedThing
[error] one error found
[info] done compiling
ASuite:
  + one 0.01s
==> X ASuite.two  0.037s munit.ComparisonFailException: a/src/test/scala/ASuite.scala:3
[error] Failed: Total 2, Failed 1, Errors 0, Passed 1
[error] Failed tests:
[error] \tASuite
[error] (a / Test / test) sbt.TestsFailedException: Tests unsuccessful
[error] (b / Test / compileIncremental) Compilation failed
[error] Total time: 7 s, completed Oct 25, 2026, 2:44:20 AM
`;
describe("gate matrix: sbt, munit, ScalaTest and scalafmt (#1496)", () => {
  test("sbt and ScalaTest counts, the tests that ran, the failed tests and a stable signature", () => {
    expect([testCount(MUNIT_FAILED), testsRan(MUNIT_FAILED), failedTests(MUNIT_FAILED)]).toEqual([
      { tool: "sbt", count: 3 }, { tool: "sbt", count: 2 }, { tool: "sbt", names: ["CalcSuite.fails on purpose"] },
    ]);
    // ScalaTest alone prints its own totals and no sbt line.
    expect([testCount(SCALATEST_FAILED), testsRan(SCALATEST_FAILED), failedTests(SCALATEST_FAILED)]).toEqual([
      { tool: "sbt", count: 6 }, { tool: "sbt", count: 4 }, { tool: "sbt", names: ["CalcFlatSpec: should fail too", "CalcSpec: fails on purpose"] },
    ]);
    // With munit beside it, sbt's line counts both frameworks.
    const mixed = "[info] Tests: succeeded 4, failed 0, canceled 0, ignored 1, pending 1\n[info] All tests passed.\n[info] Passed: Total 5, Failed 0, Errors 0, Passed 5, Ignored 1, Pending 1\n";
    expect([testCount(mixed), testsRan(mixed)]).toEqual([{ tool: "sbt", count: 7 }, { tool: "sbt", count: 5 }]);
    // One summary per project that ran tests.
    expect(testCount("[info] Passed: Total 2, Failed 0, Errors 0, Passed 2\n[info] Passed: Total 3, Failed 0, Errors 0, Passed 3\n")).toEqual({ tool: "sbt", count: 5 });
    // A passing test more, other timings and another date: the same failure. A second failure is not.
    const later = MUNIT_FAILED.replace(`${E}[90m0.011s${E}[0m\n`, `${E}[90m0.02s${E}[0m\n${E}[32m  + ${E}[0m${E}[32msubtracts${E}[0m ${E}[90m0.001s${E}[0m\n`)
      .replace("Total 2, Failed 1, Errors 0, Passed 1", "Total 3, Failed 1, Errors 0, Passed 2").replace("16 s, completed Oct 25, 2026, 2:40:35 AM", "9 s, completed Oct 26, 2026, 11:02:01 PM");
    expect(failureSignature(later, "/w")).toBe(failureSignature(MUNIT_FAILED, "/w"));
    const scalatestLater = SCALATEST_FAILED.replace("[info] - adds\n", "[info] - adds\n[info] - subtracts\n").replace("387 milliseconds", "401 milliseconds")
      .replace("tests run: 4", "tests run: 5").replace("succeeded 2, failed 2, canceled 0, ignored 1, pending 1", "succeeded 3, failed 2, canceled 0, ignored 1, pending 1");
    expect(failureSignature(scalatestLater, "/w")).toBe(failureSignature(SCALATEST_FAILED, "/w"));
    expect(failureSignature(SCALATEST_FAILED.replace("[info] - adds\n", "[info] - adds *** FAILED ***\n"), "/w")).not.toBe(failureSignature(SCALATEST_FAILED, "/w"));
    expect(timedOutFailure(MUNIT_FAILED) && timedOutFailure(SCALATEST_FAILED)).toBe(true);
  });

  test("a project whose tests do not compile is a build failure; an empty run reads as no tests collected", () => {
    expect(buildRunner(SBT_MULTI)).toBe("sbt");
    expect(buildRunner(MUNIT_FAILED)).toBeNull();
    expect(buildRunner("[error] /w/src/test/scala/A.scala:2:31: not found: value x\n[error] one error found\n")).toBe("sbt");
    expect(testCount(SBT_MULTI)).toEqual({ tool: "sbt", count: 2 });
    expect(noTestsCollected("[info] Passed: Total 0, Failed 0, Errors 0, Passed 0\n[info] No tests to run for Test / testOnly\n")).toBe(true);
  });

  test("scalafmt formats before the tests when the build has the plugin, and its fixer takes the task's file", () => {
    const files = { "build.sbt": 'scalaVersion := "3.6.4"\n', "project/plugins.sbt": 'addSbtPlugin("org.scalameta" % "sbt-scalafmt" % "2.5.4")\n', ".scalafmt.conf": 'version = "3.9.4"\n' };
    const checks = detectGates(project(files)).map((s) => s.check);
    expect(checks.map((c) => [c.id, [c.executable, ...c.args].join(" ")])).toEqual([["scalafmt", "sbt -batch scalafmtCheckAll"], ["sbt-test", "sbt -batch test"]]);
    expect(isStaticCheck(checks[0]!) && !isStaticCheck(checks[1]!)).toBe(true);
    expect(fixerCommand(checks[0]!.fix!, "src/main/scala/Calc.scala")).toEqual({ executable: "sbt", args: ["-batch", "scalafmtOnly src/main/scala/Calc.scala"] });
    // A .scalafmt.conf without the plugin, or the plugin without a config, formats nothing.
    expect(detectGates(project({ ...files, "project/plugins.sbt": "" })).map((s) => s.check.id)).toEqual(["sbt-test"]);
    const scalafmt = "[info] scalafmt: Checking 2 Scala sources (/w)...\n[warn] scalafmt: /w/src/main/scala/Ugly.scala isn't formatted properly!\n[error] scalafmt: 1 files must be formatted (/w)\n";
    expect(failureSignature(scalafmt, "/w")).toBe(failureSignature(scalafmt.replace("Checking 2", "Checking 3"), "/w"));
  });

  test("the affected tests run through testOnly, by the test files' class names", () => {
    const check: Check = { id: "sbt-test", executable: "sbt", args: ["-batch", "test"], cwd: ".", timeoutMs: 1200000, required: true, scope: "feature", envNames: [], writes: [] };
    expect(affectedTestCheck([check], ["src/test/scala/app/CalcSuite.scala", "core/src/test/scala/ParseSpec.scala"])?.args).toEqual(["-batch", "testOnly *CalcSuite *ParseSpec"]);
  });

  test("ScalaTest and munit skips, focus and Scala suppressions are found; platform guards are not", () => {
    const before = 'class CalcSuite extends munit.FunSuite:\n  test("adds") {\n    assertEquals(Calc.add(1, 2), 3)\n  }\n';
    const rules = (path: string, from: string, to: string) => scanTestIntegrity([{ path, before: from, after: to }]).map((f) => `${f.rule}: ${f.detail}`);
    const skip = ["skip: added 1 skip, only, todo or ignore marker(s)"];
    const path = "src/test/scala/CalcSuite.scala";
    expect(rules(path, before, before.replace('test("adds")', 'test("adds".ignore)'))).toEqual(skip);
    expect(rules(path, before, before.replace('test("adds")', 'test("adds".only)'))).toEqual(skip);
    expect(rules(path, before, before.replace('  test("adds")', '  ignore("adds")'))).toEqual(skip);
    expect(rules(path, before, before.replace("    assertEquals", "    pending\n    assertEquals"))).toEqual(skip);
    expect(rules(path, before, before.replace("    assertEquals", '    assume(!scala.util.Properties.isWin, "no symlinks")\n    assertEquals'))).toEqual([]);
    const flat = 'class CalcSpec extends AnyFlatSpec:\n  "Calc" should "add" in {\n    Calc.add(1, 1) shouldBe 2\n  }\n';
    expect(rules("src/test/scala/CalcSpec.scala", flat, flat.replace('"Calc" should "add" in', '"Calc" should "add" ignore'))).toEqual(skip);
    expect(rules("src/main/scala/Calc.scala", "object Calc\n", "@nowarn(\"msg=unused\")\nobject Calc\n").map((r) => r.split(":")[0])).toEqual(["suppression"]);
    const two = flat.replace("  }\n", '  }\n  it should "subtract" in {\n    Calc.sub(2, 1) shouldBe 1\n  }\n');
    expect(scanTestIntegrity([{ path: "src/test/scala/CalcSpec.scala", before: two, after: flat }]).map((f) => `${f.rule}: ${f.detail}`)).toEqual([
      'test-count: test count dropped from 2 to 1 (removed "subtract")',
      "assertions: assertions dropped from 2 to 1 (removed or commented out)",
    ]);
  });

  test("the agent profile runs sbt in batch mode and scalafmt through its plugin", async () => {
    const profile = await detectProfile(project({ "build.sbt": "", ".scalafmt.conf": "", "project/plugins.sbt": 'addSbtPlugin("org.scalameta" % "sbt-scalafmt" % "2.5.4")\n' }));
    expect([profile.test, profile.lint, profile.format]).toEqual(["sbt -batch test", "sbt -batch scalafmtCheckAll", "sbt -batch scalafmtAll"]);
  });
});

/**
 * Manifests and tool configs of each stack a request may name (#1710), with the content a
 * host-written task writes and whether the approval takes the write without a person. A lock that
 * records the project's own version is exempt and bounded by the field check (#1934).
 */
const PROPS = "<Project>\n  <PropertyGroup>\n    <Version>0.1.0</Version>\n    <Authors>dieodds</Authors>\n  </PropertyGroup>\n</Project>\n";
const NAMED_CONFIGS: Record<Stack, { path: string; content: string; exempt: boolean }[]> = {
  bun: [
    { path: "package.json", content: '{"name":"fixture"}', exempt: true },
    { path: "bunfig.toml", content: "[test]\npreload = ['./setup.ts']\n", exempt: false },
    { path: "tsconfig.json", content: "{}", exempt: false },
    { path: "bun.lock", content: "{}", exempt: false },
  ],
  npm: [
    { path: "package.json", content: '{"name":"fixture"}', exempt: true },
    { path: "package-lock.json", content: "{}", exempt: true },
    { path: "biome.json", content: "{}", exempt: false },
  ],
  python: [
    { path: "pyproject.toml", content: '[project]\nname = "fixture"\n', exempt: true },
    { path: "setup.py", content: "from setuptools import setup\nsetup()\n", exempt: false },
    { path: "tox.ini", content: "[testenv]\ncommands = pytest\n", exempt: false },
  ],
  go: [
    { path: "go.mod", content: "module example.com/fixture\n", exempt: true },
    { path: "go.work", content: "go 1.22\nuse .\n", exempt: true },
    { path: "go.sum", content: "", exempt: false },
  ],
  rust: [
    { path: "Cargo.toml", content: '[package]\nname = "fixture"\n', exempt: true },
    { path: "rust-toolchain.toml", content: '[toolchain]\nchannel = "stable"\ncomponents = ["clippy"]\n', exempt: true },
    { path: "rust-toolchain.toml", content: '[toolchain]\npath = "/opt/rust"\n', exempt: false },
    { path: ".cargo/config.toml", content: '[build]\nrustflags = ["-Dwarnings"]\n', exempt: false },
    { path: "Cargo.lock", content: "version = 3\n", exempt: true },
  ],
  maven: [
    { path: "pom.xml", content: "<project/>", exempt: true },
    { path: ".mvn/maven.config", content: "-B -ntp -Dstyle.color=never\n", exempt: true },
    { path: ".mvn/maven.config", content: "-s /tmp/settings.xml\n", exempt: false },
    { path: "gradle.properties", content: "org.gradle.jvmargs=-Xmx2g\n", exempt: true },
    { path: "gradle.properties", content: "org.gradle.jvmargs=-javaagent:agent.jar\n", exempt: false },
  ],
  dotnet: [
    { path: "Directory.Build.props", content: PROPS, exempt: true },
    { path: "Directory.Build.props", content: '<Project>\n  <Target Name="Stamp" BeforeTargets="Build">\n    <Exec Command="curl example.com" />\n  </Target>\n</Project>\n', exempt: false },
    { path: "Directory.Build.props", content: '<Project>\n  <ItemGroup>\n    <PackageReference Include="Newtonsoft.Json" />\n  </ItemGroup>\n</Project>\n', exempt: false },
    { path: "Directory.Build.props", content: "<Project>\n  <PropertyGroup>\n    <PostBuildEvent>rm -rf /</PostBuildEvent>\n  </PropertyGroup>\n</Project>\n", exempt: false },
    { path: "Directory.Build.targets", content: PROPS, exempt: true },
    { path: "Directory.Packages.props", content: '<Project>\n  <PropertyGroup>\n    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>\n  </PropertyGroup>\n  <ItemGroup>\n    <PackageVersion Include="xunit" Version="2.9.0" />\n  </ItemGroup>\n</Project>\n', exempt: true },
    { path: "global.json", content: '{"sdk":{"version":"10.0.100","rollForward":"latestFeature"}}', exempt: true },
    { path: "global.json", content: '{"msbuild-sdks":{"My.Sdk":"1.0.0"}}', exempt: false },
    { path: "NuGet.config", content: '<configuration>\n  <packageSources>\n    <add key="mine" value="https://example.com/v3/index.json" />\n  </packageSources>\n</configuration>\n', exempt: false },
    { path: "Dieodds.slnx", content: '<Solution>\n  <Project Path="src/App/App.csproj" />\n</Solution>\n', exempt: true },
  ],
};

describe("gate matrix: shared criterion rows (#1597)", () => {
  for (const [stack, path] of [
    ["bun", "tests/cli.test.ts"], ["python", "tests/test_cli.py"], ["rust", "tests/cli.rs"],
  ] as const) cell(stack, `${stack}: each test task owns one shared row`, () => {
    const rows = ["--ascending", "--descending", "--stdin"];
    const tasks = rows.map((row, index) => ({
      id: `T00${index + 1}`, criterionIds: ["AC-001"], description: `Test only ${row}`,
      writes: [{ path, action: "create" as const }],
    }));
    const spec = { criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "CLI input", when: "it runs",
      then: rows.map((row) => `input "${row}"`).join("; "), method: "automated" as const }] };
    for (const [index, task] of tasks.entries()) {
      const cases = criterionCases(spec, task, { checks: [], tasks });
      expect(cases.map((c) => c.literal)).toEqual([rows[index]!]);
      expect(missingCases(cases, [rows[index]!])).toEqual([]);
      expect(missingCases(cases, [])).toHaveLength(1);
    }
  });
});

describe("gate matrix: multi-input criteria cells and escapes (#1614)", () => {
  for (const sample of cellSamples) cell(sample.stack, `${sample.stack}: table inputs compare by value`, async () => {
    const root = project({ [sample.path]: sample.text });
    const task = { criterionIds: ["AC-001"], writes: [{ path: sample.path, action: "create" as const }] };
    const cases = criterionCases(cellSpec, task, { checks: [] });
    expect(cases).toHaveLength(14);
    const check = caseCheck(cellSpec, task, { checks: [] });
    expect(check).toBeDefined();
    expect(await check?.(root)).toEqual([]);
    writeFileSync(join(root, sample.path), withoutCellInput(sample.text));
    expect(await check?.(root)).toEqual([
      `AC-001 names ${JSON.stringify(omittedCellInput)}, and no test file this task writes (${sample.path}) contains it.`,
    ]);
  });
});

describe("gate matrix: criteria scenario labels (#1565)", () => {
  const samples: { stack: Stack; path: string; text: string }[] = [
    { stack: "bun", path: "tests/cli.test.ts", text: 'const path = "src/cli"; expect(run(["--path", path])).toBe(0); Join([3, 0, -2]);' },
    { stack: "python", path: "tests/test_cli.py", text: 'path = "src/cli"\nassert run(["--path", path]) == 0\nJoin([3, 0, -2])' },
    { stack: "go", path: "cli_test.go", text: 'path := "src/cli"; run([]string{"--path", path}); Join([]int{3, 0, -2})' },
  ];
  for (const sample of samples) cell(sample.stack, `${sample.stack}: labels are not missing cases`, () => {
    const task = { criterionIds: ["AC-001"], writes: [{ path: sample.path, action: "create" as const }] };
    const cases = criterionCases({ criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: 'the "repeated flag" and `success` scenarios', when: "tests run", then: "| Input | expected |\n| --- | --- |\n| repeated flag | last value |\n| success | zero status |\n| --path src/cli | selected |\n| Join([3,0,-2]) | joined |", method: "automated" }] }, task, { checks: [] });
    expect(writtenTestPaths(task)).toEqual([sample.path]);
    // An expression cell asks for its literal arguments (#1663).
    expect(cases.map((c) => c.literal)).toEqual(["--path src/cli", "[3,0,-2]"]);
    expect(missingCases(cases, [sample.text])).toEqual([]);
    expect(missingCases(cases, [sample.text.replace("src/cli", "SRC")]).map((c) => c.literal)).toEqual(["--path src/cli"]);
  });
});

/** A tool shell over a real directory with a fixed PATH, for detection only. */
function shell(root: string, on: string[]): ToolShell {
  return {
    root,
    scratch: join(root, ".scratch"),
    platform: "linux",
    run: async () => ({ exitCode: 0, output: "", timedOut: false }),
    read: (path) => {
      try {
        return readFileSync(join(root, path), "utf8");
      } catch {
        return null;
      }
    },
    exists: (path) => existsSync(join(root, path)),
    remove: () => {},
    which: (command) => (on.includes(command) ? `/usr/bin/${command}` : null),
    now: () => 0,
  };
}

// A Python project whose lockfile names its environment (#1655): the gates run in it, and its
// test task still gets a tests-written check. The bare interpreter outside an activated uv
// environment has no pytest, and `uv run pytest` built no per-task check.
const PYTHON_ENVIRONMENTS: [string, string, string][] = [
  ["uv.lock", "uv", "run"],
  ["poetry.lock", "poetry", "run"],
  ["Pipfile.lock", "pipenv", "run"],
];
describe("gate matrix: unsafe fixer tiers (#2095)", () => {
  cell("python", "ruff's unsafe tier runs on test files only; the safe tier on every file", () => {
    const ruff = detectGates(project(FIXTURES.python.files)).find((s) => s.check.id === "ruff")?.check;
    expect(ruff?.fixUnsafe?.args.slice(-3)).toEqual(["check", "--fix", "--unsafe-fixes"]);
    const files = ["src/fields.py", "tests/test_fields.py"];
    expect(ruff && fixerTierPaths(ruff, 0, files)).toEqual(files);
    expect(ruff && fixerTierPaths(ruff, 1, files)).toEqual(["tests/test_fields.py"]);
    // A person's own unsafe tier without a scope keeps every file.
    expect(fixerTierPaths({}, 1, files)).toEqual(files);
  });
});

describe("gate matrix: python environments", () => {
  for (const [lockfile, runner, verb] of PYTHON_ENVIRONMENTS)
    cell("python", `${lockfile}: gates and the written-tests check run in the environment`, () => {
      const fixture = FIXTURES.python;
      const path = fixture.property.path;
      const root = project({ ...fixture.files, [lockfile]: "", [path]: fixture.property.seeded });
      const checks = detectGates(root).filter((s) => s.preselected).map((s) => s.check);
      expect(checks.map((c) => [c.id, c.executable, ...c.args.slice(0, 2)])).toEqual([
        ["pytest", runner, verb, "pytest"],
        ["ruff", runner, verb, "ruff"],
      ]);
      expect(checks.find((c) => c.id === "ruff")?.fix).toEqual({ executable: runner, args: [verb, "ruff", "check", "--fix"] });
      // #2095: the unsafe tier, on test files only.
      expect(checks.find((c) => c.id === "ruff")?.fixUnsafe).toEqual({ executable: runner, args: [verb, "ruff", "check", "--fix", "--unsafe-fixes"] });
      expect(checks.find((c) => c.id === "ruff")?.fixUnsafeScope).toBe("tests");
      const written = writtenTestsCheck(root, checks, [{ path, action: "create" }]);
      expect(written && [written.executable, ...written.args]).toEqual([runner, verb, "pytest", "-q", `./${path}`]);
    });
});

// #1793: a manifest edit the request names was approved by its path; the manifest field check
// holds every executable field of it to what the request names. Each stack's manifest changes one
// executable field (caught) and one plain field (free).
describe("gate matrix: manifest executable fields (#1793)", () => {
  const changes = (path: string, before: string, after: string) => manifestFieldChanges(path, before, after);
  cell("bun", "package.json: scripts, bin and trustedDependencies, not engines", () => {
    const base = { name: "p", scripts: { test: "bun test" } };
    const json = (extra: object) => JSON.stringify({ ...base, ...extra });
    expect(changes("package.json", json({}), json({ engines: { bun: ">=1.4.0" } }))).toEqual([]);
    expect(changes("package.json", json({}), json({ scripts: { ...base.scripts, postinstall: "node x.js" }, bin: { p: "cli.js" }, trustedDependencies: ["esbuild"] }))).toEqual(["scripts.postinstall", "bin", "trustedDependencies"]);
    expect(unrequestedManifestFields([{ path: "package.json", before: json({}), content: json({ scripts: { ...base.scripts, postinstall: "x" }, engines: {} }) }], ["package.json"], "Add the engines field to package.json")).toEqual([{ file: "package.json", field: "scripts.postinstall" }]);
    expect(unrequestedManifestFields([{ path: "package.json", before: json({}), content: json({ scripts: { ...base.scripts, postinstall: "x" } }) }], ["package.json"], "Add a postinstall script to package.json")).toEqual([]);
  });
  cell("python", "pyproject.toml build backend and requirements index options, not the description", () => {
    const pyproject = (backend: string, description: string) => `[build-system]\nrequires = ["hatchling"]\nbuild-backend = "${backend}"\n\n[project]\nname = "p"\ndescription = "${description}"\n`;
    expect(changes("pyproject.toml", pyproject("hatchling.build", "a"), pyproject("hatchling.build", "b"))).toEqual([]);
    expect(changes("pyproject.toml", pyproject("hatchling.build", "a"), pyproject("evil.build", "a"))).toEqual(["build-system"]);
    expect(changes("requirements.txt", "requests==2.32.0\n", "--index-url https://example.test/simple\nrequests==2.32.0\n")).toEqual(["--index-url"]);
  });
  cell("rust", "Cargo.toml build script, not the version", () => {
    const cargo = (extra: string) => `[package]\nname = "p"\nversion = "0.1.0"\n${extra}`;
    expect(changes("Cargo.toml", cargo(""), cargo("").replace("0.1.0", "0.2.0"))).toEqual([]);
    expect(changes("Cargo.toml", cargo(""), cargo('build = "build.rs"\n'))).toEqual(["package.build"]);
  });
  cell("go", "go.mod replace and the go line, not the module path", () => {
    expect(changes("go.mod", "module m\n\ngo 1.22\n", "module n\n\ngo 1.22\n")).toEqual([]);
    expect(changes("go.mod", "module m\n\ngo 1.22\n", "module m\n\ngo 1.22\n\nreplace example.com/x => ../x\n")).toEqual(["replace example.com/x"]);
    // #1963: the go line selects (and downloads) the toolchain that runs the checks.
    const mod = (version: string) => `module m\n\ngo ${version}\n`;
    expect(changes("go.mod", mod("1.22.0"), mod("1.27.1"))).toEqual(["go 1.22.0", "go 1.27.1"]);
    expect(unrequestedManifestFields([{ path: "go.mod", before: mod("1.27.0"), content: mod("1.22.0") }], ["go.mod"], "Change go.mod from go 1.27.0 to go 1.22.0")).toEqual([]);
    expect(unrequestedManifestFields([{ path: "go.mod", before: mod("1.22.0"), content: mod("1.27.1") }], ["go.mod"], "Add a version flag; go.mod may change")).toHaveLength(2);
  });
  // #1963: the files beside the manifests that choose the toolchain or tool distribution.
  cell("rust", "rust-toolchain channel and path, not components", () => {
    const toml = (channel: string, extra = "") => `[toolchain]\nchannel = "${channel}"\n${extra}`;
    expect(changes("rust-toolchain.toml", toml("1.80.0"), toml("1.80.0", 'components = ["clippy"]\n'))).toEqual([]);
    expect(changes("rust-toolchain.toml", toml("1.80.0"), toml("nightly"))).toEqual(["toolchain.channel"]);
    expect(changes("rust-toolchain", "1.80.0\n", "1.81.0\n")).toEqual(["toolchain.channel"]);
  });
  cell("dotnet", "global.json sdk version, not the test runner", () => {
    const json = (version: string, extra = {}) => JSON.stringify({ sdk: { version }, ...extra });
    expect(changes("global.json", json("10.0.100"), json("10.0.100", { test: { runner: "Microsoft.Testing.Platform" } }))).toEqual([]);
    expect(changes("global.json", json("10.0.100"), json("10.0.200"))).toEqual(["sdk.version"]);
    // The checks stage reads these files with the manifests, so a request-named one reaches the check.
    for (const path of ["global.json", "rust-toolchain.toml", "gradle/wrapper/gradle-wrapper.properties", ".python-version"]) expect(hasExecutableFields(path)).toBe(true);
    expect(unrequestedManifestFields([{ path: "global.json", before: json("10.0.100"), content: json("10.0.200") }], ["global.json"], "Pin the SDK in global.json")).toEqual([{ file: "global.json", field: "sdk.version" }]);
  });
  cell("maven", "wrapper distributionUrl, not the distribution type", () => {
    const props = (url: string, type = "only-script") => `wrapperVersion=3.3.2\ndistributionType=${type}\ndistributionUrl=${url}\n`;
    const url = "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.zip";
    expect(changes(".mvn/wrapper/maven-wrapper.properties", props(url), props(url, "bin"))).toEqual([]);
    expect(changes(".mvn/wrapper/maven-wrapper.properties", props(url), props("https://example.test/maven.zip"))).toEqual(["distributionUrl"]);
    expect(changes("gradle/wrapper/gradle-wrapper.properties", "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10-bin.zip\n", "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.11-bin.zip\n")).toEqual(["distributionUrl"]);
  });
  // #1934: a request-named lock is bounded to the project's own entry; any other entry it changes
  // is a finding whatever the request names.
  cell("rust", "Cargo.lock: the project's own version is free, a dependency entry is not", () => {
    const lock = (own: string, serde = "1.0.200") => `version = 4\n\n[[package]]\nname = "serde"\nversion = "${serde}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "abc"\n\n[[package]]\nname = "sketchfold"\nversion = "${own}"\ndependencies = [\n "serde",\n]\n`;
    expect(changes("Cargo.lock", lock("0.1.0"), lock("0.2.0"))).toEqual([]);
    expect(changes("Cargo.lock", lock("0.1.0"), lock("0.2.0", "1.0.201"))).toEqual(["package serde 1.0.200", "package serde 1.0.201"]);
    expect(unrequestedManifestFields([{ path: "Cargo.lock", before: lock("0.1.0"), content: lock("0.2.0", "1.0.201") }], ["Cargo.lock"], "Bump sketchfold to 0.2.0; Cargo.lock follows, serde 1.0.201")).toHaveLength(2);
  });
  cell("npm", "package-lock.json: the root version is free, a node_modules entry is not", () => {
    const lock = (version: string, dep = "1.0.0") => JSON.stringify({ name: "p", version, lockfileVersion: 3, requires: true, packages: { "": { name: "p", version, dependencies: { a: "^1.0.0" } }, "node_modules/a": { version: dep, resolved: `https://registry.npmjs.org/a/-/a-${dep}.tgz` } } });
    expect(changes("package-lock.json", lock("1.0.0"), lock("1.1.0"))).toEqual([]);
    expect(changes("package-lock.json", lock("1.0.0"), lock("1.1.0", "1.0.1"))).toEqual(["package node_modules/a"]);
  });
  cell("python", "uv.lock: the editable project is free, a registry package is not", () => {
    const lock = (own: string, dep = "2.32.0") => `version = 1\nrequires-python = ">=3.11"\n\n[[package]]\nname = "p"\nversion = "${own}"\nsource = { editable = "." }\ndependencies = [{ name = "requests" }]\n\n[[package]]\nname = "requests"\nversion = "${dep}"\nsource = { registry = "https://pypi.org/simple" }\nsdist = { url = "https://example.test/r.tar.gz" }\n`;
    expect(changes("uv.lock", lock("0.1.0"), lock("0.2.0"))).toEqual([]);
    expect(changes("uv.lock", lock("0.1.0"), lock("0.1.0", "2.33.0"))).toEqual(["package requests 2.32.0", "package requests 2.33.0"]);
  });
  cell("ruby", "Gemfile.lock: the path gem of the project is free, a registry gem is not", () => {
    const lock = (own: string, rake = "13.2.1") => `PATH\n  remote: .\n  specs:\n    mygem (${own})\n      rake (~> 13.0)\n\nGEM\n  remote: https://rubygems.org/\n  specs:\n    rake (${rake})\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  mygem!\n  rake (~> 13.0)\n\nBUNDLED WITH\n   2.5.0\n`;
    expect(changes("Gemfile.lock", lock("0.1.0"), lock("0.2.0"))).toEqual([]);
    expect(changes("Gemfile.lock", lock("0.1.0"), lock("0.1.0", "13.3.0"))).toEqual(["GEM rake"]);
  });
  cell("python", "requires-python and .python-version select the interpreter, not the description", () => {
    const pyproject = (requires: string, description = "a") => `[project]\nname = "p"\ndescription = "${description}"\nrequires-python = "${requires}"\n`;
    expect(changes("pyproject.toml", pyproject(">=3.11"), pyproject(">=3.11", "b"))).toEqual([]);
    expect(changes("pyproject.toml", pyproject(">=3.11"), pyproject(">=3.13"))).toEqual(["project.requires-python"]);
    expect(changes(".python-version", "3.12\n", "3.13\n")).toEqual(["python-version"]);
  });
  cell("dotnet", "csproj Exec target, not the target framework", () => {
    const csproj = (extra: string, framework = "net10.0") => `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><TargetFramework>${framework}</TargetFramework></PropertyGroup>${extra}\n</Project>\n`;
    expect(changes("App.csproj", csproj(""), csproj("", "net9.0"))).toEqual([]);
    expect(changes("App.csproj", csproj(""), csproj('<Target Name="X" BeforeTargets="Build"><Exec Command="curl x" /></Target>'))).toEqual(["Target"]);
  });
  cell("maven", "pom.xml plugins and Gradle code, not the version or dependencies", () => {
    const pom = (extra: string, version = "1.0") => `<project><version>${version}</version>${extra}</project>`;
    expect(changes("pom.xml", pom(""), pom("", "1.1"))).toEqual([]);
    expect(changes("pom.xml", pom(""), pom("<build><plugins><plugin><artifactId>exec-maven-plugin</artifactId></plugin></plugins></build>"))).toEqual(["plugins"]);
    const gradle = (extra: string) => `plugins {\n  id("java")\n}\n\ndependencies {\n  implementation("a:b:1")${extra}\n}\n`;
    expect(changes("build.gradle.kts", gradle(""), gradle('\n  implementation("c:d:2")'))).toEqual([]);
    expect(changes("settings.gradle", "", 'rootProject.name = "fixture"\n')).toEqual([]);
    expect(changes("build.gradle.kts", gradle(""), `${gradle("")}tasks.register<Exec>("x") { commandLine("curl") }\n`)).toEqual(["tasks.register"]);
  });
});

// #1791: a passing lint check with six Biome infos became a high "Required check lint failed"
// finding and a 489k-token correction. Each tool's summary parser counts errors and warnings only,
// and a rise of warnings alone is a low finding; more errors stay high.
describe("gate matrix: diagnostics ratchet severity (#1791)", () => {
  const base = (output: string) => {
    const count = diagnosticCount(output);
    if (!count) throw new Error(`no count in ${output}`);
    return { kind: "diagnostics" as const, ...count };
  };
  const rise = (before: string, after: string) => baselineRegression(base(before), after)?.severity ?? null;
  const biome = (found: string) => `Checked 3 files in 2ms. No fixes applied.\n${found}`;
  cell("bun", "biome: infos are not counted, warnings are low, errors are high", () => {
    expect(rise(biome(""), biome("Found 6 infos."))).toBeNull();
    expect(rise(biome(""), biome("Found 2 warnings.\nFound 6 infos."))).toBe("low");
    expect(rise(biome("Found 1 warning."), biome("Found 1 error.\nFound 1 warning."))).toBe("high");
  });
  cell("npm", "eslint: warnings are low, errors are high", () => {
    expect(rise("✖ 1 problem (0 errors, 1 warning)", "✖ 3 problems (0 errors, 3 warnings)")).toBe("low");
    expect(rise("✖ 1 problem (0 errors, 1 warning)", "✖ 2 problems (1 error, 1 warning)")).toBe("high");
  });
  cell("python", "ruff: every violation is an error", () => {
    expect(rise("All checks passed!", "Found 1 error.")).toBe("high");
  });
  cell("bun", "tsc: every diagnostic is an error", () => {
    expect(rise("Found 1 error in 1 file.", "Found 2 errors in 1 file.")).toBe("high");
  });
  cell("rust", "cargo: a finished build's warnings are low", () => {
    const cargo = (n: number) => `    Checking app v0.1.0\n${n ? `warning: \`app\` (bin "app") generated ${n} warnings\n` : ""}    Finished \`dev\` profile [unoptimized] target(s) in 0.5s`;
    expect(rise(cargo(0), cargo(3))).toBe("low");
  });
  cell("dotnet", "dotnet build: warnings are low, errors are high", () => {
    const build = (w: number, e: number) => `Build succeeded.\n    ${w} Warning(s)\n    ${e} Error(s)`;
    expect(rise(build(0, 0), build(2, 0))).toBe("low");
    expect(rise(build(0, 0), build(0, 1))).toBe("high");
  });
  cell("go", "go vet prints no summary: no count, no ratchet", () => {
    expect(diagnosticCount("# example.com/app\n./main.go:5:2: unreachable code")).toBeNull();
  });
  cell("maven", "maven has no diagnostics summary parser: no count, no ratchet", () => {
    expect(diagnosticCount("[WARNING] /src/App.java:[3,8] unused\n[INFO] BUILD SUCCESS")).toBeNull();
  });
  test("dart analyze: infos are not counted, warnings are low, errors are high (#1494)", () => {
    const analyze = (...lines: string[]) => `Analyzing calc...\n\n${lines.join("\n")}\n\n${lines.length ? `${lines.length} issue${lines.length > 1 ? "s" : ""} found.` : "No issues found!"}\n`;
    const info = "   info - lib/a.dart:5:3 - Don't invoke 'print' in production code. - avoid_print";
    const warning = "warning - lib/a.dart:2:7 - The value of the local variable 'unused' isn't used. - unused_local_variable";
    const error = "  error - lib/a.dart:3:14 - A value of type 'int' can't be assigned to a variable of type 'String'. - invalid_assignment";
    expect(rise(analyze(), analyze(info))).toBeNull();
    expect(rise(analyze(), analyze(warning, info))).toBe("low");
    expect(rise(analyze(warning), analyze(error, warning))).toBe("high");
  });
});

describe("gate matrix: format and type-check gates (#1685)", () => {
  const gates = (files: Record<string, string>) =>
    detectGates(project(files)).map((s) => [s.check.id, [s.check.executable, ...s.check.args].join(" "), s.check.fix ? [s.check.fix.executable, ...s.check.fix.args].join(" ") : null, s.preselected]);
  const pkg = (extra: Record<string, unknown>) => JSON.stringify({ name: "p", ...extra });

  for (const name of ["format:check", "fmt:check", "check-format", "format-check", "prettier:check"])
    cell("bun", `a "${name}" script is a preselected format gate`, () => {
      const scripts = { [name]: "prettier --check .", format: "prettier --write ." };
      expect(gates({ "package.json": pkg({ scripts }), "bun.lock": "" })).toContainEqual(["format", `bun run ${name}`, "bun run format", true]);
    });

  cell("npm", "a formatter config without a check script is offered, not preselected", () => {
    expect(gates({ "package.json": pkg({ prettier: {} }), "package-lock.json": "{}" })).toContainEqual(["format", "npx prettier --check .", "npx prettier --write .", false]);
    expect(gates({ "package.json": pkg({}), "pnpm-lock.yaml": "", ".prettierrc.yaml": "" })).toContainEqual(["format", "pnpm exec prettier --check .", "pnpm exec prettier --write .", false]);
    expect(gates({ "package.json": pkg({}), "bun.lock": "", "biome.json": "{}" })).toContainEqual(["format", "bunx biome format .", "bunx biome format --write .", false]);
    expect(gates({ "package.json": pkg({}), "yarn.lock": "", "dprint.json": "{}" })).toContainEqual(["format", "yarn dprint check", "yarn dprint fmt", false]);
    // #1920: a project that opted into `bun fmt` runs it through Bun, ahead of a Prettier config.
    expect(gates({ "package.json": pkg({}), "bun.lock": "", "bunfig.toml": "[fmt]\n", ".prettierrc": "{}" })).toContainEqual(["format", "bun fmt --no-script --check .", "bun fmt --no-script .", false]);
    expect(gates({ "package.json": pkg({}), "package-lock.json": "{}", "bunfig.toml": "[fmt]\n" })).toContainEqual(["format", "bun fmt --no-script --check .", "bun fmt --no-script .", false]);
    expect(gates({ "package.json": pkg({}), "bun.lock": "", "bunfig.toml": "[fmt]\n", "biome.json": "{}" })).toContainEqual(["format", "bunx biome format .", "bunx biome format --write .", false]);
    expect(gates({ "package.json": pkg({}), "bun.lock": "", "bunfig.toml": "[test]\n" }).map(([id]) => id)).not.toContain("format");
    const scripted = gates({ "package.json": pkg({ scripts: { "format:check": "biome format ." } }), "bun.lock": "", "biome.json": "{}" });
    expect(scripted.filter(([id]) => id === "format")).toEqual([["format", "bun run format:check", null, true]]);
    expect(gates({ "package.json": pkg({ scripts: { lint: "eslint ." } }), "bun.lock": "" }).map(([id]) => id)).toEqual(["lint"]);
  });

  const python = (pyproject: string, extra: Record<string, string> = {}) => gates({ "pyproject.toml": `[project]\nname = "p"\n${pyproject}`, ...extra });

  cell("python", "black gets a preselected format gate unless ruff formats", () => {
    expect(python("[tool.black]\nline-length = 100\n")).toContainEqual(["black", "black --check .", "black .", true]);
    expect(python("", { "requirements-dev.txt": "black==24.1.0\n" })).toContainEqual(["black", "black --check .", "black .", true]);
    expect(python("", { "requirements.txt": "black-extras\n" }).map(([id]) => id)).not.toContain("black");
    expect(python("[tool.black]\n[tool.ruff]\n[tool.ruff.format]\n").map(([id]) => id)).not.toContain("black");
    expect(python("[tool.black]\n", { "uv.lock": "" })).toContainEqual(["black", "uv run black --check .", "uv run black .", true]);
  });

  cell("python", "mypy and pyright configs get a preselected whole-unit type-check gate", () => {
    for (const [extra, pyproject] of [[{ "mypy.ini": "[mypy]\n" }, ""], [{}, "[tool.mypy]\nstrict = true\n"], [{ "setup.cfg": "[mypy]\n" }, ""]] as const)
      expect(python(pyproject, extra)).toContainEqual(["mypy", "mypy .", null, true]);
    expect(python("", { "pyrightconfig.json": "{}" })).toContainEqual(["pyright", "pyright", null, true]);
    expect(python("[tool.pyright]\n[tool.mypy]\n").filter(([id]) => id === "mypy" || id === "pyright").map(([id]) => id)).toEqual(["pyright"]);
    expect(python("[tool.mypy]\n", { "poetry.lock": "" })).toContainEqual(["mypy", "poetry run mypy .", null, true]);
    const typecheck = detectGates(project({ "pyproject.toml": "[tool.mypy]\n" })).find((s) => s.check.id === "mypy")!.check;
    expect(isWholeUnitCheck(typecheck)).toBe(true);
    expect(python("").map(([id]) => id)).toEqual([]);
  });
});

// #1837: a repository not formatter-clean leaves its whole-tree format gate out of the run's checks;
// the files a task writes still get the project's formatter, scoped to them, with its fixer.
describe("gate matrix: format-written check on a dirty repository (#1837)", () => {
  const scoped = (files: Record<string, string>, written: string[], checks: Check[] = []) =>
    formatWrittenChecks(project(files), checks, written.map((path) => ({ path, action: "create" })), (c) => `/usr/bin/${c}`).map((c) => [
      c.id,
      [c.executable, ...c.args].join(" "),
      c.fix ? [c.fix.executable, ...c.fix.args].join(" ") : null,
      c.required,
    ]);
  const pkg = JSON.stringify({ name: "p" });

  cell("python", "ruff as the linter: ruff format on the written files only, fixer ruff format", () => {
    const files = { "pyproject.toml": "[project]\nname = 'p'\n[tool.ruff]\n", "p/old.py": "x=1\n", "tests/test_new.py": "x=1\n" };
    expect(scoped(files, ["tests/test_new.py"])).toEqual([["ruff-format-written", "ruff format --check tests/test_new.py", "ruff format", true]]);
    expect(scoped({ ...files, "uv.lock": "" }, ["tests/test_new.py"])).toEqual([["ruff-format-written", "uv run ruff format --check tests/test_new.py", "uv run ruff format", true]]);
    // The run already formats Python: nothing to add.
    const whole = detectGates(project(files)).find((s) => s.check.id === "ruff-format")!.check;
    expect(scoped(files, ["tests/test_new.py"], [whole])).toEqual([]);
  });
  cell("python", "a formatter check on other files holds no written file outside them", () => {
    const files = { "pyproject.toml": "[project]\nname = 'p'\n[tool.ruff]\n", "legacy/clean.py": "x = 1\n", "tests/test_new.py": "x=1\n", "tests/test_b.py": "x=1\n" };
    const whole = detectGates(project(files)).find((s) => s.check.id === "ruff-format")!.check;
    const written = [["ruff-format-written", "ruff format --check tests/test_new.py", "ruff format", true]];
    // One file, another directory, a cwd elsewhere, or a narrowed run: the new file still gets its check.
    expect(scoped(files, ["tests/test_new.py"], [{ ...whole, args: ["format", "--check", "legacy/clean.py"] }])).toEqual(written);
    expect(scoped(files, ["tests/test_new.py"], [{ ...whole, args: ["format", "--check", "legacy"] }])).toEqual(written);
    expect(scoped(files, ["tests/test_new.py"], [{ ...whole, cwd: "legacy" }])).toEqual(written);
    expect(scoped(files, ["tests/test_new.py"], [{ ...whole, args: [...whole.args, "--exclude", "tests"] }])).toEqual(written);
    // The file itself, its directory or the cwd above it: held already, nothing to add for it.
    expect(scoped(files, ["tests/test_new.py"], [{ ...whole, args: ["format", "--check", "tests/test_new.py"] }])).toEqual([]);
    expect(scoped(files, ["tests/test_new.py"], [{ ...whole, args: ["format", "--check", "./tests/"] }])).toEqual([]);
    expect(scoped(files, ["tests/test_new.py"], [{ ...whole, cwd: "tests", args: ["format", "--check", "."] }])).toEqual([]);
    // Only the written files the check leaves out.
    expect(scoped(files, ["tests/test_new.py", "tests/test_b.py"], [{ ...whole, args: ["format", "--check", "tests/test_b.py"] }])).toEqual(written);
  });
  cell("go", "gofmt on ./... holds every written Go file", () => {
    const files = { "go.mod": "module p\n\ngo 1.22\n", "a/b.go": "package a\n" };
    const gate = { id: "gofmt", executable: "gofmt", args: ["-l", "./..."], cwd: ".", timeoutMs: 120000, required: true, scope: "feature" as const, envNames: [], writes: [] };
    expect(scoped(files, ["a/b.go"], [gate])).toEqual([]);
  });
  cell("python", "black: black --check on the written files, fixer black", () => {
    const files = { "pyproject.toml": "[project]\nname = 'p'\n[tool.black]\n", "p/new.py": "x=1\n" };
    expect(scoped(files, ["p/new.py"])).toEqual([["black-written", "black --check p/new.py", "black", true]]);
  });
  cell("bun", "biome: biome format on the written files through bunx, fixer biome format --write", () => {
    const files = { "package.json": pkg, "bun.lock": "", "biome.json": "{}", "src/a.ts": "x\n", "README.md": "# p\n" };
    expect(scoped(files, ["src/a.ts", "README.md"])).toEqual([["format-written", "bunx biome format src/a.ts", "bunx biome format --write", true]]);
    // A format script in the run's checks formats the npm languages already.
    expect(scoped(files, ["src/a.ts"], [{ id: "format", executable: "bun", args: ["run", "format:check"], cwd: ".", timeoutMs: 120000, required: true, scope: "feature", envNames: [], writes: [] }])).toEqual([]);
  });
  cell("npm", "prettier: prettier --check on the written files through npx", () => {
    const files = { "package.json": pkg, "package-lock.json": "{}", ".prettierrc": "{}", "src/a.js": "x\n" };
    expect(scoped(files, ["src/a.js"])).toEqual([["format-written", "npx prettier --check src/a.js", "npx prettier --write", true]]);
    // Not installed in node_modules nor on the PATH: npx would download it, so no check.
    expect(formatWrittenChecks(project(files), [], [{ path: "src/a.js", action: "create" }], () => null)).toEqual([]);
  });
  cell("bun", "bun fmt: --check on the written files through Bun, only where Bun has bun fmt (#1920)", () => {
    const files = { "package.json": pkg, "bun.lock": "", "bunfig.toml": "[fmt]\n", "src/a.ts": "x\n" };
    const asked: string[] = [];
    const run = (has: boolean) =>
      formatWrittenChecks(project(files), [], [{ path: "src/a.ts", action: "create" }], (c) => `/usr/bin/${c}`, undefined, (command, _, flag) => {
        asked.push(`${[command.executable, ...command.args].join(" ")} ${flag}`);
        return has;
      }).map((c) => [c.id, [c.executable, ...c.args].join(" "), c.fix ? [c.fix.executable, ...c.fix.args].join(" ") : null, c.required]);
    expect(run(true)).toEqual([["format-written", "bun fmt --no-script --check src/a.ts", "bun fmt --no-script", true]]);
    // A Bun before 1.4.4 has no `bun fmt`: no check that would fail every attempt.
    expect(run(false)).toEqual([]);
    expect(asked).toEqual(["bun fmt --no-script --help --all --range-start", "bun fmt --no-script --help --all --range-start"]);
  });
  cell("go", "gofmt left out: gofmt -l on the written files, fixer gofmt -w", () => {
    const files = { "go.mod": "module p\n\ngo 1.22\n", "a.go": "package p\n" };
    expect(scoped(files, ["a.go"])).toEqual([["gofmt-written", "gofmt -l a.go", "gofmt -w", true]]);
  });

  // An edited file: only the lines the run changed against its content before the run (#1837, R57
  // zonevet), by a formatter that formats a range; none where the formatter cannot.
  const edited = (files: Record<string, string>, path: string, before: string) =>
    formatWrittenChecks(project(files), [], [{ path, action: "modify" }], (c) => `/usr/bin/${c}`, (p) => (p === path ? before : undefined), () => true).map((c) => [
      c.id,
      [c.executable, ...c.args].join(" "),
      c.fix ? [c.fix.executable, ...c.fix.args].join(" ") : null,
      c.fixPaths,
    ]);
  cell("python", "ruff, edited file: one --range check per changed block, fixer ruff format --range", () => {
    const files = { "pyproject.toml": "[project]\nname = 'p'\n[tool.ruff]\n", "t/test_a.py": "x=1\nY\nz=2\nW\n" };
    expect(edited(files, "t/test_a.py", "x=1\nz=2\n")).toEqual([
      // The last block first: fixing it never moves the blocks above it.
      ["ruff-format-lines", "ruff format --check --range=4-5 t/test_a.py", "ruff format --range=4-5", ["t/test_a.py"]],
      ["ruff-format-lines-2", "ruff format --check --range=2-3 t/test_a.py", "ruff format --range=2-3", ["t/test_a.py"]],
    ]);
  });
  cell("python", "ruff, edited file: every changed block gets its check, the ninth too", () => {
    const before = Array.from({ length: 9 }, (_, i) => `a${i}\n`).join("");
    const after = Array.from({ length: 9 }, (_, i) => `a${i}\nx=${i}\n`).join("");
    const files = { "pyproject.toml": "[project]\nname = 'p'\n[tool.ruff]\n", "t/test_a.py": after };
    const checks = edited(files, "t/test_a.py", before);
    expect(checks).toHaveLength(9);
    expect(checks[0]).toEqual(["ruff-format-lines", "ruff format --check --range=18-19 t/test_a.py", "ruff format --range=18-19", ["t/test_a.py"]]);
  });
  cell("python", "black, edited file: one check with every --line-ranges", () => {
    const files = { "pyproject.toml": "[project]\nname = 'p'\n[tool.black]\n", "p/a.py": "x=1\nY\nz=2\nW\n" };
    expect(edited(files, "p/a.py", "x=1\nz=2\n")).toEqual([
      ["black-lines", "black --check --line-ranges=2-2 --line-ranges=4-4 p/a.py", "black --line-ranges=2-2 --line-ranges=4-4", ["p/a.py"]],
    ]);
  });
  cell("npm", "prettier, edited file: --range-start and --range-end over the changed lines", () => {
    const files = { "package.json": pkg, "package-lock.json": "{}", ".prettierrc": "{}", "src/a.js": "old\nnew( )\n" };
    expect(edited(files, "src/a.js", "old\n")).toEqual([
      ["format-lines", "npx prettier --check --range-start=4 --range-end=11 src/a.js", "npx prettier --write --range-start=4 --range-end=11", ["src/a.js"]],
    ]);
  });
  cell("bun", "bun fmt, edited file: --range-start and --range-end over the changed lines (#1920)", () => {
    const files = { "package.json": pkg, "bun.lock": "", "bunfig.toml": "[fmt]\n", "src/a.ts": "old\nnew( )\n" };
    expect(edited(files, "src/a.ts", "old\n")).toEqual([
      ["format-lines", "bun fmt --no-script --check --range-start=4 --range-end=11 src/a.ts", "bun fmt --no-script --range-start=4 --range-end=11", ["src/a.ts"]],
    ]);
  });
  // A formatter release without the range flag would fail every range check and its fixer (#1907).
  cell("python", "ruff and black without their range flag: an edited file is not checked, a new file still is", () => {
    const asked: string[] = [];
    const without = (files: Record<string, string>, path: string, before: string) =>
      formatWrittenChecks(project(files), [], [{ path, action: "modify" }, { path: "t/test_new.py", action: "create" }], (c) => `/usr/bin/${c}`, (p) => (p === path ? before : undefined), (command, _, flag) => {
        asked.push(`${[command.executable, ...command.args].join(" ")} ${flag}`);
        return false;
      }).map((c) => c.id);
    const ruff = { "pyproject.toml": "[project]\nname = 'p'\n[tool.ruff]\n", "t/test_a.py": "x=1\nY\n", "t/test_new.py": "x=1\n" };
    expect(without(ruff, "t/test_a.py", "x=1\n")).toEqual(["ruff-format-written"]);
    const black = { "pyproject.toml": "[project]\nname = 'p'\n[tool.black]\n", "t/test_a.py": "x=1\nY\n", "t/test_new.py": "x=1\n" };
    expect(without(black, "t/test_a.py", "x=1\n")).toEqual(["black-written"]);
    expect(asked).toEqual(["ruff format --help --range", "black --help --line-ranges"]);
  });
  cell("bun", "biome, dprint, gofmt and dotnet format take no range: an edited file is not checked", () => {
    expect(edited({ "package.json": pkg, "bun.lock": "", "biome.json": "{}", "src/a.ts": "a\nb\n" }, "src/a.ts", "a\n")).toEqual([]);
    expect(edited({ "go.mod": "module p\n\ngo 1.22\n", "a.go": "package p\nvar x=1\n" }, "a.go", "package p\n")).toEqual([]);
  });
  cell("dotnet", "dotnet format left out: --include the written files, fixer dotnet format", () => {
    const files = { "App.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\" />", "A.cs": "class A {}\n" };
    expect(scoped(files, ["A.cs"])).toEqual([["dotnet-format-written", "dotnet format --verify-no-changes --include A.cs", "dotnet format", true]]);
  });
  cell("rust", "cargo fmt follows mod declarations: no file-scoped check (#842)", () => {
    expect(scoped({ "Cargo.toml": "[package]\nname = 'p'\n", "src/lib.rs": "" }, ["src/lib.rs"])).toEqual([]);
  });
  cell("maven", "no Maven formatter gate is detected: no check", () => {
    expect(scoped({ "pom.xml": "<project/>", "src/main/java/A.java": "class A {}\n" }, ["src/main/java/A.java"])).toEqual([]);
  });
});

for (const stack of STACKS) {
  const fixture = FIXTURES[stack];
  describe(`gate matrix: ${stack}`, () => {
    const preselected = () =>
      detectGates(project(fixture.files))
        .filter((s) => s.preselected)
        .map((s) => s.check);

    cell(stack, "detection", () => {
      expect(preselected().map((c) => c.id)).toEqual(fixture.gates);
    });

    cell(stack, "suite per-test timeout (#1548)", () => {
      const root = project(fixture.files);
      const suite = detectGates(root).map((s) => s.check).find(isTestCheck)!;
      const definition = JSON.stringify(suite);
      const args = withPerTestTimeout(suite, root);
      if (stack === "bun") expect(args.slice(-2)).toEqual(["--timeout", "30000"]);
      else if (stack === "npm") expect(args.slice(-2)).toEqual(["--", "--testTimeout=30000"]);
      else expect(args).toEqual(suite.args);
      expect(JSON.stringify(suite)).toBe(definition);
    });

    // caesar 21bc3a53: run_probe refused java next to `mvn verify`, so its README task blocked.
    cell(stack, "README example program runs under run_probe", () => {
      expect(reproExecutables(preselected())).toContain(DOCUMENTED_PROGRAM[stack]);
    });

    // routeshadow R55: the README documented `routeshadow ...`, which is not cargo, so none of its
    // examples ran; the project's own command runs through the launcher the checks start.
    cell(stack, "doc examples entry points (#1821)", () => {
      const root = project(WITH_ENTRY_POINT[stack](fixture.files));
      const executables = reproExecutables(detectGates(root).filter((s) => s.preselected).map((s) => s.check));
      const resolved = entryPointCommand(root, ["tool", "--help"], executables);
      expect(resolved?.entry.name).toBe("tool");
      expect(executables).toContain(resolved!.argv[0]!);
      expect(resolved!.argv.at(-1)).toBe("--help");
    });

    cell(stack, "edit-profile", async () => {
      const profile = await detectProfile(project(fixture.files));
      expect({ lint: profile.lint, formatFile: profile.formatFile }).toEqual(EDIT_PROFILE[stack]);
    });

    cell(stack, "post-edit formatter pre-image probe (#1582)", async () => {
      const root = project(fixture.files);
      const profile = await detectProfile(root);
      const file = join(root, "original.py");
      const command = profile.formatFile;
      if (stack === "python") {
        expect(formatProbeCommand(command!, file)).toContain("ruff format --stdin-filename");
      } else if (stack === "go") {
        expect(formatProbeCommand(command!, file)).toBe("gofmt");
      } else if (stack === "rust") {
        expect(formatProbeCommand(command!, file)).toContain("rustfmt --emit stdout");
      } else {
        expect(command).toBeNull();
      }
    });

    cell(stack, "timed-out-failure", () => {
      expect(timedOutFailure(`${FAILED_TEST_OUTPUT[stack]}\nstill running`)).toBe(true);
    });

    cell(stack, "baseline-signature test summary", () => {
      expect(failureSignature(RED_BASELINE[stack](4), "/w")).toBe(failureSignature(RED_BASELINE[stack](5), "/w"));
    });

    cell(stack, "written-tests-check runs no test (#1832)", () => {
      const check = { id: "tests-affected", executable: stack, args: [], cwd: ".", timeoutMs: 1000, required: false, scope: "task" as const, envNames: [], writes: [] };
      expect(testsRan(ZERO_RUN_OUTPUT[stack])?.count).toBe(0);
      expect(exitStatus({ ...check, requireTests: true }, 0, ZERO_RUN_OUTPUT[stack])).toBe("failed");
      expect(exitStatus(check, 0, ZERO_RUN_OUTPUT[stack])).toBe("passed");
      expect(testsRan(RED_BASELINE[stack](4))?.count ?? 1).toBeGreaterThan(0);
    });

    cell(stack, "written-tests-check", () => {
      const path = fixture.property.path;
      const root = project({ ...fixture.files, [path]: fixture.property.seeded });
      const written = writtenTestsCheck(root, preselected(), [{ path, action: "create" }]);
      expect(written?.args ?? null).toEqual(WRITTEN_TEST_ARGS[stack]);
    });

    // A planned test task is told the check of its test files before they exist (#1518): bench
    // round 43's bun test tasks listed no suite check and did not know they could run it.
    cell(stack, "planned-written-tests", () => {
      const path = fixture.property.path;
      const root = project({ ...fixture.files, [path]: fixture.property.seeded });
      const writes = [{ path, action: "create" }];
      const written = writtenTestsCheck(root, preselected(), writes);
      expect(plannedWrittenTests(preselected(), writes)?.id ?? null).toBe(written?.id ?? null);
      if (written) expect(plannedWrittenTests(preselected(), writes)?.timeoutMs).toBe(written.timeoutMs);
    });

    cell(stack, "test-task-price-and-case-capacity (#1595)", () => {
      const original: Task = {
        id: "T001", title: "Tests", description: "Write cases", requirementIds: ["FR-001"],
        criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer",
        writes: [{ path: fixture.property.path, action: "create" }], readHints: [],
        checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior",
      };
      const graph = { schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [original] };
      const samples = [100_000, ...Array<number>(8).fill(1_000_000), 5_000_000].map((tokens, i) => ({
        runId: `h${i}`, taskId: "T001", kind: "test" as const, action: "create" as const,
        source: "project" as const, files: 1, tokens, model: null, cases: 12,
      }));
      for (const cases of [8, 12, 13]) {
        const spec = { criteria: [{ id: "AC-001", method: "automated", given: Array.from({ length: cases }, (_, i) => `input "case-${i}"`).join("; "), when: "it runs", then: "it passes" }] };
        const report = sizePlan({ graph, policy: { ...defaultWorkflowPolicy, sizing: { maxAttemptTokens: 600_000 } }, samples, spent: 0, spec });
        expect(report.tasks[0]).toMatchObject({ estimate: { low: 1_000_000, high: 1_000_000 }, attemptTokens: 600_000, cases, oversized: cases > 12 });
      }
    });

    cell(stack, "sizing-replan-approval-task-count (#1627)", () => {
      const graph: TaskGraph = {
        schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64),
        tasks: Array.from({ length: 10 }, (_, i) => ({
          id: `T${String(i + 1).padStart(3, "0")}`, title: "Test slice", description: "Write cases",
          requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer",
          writes: [{ path: fixture.property.path, action: "modify" }], readHints: [], checkIds: [],
          origin: "planned", findingIds: [], rationale: "Required behavior",
        })),
      };
      const policy = {
        ...defaultWorkflowPolicy,
        autoApproval: { renewal: false, limits: { maxTasks: 8, maxFiles: 20, allowedPaths: ["**"], allowDelete: false, allowNewDependencies: false, maxTotalTokens: defaultWorkflowPolicy.maxTotalTokens } },
      };
      expect(planScopeAdvice(policy, graph, undefined, false, "", 2)).toEqual([]);
      expect(evaluateAutoApproval(policy, {} as Parameters<typeof evaluateAutoApproval>[1], fixtureSpec, graph, [], [], { hostSplitTasks: 2 }).approval?.mode).toBe("limits");
      expect(planScopeAdvice(policy, graph).join(" ")).toContain("10 tasks exceed 8");
    });

    // R51 dieodds-update (#1710): the brief named a new Directory.Build.props with its content, the
    // planner was told the write was fine, and the approval declined it as outside the allowed paths.
    cell(stack, "request-named-config-agreement (#1710)", () => {
      const policy = {
        ...defaultWorkflowPolicy,
        autoApproval: {
          renewal: false, requestedManifestEdits: true,
          limits: { maxTasks: 8, maxFiles: 20, allowedPaths: ["src/**", "tests/**"], allowDelete: false, allowNewDependencies: false, maxTotalTokens: defaultWorkflowPolicy.maxTotalTokens },
        },
      };
      for (const { path, content, exempt } of NAMED_CONFIGS[stack]) {
        for (const action of ["create", "modify"] as const) {
          const graph: TaskGraph = {
            schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64),
            tasks: [{
              id: "T001", title: "Write the config", description: "Write the file the brief gives",
              requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer",
              writes: [{ path, action, content }], readHints: [], checkIds: [],
              origin: "planned", findingIds: [], rationale: "The brief names it",
            }],
          };
          const request = `Write ${path} with the content the brief gives.`;
          const exists = () => action === "modify";
          const advice = planScopeAdvice(policy, graph, exists, false, request).join(" ");
          const result = evaluateAutoApproval(policy, {} as Parameters<typeof evaluateAutoApproval>[1], fixtureSpec, graph, [], [], { exists, manifestRequest: request });
          const label = `${action} ${path}: ${content.slice(0, 40)}`;
          expect([label, result.approval?.mode ?? null]).toEqual([label, exempt ? "limits" : null]);
          expect([label, advice === ""]).toEqual([label, exempt]);
          if (exempt) continue;
          const reason = result.reasons.find((r) => r.includes(`${path} needs a person: `));
          expect([label, reason !== undefined]).toEqual([label, true]);
          expect(advice).toContain(reason?.replace(/^Limits: /, "") ?? "");
          expect(result.reasons.join("\n")).not.toContain("outside the allowed paths");
        }
      }
    });

    cell(stack, "sizing-slices-count-once (#1711)", () => {
      // R51: a test file cut into slices over several planning passes counts as one planned task.
      const tasks = Array.from({ length: 12 }, (_, i) => ({
        id: `T${String(i + 1).padStart(3, "0")}`, title: "Test slice", description: "Write cases",
        requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer",
        writes: [{ path: i < 7 ? `src/m${i}.txt` : fixture.property.path, action: i <= 7 ? "create" as const : "modify" as const }],
        readHints: [], checkIds: [], origin: "planned" as const, findingIds: [], rationale: "Required behavior",
        ...(i >= 7 ? { sizingSlice: { taskId: "T008", index: i - 7, count: 5, share: 0.2 } } : {}),
      }));
      const graph: TaskGraph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks };
      const policy = {
        ...defaultWorkflowPolicy,
        autoApproval: { renewal: false, limits: { maxTasks: 8, maxFiles: 20, allowedPaths: ["**"], allowDelete: false, allowNewDependencies: false, maxTotalTokens: defaultWorkflowPolicy.maxTotalTokens } },
      };
      expect(planScopeAdvice(policy, graph)).toEqual([]);
      expect(evaluateAutoApproval(policy, {} as Parameters<typeof evaluateAutoApproval>[1], fixtureSpec, graph, [], []).approval?.mode).toBe("limits");
    });

    cell(stack, "sequential-test-slices-written-tests", () => {
      const path = fixture.property.path;
      const root = project({ ...fixture.files, [path]: fixture.property.seeded });
      const original: Task = {
        id: "T001", title: "Tests", description: "Write cases", requirementIds: ["FR-001"],
        criterionIds: ["AC-001", "AC-002", "AC-003", "AC-004"], dependsOn: [], profileId: "implementer",
        writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior",
      };
      const graph = { schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [original] };
      const report = sizePlan({ graph, policy: { ...defaultWorkflowPolicy, sizing: { maxAttemptTokens: 200_000 } }, samples: [], spent: 0 });
      const parts = splitTestTasks(graph, report)!.tasks;
      expect(parts).toHaveLength(2);
      for (const part of parts) {
        expect(part.writes.map((w) => w.path)).toEqual([path]);
        expect(plannedWrittenTests(preselected(), part.writes)?.paths ?? null).toEqual(WRITTEN_TEST_ARGS[stack] ? [path] : null);
        expect(writtenTestsCheck(root, preselected(), part.writes)?.args ?? null).toEqual(WRITTEN_TEST_ARGS[stack]);
      }
    });

    cell(stack, "indivisible-test-batches-without-tests-written (#1579)", () => {
      const original: Task = {
        id: "T001", title: "Tests", description: "Write cases", requirementIds: ["FR-001"],
        criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer",
        writes: [{ path: fixture.property.path, action: "create" }], readHints: [],
        checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior",
      };
      const graph = { schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [original] };
      const policy = { ...defaultWorkflowPolicy, checks: preselected(), sizing: { maxAttemptTokens: 200_000 } };
      expect(policy.checks.some((check) => check.id === "tests-written")).toBe(false);
      const report = sizePlan({ graph, policy, samples: [], spent: 0 });
      expect(report.tasks[0]!.oversized).toBe(true);
      const edits: HostEdit[] = [];
      const split = splitTestTasks(graph, report, null, edits)!;
      const part = split.tasks[0]!;
      expect(part.description).toContain("small batches inside this attempt");
      expect(part.description).not.toContain("tests-written");
      expect(part.checkIds).toEqual(original.checkIds);
      // #1583: the analysis gate uses provenance for the same host text on every stack.
      const description = edits.find((edit) => edit.field === "description")!;
      expect(hostOnlyEvidence({ kind: "inconsistency", refs: ["tasks.json", part.id], description: `${part.id} adds "preserve earlier batches".` }, edits, "")).toContainEqual(description);
      expect(plannerGraph(split, edits)).toEqual(graph);
    });

    // The mutation gate needs a required test check to run the mutants against; without one it is
    // a silent no-op (#844).
    cell(stack, "test-check", () => {
      expect(preselected().some((c) => c.required && isTestCheck(c))).toBe(true);
    });

    cell(stack, "mutation caps cover sibling files (#1567)", () => {
      const source = fixture.mutation?.source ?? "src/Sum.cs";
      const extension = source.slice(source.lastIndexOf("."));
      const line = stack === "python" ? "    return value > 0" : "    return value > 0;";
      const files = ["a", "b", "z"].map((name) => ({
        path: `src/${name}${extension}`, before: null,
        content: Array.from({ length: 100 }, () => `${line}${" ".repeat(300)}`).join("\n"),
      }));
      const mutants = generateMutants(files);
      expect(mutants).toHaveLength(24);
      for (const file of files) expect(mutants.filter((m) => m.file === file.path)).toHaveLength(8);
      const listed = proposalFiles(files);
      expect(listed.map((f) => f.path)).toEqual(files.map((f) => f.path));
      expect(listed.flatMap((f) => f.lines).join("").length).toBeLessThanOrEqual(24_000);
    });

    // A check started through a launcher routes by the program the launcher runs (#1507): bench
    // round 42 wrote the Maven check as `cmd /c mvn -B -q verify`, and 7 of 7 features got no
    // task-end test check and no mutation gate.
    for (const [launcher, wrap] of LAUNCHERS)
      cell(stack, `written-tests-check and test-check behind ${launcher}`, () => {
        const path = fixture.property.path;
        const root = project({ ...fixture.files, [path]: fixture.property.seeded });
        const checks = preselected().map((c) => ({ ...c, ...wrap(c.executable, c.args) }));
        expect(checks.some((c) => c.required && isTestCheck(c))).toBe(true);
        const written = writtenTestsCheck(root, checks, [{ path, action: "create" }]);
        if (!WRITTEN_TEST_ARGS[stack]) return expect(written).toBeNull();
        expect(written?.executable).toBe(launcher.split(" ")[0]);
        expect(launchedCommand(written?.executable ?? "", written?.args ?? []).args).toEqual(WRITTEN_TEST_ARGS[stack]);
      });

    // Whole-unit checks fail in a task's worktree until sibling tasks' files exist, so they run at
    // integration; file-local static checks run per task (#799, #842).
    cell(stack, "per-task-or-integration", () => {
      const checks = preselected();
      expect(checks.filter(isWholeUnitCheck).map((c) => c.id)).toEqual(fixture.wholeUnit);
      for (const check of checks.filter((c) => isTestCheck(c))) {
        expect(isStaticCheck(check)).toBe(false);
      }
    });

    cell(stack, "same-assertion-pending-repair (#1612)", () => {
      const source: Task = { id: "T001", title: "Source", description: "Source", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Fixture" };
      const tests: Task = { ...source, id: "T003", dependsOn: [source.id], writes: [{ path: fixture.property.path, action: "create" }] };
      const repair: Task = { ...source, id: "T006", origin: "repair", findingIds: ["F1"] };
      const graph = { schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [source, tests, repair] };
      const rows = [{ id: source.id, status: "verified" }, { id: tests.id, status: "running" }, { id: repair.id, status: "pending" }] as TaskRow[];
      const failure = stack === "dotnet" ? (name: string) => `Failed ${name}.Order [8 ms]\nAssert.Equal() Failure: Collections differ\nExpected: [removed, changed]\nActual: [changed, removed]`
        : ASSERTION_FAILURES[stack as keyof typeof ASSERTION_FAILURES] ?? ASSERTION_FAILURES.bun;
      expect(failureOwner(graph, rows, {}, tests, failure("Caller"), { pendingFindings: [{ taskId: repair.id, output: failure("Differ") }] })).toMatchObject({ kind: "pending", owners: [repair.id] });
      expect(failureOwner(graph, rows, {}, tests, failure("Caller"), { pendingFindings: [] }).kind).not.toBe("pending");
    });

    cell(stack, "pending-test-update-owner (#1563)", () => {
      const path = fixture.property.path;
      const source: Task = { id: "T001", title: "Source", description: "Source", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Fixture" };
      const updater: Task = { ...source, id: "T002", dependsOn: [source.id], writes: [{ path, action: "modify" }] };
      const graph = { schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [source, updater] };
      const rows = [{ id: source.id, status: "implemented" }, { id: updater.id, status: "pending" }] as TaskRow[];
      const output = stack === "maven" ? "[ERROR] com.example.SumTest.commutes:42 expected result"
        : stack === "dotnet" ? "Failed SumTests.Commutes [8 ms]"
        : stack === "go" ? "--- FAIL: TestSum (0.00s)\n    sum_test.go:42: wrong result"
        : stack === "rust" ? "thread 'sum' panicked at tests/sum.rs:42:5"
        : `FAIL ${path}:42: wrong result`;
      expect(failureOwner(graph, rows, {}, source, output)).toMatchObject({ kind: "test-update", owners: [updater.id] });
      expect(failureOwner(graph, [{ ...rows[1], status: "verified" }] as TaskRow[], {}, source, output).kind).not.toBe("test-update");
    });

    // `allowNewDependencies: false` relies on this to see a dependency added to the stack's
    // manifest (#802).
    // A failed linter, formatter or type checker is corrected in the files its output names,
    // without their tests and without the planned task's whole scope; a test gate is not (#1067).
    cell(stack, "lint-corrective-scope", () => {
      const correction = (check: Check): boolean => {
        const store = {
          findings: () => [{ id: "F1", body_json: JSON.stringify({ claim: `Task T001 required check ${check.id} failed` }) }],
        } as unknown as WorkflowStore;
        const task = { origin: "repair", findingIds: ["F1"] } as Task;
        return staticCorrection(store, "run", { checks: [check] } as RunPolicy, task);
      };
      expect(preselected().filter(correction).map((c) => c.id)).toEqual(STATIC_FIXES[stack]);
    });

    cell(stack, "dependency-check", () => {
      const { declared } = addedDependencies([
        { path: fixture.manifest.path, before: fixture.manifest.before, content: fixture.manifest.after },
      ]);
      expect(declared.map((d) => d.name)).toContain(fixture.manifest.added);
    });

    // A project that forbids new dependencies can still satisfy the property-test gate with a
    // seeded generator in its own test framework (#796).
    cell(stack, "property-tests", () => {
      expect(propertyTestKind(fixture.property.path, fixture.property.seeded)).toBe("seeded");
      expect(propertyTestKind(fixture.property.path, fixture.property.library)).toBe("library");
    });

    // A request that forbids random input still gets a property test: a loop over every value of
    // a bounded domain counts (#1064: cidrfold-update looped over all 256 masks and was refused).
    cell(stack, "property-tests-exhaustive", () => {
      expect(propertyTestKind(fixture.property.path, fixture.property.exhaustive)).toBe("exhaustive");
    });

    cell(stack, "mutation-tool", () => {
      const mutation = fixture.mutation;
      const source = { path: mutation?.source ?? "src/Sum.cs", content: "x\n", before: null };
      if (!mutation) {
        expect(detectMutationTool([source], shell(project(fixture.files), []))).toBeNull();
        return;
      }
      const installed = project({ ...fixture.files, ...mutation.files });
      expect(detectMutationTool([source], shell(installed, mutation.on))?.tool).toBe(
        mutation.tool as never,
      );
      // Without the tool the built-in engine runs: detection never invents one.
      expect(detectMutationTool([source], shell(project(fixture.files), []))).toBeNull();
    });
  });
}

// --- Rule pack -------------------------------------------------------------------------------

/**
 * A placeholder body in each stack's language, and an ordinary error whose message mentions a
 * todo, which a todo app writes on purpose (#845).
 */
const STUBS: Record<Stack, { path: string; placeholder: string; ordinary: string }> = {
  bun: {
    path: "src/sum.ts",
    placeholder: '  throw new Error("not implemented");',
    ordinary: '  throw new Error("Todo with id 3 does not exist");',
  },
  npm: {
    path: "src/sum.js",
    placeholder: '  throw new Error("TODO");',
    ordinary: '  throw new Error("Todo 3 not found");',
  },
  python: {
    path: "fixture/sum.py",
    // A Python stub is only a placeholder as a function's whole body (#937).
    placeholder: "def total(values):\n    raise NotImplementedError",
    ordinary: '    raise KeyError("Todo 3 does not exist")',
  },
  go: {
    path: "sum.go",
    placeholder: '\tpanic("not implemented")',
    ordinary: '\tpanic("todo list is empty")',
  },
  rust: {
    path: "src/lib.rs",
    placeholder: "    todo!()",
    ordinary: '    panic!("todo {} not found: {}", id, reason)',
  },
  maven: {
    path: "src/main/java/fixture/Sum.java",
    placeholder: "        throw new UnsupportedOperationException();",
    ordinary: '        throw new IllegalStateException("Todo 3 does not exist");',
  },
  dotnet: {
    path: "src/Sum.cs",
    placeholder: "        throw new NotImplementedException();",
    ordinary: '        throw new KeyNotFoundException("Todo 3 does not exist");',
  },
};

/**
 * A catch that returns the null or false its function's declared type announces, and one that
 * returns a default the type does not announce, in each stack with brace catches (#1192).
 */
const FALLBACKS: Partial<Record<Stack, { path: string; typed: string; silent: string }>> = {
  bun: {
    path: "src/url.ts",
    typed: "export function parseUrl(raw: string): URL | null {\n  try {\n    return new URL(raw);\n  } catch {\n    return null;\n  }\n}",
    silent: "export function parseUrl(raw: string) {\n  try {\n    return new URL(raw);\n  } catch {\n    return null;\n  }\n}",
  },
  npm: {
    path: "src/url.js",
    typed: "/** @returns {boolean} */\nexport function isUrl(raw) {\n  try { new URL(raw); return true; } catch { return false; }\n}",
    silent: "export function isUrl(raw) {\n  try { new URL(raw); return true; } catch { return false; }\n}",
  },
  maven: {
    path: "src/main/java/fixture/Urls.java",
    typed: "    static boolean isUrl(String raw) {\n        try {\n            new java.net.URI(raw);\n            return true;\n        } catch (Exception e) {\n            return false;\n        }\n    }",
    silent: "    static String host(String raw) {\n        try {\n            return new java.net.URI(raw).getHost();\n        } catch (Exception e) {\n            return \"\";\n        }\n    }",
  },
  dotnet: {
    path: "src/Urls.cs",
    typed: "    static bool IsUrl(string raw) {\n        try {\n            new Uri(raw);\n            return true;\n        } catch (Exception) {\n            return false;\n        }\n    }",
    silent: "    static string Host(string raw) {\n        try {\n            return new Uri(raw).Host;\n        } catch (Exception) {\n            return \"\";\n        }\n    }",
  },
};

for (const stack of STACKS) {
  const stub = STUBS[stack];
  const placeholders = (line: string) =>
    checkBuiltinRules([{ path: stub.path, content: `${line}\n`, before: null }], {}).filter(
      (f) => f.rule === "placeholder-body",
    );
  describe(`gate matrix: ${stack} rule pack`, () => {
    cell(stack, "rule-pack: placeholder-body", () => {
      expect(placeholders(stub.placeholder).map((f) => f.blocking)).toEqual([true]);
      expect(placeholders(stub.ordinary)).toEqual([]);
    });

    const fallback = FALLBACKS[stack];
    if (fallback)
      cell(stack, "rule-pack: catch-return-default", () => {
        const found = (content: string) =>
          checkBuiltinRules([{ path: fallback.path, content: `${content}\n`, before: null }], {})
            .filter((f) => f.rule === "catch-return-default")
            .map((f) => f.blocking);
        // A JSDoc type is not a declared return type: plain JavaScript keeps the finding.
        expect(found(fallback.typed)).toEqual(stack === "npm" ? [true] : []);
        expect(found(fallback.silent)).toEqual([true]);
      });

    // A correction that leaves the same match is kept as a limitation instead of asking again;
    // the earlier round's claim must read back to the same key, wherever the line moved (#845).
    cell(stack, "rule-pack: same match after a correction", () => {
      const [found] = checkBuiltinRules(
        [{ path: stub.path, content: `${stub.ordinary}\n${stub.placeholder}\n`, before: null }],
        {},
      ).filter((f) => f.rule === "placeholder-body");
      const finding = found ?? {
        rule: "placeholder-body",
        message: "The body is a placeholder, not an implementation",
        file: stub.path,
        line: 2,
        text: stub.placeholder.trim(),
      };
      const key = ruleFindingKey(finding);
      expect(ruleClaimKey(ruleClaimText(finding))).toBe(key);
      expect(ruleClaimKey(ruleClaimText({ ...finding, line: finding.line + 7 }))).toBe(key);
    });
  });
}

/**
 * The task-end syntax gate (#977): a source file of each stack that does not parse, with the line
 * the gate must name, and the same file fixed, which must pass.
 */
const SYNTAX: Record<Stack, { path: string; valid: string; broken: string; line: number }> = {
  bun: {
    path: "src/sum.ts",
    valid: "export const sum = <T extends number>(a: T, b: T): number => a + b;\n",
    broken: "export const sum = (a: number, b: number): number => {\n  return a + ;\n};\n",
    line: 2,
  },
  npm: {
    path: "src/sum.js",
    valid: "export const sum = (a, b) => a + b;\n",
    broken: "export const sum = (a, b) => {\n  return [a, b;\n};\n",
    line: 2,
  },
  python: {
    path: "fixture/sum.py",
    valid: "def total(a: int, b: int) -> int:\n    return a + b\n",
    broken: "def total(a: int, b: int) -> int:\n    return (a + b\n\nx = 1\n",
    line: 2,
  },
  go: {
    path: "sum.go",
    valid: "package fixture\n\nfunc Sum(a, b int) int { return a + b }\n",
    broken: "package fixture\n\nfunc Sum(a, b int) int {\n\treturn a + b +\n}\n",
    line: 4,
  },
  rust: {
    path: "src/lib.rs",
    valid: "pub fn sum(a: i32, b: i32) -> i32 {\n    a + b\n}\n",
    broken: "pub fn sum(a: i32, b: i32) -> i32 {\n    let s = \u201cx\u201d;\n    a + b\n}\n",
    line: 2,
  },
  maven: {
    path: "src/main/java/fixture/Sum.java",
    valid: "package fixture;\n\npublic class Sum {\n    int sum(int a, int b) { return a + b; }\n}\n",
    broken: "package fixture;\n\npublic class Sum {\n    int sum(int a, int b) { return a + b }\n}\n",
    line: 4,
  },
  dotnet: {
    path: "src/Sum.cs",
    valid: "namespace Fixture;\n\npublic static class Sum\n{\n    public static int Of(int a, int b) => a + b;\n}\n",
    broken: "namespace Fixture;\n\npublic static class Sum\n{\n    public static int Of(int a, int b) => a + ;\n}\n",
    line: 5,
  },
};

// --- Test integrity ----------------------------------------------------------------------

/**
 * A test that checks parts of the output (a prefix, a count, a final row), and the same test
 * strengthened to one comparison with the full expected output: fewer assertions, more expected
 * text. A correction of a test-strength finding writes the second (#1481).
 */
const STRENGTHENED: Record<Stack, { path: string; loose: string; strict: string }> = {
  bun: {
    path: "tests/table.test.ts",
    loose: 'test("table", () => {\n  expect(out).toContain("1 | one");\n  expect(out).toContain("2 | two");\n  expect(out.length).toBe(17);\n});\n',
    strict: 'test("table", () => {\n  expect(out).toBe("1 | one\\n2 | two\\n3 | three\\n");\n});\n',
  },
  npm: {
    path: "test/table.test.js",
    loose: 'test("table", () => {\n  assert.ok(out.startsWith("1 | one"));\n  assert.ok(out.endsWith("3 | three"));\n});\n',
    strict: 'test("table", () => {\n  assert.strictEqual(out, "1 | one\\n2 | two\\n3 | three");\n});\n',
  },
  python: {
    path: "tests/test_table.py",
    loose: 'def test_table():\n    assert out.startswith("1 | one")\n    assert out.count("\\n") == 3\n',
    strict: 'def test_table():\n    assert out == """1 | one\n2 | two\n3 | three\n"""\n',
  },
  go: {
    path: "table_test.go",
    loose: 'func TestTable(t *testing.T) {\n\tif !strings.HasPrefix(out, "1 | one") {\n\t\tt.Errorf("prefix")\n\t}\n\tif strings.Count(out, "\\n") != 3 {\n\t\tt.Errorf("rows")\n\t}\n}\n',
    strict: 'func TestTable(t *testing.T) {\n\twant := `1 | one\n2 | two\n3 | three\n`\n\tif out != want {\n\t\tt.Errorf("got %q", out)\n\t}\n}\n',
  },
  rust: {
    path: "tests/table.rs",
    loose: '#[test]\nfn table() {\n    assert!(out.starts_with("1 | one"));\n    assert_eq!(out.lines().count(), 3);\n}\n',
    strict: '#[test]\nfn table() {\n    assert_eq!(out, "1 | one\\n2 | two\\n3 | three\\n");\n}\n',
  },
  maven: {
    path: "src/test/java/fixture/TableTest.java",
    loose: '    @Test\n    void table() {\n        assertTrue(out.startsWith("1 | one"));\n        assertEquals(3, out.lines().count());\n    }\n',
    strict: '    @Test\n    void table() {\n        assertEquals("1 | one\\n2 | two\\n3 | three\\n", out);\n    }\n',
  },
  dotnet: {
    path: "tests/TableTests.cs",
    loose: '    [Fact]\n    public void Table()\n    {\n        Assert.StartsWith("1 | one", output);\n        Assert.Equal(3, output.Split("\\n").Length);\n    }\n',
    strict: '    [Fact]\n    public void Table()\n    {\n        Assert.Equal("1 | one\\n2 | two\\n3 | three\\n", output);\n    }\n',
  },
};

for (const stack of STACKS) {
  const sample = STRENGTHENED[stack];
  const rules = (strengthens: string[], after = sample.strict) =>
    scanTestIntegrity([{ path: sample.path, before: sample.loose, after }], {
      strengthens: new Set(strengthens),
    }).map((f) => f.rule);
  describe(`gate matrix: ${stack} test integrity`, () => {
    cell(stack, "test integrity: strengthened test of a test-strength finding passes", () => {
      expect(rules([sample.path])).toEqual([]);
    });
    cell(stack, "test integrity: the same edit without that finding is flagged", () => {
      expect(rules([])).toEqual(["assertions"]);
    });
    cell(stack, "test integrity: fewer assertions with less expected text are flagged", () => {
      // The loose test with its last assertion removed: weaker, not stronger.
      const lines = sample.loose.split("\n");
      const last = lines.findLastIndex((line) => /assert|expect\(|Errorf/i.test(line));
      const weaker = lines.filter((_, i) => i !== last).join("\n");
      expect(rules([sample.path], weaker)).toContain("assertions");
    });
  });
}

/**
 * A test file with two tests of one assertion each, by name, the first checking `v`. A correction
 * that swaps the first for a weaker test under another name keeps every total (#1519); one that
 * only retitles it keeps its body (#1532).
 */
const NAMED: Record<Stack, { path: string; file: (names: [string, string], v?: number) => string }> = {
  bun: {
    path: "tests/primes.test.ts",
    file: ([a, b], v = 1) => `test("${a}", () => {\n  expect(run()).toBe(${v});\n});\ntest("${b}", () => {\n  expect(run()).toBe(2);\n});\n`,
  },
  npm: {
    path: "test/primes.test.js",
    file: ([a, b], v = 1) => `it("${a}", () => {\n  assert.strictEqual(run(), ${v});\n});\nit("${b}", () => {\n  assert.strictEqual(run(), 2);\n});\n`,
  },
  python: {
    path: "tests/test_primes.py",
    file: ([a, b], v = 1) => `def test_${a}():\n    assert run() == ${v}\n\n\ndef test_${b}():\n    assert run() == 2\n`,
  },
  go: {
    path: "primes_test.go",
    file: ([a, b], v = 1) => `func Test${a}(t *testing.T) {\n\tif run() != ${v} {\n\t\tt.Errorf("want ${v}")\n\t}\n}\n\nfunc Test${b}(t *testing.T) {\n\tif run() != 2 {\n\t\tt.Errorf("want 2")\n\t}\n}\n`,
  },
  rust: {
    path: "tests/primes.rs",
    file: ([a, b], v = 1) => `#[test]\nfn ${a}() {\n    assert_eq!(run(), ${v});\n}\n\n#[test]\nfn ${b}() {\n    assert_eq!(run(), 2);\n}\n`,
  },
  maven: {
    path: "src/test/java/fixture/PrimesTest.java",
    file: ([a, b], v = 1) => `    @Test\n    void ${a}() {\n        assertEquals(${v}, run());\n    }\n\n    @Test\n    @DisplayName("second")\n    void ${b}() {\n        assertEquals(2, run());\n    }\n`,
  },
  dotnet: {
    path: "tests/PrimesTests.cs",
    file: ([a, b], v = 1) => `    [Fact]\n    public void ${a}()\n    {\n        Assert.Equal(${v}, Run());\n    }\n\n    [Theory]\n    [InlineData(2)]\n    public async Task ${b}(int n)\n    {\n        Assert.Equal(n, await Run());\n    }\n`,
  },
};

for (const stack of STACKS) {
  const sample = NAMED[stack];
  const before = sample.file(["intervalWorkload", "scalarCases"]);
  const swapped = sample.file(["literalCases", "scalarCases"], 3);
  const renamed = sample.file(["serializedLocation", "scalarCases"]);
  const scan = (after: string | null, options: Parameters<typeof scanTestIntegrity>[1] = {}) =>
    scanTestIntegrity([{ path: sample.path, before, after }], options);
  const name = (base: string) => (stack === "python" ? `test_${base}` : stack === "go" ? `Test${base}` : base);
  const protects = new Map([[sample.path, new Map([[name("intervalWorkload"), "T011 for finding F1"]])]]);
  describe(`gate matrix: ${stack} test identity`, () => {
    cell(stack, "test identity: explicit spec removal overrides sibling protection only for named tests", () => {
      const marker = { bun: 'test("scalarCases"', npm: 'it("scalarCases"', python: "def test_scalarCases", go: "func TestscalarCases", rust: "#[test]\nfn scalarCases", maven: '    @Test\n    @DisplayName', dotnet: "    [Theory]" }[stack];
      const after = before.slice(before.indexOf(marker));
      const finding = { basis: "spec", file: sample.path, claim: "The spec assigns this test to another module", suggestedFix: `Remove ${name("intervalWorkload")}` };
      expect(scan(after, { protects, removalFindings: [finding] })).toEqual([]);
      expect(scan(after, { protects, removalFindings: [{ ...finding, basis: "inferred" }] }).map((f) => f.rule)).toContain("test-removed");
      expect(scan("", { protects, removalFindings: [finding] }).map((f) => f.rule)).toContain("test-count");
      expect(scan(null, { protects, removalFindings: [finding] }).map((f) => f.rule)).toContain("test-deleted");
      expect(scan(null, { protects, removalFindings: [{ ...finding, suggestedFix: `Remove all tests from ${sample.path}` }] })).toEqual([]);
    });
    cell(stack, "test identity: a test swapped for another under a new name is flagged", () => {
      const found = scan(swapped);
      expect(found.map((f) => f.rule)).toEqual(["test-removed"]);
      expect(found[0]?.detail).toContain(JSON.stringify(name("intervalWorkload")));
    });
    cell(stack, "test identity: an added test and an edited body pass", () => {
      expect(scan(before.replace("1", "3"))).toEqual([]);
      expect(testChanges({ path: sample.path, before, after: swapped })).toEqual({ added: [name("literalCases")], renamed: {} });
    });
    cell(stack, "test identity: a test another finding's correction added stays, whatever the finding asks", () => {
      const found = scan(swapped, { protects, rewrites: new Set([sample.path]) });
      expect(found.map((f) => f.rule)).toEqual(["test-removed"]);
      expect(found[0]?.detail).toContain("which T011 for finding F1 added");
      expect(found[0]?.keep).toEqual([name("intervalWorkload")]);
      expect(scan(swapped, { rewrites: new Set([sample.path]) })).toEqual([]);
    });
    cell(stack, "test identity: a test retitled with its body kept is not removed, protected or not", () => {
      expect(scan(renamed)).toEqual([]);
      expect(scan(renamed, { protects })).toEqual([]);
      expect(testChanges({ path: sample.path, before, after: renamed })).toEqual({ added: [], renamed: { [name("intervalWorkload")]: name("serializedLocation") } });
    });
  });
}

/** The build command a process test of the stack runs before it starts the program (#1661). */
const PROCESS_BUILD: Record<Stack, string> = {
  bun: "bun run build",
  npm: "npm run build",
  python: "python -m build",
  go: "go build -o BIN ../..",
  rust: "cargo build",
  maven: "mvn package",
  dotnet: "dotnet build",
};

for (const stack of STACKS) {
  const checks = () => detectGates(project(FIXTURES[stack].files)).filter((s) => s.preselected).map((s) => s.check);
  const criterion = (given: string, when: string, then: string) => ({
    ...fixtureSpec,
    criteria: [{ ...fixtureSpec.criteria[0]!, id: "AC-009", given, when, then }],
  });
  describe(`gate matrix: ${stack} build criteria`, () => {
    cell(stack, "build criteria: a process test that builds the program is proven by the stack's checks", () => {
      const spec = criterion("the sole process test", `it runs \`${PROCESS_BUILD[stack]}\` and then the built program`, "the program prints the tree");
      expect(uncontractedBuildCriteria(spec, checks())).toEqual([]);
    });
    cell(stack, "build criteria: a production build is proven only where a check compiles the project", () => {
      const spec = criterion("the release", "it is prepared", "the production build succeeds");
      const compiled = stack === "go" || stack === "rust" || stack === "maven" || stack === "dotnet";
      expect(uncontractedBuildCriteria(spec, checks())).toEqual(compiled ? [] : ["AC-009"]);
    });
  });
}

/**
 * A test file in a framework style the guard read only by name (#1651): FluentAssertions, Go
 * subtests, tokio and rstest tests. A corrective that drops one assertion or one test is flagged.
 */
const FRAMEWORK_STYLE: Partial<Record<Stack, { path: string; file: string; assertion: string; test: string; name: string }>> = {
  dotnet: {
    path: "tests/PrimesTests.cs",
    file: `    [Fact]\n    public void Primes()\n    {\n        Run(2).Should().BeTrue();\n        Run(4).Should().BeFalse();\n    }\n\n    [Fact]\n    public void Composites()\n    {\n        Run(9).Should().BeFalse();\n    }\n`,
    assertion: "        Run(4).Should().BeFalse();\n",
    test: `\n    [Fact]\n    public void Composites()\n    {\n        Run(9).Should().BeFalse();\n    }\n`,
    name: "Composites",
  },
  go: {
    path: "primes_test.go",
    file: `func TestPrimes(t *testing.T) {\n\tt.Run("two", func(t *testing.T) {\n\t\trequire.True(t, run(2))\n\t\trequire.False(t, run(4))\n\t})\n\tt.Run("nine", func(t *testing.T) {\n\t\trequire.False(t, run(9))\n\t})\n}\n`,
    assertion: "\t\trequire.False(t, run(4))\n",
    test: `\tt.Run("nine", func(t *testing.T) {\n\t\trequire.False(t, run(9))\n\t})\n`,
    name: "TestPrimes/nine",
  },
  rust: {
    path: "tests/primes.rs",
    file: `#[tokio::test(flavor = "multi_thread")]\nasync fn primes() {\n    assert!(run(2).await);\n    assert!(!run(4).await);\n}\n\n#[rstest]\nfn composites() {\n    assert!(!block_on(run(9)));\n}\n`,
    assertion: "    assert!(!run(4).await);\n",
    test: `\n#[rstest]\nfn composites() {\n    assert!(!block_on(run(9)));\n}\n`,
    name: "composites",
  },
};

for (const stack of STACKS) {
  const sample = FRAMEWORK_STYLE[stack];
  if (!sample) continue;
  const scan = (after: string) => scanTestIntegrity([{ path: sample.path, before: sample.file, after }]);
  describe(`gate matrix: ${stack} framework styles`, () => {
    cell(stack, "framework styles: a corrective that removes an assertion is flagged", () => {
      expect(scan(sample.file.replace(sample.assertion, "")).map((f) => f.rule)).toEqual(["assertions"]);
    });
    cell(stack, "framework styles: a corrective that removes a test is flagged by name", () => {
      const found = scan(sample.file.replace(sample.test, ""));
      expect(found.map((f) => f.rule)).toContain("test-count");
      expect(found[0]?.detail).toContain(JSON.stringify(sample.name));
    });
  });
}

for (const stack of STACKS) {
  const sample = SYNTAX[stack];
  describe(`gate matrix: ${stack} syntax gate`, () => {
    cell(stack, "syntax gate: valid file passes", async () => {
      expect(await syntaxErrors(sample.path, sample.valid)).toEqual([]);
    });
    cell(stack, "syntax gate: broken file is refused at its line", async () => {
      const errors = await syntaxErrors(sample.path, sample.broken);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.line).toBe(sample.line);
    });
  });
}

// --- Layout check (#1262) --------------------------------------------------------------------

/** The layout check's decision on a measured page; it does not depend on the stack serving it. */
const page = (scrollWidth: number, httpStatus: number | null = 200): LayoutResult => ({
  status: "measured",
  width: 1280,
  height: 800,
  pages: [{ path: "/", httpStatus, scrollWidth, clientWidth: 1265, overflowing: [] }],
});

for (const stack of STACKS) {
  describe(`gate matrix: ${stack} layout check`, () => {
    cell(stack, "layout check: page that fits passes", () => {
      expect(layoutVerdict(page(1265)).passed).toBe(true);
    });
    cell(stack, "layout check: page wider than the viewport fails", () => {
      expect(layoutVerdict(page(1266))).toMatchObject({ passed: false });
    });
    cell(stack, "layout check: error page fails", () => {
      expect(layoutVerdict(page(1265, 500)).passed).toBe(false);
    });
    cell(stack, "layout check: no browser is not a pass", () => {
      expect(layoutVerdict({ status: "unavailable", reason: "missing dependency" }).passed).toBe(
        false,
      );
    });
  });
}

// --- Worktree mode ---------------------------------------------------------------------------

/** Dependencies installed in the working copy only, as `bun install` or `npm install` leaves them. */
const INSTALLED: Partial<Record<Stack, Record<string, string>>> = {
  bun: { "node_modules/fast-check/package.json": '{"name":"fast-check"}' },
  npm: { "node_modules/fast-check/package.json": '{"name":"fast-check"}' },
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "", GIT_CONFIG_SYSTEM: "", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

interface Worktrees {
  /** The working copy, where the user installed the dependencies. */
  workspace: string;
  /** The run worktree (mutation and property gates) and a task worktree (per-task checks). */
  roots: { name: "run" | "task"; root: string }[];
}

/**
 * The fixture committed in a repository, its dependencies installed but ignored, then the run
 * worktree and a task worktree created as the scheduler creates them.
 */
async function worktrees(files: Record<string, string>, installed: Record<string, string>): Promise<Worktrees> {
  const workspace = project({ ...files, ...installed, ".gitignore": ".baked/\nnode_modules/\n" });
  git(workspace, "init", "-q", "-b", "main");
  git(workspace, "config", "user.name", "Matrix");
  git(workspace, "config", "user.email", "matrix@example.test");
  git(workspace, "config", "commit.gpgsign", "false");
  git(workspace, "add", "-A");
  git(workspace, "commit", "-q", "-m", "Scaffold");
  const runId = "gate-matrix";
  const state = {} as RuntimeState;
  const store = {
    workspace,
    run: () => ({ created_at: 1_700_000_000_000 }),
    state: () => state,
    saveState: (_id: string, next: RuntimeState) => Object.assign(state, next),
    transaction: <T>(action: () => T): T => action(),
    artifact: () => ({}),
  } as unknown as WorkflowStore;
  const run = await ensureRunWorktree(store, runId);
  const base = await runContentCommit(store, runId, run);
  const task = await createTaskWorktree(store, runId, "T001", base);
  return {
    workspace,
    roots: [
      { name: "run", root: join(workspace, run.path) },
      { name: "task", root: join(workspace, task) },
    ],
  };
}

for (const stack of STACKS) {
  const fixture = FIXTURES[stack];
  const installed = { ...INSTALLED[stack] };
  for (const [path, content] of Object.entries(fixture.mutation?.files ?? {}))
    if (path.startsWith("node_modules/")) installed[path] = content;
  const committed = Object.fromEntries(
    Object.entries({ ...fixture.files, ...fixture.mutation?.files }).filter(
      ([path]) => !path.startsWith("node_modules/"),
    ),
  );
  describe(`gate matrix: ${stack} in worktree mode`, () => {
    let setup: Worktrees;
    beforeAll(async () => {
      setup = await worktrees(committed, installed);
    });
    const preselected = (root: string) =>
      detectGates(root)
        .filter((s) => s.preselected)
        .map((s) => s.check);

    cell(stack, "worktree: dependencies linked", () => {
      for (const { root } of setup.roots) {
        expect(existsSync(join(root, ".git"))).toBe(true);
        expect(existsSync(join(root, "node_modules"))).toBe(Object.keys(installed).length > 0);
        if (Object.keys(installed).length)
          expect(lstatSync(join(root, "node_modules")).isSymbolicLink()).toBe(true);
      }
    });

    cell(stack, "worktree: detection", () => {
      const plain = preselected(setup.workspace);
      for (const { root } of setup.roots) {
        const checks = preselected(root);
        expect(checks.map((c) => c.id)).toEqual(fixture.gates);
        expect(checks).toEqual(plain);
      }
    });

    cell(stack, "worktree: test-check and per-task-or-integration", () => {
      for (const { root } of setup.roots) {
        const checks = preselected(root);
        expect(checks.some((c) => c.required && isTestCheck(c))).toBe(true);
        expect(checks.filter(isWholeUnitCheck).map((c) => c.id)).toEqual(fixture.wholeUnit);
        for (const check of checks.filter((c) => isTestCheck(c))) expect(isStaticCheck(check)).toBe(false);
      }
    });

    // The task adds a dependency to the manifest it checked out; the baseline is the scaffold's.
    cell(stack, "worktree: dependency-check", () => {
      const task = setup.roots.find((r) => r.name === "task")?.root ?? "";
      const path = fixture.manifest.path;
      const before = readFileSync(join(task, path), "utf8");
      expect(git(task, "status", "--porcelain", "--", path)).toBe("");
      writeFileSync(join(task, path), fixture.manifest.after);
      const { declared } = addedDependencies([
        { path, before, content: readFileSync(join(task, path), "utf8") },
      ]);
      writeFileSync(join(task, path), before);
      expect(declared.map((d) => d.name)).toContain(fixture.manifest.added);
    });

    // The scheduler's tool shell reads the run root; Stryker sits in the linked node_modules,
    // which used to throw "Path escapes workspace" (#835).
    cell(stack, "worktree: mutation-tool", () => {
      const mutation = fixture.mutation;
      const source = { path: mutation?.source ?? "src/Sum.cs", content: "x\n", before: null };
      for (const { root } of setup.roots) {
        const tools = { ...shell(root, mutation?.on ?? []), ...toolShellFiles(root) };
        const found = detectMutationTool([source], tools)?.tool ?? null;
        expect(found).toBe((mutation?.tool ?? null) as never);
      }
    });

    // The property-library probe reads the same linked node_modules (#796, #835).
    cell(stack, "worktree: property-libraries", () => {
      const probe = (root: string) => propertyLibraries({ ...libraryFiles(root), pythonImports: () => null });
      const plain = probe(setup.workspace);
      expect(plain["JS/TS"]).toBe(Boolean(INSTALLED[stack]));
      for (const { root } of setup.roots) expect(probe(root)).toEqual(plain);
    });

    // The baseline is measured in the run worktree; a later failure may name a task worktree or the
    // working copy behind the linked node_modules, and is still the same failure (#1055).
    cell(stack, "worktree: baseline-signature", () => {
      const run = setup.roots.find((r) => r.name === "run")?.root ?? "";
      const failure = (root: string) => `Error: boom\n    at ${join(root, "src", "a")}:3:7`;
      const expected = failureSignature(failure(run), run);
      expect(expected).toContain("<root>");
      for (const root of [setup.workspace, ...setup.roots.map((r) => r.root)])
        expect(failureSignature(failure(root), run)).toBe(expected);
    });

    // Under staticBaseline "relative" a diagnostic from before the run is debt in every worktree,
    // whichever one printed its absolute path; one in a file the run changes never is (#1222).
    cell(stack, "worktree: baseline-debt", () => {
      const run = setup.roots.find((r) => r.name === "run")?.root ?? "";
      const lint = (root: string) => `${join(root, "lib", "old.py")}:1:1: E501 Line too long\nFound 1 error.`;
      const baseline = baselineKeys(lint(run), run);
      expect(baseline).toEqual(["lib/old.py|E# Line too long"]);
      for (const root of [setup.workspace, ...setup.roots.map((r) => r.root)]) {
        expect(baselineDebt(lint(root), run, { baseline, changed: [], summary: 1 })).toEqual(baseline);
        expect(baselineDebt(lint(root), run, { baseline, changed: ["lib/old.py"], summary: 1 })).toBeNull();
      }
    });

    // A linter that fails on an unplanned file before the run still fails the same way after a task
    // adds files: its summary count is not part of the failure (dur 741547f0, #1218).
    cell(stack, "worktree: baseline-signature lint summary", () => {
      const run = setup.roots.find((r) => r.name === "run")?.root ?? "";
      const lint = (root: string, files: number) =>
        `${join(root, "biome.json")} format\n  × Formatter would have printed the following content:\nChecked ${files} files in 3ms. No fixes applied.\nFound 1 error.`;
      const expected = failureSignature(lint(run, 1), run);
      for (const root of [setup.workspace, ...setup.roots.map((r) => r.root)])
        expect(failureSignature(lint(root, 4), run)).toBe(expected);
    });
  });
}

// --- Toolchain tier --------------------------------------------------------------------------

/** Minimal valid projects whose detected gates should all pass with the real tools. */
const RUNNABLE: Partial<
  Record<Stack, { files: Record<string, string>; needs: string[][]; written?: string }>
> = {
  bun: {
    files: {
      "package.json": JSON.stringify({ name: "fixture", private: true, scripts: { test: "bun test" } }),
      "bun.lock": '{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "fixture",\n    },\n  },\n  "packages": {},\n}\n',
      "sum.ts": "export const sum = (a: number, b: number): number => a + b;\n",
      "sum.test.ts":
        'import { expect, test } from "bun:test";\nimport { sum } from "./sum";\n\ntest("sum", () => {\n  expect(sum(1, 2)).toBe(3);\n});\n',
    },
    needs: [["bun", "--version"]],
  },
  python: {
    files: {
      "pyproject.toml":
        "[project]\nname = 'fixture'\nversion = '0.1.0'\n\n[tool.ruff]\nline-length = 100\n\n[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
      "fixture/__init__.py": "",
      "fixture/sum.py": "def add(a: int, b: int) -> int:\n    return a + b\n",
      "tests/test_sum.py": "from fixture.sum import add\n\n\ndef test_add() -> None:\n    assert add(1, 2) == 3\n",
    },
    needs: [
      ["python3", "-m", "pytest", "--version"],
      ["ruff", "--version"],
    ],
  },
  go: {
    files: {
      "go.mod": "module example.com/fixture\n\ngo 1.22\n",
      "sum.go": "package fixture\n\n// Sum adds two numbers.\nfunc Sum(a, b int) int {\n\treturn a + b\n}\n",
      "sum_test.go":
        'package fixture\n\nimport "testing"\n\nfunc TestSum(t *testing.T) {\n\tif Sum(1, 2) != 3 {\n\t\tt.Fatal("sum")\n\t}\n}\n',
    },
    needs: [["go", "version"]],
  },
  rust: {
    files: {
      "Cargo.toml": '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
      "src/lib.rs":
        "pub fn sum(a: i32, b: i32) -> i32 {\n    a + b\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn adds() {\n        assert_eq!(sum(1, 2), 3);\n    }\n}\n",
      "tests/sum.rs": "#[test]\nfn sum_adds() {\n    assert_eq!(fixture::sum(1, 2), 3);\n}\n",
    },
    written: "tests/sum.rs",
    needs: [
      ["cargo", "--version"],
      ["cargo", "fmt", "--version"],
      ["cargo", "clippy", "--version"],
    ],
  },
  maven: {
    files: {
      "pom.xml": `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>fixture</artifactId>
  <version>0.1.0</version>
  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.5</version>
      </plugin>
    </plugins>
  </build>
</project>
`,
      "src/main/java/com/example/Sum.java":
        "package com.example;\n\npublic final class Sum {\n    private Sum() {}\n\n    public static int of(int a, int b) {\n        return a + b;\n    }\n}\n",
      "src/test/java/com/example/SumTest.java":
        "package com.example;\n\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n\nimport org.junit.jupiter.api.Test;\n\nclass SumTest {\n    @Test\n    void adds() {\n        assertEquals(3, Sum.of(1, 2));\n    }\n}\n",
    },
    needs: [
      ["mvn", "--version"],
      ["java", "-version"],
    ],
    written: "src/test/java/com/example/SumTest.java",
  },
  dotnet: {
    files: {
      "Fixture.csproj":
        '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n</Project>\n',
      "Sum.cs":
        "namespace Fixture;\n\npublic static class Sum\n{\n    public static int Of(int a, int b) => a + b;\n}\n",
    },
    needs: [["dotnet", "--version"]],
  },
};

/**
 * Formatting that a passing lint gate does not show (bench round 41, fpbits, #1480): `go vet`
 * passes on unformatted code, `gofmt -l` exits 0 whatever it lists, and `ruff check` reports no
 * formatting. Each stack's formatter is a file-local gate of its own, so it covers the files a task
 * writes and its fixer formats them before the task's checks run.
 */
describe("gate matrix: formatting a lint gate does not verify", () => {
  const formatters: [string, Record<string, string>, string, string, { executable: string; args: string[] }][] = [
    ["go", FIXTURES.go.files, "gofmt", "internal/core/format.go", { executable: "gofmt", args: ["-w", "internal/core/format.go"] }],
    [
      "python",
      { "pyproject.toml": "[project]\nname = 'fixture'\n\n[tool.ruff]\n\n[tool.ruff.format]\nquote-style = 'double'\n" },
      "ruff-format",
      "fixture/core.py",
      { executable: "ruff", args: ["format", "fixture/core.py"] },
    ],
    ["rust", FIXTURES.rust.files, "cargo-fmt", "src/core.rs", { executable: "cargo", args: ["fmt", "--", "src/core.rs"] }],
    ["dotnet", FIXTURES.dotnet.files, "dotnet-format", "src/Core.cs", { executable: "dotnet", args: ["format", "--include", "src/Core.cs"] }],
  ];
  for (const [stack, files, id, path, fixer] of formatters)
    test(`${stack}: ${id} is preselected and its fixer formats the file a task wrote`, () => {
      const checks = detectGates(project(files))
        .filter((s) => s.preselected)
        .map((s) => s.check);
      const check = checks.find((c) => c.id === id);
      expect(check?.fix && fixerCommand(check.fix, path)).toEqual(fixer);
      const writes = [{ path, action: "create" as const }];
      // Whole-unit formatters (cargo fmt) run at the checks stage after integration (#842).
      expect(coveringChecks({ checks } as RunPolicy, { writes }).some((c) => c.id === id)).toBe(!isWholeUnitCheck(check as Check));
    });

  test("gofmt -l fails on a file it lists although it exits 0", () => {
    const gofmt = detectGates(project(FIXTURES.go.files)).find((s) => s.check.id === "gofmt")?.check as Check;
    expect(exitStatus(gofmt, 0, "internal/core/format.go\n")).toBe("failed");
    expect(exitStatus(gofmt, 0, "")).toBe("passed");
    expect(exitStatus({ ...gofmt, executable: "C:\\Go\\bin\\gofmt.exe" }, 0, "a.go\n")).toBe("failed");
  });

  // A criterion that claims formatting or lint passes only on a check that shows it.
  const passed = (...commands: string[][]): Check[] =>
    commands.map(([executable = "", ...args]) => ({
      id: [executable, ...args].join("-").replace(/[^A-Za-z0-9_-]/g, ""),
      executable,
      args,
      cwd: ".",
      timeoutMs: 1000,
      required: true,
      scope: "feature",
      envNames: [],
      writes: [],
    }));
  const claims: [string, Check[], boolean | null][] = [
    ["All new Go files are gofmt-formatted; 'go vet ./...' and 'go test ./...' pass", passed(["go", "vet", "./..."], ["go", "test", "./..."]), false],
    ["All new Go files are gofmt-formatted; 'go vet ./...' and 'go test ./...' pass", passed(["gofmt", "-l", "."], ["go", "vet", "./..."]), true],
    ["changed Go files are formatted", passed(["go", "vet", "./..."]), false],
    ["the Python sources are formatted", passed(["ruff", "check", "."]), false],
    ["the Python sources are formatted", passed(["ruff", "format", "--check", "."]), true],
    ["the code is lint-clean", passed(["ruff", "check", "."]), true],
    ["the code is formatted", passed(["bun", "run", "lint"]), true],
    ["cargo fmt --check and clippy report nothing", passed(["cargo", "fmt", "--check"], ["cargo", "clippy"]), true],
    ["the report prints dates in ISO 8601 format", passed(["go", "test", "./..."]), null],
    ["the output is formatted as a table", passed(["go", "test", "./..."]), null],
  ];
  for (const [text, checks, shown] of claims)
    test(`"${text}" with ${checks.map((c) => c.id).join(", ")} passing: ${shown}`, () => {
      expect(styleClaimShown(text, checks)).toBe(shown);
    });
});

/**
 * A project whose toolchain no detector knows (Lua, PHP, C) states its commands in a task runner or
 * its CI (#1488). Without suggestions a shipped SDD preset refuses to start until a person types
 * every gate; with them the gates come from the project's own files, and a runner that prints TAP
 * or a JUnit XML report still gets the fewer-tests baseline.
 */
describe("gate matrix: a toolchain no detector knows", () => {
  const LUA = { "src/sum.lua": "return function(a, b) return a + b end\n", "spec/sum_spec.lua": "describe('sum', function() end)\n" };
  const cases: [string, Record<string, string>, [string, string, string[]][]][] = [
    [
      "Makefile",
      { ...LUA, Makefile: ".PHONY: test lint\nLUA ?= lua\n\nlint:\n\tluacheck src\n\ntest: lint\n\tbusted\n\nfmt-check fmt:\n\tstylua --check src\n" },
      [
        ["lint", "make", ["lint"]],
        ["format", "make", ["fmt-check"]],
        ["tests", "make", ["test"]],
      ],
    ],
    [
      "justfile",
      { ...LUA, justfile: "set shell := [\"bash\", \"-c\"]\nversion := \"1\"\n\n# Run the specs\ntest *args:\n    busted {{args}}\n\ncheck: test\n    luacheck src\n" },
      [
        ["tests", "just", ["test"]],
        ["check", "just", ["check"]],
      ],
    ],
    [
      "Taskfile",
      { ...LUA, "Taskfile.yml": "version: '3'\n\ntasks:\n  lint:\n    cmds:\n      - luacheck src\n  test:\n    deps: [lint]\n    cmds:\n      - busted\n" },
      [
        ["lint", "task", ["lint"]],
        ["tests", "task", ["test"]],
      ],
    ],
    [
      "CI workflow",
      {
        ...LUA,
        ".github/workflows/ci.yml": "on: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: luarocks install busted\n      - run: luacheck src\n      - name: Specs\n        run: |\n          busted --output=TAP\n      - run: busted --coverage && luacov\n",
      },
      [
        ["lint", "luacheck", ["src"]],
        ["tests", "busted", ["--output=TAP"]],
      ],
    ],
  ];
  for (const [name, files, expected] of cases)
    test(`${name}: its targets are suggested and preselected`, () => {
      const found = detectGates(project(files));
      expect(found.map((s) => [s.check.id, s.check.executable, s.check.args])).toEqual(expected);
      expect(found.every((s) => s.preselected && s.check.required && s.check.scope === "feature")).toBe(true);
    });

  test("a detected toolchain keeps its own gates, without the runner's", () => {
    const found = detectGates(project({ ...FIXTURES.go.files, Makefile: "test:\n\tgo test ./...\n" }));
    expect(found.map((s) => s.check.id)).toEqual(FIXTURES.go.gates);
  });

  test("the runner's test gate is a test check for the mutation and written-tests gates", () => {
    const tests = detectGates(project({ ...LUA, Makefile: "test:\n\tbusted\n" })).find((s) => s.check.id === "tests");
    expect(tests && isTestCheck(tests.check)).toBe(true);
  });

  test("TAP and JUnit XML output give the fewer-tests baseline", () => {
    expect(testCount("ok 1 - sum adds\nok 2 - sum commutes\n1..2\n")).toEqual({ tool: "tap", count: 2 });
    expect(testCount('<testsuites tests="5"><testsuite tests="5"/></testsuites>')).toEqual({ tool: "junit", count: 5 });
  });
});

const toolchains = process.env.BAKED_GATE_MATRIX_TOOLCHAINS === "1";
// The test preload points HOME at an empty profile, where rustup finds no default toolchain;
// os.homedir() still names the real home, so the toolchain tier points rustup and cargo there.
if (toolchains) {
  process.env.RUSTUP_HOME ??= join(homedir(), ".rustup");
  process.env.CARGO_HOME ??= join(homedir(), ".cargo");
}
const available = (needs: string[][]) =>
  needs.every(([command, ...args]) => {
    if (!command) return false;
    const result = spawnSync(command, args, { stdio: "ignore", timeout: 60_000 });
    return result.status === 0;
  });

describe.skipIf(!toolchains)("gate matrix: toolchains", () => {
  // #1493: the RSpec, Minitest and RuboCop parsers read what the installed tools print.
  test.skipIf(!available([["rspec", "--version"], ["ruby", "-e", "require 'minitest'"], ["rubocop", "--version"]]))("rspec, minitest and rubocop output reads as their parsers expect (#1493)", () => {
    const root = project({
      "lib/calc.rb": "module Calc\n  def self.add(a, b) = a + b\nend\n",
      "spec/calc_spec.rb": 'require_relative "../lib/calc"\nRSpec.describe Calc do\n  it "adds" do\n    expect(Calc.add(1, 2)).to eq(3)\n  end\n  it "fails" do\n    expect(Calc.add(1, 2)).to eq(4)\n  end\n  xit "waits" do\n  end\nend\n',
      "test/calc_test.rb": 'require "minitest/autorun"\nrequire_relative "../lib/calc"\nclass CalcTest < Minitest::Test\n  def test_add = assert_equal(3, Calc.add(1, 2))\n  def test_fail = assert_equal(4, Calc.add(1, 2))\n  def test_skip = skip("later")\nend\n',
      "lib/ugly.rb": "def  ugly( a )\n    a\nend\n",
      ".rubocop.yml": "AllCops:\n  NewCops: enable\n  SuggestExtensions: false\n  TargetRubyVersion: 3.3\n",
    });
    const run = (command: string, args: string[]) => {
      const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 120000 });
      return `${result.stdout}${result.stderr}`;
    };
    const rspec = run("rspec", []);
    expect([testCount(rspec), testsRan(rspec), failedTests(rspec)]).toEqual([{ tool: "rspec", count: 3 }, { tool: "rspec", count: 2 }, { tool: "rspec", names: ["Calc fails"] }]);
    const minitest = run("ruby", ["test/calc_test.rb"]);
    expect([testCount(minitest), testsRan(minitest), failedTests(minitest)]).toEqual([{ tool: "minitest", count: 3 }, { tool: "minitest", count: 2 }, { tool: "minitest", names: ["CalcTest#test_fail"] }]);
    expect(failureSignature(run("ruby", ["test/calc_test.rb"]), root)).toBe(failureSignature(minitest, root));
    expect(missingPlannedPaths(run("rspec", ["spec/later_spec.rb"]), [{ id: "T002", writes: [{ path: "spec/later_spec.rb", action: "create" }] }] as Task[])).toEqual(["spec/later_spec.rb"]);
    expect(run("rubocop", ["--only", "Layout", "lib/ugly.rb"])).toContain("Layout/");
    run("rubocop", ["-a", "--only", "Layout", "lib/ugly.rb"]);
    expect(readFileSync(join(root, "lib/ugly.rb"), "utf8")).toBe("def ugly(a)\n  a\nend\n");
  }, 300000);
  // #1496: the sbt, munit, ScalaTest and scalafmt parsers read what a real sbt build prints.
  test.skipIf(!available([["sbt", "--script-version"]]))("sbt test and scalafmt output reads as their parsers expect (#1496)", () => {
    const root = project({
      "build.sbt": 'scalaVersion := "3.6.4"\nlibraryDependencies ++= Seq("org.scalameta" %% "munit" % "1.1.0" % Test, "org.scalatest" %% "scalatest" % "3.2.19" % Test)\n',
      "project/build.properties": "sbt.version=1.10.11\n",
      "project/plugins.sbt": 'addSbtPlugin("org.scalameta" % "sbt-scalafmt" % "2.5.4")\n',
      ".scalafmt.conf": 'version = "3.9.4"\nrunner.dialect = scala3\n',
      "src/main/scala/Calc.scala": "object Calc:\n  def add(a: Int, b: Int): Int = a + b\n",
      "src/test/scala/CalcSuite.scala": 'class CalcSuite extends munit.FunSuite:\n  test("adds") { assertEquals(Calc.add(1, 2), 3) }\n  test("fails") { assertEquals(Calc.add(1, 2), 4) }\n  test("later".ignore) { assertEquals(1, 1) }\n',
      "src/test/scala/CalcSpec.scala": 'import org.scalatest.funsuite.AnyFunSuite\n\nclass CalcSpec extends AnyFunSuite:\n  test("adds too") { assert(Calc.add(1, 2) == 3) }\n  ignore("waits") { assert(true) }\n',
    });
    const run = (args: string[]) => {
      const result = spawnSync("sbt", ["-batch", ...args], { cwd: root, encoding: "utf8", timeout: 900000 });
      return `${result.stdout}${result.stderr}`;
    };
    const tests = run(["test"]);
    expect([testCount(tests), testsRan(tests), failedTests(tests)]).toEqual([{ tool: "sbt", count: 5 }, { tool: "sbt", count: 3 }, { tool: "sbt", names: ["CalcSuite.fails"] }]);
    expect(failureSignature(run(["test"]), root)).toBe(failureSignature(tests, root));
    const only = run(["testOnly *CalcSpec"]);
    expect([testCount(only), failedTests(only)]).toEqual([{ tool: "sbt", count: 2 }, { tool: "sbt", names: [] }]);
    writeFileSync(join(root, "src/main/scala/Ugly.scala"), "object Ugly:\n  def  f( a:Int ):Int=a\n");
    expect(run(["scalafmtCheckAll"])).toContain("isn't formatted properly");
    run(["scalafmtOnly src/main/scala/Ugly.scala"]);
    expect(readFileSync(join(root, "src/main/scala/Ugly.scala"), "utf8")).toBe("object Ugly:\n  def f(a: Int): Int = a\n");
  }, 1800000);
  // #1494: the dart test, dart analyze and dart format parsers read what the installed SDK prints.
  // package:test comes from the real pub cache; the test preload points HOME elsewhere.
  test.skipIf(!available([["dart", "--version"]]))("dart test, analyze and format output reads as their parsers expect (#1494)", () => {
    const root = project({
      "pubspec.yaml": "name: calc\nenvironment:\n  sdk: ^3.5.0\ndev_dependencies:\n  test: ^1.25.0\n",
      "lib/calc.dart": "int add(int a, int b) => a + b;\n",
      "test/calc_test.dart": "import 'package:calc/calc.dart';\nimport 'package:test/test.dart';\n\nvoid main() {\n  test('adds', () => expect(add(1, 2), 3));\n  test('fails', () => expect(add(1, 2), 4));\n  test('waits', () {}, skip: 'later');\n}\n",
      "lib/ugly.dart": "int  ugly( int a ){return a;}\n",
      "lib/bad.dart": "int f(int a) {\n  var unused = 1;\n  String s = 3;\n  return a;\n}\n",
    });
    const env = { ...process.env, PUB_CACHE: process.env.PUB_CACHE ?? join(homedir(), ".pub-cache") };
    const run = (args: string[]) => {
      const result = spawnSync("dart", args, { cwd: root, encoding: "utf8", timeout: 300000, env });
      return `${result.stdout}${result.stderr}`;
    };
    run(["pub", "get"]);
    const tests = run(["test"]);
    expect([testCount(tests), testsRan(tests), failedTests(tests)]).toEqual([{ tool: "dart", count: 3 }, { tool: "dart", count: 2 }, { tool: "dart", names: ["test/calc_test.dart: fails"] }]);
    expect(failureSignature(run(["test"]), root)).toBe(failureSignature(tests, root));
    expect(missingPlannedPaths(run(["test", "test/later_test.dart"]), [{ id: "T002", writes: [{ path: "test/later_test.dart", action: "create" }] }] as Task[])).toEqual(["test/later_test.dart"]);
    expect(diagnosticCount(run(["analyze", "lib/bad.dart"]))).toEqual({ tool: "dart", count: 3, errors: 1 });
    expect(run(["format", "--output=none", "--set-exit-if-changed", "lib/ugly.dart"])).toContain("Changed lib/ugly.dart");
    run(["format", "lib/ugly.dart"]);
    expect(readFileSync(join(root, "lib/ugly.dart"), "utf8")).toBe("int ugly(int a) {\n  return a;\n}\n");
  }, 600000);
  test.skipIf(!available([["cargo", "--version"]]))("a cargo init crate reaches approval with the detected cargo gates (#1815)", async () => {
    const files = {
      "Cargo.toml": '[package]\nname = "hexview"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
      "src/main.rs": 'fn main() {\n    println!("Hello, world!");\n}\n',
      ".gitignore": "/target\n",
    };
    const checks = detectGates(project(files)).filter((s) => s.preselected).map((s) => s.check);
    expect(checks.map((c) => c.executable)).toContain("cargo");
    const result = await baselineCreatedFilesScenario([], { files, checks });
    expect(result.approval).toEqual({ status: "waiting", reason: "approval" });
    expect(result.baseline?.createdByChecks).toContain("Cargo.lock");
    expect(result.final.status).toBe("completed");
  }, 300000);
  test("pytest executes host rows and fails a wrong harness (#1596)", () => {
    const root = project({});
    const spec = { ...fixtureSpec, criteria: [{ ...fixtureSpec.criteria[0]!, given: "a JSON value", when: "it is returned", then: 'Input | Expected\n{"ok":true,"value":null} | {"ok":true,"value":null}\n[12,24] | [12,24]' }] };
    const task: Task = { id: "T001", title: "Rows", description: "Write actual(input)", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", origin: "planned", findingIds: [], rationale: "Test", readHints: [], checkIds: [], rows: ["AC-001"],
      rowTest: { framework: "pytest", harness: "tests/harness.py", test: "tests/test_rows.py", data: "tests/rows.json" },
      writes: ["tests/harness.py", "tests/test_rows.py", "tests/rows.json"].map((path) => ({ path, action: "create" })) };
    const graph = { schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks: [task] };
    const files = rowFiles(task, rowsArtifact(spec, graph, { schemaVersion: 1, inputHash: "a".repeat(64), verdict: "pass", findings: [] }));
    mkdirSync(join(root, "tests"));
    for (const generated of files) writeFileSync(join(root, generated.path), generated.content);
    const python = Bun.which("python") ?? Bun.which("python3");
    if (!python) throw new Error("The gate-matrix toolchain tier requires Python and pytest");
    const run = () => spawnSync(python, ["-m", "pytest", "-q", "tests/test_rows.py"], {
      cwd: root, encoding: "utf8", timeout: 30000,
      env: { ...process.env, PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1", PYTEST_ADDOPTS: "" },
    });
    writeFileSync(join(root, "tests/harness.py"), "def actual(value):\n    return value\n");
    const passing = run();
    expect({ status: passing.status, output: passing.status === 0 ? "" : passing.stdout + passing.stderr }).toEqual({ status: 0, output: "" });
    writeFileSync(join(root, "tests/harness.py"), "def actual(value):\n    return None\n");
    expect(run().status).toBe(1);
  });

  // A misaligned struct passes `go vet` and fails the format gate; the per-file fixer repairs it
  // (bench round 41, fpbits internal/core/format.go, #1480). The same for an unformatted Python file.
  const unformatted: [Stack, string, Record<string, string>, string, string[][]][] = [
    [
      "go",
      "gofmt",
      { ...RUNNABLE.go?.files, "format.go": "package fixture\n\ntype Format struct {\n\tA int\n\tLonger string\n}\n" },
      "format.go",
      [["go", "version"]],
    ],
    [
      "python",
      "ruff-format",
      {
        ...RUNNABLE.python?.files,
        "pyproject.toml": "[project]\nname = 'fixture'\nversion = '0.1.0'\n\n[tool.ruff]\nline-length = 100\n\n[tool.ruff.format]\n\n[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
        "fixture/core.py": "def core( a,b ):\n    return {'a':a,'b':b}\n",
      },
      "fixture/core.py",
      [["ruff", "--version"]],
    ],
  ];
  for (const [stack, id, files, path, needs] of unformatted)
    (process.env.CI || available(needs) ? cell : (s: Stack, name: string) => test.skip(`${name} (no toolchain)`, () => {}))(
      stack,
      `${stack}: ${id} fails on an unformatted file that the lint gate passes, and its fixer repairs it`,
      async () => {
        const root = project(files);
        const checks = detectGates(root)
          .filter((s) => s.preselected)
          .map((s) => s.check);
        const format = checks.find((c) => c.id === id);
        const lint = checks.find((c) => c.id === (stack === "go" ? "go-vet" : "ruff"));
        if (!format?.fix || !lint) throw new Error(`${id} or its lint gate is missing`);
        expect((await executeGate(root, lint, new AbortController().signal)).status).toBe("passed");
        const before = await executeGate(root, format, new AbortController().signal);
        expect(before.status).toBe("failed");
        expect(before.outputTail).toContain(path.split("/").at(-1) ?? path);
        const fix = fixerCommand(format.fix, path);
        expect(spawnSync(fix.executable, fix.args, { cwd: root }).status).toBe(0);
        expect((await executeGate(root, format, new AbortController().signal)).status).toBe("passed");
      },
      300_000,
    );

  // #1837: the old file stays unformatted, the scoped check fails only on the task's new file, and
  // its fixer repairs that file alone.
  (process.env.CI || available([["ruff", "--version"]]) ? cell : (s: Stack, name: string) => test.skip(`${name} (no toolchain)`, () => {}))(
    "python",
    "python: ruff-format-written fails on the new file, not the old one, and its fixer repairs it",
    async () => {
      const root = project({
        "pyproject.toml": "[project]\nname = 'fixture'\nversion = '0.1.0'\n\n[tool.ruff]\nline-length = 100\n",
        "fixture/old.py": "def old( a,b ):\n    return {'a':a}\n",
        "tests/test_new.py": "def test_new( ):\n    assert {'a':1}=={'a':1}\n",
      });
      const [check] = formatWrittenChecks(root, [], [{ path: "tests/test_new.py", action: "create" }]);
      if (!check?.fix) throw new Error("no ruff-format-written check");
      const before = await executeGate(root, check, new AbortController().signal);
      expect(before.status).toBe("failed");
      expect(before.outputTail).toContain("test_new.py");
      expect(before.outputTail).not.toContain("old.py");
      const fix = fixerCommand(check.fix, "tests/test_new.py");
      expect(spawnSync(fix.executable, fix.args, { cwd: root }).status).toBe(0);
      expect((await executeGate(root, check, new AbortController().signal)).status).toBe("passed");
      expect(readFileSync(join(root, "fixture/old.py"), "utf8")).toBe("def old( a,b ):\n    return {'a':a}\n");
    },
    300_000,
  );

  // #1913, rpn 09a1c786: a required gate names `src tests` before the task that writes `tests/` ran.
  // The real tools' "path does not exist" output names the folder the later task creates.
  for (const [tool, args] of [["ruff", ["check", "src", "tests"]], ["black", ["--check", "src", "tests"]]] as const)
    ((tool === "ruff" && process.env.CI) || available([[tool, "--version"]]) ? cell : (s: Stack, name: string) => test.skip(`${name} (no toolchain)`, () => {}))(
      "python",
      `python: ${tool} on src and a missing tests folder names the folder the test task creates`,
      async () => {
        const root = project({ "pyproject.toml": "[project]\nname = 'rpn'\nversion = '0.1.0'\n", "src/rpn/core.py": "x = 1\n" });
        const check: Check = { id: tool, executable: tool, args: [...args], cwd: ".", timeoutMs: 60_000, required: true, scope: "feature", envNames: [], writes: [] };
        const result = await executeGate(root, check, new AbortController().signal);
        expect(result.status).toBe("failed");
        const tasks = [{ writes: [{ path: "src/rpn/core.py", action: "create" as const }] }, { writes: [{ path: "tests/test_core.py", action: "create" as const }] }];
        expect(missingPlannedPaths(result.outputTail, tasks)).toEqual(["tests/test_core.py"]);
      },
      300_000,
    );

  // #1837, R57 zonevet: a test appended to a file that was not formatted before the run. The range
  // check fails on the appended lines only, its fixer formats them, and the old lines stay as they were.
  for (const [tool, gate] of [["ruff", "[tool.ruff]\nline-length = 100\n"], ["black", "[tool.black]\n"]] as const)
    ((tool === "ruff" && process.env.CI) || available([[tool, "--version"]]) ? cell : (s: Stack, name: string) => test.skip(`${name} (no toolchain)`, () => {}))(
      "python",
      `python: ${tool} range check holds only the lines a task appended to an unformatted file`,
      async () => {
        const old = "import os\nx  =  {'a':1}\n\n\ndef test_old( ):\n    assert os.sep\n";
        const appended = `${old}\n\ndef test_new( ):\n    assert {'a':1}=={'a':1}\n`;
        const root = project({
          "pyproject.toml": `[project]\nname = 'fixture'\nversion = '0.1.0'\n\n${gate}`,
          "tests/test_docs.py": appended,
        });
        const [check] = formatWrittenChecks(root, [], [{ path: "tests/test_docs.py", action: "modify" }], undefined, () => old);
        if (!check?.fix) throw new Error(`no ${tool} range check`);
        expect((await executeGate(root, check, new AbortController().signal)).status).toBe("failed");
        const fix = fixerCommand(check.fix, "tests/test_docs.py");
        expect(spawnSync(fix.executable, fix.args, { cwd: root }).status).toBe(0);
        expect((await executeGate(root, check, new AbortController().signal)).status).toBe("passed");
        const after = readFileSync(join(root, "tests/test_docs.py"), "utf8");
        expect(after.startsWith(old)).toBe(true);
        expect(after).toContain("def test_new():\n    assert {\"a\": 1} == {\"a\": 1}\n");
      },
      300_000,
    );

  for (const [stack, runnable] of Object.entries(RUNNABLE) as [Stack, NonNullable<(typeof RUNNABLE)[Stack]>][]) {
    // In CI every toolchain must be there; locally a missing one skips its row.
    const ready = process.env.CI ? true : available(runnable.needs);
    (ready ? cell : (s: Stack, name: string) => test.skip(`${name} (no toolchain)`, () => {}))(
      stack,
      `${stack}: every detected gate passes on a clean project`,
      async () => {
        const root = project(runnable.files);
        const checks = detectGates(root)
          .filter((s) => s.preselected)
          .map((s) => s.check);
        expect(checks.length).toBeGreaterThan(0);
        for (const check of checks) {
          const result = await executeGate(root, check, new AbortController().signal);
          expect({ gate: check.id, status: result.status, output: result.status === "passed" ? "" : result.outputTail }).toEqual({
            gate: check.id,
            status: "passed",
            output: "",
          });
        }
      },
      900_000,
    );
    if (runnable.written)
      (ready ? cell : (s: Stack, name: string) => test.skip(`${name} (no toolchain)`, () => {}))(
        stack,
        `${stack}: the written-tests check runs the task's test file`,
        async () => {
          const root = project(runnable.files);
          const checks = detectGates(root)
            .filter((s) => s.preselected)
            .map((s) => s.check);
          const check = writtenTestsCheck(root, checks, [{ path: runnable.written ?? "", action: "create" }]);
          expect(check).not.toBeNull();
          if (!check) return;
          const result = await executeGate(root, check, new AbortController().signal);
          expect({ status: result.status, output: result.status === "passed" ? "" : result.outputTail }).toEqual({
            status: "passed",
            output: "",
          });
        },
        900_000,
      );
  }
});

// A gate's failed output can stop on a repair limit on every stack; the grant does not waive it.
describe("initiative start budget gate (#1605)", () => {
  test.each([899_999, 900_000, 1_000_000])("pool %s protects waiting lows before starting a feature", (tokens) => {
    const before = {
      initiativeId: "pictures",
      budget: { remaining: { tokens, calls: 100, activeMs: 1_000_000 }, cost: { capUsd: null } },
      features: [
        { id: "pictures", size: "small", share: null, shareUsd: null, need: null },
        { id: "docs", size: "large", share: { tokens, calls: 100, activeMs: 1_000_000 }, shareUsd: null, need: { low: 200_000, high: 1_000_000 } },
      ],
    } as unknown as InitiativeView;
    const view = rebaseView(before, "pictures", { low: 700_000, high: 800_000 });
    const pictures = view.features.find((f) => f.id === "pictures")!;
    expect(growthLimit(view, "pictures")).toBe(tokens - 200_000);
    if (tokens < 900_000) {
      expect(shareShortfall(view, pictures)?.remedies).toContainEqual({ action: "extend", initiativeId: "pictures" });
    } else {
      expect(shareShortfall(view, pictures)).toBeNull();
      expect(pictures.share?.tokens).toBeGreaterThanOrEqual(700_000);
      expect(view.features.reduce((sum, f) => sum + (f.share?.tokens ?? 0), 0)).toBeLessThanOrEqual(tokens);
    }
  });
});

describe("per-call cost gate (#1630)", () => {
  test.each(CALL_COST_MODELS)("%s reserves at the finished task price after expensive planning", async (model) => {
    const { fixture, store, runId, policy, rate } = await perCallCostScenario(model);
    try {
      store.reserve(runId, store.beginStep(runId, "task-next"), model, NEXT_CALL, policy);
      expect(store.costUsage(runId).reservedUsd).toBeCloseTo(NEXT_CALL * rate, 10);
      expect(() => store.reserve(runId, store.beginStep(runId, "task-parallel"), model, NEXT_CALL, policy)).toThrow("cost ceiling");
    } finally { await fixture.dispose(); }
  });
});

describe("initiative dollar forecast gate (#1607)", () => {
  for (const tolerance of [0, 0.2, 0.25])
    test.each([252_000, 500_000])(`accepted spend of %s tokens per feature, tolerance ${tolerance}`, (spent) => {
      const estimate = estimateInitiative({
        features: Array.from({ length: 12 }, (_, i) => ({ id: `f${i + 1}`, title: `f${i + 1}`, size: "medium" as const, workflowId: "sdd", paths: 1,
          stages: [{ id: "specify", type: "agent", models: [] }, { id: "implement", type: "tasks", models: [] }],
        })),
        history: [], samples: [], maxTotalTokens: 20_000_000,
        progress: { features: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i + 1}`, { spent, accepted: true }])), overhead: 0 },
      });
      const forecastUsd = Math.round(estimate.features.reduce((sum, f) => sum + f.expectedTokens * 9e-6, 0) * 100) / 100;
      const view = {
        initiativeId: "values",
        budget: { remaining: { tokens: 20_000_000, calls: 1000, activeMs: 21_600_000 },
          cost: { capUsd: 30, ceilingUsd: 30 * (1 + tolerance), spentUsd: 5 * spent * 9e-6, forecastUsd, measuredFeatures: 5, forecastBinding: true, forecastMode: "enforce" },
        },
        features: estimate.features.map((f, i) => ({ id: f.featureId, size: f.size, state: i < 5 ? "accepted" : "ready",
          share: i < 5 ? null : { tokens: 1_000_000, calls: 100, activeMs: 1_000_000 }, shareUsd: i < 5 ? null : 2.5, need: f.tokens,
        })),
      } as unknown as InitiativeView;
      expect(forecastUsd).toBe(Math.round(12 * spent * 9e-6 * 100) / 100);
      const shortfall = shareShortfall(view, view.features[5]!);
      if (spent === 252_000) expect(shortfall).toBeNull();
      else expect(shortfall?.message).toContain("The initiative's cost forecast is");
      // In shadow or advisory mode the same binding forecast only records a would-stop (#1714).
      for (const forecastMode of ["shadow", "advisory"] as const)
        expect(shareShortfall({ ...view, budget: { ...view.budget, cost: { ...view.budget.cost, forecastMode } } }, view.features[5]!)).toBeNull();
    });
});

test("#1631 one accepted skeleton keeps the initiative's planned forecast below its ceiling", () => {
  const estimate = estimateInitiative({
    features: Array.from({ length: 12 }, (_, i) => ({
      id: `f${i + 1}`, title: `f${i + 1}`, size: "medium" as const, workflowId: "sdd",
      ...(i === 0 ? { skeleton: 24 } : {}),
      stages: [{ id: "specify", type: "agent", models: [] }, { id: "implement", type: "tasks", models: [] }],
    })),
    history: Array.from({ length: 2 }, (_, i) => ({ runId: `prior${i}`, workflowId: "sdd", status: "completed", tokens: 200_000, calls: 2, activeMs: 1000,
      taskCount: 1, taskTokens: 100_000, stageTokens: { specify: 100_000, implement: 100_000 } })),
    samples: [], maxTotalTokens: 20_000_000,
    progress: { features: { f1: { spent: 400_000, accepted: true } }, overhead: 0 },
  });
  const forecastUsd = Math.round(estimate.features.reduce((sum, f) => sum + f.expectedTokens * 9e-6, 0) * 100) / 100;
  const view = {
    initiativeId: "skeleton",
    budget: { remaining: { tokens: 20_000_000, calls: 1000, activeMs: 21_600_000 },
      cost: { capUsd: 30, ceilingUsd: 37.5, spentUsd: 3.6, forecastUsd } },
    features: estimate.features.map((f, i) => ({ id: f.featureId, size: f.size, state: i ? "ready" : "accepted",
      share: i ? { tokens: 1_000_000, calls: 100, activeMs: 1_000_000 } : null,
      shareUsd: i ? 2.4 : null, need: f.tokens,
    })),
  } as unknown as InitiativeView;
  expect(estimate.progress.ratio).toBeNull();
  expect(forecastUsd).toBe(23.4);
  expect(shareShortfall(view, view.features[1]!)).toBeNull();
});

describe("repair-limit decisions (#1577)", () => {
  test.each(STACKS)("%s offers grants only for a recorded repair-limit stop", () => {
    const repairBlock: RepairBlock = { limit: "maxRepairRounds", scope: "round", required: 1, taskIds: [] };
    expect(canRepairRun({ status: "blocked", reason: "no_progress", repairBlock })).toBe(true);
    expect(canRepairRun({ status: "blocked", reason: "no_progress" })).toBe(false);
    expect(canRepairRun({ status: "blocked", reason: "verification_failed", repairBlock })).toBe(false);
  });
});

// Ownership is independent of the check program: an initiative's review gate must not ask
// the current feature to correct a file reserved for a downstream feature (#1590).
test("review gate keeps sibling-owned missing tests as notes", () => {
  const state: Pick<RuntimeState, "initiativeBounds" | "reviewNotes" | "snapshotId"> = {
    initiativeBounds: { featureId: "adapters", features: [
      { id: "adapters", scope: "Adapters", paths: ["src/adapter.py"] },
      { id: "entry", scope: "Entry acceptance", paths: ["tests/**"] },
    ] },
    reviewNotes: [], snapshotId: null,
  };
  const finding = { id: "F001", kind: "missing" as const, severity: "medium" as const, basis: "spec" as const, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "tests/test_x.py", symbol: null, evidenceIds: [], claim: "Acceptance tests are missing", impact: "Tests are absent", suggestedFix: "Add tests" };
  expect([...noteSiblingFindings(state, "correctness", [finding])]).toEqual(["F001"]);
  expect(state.reviewNotes[0]).toMatchObject({ reason: "owned_by_sibling", claim: expect.stringContaining("feature entry") });
  expect([...noteSiblingFindings(state, "correctness", [{ ...finding, id: "F002", file: "src/adapter.py" }])]).toEqual([]);
});

test("#1594 review and mutation gates route pathless deliverables without hiding local defects", () => {
  const bounds: RuntimeState["initiativeBounds"] = { featureId: "adapters", features: [
    { id: "adapters", scope: "Adapters", paths: ["src/adapter.py"], testedBy: "entry" },
    { id: "entry", scope: "Acceptance and docs", paths: ["tests/**", "docs/**"] },
  ] };
  const base = { id: "F001", kind: "missing" as const, severity: "medium" as const, requirementIds: [], criterionIds: [], file: null, symbol: null, evidenceIds: [], claim: "Acceptance tests have not been delivered", impact: "Missing coverage", suggestedFix: "Supply adapter tests" };
  for (const finding of [base,
    { ...base, claim: "Missing tests/test_x.py", suggestedFix: "Deliver coverage" },
    { ...base, claim: "Missing documentation", suggestedFix: "Write docs/commands.md" },
    { ...base, repro: { executable: "python", args: ["tests/test_x.py"], actual: "missing", expected: "ready" } },
  ]) expect(ownerOfFinding(finding, bounds)?.id).toBe("entry");
  // Give the current feature its own tests/docs so kind inference cannot mask a path-parser bug.
  const withLocalTargets = { ...bounds, features: [{ ...bounds.features[0]!, paths: ["src/adapter.py", "tests/local.py", "docs/local.md"] }, bounds.features[1]!] };
  for (const finding of [
    { ...base, claim: "Missing tests/test_x.py", suggestedFix: "Deliver coverage" },
    { ...base, claim: "Acceptance is incomplete", suggestedFix: "Update docs/commands.md" },
    { ...base, claim: "Acceptance script is incomplete", suggestedFix: "Fix the script", repro: { executable: "python", args: ["tests/test_x.py"], actual: "missing", expected: "ready" } },
    { ...base, claim: "Missing .\\tests\\test_x.py", suggestedFix: "Deliver coverage" },
  ]) expect(ownerOfFinding(finding, withLocalTargets)?.id).toBe("entry");
  expect(ownerOfFinding({ ...base, file: "src/adapter.py" }, bounds)).toBeUndefined();
  expect(ownerOfFinding({ ...base, claim: "src/adapter.py and tests/test_x.py disagree" }, bounds)).toBeUndefined();
  expect(ownerOfFinding({ ...base, kind: "correctness", claim: "The adapter returns the wrong value", suggestedFix: "Fix the calculation" }, bounds)).toBeUndefined();
  expect(ownerOfFinding(base, { ...bounds, features: [{ ...bounds.features[0]!, paths: ["src/**"] }, bounds.features[1]!] })).toBeUndefined();
  expect(ownerOfFinding(base, { ...bounds, features: [{ ...bounds.features[0]!, paths: ["src/*/adapter.py"] }, bounds.features[1]!] })).toBeUndefined();
  expect(ownerOfFinding(base, { ...bounds, features: [{ ...bounds.features[0]!, testedBy: undefined }, bounds.features[1]!, { id: "other", scope: "Other tests", paths: ["test/**"] }] })).toBeUndefined();
});

// #1864: a required test check that collected no test, in a run whose plan writes none, is no
// failure. Each stack's "no test" output is recognized; a real failure and a skipped-only run are not.
describe("gate matrix: no tests collected (#1864)", () => {
  const NO_TESTS: [string, string][] = [
    ["Python (pytest, exit 5)", "collected 0 items\n\n============ no tests ran in 0.01s ============"],
    ["Python (pytest testpaths missing)", "PytestConfigWarning: No files were found in testpaths; consider removing or adjusting your testpaths configuration."],
    ["TypeScript/JavaScript (bun test, exit 1)", "error: 0 test files matching **{.test,.spec,_test_,_spec_}.{js,ts,jsx,tsx}"],
    ["TypeScript/JavaScript (jest)", "No tests found, exiting with code 1"],
    ["TypeScript/JavaScript (vitest)", "No test files found, exiting with code 1"],
    ["Go (exit 0)", "?   \texample.com/pkg\t[no test files]"],
    ["Swift (swift test)", "error: no tests found; create a target in the 'Tests' directory"],
    ["Dart (dart test)", "No tests ran."],
    ["Kotlin/Java (Gradle 9)", "There are test sources present and no filters are applied, but the test task did not discover any tests to execute."],
  ];
  for (const [stack, output] of NO_TESTS)
    test(`${stack}: no test collected`, () => expect(noTestsCollected(output)).toBe(true));
  test("a failing test and a passing run are not 'no tests'", () => {
    expect(noTestsCollected("FAILED tests/test_tags.py::test_wheel - AssertionError\n1 failed in 0.02s")).toBe(false);
    expect(noTestsCollected(" 3 pass\n 0 fail\nRan 3 tests across 1 file.")).toBe(false);
    expect(noTestsCollected("test result: ok. 0 passed; 0 failed; 0 ignored")).toBe(false);
  });
});
