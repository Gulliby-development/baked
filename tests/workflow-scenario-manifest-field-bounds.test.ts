import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import type { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 53, pgnvet-update 438ba5e5 (#1793): the brief named one package.json edit, an
// `engines` field; the request-named exemption approved the write by its path, so nothing held the
// plan to that field. Here the first implementation also adds a `postinstall` script.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ORIGINAL = { name: "pgnvet", version: "1.0.0", scripts: { test: "bun test" } };
const ENGINES = { ...ORIGINAL, engines: { bun: ">=1.4.0" } };
const POLLUTED = { ...ENGINES, scripts: { ...ORIGINAL.scripts, postinstall: "node fetch.js" } };

/** The manifest write goes through the same tool policy and journal as a model edit. */
class EnginesExecutor extends FixtureExecutor {
  service?: NativeWorkflowService;
  writes = 0;
  constructor(
    private dir: string,
    private first: object,
  ) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "spec") {
      const result = await super.execute(request);
      return { ...result, output: { ...(result.output as Spec), deliverables: [{ quote: "engines", requirementIds: ["FR-001"] }] } };
    }
    if (request.profile.output === "plan") {
      const result = await super.execute(request);
      (result.output as { taskGraph: { tasks: Task[] } }).taskGraph.tasks[0]?.writes.push({ path: "package.json", action: "modify" });
      return result;
    }
    if (request.profile.output === "implementation" && request.task?.writes.some((w) => w.path === "package.json")) {
      const root = request.root ?? this.dir;
      const content = this.writes++ === 0 ? this.first : ENGINES;
      const guard = new WorkflowToolPolicy(this.service!.store, this.service!.leases, request.runId, request.attemptId, request.profile, policy, request.task, root);
      const edits = [["package.json", `${JSON.stringify(content, null, 2)}\n`], ["value.txt", "ready"]] as const;
      for (const [path, text] of edits.filter(([path]) => request.task?.writes.some((w) => w.path === path)))
        await guard.execute("edit_file", { path }, async () => {
          writeFileSync(join(root, path), text);
          return { success: true };
        });
      return { output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Updated the manifest and value", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
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

async function runWith(first: object) {
  const fixture = workflowFixture({ policy, executor: (root) => new EnginesExecutor(root, first) });
  cleanups.push(fixture.dispose);
  fixture.executor.service = fixture.service;
  writeFileSync(join(fixture.root, "package.json"), `${JSON.stringify(ORIGINAL, null, 2)}\n`);
  writeFileSync(join(fixture.root, "app.ts"), "console.log('pgnvet');\n");
  const { service } = fixture;
  const prompt = 'Create ready value. Add one field to package.json: engines, with exactly { "bun": ">=1.4.0" }.';
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy });
  const done = await service.drive(run.runId, new AbortController().signal);
  const claims = service.store.findings(run.runId).map((f) => (JSON.parse(f.body_json) as { claim: string }).claim);
  const approvals = service.store.requests(run.runId).filter((r) => r.kind === "approval").map((r) => r.actor);
  return { done, claims, approvals, manifest: JSON.parse(readFileSync(join(fixture.root, "package.json"), "utf8")) };
}

test("a request-named package.json edit that also adds a postinstall script gets a finding and is corrected", async () => {
  const { done, claims, approvals, manifest } = await runWith(POLLUTED);
  expect(approvals[0]).toBe("auto-approval");
  expect(claims).toContain("Manifest package.json changes scripts.postinstall, which the request does not name");
  expect(done.status).toBe("completed");
  expect(manifest).toEqual(ENGINES);
});

test("the edit of the named field alone passes with no person and no finding", async () => {
  const { done, claims, approvals, manifest } = await runWith(ENGINES);
  expect(approvals).toEqual(["auto-approval"]);
  expect(claims.filter((c) => c.startsWith("Manifest "))).toEqual([]);
  expect(done.status).toBe("completed");
  expect(manifest).toEqual(ENGINES);
});
