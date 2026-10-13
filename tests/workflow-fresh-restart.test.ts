import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runReport } from "../src/core/workflows/run-report.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

/** Writes a wrong value for the first `broken` implementations, so the check fails the same way. */
class BrokenExecutor extends FixtureExecutor {
  implementations = 0;
  constructor(
    private dir: string,
    private broken: number,
  ) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "implementation" && ++this.implementations <= this.broken)
      // A different wrong value each time: an attempt that changes nothing is refused earlier.
      writeFileSync(join(this.dir, "value.txt"), `broken ${String(this.implementations)}`);
    return result;
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;
type Extra = {
  freshStart?: { summary: string };
  evidence?: { id: string; kind: string }[];
  task?: { id: string; description: string };
};
const extraOf = (prompt: string): Extra =>
  (JSON.parse(prompt.split("\n").at(-1) ?? "{}") as { extra: Extra }).extra;

async function run(broken: number) {
  const fx = workflowFixture({ executor: (root) => new BrokenExecutor(root, broken) });
  cleanups.push(() => fx.dispose());
  const started = await fx.start();
  await fx.service.drive(started.runId, signal());
  await fx.approve(started.runId);
  const final = await fx.service.drive(started.runId, signal());
  return { fx, runId: started.runId, final };
}

describe("fresh-context restart", () => {
  test("the correction after two identical failures starts clean and fixes it", async () => {
    const { fx, runId, final } = await run(3);
    expect(final.status).toBe("completed");
    const prompts = (fx.executor.prompts.implementation ?? []).map(extraOf);
    expect(prompts).toHaveLength(4);
    // The first repeat is told to probe; the second starts from a clean context.
    expect(prompts[2]?.task?.description).toContain("run_probe");
    expect(prompts[2]?.freshStart).toBeUndefined();
    const fresh = prompts[3];
    expect(fresh?.task?.description).not.toContain("run_probe");
    expect(fresh?.freshStart?.summary).toContain("2 earlier correction(s)");
    expect(fresh?.freshStart?.summary).toContain("changed value.txt");
    // Only the evidence its own finding cites: no diffs of the earlier attempts.
    expect(fresh?.evidence?.map((e) => e.kind)).toEqual(["command"]);
    expect((prompts[2]?.evidence ?? []).length).toBeGreaterThan(1);
    const id = fresh?.task?.id ?? "";
    expect(fx.service.store.latestArtifact(runId, `tasks/${id}/fresh-start.json`)).not.toBeNull();
    expect(runReport(fx.service.store, runId)).toContain("repair, fresh context");
  }, 120000);

  test("a clean-context correction that fails the same way stops the run", async () => {
    const { fx, runId, final } = await run(4);
    expect(final.status).toBe("blocked");
    expect(fx.service.store.run(runId).reason).toBe("no_progress");
    expect(fx.executor.prompts.implementation).toHaveLength(4);
  }, 120000);
});
