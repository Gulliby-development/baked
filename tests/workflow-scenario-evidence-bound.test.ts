import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { getProvider } from "../src/core/llm/providers/index.js";
import { canonical, hashBytes, hashJson } from "../src/core/specs/hash.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { boundEvidence, checkFacts, EVIDENCE_BUDGET_CHARS, type EvidenceItem } from "../src/core/workflows/evidence-budget.js";
import { largePromptText } from "../src/core/workflows/prompt-sections.js";
import type { Repro, RunPolicy, Task } from "../src/core/workflows/schemas.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { runUsage } from "../src/core/workflows/usage.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";

// Bench round 85, md-site control (run 135ad4d9, #2617): 15.78M tokens against a 10.2M estimate.
// The implementer T012 prompts were 472 to 504 KB with `input.evidence` 379 to 393 KB: in its
// snapshot of 47 entries, 14 `checks/lint` entries were the same passing `biome check .` output
// (17,604 bytes each, 224 KB), the diffs 51 KB. Each step resent it. The section now lists a
// passing check by its status, a repeated run once, and stays within `EVIDENCE_BUDGET_CHARS`,
// failing output and diffs first.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const LINT_RUNS = 14;
// Biome's info-level diagnostics of a passing `biome check .`: 17,604 bytes, exit 0.
const info = (i: number) => `src/page${i % 9}.ts:${i + 3}:7 lint/style/useTemplate FIXABLE\n\n  i Template literals are preferred over string concatenation.\n\n  > ${i + 3} | const title = "Page " + name + " of the site";\n\n`;
const LINT_OUTPUT = (() => {
  let text = "";
  for (let i = 0; text.length < 17_400; i++) text += info(i);
  return `${text.slice(0, 17_400)}\nChecked 42 files in 31ms. No fixes applied.\nFound 87 infos.`.padEnd(17_604, " ");
})();
const TYPE_ERROR = "src/render.ts(14,9): error TS2322: Type 'number' is not assignable to type 'string'. R85-FAILING-MARKER";
const TYPECHECK_OUTPUT = `${"src/render.ts(3,1): note: checking\n".repeat(120)}${TYPE_ERROR}\nFound 1 error in src/render.ts:14`;
const lintCheck = { id: "lint", executable: "bunx", args: ["biome", "check", "."], cwd: ".", timeoutMs: 60000, required: true, scope: "feature", envNames: [], writes: [] };
const typeCheck = { ...lintCheck, id: "typecheck", args: ["tsc", "--noEmit"] };
const record = (check: typeof lintCheck, output: string, exitCode: number, durationMs: number) =>
  canonical({ definition: check, definitionHash: hashJson(check), beforeHash: hashBytes(String(durationMs)), afterHash: hashBytes(`${durationMs}a`), reason: "exit", exitCode, durationMs, output, timedOut: false, cancelled: false });
const diff = (n: number) => `--- a/src/page${n}.ts\n+++ b/src/page${n}.ts\n${Array.from({ length: 400 }, (_, i) => `+export const line${i} = "${"x".repeat(50)}";`).join("\n")}`;

const task = (id: string, path: string, extra: Partial<Task> = {}): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior", ...extra });
const tasks = [task("T001", "src/value.ts")];
const markdown = "# Plan\n## Context\nA value.\n## Decisions\nDEC-001: FR-001 in src/value.ts.\n## Components\nsrc/value.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const PROGRAM = "const t = await Bun.file('src/value.ts').text(); console.log(t.includes('fixed') ? 'fixed' : 'broken')";
const repro: Repro = { executable: "bun", args: ["-e", PROGRAM], expected: "fixed", actual: "broken" };
const policy: RunPolicy = { ...fixturePolicy, maxRepairRounds: 2, checks: [{ id: "tests", executable: "bun", args: ["-e", "console.log('ok')"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };

type Entry = { id: string; handle?: string; kind: string; content?: string; check?: string; status?: string; repeats?: number; sameAs?: string[]; summary?: string };

/** The fixture flow: the convergence finds the value broken once, after the R85 snapshot is put in place. */
class R85Executor extends FixtureExecutor {
  native?: NativeAgentExecutor;
  store?: WorkflowStore;
  corrective?: { evidence: Entry[]; attemptId: string };
  injected = false;
  constructor(private workspace: string) {
    super(workspace);
  }
  override async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { snapshotHash: string; extra: { evidence?: Entry[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    switch (request.profile.output) {
      case "plan":
        return { output: { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown), tasks } }, inputTokens: 20, outputTokens: 30 };
      case "convergence": {
        if (readFileSync(join(this.workspace, "src/value.ts"), "utf8").includes("fixed")) break;
        if (!this.injected) {
          this.injected = true;
          this.inject(request.runId);
        }
        const finding = { id: "F1", kind: "correctness", severity: "medium", basis: "spec", confidence: 0.99, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "src/value.ts", symbol: null, evidenceIds: evidenceIds.slice(0, 1), claim: "The value is not fixed", impact: "Value is wrong", suggestedFix: "Fix the value", repro };
        return { output: { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds: evidenceIds.slice(0, 1), explanation: "Value is wrong" }], findings: [finding] }, inputTokens: 20, outputTokens: 30 };
      }
      case "implementation": {
        const root = request.root ?? this.workspace;
        const t = request.task;
        if (t?.origin !== "planned" && !this.corrective) this.corrective = { evidence: data.extra.evidence ?? [], attemptId: request.attemptId };
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src/value.ts"), t?.origin !== "planned" ? 'export const value = "fixed";\n' : 'export const value = "broken";\n');
        if (!this.native) throw new Error("native executor missing");
        return this.native.execute({ ...request, profile: { ...request.profile, model: "openai/fixture-model" }, caseCheck: undefined, testCapCheck: undefined, taskEndCheck: undefined, reproCheck: undefined, rowReplay: undefined, checkpointChecks: undefined });
      }
    }
    return super.execute(request);
  }
  /** The R85 T012 snapshot: 14 passing lint runs with one output, a failing typecheck, two diffs. */
  private inject(runId: string) {
    const store = this.store;
    if (!store) throw new Error("store missing");
    const snapshotId = store.evidence(runId).at(-1)?.snapshot_id ?? "";
    store.transaction(() => {
      for (let i = 0; i < LINT_RUNS; i++) {
        const artifact = store.artifact(runId, "check", `checks/lint/r85-${i}.json`, record(lintCheck, LINT_OUTPUT, 0, 300 + i));
        store.checkResult(runId, "lint", store.addEvidence(runId, "command", snapshotId, artifact.id), "passed", 0, "exit", 300 + i);
      }
      const failing = store.artifact(runId, "check", "checks/typecheck/r85.json", record(typeCheck, TYPECHECK_OUTPUT, 2, 900));
      store.checkResult(runId, "typecheck", store.addEvidence(runId, "command", snapshotId, failing.id), "failed", 2, "exit", 900);
      for (const n of [1, 2]) store.addEvidence(runId, "diff", snapshotId, store.artifact(runId, "diff", `diffs/r85-${n}.patch`, diff(n)).id);
    });
  }
}

function submittingModel(): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> => {
      const text = JSON.stringify(options.prompt);
      const taskId = /\\"task\\":\{[^}]*?\\"id\\":\\"(T\d+)\\"/.exec(text)?.[1] ?? "T001";
      const input = { schemaVersion: 1, taskId, outcome: "implemented", summary: "Done", evidenceIds: [], unresolved: [] };
      return {
        content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: "submit_result", input: JSON.stringify(input) }],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
        warnings: [],
      };
    },
  }) as LanguageModelV3;
}

describe("scenario: R85 md-site, a corrective's evidence of 14 identical passing lint runs (#2617)", () => {
  test("the repair task's input.evidence is bounded, lists the lint run once and keeps the failing typecheck whole", async () => {
    const provider = getProvider("openai");
    if (!provider) throw new Error("openai provider missing");
    const original = provider.createModel;
    provider.createModel = () => submittingModel();
    cleanups.push(() => {
      provider.createModel = original;
    });
    const fixture = workflowFixture({ policy, executor: (root) => new R85Executor(root) });
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    fixture.executor.store = service.store;
    fixture.executor.native = new NativeAgentExecutor(service.store, service.leases, { ...fixture.config, repoMap: false });
    cleanups.push(() => fixture.executor.native?.dispose());
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    await service.drive(run.runId, new AbortController().signal);
    const corrective = fixture.executor.corrective;
    expect(corrective).toBeDefined();
    const evidence = corrective?.evidence ?? [];
    const usage = runUsage(service.store, run.runId).attempts.find((a) => a.attemptId === corrective?.attemptId);
    const bytes = Object.fromEntries((usage?.prompt?.sections ?? []).map((s) => [s.name, s.bytes]))["input.evidence"] ?? 0;
    // Main: 14 copies of the lint output and the rest, 280 KB. Now within the budget, plus the
    // ids and handles of the entries listed.
    console.log(`R85 corrective input.evidence: ${bytes} bytes (budget ${EVIDENCE_BUDGET_CHARS}), bound ${JSON.stringify(usage?.prompt?.evidence)}`);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(EVIDENCE_BUDGET_CHARS + 8_000);
    // The passing lint run is listed once, by its status and last line, with its repeats.
    const lint = evidence.filter((e) => e.content?.includes("useTemplate") || e.check === "lint");
    expect(lint).toHaveLength(1);
    expect(lint[0]).toMatchObject({ check: "lint", status: "passed", repeats: LINT_RUNS, summary: "Found 87 infos." });
    expect(lint[0]?.content).toBeUndefined();
    expect(lint[0]?.sameAs).toHaveLength(LINT_RUNS - 1);
    // The failing typecheck keeps its output whole; the diffs are listed.
    const failing = evidence.find((e) => e.content?.includes("R85-FAILING-MARKER"));
    expect((JSON.parse(failing?.content ?? "{}") as { output?: string }).output).toBe(TYPECHECK_OUTPUT);
    expect(evidence.filter((e) => e.kind === "diff" && e.content).length).toBeGreaterThanOrEqual(2);
    // The attempt's prompt record says what the bound did; the sections still sum to firstBytes.
    expect(usage?.prompt?.evidence).toMatchObject({ budget: EVIDENCE_BUDGET_CHARS, collapsed: LINT_RUNS - 1, summarized: 2 }); // lint and the run's own tests check
    expect(usage?.prompt?.sections?.reduce((sum, s) => sum + s.bytes, 0)).toBe(usage?.prompt?.firstBytes ?? -1);
    // A large-prompt notice of the corrective, if any, names what the bound cut.
    const notices = service.store.events(run.runId).flatMap((e) => (e.type === "attempt.large_prompt" ? [e.payload] : []));
    console.log(`R85 corrective attempt.large_prompt notices: ${notices.filter((n) => n.attemptId === corrective?.attemptId).length}`);
    for (const notice of notices.filter((n) => n.attemptId === corrective?.attemptId)) {
      expect(notice.evidence?.budget).toBe(EVIDENCE_BUDGET_CHARS);
      expect(largePromptText(notice)).toContain("evidence bounded to");
    }
  });
});

describe("boundEvidence", () => {
  const item = (id: string, kind: string, content: string, check?: { id: string; status: string }): EvidenceItem => ({
    id,
    handle: id.replace("id", "E"),
    kind,
    content,
    ...(check ? { check: { ...check, exitCode: check.status === "passed" ? 0 : 1, ...checkFacts(content) } } : {}),
  });

  test("runs of one check with the same definition and output are listed once, at the latest", () => {
    const failing = (n: number) => item(`id${n}`, "command", record(lintCheck, "error: x is unused", 1, n), { id: "lint", status: "failed" });
    const other = item("id3", "command", record(lintCheck, "error: y is unused", 1, 3), { id: "lint", status: "failed" });
    const { entries, bound } = boundEvidence([failing(1), failing(2), other, failing(4)]);
    expect(entries.map((e) => e.id)).toEqual(["id3", "id4"]);
    expect(entries[1]).toMatchObject({ repeats: 3, sameAs: ["E1", "E2"] });
    expect(bound).toMatchObject({ entries: 4, listed: 2, collapsed: 2, summarized: 0, cutChars: 0 });
  });

  test("a passing check is its status unless the input asked for it", () => {
    const passing = item("id1", "command", record(lintCheck, LINT_OUTPUT, 0, 1), { id: "lint", status: "passed" });
    expect(boundEvidence([passing]).entries[0]).toMatchObject({ check: "lint", status: "passed", summary: "Found 87 infos." });
    expect(boundEvidence([passing]).entries[0]?.content).toBeUndefined();
    expect(boundEvidence([passing], { only: new Set(["id1"]) }).entries[0]?.content).toContain("useTemplate");
  });

  test("over the budget, failing output and diffs come first and the oldest other entries are cut", () => {
    const review = (n: number) => item(`id${n}`, "review", `review ${n} `.repeat(3_000));
    const failing = item("id9", "command", record(typeCheck, TYPECHECK_OUTPUT, 2, 9), { id: "typecheck", status: "failed" });
    const { entries, bound } = boundEvidence([failing, review(1), item("id2", "diff", diff(2)), review(3)], { budget: 40_000 });
    expect(entries[0]?.content).toContain(TYPE_ERROR);
    expect(entries[2]?.content).toBe(diff(2));
    expect(String(entries[1]?.content ?? entries[1]?.cut)).toContain("evidence budget");
    expect(bound.cut).toContain("E1");
    expect(bound.cutChars).toBeGreaterThan(0);
    const listed = entries.reduce((sum, e) => sum + (typeof e.content === "string" ? JSON.stringify(e.content).length - 2 : 0), 0);
    expect(listed).toBeLessThanOrEqual(40_000);
  });
});

describe("evidence inputs go through evidenceContext (#2617)", () => {
  const root = join(import.meta.dir, "..", "src");
  const files = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
    );
  const sources = files(".").map((path) => ({ path: path.replaceAll("\\", "/"), text: readFileSync(join(root, path), "utf8") }));

  test("only evidenceContext numbers evidence for an agent, besides the format hint's id list", () => {
    const numbering = sources.flatMap(({ path, text }) =>
      text.split("\n").flatMap((line, index) => (/\bevidenceHandle\(/.test(line) && !/export const evidenceHandle/.test(line) ? [`${path}:${index + 1}`] : [])),
    );
    // readdirSync order is the file system's (hash order on the Linux runners), so compare sorted.
    expect(numbering.map((at) => at.split(":")[0]).sort()).toEqual(["core/verification/evidence.ts", "core/workflows/scheduler.ts"]);
    const scheduler = sources.find((s) => s.path === "core/workflows/scheduler.ts")?.text ?? "";
    const at = scheduler.indexOf("evidenceHandle(index)");
    // The one call in the scheduler is inside evidenceContext.
    const method = scheduler.lastIndexOf("\n  private ", at);
    expect(scheduler.slice(method, method + 40)).toContain("private evidenceContext(");
  });

  test("no agent input lists the run's evidence rows itself", () => {
    const raw = sources.flatMap(({ path, text }) =>
      text.split("\n").flatMap((line, index) => (/\bevidence:\s.*\b(?:currentEvidence\(|store\.evidence\()/.test(line) ? [`${path}:${index + 1}`] : [])),
    );
    expect(raw).toEqual([]);
  });
});
