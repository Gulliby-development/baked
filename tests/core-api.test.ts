import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApiServer, faultStatus, startApiServer } from "../src/core/api/server.js";
import { recordProjectOpen } from "../src/core/projects/known.js";
import { ProjectService } from "../src/core/projects/service.js";
import { parseServeArgs } from "../src/headless/serve.js";
import type { RunSnapshot, WorkflowEvent } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(options: { allowOrigins?: string[]; maxBodyBytes?: number; configDir?: string } = {}) {
  const fixture = workflowFixture();
  const logs: string[] = [];
  const server = await startApiServer({
    service: fixture.service,
    pollMs: 20,
    log: (line) => logs.push(line),
    ...options,
  });
  cleanups.push(async () => {
    await server.stop();
    await fixture.dispose();
  });
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${server.token}`, ...(init.headers as Record<string, string>) },
    });
  const post = (path: string, body: unknown) =>
    call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { fixture, server, call, post, logs };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value ${JSON.stringify(value)}`);
    await Bun.sleep(25);
  }
}

/** Reads SSE frames until `count` events arrived, then disconnects. */
async function readEvents(response: Response, count: number): Promise<{ id: number; event: WorkflowEvent }[]> {
  if (!response.body) throw new Error("No body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: { id: number; event: WorkflowEvent }[] = [];
  let buffer = "";
  try {
    while (events.length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const id = /^id: (\d+)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (id && data) events.push({ id: Number(id), event: JSON.parse(data) as WorkflowEvent });
        end = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel();
  }
  return events;
}

interface AttentionItem {
  source: "run" | "chat";
  runId: string | null;
  featureId: string | null;
  sessionId: string | null;
  title: string | null;
  status: string;
  requestId: string | null;
  kind: string;
  blocking: boolean;
  createdAt: number;
}

/** Collects `attention` frames from an open stream; `next` waits for one that satisfies `done`. */
function attentionFrames(response: Response) {
  if (!response.body) throw new Error("No body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(done: (items: AttentionItem[]) => boolean): Promise<AttentionItem[]> {
      for (;;) {
        let end = buffer.indexOf("\n\n");
        while (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (/^event: attention$/m.test(frame) && data) {
            const { items } = JSON.parse(data) as { items: AttentionItem[] };
            if (done(items)) return items;
          }
          end = buffer.indexOf("\n\n");
        }
        const { done: ended, value } = await reader.read();
        if (ended) throw new Error("Stream ended");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    close: () => reader.cancel(),
  };
}

const startBody = (commandId = newId()) => ({ commandId, feature: "fixture", prompt: "Create ready value" });

describe("local core API", () => {
  test("requires the bearer token, a loopback Host and an allowed Origin", async () => {
    const { server, call } = await setup({ allowOrigins: ["http://localhost:5173"] });
    expect((await fetch(`${server.url}/v1/health`)).status).toBe(401);
    const wrong = await fetch(`${server.url}/v1/health`, { headers: { Authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");

    const rebound = await call("/v1/health", { headers: { Host: `evil.example:${server.port}` } });
    expect(rebound.status).toBe(421);
    const otherPort = await call("/v1/health", { headers: { Host: `127.0.0.1:${server.port + 1}` } });
    expect(otherPort.status).toBe(421);
    const viaLocalhost = await call("/v1/health", { headers: { Host: `localhost:${server.port}` } });
    expect(viaLocalhost.status).toBe(200);

    const foreign = await call("/v1/health", { headers: { Origin: "https://evil.example" } });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    const allowed = await call("/v1/health", { headers: { Origin: "http://localhost:5173" } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const preflight = await fetch(`${server.url}/v1/health`, { method: "OPTIONS", headers: { Origin: "http://localhost:5173" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
    const foreignPreflight = await fetch(`${server.url}/v1/health`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    expect(foreignPreflight.status).toBe(403);
  });

  test("health names the version and workspace; the token file is private and removed on stop", async () => {
    const { server, call, fixture } = await setup();
    const health = (await (await call("/v1/health")).json()) as { apiVersion: number; version: string; workspace: string };
    expect(health.apiVersion).toBe(1);
    expect(typeof health.version).toBe("string");
    expect(health.workspace).toBe(fixture.root);
    expect(server.tokenFile).toBe(join(fixture.root, ".baked", `serve-${server.port}.token`));
    expect((await Bun.file(server.tokenFile).text()).trim()).toBe(server.token);
    expect(server.token.length).toBeGreaterThanOrEqual(43);
    if (process.platform !== "win32") expect(statSync(server.tokenFile).mode & 0o777).toBe(0o600);
    await server.stop();
    expect(existsSync(server.tokenFile)).toBe(false);
    expect((await fetch(`${server.url}/v1/health`).catch(() => null))?.status ?? 0).not.toBe(200);
  });

  test("a custom token file path is honored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-api-token-"));
    cleanups.push(() => removeTempDir(dir));
    const fixture = workflowFixture();
    const tokenFile = join(dir, "nested", "token");
    const server = await startApiServer({ service: fixture.service, tokenFile });
    cleanups.push(async () => {
      await server.stop();
      await fixture.dispose();
    });
    expect(server.tokenFile).toBe(tokenFile);
    expect((await Bun.file(tokenFile).text()).trim()).toBe(server.token);
  });

  test("starts a run, streams its durable events and resumes after a sequence", async () => {
    const { call, post, server } = await setup();
    expect(await (await call("/v1/workflow/runs")).json()).toEqual({ items: [] });

    const commandId = newId();
    const started = await post("/v1/workflow/runs", startBody(commandId));
    expect(started.status).toBe(202);
    const run = (await started.json()) as RunSnapshot;
    // A retry with the same command ID names the same run.
    const retry = (await (await post("/v1/workflow/runs", startBody(commandId))).json()) as RunSnapshot;
    expect(retry.runId).toBe(run.runId);

    const waiting = await until(
      async () => (await (await call(`/v1/workflow/runs/${run.runId}`)).json()) as RunSnapshot & { requests: { kind: string; status: string }[] },
      (s) => s.status === "waiting",
    );
    expect(waiting.requests.some((r) => r.kind === "approval" && r.status === "pending")).toBe(true);

    const listed = (await (await call("/v1/workflow/runs?feature=fixture&limit=5")).json()) as { items: { runId: string }[] };
    expect(listed.items.map((r) => r.runId)).toEqual([run.runId]);
    expect((await call("/v1/workflow/runs?status=bogus")).status).toBe(400);

    const all = (await (await call(`/v1/workflow/runs/${run.runId}/events`, { headers: { Accept: "application/json" } })).json()) as {
      events: WorkflowEvent[];
      lastSeq: number;
    };
    expect(all.events.length).toBeGreaterThan(3);
    expect(all.events.map((e) => e.seq)).toEqual(all.events.map((_, i) => i + 1));
    expect(all.lastSeq).toBe(all.events.at(-1)?.seq ?? -1);

    const stream = await call(`/v1/workflow/runs/${run.runId}/events?after=0`);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const streamed = await readEvents(stream, all.events.length);
    expect(streamed.map((e) => e.id)).toEqual(all.events.map((e) => e.seq));
    expect(streamed.map((e) => e.event.type)).toEqual(all.events.map((e) => e.type));

    const resumed = await readEvents(await call(`/v1/workflow/runs/${run.runId}/events?after=2`), all.events.length - 2);
    expect(resumed[0]?.id).toBe(3);
    // Last-Event-ID, sent by a reconnecting client, takes precedence over the query.
    const reconnected = await readEvents(
      await call(`/v1/workflow/runs/${run.runId}/events?after=0`, { headers: { "Last-Event-ID": "3" } }),
      1,
    );
    expect(reconnected[0]?.id).toBe(4);

    // The approval goes through the same command as the CLI; resume then drives to completion.
    const pending = (await (await call(`/v1/workflow/runs/${run.runId}`)).json()) as RunSnapshot & {
      requests: { id: string; kind: string; status: string; digest: string }[];
    };
    const request = pending.requests.find((r) => r.kind === "approval" && r.status === "pending");
    if (!request) throw new Error("No pending approval");
    const approved = await post(`/v1/workflow/runs/${run.runId}/approve`, {
      commandId: newId(),
      expectedRevision: pending.revision,
      requestId: request.id,
      digest: request.digest,
    });
    expect(approved.status).toBe(200);
    const afterApproval = (await approved.json()) as RunSnapshot;
    const stale = await post(`/v1/workflow/runs/${run.runId}/pause`, { commandId: newId(), expectedRevision: pending.revision });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("REVISION_CONFLICT");

    const live = call(`/v1/workflow/runs/${run.runId}/events?after=${all.lastSeq}`);
    const resume = await post(`/v1/workflow/runs/${run.runId}/resume`, {
      commandId: newId(),
      expectedRevision: afterApproval.revision,
    });
    expect(resume.status).toBe(200);
    const fresh = await readEvents(await live, 1);
    expect(fresh[0]?.id).toBe(all.lastSeq + 1);
    const done = await until(
      async () => (await (await call(`/v1/workflow/runs/${run.runId}`)).json()) as RunSnapshot,
      (s) => ["completed", "failed", "blocked"].includes(s.status),
      30000,
    );
    expect(done.status).toBe("completed");

    const usage = await call(`/v1/workflow/runs/${run.runId}/usage`);
    expect(usage.status).toBe(200);
    const artifacts = (await (await call(`/v1/workflow/runs/${run.runId}/artifacts`)).json()) as { id: string; path: string }[];
    expect(artifacts.length).toBeGreaterThan(0);
    const first = artifacts[0];
    if (!first) throw new Error("No artifact");
    const content = (await (await call(`/v1/workflow/runs/${run.runId}/artifacts?file=${first.id}`)).json()) as { content: string };
    expect(typeof content.content).toBe("string");
    expect(server.port).toBeGreaterThan(0);
  }, 60000);

  test("attention lists a run waiting for approval until it is approved", async () => {
    const { server, call, post } = await setup();
    expect((await fetch(`${server.url}/v1/attention`)).status).toBe(401);
    expect((await fetch(`${server.url}/v1/attention`, { headers: { Accept: "application/json" } })).status).toBe(401);
    expect((await call("/v1/attention", { method: "POST" })).status).toBe(405);

    const stream = await call("/v1/attention");
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const frames = attentionFrames(stream);
    try {
      // The list is sent once on connect, even when nothing waits.
      expect(await frames.next(() => true)).toEqual([]);
      const run = (await (await post("/v1/workflow/runs", startBody())).json()) as RunSnapshot;
      const streamed = await frames.next((items) => items.length > 0);
      const pending = (await (await call(`/v1/workflow/runs/${run.runId}`)).json()) as RunSnapshot & { requests: { id: string; kind: string; status: string; digest: string }[] };
      const request = pending.requests.find((r) => r.kind === "approval" && r.status === "pending");
      if (!request) throw new Error("No pending approval");
      expect(streamed).toEqual([
        {
          source: "run",
          sessionId: null,
          title: null,
          runId: run.runId,
          featureId: "fixture",
          status: "waiting",
          requestId: request.id,
          kind: "approval",
          blocking: true,
          createdAt: expect.any(Number),
        },
      ]);
      const listed = (await (await call("/v1/attention", { headers: { Accept: "application/json" } })).json()) as {
        items: AttentionItem[];
      };
      expect(listed.items).toEqual(streamed);

      const approved = await post(`/v1/workflow/runs/${run.runId}/approve`, {
        commandId: newId(),
        expectedRevision: pending.revision,
        requestId: request.id,
        digest: request.digest,
      });
      expect(approved.status).toBe(200);
      expect(await frames.next((items) => items.length === 0)).toEqual([]);
      expect(await (await call("/v1/attention", { headers: { Accept: "application/json" } })).json()).toEqual({ items: [] });
    } finally {
      await frames.close();
    }
  }, 60000);

  test("attention lists blocked runs and advisory acceptance requests as not blocking", async () => {
    const { call, post, fixture } = await setup();
    const run = (await (await post("/v1/workflow/runs", startBody())).json()) as RunSnapshot;
    const json = async () =>
      ((await (await call("/v1/attention", { headers: { Accept: "application/json" } })).json()) as { items: AttentionItem[] }).items;
    await until(json, (items) => items.length === 1);
    const store = fixture.service.store;
    const approval = store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No pending approval");
    store.transaction(() => {
      store.decideRequest(run.runId, approval.id, "rejected", { kind: "reject" });
      store.request(run.runId, "approval", "b".repeat(64), { acceptance: { gateId: "walkthrough" } });
      store.transition(run.runId, "blocked", "input_changed");
    });
    // Both are dated to about the same moment; their order is not what this test is about.
    const items = (await json()).sort((a, b) => a.kind.localeCompare(b.kind));
    expect(items.map(({ status, requestId, kind, blocking }) => ({ status, requestId: requestId !== null, kind, blocking }))).toEqual([
      { status: "blocked", requestId: true, kind: "approval", blocking: false },
      { status: "blocked", requestId: false, kind: "input_changed", blocking: true },
    ]);
    expect(items.every((item) => item.runId === run.runId && item.featureId === "fixture")).toBe(true);
  }, 60000);

  test("lists definitions and profiles", async () => {
    const { call } = await setup();
    const definitions = await call("/v1/workflow/definitions");
    expect(definitions.status).toBe(200);
    expect(JSON.stringify(await definitions.json())).toContain("sdd");
    const profiles = await call("/v1/workflow/profiles");
    expect(profiles.status).toBe(200);
    expect(Array.isArray(await profiles.json())).toBe(true);
  });

  test("runs the doctor and the pre-run estimate", async () => {
    const { call, post } = await setup();
    const doctor = await call("/v1/workflow/doctor?workflow=standard");
    expect(doctor.status).toBe(200);
    const report = (await doctor.json()) as { workflowId: string; checks: { id: string; status: string }[] };
    expect(report.workflowId).toBe("standard");
    expect(report.checks.find((c) => c.id === "start")?.status).toBe("ok");

    const estimate = await call(
      `/v1/workflow/estimate?workflow=standard&route=${encodeURIComponent("research=anthropic/claude-haiku-4-5")}`,
    );
    expect(estimate.status).toBe(200);
    const body = (await estimate.json()) as { stages: { stageId: string; models: string[] }[] };
    expect(body.stages.find((s) => s.stageId === "research")?.models).toEqual(["anthropic/claude-haiku-4-5"]);

    expect((await call("/v1/workflow/estimate?workflow=missing")).status).toBe(404);
    expect((await call("/v1/workflow/estimate?policy=x")).status).toBe(400);
    expect((await call("/v1/workflow/doctor?writers=2")).status).toBe(400);
    expect((await post("/v1/workflow/doctor", {})).status).toBe(405);
  });

  test("maps faults and request problems to HTTP statuses", async () => {
    const { call, post } = await setup({ maxBodyBytes: 1024 });
    const unknown = await call("/v1/workflow/runs/no-such-run");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: { code: "NOT_FOUND", message: "Unknown run no-such-run" } });
    expect((await call("/v1/workflow/runs/no-such-run/events")).status).toBe(404);
    expect((await call("/v1/nothing")).status).toBe(404);
    expect((await call("/v1/health", { method: "POST" })).status).toBe(405);

    const large = await post("/v1/workflow/runs", { ...startBody(), prompt: "x".repeat(4096) });
    expect(large.status).toBe(413);
    expect(((await large.json()) as { error: { code: string } }).error.code).toBe("PAYLOAD_TOO_LARGE");

    const invalid = await post("/v1/workflow/runs", { feature: "fixture" });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe("INVALID_REQUEST");
    const extra = await post("/v1/workflow/runs", { ...startBody(), unknown: true });
    expect(extra.status).toBe(400);
    const clarification = await post("/v1/workflow/runs", { ...startBody(), clarification: "maybe" });
    expect(clarification.status).toBe(400);
    const writers = await post("/v1/workflow/runs", { ...startBody(), writers: 2 });
    expect(((await writers.json()) as { error: { code: string } }).error.code).toBe("INVALID_DEFINITION");
    const malformed = await call("/v1/workflow/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    expect(malformed.status).toBe(400);
    const text = await call("/v1/workflow/runs", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    expect(text.status).toBe(415);
    const missing = await post("/v1/workflow/runs/no-such-run/cancel", { commandId: newId(), expectedRevision: 0 });
    expect(missing.status).toBe(404);

    expect(faultStatus("CAPABILITY_DENIED")).toBe(403);
    expect(faultStatus("INVALID_DEFINITION")).toBe(400);
    expect(faultStatus("STALE_DECISION")).toBe(409);
    expect(faultStatus("STORAGE_CORRUPT")).toBe(500);
  });

  test("workflows that are not enabled are refused with 403", async () => {
    const fixture = workflowFixture();
    fixture.config.workflows = { ...fixture.config.workflows, enabled: false };
    const server = await startApiServer({ service: fixture.service });
    cleanups.push(async () => {
      await server.stop();
      await fixture.dispose();
    });
    const response = await fetch(`${server.url}/v1/workflow/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(startBody()),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("CAPABILITY_DENIED");
  });

  test("stopping the server ends open event streams", async () => {
    const { fixture, server, call } = await setup();
    const run = await fixture.start();
    const response = await call(`/v1/workflow/runs/${run.runId}/events`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No body");
    await reader.read();
    await server.stop();
    const ended = await Promise.race([
      (async () => {
        for (;;) if ((await reader.read()).done) return true;
      })().catch(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    expect(ended).toBe(true);
  });
});

describe("baked serve arguments", () => {
  test("parses port, token file and repeatable origins", () => {
    expect(parseServeArgs([])).toEqual({ port: 0, allowOrigins: [] });
    expect(
      parseServeArgs(["--port", "8123", "--token-file", "t", "--allow-origin", "http://a.test", "--allow-origin", "http://b.test", "--cwd", "x"]),
    ).toEqual({ port: 8123, tokenFile: "t", allowOrigins: ["http://a.test", "http://b.test"] });
    expect(parseServeArgs(["--help"])).toBe("help");
    expect(() => parseServeArgs(["--port", "70000"])).toThrow("--port");
    expect(() => parseServeArgs(["--port"])).toThrow("needs a value");
    expect(() => parseServeArgs(["--bogus"])).toThrow("Unknown option");
  });

  test("wildcard and malformed origins are refused at start", async () => {
    const fixture = workflowFixture();
    cleanups.push(() => fixture.dispose());
    await expect(startApiServer({ service: fixture.service, allowOrigins: ["*"] })).rejects.toThrow("Invalid origin");
    await expect(startApiServer({ service: fixture.service, allowOrigins: ["http://a.test/path"] })).rejects.toThrow("Invalid origin");
  });
});

describe("project endpoints", () => {
  test("report the workspace's project and change its working set", async () => {
    const profile = mkdtempSync(join(tmpdir(), "baked-api-profile-"));
    cleanups.push(async () => removeTempDir(profile));
    const { fixture, call, post } = await setup({ configDir: profile });
    expect((await call("/v1/projects/current")).status).toBe(404);
    expect((await post("/v1/projects/current/working-set", { add: ["a.ts"] })).status).toBe(404);

    new ProjectService(fixture.root, { configDir: profile }).init({ id: "demo" });
    writeFileSync(join(fixture.root, "notes.md"), "notes\n");
    const current = (await (await call("/v1/projects/current")).json()) as { id: string; workingSet: { entries: string[] } };
    expect(current).toMatchObject({ id: "demo", workingSet: { entries: [] } });

    const added = (await (await post("/v1/projects/current/working-set", { add: ["notes.md"] })).json()) as {
      workingSet: { entries: string[]; files: { path: string }[] };
    };
    expect(added.workingSet.entries).toEqual(["notes.md"]);
    expect(added.workingSet.files.map((f) => f.path)).toContain("notes.md");

    const outside = await post("/v1/projects/current/working-set", { add: ["../elsewhere.md"] });
    expect(outside.status).toBe(400);
    expect(((await outside.json()) as { error: { message: string } }).error.message).toContain("outside the project roots");
    expect((await post("/v1/projects/current/working-set", {})).status).toBe(400);
    expect((await call("/v1/projects/current/working-set")).status).toBe(405);

    const removed = (await (await post("/v1/projects/current/working-set", { remove: ["notes.md"] })).json()) as {
      workingSet: { entries: string[] };
    };
    expect(removed.workingSet.entries).toEqual([]);
  });

  test("list every known folder with its overview and mark the served one", async () => {
    const profile = mkdtempSync(join(tmpdir(), "baked-api-profile-"));
    const other = mkdtempSync(join(tmpdir(), "baked-api-other-"));
    cleanups.push(async () => removeTempDir(profile));
    cleanups.push(async () => removeTempDir(other));
    const { fixture, call } = await setup({ configDir: profile });
    expect(await (await call("/v1/projects")).json()).toEqual({ projects: [] });
    recordProjectOpen(other, { configDir: profile, now: 1 });
    recordProjectOpen(fixture.root, { configDir: profile, now: 2 });
    const body = (await (await call("/v1/projects")).json()) as {
      projects: { name: string; current: boolean; projectId: string | null; overview: { sessions: number } }[];
    };
    expect(body.projects.map((p) => p.current)).toEqual([true, false]);
    expect(body.projects[0]).toMatchObject({ projectId: null, overview: { sessions: 0, activeRuns: 0, attention: 0 } });
    expect((await call("/v1/projects", { method: "POST" })).status).toBe(405);
  });
});
