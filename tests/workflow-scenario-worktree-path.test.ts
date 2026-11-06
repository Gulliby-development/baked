import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { worktreeUsage } from "../src/core/workflows/worktree-usage.js";
import { RUN_MARKER, runWorktreeDir, WORKTREES_DIR, worktreeRootDir, worktreeRootProblem } from "../src/core/workflows/worktree.js";
import { pathSensitiveChecks, runsTool, WORKTREE_PROBE_PATH, type WorktreeProbeRecord, worktreeProbeDecision } from "../src/core/workflows/worktree-probe.js";
import { FixtureExecutor, fixturePolicy } from "./helpers/workflow-fixture.js";

// #2454, R78 latcell-update and latcellu: on Windows `dart test` cannot start its frontend server
// below a working directory of about 94 characters, and a task's checks ran in
// `.baked/worktrees/<36-character run id>/<task>`. Every test file failed to load, five corrective
// sessions could not shorten a path (2.1M tokens). The run's directory is now the id's first 8 hex
// digits, and a run whose deepest worktree crosses a project language's limit records
// `worktree_environment` (shadow) before its first task.

const roots: string[] = [];
const services: NativeWorkflowService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A committed project in a folder `depth` characters below a temporary one. */
function project(files: Record<string, string>, depth = 0) {
  const parent = mkdtempSync(join(tmpdir(), "wtp-"));
  roots.push(parent);
  const root = depth ? join(parent, "w".repeat(depth)) : parent;
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".baked/\n");
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const executor: AgentExecutor = {
    execute: (request: ExecutionRequest) => new FixtureExecutor(request.root ?? root).execute(request),
  };
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, defaultWorkflow: "sdd", policy: fixturePolicy } };
  const service = new NativeWorkflowService(root, config, executor);
  services.push(service);
  const signal = () => new AbortController().signal;
  const run = async () => {
    const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: fixturePolicy, executionMode: "worktree" });
    await service.drive(started.runId, signal());
    const request = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (request)
      await service.decide(started.runId, { commandId: newId(), expectedRevision: service.store.run(started.runId).revision }, { kind: "approve", requestId: request.id, digest: request.digest });
    await service.drive(started.runId, signal());
    return started.runId;
  };
  const stops = (runId: string) =>
    service.store.eventsOfType(runId, "decision.would_stop").filter((e) => e.payload.reason === "worktree_environment");
  return { root, service, run, stops };
}

describe("scenario: R78 latcell-update, dart test below a deep task worktree (#2454)", () => {
  test("a run's worktrees live under its id's first 8 hex digits, and the directory names its run", async () => {
    const { root, service, run } = project({ "README.md": "# p\n" });
    const runId = await run();
    const hex = runId.replaceAll("-", "").slice(0, 8);
    expect(service.store.state(runId).worktree?.path).toBe(`${WORKTREES_DIR}/${hex}/main`);
    expect(readFileSync(join(root, WORKTREES_DIR, hex, RUN_MARKER), "utf8").trim()).toBe(runId);
    // 28 characters shorter than the full id's directory.
    expect(`${WORKTREES_DIR}/${runId}`.length - `${WORKTREES_DIR}/${hex}`.length).toBe(28);
    const usage = await worktreeUsage(service.store);
    expect(usage.worktrees).toHaveLength(1);
    expect(usage.worktrees[0]).toMatchObject({ runId, path: `${WORKTREES_DIR}/${hex}` });
    expect(usage.worktrees[0]?.status).not.toBe("orphan");
    expect(usage.worktrees[0]?.worktrees.map((w) => w.name)).toEqual(["main"]);
  }, 60000);

  test("another run's directory with the same prefix makes the name longer; a full-id directory stays", () => {
    const root = mkdtempSync(join(tmpdir(), "wtp-"));
    roots.push(root);
    const runId = "0123abcd-4567-89ef-0123-456789abcdef";
    expect(runWorktreeDir(root, runId)).toBe(`${WORKTREES_DIR}/0123abcd`);
    mkdirSync(join(root, WORKTREES_DIR, "0123abcd"), { recursive: true });
    writeFileSync(join(root, WORKTREES_DIR, "0123abcd", RUN_MARKER), "0123abcd-ffff-0000-0000-000000000000\n");
    expect(runWorktreeDir(root, runId)).toBe(`${WORKTREES_DIR}/0123abcd4567`);
    // Its own marker keeps the short name.
    writeFileSync(join(root, WORKTREES_DIR, "0123abcd", RUN_MARKER), `${runId}\n`);
    expect(runWorktreeDir(root, runId)).toBe(`${WORKTREES_DIR}/0123abcd`);
    // A run whose directory was named by its full id, before #2454, keeps it.
    mkdirSync(join(root, WORKTREES_DIR, runId), { recursive: true });
    expect(runWorktreeDir(root, runId)).toBe(`${WORKTREES_DIR}/${runId}`);
  });

  test("a Dart project whose task worktree is too deep for dart test records worktree_environment on Windows", async () => {
    const { root, service, run, stops } = project({ "pubspec.yaml": "name: latcell\n" }, 70);
    service.scheduler.platform = "win32";
    const runId = await run();
    const recorded = stops(runId);
    expect(recorded).toHaveLength(1);
    const deepest = join(root, service.store.state(runId).worktree?.path ?? "");
    expect(String(recorded[0]?.payload.summary)).toContain(`(${String(deepest.length)} characters)`);
    expect(String(recorded[0]?.payload.summary)).toContain("dart test fails to start over 88 characters on win32");
    expect(recorded[0]?.payload.mode).toBe("shadow");
  }, 60000);

  test("the same project on Linux, or a project without a Dart manifest on Windows, records nothing", async () => {
    // The platform is set either way: the host's own (and its temporary folder's depth) must not decide.
    const linux = project({ "pubspec.yaml": "name: latcell\n" }, 70);
    linux.service.scheduler.platform = "linux";
    expect(linux.stops(await linux.run())).toHaveLength(0);
    const other = project({ "README.md": "# p\n" }, 70);
    other.service.scheduler.platform = "win32";
    expect(other.stops(await other.run())).toHaveLength(0);
  }, 60000);
});

// #2461: `workflows.worktreeRoot` moves a run's worktrees out of a long workspace path, and the
// worktree preflight probe measures a path-sensitive test check (a `WORKTREE_PATH_LIMITS` row)
// instead of trusting the row's estimate.

/** A fake `dart test` (a script named `dart.ts` that bun runs) that cannot start in a cwd longer than `limit`. */
function fakeDart(limit: number) {
  const bin = mkdtempSync(join(tmpdir(), "wtp-bin-"));
  roots.push(bin);
  const script = join(bin, "dart.ts");
  writeFileSync(
    script,
    `if (process.cwd().length > ${String(limit)}) {\n  console.log("test/a_test.dart: Failed to load: The system cannot find the file specified.");\n  console.log("test/b_test.dart: Failed to load: The system cannot find the file specified.");\n  process.exit(1);\n}\nconsole.log("All tests passed!");\n`,
  );
  return { id: "dart-test", executable: process.execPath, args: [script, "test"], cwd: ".", timeoutMs: 20000, required: true, scope: "feature" as const, envNames: [], writes: [] };
}

/** A Dart project `depth` characters below a temporary folder, with a fake `dart test` and an optional worktree root. */
function dartProject(limit: number, depth: number, worktreeRoot?: string) {
  const policy = { ...fixturePolicy, checks: [...fixturePolicy.checks, fakeDart(limit)] };
  const parent = mkdtempSync(join(tmpdir(), "wtp-"));
  roots.push(parent);
  const root = join(parent, "w".repeat(depth));
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".baked/\n");
  writeFileSync(join(root, "pubspec.yaml"), "name: latcell\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const executor: AgentExecutor = {
    execute: (request: ExecutionRequest) => new FixtureExecutor(request.root ?? root).execute(request),
  };
  const config = {
    ...DEFAULT_CONFIG,
    defaultModel: "fixture/model",
    workflows: { enabled: true, defaultWorkflow: "sdd", policy, ...(worktreeRoot ? { worktreeRoot } : {}) },
  };
  const service = new NativeWorkflowService(root, config, executor);
  services.push(service);
  service.scheduler.platform = "win32";
  const signal = () => new AbortController().signal;
  const run = async () => {
    const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy, executionMode: "worktree" });
    await service.drive(started.runId, signal());
    const request = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (request)
      await service.decide(started.runId, { commandId: newId(), expectedRevision: service.store.run(started.runId).revision }, { kind: "approve", requestId: request.id, digest: request.digest });
    await service.drive(started.runId, signal());
    return started.runId;
  };
  const stops = (runId: string) =>
    service.store.eventsOfType(runId, "decision.would_stop").filter((e) => e.payload.reason === "worktree_environment");
  const probe = (runId: string) => {
    const artifact = service.store.latestArtifact(runId, WORKTREE_PROBE_PATH);
    return artifact ? (JSON.parse(service.store.readArtifact(runId, artifact.id)) as WorktreeProbeRecord) : null;
  };
  return { root, service, run, stops, probe };
}

describe("worktree root setting and preflight probe (#2461)", () => {
  test("workflows.worktreeRoot puts the run's worktree in that folder, named by the run's 8 hex digits", async () => {
    const short = mkdtempSync(join(tmpdir(), "wtr-"));
    roots.push(short);
    const { root, service, run } = project({ "README.md": "# p\n" });
    if (service.config.workflows) service.config.workflows.worktreeRoot = short;
    const runId = await run();
    const hex = runId.replaceAll("-", "").slice(0, 8);
    const path = service.store.state(runId).worktree?.path ?? "";
    // Stored relative to the project, as every reader of a worktree path expects.
    expect(join(root, path)).toBe(join(short, hex, "main"));
    expect(path.startsWith("..")).toBe(true);
    expect(readFileSync(join(short, hex, RUN_MARKER), "utf8").trim()).toBe(runId);
    expect(service.store.run(runId).status).toBe("completed");
    const usage = await service.worktrees();
    expect(usage.worktrees.map((w) => w.runId)).toEqual([runId]);
    expect(join(root, usage.worktrees[0]?.path ?? "")).toBe(join(short, hex));
  }, 60000);

  test("a shared root names around another project's run, and a root inside the project falls back to .baked/worktrees", () => {
    const workspace = mkdtempSync(join(tmpdir(), "wtr-"));
    roots.push(workspace);
    const runId = "0123abcd-4567-89ef-0123-456789abcdef";
    const shared = join(workspace, "..", `shared-${basename(workspace)}`);
    roots.push(shared);
    expect(runWorktreeDir(workspace, runId, shared)).toBe(`../shared-${basename(workspace)}/0123abcd`);
    // Another project's run holds the prefix in the shared folder.
    mkdirSync(join(shared, "0123abcd"), { recursive: true });
    writeFileSync(join(shared, "0123abcd", RUN_MARKER), "0123abcd-ffff-0000-0000-000000000000\n");
    expect(runWorktreeDir(workspace, runId, shared)).toBe(`../shared-${basename(workspace)}/0123abcd4567`);
    // Inside the project, outside .baked: refused, the default holds the run.
    expect(worktreeRootProblem(workspace, join(workspace, "wt"))).toContain("inside the project");
    expect(runWorktreeDir(workspace, runId, join(workspace, "wt"))).toBe(`${WORKTREES_DIR}/0123abcd`);
    expect(worktreeRootProblem(workspace, join(workspace, ".baked", "wt"))).toBeNull();
    expect(worktreeRootDir(workspace, "~/.bk")).toBe(join(homedir(), ".bk"));
    expect(worktreeRootDir(workspace, "../bk")).toBe(join(workspace, "..", "bk"));
    expect(worktreeRootDir(workspace, " ")).toBeNull();
  });

  test("dart test failing in a deep worktree and passing in a short copy records worktree_environment from the probe", async () => {
    const { run, stops, probe } = dartProject(100, 70);
    const runId = await run();
    const record = probe(runId);
    expect(record?.probes).toHaveLength(1);
    const [measured] = record?.probes ?? [];
    expect(measured).toMatchObject({ checkId: "dart-test", language: "dart", inWorktree: "failed", inCopy: "passed", decision: "environment" });
    expect(measured?.worktreeLength).toBeGreaterThan(100);
    expect(measured?.copyLength).toBeLessThanOrEqual(100);
    const recorded = stops(runId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload.mode).toBe("shadow");
    const summary = String(recorded[0]?.payload.summary);
    expect(summary).toContain(`(${String(measured?.worktreeLength)} characters)`);
    expect(summary).toContain("Set workflows.worktreeRoot to a short folder such as C:\\.bk");
    expect((recorded[0]?.payload.inputs as { source: string }).source).toBe("probe");
  }, 90000);

  test("a check that passes in the worktree clears the row's estimate; one that fails everywhere is the code's", async () => {
    // 70 characters deep is past the row's 88, but this machine's dart test starts there.
    const passes = dartProject(400, 70);
    const passed = await passes.run();
    expect(passes.probe(passed)?.probes[0]?.decision).toBe("passed");
    expect(passes.stops(passed)).toHaveLength(0);
    const broken = dartProject(5, 70);
    const failed = await broken.run();
    expect(broken.probe(failed)?.probes[0]).toMatchObject({ inWorktree: "failed", inCopy: "failed", decision: "code" });
    expect(broken.stops(failed)).toHaveLength(0);
  }, 120000);

  test("a short worktree root keeps the same project's dart test under its limit", async () => {
    const short = mkdtempSync(join(tmpdir(), "r-"));
    roots.push(short);
    const { run, stops, probe, service } = dartProject(100, 70, short);
    const runId = await run();
    expect(join(service.store.workspace, service.store.state(runId).worktree?.path ?? "").length).toBeLessThanOrEqual(100);
    expect(probe(runId)?.probes[0]?.decision).toBe("passed");
    expect(stops(runId)).toHaveLength(0);
    expect(service.store.run(runId).status).toBe("completed");
  }, 90000);

  test("the probe runs only for a required check of a toolchain with a WORKTREE_PATH_LIMITS row on its platform", () => {
    const dir = mkdtempSync(join(tmpdir(), "wtp-"));
    roots.push(dir);
    writeFileSync(join(dir, "pubspec.yaml"), "name: p\n");
    const check = fakeDart(10);
    expect(runsTool(["dart", "test"], "dart test")).toBe(true);
    expect(runsTool(["C:\\sdk\\bin\\dart.exe", "test", "-r", "expanded"], "dart test")).toBe(true);
    expect(runsTool(["dart.bat", "test"], "dart test")).toBe(true);
    expect(runsTool(["dart", "analyze"], "dart test")).toBe(false);
    expect(runsTool(["darts", "test"], "dart test")).toBe(false);
    expect(pathSensitiveChecks([check], dir, "win32").map((c) => [c.language, c.tool, c.limit])).toEqual([["dart", "dart test", 88]]);
    expect(pathSensitiveChecks([check], dir, "linux")).toEqual([]);
    expect(pathSensitiveChecks([{ ...check, required: false }], dir, "win32")).toEqual([]);
    expect(worktreeProbeDecision("failed", "passed")).toBe("environment");
    expect(worktreeProbeDecision("failed", "failed")).toBe("code");
    expect(worktreeProbeDecision("passed", "not_run")).toBe("passed");
    expect(worktreeProbeDecision("failed", "inconclusive")).toBe("not_probed");
    expect(worktreeProbeDecision("not_measured", "not_run")).toBe("not_probed");
  });
});
