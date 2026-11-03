import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV2CallOptions } from "@ai-sdk/provider";
import type { CodexAppServerConnection } from "../src/core/llm/providers/codex/client.js";
import {
  CodexAppServerSessions,
  createCodexNativeLanguageModel,
} from "../src/core/llm/providers/codex/native.js";
import { createCodexLanguageModel } from "../src/core/llm/providers/codex/runner.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { exportTrace, replayTrace } from "../src/core/workflows/trace.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { awakeClock } from "./helpers/awake-clock.js";
import {
  FixtureExecutor,
  fixturePolicy,
  fixtureSpec,
  workflowFixture,
} from "./helpers/workflow-fixture.js";

// #2660 (a follow-up of #2547): Codex sends no `max_output_tokens` with its Responses requests, so
// a runaway answer runs to the model's own limit (#1479: a 10-minute response). The app-server
// adapter counts each step's streamed text and reasoning, and past twice the profile's
// `maxOutputTokens` the `stream_output_limit` reason records a would-stop (shadow) or interrupts
// the turn and ends the step `length` (enforce).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An app-server whose turns run a script: deltas, a usage report, a tool call or a completion. */
class ScriptedAppServer {
  readonly requests: { method: string; params: Record<string, unknown> }[] = [];
  readonly inputs: string[] = [];
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private readonly serverRequests = new Set<
    (method: string, id: string | number, params: unknown) => boolean
  >();
  private threads = 0;
  private turns = 0;
  private nextId = 100;
  constructor(private readonly script: (turn: number, at: ScriptedTurn) => void) {}

  readonly connection: CodexAppServerConnection = {
    closed: false,
    request: async (method, params) => {
      this.requests.push({ method, params });
      if (method === "thread/start") return { thread: { id: `thread-${++this.threads}` } };
      if (method === "turn/start") {
        const turn = ++this.turns;
        const threadId = String(params.threadId);
        const turnId = `turn-${turn}`;
        this.inputs.push((params.input as { text: string }[])[0]?.text ?? "");
        queueMicrotask(() => this.script(turn, new ScriptedTurn(this, threadId, turnId)));
        return { turn: { id: turnId } };
      }
      return {};
    },
    waitForNotification: async () => {
      throw new Error("not used");
    },
    close: () => {},
    onNotification: (listener) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
    onClose: () => () => {},
    onServerRequest: (listener) => {
      this.serverRequests.add(listener);
      return () => this.serverRequests.delete(listener);
    },
    respond: () => {},
    respondError: () => {},
  };

  emit(method: string, params: Record<string, unknown>): void {
    for (const listener of [...this.listeners]) listener(method, params);
  }

  call(params: Record<string, unknown>): void {
    const id = this.nextId++;
    for (const listener of [...this.serverRequests]) if (listener("item/tool/call", id, params)) return;
  }

  count(method: string): number {
    return this.requests.filter((r) => r.method === method).length;
  }
}

class ScriptedTurn {
  constructor(
    private readonly server: ScriptedAppServer,
    readonly threadId: string,
    readonly turnId: string,
  ) {}
  /** `count` agent message deltas of `size` characters each. */
  text(count: number, size: number, itemId = "m1"): void {
    for (let i = 0; i < count; i++)
      this.server.emit("item/agentMessage/delta", {
        threadId: this.threadId,
        turnId: this.turnId,
        itemId,
        delta: "x".repeat(size),
      });
  }
  usage(outputTokens: number): void {
    this.server.emit("thread/tokenUsage/updated", {
      threadId: this.threadId,
      turnId: this.turnId,
      tokenUsage: {
        total: { inputTokens: 2_000, cachedInputTokens: 0, outputTokens, reasoningOutputTokens: 0 },
      },
    });
  }
  complete(): void {
    this.server.emit("item/completed", {
      threadId: this.threadId,
      turnId: this.turnId,
      item: { type: "agentMessage", id: "m1" },
    });
    this.server.emit("turn/completed", {
      threadId: this.threadId,
      turn: { id: this.turnId, status: "completed", error: null },
    });
  }
  toolCall(tool: string, args: unknown): void {
    this.server.call({ threadId: this.threadId, turnId: this.turnId, callId: `call-${this.turnId}`, tool, arguments: args });
  }
}

const unusedExec = createCodexLanguageModel("gpt-test", {
  async run(): Promise<never> {
    throw new Error("exec should not run");
  },
});

async function readParts(stream: ReadableStream<{ type: string }>) {
  const parts: Record<string, unknown>[] = [];
  const reader = stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) return parts;
    parts.push(next.value as Record<string, unknown>);
  }
}

const prompt: LanguageModelV2CallOptions["prompt"] = [
  { role: "system", content: "You are baked." },
  { role: "user", content: [{ type: "text", text: "Review the change" }] },
];

function streamed(parts: Record<string, unknown>[]): number {
  return parts
    .filter((p) => p.type === "text-delta")
    .reduce((n, p) => n + String(p.delta).length, 0);
}

describe("the Codex app-server stream guard (#2660)", () => {
  // maxOutputTokens 100: the guard's limit is 200 tokens, about 800 characters.
  const call = (mode?: "shadow" | "enforce"): LanguageModelV2CallOptions => ({
    prompt,
    maxOutputTokens: 100,
    ...(mode ? { providerOptions: { codex: { outputGuard: mode } } } : {}),
  });

  test("in shadow a stream past twice the limit records the would-stop and keeps streaming", async () => {
    const server = new ScriptedAppServer((_, turn) => {
      turn.text(10, 100);
      turn.usage(260);
      turn.complete();
    });
    const model = createCodexNativeLanguageModel("gpt-test", new CodexAppServerSessions(async () => server.connection), unusedExec);
    const parts = await readParts((await model.doStream(call("shadow"))).stream);
    expect(streamed(parts)).toBe(1_000);
    const finish = parts.at(-1);
    expect(finish).toMatchObject({ type: "finish", finishReason: "stop" });
    expect((finish?.providerMetadata as { codex: Record<string, unknown> }).codex.outputGuard).toEqual({
      mode: "shadow",
      maxOutputTokens: 100,
      factor: 2,
      limitTokens: 200,
      streamedChars: 1_000,
      streamedTokens: 250,
      decision: "would_stop",
    });
    expect(server.count("turn/interrupt")).toBe(0);
  });

  test("enforced, the turn is interrupted and the step ends `length` with the text streamed so far", async () => {
    const server = new ScriptedAppServer((turn, at) => {
      if (turn === 1) {
        at.text(20, 100);
        at.complete();
        return;
      }
      at.text(1, 50);
      at.usage(20);
      at.complete();
    });
    const model = createCodexNativeLanguageModel("gpt-test", new CodexAppServerSessions(async () => server.connection), unusedExec);
    const parts = await readParts((await model.doStream(call("enforce"))).stream);
    // The ninth delta takes the stream to 900 characters, 225 tokens: past the 200-token limit.
    expect(streamed(parts)).toBe(900);
    expect(parts.filter((p) => p.type === "text-end")).toHaveLength(1);
    const finish = parts.at(-1);
    expect(finish).toMatchObject({ type: "finish", finishReason: "length" });
    expect((finish?.providerMetadata as { codex: Record<string, unknown> }).codex.outputGuard).toMatchObject({
      mode: "enforce",
      streamedChars: 900,
      decision: "stopped",
    });
    expect(server.count("turn/interrupt")).toBe(1);
    // The next call, with the truncated answer and the notice after it, starts a new thread.
    const next = await model.doGenerate({
      ...call("enforce"),
      prompt: [
        ...prompt,
        { role: "assistant", content: [{ type: "text", text: "x".repeat(900) }] },
        { role: "user", content: [{ type: "text", text: "Your last response was cut off." }] },
      ],
    });
    expect(next.finishReason).toBe("stop");
    expect(server.count("thread/start")).toBe(2);
    expect(server.inputs[1]).toContain("Your last response was cut off.");
  });

  test("a stream under the limit passes and records only its size", async () => {
    const server = new ScriptedAppServer((_, turn) => {
      turn.text(5, 100);
      turn.usage(120);
      turn.complete();
    });
    const model = createCodexNativeLanguageModel("gpt-test", new CodexAppServerSessions(async () => server.connection), unusedExec);
    const parts = await readParts((await model.doStream(call("enforce"))).stream);
    expect(parts.at(-1)).toMatchObject({ finishReason: "stop" });
    expect((parts.at(-1)?.providerMetadata as { codex: Record<string, unknown> }).codex.outputGuard).toMatchObject({
      streamedChars: 500,
      decision: "pass",
    });
    expect(server.count("turn/interrupt")).toBe(0);
  });

  test("a call without a limit is not guarded", async () => {
    const server = new ScriptedAppServer((_, turn) => {
      turn.text(20, 100);
      turn.usage(500);
      turn.complete();
    });
    const model = createCodexNativeLanguageModel("gpt-test", new CodexAppServerSessions(async () => server.connection), unusedExec);
    const parts = await readParts((await model.doStream({ prompt })).stream);
    expect(streamed(parts)).toBe(2_000);
    expect((parts.at(-1)?.providerMetadata as { codex: Record<string, unknown> }).codex.outputGuard).toBeUndefined();
  });
});

/** The spec stage on Codex app-server (spec-author caps output at 8,192 tokens: 65,536 characters). */
async function specScenario(policy: RunPolicy, script: (turn: number, at: ScriptedTurn) => void) {
  const server = new ScriptedAppServer(script);
  const sessions = new CodexAppServerSessions(async () => server.connection);
  const adapter = getProvider("codex");
  if (!adapter) throw new Error("Codex provider missing");
  const original = adapter.createModel;
  adapter.createModel = (modelId: string) => createCodexNativeLanguageModel(modelId, sessions, unusedExec);
  cleanups.push(() => {
    adapter.createModel = original;
  });
  const fixture = workflowFixture({
    policy,
    executor: (root) =>
      new (class CodexSpecExecutor extends FixtureExecutor {
        override async execute(request: ExecutionRequest) {
          if (request.profile.output !== "spec") return super.execute(request);
          const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, {
            ...fixture.config,
            repoMap: false,
          });
          try {
            return await native.execute({ ...request, profile: { ...request.profile, model: "codex/gpt-6-astra" } });
          } finally {
            native.dispose();
          }
        }
      })(root),
  });
  cleanups.push(fixture.dispose);
  fixture.service.providerProbe = async () => ({});
  const clock = awakeClock();
  cleanups.push(() => clock.restore());
  const run = await fixture.start();
  let finished = false;
  const driving = fixture.service.drive(run.runId, new AbortController().signal).finally(() => {
    finished = true;
  });
  for (let ticks = 0; ticks < 3_600 && !finished; ticks++) {
    clock.advance(1000);
    await Bun.sleep(1);
  }
  await driving;
  const store = fixture.service.store;
  const specify = store
    .attempts(run.runId)
    .filter((a) => a.model_id !== null && store.rootStage(run.runId, a.step_id) === "specify");
  const usage = specify.map((a) => {
    const artifact = store.latestArtifact(run.runId, `attempts/${a.id}/usage.json`);
    return JSON.parse(store.readArtifact(run.runId, artifact?.id ?? "")) as AttemptUsageRecord;
  });
  const wouldStops = store
    .eventsOfType(run.runId, "decision.would_stop")
    .flatMap((e) => (e.type === "decision.would_stop" && e.payload.reason === "stream_output_limit" ? [e.payload] : []));
  const dir = mkdtempSync(join(tmpdir(), "baked-stream-guard-trace-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const trace = join(dir, "trace.sqlite.gz");
  exportTrace(fixture.root, trace);
  const replayed = (options: Parameters<typeof replayTrace>[1] = {}) =>
    replayTrace(trace, options).runs.find((r) => r.runId === run.runId);
  return { server, store, run, specify, usage, wouldStops, replayed };
}

describe("scenario: a runaway Codex spec answer (#2660)", () => {
  test("in shadow the step streams on to its submission and the run records the would-stop", async () => {
    const { server, store, run, specify, usage, wouldStops, replayed } = await specScenario(fixturePolicy, (_, at) => {
      at.text(80, 1_000);
      at.usage(21_000);
      at.toolCall("submit_result", fixtureSpec);
    });
    expect(specify.map((a) => a.status)).toEqual(["completed"]);
    expect(store.requests(run.runId).some((r) => r.status === "pending")).toBe(true);
    // One thread and one turn: the guard did not interrupt it (the attempt's end stops the thread
    // left at its submit_result, #863).
    expect(server.count("turn/start")).toBe(1);
    expect(usage[0]?.steps[0]?.outputGuard).toEqual({
      mode: "shadow",
      maxOutputTokens: 8_192,
      factor: 2,
      limitTokens: 16_384,
      streamedChars: 80_000,
      streamedTokens: 20_000,
      decision: "would_stop",
    });
    expect(wouldStops).toEqual([
      expect.objectContaining({
        mode: "shadow",
        key: `attempt-${specify[0]?.id}-step-0`,
        inputs: expect.objectContaining({ profileId: "spec-author", streamedChars: 80_000, limitTokens: 16_384 }),
      }),
    ]);
    // The trace replays the step as recorded; a rule that never stops removes it, which is no new stop.
    expect(replayed()?.streamOutputs).toEqual([
      expect.objectContaining({ step: 0, recorded: "stop", replayed: "stop" }),
    ]);
    expect(replayed()?.newStreamOutputStops).toBe(0);
  }, 60_000);

  test("enforced, the step ends `length` at the guard and the attempt goes on with the truncation notice", async () => {
    const policy = { ...fixturePolicy, stopModes: { stream_output_limit: "enforce" as const } };
    const { server, specify, usage, wouldStops, replayed } = await specScenario(policy, (turn, at) => {
      if (turn === 1) {
        at.text(80, 1_000);
        return;
      }
      at.usage(1_200);
      at.toolCall("submit_result", fixtureSpec);
    });
    expect(specify.map((a) => a.status)).toEqual(["completed"]);
    expect(server.count("turn/interrupt")).toBeGreaterThanOrEqual(1);
    expect(server.count("thread/start")).toBe(2);
    expect(server.inputs[1]).toContain("was cut off");
    expect(usage[0]?.steps.map((s) => s.outputGuard?.decision)).toEqual(["stopped", "pass"]);
    expect(usage[0]?.steps[0]?.outputGuard?.streamedChars).toBe(66_000);
    expect(wouldStops).toEqual([]);
    expect(replayed()?.newStreamOutputStops).toBe(0);
    // A rule that stops every guarded step finds the passing second step: the hook catches a change.
    const always = () => ({ limitTokens: 0, streamedTokens: 0, over: true });
    expect(replayed({ streamOutputRule: always })?.newStreamOutputStops).toBe(1);
  }, 60_000);

  test("a spec answer under the limit records no would-stop", async () => {
    const { specify, usage, wouldStops, replayed } = await specScenario(fixturePolicy, (_, at) => {
      at.text(10, 1_000);
      at.usage(2_600);
      at.toolCall("submit_result", fixtureSpec);
    });
    expect(specify.map((a) => a.status)).toEqual(["completed"]);
    expect(usage[0]?.steps[0]?.outputGuard?.decision).toBe("pass");
    expect(wouldStops).toEqual([]);
    expect(replayed()?.newStreamOutputStops).toBe(0);
  }, 60_000);
});
