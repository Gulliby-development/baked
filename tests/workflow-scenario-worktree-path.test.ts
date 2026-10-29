import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { worktreeUsage } from "../src/core/workflows/worktree-usage.js";
import { RUN_MARKER, runWorktreeDir, WORKTREES_DIR } from "../src/core/workflows/worktree.js";
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

  test("the same project on Linux, or a shallow one on Windows, records nothing", async () => {
    const deep = project({ "pubspec.yaml": "name: latcell\n" }, 70);
    expect(deep.stops(await deep.run())).toHaveLength(0);
    const shallow = project({ "pubspec.yaml": "name: latcell\n" });
    shallow.service.scheduler.platform = "win32";
    expect(shallow.stops(await shallow.run())).toHaveLength(0);
  }, 60000);
});
