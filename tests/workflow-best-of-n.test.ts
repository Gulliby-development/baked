import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import {
  type CandidateResult,
  candidateModel,
  candidatesToJudge,
  changedLineCount,
  normalizedFingerprint,
  selectCandidate,
} from "../src/core/workflows/candidates.js";
import { estimatePreRun } from "../src/core/workflows/estimate.js";
import { runReport } from "../src/core/workflows/run-report.js";
import { type Check, PolicySchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec } from "./helpers/workflow-fixture.js";

const result = (index: number, fields: Partial<CandidateResult> = {}): CandidateResult => ({
  index,
  outcome: "done",
  failedChecks: [],
  fingerprint: `f${String(index)}`,
  changedLines: 2,
  score: null,
  ...fields,
});

describe("best-of-N selection", () => {
  test("drops failing candidates, then votes by normalized change", () => {
    expect(normalizedFingerprint([["a.ts", "let x =  1;\n\n"]])).toBe(
      normalizedFingerprint([["a.ts", "let x = 1;"]]),
    );
    expect(normalizedFingerprint([["a.ts", null]])).not.toBe(normalizedFingerprint([["a.ts", ""]]));
    expect(changedLineCount("--- a/x\n+++ b/x\n@@\n-old\n+new\n+more\n same")).toBe(3);
    const vote = selectCandidate([
      result(1, { failedChecks: ["lint"], fingerprint: "same" }),
      result(2, { fingerprint: "same", changedLines: 5 }),
      result(3, { fingerprint: "same", changedLines: 3 }),
      result(4, { fingerprint: "other" }),
    ]);
    expect(vote).toMatchObject({ winner: 3, method: "vote", passing: [2, 3, 4] });
    expect(vote.clusters).toEqual([[3, 2], [4]]);
    expect(vote.reason).toBe("2 of the 3 candidates that passed their checks made the same change");
  });

  test("breaks a tied vote with critic scores, then with the smallest change", () => {
    const tied = [result(1, { changedLines: 9 }), result(2, { changedLines: 4 }), result(3)];
    expect(candidatesToJudge(tied, false)).toEqual([3, 2, 1]);
    expect(selectCandidate(tied)).toMatchObject({ winner: 3, method: "smallest" });
    const scored = tied.map((r) => ({ ...r, score: r.index === 1 ? 0.9 : 0.5 }));
    const judged = selectCandidate(scored);
    expect(judged).toMatchObject({ winner: 1, method: "critic" });
    expect(judged.reason).toContain("the critic scored candidate 1 highest (0.90)");
    // A clear vote needs no judge, unless the calibrated critic decides.
    const clear = [result(1, { fingerprint: "x" }), result(2, { fingerprint: "x" }), result(3)];
    expect(candidatesToJudge(clear, false)).toEqual([]);
    expect(candidatesToJudge(clear, true)).toEqual([1, 2, 3]);
    const decided = selectCandidate(
      clear.map((r) => ({ ...r, score: r.index === 3 ? 0.95 : 0.6 })),
      true,
    );
    expect(decided).toMatchObject({ winner: 3, method: "critic" });
  });

  // #769: a test the spec decides tells finalists of a tied vote apart before the critic.
  test("a distinguishing test narrows a tie before the critic and the smallest change", () => {
    const tied = [result(1, { changedLines: 1 }), result(2, { changedLines: 5 }), result(3, { changedLines: 3 })];
    expect(selectCandidate(tied, false, [2])).toMatchObject({
      winner: 2,
      method: "distinguishing-test",
      finalists: [1, 3, 2],
    });
    const two = selectCandidate(tied, false, [2, 3]);
    expect(two).toMatchObject({ winner: 3, method: "smallest" });
    expect(two.reason).toContain("candidates 3, 2 passed the distinguishing test");
    // A test every finalist passes, or none does, decides nothing.
    expect(selectCandidate(tied, false, [1, 2, 3])).toMatchObject({ winner: 1, method: "smallest" });
    expect(selectCandidate(tied, false, [])).toMatchObject({ winner: 1, method: "smallest" });
    // It never overrides the vote.
    const voted = [result(1, { fingerprint: "x" }), result(2, { fingerprint: "x" }), result(3)];
    expect(selectCandidate(voted, false, [3])).toMatchObject({ winner: 1, method: "vote" });
  });

  test("candidate k runs on candidateModels[k mod n]", () => {
    const policy = { candidateModels: ["a/one", "b/two"] };
    expect([1, 2, 3, 4].map((k) => candidateModel(policy, k))).toEqual(["a/one", "b/two", "a/one", "b/two"]);
    expect(candidateModel({}, 1)).toBeNull();
  });

  test("with no passing candidate the fewest failures go on to repair", () => {
    expect(
      selectCandidate([
        result(1, { failedChecks: ["a", "b"] }),
        result(2, { failedChecks: ["a"] }),
        result(3, { outcome: "rejected", fingerprint: null }),
      ]),
    ).toMatchObject({ winner: 2, method: "fewest-failures", passing: [] });
    expect(
      selectCandidate([result(1, { outcome: "interrupted" }), result(2, { outcome: "rejected" })]),
    ).toMatchObject({ winner: null, method: "none" });
    expect(selectCandidate([result(1, { failedChecks: ["a"] }), result(2)])).toMatchObject({
      winner: 2,
      method: "only",
    });
  });

  test("the estimate prices every candidate of a task", () => {
    const stages = (candidates?: number) => [
      { id: "implement", type: "tasks", models: ["m"], ...(candidates ? { candidates } : {}) },
    ];
    const price = () => null;
    const one = estimatePreRun({ history: [], workflowId: "w", stages: stages(), maxTotalTokens: 1e9, price });
    const three = estimatePreRun({ history: [], workflowId: "w", stages: stages(3), maxTotalTokens: 1e9, price });
    expect(three.tokens.high).toBe(one.tokens.high * 3);
    expect(three.notes.join(" ")).toContain("3 candidates");
  });

  test("the estimate gives each candidate model its share of the tasks stage", () => {
    const estimate = estimatePreRun({
      history: [],
      workflowId: "best-of-n",
      stages: [{ id: "implement", type: "tasks", models: ["a/one", "b/two", "a/one"], candidates: 3 }],
      maxTotalTokens: 100_000_000,
      price: () => null,
    });
    const one = estimate.models.find((m) => m.model === "a/one");
    const two = estimate.models.find((m) => m.model === "b/two");
    expect(one?.stages).toEqual(["implement"]);
    expect(one?.tokens.high).toBe((two?.tokens.high ?? 0) * 2);
  });

  test("the CLI takes --candidates from 1 to 8", () => {
    expect(
      parseWorkflowArgs(["run", "--feature", "f", "--prompt", "p", "--worktree", "--candidates", "3"])
        .flags.candidates,
    ).toBe("3");
    expect(() =>
      parseWorkflowArgs(["run", "--feature", "f", "--prompt", "p", "--candidates", "9"]),
    ).toThrow("--candidates requires an integer from 1 to 8");
  });
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

const MARKDOWN =
  "# Plan\n## Context\nWrite the value.\n## Decisions\nDEC-001: FR-001 needs the value.\n## Components\nFiles\n## Data\nText\n## Verification\nCheck files\n## Risks\nNone for fixture";

/**
 * Plans one task that writes value.txt; candidate N of it writes `variants[N - 1]`. The critic
 * scores a patch that adds "good" highest.
 */
class CandidateExecutor implements AgentExecutor {
  service: NativeWorkflowService | undefined;
  roots: string[] = [];
  critiques = 0;
  /** The distinguishing test this executor writes; none makes the profile fail. */
  distinction: { expected: string } | null = null;
  models: string[] = [];
  constructor(
    private workspace: string,
    private variants: string[],
  ) {}
  async execute(request: ExecutionRequest) {
    const root = request.root ?? this.workspace;
    const service = this.service;
    if (request.profile.output === "plan") {
      const task = {
        id: "T001", title: "Write value", description: "Write value.txt", requirementIds: ["FR-001"],
        criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer",
        writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: ["not-bad"],
        origin: "planned", findingIds: [], rationale: "Required behavior",
      };
      const taskGraph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(MARKDOWN), tasks: [task] };
      return { output: { schemaVersion: 1, markdown: MARKDOWN, taskGraph }, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output === "distinction") {
      if (!this.distinction) return { output: { invalid: true }, inputTokens: 10, outputTokens: 10 };
      return {
        output: {
          schemaVersion: 1, taskId: request.task?.id ?? "T001", executable: "bun",
          args: ["-e", "console.log((await Bun.file('value.txt').text()).trim())"],
          expected: this.distinction.expected, criterionIds: ["AC-001"], rationale: "fixture",
        },
        inputTokens: 10,
        outputTokens: 10,
      };
    }
    if (request.profile.output === "critique") {
      this.critiques++;
      const good = request.prompt.includes("+good");
      const item = { score: good ? 0.9 : 0.4, note: "fixture" };
      return {
        output: {
          schemaVersion: 1, taskId: request.task?.id ?? "T001", score: good ? 0.9 : 0.4,
          rubric: { intent: item, instructions: item, scope: item, testIntegrity: item, completeness: item },
          summary: "fixture",
        },
        inputTokens: 10,
        outputTokens: 10,
      };
    }
    if (request.profile.output !== "implementation" || !service || !request.task)
      return new FixtureExecutor(root).execute(request);
    const task = request.task;
    this.roots.push(root);
    this.models.push(`${basename(root)}=${request.profile.model}`);
    const index = Number(/-c(\d+)$/.exec(basename(root))?.[1] ?? "1");
    const guard = new WorkflowToolPolicy(
      service.store, service.leases, request.runId, request.attemptId, request.profile,
      PolicySchema.parse(JSON.parse(service.store.run(request.runId).policy_json)), task, root,
    );
    await guard.execute("edit_file", { path: "value.txt" }, async () => {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "value.txt"), this.variants[index - 1] ?? "");
    });
    return {
      output: { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  }
}

const notBad: Check = {
  id: "not-bad", executable: "bun",
  args: ["-e", "if ((await Bun.file('value.txt').text()).trim() === 'bad') process.exit(1)"],
  cwd: ".", timeoutMs: 20000, required: true, scope: "task", envNames: [], writes: [],
};
const expects = (text: string): Check => ({
  id: "check", executable: "bun",
  args: ["-e", `if ((await Bun.file('value.txt').text()).trim() !== ${JSON.stringify(text)}) process.exit(1)`],
  cwd: ".", timeoutMs: 20000, required: true, scope: "feature", envNames: [], writes: [],
});

function setup(variants: string[], expected: string, extra: Partial<RunPolicy> = {}) {
  const root = mkdtempSync(join(tmpdir(), "baked-best-of-n-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".baked/\n");
  writeFileSync(join(root, "README.md"), "# Project\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Initial");
  const policy: RunPolicy = { ...fixturePolicy, checks: [expects(expected), notBad], ...extra };
  const executor = new CandidateExecutor(root, variants);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  executor.service = service;
  cleanups.push(() => service.close());
  const store = service.store;
  const run = async (candidates: number) => {
    const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Write the value", ownerLabel: "test", policy, executionMode: "worktree", candidates });
    const signal = new AbortController().signal;
    const waiting = await service.drive(started.runId, signal);
    if (waiting.status !== "waiting") throw new Error(`Expected an approval, run is ${waiting.status}`);
    const request = store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!request) throw new Error("No pending approval");
    await service.decide(started.runId, { commandId: newId(), expectedRevision: store.run(started.runId).revision }, { kind: "approve", requestId: request.id, digest: request.digest });
    return { runId: started.runId, final: await service.drive(started.runId, signal) };
  };
  const json = <T>(runId: string, path: string): T => {
    const row = store.latestArtifact(runId, path);
    if (!row) throw new Error(`No ${path}`);
    return JSON.parse(store.readArtifact(runId, row.id)) as T;
  };
  return { root, executor, service, store, policy, run, json };
}

describe("best-of-N runs", () => {
  test("three candidates run in their own worktrees; the vote picks the shared change", async () => {
    const fx = setup(["bad", "B", "B  "], "B");
    const { runId, final } = await fx.run(3);
    expect(final.status).toBe("completed");
    expect(fx.executor.roots.map((r) => basename(r)).sort()).toEqual(["T001-c1", "T001-c2", "T001-c3"]);
    const selection = fx.json<{ winner: number; method: string; passing: number[]; oracle: boolean; selectedPassed: boolean }>(runId, "tasks/T001/selection.json");
    expect(selection).toMatchObject({ winner: 2, method: "vote", passing: [2, 3], oracle: true, selectedPassed: true });
    const loser = fx.json<{ outcome: string; failedChecks: string[]; selected: boolean; patch: string }>(runId, "tasks/T001/candidates/1.json");
    expect(loser).toMatchObject({ outcome: "done", failedChecks: ["not-bad"], selected: false });
    expect(loser.patch).toContain("+bad");
    const worktree = join(fx.root, `.baked/worktrees/${runId}/main`);
    expect(readFileSync(join(worktree, "value.txt"), "utf8")).toBe("B");
    for (const n of [1, 2, 3]) expect(existsSync(join(fx.root, `.baked/worktrees/${runId}/T001-c${String(n)}`))).toBe(false);
    expect(fx.store.leases()).toEqual([]);
    const report = runReport(fx.store, runId);
    expect(report).toContain("## Best-of-N");
    expect(report).toContain("Oracle rate 1/1");
    expect(report).toContain("T001 (vote): 2 of the 2 candidates");
  }, 120000);

  test("the critic breaks a tie between different passing candidates", async () => {
    const fx = setup(["alpha", "good", "beta"], "good", { critic: "advise" });
    const { runId, final } = await fx.run(3);
    expect(final.status).toBe("completed");
    const selection = fx.json<{ winner: number; method: string; finalists: number[] }>(runId, "tasks/T001/selection.json");
    expect(selection).toMatchObject({ winner: 2, method: "critic" });
    expect(selection.finalists.sort()).toEqual([1, 2, 3]);
    expect(fx.json<{ score: number }>(runId, "tasks/T001/candidates/2.json").score).toBe(0.9);
    expect(readFileSync(join(fx.root, `.baked/worktrees/${runId}/main/value.txt`), "utf8")).toBe("good");
  }, 120000);

  test("a distinguishing test picks the finalist that prints what the spec requires", async () => {
    const fx = setup(["alpha", "good", "beta"], "good", { critic: "off" });
    fx.executor.distinction = { expected: "good" };
    const { runId, final } = await fx.run(3);
    expect(final.status).toBe("completed");
    const selection = fx.json<{
      winner: number;
      method: string;
      distinction: { test: { expected: string }; matching: number[]; runs: { candidate: number; shows: boolean }[] };
    }>(runId, "tasks/T001/selection.json");
    expect(selection).toMatchObject({ winner: 2, method: "distinguishing-test" });
    expect(selection.distinction.test.expected).toBe("good");
    expect(selection.distinction.matching).toEqual([2]);
    expect(selection.distinction.runs.map((r) => r.shows)).toEqual([false, true, false]);
    expect(readFileSync(join(fx.root, `.baked/worktrees/${runId}/main/value.txt`), "utf8")).toBe("good");
  }, 120000);

  test("candidates run on the models candidateModels names", async () => {
    const fx = setup(["A", "A", "A"], "A", { candidateModels: ["fixture/one", "fixture/two"] });
    const { runId, final } = await fx.run(3);
    expect(final.status).toBe("completed");
    expect(fx.executor.models.sort()).toEqual(["T001-c1=fixture/one", "T001-c2=fixture/two", "T001-c3=fixture/one"]);
    const models = [1, 2, 3].map((n) => fx.json<{ model: string }>(runId, `tasks/T001/candidates/${String(n)}.json`).model);
    expect(models).toEqual(["fixture/one", "fixture/two", "fixture/one"]);
  }, 120000);

  test("a run asks for candidates only in a worktree and within maxCandidates", async () => {
    const fx = setup(["A"], "A");
    const start = (fields: Record<string, unknown>) =>
      fx.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "p", ownerLabel: "test", policy: fx.policy, ...fields });
    await expect(start({ candidates: 3 })).rejects.toThrow("candidates above 1 needs worktree execution");
    await expect(start({ candidates: 5, executionMode: "worktree" })).rejects.toThrow("candidates 5 is above maxCandidates 4");
    const preset = await start({ workflowId: "best-of-n" });
    const policy = PolicySchema.parse(JSON.parse(fx.store.run(preset.runId).policy_json));
    expect(policy.candidates).toBe(3);
    expect(policy.executionMode).toBe("worktree");
    const one = await start({ executionMode: "worktree", featureId: "other" });
    expect(PolicySchema.parse(JSON.parse(fx.store.run(one.runId).policy_json)).candidates).toBeUndefined();
  }, 60000);
});
