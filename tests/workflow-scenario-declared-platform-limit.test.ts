import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  declaredPlatformLimits,
  settledConflicts,
} from "../src/core/workflows/conflict-decisions.js";
import { runReport } from "../src/core/workflows/run-report.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 44, url-shortener ae4b9d3d (#1536): corrective T005 implemented the URL-serialized
// Location and wrote "Platform limit: Fetch headers cannot carry raw non-ASCII text" in its
// implemented result. Nothing recorded it as settled, so the next review asked for the raw
// Location again and T006 paid 1.2M tokens to report the same limit as a spec conflict.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const LIMIT = "Fetch headers cannot carry raw non-ASCII text, so Location uses the URL-serialized form";

type Declare = "prose" | "typed";

/**
 * The task implements the feasible behavior and declares the limit. The reviewers follow their
 * rule: a finding that asks again for what a declared limit rules out is basis inferred.
 */
class LimitExecutor extends FixtureExecutor {
  corrections = 0;
  reviewExtras: Record<string, unknown>[] = [];
  constructor(
    private dir: string,
    private declare: Declare,
  ) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as {
      snapshotHash: string;
      extra: Record<string, unknown> & { evidence?: { id: string }[]; finding?: { id: string } };
    };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    switch (request.profile.output) {
      case "implementation": {
        if (request.task?.origin !== "planned") this.corrections++;
        writeFileSync(join(this.dir, "value.txt"), "ready");
        const summary =
          this.declare === "prose" ? `Wrote the redirect. Platform limit: ${LIMIT}.` : "Wrote the redirect";
        return {
          output: {
            schemaVersion: 1,
            taskId: request.task?.id,
            outcome: "implemented",
            summary,
            evidenceIds: [],
            unresolved: [],
            ...(this.declare === "typed"
              ? { platformLimits: [{ claim: LIMIT, evidence: "run_probe: new Headers({ Location }) threw TypeError" }] }
              : {}),
          },
          inputTokens: 25,
          outputTokens: 25,
        };
      }
      case "review": {
        this.reviewExtras.push(data.extra);
        if (this.reviewExtras.length > 1) return super.execute(request);
        const settled = (data.extra.settledConflicts ?? []) as { declared?: boolean }[];
        return {
          output: {
            schemaVersion: 1,
            snapshotHash: data.snapshotHash,
            verdict: "changes_requested",
            coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: "Location" }],
            findings: [
              {
                id: "F1",
                kind: "correctness",
                severity: "high",
                basis: settled.some((c) => c.declared) ? "inferred" : "spec",
                requirementIds: ["FR-001"],
                criterionIds: ["AC-001"],
                file: "value.txt",
                symbol: null,
                evidenceIds,
                claim: "The redirect relaxes the exact Location requirement: the raw Unicode URL is not sent",
                impact: "AC-001 asks for the stored URL as given",
                suggestedFix: "Send the raw URL in Location",
              },
            ],
          },
          inputTokens: 25,
          outputTokens: 25,
        };
      }
      case "refutation":
        return {
          output: { schemaVersion: 1, findingId: data.extra.finding?.id, decision: "confirmed", evidenceIds, explanation: "Confirmed" },
          inputTokens: 25,
          outputTokens: 25,
        };
      default:
        return super.execute(request);
    }
  }
}

async function run(declare: Declare) {
  const fixture = workflowFixture({ executor: (root) => new LimitExecutor(root, declare) });
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  const started = await fixture.start();
  await service.drive(started.runId, new AbortController().signal);
  await fixture.approve(started.runId);
  await service.drive(started.runId, new AbortController().signal);
  return { service, executor, runId: started.runId };
}

for (const declare of ["prose", "typed"] as const) {
  test(`a platform limit an implemented result declares (${declare}) is settled for the next review`, async () => {
    const { service, executor, runId } = await run(declare);
    const settled = settledConflicts(service.store, runId);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ path: "assumptions/limits/T001.json", taskId: "T001", declared: true });
    expect(settled[0]?.report).toContain("Fetch headers cannot carry raw non-ASCII text");
    expect(executor.reviewExtras[0]?.settledConflicts).toEqual(settled);
    // The finding that asks for the raw value again is a note: no corrective task runs.
    expect(executor.corrections).toBe(0);
    expect((await service.get(runId)).status).toBe("completed");
    expect(runReport(service.store, runId)).toContain("T001 (declared limit)");
  });
}

test("only a finished result declares a limit, and its summary only names the matching sentence", () => {
  const prose = { outcome: "implemented", summary: `Wrote the redirect. Platform limit: ${LIMIT}. Added tests.`, unresolved: [] };
  expect(declaredPlatformLimits(prose)).toEqual([{ claim: `Platform limit: ${LIMIT}.` }]);
  expect(declaredPlatformLimits({ ...prose, outcome: "already_satisfied" })).toHaveLength(1);
  expect(declaredPlatformLimits({ ...prose, outcome: "blocked" })).toEqual([]);
  expect(declaredPlatformLimits({ ...prose, outcome: "spec_conflict" })).toEqual([]);
  expect(declaredPlatformLimits({ outcome: "implemented", summary: "Wrote the redirect and its tests." })).toEqual([]);
});

test("every reviewer that gets settled conflicts is told how to treat a declared limit", async () => {
  const { builtinProfiles } = await import("../src/core/agents/profiles/builtin.js");
  for (const id of ["reviewer", "language-reviewer", "spec-auditor", "acceptance-walker"]) {
    const text = builtinProfiles.find((p) => p.id === id)?.instructions ?? "";
    expect([id, text.includes("extra.settledConflicts")]).toEqual([id, true]);
    expect([id, /platform limit/i.test(text)]).toEqual([id, true]);
  }
});
