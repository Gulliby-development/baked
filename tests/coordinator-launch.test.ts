import { afterEach, describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { startApiServer } from "../src/core/api/server.js";
import { BriefStore } from "../src/core/chat/coordinator.js";
import { type ChatAgentHost, ChatService, type TurnAgentRequest } from "../src/core/chat/sessions.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

class RecordingHost implements ChatAgentHost {
  requests: TurnAgentRequest[] = [];
  async agent(request: TurnAgentRequest) {
    this.requests.push(request);
    return {
      contextWindow: 1000,
      agent: {
        stream: async (_args: { messages: ModelMessage[]; abortSignal: AbortSignal }) => ({
          stream: (async function* () {
            yield { type: "text-delta", text: "done" };
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

type Result = { success: boolean; output: string; error?: string };
type Tool = { execute: (input: Record<string, unknown>) => Promise<Result> };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(maxActive = 3) {
  const fixture = workflowFixture();
  const host = new RecordingHost();
  const chat = new ChatService({
    workspace: fixture.root,
    config: { ...fixture.service.config, defaultModel: "openai/gpt-test", coordinator: { maxActive } },
    host,
    homeDir: fixture.root,
  });
  const server = await startApiServer({ service: fixture.service, chat, pollMs: 20, log: () => {} });
  cleanups.push(async () => {
    await server.stop();
    await fixture.dispose();
  });
  const coordinator = await chat.coordinator(true);
  if (!coordinator) throw new Error("no coordinator");
  coordinator.send("plan the week");
  await coordinator.settled();
  const tools = (host.requests.at(-1)?.tools ?? {}) as Record<string, Tool>;
  const tool = (name: string): Tool => {
    const found = tools[name];
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };
  return { fixture, chat, host, coordinator, tool };
}

/** Syncs until a notice matching `pattern` arrives. */
async function noticeFor(chat: ChatService, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const found = (await chat.syncLaunched()).find((n) => pattern.test(n));
    if (found) return found;
    await Bun.sleep(25);
  }
  throw new Error(`No notice matching ${pattern}`);
}

describe("coordinator launches", () => {
  test("a background session and a run show in their lists and report back", async () => {
    const { fixture, chat, coordinator, tool } = await setup();

    const session = await tool("launch_session").execute({
      title: "Survey the auth code",
      brief: "List every place that checks a token.",
      mode: "architect",
      why: "Find the token checks",
    });
    expect(session).toMatchObject({ success: true });
    const sessionId = /session ([0-9a-f-]{36})/.exec(session.output)?.[1] ?? "";
    expect(chat.list().map((s) => s.id)).toContain(sessionId);
    await chat.get(sessionId).settled();
    expect(await noticeFor(chat, /^session/)).toContain(`session ${sessionId}: done (Find the token checks)`);

    const run = await tool("start_run").execute({ prompt: "Create ready value", feature: "fixture", why: "Ship the value" });
    expect(run).toMatchObject({ success: true });
    const runId = /run ([0-9a-f-]{36})/.exec(run.output)?.[1] ?? "";
    expect((await fixture.service.list({ limit: 10 })).items.map((r) => r.runId)).toContain(runId);
    expect(await noticeFor(chat, /^run/)).toBe(`run ${runId}: waiting: approval (Ship the value)`);

    const brief = new BriefStore(chat.workspace, coordinator.id).read();
    expect(brief.launched.map((l) => [l.kind, l.id, l.status])).toEqual([
      ["session", sessionId, "done"],
      ["run", runId, "waiting: approval"],
    ]);
    const notices = coordinator.messages.filter((m) => m.role === "system").map((m) => m.content);
    expect(notices).toContain(`Launched run ${runId}: waiting: approval (Ship the value)`);
    // Nothing new: no second notice.
    expect(await chat.syncLaunched()).toEqual([]);
  }, 60000);

  test("a writing session needs the user's yes, and the active limit holds", async () => {
    const { chat, coordinator, tool } = await setup(1);
    const declined = tool("launch_session").execute({
      title: "Fix it",
      brief: "Fix the bug",
      mode: "default",
      why: "Fix",
    });
    await Bun.sleep(10);
    const prompt = coordinator.pendingPrompts[0];
    if (!prompt || prompt.kind !== "destructive") throw new Error("no confirmation prompt");
    expect(prompt.description).toContain("default-mode session");
    coordinator.answer(prompt.id, { approve: false });
    expect(await declined).toMatchObject({ success: false, error: expect.stringContaining("declined") });
    expect(chat.list()).toEqual([]);

    const approved = tool("launch_session").execute({ title: "Fix it", brief: "Fix the bug", mode: "default", why: "Fix" });
    await Bun.sleep(10);
    const second = coordinator.pendingPrompts[0];
    if (!second) throw new Error("no confirmation prompt");
    coordinator.answer(second.id, { approve: true });
    expect((await approved).success).toBe(true);
    expect(chat.list().map((s) => s.mode)).toEqual(["default"]);

    // The launched session is still working on its first turn, so the limit of one is reached.
    const blocked = await tool("start_run").execute({ prompt: "Create ready value", why: "More" });
    expect(blocked.error ?? "").toContain("limit 1");
  }, 60000);
});
