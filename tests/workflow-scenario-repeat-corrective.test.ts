import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, Repro, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 52 (#1764, #1774). md-site: a review found a tab before `javascript:`
// (F-002, inferred, security), a correction fixed it, and the next pass found a U+0001 before it
// (F-003, `repeatOf: F-002`), whose correction cost 2.46M tokens, 21 percent of the run. Here the
// repeat's correction gets the earlier correction's patch and a step that names the class.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Inline parser", problem: "No parser", outcome: "A parser", inScope: ["Parser"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Delimiters inside code and links are literal", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "inline code or a link", when: "it is parsed", then: "its delimiters are literal", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne parser.\n## Decisions\nDEC-001: FR-001 in inline.txt.\n## Components\ninline.txt\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "const t = await Bun.file('inline.txt').text(); if (!t.includes('ready')) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 3, checks: [check] };
const planned: Task = { id: "T001", title: "Write the inline parser", description: "Write inline.txt", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "inline.txt", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };
// "tab" in the file stands for the tab case handled, "control" for the control character case.
const reproFor = (marker: string): Repro => ({ executable: "bun", args: ["-e", `const t = await Bun.file('inline.txt').text(); console.log(t.includes('${marker}') ? 'suppressed' : 'script')`], expected: "suppressed", actual: "script" });

class ScriptedExecutor implements AgentExecutor {
  corrections: { findingIds: string[]; description: string; recurring?: { earlier: { id: string; correction?: { taskId: string; patch: string } }[] } }[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[]; recurringFindings?: { earlier: { id: string; correction?: { taskId: string; patch: string } }[] } } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] };
    const root = request.root ?? this.root;
    const write = (text: string) => writeFileSync(join(root, "inline.txt"), text);
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["inline.txt"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        if (task?.origin === "planned") write("ready");
        else {
          this.corrections.push({ findingIds: task?.findingIds ?? [], description: task?.description ?? "", recurring: data.extra.recurringFindings });
          write(this.corrections.length === 1 ? "ready tab" : "ready tab control");
        }
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Suppressed the scheme", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": output = pass; break;
      case "convergence": {
        const text = readFileSync(join(root, "inline.txt"), "utf8");
        const finding = (id: string, marker: string, claim: string, repeatOf: string | null) => ({ id, kind: "security", severity: "high", basis: "inferred", confidence: 0.99, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "inline.txt", symbol: "sanitizeUrl", evidenceIds, claim, impact: "Script runs on click", suggestedFix: "Strip the prefix before the scheme check", repro: reproFor(marker), repeatOf });
        const findings = !text.includes("tab")
          ? [finding("F1", "tab", "A tab before javascript: bypasses the scheme suppression", null)]
          : !text.includes("control")
            ? [finding("F2", "control", "A U+0001 before javascript: bypasses the scheme suppression", "F1")]
            : [];
        output = findings.length
          ? { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: findings[0]?.claim }], findings }
          : pass;
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function run(runPolicy: RunPolicy) {
  const root = mkdtempSync(join(tmpdir(), "baked-repeat-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy: runPolicy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Sanitize link URLs", ownerLabel: "test", policy: runPolicy });
  await service.drive(started.runId, new AbortController().signal);
  const snapshot = await service.get(started.runId);
  const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(started.runId, new AbortController().signal);
  return { done, executor };
}

describe("scenario: md-site, a repeat of a corrected inferred finding (bench round 52)", () => {
  test("the repeat's correction gets the earlier patch and a step that names the class", async () => {
    const { done, executor } = await run(policy);
    expect(done.status).toBe("completed");
    const [first, second] = executor.corrections;
    expect(first?.findingIds).toEqual(["F1"]);
    expect(first?.description).toContain("Look for the same defect in sibling code paths");
    expect(second?.findingIds).toEqual(["F2"]);
    expect(second?.description).toContain("This finding repeats F1");
    expect(second?.description).toContain("Name the class of input");
    expect(second?.description).not.toContain("sibling code paths");
    const earlier = second?.recurring?.earlier.find((f) => f.id === "F1");
    expect(earlier?.correction?.taskId).toBe("T002");
    // The scripted worker writes past the edit journal, so the diff names the file without hunks.
    expect(earlier?.correction?.patch).toContain("inline.txt");
  }, 60000);
});
