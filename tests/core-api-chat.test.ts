import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { startApiServer } from "../src/core/api/server.js";
import type { SessionDiffStats } from "../src/core/chat/diff-stats.js";
import {
  type ChatAgentHost,
  type CompactionRequest,
  type CompactionResponse,
  type ChatEvent,
  ChatService,
  type SessionDetail,
  type TurnAgentRequest,
} from "../src/core/chat/sessions.js";
import { assembleCompacted, splitForCompaction } from "../src/core/compaction/manual.js";
import { SessionManager } from "../src/core/sessions/manager.js";
import { renderChatExport } from "../src/core/sessions/export.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

type Part = Record<string, unknown> & { type: string };
type Script = (turn: {
  request: TurnAgentRequest;
  signal: AbortSignal;
  messages: ModelMessage[];
}) => AsyncGenerator<Part>;

/** Plays one scripted stream per turn instead of calling a model. */
class ScriptedHost implements ChatAgentHost {
  scripts: Script[] = [];
  seen: { modelId: string; mode: string; effort: string; messages: ModelMessage[] }[] = [];
  released: string[] = [];
  suggestMentions?: ChatAgentHost["suggestMentions"];
  compact?: (request: CompactionRequest) => Promise<CompactionResponse>;
  async agent(request: TurnAgentRequest) {
    const script = this.scripts.shift() ?? reply("ok");
    return {
      contextWindow: 1000,
      agent: {
        stream: async (args: { messages: ModelMessage[]; abortSignal: AbortSignal }) => {
          this.seen.push({
            modelId: request.modelId,
            mode: request.mode,
            effort: request.effort,
            messages: args.messages,
          });
          return {
            stream: script({ request, signal: args.abortSignal, messages: args.messages }),
            responseMessages: Promise.resolve([]),
          };
        },
      },
    };
  }
  release(sessionId: string) {
    this.released.push(sessionId);
  }
  async dispose() {}
}

const step = (input = 100, output = 20): Part => ({
  type: "finish-step",
  usage: { inputTokens: input, outputTokens: output, inputTokenDetails: { cacheReadTokens: 40 } },
});

function reply(text: string): Script {
  return async function* () {
    yield { type: "text-delta", text };
    yield step();
  };
}

/** Waits until the abort signal fires, then fails the stream like the AI SDK does. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const fixture = workflowFixture();
  const host = new ScriptedHost();
  // Global custom commands come from this folder, not the developer's home.
  const home = mkdtempSync(join(tmpdir(), "baked-chat-home-"));
  const chat = new ChatService({
    workspace: fixture.root,
    config: { ...fixture.service.config, defaultModel: "openai/gpt-test" },
    host,
    homeDir: home,
  });
  const server = await startApiServer({ service: fixture.service, chat, pollMs: 20, log: () => {} });
  cleanups.push(async () => {
    await server.stop();
    await fixture.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${server.token}`, ...(init.headers as Record<string, string>) },
    });
  const send = (method: string, path: string, body: unknown) =>
    call(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const post = (path: string, body: unknown = {}) => send("POST", path, body);
  const detail = async (id: string) => (await (await call(`/v1/sessions/${id}`)).json()) as SessionDetail;
  return { fixture, host, chat, server, call, send, post, detail, home };
}

/** Reads session events until `done` holds for the latest one, then disconnects. */
async function events(response: Response, done: (event: ChatEvent) => boolean): Promise<ChatEvent[]> {
  if (!response.body) throw new Error("No body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const seen: ChatEvent[] = [];
  let buffer = "";
  const deadline = Date.now() + 10_000;
  try {
    while (Date.now() < deadline) {
      const { done: ended, value } = await reader.read();
      if (ended) break;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        const type = /^event: (.*)$/m.exec(frame)?.[1];
        if (data && type) {
          const event = { type, ...JSON.parse(data) } as ChatEvent;
          seen.push(event);
          if (done(event)) return seen;
        }
        end = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel();
  }
  throw new Error(`Stream ended early: ${JSON.stringify(seen.map((e) => e.type))}`);
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value ${JSON.stringify(value)}`);
    await Bun.sleep(20);
  }
}

describe("local API chat sessions", () => {
  test("health lists the sessions capability", async () => {
    const { call } = await setup();
    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("sessions");
    expect(health.capabilities).toContain("chat-effort");
  });

  test("a session keeps its reasoning effort, passes it to each turn and to forks", async () => {
    const { host, send, post, detail, fixture } = await setup();
    const created = await post("/v1/sessions", { text: "Hello", effort: "high" });
    const session = (await created.json()) as SessionDetail;
    expect(session.effort).toBe("high");
    await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 2);
    expect(host.seen.at(-1)?.effort).toBe("high");

    const patched = await send("PATCH", `/v1/sessions/${session.id}`, { effort: "low" });
    expect(await patched.json()).toMatchObject({ effort: "low" });
    expect((await send("PATCH", `/v1/sessions/${session.id}`, { effort: "extreme" })).status).toBe(400);
    await post(`/v1/sessions/${session.id}/messages`, { text: "Again" });
    await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 4);
    expect(host.seen.at(-1)?.effort).toBe("low");

    const fork = (await (await post(`/v1/sessions/${session.id}/fork`, {})).json()) as SessionDetail;
    expect(fork.effort).toBe("low");
    // The session reads as idle before its last save lands, so wait for the saved effort.
    await until(
      async () => new SessionManager(fixture.root).loadSession(session.id)?.meta,
      (meta) => meta?.tabs.some((tab) => tab.effort === "low") === true,
    );
    const reloaded = new ChatService({ workspace: fixture.root, config: fixture.service.config, host });
    expect(reloaded.get(session.id).summary().effort).toBe("low");

    const plain = (await (await post("/v1/sessions", {})).json()) as SessionDetail;
    expect(plain.effort).toBe("default");
  });

  test("a session's context size picks the model variant; the coordinator takes the largest", async () => {
    const { host, chat, send, post, detail } = await setup();
    const created = await post("/v1/sessions", { text: "Hello", model: "claude-code/opus" });
    const session = (await created.json()) as SessionDetail;
    expect(session).toMatchObject({
      contextSize: "default",
      contextSizes: [200_000, 1_000_000],
      contextTokens: 200_000,
    });
    await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 2);
    expect(host.seen.at(-1)?.modelId).toBe("claude-code/opus");

    const patched = await send("PATCH", `/v1/sessions/${session.id}`, { contextSize: 1_000_000 });
    expect(await patched.json()).toMatchObject({ contextSize: 1_000_000, contextTokens: 1_000_000 });
    expect((await send("PATCH", `/v1/sessions/${session.id}`, { contextSize: "huge" })).status).toBe(400);
    await post(`/v1/sessions/${session.id}/messages`, { text: "Again" });
    await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 4);
    expect(host.seen.at(-1)?.modelId).toBe("claude-code/opus[1m]");

    // A model with one window runs as chosen and shows no sizes.
    const plain = (await (await post("/v1/sessions", { contextSize: "max" })).json()) as SessionDetail;
    expect(plain).toMatchObject({ contextSize: "max", contextSizes: [], contextTokens: null });

    const coordinator = await chat.create({ model: "claude-code/sonnet", kind: "coordinator" });
    expect(coordinator.summary()).toMatchObject({ contextSize: "default", contextTokens: 1_000_000 });
    coordinator.send("Plan the week");
    await until(
      async () => coordinator.detail(),
      (d) => d.state === "idle" && d.messages.length === 2,
    );
    expect(host.seen.at(-1)?.modelId).toBe("claude-code/sonnet[1m]");
    coordinator.update({ contextSize: 200_000 });
    expect(coordinator.summary().contextTokens).toBe(200_000);
  });

  test("mentions answers with the host's @ completions", async () => {
    const { host, call } = await setup();
    const asked: string[] = [];
    host.suggestMentions = async (query: string) => {
      asked.push(query);
      return [{ kind: "file" as const, insert: "README.md", label: "README.md", detail: "file", indices: [] }];
    };
    const res = await call("/v1/mentions?q=read&limit=5");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { mentions: { insert: string }[] }).mentions[0]?.insert).toBe("README.md");
    expect(asked).toEqual(["read"]);
  });

  test("a turn streams text, tool calls and usage, and is saved where the terminal UI reads it", async () => {
    const { host, call, post, detail, fixture } = await setup();
    host.scripts.push(async function* () {
      yield { type: "reasoning-delta", id: "r1", text: "Thinking" };
      yield { type: "text-delta", text: "Reading " };
      yield { type: "tool-call", toolCallId: "c1", toolName: "edit_file", input: { path: "a.ts" } };
      yield { type: "tool-result", toolCallId: "c1", toolName: "edit_file", output: { success: true, output: "x".repeat(5000) } };
      yield step();
      yield { type: "text-delta", text: "done." };
      yield step(200, 30);
    });
    const created = await post("/v1/sessions", { title: "Router fallback" });
    expect(created.status).toBe(201);
    const session = (await created.json()) as SessionDetail;
    expect(session).toMatchObject({ title: "Router fallback", state: "idle", model: "openai/gpt-test", mode: "default", messages: [], lastSeq: 0 });

    const stream = call(`/v1/sessions/${session.id}/events?after=0`);
    const sent = await post(`/v1/sessions/${session.id}/messages`, { text: "Fix the router" });
    expect(sent.status).toBe(202);
    const { turnId, queued } = (await sent.json()) as { turnId: string; queued: boolean };
    expect(queued).toBe(false);

    const seen = await events(await stream, (e) => e.type === "turn-done");
    const types = seen.map((e) => e.type).filter((t) => t !== "session");
    expect(types).toEqual(["turn-start", "reasoning", "text", "tool-call", "tool-result", "step", "text", "step", "turn-done"]);
    expect(seen.map((e) => e.seq)).toEqual([...seen.map((e) => e.seq)].sort((a, b) => a - b));
    const result = seen.find((e) => e.type === "tool-result");
    expect(result?.type === "tool-result" && result.output.length).toBe(4001);
    const done = seen.at(-1);
    if (done?.type !== "turn-done") throw new Error("No turn-done");
    expect(done).toMatchObject({ turnId, status: "completed", usage: { input: 300, output: 50, cacheRead: 80 } });
    expect(done.message?.content).toBe("Reading done.");

    const after = await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 2);
    expect(after.messages[1]).toMatchObject({
      role: "assistant",
      content: "Reading done.",
      toolCalls: [{ id: "c1", name: "edit_file", args: { path: "a.ts" }, result: { success: true } }],
      segments: [
        { type: "reasoning", content: "Thinking", id: "r1" },
        { type: "text", content: "Reading " },
        { type: "tools", toolCallIds: ["c1"] },
        { type: "text", content: "done." },
      ],
    });
    expect(after.messages[1]?.toolCalls?.[0]?.result?.output.length).toBe(5000);
    expect(after.filesEdited).toEqual(["a.ts"]);
    expect(after.usage).toEqual({ input: 300, output: 50, cacheRead: 80 });
    expect(after.context).toEqual({ usedTokens: 230, windowTokens: 1000, percent: 23 });

    const stored = new SessionManager(fixture.root).loadSessionMessages(session.id);
    expect(stored?.messages.map((m) => m.content)).toEqual(["Fix the router", "Reading done."]);
    const listed = (await (await call("/v1/sessions")).json()) as { sessions: { id: string; title: string }[] };
    expect(listed.sessions.map((s) => s.id)).toContain(session.id);

    // The next turn sends the earlier conversation to the model.
    await post(`/v1/sessions/${session.id}/messages`, { text: "Thanks" });
    await until(() => detail(session.id), (d) => d.messages.length === 4);
    expect(host.seen[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  test("an approval waits as a prompt, shows in attention and resumes the turn when answered", async () => {
    const { host, call, post, detail } = await setup();
    let approved: boolean | undefined;
    host.scripts.push(async function* ({ request }) {
      approved = await request.onApproveDestructive("rm -rf build");
      yield { type: "text-delta", text: approved ? "removed" : "kept" };
      yield step();
    });
    const session = (await (await post("/v1/sessions", { text: "Clean the build" })).json()) as SessionDetail;
    const waiting = await until(() => detail(session.id), (d) => d.prompts.length === 1);
    expect(waiting.state).toBe("waiting");
    const prompt = waiting.prompts[0];
    expect(prompt).toMatchObject({ kind: "destructive", description: "rm -rf build" });
    if (!prompt) throw new Error("No prompt");

    const attention = (await (await call("/v1/attention", { headers: { Accept: "application/json" } })).json()) as {
      items: { source: string; sessionId: string; requestId: string; kind: string; blocking: boolean }[];
    };
    expect(attention.items).toEqual([
      expect.objectContaining({ source: "chat", sessionId: session.id, requestId: prompt.id, kind: "destructive", blocking: true }),
    ]);

    expect((await post(`/v1/sessions/${session.id}/prompts/${prompt.id}`, { answer: "yes" })).status).toBe(400);
    expect((await post(`/v1/sessions/${session.id}/prompts/${prompt.id}`, { approve: true })).status).toBe(200);
    const stale = await post(`/v1/sessions/${session.id}/prompts/${prompt.id}`, { approve: false });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("STALE_PROMPT");
    const done = await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 2);
    expect(approved).toBe(true);
    expect(done.messages[1]?.content).toBe("removed");
  });

  test("questions take an answer or a skip", async () => {
    const { host, post, detail } = await setup();
    const answers: string[] = [];
    host.scripts.push(async function* ({ request }) {
      answers.push(await request.callbacks.onAskUser("Exit code?", [{ label: "2", value: "2" }, { label: "3", value: "3" }], true));
      answers.push(await request.callbacks.onAskUser("Anything else?", [], true));
      yield step();
    });
    const session = (await (await post("/v1/sessions", { text: "Go" })).json()) as SessionDetail;
    const first = (await until(() => detail(session.id), (d) => d.prompts.length === 1)).prompts[0];
    expect(first).toMatchObject({ kind: "question", question: "Exit code?", allowSkip: true });
    await post(`/v1/sessions/${session.id}/prompts/${first?.id}`, { answer: "3" });
    const second = (await until(() => detail(session.id), (d) => d.prompts[0]?.id !== undefined && d.prompts[0].id !== first?.id)).prompts[0];
    await post(`/v1/sessions/${session.id}/prompts/${second?.id}`, { answer: "" });
    await until(() => detail(session.id), (d) => d.state === "idle");
    expect(answers).toEqual(["3", "__skipped__"]);
  });

  test("interrupt stops the turn, denies pending prompts and keeps the partial answer", async () => {
    const { host, call, post, detail } = await setup();
    let approval: Promise<boolean> | undefined;
    host.scripts.push(async function* ({ request, signal }) {
      yield { type: "text-delta", text: "Working" };
      approval = request.onApproveOutsideCwd("write_file", "/etc/hosts");
      await untilAborted(signal);
    });
    const session = (await (await post("/v1/sessions", { text: "Go" })).json()) as SessionDetail;
    await until(() => detail(session.id), (d) => d.prompts.length === 1);
    const stream = call(`/v1/sessions/${session.id}/events?after=0`);
    expect(await (await post(`/v1/sessions/${session.id}/interrupt`)).json()).toEqual({ interrupted: true });
    const seen = await events(await stream, (e) => e.type === "turn-done");
    expect(seen.find((e) => e.type === "prompt-resolved")).toMatchObject({ outcome: "denied" });
    expect(seen.at(-1)).toMatchObject({ type: "turn-done", status: "interrupted" });
    expect(await approval).toBe(false);
    const after = await detail(session.id);
    expect(after.state).toBe("idle");
    expect(after.messages.map((m) => m.content)).toEqual(["Go", "Working"]);
    expect(await (await post(`/v1/sessions/${session.id}/interrupt`)).json()).toEqual({ interrupted: false });
  });

  test("a message sent during a turn is steered into it", async () => {
    const { host, post, detail } = await setup();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let steered: string | undefined;
    host.scripts.push(async function* ({ request }) {
      yield { type: "text-delta", text: "First" };
      yield step();
      await gate;
      steered = request.drainSteering()?.text;
      yield { type: "text-delta", text: " then second" };
      yield step();
    });
    const session = (await (await post("/v1/sessions", { text: "Start" })).json()) as SessionDetail;
    await until(() => detail(session.id), (d) => d.state === "working");
    const sent = (await (await post(`/v1/sessions/${session.id}/messages`, { text: "Also this" })).json()) as { queued: boolean };
    expect(sent.queued).toBe(true);
    expect((await detail(session.id)).queued).toEqual(["Also this"]);
    release();
    const done = await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 3);
    expect(steered).toBe("Also this");
    expect(done.messages.map((m) => [m.role, m.content, m.isSteering ?? false])).toEqual([
      ["user", "Start", false],
      ["user", "Also this", true],
      ["assistant", "First then second", false],
    ]);
  });

  test("custom slash commands expand as in the terminal UI, steered messages too", async () => {
    const { host, post, detail, fixture, home } = await setup();
    const project = join(fixture.root, ".baked", "commands");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "fix-ci.md"), "---\ndescription: Fix CI\n---\nFix the $1 job. Notes: $ARGUMENTS");
    mkdirSync(join(home, ".baked", "commands"), { recursive: true });
    writeFileSync(join(home, ".baked", "commands", "standup.md"), "Write a standup.");
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let steered: string | undefined;
    host.scripts.push(async function* ({ request }) {
      yield step();
      await gate;
      steered = request.drainSteering()?.text;
      yield { type: "text-delta", text: "ok" };
      yield step();
    });
    const session = (await (await post("/v1/sessions", { text: "/fix-ci lint flaky" })).json()) as SessionDetail;
    await until(() => detail(session.id), (d) => d.state === "working");
    await post(`/v1/sessions/${session.id}/messages`, { text: "/standup" });
    release();
    const done = await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 3);
    expect(steered).toBe("Write a standup.");
    expect(done.messages.map((m) => m.content).slice(0, 2)).toEqual([
      "Fix the lint job. Notes: lint flaky",
      "Write a standup.",
    ]);
    const firstTurn = host.seen[0]?.messages.at(-1);
    expect(firstTurn?.role).toBe("user");
    expect(JSON.stringify(firstTurn?.content)).toContain("Fix the lint job.");

    host.scripts.push(reply("plain"));
    await post(`/v1/sessions/${session.id}/messages`, { text: "/unknown stays as typed" });
    const plain = await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 5);
    expect(plain.messages[3]?.content).toBe("/unknown stays as typed");
  });

  test("a message that arrives after the last step starts the next turn", async () => {
    const { host, post, detail } = await setup();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.scripts.push(async function* () {
      await gate;
      yield { type: "text-delta", text: "One" };
      yield step();
    });
    const session = (await (await post("/v1/sessions", { text: "Start" })).json()) as SessionDetail;
    await until(() => detail(session.id), (d) => d.state === "working");
    await post(`/v1/sessions/${session.id}/messages`, { text: "Next" });
    release();
    const done = await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 4);
    expect(done.messages.map((m) => m.content)).toEqual(["Start", "One", "Next", "ok"]);
  });

  test("sessions can be renamed, switched to another model or mode, forked and deleted", async () => {
    const { host, call, send, post, detail, fixture } = await setup();
    const session = (await (await post("/v1/sessions", { text: "Hello" })).json()) as SessionDetail;
    const first = await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 2);

    const patched = await send("PATCH", `/v1/sessions/${session.id.slice(0, 8)}`, {
      title: "Renamed",
      model: "anthropic/claude-test",
      mode: "auto",
    });
    expect(await patched.json()).toMatchObject({ title: "Renamed", model: "anthropic/claude-test", mode: "auto" });
    expect((await send("PATCH", `/v1/sessions/${session.id}`, { mode: "review" })).status).toBe(400);
    expect((await send("PATCH", `/v1/sessions/${session.id}`, {})).status).toBe(400);
    await post(`/v1/sessions/${session.id}/messages`, { text: "Again" });
    await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 4);
    expect(host.seen.at(-1)).toMatchObject({ modelId: "anthropic/claude-test", mode: "auto" });

    const forked = await post(`/v1/sessions/${session.id}/fork`, { atMessageId: first.messages[1]?.id });
    expect(forked.status).toBe(201);
    const fork = (await forked.json()) as SessionDetail;
    expect(fork.id).not.toBe(session.id);
    expect(fork.title).toBe("Renamed (fork)");
    expect(fork.messages.map((m) => m.content)).toEqual(["Hello", "ok"]);
    expect((await post(`/v1/sessions/${session.id}/fork`, { atMessageId: "missing" })).status).toBe(404);

    // The session reads as idle before its last save lands, so wait for the saved meta.
    await until(
      async () => new SessionManager(fixture.root).loadSession(session.id)?.meta,
      (meta) => meta?.customTitle === "Renamed" && meta.tabs.some((tab) => tab.messageRange.endLine === 4),
    );
    const reloaded = new ChatService({ workspace: fixture.root, config: fixture.service.config, host });
    expect(reloaded.get(session.id).summary()).toMatchObject({ title: "Renamed", model: "anthropic/claude-test", mode: "auto" });

    expect((await call(`/v1/sessions/${fork.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await call(`/v1/sessions/${fork.id}`)).status).toBe(404);
    expect(host.released).toContain(fork.id);
  });

  test("a session exports as Markdown or JSON with the terminal UI's renderer", async () => {
    const { call, post, detail } = await setup();
    const session = (await (await post("/v1/sessions", { title: "Router fix", text: "Hello" })).json()) as SessionDetail;
    const done = await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 2);

    const markdown = await call(`/v1/sessions/${session.id}/export`);
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(markdown.headers.get("content-disposition")).toMatch(/^attachment; filename="router-fix-[\d-]+\.md"$/);
    const text = await markdown.text();
    expect(text.startsWith("# Router fix\n")).toBe(true);
    expect(text).toContain("### User");
    expect(text).toContain("Hello");
    expect(text).toContain("### Assistant");
    expect(text).toBe(renderChatExport(done.messages, "markdown", "Router fix"));

    const json = await call(`/v1/sessions/${session.id.slice(0, 8)}/export?format=json`);
    expect(json.status).toBe(200);
    expect(json.headers.get("content-disposition")).toMatch(/\.json"$/);
    expect(((await json.json()) as { content: string }[]).map((m) => m.content)).toEqual(["Hello", "ok"]);

    expect((await call(`/v1/sessions/${session.id}/export?format=pdf`)).status).toBe(400);
    expect((await call(`/v1/sessions/${session.id}/export`, { method: "POST" })).status).toBe(405);
    expect((await call("/v1/sessions/missing/export")).status).toBe(404);
  });

  test("undo and redo rewind the conversation over the API", async () => {
    const { host, call, post, detail } = await setup();
    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("chat-undo");
    expect(health.capabilities).toContain("checkpoints");
    expect(health.capabilities).toContain("chat-export");
    const session = (await (await post("/v1/sessions", { text: "One" })).json()) as SessionDetail;
    await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 2);
    await post(`/v1/sessions/${session.id}/messages`, { text: "Two" });
    await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 4);

    const stream = call(`/v1/sessions/${session.id}/events?after=${(await detail(session.id)).lastSeq}`);
    const undone = await post(`/v1/sessions/${session.id}/undo`);
    expect(undone.status).toBe(200);
    const body = (await undone.json()) as SessionDetail & { rollback: { checkpoint: number } };
    expect(body.messages.map((m) => m.content)).toEqual(["One", "ok"]);
    expect(body.redo).toEqual([{ index: 2, prompt: "Two" }]);
    expect(body.rollback.checkpoint).toBe(1);
    const seen = await events(await stream, (e) => e.type === "rewind");
    expect(seen.at(-1)).toMatchObject({ type: "rewind", action: "undo", checkpoint: 1, messageCount: 2 });

    const listed = (await (await call(`/v1/sessions/${session.id}/checkpoints`)).json()) as {
      checkpoints: { index: number; anchorMessageId: string; endMessageId: string; prompt: string }[];
      redo: { index: number; prompt: string }[];
    };
    expect(listed.checkpoints.map((c) => [c.index, c.prompt])).toEqual([[1, "One"]]);
    expect(listed.checkpoints[0]?.endMessageId).toBe(body.messages[1]?.id);
    expect(listed.redo).toMatchObject([{ index: 2, prompt: "Two" }]);
    expect((await call(`/v1/sessions/${session.id}/checkpoints`, { method: "POST" })).status).toBe(405);

    expect((await post(`/v1/sessions/${session.id}/undo`, { toCheckpoint: 5 })).status).toBe(400);
    const redone = (await (await post(`/v1/sessions/${session.id}/redo`)).json()) as SessionDetail;
    expect(redone.messages.map((m) => m.content)).toEqual(["One", "ok", "Two", "ok"]);
    const nothing = await post(`/v1/sessions/${session.id}/redo`);
    expect(nothing.status).toBe(409);
    expect(((await nothing.json()) as { error: { code: string } }).error.code).toBe("NOTHING_TO_REDO");

    host.scripts.push(async function* ({ signal }) {
      await untilAborted(signal);
    });
    await post(`/v1/sessions/${session.id}/messages`, { text: "Hold" });
    await until(() => detail(session.id), (d) => d.state === "working");
    const busy = await post(`/v1/sessions/${session.id}/undo`);
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe("SESSION_BUSY");
    await post(`/v1/sessions/${session.id}/interrupt`);
  });

  test("errors: unknown sessions and prompts, bad bodies, busy deletes and a stale event cursor", async () => {
    const { host, call, post, detail } = await setup();
    expect((await call("/v1/sessions/nope")).status).toBe(404);
    expect((await post("/v1/sessions", { mode: "review" })).status).toBe(400);
    expect((await post("/v1/sessions", { model: "no-provider" })).status).toBe(400);
    host.scripts.push(async function* ({ signal }) {
      await untilAborted(signal);
    });
    const session = (await (await post("/v1/sessions", { text: "Hold" })).json()) as SessionDetail;
    await until(() => detail(session.id), (d) => d.state === "working");
    const busy = await call(`/v1/sessions/${session.id}`, { method: "DELETE" });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe("SESSION_BUSY");
    expect((await post(`/v1/sessions/${session.id}/prompts/missing`, { approve: true })).status).toBe(409);
    expect((await post(`/v1/sessions/${session.id}/messages`, { text: "" })).status).toBe(400);
    await post(`/v1/sessions/${session.id}/interrupt`);

    const reset = await events(await call(`/v1/sessions/${session.id}/events?after=999999`), (e) => e.type === "reset");
    expect(reset.at(-1)).toMatchObject({ type: "reset" });
  });

  test("a failing model ends the turn as failed and keeps the session usable", async () => {
    const { host, post, detail } = await setup();
    host.scripts.push(async function* () {
      yield { type: "text-delta", text: "Partial" };
      throw new Error("429 rate limited");
    });
    const session = (await (await post("/v1/sessions", { text: "Try" })).json()) as SessionDetail;
    const after = await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 2);
    expect(after.messages[1]?.content).toBe("Partial");
    await post(`/v1/sessions/${session.id}/messages`, { text: "Again" });
    await until(() => detail(session.id), (d) => d.messages.length === 4);
  });
  test("compaction replaces older messages with a summary and the next turn starts from it", async () => {
    const { host, call, post, detail } = await setup();
    const seenCompact: CompactionRequest[] = [];
    host.compact = async (request) => {
      seenCompact.push(request);
      const { older, recent } = splitForCompaction(request.messages, 4);
      const summary = `Summary of ${older.length} messages. ${"x".repeat(60)}`;
      return {
        result: { status: "compacted", messages: assembleCompacted(summary, recent), summary, compacted: older.length, strategy: "v1", usage: { inputTokens: 50, outputTokens: 10 } },
        systemChars: 300,
        contextWindow: 1000,
      };
    };
    const session = (await (await post("/v1/sessions", { text: "One" })).json()) as SessionDetail;
    await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 2);
    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("compaction");

    // Two messages are too few to summarize.
    const short = await post(`/v1/sessions/${session.id}/compact`);
    expect(short.status).toBe(409);
    expect(((await short.json()) as { error: { code: string } }).error.code).toBe("NOTHING_TO_COMPACT");

    for (const text of ["Two", "Three"]) {
      await post(`/v1/sessions/${session.id}/messages`, { text });
      await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.at(-1)?.role === "assistant" && d.messages.length % 2 === 0 && d.messages.some((m) => m.content === text));
    }
    const before = await detail(session.id);
    const stream = call(`/v1/sessions/${session.id}/events?after=${before.lastSeq}`);
    const started = await post(`/v1/sessions/${session.id}/compact`);
    expect(started.status).toBe(202);
    const { compactionId } = (await started.json()) as { compactionId: string };
    const seen = await events(await stream, (e) => e.type === "compaction-done");
    expect(seen.map((e) => e.type).filter((t) => t.startsWith("compaction"))).toEqual(["compaction-start", "compaction-done"]);
    const done = seen.at(-1);
    if (done?.type !== "compaction-done") throw new Error("No compaction-done");
    expect(done).toMatchObject({ compactionId, status: "compacted", compacted: 2, context: { usedTokens: expect.any(Number), windowTokens: 1000 } });
    expect(done.message?.role).toBe("system");
    expect(seenCompact[0]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);

    const after = await until(() => detail(session.id), (d) => d.state === "idle" && !d.compacting);
    expect(after.messages.at(-1)?.content).toContain("Compacted 2 messages");
    expect(after.usage).toMatchObject({ input: 350, output: 70 });
    await post(`/v1/sessions/${session.id}/messages`, { text: "Four" });
    await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.at(-1)?.role === "assistant" && d.messages.some((m) => m.content === "Four"));
    const sent = host.seen.at(-1)?.messages ?? [];
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user"]);
    expect(String(sent[0]?.content)).toContain("Summary of 2 messages");
    expect(sent[1]?.content).toBe("Continuing.");
  });

  test("a message sent while compacting waits and starts the next turn; interrupt and busy errors", async () => {
    const { host, post, detail } = await setup();
    let release: () => void = () => {};
    host.compact = async (request) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        request.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      const { recent } = splitForCompaction(request.messages, 4);
      const summary = "y".repeat(80);
      return { result: { status: "compacted", messages: assembleCompacted(summary, recent), summary, compacted: 2, strategy: "v2" } };
    };
    const session = (await (await post("/v1/sessions", { text: "One" })).json()) as SessionDetail;
    for (const text of ["Two", "Three"]) {
      await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.at(-1)?.role === "assistant");
      await post(`/v1/sessions/${session.id}/messages`, { text });
    }
    await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 6);

    expect((await post(`/v1/sessions/${session.id}/compact`)).status).toBe(202);
    const busy = await until(() => detail(session.id), (d) => d.compacting);
    expect(busy.state).toBe("working");
    const again = await post(`/v1/sessions/${session.id}/compact`);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("SESSION_BUSY");
    const queued = await post(`/v1/sessions/${session.id}/messages`, { text: "After" });
    expect(((await queued.json()) as { queued: boolean }).queued).toBe(true);
    release();
    const after = await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.at(-1)?.role === "assistant" && d.messages.some((m) => m.content === "After"));
    expect(after.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "system", "user", "assistant"]);

    // Interrupting a compaction keeps the conversation as it was.
    expect((await post(`/v1/sessions/${session.id}/compact`)).status).toBe(202);
    await until(() => detail(session.id), (d) => d.compacting);
    expect(((await (await post(`/v1/sessions/${session.id}/interrupt`)).json()) as { interrupted: boolean }).interrupted).toBe(true);
    const stopped = await until(() => detail(session.id), (d) => !d.compacting && d.state === "idle");
    expect(stopped.messages).toHaveLength(9);

    host.compact = undefined;
    const unsupported = await post(`/v1/sessions/${session.id}/compact`);
    expect(unsupported.status).toBe(501);
    expect((await post(`/v1/sessions/${session.id}/compact`, { keep: 2 })).status).toBe(400);
  });

  test("plan mode reviews the plan as a prompt; accepting it runs the plan outside plan mode", async () => {
    const { host, call, post, detail, fixture } = await setup();
    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("plan-mode");
    const plan = {
      title: "Add a flag",
      depth: "light" as const,
      steps: [
        { id: "1", label: "Parse it", status: "pending" as const },
        { id: "2", label: "Test it", status: "pending" as const },
      ],
      createdAt: 1,
    };
    const actions: string[] = [];
    // The planning turn: proposes the plan, is revised once, then accepted.
    host.scripts.push(async function* ({ request, signal }) {
      request.callbacks.onPlanCreate(plan);
      actions.push(await request.callbacks.onPlanReview(plan, ".baked/plans/p.md", "# Add a flag v1"));
      request.callbacks.onPlanCreate(plan);
      await Bun.write(`${fixture.root}/.baked/plans/p.md`, "# Add a flag v2 (edited)");
      actions.push(await request.callbacks.onPlanReview(plan, ".baked/plans/p.md", "# Add a flag v2"));
      yield { type: "text-delta", text: "Planned." };
      await untilAborted(signal);
    });
    // The execution turn carries out the plan.
    host.scripts.push(async function* ({ request }) {
      request.callbacks.onPlanStepUpdate("1", "done");
      yield { type: "text-delta", text: "Executed." };
      yield step();
    });
    const session = (await (await post("/v1/sessions", { mode: "plan", text: "Add --dry-run" })).json()) as SessionDetail;
    expect(session.mode).toBe("plan");
    const stream = call(`/v1/sessions/${session.id}/events?after=0`);

    const first = await until(() => detail(session.id), (d) => d.prompts.length === 1);
    const review = first.prompts[0];
    expect(review).toMatchObject({
      kind: "plan-review",
      title: "Add a flag",
      depth: "light",
      steps: [{ id: "1", label: "Parse it" }, { id: "2", label: "Test it" }],
      planFile: ".baked/plans/p.md",
      content: "# Add a flag v1",
    });
    expect(first.plan?.title).toBe("Add a flag");
    const url = `/v1/sessions/${session.id}/prompts/${review?.id}`;
    expect((await post(url, { approve: true })).status).toBe(400);
    expect((await post(url, { action: "revise" })).status).toBe(400);
    expect((await post(url, { action: "revise", feedback: "Also document it" })).status).toBe(200);

    const second = await until(() => detail(session.id), (d) => d.prompts.length === 1 && d.prompts[0]?.id !== review?.id);
    expect((await post(`/v1/sessions/${session.id}/prompts/${second.prompts[0]?.id}`, { action: "execute" })).status).toBe(200);

    const seen = await events(await stream, (e) => e.type === "turn-done" && e.message?.content === "Executed.");
    expect(actions).toEqual(["Also document it", "execute"]);
    const resolved = seen.filter((e) => e.type === "prompt-resolved");
    expect(resolved).toEqual([
      expect.objectContaining({ outcome: "answered", action: "revise" }),
      expect.objectContaining({ outcome: "approved", action: "execute" }),
    ]);
    const dones = seen.filter((e) => e.type === "turn-done");
    expect(dones.map((e) => e.type === "turn-done" && e.status)).toEqual(["completed", "completed"]);
    expect(seen.find((e) => e.type === "notice")).toMatchObject({ message: { role: "system", content: "Plan accepted — executing." } });
    const planEvents = seen.filter((e) => e.type === "plan");
    expect(planEvents.at(-2)).toMatchObject({ plan: { steps: [{ id: "1", status: "done" }, { id: "2", status: "pending" }] } });
    expect(planEvents.at(-1)).toMatchObject({ plan: null });

    // The plan turn ran in plan mode; the execution turn in default mode with the edited plan.
    expect(host.seen.map((s) => s.mode)).toEqual(["plan", "default"]);
    const execution = String(host.seen[1]?.messages.at(-1)?.content);
    expect(execution).toContain("Execute this plan.");
    expect(execution).toContain("# Add a flag v2 (edited)");
    const after = await until(() => detail(session.id), (d) => d.state === "idle");
    expect(after.mode).toBe("default");
    expect(after.plan).toBeNull();
    expect(after.messages.map((m) => m.role)).toEqual(["user", "assistant", "system", "user", "assistant"]);
    expect(after.messages[3]?.content).toBe("Execute the plan: Add a flag");
  });

  test("cancelling a plan review leaves plan mode; interrupting it keeps plan mode", async () => {
    const { host, post, detail } = await setup();
    const plan = { title: "Rename", depth: "full" as const, steps: [{ id: "1", label: "Do", status: "pending" as const }], createdAt: 1 };
    let action: string | undefined;
    host.scripts.push(async function* ({ request }) {
      action = await request.callbacks.onPlanReview(plan, ".baked/plans/missing.md", "# Rename");
      yield { type: "text-delta", text: "Waiting." };
      yield step();
    });
    const session = (await (await post("/v1/sessions", { mode: "plan", text: "Rename it" })).json()) as SessionDetail;
    const waiting = await until(() => detail(session.id), (d) => d.prompts.length === 1);
    await post(`/v1/sessions/${session.id}/prompts/${waiting.prompts[0]?.id}`, { action: "cancel" });
    const cancelled = await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 3);
    expect(action).toBe("cancel");
    expect(cancelled.mode).toBe("default");
    expect(cancelled.messages.at(-1)).toMatchObject({ role: "system", content: "Plan cancelled: Rename" });

    host.scripts.push(async function* ({ request, signal }) {
      action = await request.callbacks.onPlanReview(plan, ".baked/plans/missing.md", "# Rename");
      await untilAborted(signal);
    });
    const again = (await (await post("/v1/sessions", { mode: "plan", text: "Rename it" })).json()) as SessionDetail;
    await until(() => detail(again.id), (d) => d.prompts.length === 1);
    await post(`/v1/sessions/${again.id}/interrupt`);
    const interrupted = await until(() => detail(again.id), (d) => d.state === "idle");
    expect(action).toBe("cancel");
    expect(interrupted.mode).toBe("plan");
    expect(interrupted.messages.map((m) => m.role)).toEqual(["user"]);
  });

  test("a plan made outside plan mode goes ahead without a review", async () => {
    const { host, post, detail } = await setup();
    let action: string | undefined;
    host.scripts.push(async function* ({ request }) {
      action = await request.callbacks.onPlanReview(
        { title: "T", depth: "light", steps: [], createdAt: 1 },
        ".baked/plans/t.md",
        "# T",
      );
      yield step();
    });
    const session = (await (await post("/v1/sessions", { text: "Go" })).json()) as SessionDetail;
    await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length >= 1);
    expect(action).toBe("execute");
  });

  test("diff stats list the files the session edited", async () => {
    const { host, call, post, detail } = await setup();
    host.scripts.push(async function* () {
      yield { type: "tool-call", toolCallId: "c1", toolName: "edit_file", input: { path: "a.ts" } };
      yield { type: "tool-result", toolCallId: "c1", toolName: "edit_file", output: { success: true, output: "ok" } };
      yield { type: "tool-call", toolCallId: "c2", toolName: "edit_file", input: { path: "b.ts" } };
      yield { type: "tool-result", toolCallId: "c2", toolName: "edit_file", output: { success: false, output: "", error: "no match" } };
      yield step();
    });
    const session = (await (await post("/v1/sessions", { text: "Edit" })).json()) as SessionDetail;
    await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 2);
    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("diff-stats");
    const res = await call(`/v1/sessions/${session.id}/diff`);
    expect(res.status).toBe(200);
    const stats = (await res.json()) as SessionDiffStats;
    expect(stats.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(stats.totals.files).toBe(stats.files.filter((f) => f.status !== "unchanged").length);
    expect((await post(`/v1/sessions/${session.id}/diff`)).status).toBe(405);
  });
});
