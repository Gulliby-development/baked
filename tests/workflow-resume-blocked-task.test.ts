import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;

test("resume retries a task whose implementation did not complete, on the edits already made", async () => {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  // The first implementation edits the file, then stops with an unconfirmed check listed as
  // unresolved, as an implementer does at its step limit. The second finds the edit in place.
  const seen: string[] = [];
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output !== "implementation") return original(request);
    const file = join(root, "value.txt");
    seen.push((() => { try { return readFileSync(file, "utf8"); } catch { return "missing"; } })());
    if (seen.length === 1) {
      const policy = JSON.parse(service.store.run(request.runId).policy_json) as RunPolicy;
      const guard = new WorkflowToolPolicy(service.store, service.leases, request.runId, request.attemptId, request.profile, policy, request.task);
      await guard.execute("edit_file", { path: "value.txt" }, async () => writeFileSync(file, "ready"));
    }
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: seen.length === 1 ? ["lint remains unconfirmed"] : [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  };
  const run = await fixture.start();
  await service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await fixture.resume(run.runId);
  await service.drive(run.runId, signal());

  expect(service.store.run(run.runId)).toMatchObject({ status: "blocked", reason: "invalid_output" });
  expect(service.store.tasks(run.runId).find((t) => t.id === "T001")?.status).toBe("blocked");
  const diagnostic = service.store.events(run.runId).map((e) => e.payload as { kind?: string; artifactId?: string }).findLast((p) => p.kind === "diagnostic");
  expect(service.store.readArtifact(run.runId, diagnostic?.artifactId ?? "")).toContain("lint remains unconfirmed");

  await fixture.resume(run.runId);
  expect(service.store.tasks(run.runId).find((t) => t.id === "T001")?.status).toBe("pending");
  await service.drive(run.runId, signal());
  expect((await service.get(run.runId)).status).toBe("completed");
  expect(seen).toEqual(["missing", "ready"]);
});
