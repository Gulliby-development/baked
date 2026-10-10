import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Backend } from "../src/main/backend.ts";
import { projectKey } from "../src/main/project-key.ts";
import { checkApiPath, ProjectSupervisor } from "../src/main/supervisor.ts";
import type { BackendState, KnownProject, StreamEvent } from "../src/shared/api.ts";

const fake = join(import.meta.dir, "fixtures", "fake-serve.ts");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function folder(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-desktop-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, name);
  mkdirSync(path);
  return path;
}

function known(path: string): KnownProject {
  return {
    path,
    name: path.split(/[\\/]/).pop() ?? path,
    projectId: null,
    pinned: false,
    addedAt: 0,
    lastOpenedAt: 0,
    exists: true,
    overview: { sessions: 0, lastSessionAt: null, activeRuns: 0, attention: 0 },
  };
}

function supervisor(paths: string[], states: BackendState[] = []) {
  const sup = new ProjectSupervisor({
    listProjects: async () => paths.map(known),
    createBackend: (project, key, onState) =>
      new Backend({
        folder: project.path,
        command: { command: process.execPath, prefix: [fake] },
        tokenFile: join(project.path, `${key}.token`),
        restartDelaysMs: [20, 20],
        readyTimeoutMs: 3000,
        stopGraceMs: 1000,
        onState: (state) => {
          states.push(state);
          onState(state);
        },
      }),
    reconnectDelayMs: 20,
  });
  cleanups.push(() => sup.stopAll());
  return sup;
}

describe("checkApiPath", () => {
  test("allows only versioned API paths with GET or POST", () => {
    expect(() => checkApiPath("GET", "/v1/workflow/runs?limit=5")).not.toThrow();
    expect(() => checkApiPath("DELETE", "/v1/health")).toThrow();
    expect(() => checkApiPath("GET", "/v2/health")).toThrow();
    expect(() => checkApiPath("GET", "/v1/../secret")).toThrow();
    expect(() => checkApiPath("GET", "http://evil/v1/health")).toThrow();
  });
});

describe("ProjectSupervisor", () => {
  test("opens a project, proxies requests with the token and closes it", async () => {
    const path = folder("alpha");
    const sup = supervisor([path]);
    await sup.refresh();
    const key = projectKey(path);
    await sup.open(key);
    expect(sup.projects()[0]?.backend).toEqual({ kind: "running", version: "9.9.9" });
    expect(await sup.request(key, "GET", "/v1/health")).toEqual({
      status: 200,
      body: { apiVersion: 1, version: "9.9.9", workspace: path },
    });
    expect((await sup.request(key, "POST", "/v1/echo", { a: 1 })).body).toEqual({ body: { a: 1 } });
    expect((await sup.request(key, "GET", "/v1/missing")).status).toBe(404);
    await sup.close(key);
    expect(sup.projects()[0]?.open).toBe(false);
    await expect(sup.request(key, "GET", "/v1/health")).rejects.toThrow("not open");
  });

  test("restarts a backend that exits and resumes the stream after the last event", async () => {
    const path = folder("beta");
    const states: BackendState[] = [];
    const sup = supervisor([path], states);
    await sup.refresh();
    const key = projectKey(path);
    await sup.open(key);
    const events: StreamEvent[] = [];
    const stream = sup.stream(key, "/v1/events", (e) => events.push(e));
    cleanups.push(() => stream.close());
    while (events.length < 4) await Bun.sleep(10);
    // Each reconnect asks for events after the last one it saw.
    expect(events.slice(0, 4).map((e) => e.data)).toEqual(["1", "2", "3", "4"]);
    await sup.request(key, "GET", "/v1/exit");
    while (!states.some((s) => s.kind === "restarting")) await Bun.sleep(10);
    while (sup.projects()[0]?.backend.kind !== "running") await Bun.sleep(10);
    expect((await sup.request(key, "GET", "/v1/health")).status).toBe(200);
  });

  test("gives up after the restart budget and keeps the error output", async () => {
    const path = folder("crash");
    const states: BackendState[] = [];
    const sup = supervisor([path], states);
    await sup.refresh();
    await expect(sup.open(projectKey(path))).rejects.toThrow("database is locked");
    while (sup.projects()[0]?.backend.kind !== "failed") await Bun.sleep(10);
    const failed = sup.projects()[0]?.backend;
    expect(failed?.kind === "failed" && failed.stderr).toEqual(["fake serve: database is locked"]);
    expect(states.filter((s) => s.kind === "restarting")).toHaveLength(2);
  });

  test("refuses unknown and missing folders", async () => {
    const sup = supervisor([]);
    await sup.refresh();
    await expect(sup.open("nope")).rejects.toThrow("Unknown project");
  });
});

describe("Backend", () => {
  test("a state listener that asks for the endpoint does not start a second process", async () => {
    const path = folder("gamma");
    let spawned = 0;
    const backend: Backend = new Backend({
      folder: path,
      command: { command: process.execPath, prefix: [fake] },
      tokenFile: join(path, "t.token"),
      spawn: (command, args, options) => {
        spawned += 1;
        return spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
      },
      onState: () => {
        void backend.endpointOrStart().catch(() => undefined);
      },
    });
    cleanups.push(() => backend.stop());
    await backend.start();
    expect(spawned).toBe(1);
  });

  test("callers wait out the restart backoff instead of starting early", async () => {
    const path = folder("crash-loop");
    let spawned = 0;
    const backend = new Backend({
      folder: path,
      command: { command: process.execPath, prefix: [fake] },
      tokenFile: join(path, "t.token"),
      restartDelaysMs: [150, 150],
      spawn: (command, args, options) => {
        spawned += 1;
        return spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
      },
    });
    cleanups.push(() => backend.stop());
    await expect(backend.start()).rejects.toThrow();
    for (let i = 0; i < 20; i++) await backend.endpointOrStart().catch(() => undefined);
    expect(spawned).toBeLessThanOrEqual(3);
    while (backend.state.kind !== "failed") await Bun.sleep(10);
    expect(spawned).toBe(3);
  });
});
