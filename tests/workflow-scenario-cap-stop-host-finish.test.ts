import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { canonical, hashBytes, hashJson } from "../src/core/specs/hash.js";
import { attemptCapFault } from "../src/core/workflows/agent-executor.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, Repro, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 63, md-site 54da0241 (#1978). Convergence found that `tags: [a], b]`
// parsed wrong in `parseTagItem`; corrective T012 needed a 7-line fix. Its first session made the
// fix with its first edit, so the finding's repro passed, and then ended at its uncached cap
// (each call re-sent a ~107k-token prompt). The host still started a second model session
// (`widened_correction`) and a third: 3.04M tokens, 30.6 percent of the run, for the diff of the
// first. Now a stopped corrective whose edits pass its repro and its required checks is finished
// by the host, without another model session.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Tags", problem: "Tags parse wrong", outcome: "Tags parse", inScope: ["Parse tags"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "A tag list with a bracket inside parses as written", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "tags: [a], b]", when: "it parses", then: "the tags are [a] and b", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA front-matter parser.\n## Decisions\nDEC-001: FR-001 in src/tags.ts.\n## Components\nsrc/tags.ts, src/page.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
// A large file next to the fix, as md-site's 107k-token corrective prompt: the fix is 7 lines.
const BULK = Array.from({ length: 4000 }, (_, i) => `// row ${i}: ${"x".repeat(80)}`).join("\n");
const BROKEN = `${BULK}\nexport const parseTagItem = (s: string) => s.split(",");\n`;
const FIXED = `${BULK}\nexport const parseTagItem = (s: string) => {\n  // fixed: a bracket inside an item\n  const out: string[] = [];\n  for (const part of s.split(/,(?![^[]*\\])/)) out.push(part.trim());\n  return out;\n};\n`;
const HALF = `${BULK}\nexport const parseTagItem = (s: string) => s.split(","); // half\n`;
const PROGRAM = "const t = await Bun.file('src/tags.ts').text(); console.log(t.includes('fixed') ? 'a],b' : 'a,],b')";
const repro: Repro = { executable: "bun", args: ["-e", PROGRAM], expected: "a],b", actual: "a,],b" };
// The task-end check: the parser file must not hold a half fix.
const typecheck: Check = { id: "typecheck", executable: "bun", args: ["-e", "const t = await Bun.file('src/tags.ts').text(); if (t.includes('half')) { console.log('src/tags.ts: half a fix'); process.exit(1) }"], cwd: ".", timeoutMs: 10000, required: true, scope: "task", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [typecheck, { ...typecheck, id: "tests", scope: "feature" }] };
const planned: Task = { id: "T001", title: "Write the parser", description: "Write src/tags.ts and src/page.ts", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/tags.ts", action: "create" }, { path: "src/page.ts", action: "create" }], readHints: [], checkIds: ["typecheck"], origin: "planned", findingIds: [], rationale: "Required behavior" };

interface Behavior {
  /** How the corrective's first session ends. */
  end: "cap" | "watcher";
  /** What each session's edit leaves in src/tags.ts before it ends that way; later ones submit the fix. */
  edits: string[];
  /** What the planned task leaves in src/tags.ts; a half fix fails its typecheck (task-level repair). */
  planned?: string;
}

class ScriptedExecutor implements AgentExecutor {
  /** Each corrective model session: its task, the size of its prompt. */
  sessions: { taskId: string; promptChars: number }[] = [];
  service?: NativeWorkflowService;
  constructor(
    private workspace: string,
    private behavior: Behavior,
  ) {}
  async execute(request: ExecutionRequest) {
    const root = request.root ?? this.workspace;
    const write = (path: string, text: string) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/tags.ts"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task as Task;
        if (task.origin === "planned") {
          write("src/tags.ts", this.behavior.planned ?? BROKEN);
          write("src/page.ts", "export const page = 1;\n");
          output = { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Wrote the parser", evidenceIds: [], unresolved: [] };
          break;
        }
        this.sessions.push({ taskId: task.id, promptChars: request.prompt.length });
        const edit = this.behavior.edits[this.sessions.length - 1];
        if (edit === undefined) {
          // A later session submits the fix with a check, as md-site's third session did.
          write("src/tags.ts", FIXED);
          output = { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Fixed parseTagItem", evidenceIds: [], unresolved: [] };
          break;
        }
        write("src/tags.ts", edit);
        const watcher = this.behavior.end === "watcher";
        // The attempt's usage, as the executor writes it at each step: one edit, then reads.
        this.service?.store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, canonical({ schemaVersion: 1, profileId: request.profile.id, taskId: task.id, maxSteps: request.maxSteps, maxTokens: 1000, stopReason: watcher ? "submitted" : "tokens", finalizedBy: watcher ? "watcher" : "tokens", totalTokens: 1000, steps: [["read"], ["edit_file"], ["read"], ["read"]].map((tools) => ({ inputTokens: 250, outputTokens: 10, cacheReadTokens: null, toolCalls: tools.length, tools, compactedBytes: 0 })) }));
        if (!watcher) throw attemptCapFault(request.profile.id, 1000, 1000);
        // The watcher's forced submit: the worker could not rerun the checks.
        output = { schemaVersion: 1, taskId: task.id, outcome: "blocked", summary: "Stopped by the progress watcher", evidenceIds: [], unresolved: ["The checks could not be rerun before the stop"] };
        break;
      }
      case "review": output = pass; break;
      case "convergence": {
        if (readFileSync(join(root, "src/tags.ts"), "utf8").includes("fixed")) {
          output = pass;
          break;
        }
        const finding = { id: "F1", kind: "correctness", severity: "medium", basis: "spec", confidence: 0.99, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "src/tags.ts", symbol: "parseTagItem", evidenceIds, claim: "parseTagItem splits `tags: [a], b]` inside the bracket", impact: "Tags with a bracket are wrong", suggestedFix: "Split outside brackets", repro };
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: "Brackets split" }], findings: [finding] };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function runScenario(behavior: Behavior, parallel = false) {
  const root = mkdtempSync(join(tmpdir(), "baked-capfinish-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  if (parallel) {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.test");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, ".gitignore"), ".baked/\n");
    writeFileSync(join(root, "README.md"), "# Tags\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "Initial");
  }
  const executor = new ScriptedExecutor(root, behavior);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  executor.service = service;
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Parse tags", ownerLabel: "test", policy, ...(parallel ? { executionMode: "worktree" as const, maxConcurrentWriters: 2 } : {}) });
  await service.drive(run.runId, new AbortController().signal);
  const snapshot = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  const { store } = service;
  const finishes = store.artifacts(run.runId).filter((a) => /^tasks\/[^/]+\/host-finish\.json$/.test(a.logical_path));
  const finish = finishes.length ? (JSON.parse(store.readArtifact(run.runId, finishes.at(-1)?.id ?? "")) as { stoppedBy: string; repro: string; checks: string[] }) : null;
  const errors = store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/"));
  return { done, executor, finish, lastError: errors.length ? store.readArtifact(run.runId, errors.at(-1)?.id ?? "") : "" };
}

describe("scenario: md-site 54da0241, a corrective stopped at its cap with the repro passing (#1978)", () => {
  test("the host finishes it on its edits without a second model session", async () => {
    const { done, executor, finish, lastError } = await runScenario({ end: "cap", edits: [FIXED] });
    expect(lastError).toBe("");
    expect(done.status).toBe("completed");
    expect(executor.sessions).toHaveLength(1);
    expect(executor.sessions[0]?.promptChars).toBeGreaterThan(50_000);
    expect(finish).toMatchObject({ stoppedBy: "tokens", repro: "passed", checks: ["typecheck"] });
  }, 60000);

  test("a task-level repair, whose finding names the failed check, is finished the same way", async () => {
    const { done, executor, finish } = await runScenario({ end: "cap", edits: [FIXED], planned: HALF });
    expect(done.status).toBe("completed");
    expect(executor.sessions).toHaveLength(1);
    expect(finish).toMatchObject({ stoppedBy: "tokens", repro: "none", checks: ["typecheck"] });
  }, 60000);

  test("an attempt the progress watcher stopped is finished the same way", async () => {
    const { done, executor, finish } = await runScenario({ end: "watcher", edits: [FIXED] });
    expect(done.status).toBe("completed");
    expect(executor.sessions).toHaveLength(1);
    expect(finish).toMatchObject({ stoppedBy: "watcher", repro: "passed" });
  }, 60000);

  test("in a task worktree with several writers too", async () => {
    const { done, executor, finish } = await runScenario({ end: "cap", edits: [FIXED] }, true);
    expect(done.status).toBe("completed");
    expect(executor.sessions).toHaveLength(1);
    expect(finish).toMatchObject({ stoppedBy: "tokens", repro: "passed" });
  }, 60000);

  test("edits that still reproduce the finding, or fail a required check, get the next session", async () => {
    // HALF still prints the wrong tags and fails typecheck.
    const { done, executor, finish } = await runScenario({ end: "cap", edits: [HALF] });
    expect(done.status).toBe("completed");
    expect(executor.sessions.length).toBeGreaterThan(1);
    expect(finish).toBeNull();
  }, 60000);

  test("a cap stop that would stop the run is finished by the host when its edits pass", async () => {
    // The first stop widened the correction; a second cap stop on the same task stops the run.
    const { done, executor, finish, lastError } = await runScenario({ end: "cap", edits: [HALF, FIXED] });
    expect(lastError).toBe("");
    expect(done.status).toBe("completed");
    expect(executor.sessions).toHaveLength(2);
    expect(finish).toMatchObject({ stoppedBy: "tokens", repro: "passed" });
  }, 60000);
});
