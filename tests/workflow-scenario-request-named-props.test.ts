import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 51, dieodds-update 5a88921f (#1710): the brief named a new root Directory.Build.props
// and its content, the planner was told the write was fine, and auto approval declined it as
// outside the update scaffold's allowed paths; a person approved it 86 s later.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PROPS = "<Project>\n  <PropertyGroup>\n    <Version>0.1.0</Version>\n  </PropertyGroup>\n</Project>\n";
const EXEC = '<Project>\n  <Target Name="Stamp" BeforeTargets="Build">\n    <Exec Command="git describe" />\n  </Target>\n</Project>\n';

class PropsExecutor extends FixtureExecutor {
  constructor(
    dir: string,
    private content: string,
  ) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const tasks = (result.output as { taskGraph: { tasks: Task[] } }).taskGraph.tasks;
      const first = tasks[0];
      if (first)
        tasks.push({
          ...first,
          id: "T900",
          title: "Write Directory.Build.props",
          dependsOn: [],
          writes: [{ path: "Directory.Build.props", action: "create", content: this.content }],
          checkIds: [],
        });
    }
    return result;
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

async function runWith(content: string) {
  const fixture = workflowFixture({ policy, executor: (root) => new PropsExecutor(root, content) });
  cleanups.push(fixture.dispose);
  writeFileSync(join(fixture.root, "app.cs"), "class App {}\n");
  const { service } = fixture;
  const prompt = `Create ready value. Create Directory.Build.props with ${content.replaceAll("\n", " ")}`;
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy });
  const done = await service.drive(run.runId, new AbortController().signal);
  const approvals = service.store.requests(run.runId).filter((r) => r.kind === "approval");
  const declined = JSON.parse(approvals.at(-1)?.body_json ?? "{}").autoApproval?.declined ?? [];
  return { done, approvals, declined: declined as string[], root: fixture.root };
}

test("a request-named Directory.Build.props with properties only is approved and written", async () => {
  const { done, approvals, declined, root } = await runWith(PROPS);
  expect(declined).toEqual([]);
  expect(approvals.map((r) => r.actor)).toEqual(["auto-approval"]);
  expect(done.status).toBe("completed");
  expect(existsSync(join(root, "Directory.Build.props")) && readFileSync(join(root, "Directory.Build.props"), "utf8")).toBe(PROPS);
});

test("one that runs a command goes to a person with the rule, not the allowed paths", async () => {
  const { done, declined } = await runWith(EXEC);
  expect(done.reason).toBe("approval");
  expect(declined.join("\n")).toContain("Directory.Build.props needs a person: MSBuild props and targets run build logic");
  expect(declined.join("\n")).not.toContain("outside the allowed paths");
});
