import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { startApiServer } from "../src/core/api/server.js";
import {
  type ChatAgentHost,
  ChatService,
  type SessionDetail,
  type TurnAgentRequest,
  type WatchStatus,
} from "../src/core/chat/sessions.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

type Part = Record<string, unknown> & { type: string };
type Script = (turn: { request: TurnAgentRequest }) => AsyncGenerator<Part>;

const step: Part = {
  type: "finish-step",
  usage: { inputTokens: 100, outputTokens: 20, inputTokenDetails: { cacheReadTokens: 0 } },
};

class ScriptedHost implements ChatAgentHost {
  scripts: Script[] = [];
  seen: { messages: ModelMessage[]; steered: string | undefined }[] = [];
  async agent(request: TurnAgentRequest) {
    const script =
      this.scripts.shift() ??
      async function* () {
        yield { type: "text-delta", text: "ok" };
        yield step;
      };
    return {
      contextWindow: 1000,
      agent: {
        stream: async (args: { messages: ModelMessage[] }) => {
          const seen = { messages: args.messages, steered: undefined as string | undefined };
          this.seen.push(seen);
          async function* run() {
            yield* script({ request });
            seen.steered = request.drainSteering()?.text;
          }
          return { stream: run(), responseMessages: Promise.resolve([]) };
        },
      },
    };
  }
  release() {}
  async dispose() {}
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const fixture = workflowFixture();
  const host = new ScriptedHost();
  const home = mkdtempSync(join(tmpdir(), "baked-watch-home-"));
  const chat = new ChatService({
    workspace: fixture.root,
    config: {
      ...fixture.service.config,
      defaultModel: "openai/gpt-test",
      // Polling: macOS file events can miss a save made right after the watch starts. Native
      // events are covered in watch.test.ts; this file tests the API around them.
      watch: { debounceMs: 50, poll: true },
    },
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
  const post = (path: string, body: unknown = {}) =>
    call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const detail = async (id: string) => (await (await call(`/v1/sessions/${id}`)).json()) as SessionDetail;
  const watch = async (id: string) => (await (await call(`/v1/sessions/${id}/watch`)).json()) as WatchStatus;
  const create = async () => (await (await post("/v1/sessions", {})).json()) as SessionDetail;
  const write = (rel: string, text: string) => {
    const abs = join(fixture.root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text);
  };
  return { host, call, post, detail, watch, create, write };
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

test("health lists the watch capability", async () => {
  const { call } = await setup();
  const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
  expect(health.capabilities).toContain("watch");
});

test("a saved baked! comment starts a turn in the watching session; one queued meanwhile waits for its own turn", async () => {
  const { host, post, detail, watch, create, write } = await setup();
  const session = await create();
  expect(await watch(session.id)).toEqual({
    watching: false,
    watchingSession: null,
    method: null,
    turns: 0,
    last: null,
    error: null,
  });
  const on = (await (await post(`/v1/sessions/${session.id}/watch`, { on: true })).json()) as WatchStatus;
  expect(on.watching).toBe(true);
  await until(() => watch(session.id), (w) => w.method !== null);

  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.scripts.push(async function* () {
    yield { type: "text-delta", text: "Retrying" };
    yield step;
    await gate;
  });
  write("src/load.ts", "export function load() {\n  // baked! retry twice on a network error\n  return 1;\n}\n");
  const first = await until(() => detail(session.id), (d) => d.state === "working" && d.messages.length > 0);
  expect(first.messages[0]?.content).toBe("From src/load.ts:2 (baked!): retry twice on a network error");
  const prompt = JSON.stringify(host.seen[0]?.messages.at(-1));
  expect(prompt).toContain("src/load.ts");
  expect(prompt).toContain("return 1;");

  write("src/sum.py", "def total(items):  # baked? why is tax added twice\n    return 0\n");
  const queued = await until(() => detail(session.id), (d) => d.queued.length > 0);
  expect(queued.queued).toEqual(["From src/sum.py:1 (baked?): why is tax added twice"]);
  release();
  const done = await until(
    () => detail(session.id),
    (d) => d.state === "idle" && d.messages.filter((m) => m.role === "user").length === 2,
  );
  expect(host.seen[0]?.steered).toBeUndefined();
  expect(done.messages.filter((m) => m.role === "user").map((m) => [m.content, m.isSteering ?? false])).toEqual([
    ["From src/load.ts:2 (baked!): retry twice on a network error", false],
    ["From src/sum.py:1 (baked?): why is tax added twice", false],
  ]);
  const status = await watch(session.id);
  expect(status.turns).toBe(2);
  expect(status.last).toBe("src/sum.py:1 (baked?)");
});

test("watch moves between sessions, turns off, and rejects a bad body", async () => {
  const { post, watch, create } = await setup();
  const a = await create();
  const b = await create();
  await post(`/v1/sessions/${a.id}/watch`, { on: true });
  const moved = (await (await post(`/v1/sessions/${b.id}/watch`, { on: true })).json()) as WatchStatus;
  expect(moved.watching).toBe(true);
  const fromA = await watch(a.id);
  expect(fromA.watching).toBe(false);
  expect(fromA.watchingSession).toBe(b.id);
  // Turning it off from a session that does not watch changes nothing.
  expect((await (await post(`/v1/sessions/${a.id}/watch`, { on: false })).json()) as WatchStatus).toMatchObject({
    watching: false,
    watchingSession: b.id,
  });
  const off = (await (await post(`/v1/sessions/${b.id}/watch`, { on: false })).json()) as WatchStatus;
  expect(off).toMatchObject({ watching: false, watchingSession: null });
  expect((await post(`/v1/sessions/${b.id}/watch`, { on: "yes" })).status).toBe(400);
  expect((await post(`/v1/sessions/missing/watch`, { on: true })).status).toBe(404);
});
