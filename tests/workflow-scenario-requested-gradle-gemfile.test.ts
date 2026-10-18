import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const policy: RunPolicy = {
  ...fixturePolicy,
  registryLookups: false,
  autoApproval: {
    renewal: false,
    requestedManifestEdits: true,
    limits: { maxTasks: 5, maxFiles: 5, allowedPaths: ["value.txt"], allowDelete: false, allowNewDependencies: false, maxTotalTokens: fixturePolicy.maxTotalTokens },
  },
};

// #1552: the brief names an existing manifest outside allowedPaths. It may edit configuration,
// but adding an unrequested package must still produce a blocking finding before checks run.
class ScriptedExecutor extends FixtureExecutor {
  corrections = 0;
  constructor(private dir: string, private path: string, private baseline: string, private addition: string) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const result = await super.execute(request);
      (result.output as { taskGraph: { tasks: Task[] } }).taskGraph.tasks[0]?.writes.push({ path: this.path, action: "modify" });
      return result;
    }
    if (request.profile.output === "implementation") {
      const correcting = request.task?.origin !== "planned";
      if (correcting) this.corrections++;
      writeFileSync(join(this.dir, this.path), `${this.baseline}${correcting ? "" : this.addition}`);
    }
    return super.execute(request);
  }
}

for (const path of ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "Gemfile"]) {
  const baseline = path === "Gemfile" ? 'source "https://rubygems.org"\n' : "dependencies {}\n";
  test(`requested ${path} outside allowedPaths completes without a person`, async () => {
    const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root, path, baseline, path === "Gemfile" ? "# Configure the project\n" : "rootProject.name = \"fixture\"\n") });
    cleanups.push(fixture.dispose);
    writeFileSync(join(fixture.root, path), baseline);
    writeFileSync(join(fixture.root, "existing.ts"), "export const existing = 1;\n");
    fixture.service.scheduler.semgrep = null;
    const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: `Create ready value. Update ${path}.`, ownerLabel: "test", policy });
    const done = await fixture.service.drive(run.runId, new AbortController().signal);
    expect(fixture.service.store.requests(run.runId).filter((r) => r.kind === "approval").map((r) => r.actor)).toEqual(["auto-approval"]);
    expect(done.status).toBe("completed");
    expect(fixture.executor.corrections).toBe(0);
  }, 90_000);

  test(`requested ${path} cannot add an unrequested dependency`, async () => {
    const name = path === "Gemfile" ? "rake" : "org.example:unrequested";
    const addition = path === "Gemfile" ? 'gem "rake", "~> 13"\n' : 'dependencies { implementation("org.example:unrequested:1.0") }\n';
    const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root, path, baseline, addition) });
    cleanups.push(fixture.dispose);
    writeFileSync(join(fixture.root, path), baseline);
    writeFileSync(join(fixture.root, "existing.ts"), "export const existing = 1;\n");
    fixture.service.scheduler.semgrep = null;
    const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: `Create ready value. Update ${path}.`, ownerLabel: "test", policy });
    const done = await fixture.service.drive(run.runId, new AbortController().signal);
    const finding = fixture.service.store.findings(run.runId).find((f) => String(JSON.parse(f.body_json).claim).startsWith(`Dependency ${name}: `));
    expect(finding).toBeDefined();
    expect(JSON.parse(finding!.body_json).claim).toContain("allowNewDependencies is false");
    expect(finding!.status).toBe("resolved");
    expect(fixture.executor.corrections).toBe(1);
    expect(readFileSync(join(fixture.root, path), "utf8")).toBe(baseline);
    expect(done.status).toBe("completed");
  }, 90_000);
}
