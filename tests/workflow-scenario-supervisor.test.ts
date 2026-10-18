import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { multiEditTool } from "../src/core/tools/multi-edit.js";
import { withToolPhases } from "../src/core/tools/tool-phase.js";
import { IS_WIN } from "../src/core/platform/index.js";
import { type LeaseRow, WorkflowStore } from "../src/core/workflows/store.js";
import { driverRuns, StallDetector } from "../src/core/workflows/supervisor.js";
import { recoveryArgs, superviseWorkflowCli, supervisedCommand } from "../src/headless/workflow-supervise.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 44, ignorewhy-update e415f9be (#1533): the driver journaled
// `tool.started multi_edit`, then its main thread never ran again. The tool deadline, the step
// watchdog and the lease heartbeat are timers on that thread, so the run stayed "running" for
// 31 minutes until an operator killed the driver and resumed the run, which finished in 93 s.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DRIVER = join(import.meta.dir, "helpers", "supervised-driver.ts");

async function pausedRun(stall: Record<string, number> = {}) {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  fixture.config.workflows.stall = { ...fixture.config.workflows.stall, ...stall };
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  return { fixture, runId: run.runId, revision: fixture.service.store.run(run.runId).revision };
}

function starter(root: string, config: unknown) {
  const started: { argv: string[]; child: ChildProcess }[] = [];
  const start = (argv: string[]) => {
    const child = spawn(process.execPath, [DRIVER], {
      cwd: root,
      env: {
        ...process.env,
        SUPERVISED_ROOT: root,
        SUPERVISED_CONFIG: JSON.stringify(config),
        SUPERVISED_ARGS: JSON.stringify(argv),
        // The first driver hangs; the one the supervisor starts after the takeover finishes.
        SUPERVISED_MODE: started.length === 0 ? "hang" : "finish",
      },
      stdio: ["ignore", "pipe", "inherit"],
      detached: !IS_WIN,
    });
    started.push({ argv, child });
    return child;
  };
  return { start, started };
}

describe("scenario: ignorewhy e415f9be, a driver whose thread stopped inside multi_edit (#1533)", () => {
  test("a reader sees the takeover and resumed state together (#1541)", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    fixture.config.workflows.stall.autoResumes = 1;
    const run = await fixture.start();
    const store = fixture.service.store;
    store.transition(run.runId, "running");
    const reader = new WorkflowStore(fixture.root, true);
    const observed: string[][] = [];
    const transaction = store.transaction.bind(store);
    // Poll on the other connection at every transaction boundary, including the gap before resume.
    store.transaction = <T>(action: () => T): T => {
      const result = transaction(action);
      if (reader.latestArtifact(run.runId, "stalled/takeover-1.json")) {
        const current = reader.run(run.runId);
        observed.push([current.status, current.reason]);
      }
      return result;
    };
    try {
      expect(await fixture.service.takeOverStalledDriver(run.runId, { pid: process.pid, owner: "stopped" })).toBe(true);
      expect(observed).toContainEqual(["paused", "none"]);
      expect(observed).not.toContainEqual(["blocked", "step_stalled"]);
      expect(store.state(run.runId).stallResumes).toBe(1);
    } finally {
      store.transaction = transaction;
      reader.close();
    }
  });

  test("the supervisor stops the driver, takes the run over and a new driver finishes it", async () => {
    const { fixture, runId, revision } = await pausedRun();
    const { start, started } = starter(fixture.root, fixture.config);
    const lines: string[] = [];
    const code = await superviseWorkflowCli(["resume", runId, "--expected-revision", String(revision)], {
      cwd: fixture.root,
      config: fixture.config,
      graceMs: 1_000,
      pollMs: 200,
      start,
      log: (line) => lines.push(line),
    });
    const store = fixture.service.store;
    expect(started).toHaveLength(2);
    expect(started[1]?.argv.slice(0, 2)).toEqual(["resume", runId]);
    expect(code).toBe(0);
    expect(store.run(runId).status).toBe("completed");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { supervisor: "takeover", runId, pid: started[0]?.child.pid, resumed: true },
    ]);
    expect(store.latestArtifact(runId, "stalled/takeover-1.json")).not.toBeNull();
    expect(store.state(runId).stallResumes).toBe(1);
    // The hung driver journaled the call it was in; its edit was settled on the takeover.
    const events = store.events(runId, 0, 100_000);
    expect(events.some((e) => e.type === "tool.started")).toBe(true);
    // The step it stopped in is journaled too: the edit had its pre-image and never wrote.
    const phases = events.filter((e) => e.type === "tool.phase").map((e) => (e.payload as { phase: string }).phase);
    expect(phases[0]).toBe("pre_image");
    expect(store.effects(runId).some((e) => e.status === "prepared")).toBe(false);
  }, 90_000);

  test("past workflows.stall.autoResumes the run blocks step_stalled for a person", async () => {
    const { fixture, runId, revision } = await pausedRun({ autoResumes: 0 });
    const { start, started } = starter(fixture.root, fixture.config);
    const code = await superviseWorkflowCli(["resume", runId, "--expected-revision", String(revision)], {
      cwd: fixture.root,
      config: fixture.config,
      graceMs: 1_000,
      pollMs: 200,
      start,
      log: () => {},
    });
    expect(code).toBe(4);
    expect(started).toHaveLength(1);
    const run = fixture.service.store.run(runId);
    expect([run.status, run.reason]).toEqual(["blocked", "step_stalled"]);
  }, 90_000);
});

describe("edit tool phases (#1533)", () => {
  test("multi_edit reports its write and the follow-up steps in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-phase-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "a.txt");
    writeFileSync(file, "one\ntwo\n");
    const phases: string[] = [];
    const result = await withToolPhases(
      (phase) => phases.push(phase),
      () => multiEditTool.execute({ path: file, edits: [{ oldString: "two", newString: "three" }] }),
    );
    expect(result.success).toBe(true);
    expect(phases[0]).toBe("write");
    expect(phases).toContain("format");
    expect(phases.indexOf("format")).toBeGreaterThan(0);
  });
});

describe("stall detector (#1533)", () => {
  const lease = (expiresAt: number, pid = 42, resource = "execution:."): LeaseRow =>
    ({ resource, owner_id: "o", owner_epoch: 1, run_id: "r1", expires_at: expiresAt, process_identity_json: JSON.stringify({ pid }) }) as LeaseRow;

  test("a lease that stays expired for the grace period is a stopped driver", () => {
    const detector = new StallDetector({ graceMs: 1_000, pollMs: 500 });
    expect(detector.check([lease(100)], 42, 200, 0)).toEqual([]);
    expect(detector.check([lease(100)], 42, 700, 500)).toEqual([]);
    expect(detector.check([lease(100)], 42, 1_200, 1_000)).toEqual(["r1"]);
  });

  test("a renewed lease, another process's lease or a live one is not", () => {
    const detector = new StallDetector({ graceMs: 1_000, pollMs: 500 });
    detector.check([lease(100)], 42, 200, 0);
    detector.check([lease(600)], 42, 700, 500);
    expect(detector.check([lease(600)], 42, 1_200, 1_000)).toEqual([]);
    expect(detector.check([lease(100, 7)], 42, 5_000, 1_500)).toEqual([]);
    expect(detector.check([lease(99_000)], 42, 5_000, 2_000)).toEqual([]);
  });

  test("after a gap in its own polls (the host slept) the wait starts over", () => {
    const detector = new StallDetector({ graceMs: 1_000, pollMs: 500 });
    detector.check([lease(100)], 42, 200, 0);
    // Hours later by the wall clock and 10 s by the supervisor's: the driver slept too.
    expect(detector.check([lease(100)], 42, 9_000_000, 10_000)).toEqual([]);
    expect(detector.check([lease(100)], 42, 9_000_500, 10_500)).toEqual([]);
    expect(detector.check([lease(100)], 42, 9_001_000, 11_000)).toEqual(["r1"]);
  });

  test("a worker watch and takeover select only its owner within the shared process (#1541)", () => {
    const detector = new StallDetector({ graceMs: 1_000, pollMs: 500 });
    const own = lease(100);
    const other = { ...lease(100, 42, "execution:other"), owner_id: "other", run_id: "r2" };
    const leases: LeaseRow[] = [own, { ...own, resource: "mutation" }, other, lease(100, 7, "execution:foreign")];
    const driver = { pid: 42, owner: "o" };
    expect(driverRuns(leases, driver)).toEqual(["r1"]);
    expect(detector.check(leases, driver, 200, 0)).toEqual([]);
    expect(detector.check(leases, driver, 700, 500)).toEqual([]);
    expect(detector.check(leases, driver, 1_200, 1_000)).toEqual(["r1"]);
    expect(driverRuns([other], driver)).toEqual([]);
  });
});

describe("supervised commands (#1533)", () => {
  test("only commands that drive a run or an initiative run under a supervisor", () => {
    expect(supervisedCommand(["run", "--prompt", "x"], {})).toBe(true);
    expect(supervisedCommand(["approve", "R"], {})).toBe(true);
    expect(supervisedCommand(["initiative", "drive", "I"], {})).toBe(true);
    expect(supervisedCommand(["status", "R"], {})).toBe(false);
    expect(supervisedCommand(["initiative", "show", "I"], {})).toBe(false);
    expect(supervisedCommand(["run", "--help"], {})).toBe(false);
    expect(supervisedCommand(["run"], { BAKED_WORKFLOW_SUPERVISED: "1" })).toBe(false);
  });

  test("the driver after a takeover resumes the run, or drives its initiative", () => {
    const run = { runId: "R", revision: 9, initiativeId: "I" };
    expect(recoveryArgs(["approve", "R", "--events"], run, 55)).toEqual(["resume", "R", "--expected-revision", "9", "--events", "--after", "55"]);
    expect(recoveryArgs(["run", "--json"], { ...run, initiativeId: null }, 0)).toEqual(["resume", "R", "--expected-revision", "9", "--json"]);
    expect(recoveryArgs(["initiative", "start", "--prompt", "x"], run, 0)).toEqual(["initiative", "drive", "I"]);
  });
});
