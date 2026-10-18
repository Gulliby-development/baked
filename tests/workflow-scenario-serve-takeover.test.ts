import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Backend } from "../apps/desktop/src/main/backend.js";
import { startApiServer } from "../src/core/api/server.js";
import { IS_WIN, killTree } from "../src/core/platform/index.js";
import { ScriptedWorkflowExecutor } from "../src/core/workflows/scripted-executor.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { parseServeArgs } from "../src/headless/serve.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

class ScriptedFixture extends FixtureExecutor {
  private readonly scripted: ScriptedWorkflowExecutor;
  constructor(root: string) {
    super(root);
    this.scripted = new ScriptedWorkflowExecutor(root, "value.txt");
  }
  override async execute(request: ExecutionRequest) {
    const response = await this.scripted.execute(request);
    return { ...response, inputTokens: response.inputTokens ?? 0, outputTokens: response.outputTokens ?? 0 };
  }
}

// #1541, the desktop side of #1533: `baked serve` drives runs on its main thread. When that thread
// stops inside a tool call, the run stays "running" and the API stops answering. The desktop app
// stops that server and starts a new one with `--take-over PID`, which takes the run over and
// drives it to the end.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DRIVER = join(import.meta.dir, "helpers", "supervised-driver.ts");

async function until(done: () => boolean, ms = 30_000, diagnostics = () => ""): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out ${diagnostics()}`);
    await Bun.sleep(25);
  }
}

describe("scenario: a baked serve whose thread stopped inside multi_edit (#1541)", () => {
  test("the desktop watcher restarts a real scripted server after tool.started and the run completes", async () => {
    const fixture = workflowFixture({ executor: (root) => new ScriptedFixture(root) });
    cleanups.push(fixture.dispose);
    fixture.config.workflows.stall.supervisorGraceMs = 1_000;
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const children: { pid: number | undefined; args: string[] }[] = [];
    const backend = new Backend({
      folder: fixture.root,
      command: { command: process.execPath, prefix: [join(import.meta.dir, "helpers", "scripted-stalled-serve.ts")] },
      tokenFile: join(fixture.root, ".baked", "serve.token"),
      stallPollMs: 100,
      restartDelaysMs: [20],
      spawn: (command, args, options) => {
        const child = spawn(command, args, {
          ...options,
          env: { ...options.env, SUPERVISED_CONFIG: JSON.stringify(fixture.config) },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        children.push({ pid: child.pid, args });
        return child;
      },
    });
    cleanups.push(() => backend.stop());
    const endpoint = await backend.start();
    const response = await fetch(`${endpoint.url}/v1/workflow/runs/${run.runId}/resume`, {
      method: "POST",
      headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "scripted-resume", expectedRevision: fixture.service.store.run(run.runId).revision }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.ok).toBe(true);
    const store = fixture.service.store;
    const diagnostics = () => JSON.stringify({ children, status: store.run(run.runId).status, reason: store.run(run.runId).reason, events: store.events(run.runId, 0, 100_000).slice(-8), backend: backend.state });
    await until(() => store.events(run.runId, 0, 100_000).some((event) => event.type === "tool.started"), 15_000, diagnostics);
    await until(() => store.run(run.runId).status === "completed", 45_000, diagnostics);
    expect(children).toHaveLength(2);
    expect(children[1]?.args.slice(-2)).toEqual(["--take-over", String(children[0]?.pid)]);
    const artifact = store.latestArtifact(run.runId, "stalled/takeover-1.json");
    expect(artifact).not.toBeNull();
    expect(JSON.parse(store.readArtifact(run.runId, artifact!.id))).toMatchObject({ pid: children[0]?.pid, resumed: true });
    expect(store.state(run.runId).stallResumes).toBe(1);
    expect(store.effects(run.runId).some((effect) => effect.status === "prepared")).toBe(false);
    expect(readFileSync(join(fixture.root, "value.txt"), "utf8")).toBe("ready");
  }, 90_000);

  test("a server started with --take-over takes the run over and drives it to completion", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const store = fixture.service.store;
    const revision = store.run(run.runId).revision;
    // The stopped server: it drives the run in its own process and spins inside multi_edit.
    const hung = spawn(process.execPath, [DRIVER], {
      cwd: fixture.root,
      env: {
        ...process.env,
        SUPERVISED_ROOT: fixture.root,
        SUPERVISED_CONFIG: JSON.stringify(fixture.config),
        SUPERVISED_ARGS: JSON.stringify(["resume", run.runId, "--expected-revision", String(revision)]),
        SUPERVISED_MODE: "hang",
      },
      stdio: ["ignore", "ignore", "inherit"],
      detached: !IS_WIN,
    });
    let stopped = false;
    const exited = new Promise<void>((resolve) => hung.once("exit", () => { stopped = true; resolve(); }));
    cleanups.push(async () => {
      if (stopped) return;
      if (hung.pid !== undefined) killTree(hung.pid, "SIGKILL");
      hung.kill("SIGKILL");
      await exited;
    });
    await until(() => store.events(run.runId, 0, 100_000).some((e) => e.type === "tool.started"));
    const pid = hung.pid ?? 0;
    // What the desktop app does to a server that stopped answering.
    killTree(pid, "SIGKILL");
    if (IS_WIN) hung.kill("SIGKILL");
    await exited;
    expect(store.run(run.runId).status).toBe("running");

    const lines: string[] = [];
    const args = parseServeArgs(["--take-over", String(pid)]);
    if (args === "help" || args.takeOver === undefined) throw new Error("--take-over is not parsed");
    const server = await startApiServer({ service: fixture.service, pollMs: 20, log: (line) => lines.push(line), takeOver: { pid: args.takeOver } });
    cleanups.push(() => server.stop());
    await until(() => store.run(run.runId).status === "completed");
    expect(lines.map((line) => JSON.parse(line))).toContainEqual({ event: "takeover", runId: run.runId, pid, resumed: true });
    expect(store.latestArtifact(run.runId, "stalled/takeover-1.json")).not.toBeNull();
    expect(store.state(run.runId).stallResumes).toBe(1);
    expect(store.effects(run.runId).some((e) => e.status === "prepared")).toBe(false);
    // The health answer tells the desktop app how long to wait before it restarts the server.
    const health = (await (await fetch(`${server.url}/v1/health`, { headers: { Authorization: `Bearer ${server.token}` } })).json()) as { supervisorGraceMs: number };
    expect(health.supervisorGraceMs).toBe(120_000);
  }, 90_000);

  test("--take-over of a process that still runs takes nothing over", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const lines: string[] = [];
    const server = await startApiServer({ service: fixture.service, pollMs: 20, log: (line) => lines.push(line), takeOver: { pid: process.pid } });
    cleanups.push(() => server.stop());
    await Bun.sleep(200);
    expect(lines).toEqual([]);
    expect(fixture.service.store.latestArtifact(run.runId, "stalled/takeover-1.json")).toBeNull();
  });
});
