import { afterEach, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { startApiServer } from "../src/core/api/server.js";
import { ScriptedWorkflowExecutor } from "../src/core/workflows/scripted-executor.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { fixturePolicy } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Feature {
  id: string;
  state: string;
  runId: string | null;
  runStatus: string | null;
  runReason: string | null;
}
interface View {
  revision: number;
  status: string;
  features: Feature[];
  pendingDecisions: { requestId: string; digest: string }[];
}
interface Run {
  revision: number;
  requests: { id: string; status: string; digest: string }[];
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value ${JSON.stringify(value)}`);
    await Bun.sleep(50);
  }
}

test("approving and resuming the feature runs in the run screen continues their initiative", async () => {
  const root = mkdtempSync(join(tmpdir(), "baked-initiative-continue-"));
  execSync("git init -q && git -c user.email=t@baked.dev -c user.name=t commit -q --allow-empty -m init", { cwd: root });
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy: fixturePolicy, stall: { providerResumes: 0 } as Record<string, number> } };
  const service = new NativeWorkflowService(root, config, new ScriptedWorkflowExecutor(root, "value.txt"));
  const server = await startApiServer({ service, pollMs: 20, log: () => {} });
  cleanups.push(async () => {
    await server.stop();
    await service.shutdown();
    service.close();
    await removeTempDir(root);
  });
  const send = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${server.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json()) as T;
    if (!response.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
    return json;
  };
  const view = () => send<View>("/v1/initiatives/shop");

  await send("/v1/initiatives", { commandId: newId(), initiativeId: "shop", prompt: "Build the shop", worktree: true });
  const split = await until(view, (v) => v.status === "awaiting_approval");
  const [decision] = split.pendingDecisions;
  await send("/v1/initiatives/shop/approve", { commandId: newId(), expectedRevision: split.revision, requestId: decision?.requestId, digest: decision?.digest });

  // The first step (api, docs) waits for each run's plan approval, made as the run screen does.
  const first = await until(view, (v) => v.features.filter((f) => f.runReason === "approval").length === 2);
  for (const feature of first.features.filter((f) => f.runReason === "approval")) {
    const path = `/v1/workflow/runs/${feature.runId}`;
    const run = await send<Run>(path);
    const request = run.requests.find((r) => r.status === "pending");
    await send(`${path}/approve`, { commandId: newId(), expectedRevision: run.revision, requestId: request?.id, digest: request?.digest });
    await send(`${path}/resume`, { commandId: newId(), expectedRevision: (await send<Run>(path)).revision });
  }

  // Once both are accepted, the initiative starts the second step (ui, cli) by itself.
  const next = await until(view, (v) => ["ui", "cli"].every((id) => v.features.find((f) => f.id === id)?.runId));
  expect(next.features.filter((f) => f.state === "accepted").map((f) => f.id).sort()).toEqual(["api", "docs"]);
}, 120_000);
