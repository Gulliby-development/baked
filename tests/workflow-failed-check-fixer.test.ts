import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

// Bench round 07 (pkgdrift T004 54k, md-site T009 71k): a failed check that declares a fixer became
// an LLM repair task. value.txt is not a code file, so the fixer pass before the checks skips it.
const policy: RunPolicy = {
  ...fixturePolicy,
  checks: [
    {
      id: "fmt",
      executable: "bun",
      args: ["-e", "const t = await Bun.file('value.txt').text(); if (t !== t.trim()) process.exit(1)"],
      cwd: ".",
      timeoutMs: 10000,
      required: true,
      scope: "task",
      envNames: [],
      writes: [],
      fix: {
        executable: "bun",
        args: ["-e", "const f = process.argv.at(-1); await Bun.write(f, (await Bun.file(f).text()).trim())"],
      },
    },
    ...fixturePolicy.checks,
  ],
};

async function runToEnd(fixture: ReturnType<typeof workflowFixture>) {
  const { service } = fixture;
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  for (let i = 0; i < 4 && (await service.get(run.runId)).status !== "completed"; i++) {
    await fixture.resume(run.runId);
    await service.drive(run.runId, signal());
  }
  return run;
}

/** An implementer that leaves trailing whitespace and a plan that names the `fmt` check on T001. */
function sloppyExecutor(fixture: ReturnType<typeof workflowFixture>, root: string) {
  const { executor } = fixture;
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    const out = await original(request);
    if (request.profile.output === "plan") {
      const plan = out.output as { taskGraph: { tasks: Record<string, unknown>[] } };
      (plan.taskGraph.tasks[0] as Record<string, unknown>).checkIds = ["fmt"];
    }
    if (request.profile.output === "implementation") writeFileSync(join(root, "value.txt"), "ready  \n");
    return out;
  };
}

test("a failed task check with a fixer is fixed by the host and rerun before any repair task", async () => {
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  sloppyExecutor(fixture, fixture.root);
  const run = await runToEnd(fixture);
  const { service, executor, root } = fixture;

  expect((await service.get(run.runId)).status).toBe("completed");
  expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("ready");
  // One implementation call: no finding, no repair task.
  expect(executor.calls.filter((call) => call === "implementation")).toHaveLength(1);
  expect(service.store.tasks(run.runId).map((t) => t.id)).toEqual(["T001"]);
  const fixes = service.store
    .effects(run.runId)
    .filter((e) => e.kind === "file_patch" && JSON.parse(e.intent_json).tool === "apply_fix");
  expect(fixes.map((e) => JSON.parse(e.intent_json).path)).toEqual(["value.txt"]);
});

test("a fixer that changes nothing leaves the failure to the repair task", async () => {
  const noop: RunPolicy = {
    ...policy,
    checks: policy.checks.map((c) =>
      c.id === "fmt" ? { ...c, fix: { executable: "bun", args: ["-e", "0"] } } : c,
    ),
  };
  const fixture = workflowFixture({ policy: noop });
  cleanups.push(fixture.dispose);
  sloppyExecutor(fixture, fixture.root);
  const run = await runToEnd(fixture);
  expect((await fixture.service.get(run.runId)).status).not.toBe("completed");
  expect(fixture.executor.calls.filter((call) => call === "implementation").length).toBeGreaterThan(1);
});

test("the unsafe fixer tier runs after the safe one and fixes what it left", async () => {
  const tiered: RunPolicy = {
    ...policy,
    checks: policy.checks.map((c) =>
      c.id === "fmt"
        ? { ...c, fix: { executable: "bun", args: ["-e", "0"] }, fixUnsafe: policy.checks[0]?.fix }
        : c,
    ),
  };
  const fixture = workflowFixture({ policy: tiered });
  cleanups.push(fixture.dispose);
  sloppyExecutor(fixture, fixture.root);
  const run = await runToEnd(fixture);
  expect((await fixture.service.get(run.runId)).status).toBe("completed");
  expect(readFileSync(join(fixture.root, "value.txt"), "utf8")).toBe("ready");
  expect(fixture.executor.calls.filter((call) => call === "implementation")).toHaveLength(1);
  const fixes = fixture.service.store
    .effects(run.runId)
    .filter((e) => e.kind === "file_patch" && JSON.parse(e.intent_json).tool === "apply_fix");
  // One journaled run per tier.
  expect(fixes).toHaveLength(2);
});

// Bench round 27, bytelens-update a11ea789 T004 (#1228): `cargo fmt -- <path>` formats the whole
// crate. Its run on an already formatted file rewrote a later planned file, whose own run then
// changed nothing, so the check was not rerun and a model corrective spent 112k tokens on a tree
// that was already formatted.
test("a whole-unit fixer that rewrites a later file through an earlier file's run reruns the check", async () => {
  const wholeUnit: RunPolicy = {
    ...policy,
    checks: policy.checks.map((c) =>
      c.id === "fmt"
        ? {
            ...c,
            fix: {
              executable: "bun",
              // Trims every planned file whatever path it is given, as `cargo fmt` formats the crate.
              args: ["-e", "for (const f of ['a.txt', 'value.txt']) await Bun.write(f, (await Bun.file(f).text()).trim())"],
            },
          }
        : c,
    ),
  };
  const fixture = workflowFixture({ policy: wholeUnit });
  cleanups.push(fixture.dispose);
  const { executor, root } = fixture;
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    const out = await original(request);
    if (request.profile.output === "plan") {
      const task = (out.output as { taskGraph: { tasks: { checkIds: string[]; writes: { path: string; action: string }[] }[] } }).taskGraph.tasks[0];
      if (task) {
        task.checkIds = ["fmt"];
        // The already formatted file comes first, so its fixer run is the one that rewrites value.txt.
        task.writes.unshift({ path: "a.txt", action: "create" });
      }
    }
    if (request.profile.output === "implementation") {
      writeFileSync(join(root, "a.txt"), "a");
      writeFileSync(join(root, "value.txt"), "ready  \n");
    }
    return out;
  };
  const run = await runToEnd(fixture);
  expect((await fixture.service.get(run.runId)).status).toBe("completed");
  expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("ready");
  expect(executor.calls.filter((call) => call === "implementation")).toHaveLength(1);
  expect(fixture.service.store.tasks(run.runId).map((t) => t.id)).toEqual(["T001"]);
});
