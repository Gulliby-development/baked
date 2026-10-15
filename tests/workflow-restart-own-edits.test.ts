import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes } from "../src/core/specs/hash.js";
import { capturePreImage } from "../src/core/workflows/rollback.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;

test("a restarted task edits the file its own earlier attempt edited", async () => {
  // Under clarification assume a blocked implementer restarts once in a fresh session (#745).
  const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "assume" } });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const file = join(root, "usage.txt");
  writeFileSync(file, "original usage\n");
  const errors: string[] = [];
  let attempts = 0;
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output !== "implementation") {
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.unshift({ path: "usage.txt", action: "modify" });
      }
      return out;
    }
    attempts++;
    const policy = JSON.parse(service.store.run(request.runId).policy_json) as RunPolicy;
    const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, policy, request.task);
    try {
      await guard.execute("edit_file", { path: "usage.txt" }, async () => writeFileSync(file, attempts === 1 ? "draft" : "ready"));
      await guard.execute("edit_file", { path: "value.txt" }, async () => writeFileSync(join(root, "value.txt"), "ready"));
    } catch (error) {
      errors.push((error as Error).message);
    }
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: attempts === 1 ? "blocked" : "implemented", summary: attempts === 1 ? "Ran out of steps" : "Wrote value", evidenceIds: [], unresolved: attempts === 1 ? ["value is a draft"] : [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  };
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await fixture.resume(run.runId);
  await service.drive(run.runId, signal());
  expect(attempts).toBe(2);
  expect(errors).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe("ready");
});

test("a restarted task creates again the file its earlier attempt created when the file is gone", async () => {
  // A task restarted after `invalidated` can get a rebuilt worktree without the earlier attempt's
  // file while the journal still carries its write; every write was refused as changed (#927).
  const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "assume" } });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const file = join(root, "fresh.txt");
  const errors: string[] = [];
  let attempts = 0;
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output !== "implementation") {
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.unshift({ path: "fresh.txt", action: "create" });
      }
      return out;
    }
    attempts++;
    // The rebuilt worktree of the restart no longer holds the first attempt's file.
    if (attempts === 2) rmSync(file, { force: true });
    const policy = JSON.parse(service.store.run(request.runId).policy_json) as RunPolicy;
    const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, policy, request.task);
    try {
      await guard.execute("edit_file", { path: "fresh.txt" }, async () => writeFileSync(file, attempts === 1 ? "draft" : "ready"));
      if (attempts === 2) await guard.execute("edit_file", { path: "fresh.txt" }, async () => writeFileSync(file, "ready, edited"));
      await guard.execute("edit_file", { path: "value.txt" }, async () => writeFileSync(join(root, "value.txt"), "ready"));
    } catch (error) {
      errors.push((error as Error).message);
    }
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: attempts === 1 ? "blocked" : "implemented", summary: attempts === 1 ? "Ran out of steps" : "Wrote value", evidenceIds: [], unresolved: attempts === 1 ? ["value is a draft"] : [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  };
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await fixture.resume(run.runId);
  await service.drive(run.runId, signal());
  expect(attempts).toBe(2);
  expect(errors).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe("ready, edited");
});

test("a restarted task edits its file when the rebuilt worktree holds an earlier state of its own writes", async () => {
  // Bench R17 (#991): after repeated invalidations or a second worker loss the rebuilt worktree
  // held a state the task's own lineage wrote in between (the integrated file, or the first
  // attempt's content). It was neither the last journaled hash nor the hash before the first
  // write, so every edit was refused as a change made outside the attempt.
  const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "assume" } });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const file = join(root, "props.txt");
  const errors: string[] = [];
  let attempts = 0;
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output !== "implementation") {
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.unshift({ path: "props.txt", action: "create" });
      }
      return out;
    }
    attempts++;
    // The rebuilt worktree of the restart holds the first write's content, not the last.
    if (attempts === 2) writeFileSync(file, "first");
    const policy = JSON.parse(service.store.run(request.runId).policy_json) as RunPolicy;
    const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, policy, request.task);
    try {
      if (attempts === 1) {
        await guard.execute("edit_file", { path: "props.txt" }, async () => writeFileSync(file, "first"));
        await guard.execute("edit_file", { path: "props.txt" }, async () => writeFileSync(file, "second"));
      } else {
        await guard.execute("edit_file", { path: "props.txt" }, async () => writeFileSync(file, "ready"));
        await guard.execute("edit_file", { path: "props.txt" }, async () => writeFileSync(file, "ready, edited"));
        await guard.execute("edit_file", { path: "value.txt" }, async () => writeFileSync(join(root, "value.txt"), "ready"));
      }
    } catch (error) {
      errors.push((error as Error).message);
    }
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: attempts === 1 ? "blocked" : "implemented", summary: attempts === 1 ? "Ran out of steps" : "Wrote value", evidenceIds: [], unresolved: attempts === 1 ? ["value is a draft"] : [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  };
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await fixture.resume(run.runId);
  await service.drive(run.runId, signal());
  expect(attempts).toBe(2);
  expect(errors).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe("ready, edited");
});

test("a restarted task edits its file when the rebuilt worktree holds a check fixer's output from another root", async () => {
  // Bench R29, seqtext ead875e0 (#1269): the checks stage's `cargo fmt` rewrote the task's file in
  // the integration root, and the task restarted in a root rebuilt from it. The formatted content
  // is in neither this root's journal nor its lineage, so every edit was refused as a change made
  // outside the attempt: 11 attempts and $3.42 with no edit.
  const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "assume" } });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const file = join(root, "cli.rs");
  const errors: string[] = [];
  let attempts = 0;
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output !== "implementation") {
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.unshift({ path: "cli.rs", action: "create" });
      }
      return out;
    }
    attempts++;
    if (attempts === 2) {
      // The fixer's run in the integration root, journaled there for this task's file.
      const step = service.store.steps(request.runId).find((s) => !s.stage_id.startsWith("task-"));
      if (!step) throw new Error("No run-level step");
      const host = service.store.beginHostAttempt(request.runId, step.id);
      const before = capturePreImage(service.store, request.runId, file);
      writeFileSync(file, "fn main() {}\n");
      const effect = service.store.transaction(() =>
        service.store.prepareEffect(request.runId, host, "file_patch", { path: "cli.rs", tool: "apply_fix", checkId: "fmt", taskId: request.task?.id, root: ".baked/worktrees/run/main" }, before, null),
      );
      service.store.transaction(() => service.store.finishFileEffect(request.runId, effect, hashBytes(Buffer.from("fn main() {}\n"))));
      service.store.transaction(() => service.store.finishAttempt(request.runId, host, "completed", 0));
    }
    const policy = JSON.parse(service.store.run(request.runId).policy_json) as RunPolicy;
    const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, policy, request.task);
    try {
      if (attempts === 1) await guard.execute("edit_file", { path: "cli.rs" }, async () => writeFileSync(file, "fn main(){}"));
      else {
        await guard.execute("edit_file", { path: "cli.rs" }, async () => writeFileSync(file, "fn main() { run(); }\n"));
        await guard.execute("edit_file", { path: "value.txt" }, async () => writeFileSync(join(root, "value.txt"), "ready"));
      }
    } catch (error) {
      errors.push((error as Error).message);
    }
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: attempts === 1 ? "blocked" : "implemented", summary: attempts === 1 ? "Ran out of steps" : "Wrote value", evidenceIds: [], unresolved: attempts === 1 ? ["value is a draft"] : [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  };
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await fixture.resume(run.runId);
  await service.drive(run.runId, signal());
  expect(attempts).toBe(2);
  expect(errors).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe("fn main() { run(); }\n");
});

test("a restarted task edits its file when the rebuilt worktree holds the run's baseline of it", async () => {
  // #1269: a root rebuilt from the integration root holds the file as the run's baseline records it,
  // changed after this task's last write by another task or a fixer whose edit is not in the
  // task's lineage. It is the run's own content, so the restarted task may edit it.
  const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "assume" } });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const file = join(root, "cli.rs");
  const errors: string[] = [];
  let attempts = 0;
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output !== "implementation") {
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.unshift({ path: "cli.rs", action: "create" });
      }
      return out;
    }
    attempts++;
    if (attempts === 2) {
      // The integration root's version, recorded as the run's baseline; nothing journaled it for this task.
      writeFileSync(file, "fn main() {}\n");
      const state = service.store.state(request.runId);
      if (!state.expectedFiles) throw new Error("No baseline");
      state.expectedFiles["cli.rs"] = hashBytes(Buffer.from("fn main() {}\n"));
      service.store.transaction(() => service.store.saveState(request.runId, state));
    }
    const policy = JSON.parse(service.store.run(request.runId).policy_json) as RunPolicy;
    const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, policy, request.task);
    try {
      if (attempts === 1) await guard.execute("edit_file", { path: "cli.rs" }, async () => writeFileSync(file, "fn main(){}"));
      else {
        await guard.execute("edit_file", { path: "cli.rs" }, async () => writeFileSync(file, "fn main() { run(); }\n"));
        await guard.execute("edit_file", { path: "value.txt" }, async () => writeFileSync(join(root, "value.txt"), "ready"));
      }
    } catch (error) {
      errors.push((error as Error).message);
    }
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: attempts === 1 ? "blocked" : "implemented", summary: attempts === 1 ? "Ran out of steps" : "Wrote value", evidenceIds: [], unresolved: attempts === 1 ? ["value is a draft"] : [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  };
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await fixture.resume(run.runId);
  await service.drive(run.runId, signal());
  expect(attempts).toBe(2);
  expect(errors).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe("fn main() { run(); }\n");
});
