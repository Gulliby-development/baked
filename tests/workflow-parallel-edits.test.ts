import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("edits of one file issued in parallel in one step all apply (#955)", async () => {
  // depwave db4612f3: a claude model sent three edit_file calls for one file in one step; the
  // second saw the first one's write before its effect was journaled and was refused as a change
  // made outside the attempt.
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const file = join(root, "value.txt");
  const errors: string[] = [];
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output !== "implementation") return original(request);
    const policy = JSON.parse(service.store.run(request.runId).policy_json) as RunPolicy;
    const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, policy, request.task);
    // Each edit writes at once and then does its follow-up work (formatting, diagnostics).
    const edit = (text: string) =>
      guard
        .execute("edit_file", { path: "value.txt" }, async () => {
          let current = "";
          try {
            current = readFileSync(file, "utf8");
          } catch {}
          writeFileSync(file, current + text);
          await tick();
          return { success: true };
        })
        .catch((error: Error) => {
          errors.push(error.message);
        });
    await Promise.all([edit("re"), edit("ad"), edit("y")]);
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  };
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await fixture.resume(run.runId);
  await service.drive(run.runId, signal());
  expect(errors).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe("ready");
  const effects = service.store.effects(run.runId).filter((e) => e.kind === "file_patch");
  expect(effects.map((e) => e.status)).toEqual(["applied", "applied", "applied"]);
  expect((await service.get(run.runId)).status).toBe("completed");
});
