import { afterEach, describe, expect, test } from "bun:test";
import { ProviderUnreachableError } from "../src/core/llm/provider-health.js";
import type { CodexAppServerConnection } from "../src/core/llm/providers/codex/client.js";
import {
  CodexAppServerSessions,
  createCodexNativeLanguageModel,
  STALL_PROBE_EXEC_CALLS,
  STALL_PROBE_MS,
} from "../src/core/llm/providers/codex/native.js";
import { createCodexLanguageModel } from "../src/core/llm/providers/codex/runner.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { awakeClock } from "./helpers/awake-clock.js";
import { FixtureExecutor, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 58, wheeltags base specify (#1876). On the Codex app-server transport the first
// call of each attempt answered with a complete submit_artifact call, the host refused it, and
// the call that answered the refusal on the same turn got no first byte in 8 of 8 attempts, on
// astra and on sol. The same stage completed in one 126 s call on `codex exec`. BAKED stayed on
// app-server for every attempt until the provider circuit stopped the run (#1875).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An app-server that calls a tool on each new turn and never streams on after its answer. */
class StallingAppServer {
  turns = 0;
  answers = 0;
  interrupts = 0;
  private notify = new Set<(method: string, params: unknown) => void>();
  private serverRequests = new Set<(method: string, id: string | number, params: unknown) => boolean>();
  private nextId = 100;
  constructor(private readonly call: { tool: string; args: unknown }) {}
  readonly connection: CodexAppServerConnection = {
    closed: false,
    request: async (method, params) => {
      if (method === "thread/start") return { thread: { id: `thread-${this.turns + 1}` } };
      if (method === "turn/interrupt") this.interrupts++;
      if (method === "turn/start") {
        this.turns++;
        const threadId = String(params.threadId);
        const turnId = `turn-${this.turns}`;
        queueMicrotask(() => {
          for (const listener of this.serverRequests)
            listener("item/tool/call", this.nextId++, {
              threadId,
              turnId,
              callId: `call-${this.turns}`,
              tool: this.call.tool,
              arguments: this.call.args,
            });
        });
        return { turn: { id: turnId } };
      }
      return {};
    },
    waitForNotification: async () => {
      throw new Error("not used");
    },
    close: () => {},
    onNotification: (listener) => {
      this.notify.add(listener);
      return () => this.notify.delete(listener);
    },
    onClose: () => () => {},
    onServerRequest: (listener) => {
      this.serverRequests.add(listener);
      return () => this.serverRequests.delete(listener);
    },
    // The answer to the tool call is taken, and the turn never streams on.
    respond: () => {
      this.answers++;
    },
    respondError: () => {},
  };
}

describe("scenario: wheeltags base specify, a stalled follow-up on app-server (#1876)", () => {
  test("the next attempt of the stage runs on codex exec and the spec is accepted", async () => {
    // The first submission misses required fields, so the host refuses it, as in R58 (#1871).
    const appServer = new StallingAppServer({ tool: "submit_result", args: { schemaVersion: 1 } });
    const sessions = new CodexAppServerSessions(async () => appServer.connection);
    const execPrompts: string[] = [];
    const adapter = getProvider("codex");
    if (!adapter) throw new Error("Codex provider missing");
    const original = adapter.createModel;
    adapter.createModel = (modelId: string) =>
      createCodexNativeLanguageModel(
        modelId,
        sessions,
        createCodexLanguageModel(modelId, {
          async run(call) {
            execPrompts.push(call.prompt);
            return {
              text: JSON.stringify({
                finishReason: "tool-calls",
                reasoning: "",
                text: "",
                toolCalls: [{ toolName: "submit_result", inputJson: JSON.stringify(fixtureSpec) }],
              }),
              usage: { inputTokens: 24_810, outputTokens: 4_992, totalTokens: 29_802 },
            };
          },
        }),
      );
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
              return await native.execute({
                ...request,
                profile: { ...request.profile, model: "codex/gpt-6-astra" },
              });
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
    // The spec was accepted and the run went on to its approval.
    expect(store.snapshot(run.runId).reason).not.toBe("no_progress");
    expect(store.requests(run.runId).some((r) => r.status === "pending")).toBe(true);
    const attempts = store.attempts(run.runId).filter((a) => a.model_id !== null);
    const specify = attempts
      .filter((a) => store.rootStage(run.runId, a.step_id) === "specify")
      .sort((a, b) => a.started_at - b.started_at);
    expect(specify.map((a) => a.status)).toEqual(["failed", "completed"]);
    expect(appServer.turns).toBe(1);
    expect(appServer.answers).toBe(1);
    expect(execPrompts).toHaveLength(1);
    const calls = specify.map((a) => {
      const usage = store.latestArtifact(run.runId, `attempts/${a.id}/usage.json`);
      return (JSON.parse(store.readArtifact(run.runId, usage?.id ?? "")) as { calls: unknown[] }).calls;
    });
    // The usage record says which call stalled and on which transport.
    expect(calls[0]).toMatchObject([
      { transport: "app-server", resumed: false, firstByteMs: expect.any(Number) },
      { transport: "app-server", resumed: true, firstByteMs: null },
    ]);
    expect(calls[1]).toMatchObject([{ transport: "exec", firstByteMs: expect.any(Number) }]);
  }, 60_000);
});

describe("codex app-server stalls", () => {
  const prompt = (system: string, task = "Write the spec") =>
    [
      { role: "system", content: system },
      { role: "user", content: [{ type: "text", text: task }] },
    ] as const;
  const tools = [
    {
      type: "function" as const,
      name: "submit_result",
      description: "Submit",
      inputSchema: { type: "object", properties: {} },
    },
  ];

  function setup(now: () => number = Date.now) {
    const appServer = new StallingAppServer({ tool: "submit_result", args: {} });
    const sessions = new CodexAppServerSessions(async () => appServer.connection, now);
    let execCalls = 0;
    const exec = createCodexLanguageModel("gpt-test", {
      async run() {
        execCalls++;
        return {
          text: JSON.stringify({ finishReason: "stop", reasoning: "", text: "exec", toolCalls: [] }),
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    });
    const model = createCodexNativeLanguageModel("gpt-test", sessions, exec);
    return { appServer, model, execCalls: () => execCalls };
  }

  test("a first-byte stall moves that stage's calls to exec and leaves other stages on app-server", async () => {
    const { appServer, model, execCalls } = setup();
    const first = await model.doGenerate({ prompt: [...prompt("Spec author.")], tools });
    expect(first.finishReason).toBe("tool-calls");
    const stalled = new AbortController();
    const resumed = model.doGenerate({
      prompt: [
        ...prompt("Spec author."),
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "submit_result", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "submit_result", output: { type: "error-text", value: "refused" } }] },
      ],
      tools,
      abortSignal: stalled.signal,
    });
    await Bun.sleep(5);
    stalled.abort(new ProviderUnreachableError("codex/gpt-test", "No model response within 216 seconds"));
    await expect(resumed).rejects.toThrow("216 seconds");
    expect(appServer.interrupts).toBe(1);

    const again = await model.doGenerate({ prompt: [...prompt("Spec author.")], tools });
    expect(again.content).toEqual([{ type: "text", text: "exec" }]);
    expect(execCalls()).toBe(1);
    // Another stage's profile keeps its app-server thread.
    const other = await model.doGenerate({ prompt: [...prompt("Planner.")], tools });
    expect(other.finishReason).toBe("tool-calls");
    expect(appServer.turns).toBe(2);
  });

  test("a cancelled call is not a stall: the stage stays on app-server", async () => {
    const { appServer, model, execCalls } = setup();
    await model.doGenerate({ prompt: [...prompt("Spec author.")], tools });
    const cancelled = new AbortController();
    const resumed = model.doGenerate({
      prompt: [
        ...prompt("Spec author."),
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "submit_result", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "submit_result", output: { type: "text", value: "ok" } }] },
      ],
      tools,
      abortSignal: cancelled.signal,
    });
    await Bun.sleep(5);
    cancelled.abort();
    await expect(resumed).rejects.toThrow();
    const again = await model.doGenerate({ prompt: [...prompt("Spec author.")], tools });
    expect(again.finishReason).toBe("tool-calls");
    expect(execCalls()).toBe(0);
    expect(appServer.turns).toBe(2);
  });
  type Model = ReturnType<typeof setup>["model"];
  /** A call of `task` that calls a tool, then the answer to it that gets no first byte. */
  async function stall(model: Model, task: string) {
    const first = await model.doGenerate({ prompt: [...prompt("Analyst.", task)], tools });
    const callId = first.content.find((part) => part.type === "tool-call")?.toolCallId ?? "";
    const stalled = new AbortController();
    const resumed = model.doGenerate({
      prompt: [
        ...prompt("Analyst.", task),
        { role: "assistant", content: [{ type: "tool-call", toolCallId: callId, toolName: "submit_result", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: callId, toolName: "submit_result", output: { type: "text", value: "ok" } }] },
      ],
      tools,
      abortSignal: stalled.signal,
    });
    await Bun.sleep(5);
    stalled.abort(new ProviderUnreachableError("codex/gpt-test", "No model response within 300 seconds"));
    await expect(resumed).rejects.toThrow("300 seconds");
  }
  const call = async (model: Model, task: string) =>
    (await model.doGenerate({ prompt: [...prompt("Analyst.", task)], tools })).finishReason === "tool-calls" ? "app-server" : "exec";

  // R62 stepvet (#1962): one stall of base's analysis moved the analysis of eight features to
  // exec for the rest of a 91-minute drive, with no cache reads, at twice the price per token.
  test("a first stall moves only its input to exec; a stall of another input moves the whole stage", async () => {
    const { model } = setup();
    await stall(model, "Analyze base");
    expect(await call(model, "Analyze base")).toBe("exec");
    expect(await call(model, "Analyze lines")).toBe("app-server");
    await stall(model, "Analyze lines");
    expect(await call(model, "Analyze stepexpr")).toBe("exec");
  });

  test(`after ${STALL_PROBE_EXEC_CALLS} calls on exec one call probes app-server, and its answer clears the mark`, async () => {
    const { model, execCalls } = setup();
    await stall(model, "Analyze base");
    for (let i = 0; i < STALL_PROBE_EXEC_CALLS; i++) expect(await call(model, "Analyze base")).toBe("exec");
    expect(await call(model, "Analyze base")).toBe("app-server");
    expect(await call(model, "Analyze base")).toBe("app-server");
    expect(execCalls()).toBe(STALL_PROBE_EXEC_CALLS);
  });

  test("a mark older than the probe interval probes app-server, and a later stall marks it again", async () => {
    let now = 1_000_000;
    const { model } = setup(() => now);
    await stall(model, "Analyze base");
    expect(await call(model, "Analyze base")).toBe("exec");
    now += STALL_PROBE_MS - 1;
    expect(await call(model, "Analyze base")).toBe("exec");
    now += 1;
    expect(await call(model, "Analyze base")).toBe("app-server");
    await stall(model, "Analyze base");
    expect(await call(model, "Analyze base")).toBe("exec");
  });
});
