import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 94 (#2878). md-site, run 6b1daed3: review round 3 recorded F2 and
// SEC-002, and the run blocked `no_progress` at maxRepairRounds (2) before either got a repair
// task. After `workflow repair --rounds 1` the next review raised the defect again under a new id
// (F2-2) and SEC-002 not at all; T013 fixed the family and every criterion passed, but F2 and
// SEC-002 stayed open, so acceptance refused the finished run with "Unresolved findings remain".

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class ScriptedExecutor extends FixtureExecutor {
  implementations = 0;
  reviews = 0;
  granted = false;
  constructor(private directory: string) {
    super(directory);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "refutation") {
      const data = JSON.parse(request.prompt.split("\n").at(-1)!);
      return { output: { schemaVersion: 1, findingId: data.extra.finding.id, decision: "confirmed", evidenceIds: data.extra.evidence?.map((e: { id: string }) => e.id) ?? [], explanation: "The value is wrong" }, inputTokens: 20, outputTokens: 30 };
    }
    const result = await super.execute(request);
    if (request.profile.output === "implementation") {
      this.implementations++;
      writeFileSync(join(this.directory, "value.txt"), this.granted ? "ready" : `broken-${this.implementations}`);
    }
    const path = join(this.directory, "value.txt");
    const value = request.profile.output === "review" && existsSync(path) ? readFileSync(path, "utf8") : "ready";
    if (request.profile.output === "review" && value !== "ready") {
      this.reviews++;
      const data = JSON.parse(request.prompt.split("\n").at(-1)!) as { snapshotHash: string; extra: { evidence: { id: string }[] } };
      const finding = (id: string, file: string, claim: string) => ({
        id, kind: "correctness", severity: "high", basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file, symbol: null,
        evidenceIds: data.extra.evidence.map((e) => e.id), claim, impact: "The required value is absent", suggestedFix: "Write ready",
        repro: { executable: "bun", args: ["-e", "console.log(await Bun.file('value.txt').text())"], expected: "ready", actual: value },
      });
      // Before the grant each pass raises the value finding and a second one on the notes file;
      // after it, the value defect comes back under a new claim and the second one not at all.
      const findings = this.granted
        ? [finding("F2", "value.txt", "The value is still not ready after the repair grant")]
        : [finding("F2", "value.txt", `Value is wrong after attempt ${this.implementations}`), finding("SEC", "value.txt", `The value leaks attempt ${this.implementations}`)];
      result.output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [], findings };
    }
    return result;
  }
}

async function blockedAtReviewCap() {
  const policy: RunPolicy = {
    ...fixturePolicy,
    maxRepairRounds: 2,
    checks: fixturePolicy.checks.map((c) => ({ ...c, scope: "feature" as const, args: ["-e", "process.exit(0)"] })),
  };
  let executor: ScriptedExecutor | undefined;
  const fixture = workflowFixture({ policy, executor: (root) => (executor = new ScriptedExecutor(root)) });
  cleanups.push(fixture.dispose);
  const { service } = fixture;
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  const stopped = await service.drive(run.runId, new AbortController().signal);
  return { service, runId: run.runId, stopped, executor: executor! };
}

describe("scenario: findings recorded at the repair cap are retired after a grant (#2878)", () => {
  test("a finding the next pass does not raise again no longer blocks acceptance", async () => {
    const { service, runId, stopped, executor } = await blockedAtReviewCap();
    expect(stopped.status).toBe("blocked");
    expect(stopped.reason).toBe("no_progress");
    expect(stopped.repairBlock?.limit).toBe("maxRepairRounds");
    // The findings of the refused pass were recorded and got no repair task.
    const ids = stopped.repairBlock?.stranded?.findingIds ?? [];
    expect(stopped.repairBlock?.stranded?.pass).toBe("review");
    expect(ids).toHaveLength(2);
    const stranded = service.store.findings(runId).filter((f) => ids.includes(f.id));
    expect(stranded.every((f) => f.repair_task_id === null && f.status !== "resolved")).toBe(true);

    executor.granted = true;
    await service.repair(runId, { commandId: newId(), expectedRevision: stopped.revision }, 1);
    expect(service.store.state(runId).strandedFindings.map((f) => f.id).sort()).toEqual([...ids].sort());
    const done = await service.drive(runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(readFileSync(join(service.workspace, "value.txt"), "utf8")).toBe("ready");
    expect(service.store.findings(runId).filter((f) => !["refuted", "resolved"].includes(f.status))).toEqual([]);
    expect(service.store.state(runId).strandedFindings).toEqual([]);
    const records = service.store
      .artifacts(runId)
      .filter((a) => a.logical_path.startsWith("stranded-findings/"))
      .map((a) => JSON.parse(service.store.readArtifact(runId, a.id)) as { pass: string; retired: string[] });
    expect(records).toHaveLength(1);
    expect(records[0]!.pass).toBe("review");
    expect([...records[0]!.retired].sort()).toEqual([...ids].sort());
  }, 60000);
});
