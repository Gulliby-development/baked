import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTING_ARTIFACT, type RoutingRecord } from "../src/core/llm/model-routing.js";
import { invisibleCharacters, lostAnswer, ProviderAnswerError } from "../src/core/llm/provider-answer.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { createCodexLanguageModel, parseCodexResponse, runCodexProcess } from "../src/core/llm/providers/codex/runner.js";
import { parseClaudeCodeResponse } from "../src/core/llm/providers/claude-code/prompt.js";
import { canonical } from "../src/core/specs/hash.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { replayTrace, exportTrace } from "../src/core/workflows/trace.js";
import { recoverableCall } from "../src/core/workflows/stall-ladder.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 62, stepvet tagexpr analyze (#1957). Six `codex exec` attempts ended "Codex exec
// returned no final agent message": the turn completed and was billed (27,967 input and about
// 6,400 output tokens each), but the answer was lost (#1956). Each became `provider_unavailable`
// at 0 tokens, the recovery ladder never climbed past the exec rung, three automatic resumes
// repeated the same input, and 966 s of failed calls were charged to the active deadline.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const usage = { type: "turn.completed", usage: { input_tokens: 27_967, output_tokens: 6_412 } };

/**
 * A stand-in `codex exec --json` whose first `lose` turns complete and bill with no readable
 * answer (the agent message line arrives cut, as readline cut it in R62), and then answer `text`.
 */
function fakeExec(lose: number, text: string) {
  const dir = tempDir("baked-codex-lost-");
  const counter = join(dir, "calls");
  writeFileSync(counter, "0");
  const lost = [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"{\\"finishReason\\":\\"tool-calls\\",\\"row\\":\\"a',
    JSON.stringify(usage),
  ];
  const answered = [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text } }),
    JSON.stringify(usage),
  ];
  const script = join(dir, "codex-exec.ts");
  writeFileSync(
    script,
    `import { readFileSync, writeFileSync } from "node:fs";
for await (const _ of process.stdin) {}
const n = Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1;
writeFileSync(${JSON.stringify(counter)}, String(n));
const lines = n <= ${lose} ? ${JSON.stringify(lost)} : ${JSON.stringify(answered)};
process.stdout.write(lines.map((line) => line + "\\n").join(""));
`,
  );
  return { command: { file: process.execPath, prefix: [script] }, calls: () => Number(readFileSync(counter, "utf8")) };
}

/** A run whose spec stage goes through the native executor and a fake `codex exec`. */
async function specRun(lose: number) {
  const transport = process.env.BAKED_CODEX_TRANSPORT;
  process.env.BAKED_CODEX_TRANSPORT = "exec";
  cleanups.push(() => {
    if (transport === undefined) delete process.env.BAKED_CODEX_TRANSPORT;
    else process.env.BAKED_CODEX_TRANSPORT = transport;
  });
  const spec = {
    ...fixtureSpec,
    criteria: fixtureSpec.criteria.map((c) => ({ ...c, then: "the tag splits at U+2028" })),
  };
  const message = JSON.stringify({
    finishReason: "tool-calls",
    reasoning: "",
    text: "",
    toolCalls: [{ toolName: "submit_result", inputJson: JSON.stringify(spec) }],
  });
  const exec = fakeExec(lose, message);
  const adapter = getProvider("codex");
  if (!adapter) throw new Error("Codex provider missing");
  const original = adapter.createModel;
  adapter.createModel = (modelId: string) =>
    createCodexLanguageModel(modelId, {
      run: (call) => runCodexProcess(["exec", "--json"], call.parts.instructions, call.abortSignal, call.onResponse, exec.command),
    });
  cleanups.push(() => {
    adapter.createModel = original;
  });
  const fixture = workflowFixture({
    executor: (root) =>
      new (class CodexSpecExecutor extends FixtureExecutor {
        override async execute(request: ExecutionRequest) {
          if (request.profile.output !== "spec") return super.execute(request);
          const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, {
            ...fixture.config,
            repoMap: false,
          });
          try {
            // The stage input holds the character that cut the answer in R62.
            return await native.execute({ ...request, prompt: `${request.prompt}\nrow: a b` });
          } finally {
            native.dispose();
          }
        }
      })(root),
  });
  cleanups.push(fixture.dispose);
  fixture.service.providerProbe = async () => ({});
  fixture.service.providerDelay = async () => {};
  // The request holds the character that cut the answer in R62, so the stage input does too.
  const run = await fixture.service.start({
    commandId: randomUUID(),
    featureId: "fixture",
    workflowId: "sdd",
    prompt: "Create ready value; a tag row reads a\u2028b",
    ownerLabel: "test",
    policy: fixture.policy,
  });
  const { store } = fixture.service;
  const artifact = store.latestArtifact(run.runId, ROUTING_ARTIFACT);
  if (!artifact) throw new Error("Routing record missing");
  const routing = JSON.parse(store.readArtifact(run.runId, artifact.id)) as RoutingRecord;
  routing.stages.specify = { model: "codex/gpt-6.1-sol", effort: "medium", source: "scenario" };
  store.artifact(run.runId, "routing", ROUTING_ARTIFACT, canonical(routing));
  const done = await fixture.service.drive(run.runId, new AbortController().signal);
  const specify = store
    .attempts(run.runId)
    .filter((a) => a.model_id !== null && store.rootStage(run.runId, a.step_id) === "specify");
  const events = store.events(run.runId, 0, 10_000);
  const usageOf = (attemptId: string) => {
    const saved = store.latestArtifact(run.runId, `attempts/${attemptId}/usage.json`);
    return saved ? (JSON.parse(store.readArtifact(run.runId, saved.id)) as Record<string, unknown>) : {};
  };
  return { fixture, run, done, specify, events, usageOf, calls: exec.calls };
}

describe("scenario: stepvet tagexpr analyze, a turn that loses its answer (#1957)", () => {
  test("climbs to the lower-effort rung and completes, with the lost turn's tokens charged", async () => {
    const { done, specify, events, usageOf, calls } = await specRun(1);
    expect(done.status).toBe("waiting");
    expect(calls()).toBe(2);
    expect(specify.map((a) => a.status)).toEqual(["failed", "completed"]);
    expect(JSON.stringify(events)).not.toContain("provider_unavailable");
    const recoveries = events.flatMap((e) => (e.type === "attempt.recovery" ? [e.payload] : []));
    expect(recoveries).toMatchObject([{ rung: "lower-effort", effort: "low", modelId: "codex/gpt-6.1-sol" }]);
    // The billed turn counts against the budget, and its usage keeps what the stream carried.
    const [lost] = specify;
    expect(lost?.used_tokens).toBe(27_967 + 6_412);
    expect(usageOf(lost?.id ?? "")).toMatchObject({
      lostAnswer: {
        message: expect.stringContaining("no final agent message; 1 output line(s) did not parse"),
        seen: ["thread.started", "turn.completed"],
        lines: 3,
        unparsed: 1,
      },
    });
    expect((usageOf(lost?.id ?? "").lostAnswer as { promptBytes: number }).promptBytes).toBeGreaterThan(0);
  }, 60_000);

  test("the same input failing on every rung stops for a person, naming the input and its separators", async () => {
    const { fixture, run, done, specify, events, calls } = await specRun(10);
    expect(done).toMatchObject({ status: "blocked", reason: "no_progress" });
    // As routed, then lower effort: the route has no other transport (exec) and no other model.
    expect(calls()).toBe(2);
    expect(specify.map((a) => a.status)).toEqual(["failed", "failed"]);
    expect(JSON.stringify(events)).not.toContain("provider_unavailable");
    const { store } = fixture.service;
    const advice = store
      .artifacts(run.runId)
      .filter((a) => a.kind === "diagnostic")
      .map((a) => store.readArtifact(run.runId, a.id))
      .join("\n");
    expect(advice).toContain("got no usable answer on every rung of the recovery ladder");
    expect(advice).toContain("lower reasoning effort on codex/gpt-6.1-sol");
    expect(advice).toContain(specify[0]?.input_hash.slice(0, 12) ?? "missing");
    expect(advice).toContain("U+2028 x1");

    // The ladder's decision replays from the bench trace, lost answer included.
    const out = join(tempDir("lost-trace-"), "run.sqlite.gz");
    exportTrace(fixture.root, out);
    const replayed = replayTrace(out).runs.find((r) => r.runId === run.runId);
    expect(replayed?.newRecoveries).toBe(0);
  }, 60_000);
});

describe("lost answers", () => {
  test("every adapter path that ends a billed turn without an answer throws the typed error", async () => {
    expect(() => parseCodexResponse('{"finishReason":"tool-calls","toolCalls":[]}')).toThrow(ProviderAnswerError);
    expect(() => parseClaudeCodeResponse({ finishReason: "tool-calls", toolCalls: [] }, "")).toThrow(ProviderAnswerError);
    const exec = fakeExec(1, "unused");
    const error = await runCodexProcess(["exec", "--json"], "prompt", undefined, undefined, exec.command).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderAnswerError);
    expect(error.usage).toEqual({ inputTokens: 27_967, outputTokens: 6_412 });
    // The doGenerate path carries the turn's usage onto a parse failure too.
    const model = createCodexLanguageModel("gpt-test", {
      run: async () => ({ text: '{"finishReason":"tool-calls","toolCalls":[]}', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }),
    });
    const parsed = await model.doGenerate({ prompt: [], abortSignal: undefined } as never).catch((e) => e);
    expect(lostAnswer(parsed)?.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  test("the ladder takes a lost answer, also wrapped, and nothing else new", () => {
    expect(recoverableCall(new ProviderAnswerError("Codex exec returned no final agent message"))).toBe("lost-answer");
    expect(recoverableCall(new Error("wrapped", { cause: new ProviderAnswerError("x") }))).toBe("lost-answer");
    expect(recoverableCall(new Error("Codex exec returned no final agent message"))).toBeNull();
    expect(invisibleCharacters("a b c﻿")).toEqual(["U+2028 x2", "U+FEFF x1"]);
    expect(invisibleCharacters("plain")).toEqual([]);
  });
});
