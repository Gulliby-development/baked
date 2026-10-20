import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { buildCheckEnv } from "../src/core/verification/check-runner.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { literalRows } from "../src/core/workflows/acceptance-rows.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, Check, ExecutionRequest } from "../src/core/workflows/types.js";
import { runRoot } from "../src/core/workflows/worktree.js";

// #1763: a level-5 brief names the test files a feature may write, so the file mode's harness,
// test and data files were extra files no planner could add: 248 audited rows of bench round 52,
// 0 expanded. With the inline mode the plan names only the test file the brief allows; the host
// writes the rows and their test into a block of it, and puts the block back when the agent's
// rewrite drops it.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
// The test preload points HOME at an empty profile, where rustup finds no default toolchain;
// os.homedir() still names the real home (as in the gate matrix's toolchain tier).
process.env.RUSTUP_HOME ??= join(homedir(), ".rustup");
process.env.CARGO_HOME ??= join(homedir(), ".cargo");
// Probed with the environment a check gets, so a toolchain the checks cannot run (rustup with no
// default toolchain on a Windows runner) skips its row instead of failing its baseline.
const has = (command: string[]) => {
  if (Bun.which(command[0] ?? "") === null) return false;
  const env = buildCheckEnv({ envNames: [] } as unknown as Check);
  return Bun.spawnSync(command, { env, cwd: tmpdir(), stdout: "ignore", stderr: "ignore" }).exitCode === 0;
};
const cases = Array.from({ length: 12 }, (_, i) => [i - 3, (i - 3) * 2] as const);
const spec: Spec = {
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "Double", problem: "No doubler",
  outcome: "Double a number", inScope: ["Double"], outOfScope: [], assumptions: [], openQuestions: [], dependencies: [],
  requirements: [{ id: "FR-001", text: "Return twice the input number", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a JSON number", when: "double is called",
    then: `Input | Scenario | Expected\n--- | --- | ---\n${cases.map(([input, expected]) => `\`${input}\` | ${input < 0 ? "negative" : "non-negative"} number | \`${expected}\``).join("\n")}`, method: "automated" }],
};
const markdown = "# Plan\n## Context\nDouble.\n## Decisions\nDEC-001: FR-001 doubles numbers.\n## Components\nThe one test file\n## Data\nJSON numbers\n## Verification\nTests\n## Risks\nNone";

interface Toolchain {
  framework: "bun" | "pytest" | "go" | "junit" | "rust" | "xunit";
  package?: string;
  test: string;
  /** The project around the one test file, which exists before the run with an ordinary test. */
  project: Record<string, string>;
  /** What the agent writes: the whole test file with its harness and ordinary tests, no host block. */
  agent: string;
  /** The test file before the run: an ordinary test that passes. */
  existing: string;
  /** The harness line that doubles, and one that returns its input, which the rows must fail. */
  wrong: [string, string];
  run?: string[];
  marker: string;
}
const TOOLCHAINS: Toolchain[] = [
  { framework: "bun", test: "tests/text.test.ts", project: {},
    agent: 'import { expect, test } from "bun:test";\n\nfunction acceptanceActual(input: unknown): unknown {\n  return (input as number) * 2;\n}\n\ntest("existing", () => expect(1).toBe(1));\n',
    existing: 'import { expect, test } from "bun:test";\n\ntest("existing", () => expect(1).toBe(1));\n',
    wrong: ["return (input as number) * 2;", "return input;"],
    run: [process.execPath, "test", "tests/text.test.ts"], marker: "acceptanceTest.each(acceptanceRows)" },
  { framework: "pytest", test: "tests/test_text.py", project: { ".gitignore": "__pycache__/\n.pytest_cache/\n" },
    agent: "def acceptance_actual(input):\n    return input * 2\n\n\ndef test_existing():\n    assert True\n",
    existing: "def test_existing():\n    assert True\n",
    wrong: ["return input * 2", "return input"],
    ...(has(["python3", "-c", "import pytest"]) ? { run: ["python3", "-m", "pytest", "-q", "tests/test_text.py"] } : {}), marker: "def test_acceptance_row(row):" },
  { framework: "go", package: "double", test: "double/double_test.go", project: { "go.mod": "module example.com/fixture\n\ngo 1.21\n" },
    agent: 'package double\n\nimport "testing"\n\nfunc acceptanceActual(input any) (any, error) {\n\treturn input.(float64) * 2, nil\n}\n\nfunc TestExisting(t *testing.T) {}\n',
    existing: 'package double\n\nimport "testing"\n\nfunc TestExisting(t *testing.T) {}\n',
    wrong: ["return input.(float64) * 2, nil", "return input, nil"],
    ...(Bun.which("go") !== null && Bun.which("gofmt") !== null ? { run: ["go", "test", "./..."] } : {}), marker: "func TestAcceptanceRowsDouble(t *acceptancetesting.T)" },
  { framework: "rust", test: "tests/text.rs",
    project: { ".gitignore": "/target\nCargo.lock\n", "Cargo.toml": '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n', "src/lib.rs": "pub fn double(x: f64) -> f64 {\n    x * 2.0\n}\n" },
    agent: "fn acceptance_actual(input: &AcceptanceJson) -> AcceptanceJson {\n    fixture::double(input.as_f64().unwrap()).into()\n}\n\n#[test]\nfn existing() {}\n",
    existing: "#[test]\nfn existing() {}\n",
    wrong: ["fixture::double(input.as_f64().unwrap()).into()", "input.clone()"],
    ...(has(["cargo", "--version"]) ? { run: ["cargo", "test", "--offline", "--quiet"] } : {}), marker: "fn acceptance_rows()" },
  { framework: "junit", package: "com.ex.calc", test: "src/test/java/com/ex/calc/CalcTest.java", project: {},
    agent: "package com.ex.calc;\n\nclass CalcTest {\n  static Object acceptanceActual(Object input) {\n    return ((Long) input) * 2;\n  }\n}\n",
    existing: "package com.ex.calc;\n\nclass CalcTest {}\n",
    wrong: ["return ((Long) input) * 2;", "return input;"],
    marker: "class CalcTestAcceptanceRowsTest {" },
  { framework: "xunit", package: "Calc.Tests", test: "Calc.Tests/CalcTest.cs", project: {},
    agent: "namespace Calc.Tests;\n\npublic class CalcTest\n{\n    public static object? AcceptanceActual(System.Text.Json.Nodes.JsonNode? input) => (int)input! * 2;\n}\n",
    existing: "namespace Calc.Tests;\n\npublic class CalcTest\n{\n}\n",
    wrong: ["=> (int)input! * 2;", "=> input;"],
    marker: "global::Calc.Tests.CalcTest.AcceptanceActual(" },
];

class ScriptedExecutor implements AgentExecutor {
  implementations = 0;
  sawBlock = false;
  note = "";
  constructor(private readonly task: Task, private readonly toolchain: Toolchain) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as {
      inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[]; acceptanceRows?: { note: string } };
    };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Fixture", facts: [], unknowns: [], constraints: [], suggestedScope: [this.toolchain.test] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [this.task] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [],
        derivations: cases.map(([input, expected]) => ({ criterionId: "AC-001", row: `${input} | ${expected}`, recomputed: String(expected), matches: true, derivation: "Twice the input as FR-001 requires" })) }; break;
      case "implementation": {
        this.implementations++;
        this.note = data.extra.acceptanceRows?.note ?? "";
        const path = join(request.root ?? "", this.toolchain.test);
        this.sawBlock = readFileSync(path, "utf8").includes(this.toolchain.marker);
        // The agent rewrites the whole file and drops the host's block.
        writeFileSync(path, this.toolchain.agent);
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote the harness", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "The rows pass" }], findings: [] }; break;
      default: throw new Error(`Unexpected output ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: inline acceptance rows in a brief that fixes the test files (#1763)", () => {
  // BAKED derives a cargo check from a written .rs test file, so without a working cargo the rust
  // row cannot pass its baseline at all.
  test.each(TOOLCHAINS.filter((t) => t.framework !== "rust" || t.run).map((t) => [t.framework, t]))("%s: the plan names one test file, and the host writes all 12 rows into it", async (_framework, toolchain) => {
    const root = mkdtempSync(join(tmpdir(), "baked-rows-inline-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    for (const [path, content] of Object.entries({ ...toolchain.project, [toolchain.test]: toolchain.existing })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const rowTest = { mode: "inline" as const, framework: toolchain.framework, test: toolchain.test, ...(toolchain.package ? { package: toolchain.package } : {}) };
    const task: Task = {
      id: "T001", title: "Test double", description: "Write the harness and the tests", requirementIds: ["FR-001"], criterionIds: ["AC-001"],
      dependsOn: [], profileId: "implementer", writes: [{ path: toolchain.test, action: "modify" }],
      readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "The brief allows only this test file", rows: ["AC-001"], rowTest,
    };
    // Without the toolchain the check only proves the run reaches it; with one it runs the rows.
    const check = toolchain.run ? { executable: toolchain.run[0] ?? "", args: toolchain.run.slice(1) } : { executable: process.execPath, args: ["--version"] };
    const policy: RunPolicy = { ...defaultWorkflowPolicy, rowsAsData: "on", critic: "off",
      checks: [{ id: "tests", ...check, cwd: ".", timeoutMs: 300000, required: true, scope: "feature", envNames: [], writes: [] }] };
    const executor = new ScriptedExecutor(task, toolchain);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: `Write double and verify its numeric examples. Change only ${toolchain.test}.`, ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const pending = await service.get(run.runId);
    const errors = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/"));
    expect(errors.map((a) => service.store.readArtifact(run.runId, a.id))).toEqual([]);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error(`Approval missing: ${pending.status} ${pending.reason}`);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: pending.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    if (done.status !== "completed") {
      const errs = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/") || a.logical_path.includes("check"));
      throw new Error(`${done.status} ${done.reason}: ${errs.map((a) => service.store.readArtifact(run.runId, a.id).slice(0, 1500)).join("\n---\n")}`);
    }
    expect(executor.implementations).toBe(1);
    // The agent saw the block before it worked and was told to define the harness next to it.
    expect(executor.sawBlock).toBe(true);
    expect(executor.note).toContain("marked acceptance rows block");
    const workspace = runRoot(root, service.store.state(run.runId));
    const written = readFileSync(join(workspace, toolchain.test), "utf8");
    // The agent's file with the host's block put back: no other file, all 12 rows.
    expect(written.startsWith(toolchain.agent.split("\n")[0] ?? "")).toBe(true);
    expect(written).toContain(toolchain.marker);
    for (const row of literalRows(spec, ["AC-001"])) expect(written).toContain(row.id);
    expect(literalRows(spec, ["AC-001"])).toHaveLength(12);
    if (!toolchain.run) return;
    const runIn = () => Bun.spawnSync(toolchain.run ?? [], { cwd: workspace, stdout: "pipe", stderr: "pipe" });
    const passing = runIn();
    expect(passing.exitCode, passing.stdout.toString() + passing.stderr.toString()).toBe(0);
    if (toolchain.framework === "go") expect(Bun.spawnSync(["gofmt", "-l", "."], { cwd: workspace }).stdout.toString()).toBe("");
    // A harness that gets the rows wrong fails the host's test.
    expect(written).toContain(toolchain.wrong[0]);
    writeFileSync(join(workspace, toolchain.test), written.replace(toolchain.wrong[0], toolchain.wrong[1]));
    expect(runIn().exitCode).not.toBe(0);
  }, 300000);
});
