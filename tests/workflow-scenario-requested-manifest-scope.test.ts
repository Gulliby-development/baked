import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 45, spdxok-update b270088e (#1547): the brief named the `[project.scripts]` edit of
// pyproject.toml, the scaffold's allowed paths left the manifest out, and auto approval passed the
// always-human test but declined the write as outside the allowed paths; a person approved it 31
// minutes later.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class ManifestExecutor extends FixtureExecutor {
  constructor(private dir: string) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "spec") {
      const result = await super.execute(request);
      return { ...result, output: { ...(result.output as Spec), deliverables: [{ quote: "a [project.scripts] table", requirementIds: ["FR-001"] }] } };
    }
    if (request.profile.output === "plan") {
      const result = await super.execute(request);
      (result.output as { taskGraph: { tasks: Task[] } }).taskGraph.tasks[0]?.writes.push({ path: "pyproject.toml", action: "modify" });
      return result;
    }
    if (request.profile.output === "implementation")
      writeFileSync(join(this.dir, "pyproject.toml"), '[project]\nname = "spdxok"\n\n[project.scripts]\nspdxok = "spdxok.cli:main"\n');
    return super.execute(request);
  }
}

const policy: RunPolicy = {
  ...fixturePolicy,
  autoApproval: {
    renewal: false,
    limits: { maxTasks: 5, maxFiles: 5, allowedPaths: ["value.txt", "spdxok/**", "tests/**"], allowDelete: false, allowNewDependencies: false, maxTotalTokens: fixturePolicy.maxTotalTokens },
    requestedManifestEdits: true,
  },
};

async function runWith(prompt: string) {
  const fixture = workflowFixture({ policy, executor: (root) => new ManifestExecutor(root) });
  cleanups.push(fixture.dispose);
  writeFileSync(join(fixture.root, "pyproject.toml"), '[project]\nname = "spdxok"\n');
  writeFileSync(join(fixture.root, "app.py"), "print('spdxok')\n");
  const { service } = fixture;
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy });
  const done = await service.drive(run.runId, new AbortController().signal);
  const approvals = service.store.requests(run.runId).filter((r) => r.kind === "approval");
  const declined = JSON.parse(approvals.at(-1)?.body_json ?? "{}").autoApproval?.declined ?? [];
  return { done, approvals, declined: declined as string[] };
}

test("a manifest edit the request names is approved although the allowed paths leave the manifest out", async () => {
  const { done, approvals, declined } = await runWith("Create ready value. Add a [project.scripts] table to pyproject.toml so the spdxok command starts the CLI.");
  expect(declined).toEqual([]);
  expect(approvals.map((r) => r.actor)).toEqual(["auto-approval"]);
  expect(done.status).toBe("completed");
});

test("a request that keeps the manifest as is still sends the edit to a person", async () => {
  const { done, declined } = await runWith("Create ready value. Do not change pyproject.toml.");
  expect(done.reason).toBe("approval");
  expect(declined.join("\n")).toContain("pyproject.toml always needs a person");
});
