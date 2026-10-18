import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import { IS_WIN, killTree } from "../src/core/platform/index.js";
import { parseServeArgs } from "../src/headless/serve.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

// #1541, the desktop side of #1533: `baked serve` drives runs on its main thread. When that thread
// stops inside a tool call, the run stays "running" and the API stops answering. The desktop app
// stops that server and starts a new one with `--take-over PID`, which takes the run over and
// drives it to the end.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DRIVER = join(import.meta.dir, "helpers", "supervised-driver.ts");

async function until(done: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await Bun.sleep(25);
  }
}

describe("scenario: a baked serve whose thread stopped inside multi_edit (#1541)", () => {
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
    const exited = new Promise<void>((resolve) => hung.once("exit", () => resolve()));
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
