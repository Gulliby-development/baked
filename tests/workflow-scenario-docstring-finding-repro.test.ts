import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { codeWithoutComments, commentOnlyChange } from "../src/core/intelligence/comments.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { reproCannotSeeCorrection } from "../src/core/verification/repro.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, Repro, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 43, intsmith ca6f3023 (#1517). T009 wrote a false bound into the module
// docstring of cfrac.py ("the period has at most 2 * isqrt(d) states"; sqrt_period(9949) is 217).
// The correctness review found it as F2 and attached a repro printing the code's period against
// that bound, with expected "(True, True)": the value the claim calls wrong. Corrective T012 fixed
// the docstring, the repro printed "(False, False)" five times, the task ended spec_conflict and,
// under clarification assume, the run still asked a person (2.2M tokens, one intervention).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const CODE = "export const period = (d: number) => (d === 9949 ? 217 : 1);\n";
const WRONG = `/** The period has at most 2 * isqrt(d) states. */\n${CODE}`;
const RIGHT = `/** The period can exceed 2 * isqrt(d): sqrt(9949) has period 217. */\n${CODE}`;
// A correction that also changes code: the repro gates it, and the safety net decides.
const RIGHT_WITH_CODE = `${RIGHT}export const WORKLOAD = 9949;\n`;

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Periods", problem: "Continued fraction periods", outcome: "Correct periods with an honest cost note", inScope: ["cfrac.ts"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "period(d) returns the period of the continued fraction of sqrt(d)", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "d = 9949", when: "period runs", then: "it returns 217", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne library.\n## Decisions\nDEC-001: FR-001 in cfrac.ts.\n## Components\ncfrac.ts\n## Data\nNumbers\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "const { period } = await import(`${process.cwd()}/cfrac.ts`); if (period(9949) !== 217) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [check], clarification: "assume" };
const planned: Task = { id: "T001", title: "Write the library", description: "Write cfrac.ts", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "cfrac.ts", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };
// The bound the docstring states, checked against the code: no docstring edit changes it.
const repro: Repro = { executable: "bun", args: ["-e", "const { period } = await import(`${process.cwd()}/cfrac.ts`); console.log(String(period(9949) <= 2 * Math.floor(Math.sqrt(9949))))"], expected: "true", actual: "false" };

class ScriptedExecutor implements AgentExecutor {
  /** The host's repro verdicts a corrective worker saw, one per attempt. */
  verdicts: string[][] = [];
  correctiveAttempts = 0;
  constructor(
    private root: string,
    private correction: string,
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["cfrac.ts"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        if (task?.origin === "planned") {
          writeFileSync(join(this.root, "cfrac.ts"), WRONG);
          output = { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Wrote cfrac.ts", evidenceIds: [], unresolved: [] };
          break;
        }
        this.correctiveAttempts++;
        if (this.correctiveAttempts > 1) {
          // The rerun under the assumption adds the workload's term count; the repro no longer gates.
          writeFileSync(join(this.root, "cfrac.ts"), `${this.correction}export const TERMS = 434;\n`);
          this.verdicts.push((await request.reproCheck?.(this.root, request.signal)) ?? []);
          output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "The docstring states the true bound", evidenceIds: [], unresolved: [] };
          break;
        }
        writeFileSync(join(this.root, "cfrac.ts"), this.correction);
        const verdict = (await request.reproCheck?.(this.root, request.signal)) ?? [];
        this.verdicts.push(verdict);
        output = verdict.length
          ? { schemaVersion: 1, taskId: task?.id, outcome: "spec_conflict", summary: "The required repro expects 217 <= 198; meeting it would falsify the period", evidenceIds: [], unresolved: ["The repro's expected value contradicts the spec"] }
          : { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Corrected the docstring", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": output = pass; break;
      case "convergence": {
        if (!readFileSync(join(this.root, "cfrac.ts"), "utf8").includes("at most")) {
          output = pass;
          break;
        }
        const finding = { id: "F2", kind: "correctness", severity: "high", basis: "spec", confidence: 1, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "cfrac.ts", symbol: "period", evidenceIds, claim: "The docstring of cfrac.ts incorrectly bounds the period by 2*isqrt(d): sqrt(9949) has period 217 > 198", impact: "The cost justification is false", suggestedFix: "State the true bound in the docstring", repro };
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: "The docstring is false" }], findings: [finding] };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function run(correction: string) {
  const root = mkdtempSync(join(tmpdir(), "baked-intsmith-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root, correction);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Compute periods", ownerLabel: "test", policy });
  await service.drive(started.runId, new AbortController().signal);
  const snapshot = await service.get(started.runId);
  const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(started.runId, new AbortController().signal);
  const artifacts = service.store.artifacts(started.runId).map((a) => a.logical_path);
  const clarifications = service.store.requests(started.runId).filter((r) => r.kind === "clarification");
  return { done, executor, artifacts, clarifications, root, service, runId: started.runId };
}

describe("scenario: intsmith ca6f3023, a docstring finding whose repro runs the code (#1517)", () => {
  test("a correction that changes only the docstring is not held by the repro and asks nobody", async () => {
    const { done, executor, clarifications, root, service, runId } = await run(RIGHT);
    expect(done.status).toBe("completed");
    expect(executor.verdicts).toEqual([[]]);
    expect(clarifications).toEqual([]);
    expect(readFileSync(join(root, "cfrac.ts"), "utf8")).toBe(RIGHT);
    const check = service.store.artifacts(runId).find((a) => a.logical_path.includes("/repro-check-"));
    expect(JSON.parse(service.store.readArtifact(runId, check?.id ?? "")).evidenceOnly).toEqual([expect.any(String)]);
  }, 90_000);

  test("a correction that also changes code is held, and its spec conflict is assumed, not asked", async () => {
    const { done, executor, clarifications, artifacts } = await run(RIGHT_WITH_CODE);
    // The repro still gates a correction that changed code; the conflict it raises is decided by
    // the assumption, and the rerun is no longer held by it.
    expect(executor.verdicts[0]?.length).toBe(1);
    expect(executor.verdicts.at(-1)).toEqual([]);
    expect(clarifications).toEqual([]);
    expect(artifacts.some((p) => /^assumptions\/conflicts\/.+\.json$/.test(p))).toBe(true);
    expect(done.status).toBe("completed");
  }, 90_000);
});

describe("comments and docstrings of source files (#1517)", () => {
  test("a change only to comments or docstrings is a comment-only change in each language", () => {
    const cases: [string, string, string][] = [
      ["cfrac.py", '"""At most 2 * isqrt(d) states."""\nimport math\n\ndef period(d):\n    # a bound\n    return 1\n', '"""The period can be longer."""\nimport math\n\ndef period(d):\n    """Docstring."""\n    return 1\n'],
      ["cfrac.ts", "/** At most 400 terms. */\nexport const a = 1; // note\n", "// The true bound\nexport const a = 1;\n"],
      ["cfrac.go", "package cfrac\n\n// At most 400 terms.\nfunc A() int { return 1 }\n", "package cfrac\n\n/* The real bound. */\nfunc A() int { return 1 }\n"],
      ["cfrac.lua", "-- bound\nreturn 1\n", "--[[ longer\nnote ]]\nreturn 1\n"],
    ];
    for (const [path, before, after] of cases) expect([path, commentOnlyChange(path, before, after)]).toEqual([path, true]);
  });

  test("a change to code, strings or a value that looks like a comment is not", () => {
    expect(commentOnlyChange("a.ts", "export const a = 1;\n", "export const a = 2;\n")).toBe(false);
    expect(commentOnlyChange("a.ts", 'const u = "http://a";\n', 'const u = "http://b";\n')).toBe(false);
    expect(commentOnlyChange("a.py", 'x = "a # b"\n', 'x = "a # c"\n')).toBe(false);
    expect(commentOnlyChange("a.py", 'x = """bound"""\n', 'x = """other"""\n')).toBe(false);
    expect(commentOnlyChange("a.sh", "echo $# one\n", "echo $# two\n")).toBe(false);
    expect(commentOnlyChange("a.ts", "export const a = 1;\n", "export const a = 1;\n")).toBe(false);
    expect(codeWithoutComments("README.md", "# title")).toBeNull();
  });

  test("a repro cannot see a comment-only correction, nor a document's; it sees a code change", () => {
    expect(reproCannotSeeCorrection("cfrac.ts", repro, { before: WRONG, after: RIGHT })).toBe(true);
    expect(reproCannotSeeCorrection("cfrac.ts", repro, { before: WRONG, after: RIGHT_WITH_CODE })).toBe(false);
    expect(reproCannotSeeCorrection("cfrac.ts", repro)).toBe(false);
    expect(reproCannotSeeCorrection("README.md", repro)).toBe(true);
  });
});
