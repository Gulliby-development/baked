import { afterEach, describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { startApiServer } from "../src/core/api/server.js";
import { renderState, STATE_TOOL, type SessionSource } from "../src/core/chat/project-state.js";
import { type ChatAgentHost, ChatService, type TurnAgentRequest } from "../src/core/chat/sessions.js";
import { newId } from "../src/core/workflows/store.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

/** Records each turn's request and answers with one text part. */
class RecordingHost implements ChatAgentHost {
  requests: TurnAgentRequest[] = [];
  async agent(request: TurnAgentRequest) {
    this.requests.push(request);
    return {
      contextWindow: 1000,
      agent: {
        stream: async (_args: { messages: ModelMessage[]; abortSignal: AbortSignal }) => ({
          stream: (async function* () {
            yield { type: "text-delta", text: "answer" };
            yield { type: "finish-step", usage: { inputTokens: 10, outputTokens: 1 } };
          })(),
          responseMessages: Promise.resolve([]),
        }),
      },
    };
  }
  release() {}
  async dispose() {}
}

type StateTool = { execute: (input: { view: string; id?: string }) => Promise<{ success: boolean; output: string; error?: string }> };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const fixture = workflowFixture();
  const host = new RecordingHost();
  const chat = new ChatService({
    workspace: fixture.root,
    config: { ...fixture.service.config, defaultModel: "openai/gpt-test" },
    host,
    homeDir: fixture.root,
  });
  const server = await startApiServer({ service: fixture.service, chat, pollMs: 20, log: () => {} });
  cleanups.push(async () => {
    await server.stop();
    await fixture.dispose();
  });
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${server.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers as Record<string, string>),
      },
    });
  return { chat, host, call };
}

describe("coordinator project state", () => {
  test("answers what runs and what waits for a person from fixture runs and sessions", async () => {
    const { chat, host, call } = await setup();
    const ordinary = await chat.create({ title: "Refactor auth" });
    ordinary.send("look at the login flow");
    await ordinary.settled();

    const started = await call("/v1/workflow/runs", {
      method: "POST",
      body: JSON.stringify({ commandId: newId(), feature: "fixture", prompt: "Create ready value" }),
    });
    const { runId } = (await started.json()) as { runId: string };
    const deadline = Date.now() + 20_000;
    let waiting = 0;
    while (Date.now() < deadline && waiting === 0) {
      const { items } = (await (await call("/v1/attention")).json()) as { items: unknown[] };
      waiting = items.length;
      if (!waiting) await Bun.sleep(25);
    }
    expect(waiting).toBe(1);

    const coordinator = await chat.coordinator(true);
    if (!coordinator) throw new Error("no coordinator");
    coordinator.send("what is going on?");
    await coordinator.settled();
    const tools = host.requests.at(-1)?.tools ?? {};
    const tool = tools[STATE_TOOL] as StateTool;
    expect(host.requests.at(-1)?.coordinator).toBe(true);
    // Ordinary sessions do not get the tool.
    expect(host.requests[0]?.tools).toBeUndefined();

    const overview = await tool.execute({ view: "overview" });
    expect(overview.success).toBe(true);
    expect(overview.output).toContain("## Waiting for a person");
    expect(overview.output).toContain(`run ${runId}: approval request`);
    expect(overview.output).toContain(`- run ${runId} [waiting: approval]`);

    const run = await tool.execute({ view: "run", id: runId });
    expect(run.output).toContain("## Pending requests");
    expect(run.output).toContain(": approval");

    const sessions = await tool.execute({ view: "sessions" });
    expect(sessions.output).toContain("Refactor auth");
    expect(sessions.output).not.toContain(coordinator.id);
    const session = await tool.execute({ view: "session", id: ordinary.id });
    expect(session.output).toContain("- user: look at the login flow");
    expect(session.output).toContain("- assistant: answer");

    expect((await tool.execute({ view: "initiatives" })).output).toContain("No initiatives yet.");
    const missing = await tool.execute({ view: "run" });
    expect(missing).toMatchObject({ success: false, error: "Give the id of the run to show" });
    const unknown = await tool.execute({ view: "initiative", id: "nope" });
    expect(unknown.success).toBe(false);
  }, 60000);

  test("without a workflow service the views say so", () => {
    const sessions: SessionSource = { list: () => [], messages: () => ({ title: "", messages: [] }) };
    expect(renderState("runs", undefined, null, sessions)).toContain("not available");
    expect(renderState("overview", undefined, null, sessions)).toContain("Nothing.");
  });
});
