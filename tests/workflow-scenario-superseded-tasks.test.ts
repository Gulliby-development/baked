import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { runReport } from "../src/core/workflows/run-report.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const markdown = "# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture";
const task = (id: string, path: string) => ({ id, title: `Write ${path}`, description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path, action: "create" as const }], readHints: [], checkIds: [], origin: "planned" as const, findingIds: [], rationale: "Required behavior" });

describe("task rows of a superseded plan revision (#1190)", () => {
  test("are gone once a revision drops them, so a completed run reports all its tasks done", async () => {
    // cfgtrace 16d84947, bench round 25: revisions 1 and 2 had 18 and 19 tasks, the approved one 12;
    // the run completed with "15 of 19 done" and T016 to T019 pending forever.
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service, executor, root } = fixture;
    const original = executor.execute.bind(executor);
    let plans = 0;
    let analyses = 0;
    executor.execute = async (request: ExecutionRequest) => {
      const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
      if (request.profile.output === "plan") {
        plans++;
        // The first revision plans a second file; the revision analysis asks for drops it.
        const tasks = plans === 1 ? [task("T001", "value.txt"), task("T002", "extra.txt")] : [task("T001", "value.txt")];
        return { output: { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown), tasks } }, inputTokens: 25, outputTokens: 25 };
      }
      if (request.profile.output === "analysis") {
        analyses++;
        const findings = analyses === 1 ? [{ id: "F001", kind: "inconsistency", refs: ["tasks.json", "T002"], description: "T002 writes extra.txt, which no requirement asks for", blocking: true }] : [];
        return { output: { schemaVersion: 1, inputHash: data.inputHash, verdict: findings.length ? "needs_revision" : "pass", findings }, inputTokens: 25, outputTokens: 25 };
      }
      if (request.profile.output === "implementation") writeFileSync(join(root, "value.txt"), "ready");
      return original(request);
    };
    const run = await fixture.start();
    expect(await service.drive(run.runId, new AbortController().signal)).toMatchObject({ status: "waiting", reason: "approval" });
    expect(plans).toBe(2);
    expect(service.store.tasks(run.runId).map((t) => t.id)).toEqual(["T001"]);
    await fixture.approve(run.runId);
    expect((await service.drive(run.runId, new AbortController().signal)).status).toBe("completed");
    expect(runReport(service.store, run.runId)).toContain("1 of 1 done.");
  });

  test("a task a later revision cancelled is not counted as owed work", () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { store } = fixture.service;
    return fixture.start().then((run) => {
      const graph = (tasks: ReturnType<typeof task>[]) => ({ schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks });
      store.syncTasks(run.runId, graph([task("T001", "value.txt"), task("T002", "extra.txt")]));
      // A revision after approval invalidates: the dropped task is cancelled, not deleted.
      store.syncTasks(run.runId, graph([task("T001", "value.txt")]), true);
      expect(store.tasks(run.runId).find((t) => t.id === "T002")?.status).toBe("cancelled");
      expect(runReport(store, run.runId)).toContain("0 of 1 done; 1 cancelled by a plan revision.");
    });
  });
});
