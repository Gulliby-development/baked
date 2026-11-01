import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { getProvider } from "../src/core/llm/providers/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { contextPieces, largePromptText, promptSections } from "../src/core/workflows/prompt-sections.js";
import type { Repro, RunPolicy, Task } from "../src/core/workflows/schemas.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { runUsage } from "../src/core/workflows/usage.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";

// Bench round 84, md-site control (run 2361845b, #2597): the first implementer attempts of the
// test tasks sent 33 to 37 KB. After the T009 and T010 correctives invalidated T002, T003, T005,
// T006 and T007, their re-runs sent 74 to 465 KB, T005's re-run cost 1.80M tokens against 0.54M
// for its first attempt, and `usage.json` kept only `prompt.firstBytes`, so the round could not
// say which part of the prompt held the bytes. Each attempt now records `prompt.sections`, which
// sum to `firstBytes`, and a re-run more than three times the median first attempt is noticed
// with its largest section.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const task = (id: string, path: string, extra: Partial<Task> = {}): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path, action: path.startsWith("tests/") ? "modify" : "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior", ...extra });
const tasks = [task("T001", "src/value.ts"), task("T002", "tests/a.test.ts", { dependsOn: ["T001"], readHints: ["src/value.ts"] }), task("T003", "tests/b.test.ts", { dependsOn: ["T001"], readHints: ["src/value.ts"] })];
const markdown = "# Plan\n## Context\nA value and its tests.\n## Decisions\nDEC-001: FR-001 in src/value.ts.\n## Components\nsrc/value.ts, tests/a.test.ts, tests/b.test.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
// The test files the test tasks write, as md-site's: hundreds of cases.
const cases = (name: string, expected: string) => `import { value } from "../src/value.js";\n${Array.from({ length: 300 }, (_, i) => `test("${name} case ${i}", () => expect(value).toBe("${expected}"));`).join("\n")}\n`;
const FIXED = `export const value = "fixed";\nexport const table = [\n${Array.from({ length: 600 }, (_, i) => `  { key: "k${i}", value: "${"v".repeat(40)}" },`).join("\n")}\n];\n`;
const PROGRAM = "const t = await Bun.file('src/value.ts').text(); console.log(t.includes('fixed') ? 'fixed' : 'broken')";
const repro: Repro = { executable: "bun", args: ["-e", PROGRAM], expected: "fixed", actual: "broken" };
// The tests check the value they were written for: once the corrective fixes it, the test tasks'
// files fail until they are written again, so the host's re-check cannot settle them.
const TESTS = "const v = await Bun.file('src/value.ts').text(); for await (const f of new Bun.Glob('tests/*.test.ts').scan('.')) if (!(await Bun.file(f).text()).includes(v.includes('fixed') ? 'toBe(\"fixed\")' : 'toBe(\"broken\")')) { console.log(f + ': stale'); process.exit(1) }";
const policy: RunPolicy = { ...fixturePolicy, maxRepairRounds: 2, checks: [{ id: "tests", executable: "bun", args: ["-e", TESTS], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };

/** The fixture flow, with each implementer attempt run by the native executor on a scripted model. */
class NativeTasksExecutor extends FixtureExecutor {
  native?: NativeAgentExecutor;
  constructor(private workspace: string) {
    super(workspace);
  }
  override async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    switch (request.profile.output) {
      case "plan":
        return { output: { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown), tasks } }, inputTokens: 20, outputTokens: 30 };
      case "convergence": {
        if (readFileSync(join(this.workspace, "src/value.ts"), "utf8").includes("fixed")) break;
        const finding = { id: "F1", kind: "correctness", severity: "medium", basis: "spec", confidence: 0.99, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "src/value.ts", symbol: null, evidenceIds, claim: "The value is not fixed", impact: "Value is wrong", suggestedFix: "Fix the value", repro };
        return { output: { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: "Value is wrong" }], findings: [finding] }, inputTokens: 20, outputTokens: 30 };
      }
      case "implementation": {
        const root = request.root ?? this.workspace;
        const write = (path: string, text: string) => {
          mkdirSync(join(root, path, ".."), { recursive: true });
          writeFileSync(join(root, path), text);
        };
        const t = request.task;
        // The corrective rewrites the module, as R84's T009 and T010 rewrote theirs.
        if (t?.origin !== "planned") write("src/value.ts", FIXED);
        else if (t.id === "T001") write("src/value.ts", 'export const value = "broken";\n');
        else write(t.writes[0]?.path ?? "", cases(t.id, readFileSync(join(root, "src/value.ts"), "utf8").includes("fixed") ? "fixed" : "broken"));
        if (!this.native) throw new Error("native executor missing");
        // The native executor sends the scheduler's prompt and records the attempt's usage.
        return this.native.execute({ ...request, profile: { ...request.profile, model: "openai/fixture-model" }, caseCheck: undefined, testCapCheck: undefined, taskEndCheck: undefined, reproCheck: undefined, rowReplay: undefined, checkpointChecks: undefined });
      }
    }
    return super.execute(request);
  }
}

/** A model that submits the task named in its prompt at once. */
function submittingModel(): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> => {
      const text = JSON.stringify(options.prompt);
      const taskId = /\\"task\\":\{[^}]*?\\"id\\":\\"(T\d+)\\"/.exec(text)?.[1] ?? /(T00[4-9])/.exec(text)?.[1] ?? "T001";
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

describe("scenario: R84 md-site, re-runs after correctives with 4 to 13 times the prompt (#2597)", () => {
  test("each attempt's sections sum to firstBytes, and the re-run's notice names the section that grew", async () => {
    const provider = getProvider("openai");
    if (!provider) throw new Error("openai provider missing");
    const original = provider.createModel;
    provider.createModel = () => submittingModel();
    cleanups.push(() => {
      provider.createModel = original;
    });
    const fixture = workflowFixture({ policy, executor: (root) => new NativeTasksExecutor(root) });
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    fixture.executor.native = new NativeAgentExecutor(service.store, service.leases, { ...fixture.config, repoMap: false });
    cleanups.push(() => fixture.executor.native?.dispose());
    // The project has its test files; the test tasks fill them.
    mkdirSync(join(fixture.root, "tests"), { recursive: true });
    for (const name of ["a", "b"]) writeFileSync(join(fixture.root, `tests/${name}.test.ts`), 'import { value } from "../src/value.js";\n');
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    await service.drive(run.runId, new AbortController().signal);
    const store = service.store;
    const usage = runUsage(store, run.runId);
    const recorded = usage.attempts.filter((a) => a.prompt !== null && a.taskId !== null);
    const sections = (a: (typeof recorded)[number]) => Object.fromEntries((a.prompt?.sections ?? []).map((s) => [s.name, s.bytes]));
    // The test tasks ran twice: their first attempts, then the re-runs after the corrective.
    const first = (id: string) => recorded.find((a) => a.taskId === id && a.taskGeneration === 0);
    const rerun = (id: string) => recorded.find((a) => a.taskId === id && (a.taskGeneration ?? 0) > 0);
    for (const id of ["T002", "T003"]) {
      expect(first(id)).toBeDefined();
      expect(rerun(id)).toBeDefined();
    }
    // Every attempt's sections sum exactly to its firstBytes, and name the prompt's parts.
    for (const attempt of recorded) {
      const prompt = attempt.prompt;
      expect(prompt?.sections?.length).toBeGreaterThan(1);
      expect(prompt?.sections?.reduce((sum, s) => sum + s.bytes, 0)).toBe(prompt?.firstBytes ?? -1);
      expect(Object.keys(sections(attempt))).toEqual(expect.arrayContaining(["instructions", "rules", "request", "spec", "plan", "graph", "input.task", "framing", "envelope"]));
      // Only JSON keys, punctuation, hashes and the message wrapper are unnamed.
      expect((sections(attempt).framing ?? 0) + (sections(attempt).envelope ?? 0)).toBeLessThan(1024);
    }
    // The section that grew most from the first attempt to the re-run is the one the notice names.
    const notices = store.events(run.runId).flatMap((e) => (e.type === "attempt.large_prompt" ? [e.payload] : []));
    for (const id of ["T002", "T003"]) {
      const before = sections(first(id) as (typeof recorded)[number]);
      const after = sections(rerun(id) as (typeof recorded)[number]);
      const grew = Object.keys(after).reduce((a, b) => ((after[b] ?? 0) - (before[b] ?? 0) > (after[a] ?? 0) - (before[a] ?? 0) ? b : a));
      expect(grew).toBe("input.taskFiles");
      const notice = notices.find((n) => n.attemptId === rerun(id)?.attemptId);
      expect(notice).toMatchObject({ taskId: id, firstBytes: rerun(id)?.prompt?.firstBytes, largest: { name: grew, bytes: after[grew] } });
      expect(notice?.firstBytes).toBeGreaterThan(3 * (notice?.medianBytes ?? Number.POSITIVE_INFINITY));
      expect(largePromptText(notice as NonNullable<typeof notice>)).toContain(`largest section ${grew}`);
    }
    // First attempts are the baseline: none of them is noticed.
    const firsts = new Set(["T001", "T002", "T003"].map((id) => first(id)?.attemptId));
    expect(notices.some((n) => firsts.has(n.attemptId))).toBe(false);
  });
});

describe("contextPieces", () => {
  test("spells the workflow context exactly and names its parts", () => {
    const prompt = `Project rules\n\nskill\n\nWrite every artifact in English: x\n${JSON.stringify({ plan: "# Plan", request: "Make it" })}\n${JSON.stringify({ extra: { evidence: [{ id: "E1" }], task: { id: "T1" } }, inputHash: "a", snapshotHash: "b" })}`;
    const pieces = contextPieces(prompt);
    expect(pieces.map((p) => p.text).join("")).toBe(prompt);
    expect([...new Set(pieces.map((p) => p.name))]).toEqual(["instructions", "framing", "plan", "request", "input.evidence", "input.task"]);
  });

  test("a prompt that is not a workflow context is one piece", () => {
    expect(contextPieces("Correct F1")).toEqual([{ name: "prompt", text: "Correct F1" }]);
    expect(contextPieces("a\nnot json\n{}")).toEqual([{ name: "prompt", text: "a\nnot json\n{}" }]);
  });
});

describe("promptSections", () => {
  const prompt = `Rules "quoted" é\n${JSON.stringify({ spec: { title: "Ünïcode \"x\"" } })}\n${JSON.stringify({ extra: { task: { id: "T1" } }, inputHash: "a", snapshotHash: "b" })}`;
  const total = (messages: unknown[]) => Buffer.byteLength(JSON.stringify(messages));
  const sum = (sections: { bytes: number }[]) => sections.reduce((n, s) => n + s.bytes, 0);

  test("sum to the serialized messages, whether the prompt is one string or cached parts", () => {
    const whole = [{ role: "user" as const, content: prompt }];
    const cut = prompt.lastIndexOf("\n") + 1;
    const parts = [{ role: "user" as const, content: [{ type: "text" as const, text: prompt.slice(0, cut), providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }, { type: "text" as const, text: prompt.slice(cut) }] }, { role: "user" as const, content: "A host notice" }];
    for (const messages of [whole, parts]) {
      const sections = promptSections(messages, prompt);
      expect(sum(sections)).toBe(total(messages));
      expect(sections.map((s) => s.name)).toEqual(["instructions", "framing", "spec", "input.task", "envelope"]);
    }
  });

  test("messages that do not carry the prompt are one section", () => {
    const messages = [{ role: "user" as const, content: "something else" }];
    expect(promptSections(messages, prompt)).toEqual([{ name: "messages", bytes: total(messages) }]);
  });
});
