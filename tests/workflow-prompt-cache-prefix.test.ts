/**
 * The attempts of a run share the run-level part of their prompt. It carries a cache breakpoint
 * on the Claude API and goes into the Claude Code system prompt, so the next attempt reads it
 * from the prompt cache instead of writing it again (#995).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { anthropicResponse } from "./helpers/anthropic-response.js";
import { createAnthropic } from "@ai-sdk/anthropic";
import {
  type ClaudeCodeProcess,
  type ClaudeCodeProcessFactory,
  ClaudeCodeSessionRunner,
  createClaudeCodeLanguageModel,
} from "../src/core/llm/providers/claude-code.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { splitWorkflowContext } from "../src/core/workflows/context.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { type AgentProfile, ProfileSchema } from "../src/core/workflows/schemas.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const research = {
  schemaVersion: 1,
  summary: "A fixture workspace",
  facts: [],
  unknowns: [],
  constraints: [],
  suggestedScope: [],
};

/** A run-level context shared by every attempt, then the attempt's own line, as buildWorkflowContext lays it out. */
const SHARED = `Project instructions\nThe accepted spec and plan of the run: ${"spec ".repeat(200)}\n`;
const promptFor = (task: string) => `${SHARED}${JSON.stringify({ extra: { task } })}`;

function override(id: string, createModel: (model: string) => unknown) {
  const provider = getProvider(id);
  if (!provider) throw new Error(`${id} provider missing`);
  const original = provider.createModel;
  provider.createModel = createModel as typeof provider.createModel;
  cleanups.push(() => {
    provider.createModel = original;
  });
}

async function attempts(model: string, prompts: string[]) {
  const fixture = workflowFixture({ policy: fixturePolicy });
  cleanups.push(fixture.dispose);
  const { store } = fixture.service;
  const run = await fixture.start();
  store.transaction(() => store.transition(run.runId, "running"));
  const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
  const researcher = profiles.find((p) => p.output === "research");
  if (!researcher) throw new Error("research profile missing");
  const profile: AgentProfile = { ...researcher, model };
  const executor = new NativeAgentExecutor(store, new WorkspaceLeases(store), {
    ...fixture.config,
    repoMap: false,
  });
  cleanups.push(() => executor.dispose());
  for (const prompt of prompts) {
    const stepId = store.beginStep(run.runId, "fixture");
    const attemptId = store.reserve(run.runId, stepId, profile.model, 50_000, fixturePolicy);
    await executor.execute({
      runId: run.runId,
      attemptId,
      profile,
      prompt,
      signal: new AbortController().signal,
      maxSteps: 4,
    });
  }
}

describe("the run-level prompt prefix", () => {
  test("splits a workflow context before the attempt's own line", () => {
    expect(splitWorkflowContext(promptFor("T001"))).toEqual({
      shared: SHARED,
      own: '{"extra":{"task":"T001"}}',
    });
    expect(splitWorkflowContext("Research the fixture")).toBeNull();
  });

  test("on the Claude API, ends in a cache breakpoint that the next attempt sends unchanged", async () => {
    type Block = { type: string; text: string; cache_control?: unknown };
    type Body = {
      cache_control?: unknown;
      system?: { cache_control?: unknown }[];
      messages: { content: Block[] }[];
    };
    const bodies: Body[] = [];
    const fetchMock = async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      return anthropicResponse({
        id: `msg_${bodies.length}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "tool_use", id: `toolu_${bodies.length}`, name: "submit_result", input: research }],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 50 },
      });
    };
    override("anthropic", (id) => createAnthropic({ apiKey: "test-key", fetch: fetchMock as typeof fetch })(id));
    await attempts("anthropic/claude-sonnet-4-6", [promptFor("T001"), promptFor("T002")]);

    expect(bodies).toHaveLength(2);
    const [first, second] = bodies.map((body) => body.messages[0]?.content ?? []);
    expect(first?.map((block) => block.text).join("")).toBe(promptFor("T001"));
    expect(first?.[0]).toEqual({ type: "text", text: SHARED, cache_control: { type: "ephemeral", ttl: "5m" } });
    expect(second?.[0]).toEqual(first?.[0]);
    expect(second?.[1]?.text).toBe('{"extra":{"task":"T002"}}');
    for (const body of bodies) {
      // System prompt, run-level prefix and the automatic one: within the API's four breakpoints.
      const marks = [body.cache_control, ...(body.system ?? []).map((b) => b.cache_control)]
        .concat(body.messages.flatMap((m) => m.content.map((b) => b.cache_control)))
        .filter(Boolean);
      expect(marks.length).toBeLessThanOrEqual(4);
    }
  }, 30_000);

  test("on Claude Code, goes into the system prompt that every attempt of the run shares", async () => {
    const spawned: { instructions: string; sent: string[] }[] = [];
    const factory: ClaudeCodeProcessFactory = ({ instructions }) => {
      const record = { instructions, sent: [] as string[] };
      spawned.push(record);
      const listeners: ((line: string) => void)[] = [];
      const proc: ClaudeCodeProcess = {
        send(line) {
          record.sent.push(line);
          queueMicrotask(() => {
            for (const listener of listeners)
              listener(
                JSON.stringify({
                  type: "result",
                  subtype: "success",
                  result: "",
                  structured_output: {
                    finishReason: "tool-calls",
                    text: "",
                    toolCalls: [{ toolName: "submit_result", inputJson: JSON.stringify(research) }],
                  },
                  usage: { input_tokens: 5, output_tokens: 30 },
                }),
              );
          });
        },
        onLine(listener) {
          listeners.push(listener);
        },
        onExit() {},
        kill() {},
      };
      return proc;
    };
    const runner = new ClaudeCodeSessionRunner(factory);
    cleanups.push(() => runner.close());
    override("claude-code", (id) => createClaudeCodeLanguageModel(id, runner));
    await attempts("claude-code/sonnet", [promptFor("T001"), promptFor("T002")]);

    expect(spawned).toHaveLength(2);
    const [first, second] = spawned;
    expect(second?.instructions).toBe(first?.instructions);
    expect(first?.instructions).toContain("TRANSCRIPT START");
    expect(first?.instructions).toContain(SHARED.trim());
    const turn = (line: string | undefined) =>
      (JSON.parse(line ?? "{}") as { message: { content: string } }).message.content;
    const firstTurn = turn(first?.sent[0]);
    const secondTurn = turn(second?.sent[0]);
    expect(firstTurn).not.toContain("The accepted spec");
    expect(firstTurn).toContain('2. USER (continued)\n{"extra":{"task":"T001"}}');
    expect(secondTurn).toContain('{"extra":{"task":"T002"}}');
  }, 30_000);
});
