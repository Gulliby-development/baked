import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes } from "../src/core/specs/hash.js";
import { sddWorkflow } from "../src/core/workflows/builtin/sdd.js";
import { WorkflowArtifacts } from "../src/core/workflows/artifacts.js";
import { assertFrozenInputs } from "../src/core/workflows/context.js";
import { EffectJournal, fileHash } from "../src/core/workflows/effects.js";
import type { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { upgradeWorkflowV1 } from "../src/core/workflows/v2/upgrade.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const inputs = ["package.json", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "tsconfig.json", "biome.json"];
const initial = '{"name":"fixture","scripts":{}}\n';
const changed = '{"name":"fixture","scripts":{"check":"bun -e 0"}}\n';

/** The planned manifest write goes through the same tool policy and journal as a model edit. */
class ScriptedExecutor extends FixtureExecutor {
  service?: NativeWorkflowService;
  edited?: () => void;
  constructor(private workspace: string, private path: string) { super(workspace); }
  override async execute(request: ExecutionRequest) {
    const root = request.root ?? this.workspace;
    if (request.profile.output === "plan") {
      const result = await super.execute(request);
      (result.output as { taskGraph: { tasks: Task[] } }).taskGraph.tasks[0]?.writes.push({ path: this.path, action: "modify" });
      return result;
    }
    if (request.profile.output === "implementation") {
      const service = this.service!;
      const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, fixturePolicy, request.task, root);
      for (const [path, content] of [[this.path, changed], ["value.txt", "ready"]]) {
        await guard.execute("edit_file", { path }, async () => {
          writeFileSync(join(root, path!), content!);
          return { success: true };
        });
      }
      this.edited?.();
      return { output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Updated manifest and value", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    return super.execute(request);
  }
}

async function setup(path = "package.json", worktree = false, v2 = false, parallel = false) {
  const policy = parallel ? { ...fixturePolicy, maxConcurrentWriters: 2 } : fixturePolicy;
  const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root, path) });
  cleanups.push(fixture.dispose);
  fixture.executor.service = fixture.service;
  writeFileSync(join(fixture.root, path), initial);
  writeFileSync(join(fixture.root, "existing.ts"), "export const existing = true;\n");
  if (worktree) {
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: fixture.root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test User");
    git("config", "user.email", "test@example.test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(fixture.root, ".gitignore"), ".baked/\n");
    git("add", ".");
    git("commit", "-qm", "Initial fixture");
  }
  if (v2) {
    mkdirSync(join(fixture.root, "baked/workflows"), { recursive: true });
    writeFileSync(join(fixture.root, "baked/workflows/fixture-v2.json"), JSON.stringify({ ...upgradeWorkflowV1(sddWorkflow, fixturePolicy), id: "fixture-v2" }));
  }
  const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: v2 ? "fixture-v2" : "sdd", prompt: `Create ready value and update ${path}`, ownerLabel: "test", policy, ...(worktree ? { executionMode: "worktree" as const } : {}) });
  return { ...fixture, runId: run.runId };
}

async function approved(path = "package.json", worktree = false, v2 = false, parallel = false) {
  const fixture = await setup(path, worktree, v2, parallel);
  const waiting = await fixture.service.drive(fixture.runId, new AbortController().signal);
  if (waiting.reason !== "approval") throw new Error(JSON.stringify(fixture.service.store.requests(fixture.runId)));
  await fixture.approve(fixture.runId);
  return fixture;
}

describe("scenario: journaled frozen project inputs (#1573)", () => {
  test("v2 acceptance uses the same provenance rule", async () => {
    const { service, runId } = await approved("package.json", false, true);
    const done = await service.drive(runId, new AbortController().signal);
    expect(done.reason).not.toBe("input_changed");
    expect(done.status).toBe("completed");
  }, 60000);
  for (const path of inputs) test(`an approved ${path} edit reaches checks, review and acceptance`, async () => {
    const fixture = await approved(path);
    const { service, runId, executor, root } = fixture;
    const frozen = service.store.state(runId).frozenFiles[join(root, path)];
    const done = await service.drive(runId, new AbortController().signal);
    expect(done.reason).not.toBe("input_changed");
    expect(done.status).toBe("completed");
    expect(executor.calls).toContain("review");
    expect(executor.calls).toContain("convergence");
    expect(service.store.checkDetails(runId).some((c) => c.status === "passed")).toBe(true);
    expect(service.store.effects(runId).some((e) => e.kind === "file_patch" && e.status === "applied" && JSON.parse(e.intent_json).path === path)).toBe(true);
    expect(service.store.state(runId).frozenFiles[join(root, path)]).toBe(frozen);
  }, 60000);

  test("resume after a journaled edit keeps its provenance and completes", async () => {
    const fixture = await approved();
    const controller = new AbortController();
    fixture.executor.edited = () => controller.abort();
    await fixture.service.drive(fixture.runId, controller.signal);
    expect(readFileSync(join(fixture.root, "package.json"), "utf8")).toBe(changed);
    fixture.executor.edited = undefined;
    await fixture.resume(fixture.runId);
    expect((await fixture.service.drive(fixture.runId, new AbortController().signal)).status).toBe("completed");
  }, 60000);

  for (const parallel of [false, true]) test(`a private ${parallel ? "task" : "run"} worktree does not authorize a project edit; publication does`, async () => {
    const fixture = await approved("package.json", true, false, parallel);
    const { service, runId, root } = fixture;
    expect((await service.drive(runId, new AbortController().signal)).status).toBe("completed");
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(initial);
    const tree = join(root, service.store.state(runId).worktree!.path);
    expect(readFileSync(join(tree, "package.json"), "utf8")).toBe(changed);
    if (parallel) expect(service.store.effects(runId).some((e) => e.kind === "file_patch" && JSON.parse(e.intent_json).tool === "integrate")).toBe(true);
    const assert = () => assertFrozenInputs(service.store.state(runId), service.store, runId);
    writeFileSync(join(root, "package.json"), changed);
    expect(assert).toThrow("Accepted input changed");
    writeFileSync(join(root, "package.json"), initial);
    service.leases.acquire("mutation", runId);
    new EffectJournal(service.store, service.leases).publish(runId, attempt(service, runId), "package.json", readFileSync(join(tree, "package.json")), hashBytes(initial), "file_patch");
    expect(assert).not.toThrow();
  }, 60000);
});

function attempt(service: NativeWorkflowService, runId: string): string {
  return service.store.beginExternalAttempt(runId, "publication").attemptId;
}

describe("frozen-input provenance rejects unapproved changes", () => {
  test("an explicit revision can adopt a new baseline without discarding the journal", async () => {
    const { service, root, runId } = await approved();
    const { store } = service;
    service.leases.acquire("mutation", runId);
    const journal = new EffectJournal(store, service.leases);
    journal.publish(runId, attempt(service, runId), "package.json", changed, hashBytes(initial), "file_patch");
    journal.publish(runId, attempt(service, runId), "package.json", `${changed}\n`, hashBytes(changed), "file_patch");
    // Adopt a hash that was also an intermediate journal result, after both patches happened.
    const adopted = changed;
    writeFileSync(join(root, "package.json"), adopted);
    const candidate = await new WorkflowArtifacts(service).stageRevision(runId, { commandId: newId(), expectedInputHash: store.run(runId).input_hash });
    await service.revise(runId, { commandId: newId(), expectedRevision: store.run(runId).revision }, candidate.candidateHash);
    expect(store.state(runId).frozenInputEffectCount).toBe(store.effects(runId).length);
    expect(() => assertFrozenInputs(store.state(runId), store, runId)).not.toThrow();
    journal.publish(runId, attempt(service, runId), "package.json", `${adopted}\n`, hashBytes(adopted), "file_patch");
    expect(() => assertFrozenInputs(store.state(runId), store, runId)).not.toThrow();
  });

  test("a manifest absent at startup has no frozen hash to mismatch", async () => {
    const { service, root, runId } = await setup("bun.lock");
    writeFileSync(join(root, "package.json"), changed);
    expect(() => assertFrozenInputs(service.store.state(runId), service.store, runId)).not.toThrow();
  });

  test("outside edits, deletes, and a broken before/after chain remain blocked", async () => {
    const { service, root, runId } = await setup();
    const assert = () => assertFrozenInputs(service.store.state(runId), service.store, runId);
    const path = join(root, "package.json");
    writeFileSync(path, changed);
    expect(assert).toThrow("Accepted input changed");
    rmSync(path);
    expect(assert).toThrow("Accepted input changed");
    writeFileSync(path, initial);
    service.leases.acquire("mutation", runId);
    const journal = new EffectJournal(service.store, service.leases);
    journal.publish(runId, attempt(service, runId), "package.json", changed, fileHash(path), "file_patch");
    journal.publish(runId, attempt(service, runId), "package.json", `${changed}\n`, fileHash(path), "file_patch");
    expect(assert).not.toThrow();
    writeFileSync(path, initial);
    expect(assert).toThrow("Accepted input changed");
    journal.publish(runId, attempt(service, runId), "package.json", changed, fileHash(path), "file_patch");
    expect(assert).toThrow("Accepted input changed");
  });

  for (const status of ["prepared", "unknown", "failed", "applied", "reconciled"] as const) test(`${status} effects require a known after hash and matching before hash`, async () => {
    const { service, root, runId } = await setup();
    const { store } = service;
    const assert = () => assertFrozenInputs(store.state(runId), store, runId);
    const id = store.prepareEffect(runId, attempt(service, runId), "file_patch", { path: "package.json" }, hashBytes(initial), hashBytes(changed));
    if (status !== "prepared") store.effectStatus(runId, id, status);
    writeFileSync(join(root, "package.json"), changed);
    if (status === "applied" || status === "reconciled") expect(assert).not.toThrow();
    else expect(assert).toThrow("Accepted input changed");
    store.db.run("UPDATE effects SET after_hash=NULL WHERE id=?", [id]);
    expect(assert).toThrow("Accepted input changed");
    store.db.run("UPDATE effects SET before_hash=?, after_hash=? WHERE id=?", [hashBytes("outside"), hashBytes(changed), id]);
    expect(assert).toThrow("Accepted input changed");
  });

  test("another run and host artifact publications cannot authorize manifest edits", async () => {
    const { service, root, runId } = await setup();
    const other = await service.start({ commandId: newId(), featureId: "other", workflowId: "sdd", prompt: "Another run", ownerLabel: "test", policy: fixturePolicy });
    const { store } = service;
    const assert = () => assertFrozenInputs(store.state(runId), store, runId);
    const id = store.prepareEffect(other.runId, attempt(service, other.runId), "file_patch", { path: "package.json" }, hashBytes(initial), hashBytes(changed));
    store.effectStatus(other.runId, id, "applied");
    writeFileSync(join(root, "package.json"), changed);
    expect(assert).toThrow("Accepted input changed");
    const artifact = store.prepareEffect(runId, attempt(service, runId), "artifact_write", { path: "package.json" }, hashBytes(initial), hashBytes(changed));
    store.effectStatus(runId, artifact, "applied");
    expect(assert).toThrow("Accepted input changed");
  });

  for (const path of ["AGENTS.md", "baked/constitution.md", "baked/workflows/custom.json", "baked/gates/check.json", "baked/agents/custom.json", "baked/skills/custom/SKILL.md"]) test(`${path} stays frozen even with a journaled edit`, async () => {
    const { service, root, runId } = await setup();
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, initial);
    const state = service.store.state(runId);
    state.frozenFiles[absolute] = hashBytes(initial);
    service.store.saveState(runId, state);
    service.leases.acquire("mutation", runId);
    new EffectJournal(service.store, service.leases).publish(runId, attempt(service, runId), path, changed, hashBytes(initial), "file_patch");
    expect(() => assertFrozenInputs(service.store.state(runId), service.store, runId)).toThrow("Accepted input changed");
  });
});
