import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runWithCwd } from "../src/core/cwd.js";
import { editFileTool } from "../src/core/tools/edit-file.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { installRuffFormatter } from "./helpers/post-edit-formatter.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// R47 cochange-update (#1582): a three-line Python update repeatedly reformatted old code.
// The reviewer could not accept the change, and corrective edits reformatted it again.
const before = "legacy=1\nlabel = 'keep'\nlimit = 3\n";
const expected = before.replace("limit = 3", "limit = 4");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class ScriptedExecutor extends FixtureExecutor {
  implementations = 0;
  formatFindings: string[] = [];
  constructor(private dir: string) { super(dir); }

  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "implementation") {
      this.implementations++;
      const file = join(request.root ?? this.dir, "args.py");
      const current = readFileSync(file, "utf8");
      const result = await runWithCwd(request.root ?? this.dir, () => editFileTool.execute({
        path: file, oldString: current, newString: expected,
      }));
      if (!result.success) throw new Error(result.output);
    }
    const out = await super.execute(request);
    if (request.profile.output === "plan") {
      const graph = (out.output as { taskGraph: { tasks: { description: string; writes: { path: string; action: string }[] }[] } }).taskGraph;
      graph.tasks[0]!.description = "Change limit from 3 to 4 in args.py. Do not reformat unrelated code.";
      graph.tasks[0]!.writes.push({ path: "args.py", action: "modify" });
    }
    if (request.profile.output === "review") {
      const actual = readFileSync(join(request.root ?? this.dir, "args.py"), "utf8");
      if (actual !== expected) this.formatFindings.push("args.py: reformats unrelated existing code");
    }
    return out;
  }
}

describe("scenario: cochange brownfield update without unrelated formatting (#1582)", () => {
  test("the shared edit tool finishes one planned task with no formatting finding", async () => {
    const formatter = installRuffFormatter();
    cleanups.push(formatter.dispose);
    const fixture = workflowFixture({ policy: fixturePolicy, executor: (root) => new ScriptedExecutor(root) });
    cleanups.push(fixture.dispose);
    writeFileSync(join(fixture.root, "pyproject.toml"), "[tool.ruff]\n");
    writeFileSync(join(fixture.root, "args.py"), before);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const outcome = await fixture.service.drive(run.runId, new AbortController().signal);
    expect(outcome.status).toBe("completed");
    expect(fixture.executor.implementations).toBe(1);
    expect(fixture.executor.calls).toContain("review");
    expect(fixture.executor.formatFindings).toEqual([]);
    expect(readFileSync(join(fixture.root, "args.py"), "utf8")).toBe(expected);
  }, 60_000);
});
