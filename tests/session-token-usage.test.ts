import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { type ChatAgentHost, ChatService } from "../src/core/chat/sessions.js";
import { SessionManager } from "../src/core/sessions/manager.js";
import { addTabUsage, emptyTabUsage, readTabUsage } from "../src/core/sessions/token-usage.js";
import type { TabMeta } from "../src/core/sessions/types.js";
import {
  newHeadlessSession,
  openHeadlessSession,
  saveHeadlessSession,
} from "../src/headless/saved-session.js";
import type { ChatMessage } from "../src/types/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";

// #2784: every chat surface saves `TabMeta.tokenUsage` in one meaning: `prompt` is uncached
// input, the whole input is `prompt + cacheRead + cacheWrite`, and `modelBreakdown` prices it.

const MODEL = "openai/gpt-test";
const dirs: string[] = [];
const services: ChatService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-token-usage-"));
  dirs.push(dir);
  return dir;
}

const message = (role: "user" | "assistant", content: string): ChatMessage => ({
  id: crypto.randomUUID(),
  role,
  content,
  timestamp: Date.now(),
});

/** What the TUI saves after one step of 100 input (80 cache reads) and 10 output. */
const tuiUsage = (): TabMeta["tokenUsage"] => ({
  prompt: 20,
  completion: 10,
  total: 110,
  cacheRead: 80,
  cacheWrite: 0,
  modelBreakdown: { [MODEL]: { input: 20, output: 10, cacheRead: 80, cacheWrite: 0 } },
});

/** Saves a one-tab session whose tab has the given usage, as another surface left it. */
async function savedSession(dir: string, tokenUsage: TabMeta["tokenUsage"]): Promise<string> {
  const store = new SessionManager(dir);
  const id = crypto.randomUUID();
  const tab: TabMeta = {
    id: "tab-1",
    label: "Tab 1",
    activeModel: MODEL,
    sessionId: id,
    planMode: false,
    planRequest: null,
    coAuthorCommits: false,
    tokenUsage,
    messageRange: { startLine: 0, endLine: 2 },
  };
  await store.saveTab(id, tab, [message("user", "hi"), message("assistant", "hello")], undefined, {
    title: "hi",
    cwd: dir,
    bakeMode: "default",
    activeTabId: "tab-1",
  });
  return id;
}

function savedUsage(dir: string, id: string): TabMeta["tokenUsage"] | undefined {
  const meta = new SessionManager(dir).loadSession(id)?.meta;
  return meta?.tabs.find((t) => t.id === meta.activeTabId)?.tokenUsage;
}

describe("saved token usage helper", () => {
  test("a step adds its uncached input to prompt and to the model's breakdown", () => {
    const usage = addTabUsage(emptyTabUsage(), MODEL, {
      input: 100,
      output: 10,
      cacheRead: 80,
      cacheWrite: 5,
    });
    expect(usage).toEqual({
      prompt: 15,
      completion: 10,
      total: 110,
      cacheRead: 80,
      cacheWrite: 5,
      modelBreakdown: { [MODEL]: { input: 15, output: 10, cacheRead: 80, cacheWrite: 5 } },
    });
  });

  test("a TUI tab reads as saved", () => {
    expect(readTabUsage(tuiUsage(), MODEL)).toEqual(tuiUsage() as ReturnType<typeof readTabUsage>);
  });

  test("a tab headless or the API saved before the fix loses its double-counted cache reads and keeps its cost", () => {
    const legacy = { prompt: 100, completion: 10, total: 110, cacheRead: 80 };
    expect(readTabUsage(legacy, MODEL)).toEqual({
      prompt: 20,
      completion: 10,
      total: 110,
      cacheRead: 80,
      cacheWrite: 0,
      modelBreakdown: { [MODEL]: { input: 20, output: 10, cacheRead: 80, cacheWrite: 0 } },
    });
    expect(readTabUsage({ prompt: 0, completion: 0, total: 0 }, "none").modelBreakdown).toEqual({});
  });
});

describe("headless saves token usage in the shared meaning", () => {
  test("a new run saves uncached prompt, cache writes and a model breakdown", async () => {
    const dir = workspace();
    const store = new SessionManager(dir);
    const session = newHeadlessSession();
    await saveHeadlessSession(store, session, {
      messages: [message("user", "go"), message("assistant", "done")],
      tokens: { input: 100, output: 10, cacheRead: 80, cacheWrite: 5 },
      cwd: dir,
      modelId: MODEL,
      mode: "default",
      effort: "default",
    });
    expect(savedUsage(dir, session.id)).toMatchObject({
      prompt: 15,
      total: 110,
      cacheRead: 80,
      cacheWrite: 5,
      modelBreakdown: { [MODEL]: { input: 15, output: 10, cacheRead: 80, cacheWrite: 5 } },
    });
  });

  test("a run that resumes a TUI session adds to its uncached prompt", async () => {
    const dir = workspace();
    const id = await savedSession(dir, tuiUsage());
    const store = new SessionManager(dir);
    const session = openHeadlessSession(store, id);
    if (!session) throw new Error("no session");
    await saveHeadlessSession(store, session, {
      messages: [...session.messages, message("user", "go"), message("assistant", "done")],
      tokens: { input: 100, output: 10, cacheRead: 80 },
      cwd: dir,
      modelId: MODEL,
      mode: "default",
      effort: "default",
    });
    expect(savedUsage(dir, id)).toMatchObject({
      prompt: 40,
      completion: 20,
      total: 220,
      cacheRead: 160,
      modelBreakdown: { [MODEL]: { input: 40, output: 20, cacheRead: 160, cacheWrite: 0 } },
    });
  });
});

/** A host whose every turn is one step of 100 input (80 cache reads, 5 cache writes) and 10 output. */
const usageHost: ChatAgentHost = {
  async agent() {
    return {
      contextWindow: 100_000,
      agent: {
        stream: async () => ({
          stream: (async function* () {
            yield { type: "text-delta", text: "done" };
            yield {
              type: "finish-step",
              usage: {
                inputTokens: 100,
                outputTokens: 10,
                inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 5 },
              },
            };
          })(),
          responseMessages: Promise.resolve([]),
        }),
      },
    };
  },
  release() {},
  async dispose() {},
} as unknown as ChatAgentHost;

describe("the API saves and loads token usage in the shared meaning", () => {
  test("a desktop chat that resumes a TUI session reports whole input and saves uncached prompt", async () => {
    const dir = workspace();
    const id = await savedSession(dir, tuiUsage());
    const chat = new ChatService({
      workspace: dir,
      config: { ...DEFAULT_CONFIG, defaultModel: MODEL },
      host: usageHost,
    });
    services.push(chat);
    const session = chat.get(id);
    expect(session.detail().usage).toEqual({ input: 100, output: 10, cacheRead: 80 });

    session.send("next");
    await session.settled();
    expect(session.detail().usage).toEqual({ input: 200, output: 20, cacheRead: 160 });
    expect(savedUsage(dir, id)).toMatchObject({
      prompt: 35,
      completion: 20,
      total: 220,
      cacheRead: 160,
      cacheWrite: 5,
      modelBreakdown: { [MODEL]: { input: 35, output: 20, cacheRead: 160, cacheWrite: 5 } },
    });
  });

  test("a new API session saves a model breakdown, so a TUI resume can price it", async () => {
    const dir = workspace();
    const chat = new ChatService({
      workspace: dir,
      config: { ...DEFAULT_CONFIG, defaultModel: MODEL },
      host: usageHost,
    });
    services.push(chat);
    const session = await chat.create({});
    session.send("go");
    await session.settled();
    const saved = savedUsage(dir, session.id);
    expect(saved).toMatchObject({ prompt: 15, cacheRead: 80, cacheWrite: 5, total: 110 });
    expect(readTabUsage(saved, MODEL).modelBreakdown).toEqual({
      [MODEL]: { input: 15, output: 10, cacheRead: 80, cacheWrite: 5 },
    });
  });
});
