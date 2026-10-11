import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { startApiServer } from "../src/core/api/server.js";
import { type ChatAgentHost, ChatService, type TurnAgentRequest } from "../src/core/chat/sessions.js";
import { errorLogStore, logBackgroundError } from "../src/core/diagnostics/errors.js";
import { type ModelEventsView, modelEventsStore, recordModelCall } from "../src/core/diagnostics/model-events.js";
import { clearPlans, computeStorageSizes, storageDirs, vacuumDatabases } from "../src/core/diagnostics/storage.js";
import { useErrorStore } from "../src/stores/errors.js";
import { useModelEventsStore } from "../src/stores/model-events.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

type Part = Record<string, unknown> & { type: string };
type Script = (signal: AbortSignal) => AsyncGenerator<Part>;

/** Plays one scripted stream per turn instead of calling a model. */
class ScriptedHost implements ChatAgentHost {
  scripts: Script[] = [];
  async agent(_request: TurnAgentRequest) {
    const script = this.scripts.shift() ?? reply;
    return {
      contextWindow: 1000,
      agent: {
        stream: async (args: { messages: ModelMessage[]; abortSignal: AbortSignal }) => ({
          stream: script(args.abortSignal),
          responseMessages: Promise.resolve([]),
        }),
      },
    };
  }
  release() {}
  async dispose() {}
}

async function* reply(): AsyncGenerator<Part> {
  yield { type: "text-delta", text: "ok" };
  yield { type: "finish-step", usage: { inputTokens: 120, outputTokens: 30, inputTokenDetails: { cacheReadTokens: 40 } } };
}

async function* hold(signal: AbortSignal): AsyncGenerator<Part> {
  await new Promise((_, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  modelEventsStore.getState().setEnabled(false);
  errorLogStore.getState().clear();
});

async function setup() {
  const fixture = workflowFixture();
  const host = new ScriptedHost();
  const configDir = mkdtempSync(join(tmpdir(), "baked-diag-config-"));
  const homeDir = mkdtempSync(join(tmpdir(), "baked-diag-home-"));
  const chat = new ChatService({
    workspace: fixture.root,
    config: { ...fixture.service.config, defaultModel: "openai/gpt-test" },
    host,
    homeDir,
  });
  const server = await startApiServer({ service: fixture.service, chat, pollMs: 20, configDir, homeDir, log: () => {} });
  cleanups.push(async () => {
    await server.stop();
    await fixture.dispose();
    await removeTempDir(configDir);
    await removeTempDir(homeDir);
  });
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${server.url}${path}`, { ...init, headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" } });
  const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });
  return { fixture, host, configDir, call, post };
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

interface StorageView {
  projectDir: string;
  globalDir: string;
  project: { totalBytes: number; sessionCount: number; sessionsBytes: number; plansBytes: number; repoMapBytes: number };
  global: { historyBytes: number };
}

function makeHistory(dir: string): void {
  const db = new Database(join(dir, "history.db"));
  db.run("CREATE TABLE history (id INTEGER PRIMARY KEY, text TEXT)");
  const insert = db.prepare("INSERT INTO history (text) VALUES (?)");
  for (let i = 0; i < 200; i++) insert.run(`prompt ${String(i)} ${"x".repeat(200)}`);
  db.close();
}

describe("storage helpers", () => {
  test("measure, clear plans and vacuum in the given directories", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "baked-storage-ws-"));
    const globalDir = mkdtempSync(join(tmpdir(), "baked-storage-global-"));
    cleanups.push(async () => {
      await removeTempDir(workspace);
      await removeTempDir(globalDir);
    });
    const dirs = storageDirs(workspace, globalDir);
    mkdirSync(join(dirs.projectDir, "plans"), { recursive: true });
    writeFileSync(join(dirs.projectDir, "plans", "a.md"), "plan ".repeat(100));
    mkdirSync(join(dirs.projectDir, "sessions", "s1"), { recursive: true });
    writeFileSync(join(dirs.projectDir, "sessions", "s1", "meta.json"), "{}");
    makeHistory(globalDir);
    const sizes = computeStorageSizes(dirs);
    expect(sizes.plans).toBe(500);
    expect(sizes.sessionCount).toBe(1);
    expect(sizes.history).toBeGreaterThan(0);
    expect(sizes.projectTotal).toBe(sizes.plans + sizes.sessions + sizes.repoMap + sizes.projectMemory + sizes.projectConfig);
    expect(clearPlans(dirs)).toBe(500);
    expect(existsSync(join(dirs.projectDir, "plans"))).toBe(false);
    expect(clearPlans(dirs)).toBe(0);
    expect(vacuumDatabases(dirs)).toBeGreaterThanOrEqual(0);
  });
});

describe("diagnostics over the local API", () => {
  test("reports storage and cleans up only with an explicit confirmation", async () => {
    const { fixture, configDir, call, post } = await setup();
    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("diagnostics");

    mkdirSync(join(fixture.root, ".baked", "plans"), { recursive: true });
    writeFileSync(join(fixture.root, ".baked", "plans", "p.md"), "x".repeat(300));
    makeHistory(configDir);
    expect((await post("/v1/sessions", { title: "One" })).status).toBe(201);

    const view = (await (await call("/v1/diagnostics/storage")).json()) as StorageView;
    expect(view.globalDir).toBe(configDir);
    expect(view.project.plansBytes).toBe(300);
    expect(view.project.sessionCount).toBe(1);
    expect(view.global.historyBytes).toBeGreaterThan(0);

    const unconfirmed = await post("/v1/diagnostics/storage/cleanup", { target: "plans" });
    expect(unconfirmed.status).toBe(400);
    expect(existsSync(join(fixture.root, ".baked", "plans", "p.md"))).toBe(true);
    expect((await post("/v1/diagnostics/storage/cleanup", { target: "everything", confirm: true })).status).toBe(400);
    expect((await post("/v1/diagnostics/storage/cleanup", { target: "plans", confirm: "yes" })).status).toBe(400);
    expect((await call("/v1/diagnostics/storage", { method: "DELETE" })).status).toBe(405);

    const plans = (await (await post("/v1/diagnostics/storage/cleanup", { target: "plans", confirm: true })).json()) as {
      freedBytes: number;
      storage: StorageView;
    };
    expect(plans.freedBytes).toBe(300);
    expect(plans.storage.project.plansBytes).toBe(0);

    const sessions = (await (await post("/v1/diagnostics/storage/cleanup", { target: "sessions", confirm: true })).json()) as {
      removed: number;
      storage: StorageView;
    };
    expect(sessions.removed).toBe(1);
    expect(sessions.storage.project.sessionCount).toBe(0);
    expect(((await (await call("/v1/sessions")).json()) as { sessions: unknown[] }).sessions).toEqual([]);

    const history = (await (await post("/v1/diagnostics/storage/cleanup", { target: "history", confirm: true })).json()) as {
      freedBytes: number;
    };
    expect(history.freedBytes).toBeGreaterThan(0);
    const db = new Database(join(configDir, "history.db"));
    expect((db.query("SELECT COUNT(*) AS n FROM history").get() as { n: number }).n).toBe(0);
    db.close();

    // Vacuum keeps all data, so it needs no confirmation.
    expect((await post("/v1/diagnostics/storage/cleanup", { target: "vacuum" })).status).toBe(200);
    // Nothing to clear is not an error.
    const empty = (await (await post("/v1/diagnostics/storage/cleanup", { target: "repo-map", confirm: true })).json()) as {
      freedBytes: number;
    };
    expect(empty.freedBytes).toBe(0);
  });

  test("refuses to clear sessions while a chat turn runs", async () => {
    const { host, call, post } = await setup();
    const session = (await (await post("/v1/sessions", {})).json()) as { id: string };
    host.scripts.push(hold);
    await post(`/v1/sessions/${session.id}/messages`, { text: "Hold" });
    await until(
      async () => (await (await call(`/v1/sessions/${session.id}`)).json()) as { state: string },
      (d) => d.state === "working",
    );
    const busy = await post("/v1/diagnostics/storage/cleanup", { target: "sessions", confirm: true });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe("SESSION_BUSY");
    await post(`/v1/sessions/${session.id}/interrupt`, {});
  });

  test("lists the background error log newest first", async () => {
    const { call } = await setup();
    logBackgroundError("hooks", "first failure");
    logBackgroundError("lsp", "second failure");
    const { errors } = (await (await call("/v1/diagnostics/errors")).json()) as {
      errors: { source: string; message: string; timestamp: number; id: string }[];
    };
    expect(errors.map((e) => e.source)).toEqual(["lsp", "hooks"]);
    // The terminal UI's store reads the same log.
    expect(useErrorStore.getState().errors).toHaveLength(2);
    expect((await call("/v1/diagnostics/errors", { method: "POST" })).status).toBe(405);
  });

  test("records model events of API chats once enabled, then clears and disables them", async () => {
    const { call, post } = await setup();
    const off = (await (await call("/v1/diagnostics/model-events")).json()) as ModelEventsView;
    expect(off).toEqual({ enabled: false, events: [], models: [] });
    recordModelCall({ modelId: "x/y", source: "main", startedAt: 1, durationMs: 1, state: "ok" });
    expect(modelEventsStore.getState().events).toEqual([]);

    const on = (await (await post("/v1/diagnostics/model-events", { action: "enable" })).json()) as ModelEventsView;
    expect(on.enabled).toBe(true);
    expect(useModelEventsStore.getState().enabled).toBe(true);
    const session = (await (await post("/v1/sessions", {})).json()) as { id: string };
    await post(`/v1/sessions/${session.id}/messages`, { text: "Hello" });
    const seen = await until(
      async () => (await (await call("/v1/diagnostics/model-events")).json()) as ModelEventsView,
      (v) => v.events.length > 0,
    );
    expect(seen.events[0]).toMatchObject({
      modelId: "openai/gpt-test",
      source: "main",
      state: "ok",
      sessionId: session.id,
      input: 120,
      output: 30,
      cacheRead: 40,
    });
    expect(seen.models[0]).toMatchObject({ modelId: "openai/gpt-test", calls: 1, errors: 0 });

    const cleared = (await (await post("/v1/diagnostics/model-events", { action: "clear" })).json()) as ModelEventsView;
    expect(cleared).toMatchObject({ enabled: true, events: [] });
    expect((await post("/v1/diagnostics/model-events", { action: "reset" })).status).toBe(400);
    const disabled = (await (await post("/v1/diagnostics/model-events", { action: "disable" })).json()) as ModelEventsView;
    expect(disabled.enabled).toBe(false);
    expect((await call("/v1/diagnostics/nothing")).status).toBe(404);
  });
});
