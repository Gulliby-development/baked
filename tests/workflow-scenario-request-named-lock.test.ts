import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import type { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 60, sketchfold-update 96e1f058 (#1934): the brief named a version bump and the one
// lock line that follows it; the approval declined the lock and the run waited 26 minutes for a
// person. A request-named lock that records the project's own version is now approved, and the
// manifest field check holds every other entry of it: here the first implementation also moves a
// dependency.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const manifest = (version: string) => ({ name: "sketchfold", version, scripts: { test: "bun test" }, dependencies: { a: "^1.0.0" } });
const lock = (version: string, dep = "1.0.0") => ({
  name: "sketchfold",
  version,
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "sketchfold", version, dependencies: { a: "^1.0.0" } },
    "node_modules/a": { version: dep, resolved: `https://registry.npmjs.org/a/-/a-${dep}.tgz` },
  },
});
const json = (value: object) => `${JSON.stringify(value, null, 2)}\n`;

class BumpExecutor extends FixtureExecutor {
  service?: NativeWorkflowService;
  lockWrites = 0;
  constructor(
    private dir: string,
    private firstLock: object,
  ) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "spec") {
      const result = await super.execute(request);
      return { ...result, output: { ...(result.output as Spec), deliverables: [{ quote: "0.2.0", requirementIds: ["FR-001"] }] } };
    }
    if (request.profile.output === "plan") {
      const result = await super.execute(request);
      const tasks = (result.output as { taskGraph: { tasks: Task[] } }).taskGraph.tasks;
      tasks[0]?.writes.push({ path: "package.json", action: "modify" }, { path: "package-lock.json", action: "modify" });
      return result;
    }
    const writes = request.task?.writes ?? [];
    if (request.profile.output === "implementation" && writes.some((w) => w.path === "package-lock.json")) {
      const root = request.root ?? this.dir;
      const nextLock = this.lockWrites++ === 0 ? this.firstLock : lock("0.2.0");
      const guard = new WorkflowToolPolicy(this.service!.store, this.service!.leases, request.runId, request.attemptId, request.profile, policy, request.task, root);
      const edits = [["package.json", json(manifest("0.2.0"))], ["package-lock.json", json(nextLock)], ["value.txt", "ready"]] as const;
      for (const [path, text] of edits.filter(([path]) => writes.some((w) => w.path === path)))
        await guard.execute("edit_file", { path }, async () => {
          writeFileSync(join(root, path), text);
          return { success: true };
        });
      return { output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Bumped the version", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    return super.execute(request);
  }
}

const policy: RunPolicy = {
  ...fixturePolicy,
  autoApproval: {
    renewal: false,
    limits: { maxTasks: 5, maxFiles: 5, allowedPaths: ["value.txt", "src/**", "tests/**"], allowDelete: false, allowNewDependencies: false, maxTotalTokens: fixturePolicy.maxTotalTokens },
    requestedManifestEdits: true,
  },
};

async function runWith(firstLock: object) {
  const fixture = workflowFixture({ policy, executor: (root) => new BumpExecutor(root, firstLock) });
  cleanups.push(fixture.dispose);
  fixture.executor.service = fixture.service;
  writeFileSync(join(fixture.root, "package.json"), json(manifest("0.1.0")));
  writeFileSync(join(fixture.root, "package-lock.json"), json(lock("0.1.0")));
  writeFileSync(join(fixture.root, "app.ts"), "console.log('sketchfold');\n");
  const { service } = fixture;
  const prompt = "Create ready value. Change the version in package.json from 0.1.0 to 0.2.0. package-lock.json follows the manifest and changes only the project's own version.";
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy });
  const done = await service.drive(run.runId, new AbortController().signal);
  const claims = service.store.findings(run.runId).map((f) => (JSON.parse(f.body_json) as { claim: string }).claim);
  const approvals = service.store.requests(run.runId).filter((r) => r.kind === "approval").map((r) => r.actor);
  return { done, claims, approvals, lock: JSON.parse(readFileSync(join(fixture.root, "package-lock.json"), "utf8")) };
}

test("a request-named lock that only follows the version bump passes with no person and no finding", async () => {
  const { done, claims, approvals, lock: written } = await runWith(lock("0.2.0"));
  expect(approvals).toEqual(["auto-approval"]);
  expect(claims.filter((c) => c.startsWith("Manifest "))).toEqual([]);
  expect(done.status).toBe("completed");
  expect(written).toEqual(lock("0.2.0"));
});

test("a request-named lock that also moves a dependency gets a finding and is corrected", async () => {
  const { done, claims, approvals, lock: written } = await runWith(lock("0.2.0", "1.0.1"));
  expect(approvals[0]).toBe("auto-approval");
  expect(claims).toContain("Manifest package-lock.json changes package node_modules/a, which the request does not name");
  expect(done.status).toBe("completed");
  expect(written).toEqual(lock("0.2.0"));
});
