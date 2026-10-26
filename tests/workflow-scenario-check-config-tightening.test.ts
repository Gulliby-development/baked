import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 70, nodepluck-update 85131393 (#2221): the brief named tsconfig.json and the one
// flag to turn on (`noUncheckedIndexedAccess: true`, which only makes the checker stricter); the
// approval kept it with a person ("tsconfig and biome configs set what the checks enforce") and
// the run waited 7 min 42 s. Under `requestedCheckTightening` the named tightening is approved, and
// an edit that also loosens the checker (`skipLibCheck`) is a finding that the correction restores.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ORIGINAL = { compilerOptions: { strict: true, skipLibCheck: false } };
const TIGHTENED = { compilerOptions: { ...ORIGINAL.compilerOptions, noUncheckedIndexedAccess: true } };
const LOOSENED = { compilerOptions: { ...TIGHTENED.compilerOptions, skipLibCheck: true } };

/** The tsconfig write goes through the same tool policy and journal as a model edit. */
class TsconfigExecutor extends FixtureExecutor {
  service?: NativeWorkflowService;
  writes = 0;
  constructor(
    private dir: string,
    private first: object,
    private policy: RunPolicy,
  ) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const result = await super.execute(request);
      (result.output as { taskGraph: { tasks: Task[] } }).taskGraph.tasks[0]?.writes.push({ path: "tsconfig.json", action: "modify" });
      return result;
    }
    if (request.profile.output === "implementation" && request.task?.writes.some((w) => w.path === "tsconfig.json")) {
      const root = request.root ?? this.dir;
      const content = this.writes++ === 0 ? this.first : TIGHTENED;
      const guard = new WorkflowToolPolicy(this.service!.store, this.service!.leases, request.runId, request.attemptId, request.profile, this.policy, request.task, root);
      const edits = [["tsconfig.json", `${JSON.stringify(content, null, 2)}\n`], ["value.txt", "ready"]] as const;
      for (const [path, text] of edits.filter(([path]) => request.task?.writes.some((w) => w.path === path)))
        await guard.execute("edit_file", { path }, async () => {
          writeFileSync(join(root, path), text);
          return { success: true };
        });
      return { output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Tightened the type check and wrote the value", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    return super.execute(request);
  }
}

const policyWith = (requestedCheckTightening: boolean): RunPolicy => ({
  ...fixturePolicy,
  autoApproval: {
    renewal: false,
    limits: { maxTasks: 5, maxFiles: 5, allowedPaths: ["value.txt", "src/**", "tests/**"], allowDelete: false, allowNewDependencies: false, maxTotalTokens: fixturePolicy.maxTotalTokens },
    requestedManifestEdits: true,
    ...(requestedCheckTightening ? { requestedCheckTightening } : {}),
  },
});

async function runWith(first: object, policy: RunPolicy) {
  const fixture = workflowFixture({ policy, executor: (root) => new TsconfigExecutor(root, first, policy) });
  cleanups.push(fixture.dispose);
  fixture.executor.service = fixture.service;
  writeFileSync(join(fixture.root, "tsconfig.json"), `${JSON.stringify(ORIGINAL, null, 2)}\n`);
  writeFileSync(join(fixture.root, "app.ts"), "console.log('nodepluck');\n");
  const { service } = fixture;
  const prompt = "Create ready value. Turn on noUncheckedIndexedAccess: true in tsconfig.json.";
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy });
  const done = await service.drive(run.runId, new AbortController().signal);
  const claims = service.store.findings(run.runId).map((f) => (JSON.parse(f.body_json) as { claim: string }).claim);
  const approvals = service.store.requests(run.runId).filter((r) => r.kind === "approval");
  return { done, claims, approvals, tsconfig: JSON.parse(readFileSync(join(fixture.root, "tsconfig.json"), "utf8")) };
}

test("a request-named tsconfig tightening is approved without a person under requestedCheckTightening", async () => {
  const { done, claims, approvals, tsconfig } = await runWith(TIGHTENED, policyWith(true));
  expect(approvals.map((r) => r.actor)).toEqual(["auto-approval"]);
  expect(claims.filter((c) => c.startsWith("Check config "))).toEqual([]);
  expect(done.status).toBe("completed");
  expect(tsconfig).toEqual(TIGHTENED);
}, 120000);

test("an edit that also loosens the named tsconfig gets a finding and is corrected", async () => {
  const { done, claims, approvals, tsconfig } = await runWith(LOOSENED, policyWith(true));
  expect(approvals[0]?.actor).toBe("auto-approval");
  expect(claims).toContain("Check config tsconfig.json changes compilerOptions.skipLibCheck, which is not a tightening the request names");
  expect(done.status).toBe("completed");
  expect(tsconfig).toEqual(TIGHTENED);
}, 120000);

test("without the opt-in the named tsconfig edit still waits for a person, and says how to opt in", async () => {
  const { done, approvals } = await runWith(TIGHTENED, policyWith(false));
  expect(done.status).toBe("waiting");
  const body = JSON.parse(approvals[0]?.body_json ?? "{}") as { autoApproval?: { declined?: string[] } };
  expect(body.autoApproval?.declined?.join("\n")).toContain("tsconfig.json needs a person: a tsconfig config sets what the checks enforce; autoApproval.requestedCheckTightening approves a tightening the request names");
}, 120000);
