import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invalidateHooksCache } from "../src/core/hooks/index.js";
import { notificationCommand } from "../src/core/platform/notify.js";
import {
  type AttentionChannels,
  AttentionNotifier,
  attentionMessage,
  type RunAttentionPayload,
} from "../src/core/workflows/attention-notify.js";
import type { AppConfig } from "../src/types/index.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

type Fixture = ReturnType<typeof workflowFixture>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  invalidateHooksCache();
});

/** A fixture whose service announces nothing itself, so each test's own notifier is the only one. */
function setup(): Fixture {
  const fixture = workflowFixture();
  fixture.service.attention?.dispose();
  fixtures.push(fixture);
  return fixture;
}

/** Starts a run and drives it until it waits for the plan approval. */
async function waitingRun(fixture: Fixture) {
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  return run;
}

function channels() {
  const posts: { url: string; init: RequestInit; payload: RunAttentionPayload }[] = [];
  const shown: { title: string; body: string }[] = [];
  const value: AttentionChannels = {
    async system(title, body) {
      shown.push({ title, body });
    },
    async fetch(url, init) {
      posts.push({ url, init, payload: JSON.parse(String(init.body)) as RunAttentionPayload });
      return new Response(null, { status: 204 });
    },
  };
  return { posts, shown, value };
}

const webhook: Pick<AppConfig, "notifications"> = {
  notifications: { webhook: { url: "https://hooks.example.test/baked", headers: { authorization: "Bearer t" } } },
};

describe("run attention notifications", () => {
  test("a run waiting for approval posts the webhook and shows a notification once", async () => {
    const fixture = setup();
    const sent = channels();
    const notifier = new AttentionNotifier(fixture.service.store, fixture.root, webhook, sent.value);
    notifier.systemNotifications = true;
    const run = await waitingRun(fixture);
    await notifier.flush();
    const request = fixture.service.store.requests(run.runId).find((r) => r.status === "pending");
    expect(sent.posts).toHaveLength(1);
    expect(sent.posts[0]?.url).toBe("https://hooks.example.test/baked");
    expect(sent.posts[0]?.init.headers).toEqual({ authorization: "Bearer t", "content-type": "application/json" });
    expect(sent.posts[0]?.payload).toEqual({
      event: "run.attention",
      project: expect.any(String),
      workspace: fixture.root,
      runId: run.runId,
      featureId: "fixture",
      requestId: request?.id ?? "",
      kind: "approval",
      blocking: true,
      status: "waiting",
      message: "Waiting for approval",
      createdAt: expect.any(String),
    });
    expect(sent.shown).toEqual([{ title: expect.stringContaining(": fixture"), body: "Waiting for approval" }]);

    // Checking again, from this process or another one on the same database, announces nothing new.
    await notifier.check();
    const other = channels();
    const second = new AttentionNotifier(fixture.service.store, fixture.root, webhook, other.value);
    await second.check();
    expect(sent.posts).toHaveLength(1);
    expect(other.posts).toHaveLength(0);
    notifier.dispose();
    second.dispose();
  }, 60000);

  test("nothing is sent or shown unless configured and allowed", async () => {
    const fixture = setup();
    const sent = channels();
    const notifier = new AttentionNotifier(fixture.service.store, fixture.root, {}, sent.value);
    await waitingRun(fixture);
    await notifier.flush();
    expect(sent.posts).toEqual([]);
    expect(sent.shown).toEqual([]);
    notifier.dispose();
  }, 60000);

  test("system: false turns the notification off and a non-HTTP webhook URL is refused", async () => {
    const fixture = setup();
    const sent = channels();
    const notifier = new AttentionNotifier(
      fixture.service.store,
      fixture.root,
      { notifications: { system: false, webhook: { url: "file:///etc/passwd" } } },
      sent.value,
    );
    notifier.systemNotifications = true;
    await waitingRun(fixture);
    await notifier.flush();
    expect(sent.posts).toEqual([]);
    expect(sent.shown).toEqual([]);
    notifier.dispose();
  }, 60000);

  test("a RunAttention hook matching the request kind receives the run", async () => {
    const fixture = setup();
    mkdirSync(join(fixture.root, ".claude"), { recursive: true });
    writeFileSync(
      join(fixture.root, "hook.ts"),
      'await Bun.write("hook-input.json", await new Response(Bun.stdin.stream()).text());\n',
    );
    writeFileSync(
      join(fixture.root, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          RunAttention: [
            { matcher: "clarification", hooks: [{ type: "command", command: "bun no-such-file.ts" }] },
            { matcher: "approval", hooks: [{ type: "command", command: "bun hook.ts", timeout: 30 }] },
          ],
        },
      }),
    );
    invalidateHooksCache();
    const notifier = new AttentionNotifier(fixture.service.store, fixture.root, {}, channels().value);
    const run = await waitingRun(fixture);
    await notifier.flush();
    const file = join(fixture.root, "hook-input.json");
    expect(existsSync(file)).toBe(true);
    const input = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(input.hook_event_name).toBe("RunAttention");
    expect(input.run_attention).toEqual({
      run_id: run.runId,
      feature_id: "fixture",
      request_id: expect.any(String),
      kind: "approval",
      blocking: true,
      status: "waiting",
    });
    notifier.dispose();
  }, 60000);

  test("a run blocked on its budget is announced, and again only when blocked again", async () => {
    const fixture = setup();
    const sent = channels();
    const run = await fixture.start();
    const notifier = new AttentionNotifier(fixture.service.store, fixture.root, webhook, sent.value);
    fixture.service.store.transition(run.runId, "blocked", "budget_exhausted");
    await notifier.flush();
    expect(sent.posts.map((p) => [p.payload.requestId, p.payload.kind, p.payload.message])).toEqual([
      [null, "budget_exhausted", "Blocked: needs a budget extension"],
    ]);
    await notifier.check();
    expect(sent.posts).toHaveLength(1);
    fixture.service.store.transition(run.runId, "running");
    fixture.service.store.transition(run.runId, "blocked", "budget_exhausted");
    await notifier.flush();
    expect(sent.posts).toHaveLength(2);
    notifier.dispose();
  }, 60000);

  test("a blocked run is announced with what it needs", () => {
    expect(attentionMessage({ kind: "budget_exhausted", request_id: null })).toBe("Blocked: needs a budget extension");
    expect(attentionMessage({ kind: "provider_unavailable", request_id: null })).toBe("Blocked: provider unavailable");
    expect(attentionMessage({ kind: "clarification", request_id: "r1" })).toBe("Waiting for a question");
  });

  test("the native notifier never puts the text in a script", () => {
    const command = notificationCommand('a"; rm -rf ~', "b' $(x)");
    if (!command) return;
    const joined = [command.cmd, ...command.args].join(" ");
    if (process.platform === "win32") {
      expect(joined).not.toContain("rm -rf");
      expect(command.env).toEqual({ BAKED_NOTIFY_TITLE: 'a"; rm -rf ~', BAKED_NOTIFY_BODY: "b' $(x)" });
    } else {
      expect(command.args.slice(-2)).toEqual(['a"; rm -rf ~', "b' $(x)"]);
    }
  });
});
