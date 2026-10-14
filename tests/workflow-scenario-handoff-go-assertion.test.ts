import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { failingPathsInOutput } from "../src/core/verification/convergence.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { testUpdateOwners } from "../src/core/workflows/task-graph.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 19, centsplit-update 21e03a4e (#972). T001 changed the CLI usage and
// the README; the existing help test that the dependent T002 updates failed. `go test` locates
// the assertion by base name only (`    cli_test.go:42:`), so the handoff found no planned file in
// the output, and a corrective task (247k tokens) made the edit T002 then made again.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Rounding mode", problem: "No --round", outcome: "--round exists", inScope: ["Add --round"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The usage names --round", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the CLI", when: "help runs", then: "it names --round", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nAdd --round.\n## Decisions\nDEC-001: FR-001 changes the usage.\n## Components\ninternal/cli/cli.go, internal/cli/cli_test.go\n## Data\nOptions\n## Verification\nTests\n## Risks\nThe help test changes";
// The Go tests: the existing help test still expects the old usage until T002 updates it.
const goOutput = "--- FAIL: TestUsage (0.00s)\n    cli_test.go:42: usage = \\\"centsplit [--round MODE] FILE\\\", want \\\"centsplit FILE\\\"\nFAIL\nFAIL\texample.com/centsplit/internal/cli\t0.004s\nFAIL";
const tests: Check = {
  id: "tests",
  executable: "bun",
  args: ["-e", `const s = await Bun.file('internal/cli/cli.go').text(); const t = await Bun.file('internal/cli/cli_test.go').text(); if (s.includes('--round') && !t.includes('--round')) { console.log(${JSON.stringify("${GO}")}); process.exit(1) }`.replace('"${GO}"', JSON.stringify(goOutput))],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "task",
  envNames: [],
  writes: [],
};
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [tests] };
const planned = (id: string, paths: string[], dependsOn: string[] = []): Task => ({ id, title: `Write ${paths.join(", ")}`, description: `Write ${paths.join(", ")}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: paths.map((path) => ({ path, action: "modify" as const })), readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" });
const plan = [planned("T001", ["internal/cli/cli.go", "README.md"]), planned("T002", ["internal/cli/cli_test.go"], ["T001"])];

class ScriptedExecutor implements AgentExecutor {
  implemented: string[] = [];
  constructor(
    private root: string,
    private idle: string[] = [],
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A CLI", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/cli.ts"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: plan } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        this.implemented.push(task?.id ?? "");
        const path = task?.writes[0]?.path ?? "";
        if (this.idle.includes(task?.id ?? "")) {
          output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Already done", evidenceIds: [], unresolved: [] };
          break;
        }
        const content: Record<string, string> = {
          "internal/cli/cli.go": "package cli\n\nconst Usage = \"centsplit [--round MODE] FILE\"\n",
          "README.md": "# centsplit\n\nUsage: centsplit [--round MODE] FILE\n",
          "internal/cli/cli_test.go": "package cli\n\n// want centsplit [--round MODE] FILE\n",
        };
        for (const write of task?.writes ?? []) writeFileSync(join(this.root, write.path), content[write.path] ?? "fixed\n");
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: `Wrote ${path}`, evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runPlan() {
  const root = mkdtempSync(join(tmpdir(), "baked-centsplit-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "internal/cli"), { recursive: true });
  writeFileSync(join(root, "internal/cli/cli.go"), "package cli\n\nconst Usage = \"centsplit FILE\"\n");
  writeFileSync(join(root, "internal/cli/cli_test.go"), "package cli\n\n// want centsplit FILE\n");
  writeFileSync(join(root, "README.md"), "# centsplit\n");
  const executor = new ScriptedExecutor(root);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Add --round; update the usage test", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const snapshot = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  return { root, executor, service, runId: run.runId, done };
}

describe("scenario: centsplit-update 21e03a4e, a Go assertion in a test a dependent task updates (#972)", () => {
  test("the failing Go test hands the failure to the task that updates it, with no corrective", async () => {
    const { root, executor, service, runId, done } = await runPlan();
    expect(done.status).toBe("completed");
    expect(readFileSync(join(root, "internal/cli/cli_test.go"), "utf8")).toContain("--round");
    expect(service.store.run(runId).corrective_tasks).toBe(0);
    expect(executor.implemented).toEqual(["T001", "T002"]);
    const handoff = service.store.latestArtifact(runId, "tasks/handoffs/T001.json");
    if (!handoff) throw new Error("No handoff artifact");
    expect(JSON.parse(service.store.readArtifact(runId, handoff.id))).toMatchObject({ taskId: "T001", checkId: "tests", owners: ["T002"] });
  }, 60000);
});

describe("assertion locations of Go and Rust test runners", () => {
  const tasks = [planned("T001", ["internal/cli/cli.go", "cmd/cli_test.go", "internal/cli/cli_test.go", "tests/cli.rs", "src/main.rs", "main_test.go"])];

  test("go test: a base name under a FAIL package picks the file in that directory", () => {
    expect(failingPathsInOutput(goOutput, tasks)).toEqual(["internal/cli/cli_test.go"]);
    expect(failingPathsInOutput(goOutput.replace("internal/cli", "cmd"), tasks)).toEqual(["cmd/cli_test.go"]);
    // Ambiguous without a package line; a unique name needs none.
    expect(failingPathsInOutput("    cli_test.go:42: wrong", tasks)).toEqual([]);
    expect(failingPathsInOutput("    main_test.go:7: wrong", tasks)).toEqual(["main_test.go"]);
    // A source file is not a test runner's assertion location.
    expect(failingPathsInOutput("    cli.go:3: note\nFAIL\texample.com/x/internal/cli", tasks)).toEqual([]);
  });

  test("cargo test: a panic location names the failing test file", () => {
    const rust = "---- usage stdout ----\nthread 'usage' panicked at tests/cli.rs:12:5:\nassertion failed\n    src/main.rs:3";
    expect(failingPathsInOutput(rust, tasks)).toEqual(["tests/cli.rs"]);
    const owner = planned("T002", ["tests/cli.rs"], ["T001"]);
    const source = planned("T001", ["src/main.rs"]);
    const graph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a", planHash: "b", tasks: [source, owner] } as never;
    const rows = [{ id: "T002", status: "pending" }] as never;
    expect(testUpdateOwners(graph, rows, {}, source, rust)).toEqual(["T002"]);
  });
});
