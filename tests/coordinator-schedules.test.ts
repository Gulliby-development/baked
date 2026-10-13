import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { startApiServer } from "../src/core/api/server.js";
import {
  checkWhen,
  describeWhen,
  MAX_SCHEDULES,
  nextRun,
  parseWhen,
  SCHEDULE_TOOL,
  ScheduleStore,
  scheduleInstructions,
} from "../src/core/chat/coordinator-schedules.js";
import { type ChatAgentHost, ChatService, type TurnAgentRequest } from "../src/core/chat/sessions.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

class RecordingHost implements ChatAgentHost {
  requests: TurnAgentRequest[] = [];
  prompts: string[] = [];
  async agent(request: TurnAgentRequest) {
    this.requests.push(request);
    return {
      contextWindow: 1000,
      agent: {
        stream: async (args: { messages: ModelMessage[]; abortSignal: AbortSignal }) => {
          const last = args.messages.at(-1);
          this.prompts.push(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content));
          return {
            stream: (async function* () {
              yield { type: "text-delta", text: "done" };
              yield { type: "finish-step", usage: { inputTokens: 10, outputTokens: 1 } };
            })(),
            responseMessages: Promise.resolve([]),
          };
        },
      },
    };
  }
  release() {}
  async dispose() {}
}

type Result = { success: boolean; output: string; error?: string };
type Tool = { execute: (input: Record<string, unknown>) => Promise<Result> };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempStore(): ScheduleStore {
  const root = mkdtempSync(join(tmpdir(), "baked-schedules-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return new ScheduleStore(root, "coordinator");
}

/** Local time, as cron expressions are read. */
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("schedule times", () => {
  test("intervals, cron expressions and aliases", () => {
    const now = at(2026, 10, 10, 12, 7); // a Saturday
    expect(nextRun("every 30m", now)).toBe(now + 30 * 60_000);
    expect(nextRun("every 2h", now)).toBe(now + 2 * 3_600_000);
    expect(nextRun("0 9 * * 1-5", now)).toBe(at(2026, 10, 12, 9, 0));
    expect(nextRun("*/15 * * * *", now)).toBe(at(2026, 10, 10, 12, 15));
    expect(nextRun("@daily", now)).toBe(at(2026, 10, 11, 0, 0));
    expect(nextRun("@weekly", now)).toBe(at(2026, 10, 11, 0, 0));
    expect(nextRun("0 0 1 * *", now)).toBe(at(2026, 11, 1, 0, 0));
    // Sunday as 7 and as 0.
    expect(nextRun("30 8 * * 7", now)).toBe(at(2026, 10, 11, 8, 30));
    // Both day fields restricted: either one matching is enough, as in cron.
    expect(nextRun("0 0 13 * 1", now)).toBe(at(2026, 10, 12, 0, 0));
  });

  test("unreadable and too frequent schedules are refused", () => {
    expect(() => parseWhen("tomorrow")).toThrow("not a schedule");
    expect(() => parseWhen("61 * * * *")).toThrow("0-59");
    expect(() => checkWhen("every 1m", Date.now())).toThrow("5 minutes");
    expect(() => checkWhen("* * * * *", Date.now())).toThrow("5 minutes");
    expect(() => checkWhen("0 0 31 2 *", Date.now())).toThrow("never fires");
    expect(() => checkWhen("*/5 * * * *", Date.now())).not.toThrow();
    expect(describeWhen("every 1d")).toBe("every day");
    expect(describeWhen("every 30m")).toBe("every 30 minutes");
  });
});

describe("schedule store", () => {
  test("a missed schedule fires once and goes on from now", () => {
    const store = tempStore();
    const created = at(2026, 10, 10, 8, 0);
    const added = store.add({ name: "Morning summary", prompt: "Summarize the night", when: "every 1h" }, created);
    expect(added).toMatchObject({ id: "morning-summary", enabled: true, nextRunAt: created + 3_600_000 });
    expect(store.claimDue(created + 1000)).toEqual([]);
    // Five hours passed with nothing running: one firing, the next an hour from now.
    const later = created + 5 * 3_600_000 + 1000;
    const fired = store.claimDue(later);
    expect(fired.map((s) => s.id)).toEqual(["morning-summary"]);
    expect(store.get("morning-summary")).toMatchObject({ lastRunAt: later, nextRunAt: later + 3_600_000 });
    expect(store.claimDue(later + 1000)).toEqual([]);
  });

  test("ids stay unique; pause, resume and remove", () => {
    const store = tempStore();
    const now = at(2026, 10, 10, 8, 0);
    store.add({ name: "Check", prompt: "a", when: "every 1h" }, now);
    const second = store.add({ name: "Check", prompt: "b", when: "every 1h" }, now);
    expect(second.id).toBe("check-2");
    store.setEnabled("check", false, now);
    expect(store.claimDue(now + 2 * 3_600_000).map((s) => s.id)).toEqual(["check-2"]);
    // Resuming does not catch up on what was skipped while paused.
    const resumed = store.setEnabled("check", true, now + 3 * 3_600_000);
    expect(resumed.nextRunAt).toBe(now + 4 * 3_600_000);
    store.remove("check");
    expect(store.list().map((s) => s.id)).toEqual(["check-2"]);
    expect(() => store.remove("check")).toThrow("No schedule");
  });

  test("two hosts claim each firing once, and the count is capped", () => {
    const store = tempStore();
    const other = new ScheduleStore(join(store.path, "..", "..", "..", ".."), "coordinator");
    expect(other.path).toBe(store.path);
    const now = at(2026, 10, 10, 8, 0);
    store.add({ name: "Nightly", prompt: "Check CI", when: "every 1d" }, now);
    const later = now + 2 * 86_400_000;
    expect([...store.claimDue(later), ...other.claimDue(later)]).toHaveLength(1);
    for (let i = 1; i < MAX_SCHEDULES; i++) store.add({ name: `S${i}`, prompt: "x", when: "every 1d" }, now);
    expect(() => store.add({ name: "One more", prompt: "x", when: "every 1d" }, now)).toThrow("at most");
  });

  test("the coordinator's prompt lists the schedules", () => {
    const store = tempStore();
    expect(scheduleInstructions(store)).toContain("(no schedules)");
    store.add({ name: "Nightly", prompt: "Check CI", when: "0 2 * * *" });
    store.setEnabled("nightly", false);
    expect(scheduleInstructions(store)).toContain('nightly "Nightly" 0 2 * * * (paused): Check CI');
  });
});

describe("coordinator schedules", () => {
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
    const coordinator = await chat.coordinator(true);
    if (!coordinator) throw new Error("no coordinator");
    const api = async (method: string, path: string, body?: unknown) =>
      fetch(`${server.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    return { fixture, chat, host, coordinator, server, api };
  }

  test("a due schedule starts a coordinator turn with its prompt", async () => {
    const { chat, host, coordinator } = await setup();
    const store = new ScheduleStore(chat.workspace, coordinator.id);
    const now = Date.now();
    store.add({ name: "Nightly check", prompt: "Look at failing CI", when: "every 1h" }, now);
    expect(await chat.fireSchedules(now + 1000)).toEqual([]);
    const fired = await chat.fireSchedules(now + 3_600_000 + 1000);
    expect(fired.map((s) => s.id)).toEqual(["nightly-check"]);
    await coordinator.settled();
    expect(host.prompts.at(-1)).toContain("Look at failing CI");
    expect(host.prompts.at(-1)).toContain('Scheduled task "Nightly check" (every hour)');
    expect(coordinator.messages.find((m) => m.role === "user")?.content).toBe("Scheduled: Nightly check");
    // The turn's prompt lists the schedule and the tool is there.
    expect(host.requests.at(-1)?.tools?.[SCHEDULE_TOOL]).toBeDefined();
  }, 60000);

  test("the tool asks the person before adding a schedule", async () => {
    const { chat, host, coordinator } = await setup();
    coordinator.send("hello");
    await coordinator.settled();
    const tool = (host.requests.at(-1)?.tools ?? {})[SCHEDULE_TOOL] as Tool;
    const declined = tool.execute({ action: "add", name: "Deps", prompt: "Update deps", when: "@weekly" });
    await Bun.sleep(10);
    const prompt = coordinator.pendingPrompts[0];
    if (!prompt || prompt.kind !== "destructive") throw new Error("no confirmation prompt");
    expect(prompt.description).toContain('"Deps"');
    coordinator.answer(prompt.id, { approve: false });
    expect(await declined).toMatchObject({ success: false, error: expect.stringContaining("declined") });
    expect(new ScheduleStore(chat.workspace, coordinator.id).list()).toEqual([]);

    const approved = tool.execute({ action: "add", name: "Deps", prompt: "Update deps", when: "@weekly" });
    await Bun.sleep(10);
    const second = coordinator.pendingPrompts[0];
    if (!second) throw new Error("no confirmation prompt");
    coordinator.answer(second.id, { approve: true });
    expect((await approved).success).toBe(true);
    expect((await tool.execute({ action: "pause", id: "deps" })).output).toContain("paused");
    expect((await tool.execute({ action: "list" })).output).toContain("Update deps");
    expect((await tool.execute({ action: "add", name: "x", prompt: "y", when: "every 1m" })).error).toContain(
      "5 minutes",
    );
    expect((await tool.execute({ action: "remove", id: "deps" })).success).toBe(true);
  }, 60000);

  test("the local API lists, adds, pauses and removes schedules", async () => {
    const { api } = await setup();
    const health = (await (await api("GET", "/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("coordinator-schedules");
    const created = await api("POST", "/v1/coordinator/schedules", {
      name: "Morning",
      prompt: "Summarize",
      when: "0 9 * * 1-5",
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: "morning", enabled: true });
    const bad = await api("POST", "/v1/coordinator/schedules", { name: "x", prompt: "y", when: "soon" });
    expect(bad.status).toBe(400);
    const paused = await api("PATCH", "/v1/coordinator/schedules/morning", { enabled: false });
    expect(await paused.json()).toMatchObject({ enabled: false });
    const list = (await (await api("GET", "/v1/coordinator/schedules")).json()) as { schedules: unknown[] };
    expect(list.schedules).toHaveLength(1);
    expect((await api("DELETE", "/v1/coordinator/schedules/morning")).status).toBe(204);
    expect((await api("DELETE", "/v1/coordinator/schedules/morning")).status).toBe(404);
  }, 60000);
});
