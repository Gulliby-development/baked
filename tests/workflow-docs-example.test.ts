import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { namesExampleRule } from "../src/core/workflows/analysis-notes.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Bench round 17, dirdrift 120a6a97 (#992). A README task had to show the request's five-line
// worked example, but the implementer rule said to run every example and never write output from
// the spec, and the request's fixture did not exist. The task reported spec_conflict and the run
// asked a person under `--clarification assume`; the answer was "copy the example verbatim".

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const EXAMPLE = "$ drift diff --sizes before.json ./site\n~ index.html 1.2 KB -> 1.4 KB";
const REQUEST = `Document the sized report in README.md with this worked example:\n\n\`\`\`\n${EXAMPLE}\n\`\`\``;
const CONFLICT =
  "FR-001 needs the worked example in the README, but the implementer instruction forbids writing example output from the spec, and the probe `drift diff --sizes before.json ./site` exited 2: ./site: not a directory.";
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Sized report docs", problem: "The README lacks the example", outcome: "The README shows it", inScope: ["README"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The README shows the worked example", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the README", when: "it is read", then: "it shows the worked example", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nDocs.\n## Decisions\nDEC-001: FR-001 writes README.md.\n## Components\nREADME.md\n## Data\nText\n## Verification\nThe README check\n## Risks\nNone for fixture";
const check: Check = { id: "readme", executable: "bun", args: ["-e", "if (!(await Bun.file('README.md').text()).includes('1.2 KB -> 1.4 KB')) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume", checks: [check] };
const docsTask: Task = { id: "T001", title: "Document sized text reports", description: "Write the README section with the worked example", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "README.md", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" };

class ScriptedExecutor implements AgentExecutor {
  implementations: ExecutionRequest[] = [];
  constructor(private root: string, private task: Task) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const coverage = () => [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" }];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["README.md"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [this.task] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        this.implementations.push(request);
        if (this.implementations.length === 1) {
          output = { schemaVersion: 1, taskId: "T001", outcome: "spec_conflict", summary: CONFLICT, evidenceIds: [], unresolved: [] };
          break;
        }
        for (const write of this.task.writes) writeFileSync(join(this.root, write.path), `# drift\n\n\`\`\`\n${EXAMPLE}\n\`\`\`\n`);
        output = { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Copied the worked example from the request", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: coverage(), findings: [] }; break;
      case "convergence": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: coverage(), findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function run(task: Task) {
  const root = mkdtempSync(join(tmpdir(), "baked-docs-example-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root, task);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy });
  await service.drive(started.runId, new AbortController().signal);
  const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(started.runId, { commandId: newId(), expectedRevision: (await service.get(started.runId)).revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(started.runId, new AbortController().signal);
  return { root, executor, service, runId: started.runId, done };
}

describe("scenario: dirdrift 120a6a97, a README task and the request's worked example (#992)", () => {
  test("under assume the request's example wins once and the task copies it without asking a person", async () => {
    const { root, executor, service, runId, done } = await run(docsTask);
    expect(service.store.requests(runId).some((r) => r.kind === "clarification")).toBe(false);
    expect(done.status).toBe("completed");
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain(EXAMPLE);
    expect(executor.implementations).toHaveLength(2);
    expect(executor.implementations[1]?.prompt).toContain("copy every example output the request or the spec gives");
    const assumed = service.store.latestArtifact(runId, "assumptions/conflicts/T001.json");
    expect(assumed && service.store.readArtifact(runId, assumed.id)).toContain("worked example is authoritative");
  });

  test("the same report from a task that writes code still asks a person", async () => {
    const codeTask: Task = { ...docsTask, title: "Add the sized report", writes: [{ path: "drift.ts", action: "create" }, { path: "README.md", action: "create" }] };
    const { service, runId, done } = await run(codeTask);
    expect(done.status).toBe("waiting");
    expect(service.store.requests(runId).some((r) => r.kind === "clarification" && r.status === "pending")).toBe(true);
  });
});

describe("the implementer's rule for documentation examples", () => {
  test("copies an example the request gives and probes only the others", () => {
    const implementer = builtinProfiles.find((p) => p.id === "implementer");
    const text = JSON.stringify(implementer);
    expect(text).toContain("copy that example exactly as given");
    expect(text).not.toContain("never write example output from the spec");
  });
  test("recognises a report about that rule", () => {
    expect(namesExampleRule(CONFLICT)).toBe(true);
    expect(namesExampleRule("The README heading-only: the probes could not reproduce the request's schema example.")).toBe(true);
    expect(namesExampleRule("tests/value.test.ts expects 'done' where AC-001 says ready.")).toBe(false);
  });
});
