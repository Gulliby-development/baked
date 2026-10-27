import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 72 (#2270). evalpin foundation 41fc3fd3: the brief prescribes the cli stub
// `pub fn run(args: &[String], io: &mut dyn Io) -> i32 { 2 }`, which `cargo clippy -D warnings`
// rejects for its unused parameters, so the implementer put `#[allow(unused_variables)]` on it. The
// test-integrity guard counted the allow as added in a created file, and kept counting it after a
// person answered twice that the request wins: six correctives, then no_progress, nothing
// committed. Here T001 writes the stub with the allow.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const STUB = "#[allow(unused_variables)]\npub fn run(args: &[String], io: &mut dyn Io) -> i32 {\n    2\n}\n";
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Foundation", problem: "No cli", outcome: "A cli stub", inScope: ["Cli stub"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The cli stub returns 2", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "any arguments", when: "run is called", then: "it returns 2", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne stub.\n## Decisions\nDEC-001: FR-001 is a stub.\n## Components\nsrc/cli.rs\n## Data\nNone\n## Verification\nChecks\n## Risks\nNone for fixture";
const tasks: Task[] = [{ id: "T001", title: "Write src/cli.rs", description: "Write the prescribed cli stub", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/cli.rs", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }];
const check: Check = { id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [check] };

/** Writes the stub with its allow; a correction reports the conflict until a person answered. */
class StubExecutor implements AgentExecutor {
  corrections: string[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/cli.rs"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const base = { schemaVersion: 1, taskId: request.task?.id, evidenceIds: [], unresolved: [] as string[] };
        if (request.task?.origin === "planned") {
          mkdirSync(join(this.root, "src"), { recursive: true });
          writeFileSync(join(this.root, "src/cli.rs"), STUB);
          output = { ...base, outcome: "implemented", summary: "Wrote the stub" };
          break;
        }
        this.corrections.push(request.task?.id ?? "");
        const answered = request.prompt.includes("already answered") || request.prompt.includes("request wins");
        output = answered
          ? { ...base, outcome: "already_satisfied", summary: "Kept the prescribed stub with its allow, as the answer says", evidenceIds: evidence }
          : { ...base, outcome: "spec_conflict", summary: "The request prescribes the stub with unused parameters; clippy -D warnings rejects it without the allow", unresolved: ["Keep the allow or change the prescribed stub?"] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: evidence, explanation: "The stub returns 2" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function run(prompt: string) {
  const root = mkdtempSync(join(tmpdir(), "baked-prescribed-suppression-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new StubExecutor(root);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy });
  const runId = started.runId;
  await service.drive(runId, new AbortController().signal);
  const waiting = await service.get(runId);
  const approval = service.store.requests(runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
  await service.decide(runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  let current = await service.drive(runId, new AbortController().signal);
  const asked = () => service.store.requests(runId).filter((r) => r.kind === "clarification");
  for (let round = 0; round < 4 && current.status !== "completed"; round++) {
    const pending = asked().find((r) => r.status === "pending");
    if (!pending) break;
    const question = (JSON.parse(pending.body_json) as { questions: { id: string }[] }).questions[0]!.id;
    await service.decide(runId, { commandId: newId(), expectedRevision: current.revision }, { kind: "answer", requestId: pending.id, answers: { [question]: "The request wins: keep the stub as prescribed, with its allow." } });
    current = await service.drive(runId, new AbortController().signal);
  }
  const suppressions = service.store
    .findings(runId)
    .filter((f) => (JSON.parse(f.body_json) as { claim: string }).claim.startsWith("Test integrity (suppression)"));
  return { root, executor, service, current, asked: asked(), suppressions };
}

describe("scenario: evalpin foundation 41fc3fd3, a suppression on a prescribed stub (#2270)", () => {
  test("a suppression the request names verbatim is prescribed: no finding, no correction", async () => {
    const { current, executor, suppressions } = await run(
      "Write the cli stub exactly as `#[allow(unused_variables)] pub fn run(args: &[String], io: &mut dyn Io) -> i32 { 2 }`.",
    );
    expect(current.status).toBe("completed");
    expect(suppressions).toHaveLength(0);
    expect(executor.corrections).toEqual([]);
  }, 90_000);

  test("one not named is a finding once, and a person's answer that the request wins settles it", async () => {
    const { root, current, executor, asked, suppressions } = await run(
      "Write the cli stub exactly as `pub fn run(args: &[String], io: &mut dyn Io) -> i32 { 2 }`.",
    );
    expect(suppressions).toHaveLength(1);
    expect(asked).toHaveLength(1);
    expect(current.status).toBe("completed");
    // The correction asked once and finished under the answer; no scan raised the allow again.
    expect(executor.corrections).toHaveLength(2);
    expect(readFileSync(join(root, "src/cli.rs"), "utf8")).toBe(STUB);
  }, 90_000);
});
