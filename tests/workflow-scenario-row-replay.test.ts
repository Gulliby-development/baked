import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { buildCheckEnv } from "../src/core/verification/check-runner.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import type { ReplayResult } from "../src/core/workflows/acceptance-rows-replay.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, Check, ExecutionRequest } from "../src/core/workflows/types.js";
import { runRoot } from "../src/core/workflows/worktree.js";

// #1617, bench round 53 jsonsplice paths (run 1d162577): source task T001 accepted the empty path,
// the first test task that exercised AC-003 was T003, three generations later (1.24M tokens), and
// corrective T007 (224k) fixed the source. The audited AC-003 row already named the defect. Now a
// source task replays the audited rows of its criteria on its own code before it is accepted.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
process.env.RUSTUP_HOME ??= join(homedir(), ".rustup");
process.env.CARGO_HOME ??= join(homedir(), ".cargo");
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
    then: `Input | Expected\n--- | ---\n${cases.map(([input, expected]) => `\`${input}\` | \`${expected}\``).join("\n")}`, method: "automated" }],
};
const markdown = "# Plan\n## Context\nDouble.\n## Decisions\nDEC-001: FR-001 doubles numbers.\n## Components\nThe source and its test\n## Data\nJSON numbers\n## Verification\nTests\n## Risks\nNone";

interface Toolchain {
  framework: "bun" | "pytest" | "go" | "rust";
  package?: string;
  source: string;
  test: string;
  project: Record<string, string>;
  /**
   * The source before the run, the source task's first (wrong) version and its fix. Python's
   * bytecode cache keys a file by its size and mtime second, so the two differ in size.
   */
  stub: string;
  wrong: string;
  right: string;
  /** The test file before the run, and the one the row task writes around its block. */
  existing: string;
  testFile: string;
  /** The one-shot harness the source task gives replay_rows. */
  harness: string;
  run: string[];
  needs: string[];
}

const TOOLCHAINS: Toolchain[] = [
  { framework: "bun", source: "src/double.ts", test: "tests/double.test.ts", project: {},
    stub: "export const double = (x: number): number => x;\n", wrong: "export const double = (x: number): number => x * 3;\n", right: "export const double = (x: number): number => x * 2;\n",
    existing: 'import { expect, test } from "bun:test";\n\ntest("existing", () => expect(1).toBe(1));\n',
    testFile: 'import { expect, test } from "bun:test";\nimport { double } from "../src/double";\n\nfunction acceptanceActual(input: unknown): unknown {\n  return double(input as number);\n}\n\ntest("existing", () => expect(1).toBe(1));\n',
    harness: 'import { double } from "../src/double";\n\nfunction acceptanceActual(input: unknown): unknown {\n  return double(input as number);\n}\n',
    run: ["bun", "test"], needs: ["bun", "--version"] },
  { framework: "pytest", source: "double.py", test: "tests/test_double.py", project: { ".gitignore": "__pycache__/\n.pytest_cache/\n" },
    stub: "def double(x):\n    return x\n", wrong: "def double(x):\n    return x + x + x\n", right: "def double(x):\n    return x * 2\n",
    existing: "def test_existing():\n    pass\n",
    testFile: "from double import double\n\n\ndef acceptance_actual(input):\n    return double(input)\n\n\ndef test_existing():\n    pass\n",
    harness: "from double import double\n\n\ndef acceptance_actual(input):\n    return double(input)\n",
    run: ["python3", "-m", "pytest", "-q"], needs: ["python3", "-c", "import pytest"] },
  { framework: "go", package: "double", source: "double/double.go", test: "double/double_test.go", project: { "go.mod": "module example.com/fixture\n\ngo 1.21\n" },
    stub: "package double\n\nfunc Double(x float64) float64 {\n\treturn x\n}\n", wrong: "package double\n\nfunc Double(x float64) float64 {\n\treturn x * 3\n}\n", right: "package double\n\nfunc Double(x float64) float64 {\n\treturn x * 2\n}\n",
    existing: 'package double\n\nimport "testing"\n\nfunc TestExisting(t *testing.T) {}\n',
    testFile: 'package double\n\nimport "testing"\n\nfunc acceptanceActual(input any) (any, error) {\n\treturn Double(input.(float64)), nil\n}\n\nfunc TestExisting(t *testing.T) {}\n',
    harness: "package double\n\nfunc acceptanceActual(input any) (any, error) {\n\treturn Double(input.(float64)), nil\n}\n",
    run: ["go", "test", "./..."], needs: ["go", "version"] },
  { framework: "rust", source: "src/lib.rs", test: "tests/text.rs",
    project: { ".gitignore": "/target\nCargo.lock\n", "Cargo.toml": '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n' },
    stub: "pub fn double(x: f64) -> f64 {\n    x\n}\n", wrong: "pub fn double(x: f64) -> f64 {\n    x * 3.0\n}\n", right: "pub fn double(x: f64) -> f64 {\n    x * 2.0\n}\n",
    existing: "#[test]\nfn existing() {}\n",
    testFile: "fn acceptance_actual(input: &AcceptanceJson) -> AcceptanceJson {\n    fixture::double(input.as_f64().unwrap()).into()\n}\n\n#[test]\nfn existing() {}\n",
    harness: "fn acceptance_actual(input: &AcceptanceJson) -> AcceptanceJson {\n    fixture::double(input.as_f64().unwrap()).into()\n}\n",
    run: ["cargo", "test", "--offline", "--quiet"], needs: ["cargo", "--version"] },
];

class ScriptedExecutor implements AgentExecutor {
  replays: ReplayResult[] = [];
  note = "";
  /** Whether the one-shot file was in the workspace after each replay. */
  leftBehind: boolean[] = [];
  implementations: string[] = [];
  constructor(private readonly tasks: Task[], private readonly toolchain: Toolchain) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as {
      inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[]; rowReplay?: { note: string; file: string } };
    };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Fixture", facts: [], unknowns: [], constraints: [], suggestedScope: [this.toolchain.source] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: this.tasks } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [],
        derivations: cases.map(([input, expected]) => ({ criterionId: "AC-001", row: `${input} | ${expected}`, recomputed: String(expected), matches: true, derivation: "Twice the input as FR-001 requires" })) }; break;
      case "implementation": {
        const task = request.task;
        this.implementations.push(task?.id ?? "");
        const root = request.root ?? "";
        if (task?.id === "T001") {
          this.note = data.extra.rowReplay?.note ?? "";
          const file = data.extra.rowReplay?.file ?? "";
          // The first version is wrong; the replay names the rows, and the task fixes its code.
          writeFileSync(join(root, this.toolchain.source), this.toolchain.wrong);
          for (const source of [this.toolchain.wrong, this.toolchain.right]) {
            writeFileSync(join(root, this.toolchain.source), source);
            const result = await request.rowReplay?.run(root, this.toolchain.harness, request.signal);
            if (result) this.replays.push(result);
            this.leftBehind.push(!!file && existsSync(join(root, file)));
          }
        } else {
          // The row task rewrites its test file; the host puts its rows block back.
          writeFileSync(join(root, this.toolchain.test), this.toolchain.testFile);
        }
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Done", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "The rows pass" }], findings: [] }; break;
      default: throw new Error(`Unexpected output ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: jsonsplice paths, a source defect an audited row names (#1617)", () => {
  test.each(TOOLCHAINS.filter((t) => has(t.needs)).map((t) => [t.framework, t]))("%s: the source task replays the rows on its code and fixes it before the row task", async (_framework, toolchain) => {
    const root = mkdtempSync(join(tmpdir(), "baked-row-replay-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    for (const [path, content] of Object.entries({ ...toolchain.project, [toolchain.source]: toolchain.stub, [toolchain.test]: toolchain.existing })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const base = { requirementIds: ["FR-001"], criterionIds: ["AC-001"], profileId: "implementer", readHints: [], checkIds: [], origin: "planned" as const, findingIds: [], rationale: "Required" };
    const source: Task = { ...base, id: "T001", title: "Write double", description: "Write double", dependsOn: [], writes: [{ path: toolchain.source, action: "modify" }] };
    const rows: Task = { ...base, id: "T002", title: "Test double", description: "Write the harness and the tests", dependsOn: ["T001"],
      writes: [{ path: toolchain.test, action: "modify" }], rows: ["AC-001"],
      rowTest: { mode: "inline", framework: toolchain.framework, test: toolchain.test, ...(toolchain.package ? { package: toolchain.package } : {}) } };
    const policy: RunPolicy = { ...defaultWorkflowPolicy, rowsAsData: "on", critic: "off",
      checks: [{ id: "tests", executable: toolchain.run[0] ?? "", args: toolchain.run.slice(1), cwd: ".", timeoutMs: 300000, required: true, scope: "feature", envNames: [], writes: [] }] };
    const executor = new ScriptedExecutor([source, rows], toolchain);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Write double and verify its numeric examples.", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const pending = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error(`Approval missing: ${pending.status} ${pending.reason}`);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: pending.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    if (done.status !== "completed") {
      const errors = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/"));
      throw new Error(`${done.status} ${done.reason}: ${errors.map((a) => service.store.readArtifact(run.runId, a.id).slice(0, 2000)).join("\n---\n")}`);
    }
    // The source task was told what to replay, and the replay named every row the wrong code
    // fails (0 doubled and tripled is 0), then passed on the fix.
    expect(executor.note).toContain("replays the 12 audited rows of AC-001");
    expect(executor.replays.map((r) => r.status)).toEqual(["failed", "passed"]);
    expect(executor.replays[0]?.failed).toHaveLength(11);
    expect(executor.replays[0]?.failed).not.toContain("AC-001:4");
    // The one-shot file is never left in the workspace or delivered.
    expect(executor.leftBehind).toEqual([false, false]);
    const workspace = runRoot(root, service.store.state(run.runId));
    expect(Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: workspace }).stdout.toString()).not.toContain("baked_replay");
    expect(Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: workspace }).stdout.toString()).not.toContain("baked-replay");
    // Both tasks ran once: no test task failed on the source, and no corrective followed.
    expect(executor.implementations).toEqual(["T001", "T002"]);
    const recorded = service.store.artifacts(run.runId).filter((a) => /^tasks\/T001\/row-replay-/.test(a.logical_path));
    expect(recorded.map((a) => (JSON.parse(service.store.readArtifact(run.runId, a.id)) as { status: string }).status).sort()).toEqual(["failed", "passed"]);
  }, 300000);
});
