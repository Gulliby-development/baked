import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { withCommandDependencies } from "../src/core/workflows/plan-consistency.js";
import type { Check, RunPolicy, Spec, Task, TaskGraph } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 16, cfgtrace 49dbf63b and logclump 6d6d1350 (#973). The plan's
// "Write README and MIT license" task writes README.md and LICENSE; only its criterion AC-002 asks
// for the CLI's real output. The task text names no run, the licence made it look like code, so
// it got no edge to the CLI task and ran first, before the command existed.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const OUTPUT = "3 headings, depth 2";
const spec: Spec = {
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "mdtoc", problem: "No CLI", outcome: "A CLI with a README", inScope: ["CLI", "README"], outOfScope: [], assumptions: [], openQuestions: [],
  requirements: [
    { id: "FR-001", text: "The CLI prints a summary of the headings", priority: "must", verification: "automated", sourceRefs: [] },
    { id: "FR-002", text: "The README documents usage", priority: "must", verification: "automated", sourceRefs: [] },
  ],
  criteria: [
    { id: "AC-001", requirementIds: ["FR-001"], given: "a markdown file", when: "the CLI runs", then: "it prints the summary", method: "automated" },
    { id: "AC-002", requirementIds: ["FR-002"], given: "the README", when: "a reader opens it", then: "it shows the worked example with the output copied from running the CLI on the sample file", method: "automated" },
  ],
  dependencies: [],
};
const markdown = "# Plan\n## Context\nA CLI and its README.\n## Decisions\nDEC-001: FR-001 and FR-002 need a CLI and a README.\n## Components\nsrc/cli.ts, README.md\n## Data\nText\n## Verification\nChecks\n## Risks\nNone";
// The README shows the CLI's real output.
const readme: Check = {
  id: "readme",
  executable: "bun",
  args: ["-e", `if (!(await Bun.file('README.md').text()).includes('${OUTPUT}')) { console.log('README.md: no example output'); process.exit(1) }`],
  cwd: ".", timeoutMs: 10000, required: true, scope: "task", envNames: [], writes: [],
};
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [readme] };
const docs: Task = { id: "T001", title: "Write README and MIT license", description: "Document installation and usage, and add the MIT license.", requirementIds: ["FR-002"], criterionIds: ["AC-002"], dependsOn: [], profileId: "implementer", writes: [{ path: "README.md", action: "create" }, { path: "LICENSE", action: "create" }], readHints: [], checkIds: ["readme"], origin: "planned", findingIds: [], rationale: "Docs" };
const cli: Task = { id: "T002", title: "Implement the CLI", description: "Parse the file and print the summary.", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/cli.ts", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Code" };

class ScriptedExecutor implements AgentExecutor {
  implemented: string[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Empty", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/cli.ts"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [docs, cli] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        this.implemented.push(task?.id ?? "");
        if (task?.writes.some((w) => w.path === "src/cli.ts")) writeFileSync(join(this.root, "src/cli.ts"), `console.log("${OUTPUT}");\n`);
        else {
          // The worker can only paste the output when the command exists.
          const ran = existsSync(join(this.root, "src/cli.ts"));
          writeFileSync(join(this.root, "README.md"), `# mdtoc\n\n${ran ? OUTPUT : "(output to be captured)"}\n`);
          writeFileSync(join(this.root, "LICENSE"), "MIT\n");
        }
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Done", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: spec.criteria.map((c) => ({ criterionId: c.id, verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" })), findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: cfgtrace 49dbf63b, a README whose criterion asks for the CLI's output (#973)", () => {
  test("the README task runs after the CLI task and pastes real output without a correction", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-readme-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "src"));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Build mdtoc with a README that shows real output", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const snapshot = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No approval request");
    await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(executor.implemented.slice(0, 2)).toEqual(["T002", "T001"]);
    expect(done.status).toBe("completed");
    expect(service.store.run(run.runId).corrective_tasks).toBe(0);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain(OUTPUT);
  }, 60000);
});

describe("withCommandDependencies reads the criteria a docs task covers", () => {
  const graph = (...tasks: Task[]): TaskGraph => ({ schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a", planHash: "b", tasks }) as TaskGraph;
  const deps = (g: TaskGraph) => g.tasks.map((t) => t.dependsOn);
  test("a criterion asking for copied output adds the edge; a licence beside the README keeps it docs", () => {
    expect(deps(withCommandDependencies(graph(docs, cli), spec))).toEqual([["T002"], []]);
  });
  test("without the spec, or when the criteria ask for no output, no edge is added", () => {
    expect(deps(withCommandDependencies(graph(docs, cli)))).toEqual([[], []]);
    const plain = { ...spec, criteria: spec.criteria.map((c) => (c.id === "AC-002" ? { ...c, then: "it lists the options and the license" } : c)) };
    expect(deps(withCommandDependencies(graph(docs, cli), plain))).toEqual([[], []]);
  });
  test("a read hint that names captured output adds the edge", () => {
    const hinted = { ...docs, readHints: ["examples/sample-output.txt"] };
    expect(deps(withCommandDependencies(graph(hinted, cli)))).toEqual([["T002"], []]);
  });
});
