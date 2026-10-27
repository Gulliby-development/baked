import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reproBlind, reproOutsidePaths } from "../src/core/verification/repro.js";
import { ReviewSchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// R73 evalpin `checks` b38e180d (#2287): the reviewer's probe read another copy of the code, so
// every repro run after a fix printed the same bytes and the corrective spent 2.45M tokens. #2279
// rewrites the run's own roots; a copy elsewhere (an installed package, a cached build) it cannot
// see. A repro that prints the same output after the attempt changed the finding's file, and
// names a path outside its root, now records a `repro_blind` would-stop (shadow).

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("a repro blind to its correction (#2287)", () => {
  test("paths outside the root, after the run's own roots are rewritten", () => {
    const root = "/work/app/.baked/worktrees/r1/T003";
    const repro = (args: string[], content = "") => ({ args, files: content ? [{ name: "probe.ts", content }] : [] });
    // {root}, the review's worktree and the workspace are the root once rewritten.
    expect(reproOutsidePaths(repro(["{root}/src/a.ts", "/work/app/.baked/worktrees/r1/main/src/a.ts", "/work/app/src/a.ts"]), root)).toEqual([]);
    expect(reproOutsidePaths(repro(["{files}/probe.ts", "/dev/null"], 'import "https://x.test/a"; const half = 4 /2;'), root)).toEqual([]);
    expect(reproOutsidePaths(repro(["run", "/usr/lib/node_modules/evalpin/dist/cli.js"], 'path = "C:\\\\Users\\\\me\\\\.cargo\\\\registry\\\\evalpin"'), root)).toEqual([
      "/usr/lib/node_modules/evalpin/dist/cli.js",
      "C:\\Users\\me\\.cargo\\registry\\evalpin",
    ]);
    // A Windows root a string literal escapes is still the root.
    const win = "C:\\work\\app";
    expect(reproOutsidePaths(repro(["-e", `read(${JSON.stringify(`${win}\\src\\a.ts`)})`]), win)).toEqual([]);
  });

  test("blind only when it reproduces, the file changed, the output did not, and it reads outside the root", () => {
    const base = { status: "reproduced" as const, fileChanged: true, sameOutput: true, outside: 1 };
    expect(reproBlind(base)).toBe(true);
    expect(reproBlind({ ...base, status: "refuted" })).toBe(false);
    expect(reproBlind({ ...base, fileChanged: false })).toBe(false);
    expect(reproBlind({ ...base, sameOutput: false })).toBe(false);
    expect(reproBlind({ ...base, outside: 0 })).toBe(false);
  });
});

const policy: RunPolicy = { ...fixturePolicy, checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", "process.exit(0)"] }] };

/** The repro reads an installed copy of value.txt; each correction edits the workspace's. */
class InstalledCopy extends FixtureExecutor {
  corrections = 0;
  constructor(private dir: string, private installed: string) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    const context = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { extra: { evidence?: { id: string }[]; finding?: { id: string } } };
    if (request.profile.output === "refutation")
      return { output: { schemaVersion: 1, findingId: context.extra.finding?.id, decision: "confirmed", evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [], explanation: "The repro prints ready" }, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "implementation" && request.task?.origin !== "planned") {
      this.calls.push("implementation");
      // One session: each submit runs the host's repro check, as `submit_result` does.
      for (let live = ["unfixed"]; live.length; ) {
        this.corrections++;
        writeFileSync(join(this.dir, "value.txt"), `fixed ${this.corrections}`);
        // The third try finds the copy the repro reads, and fixes it too.
        if (this.corrections === 3) writeFileSync(join(this.installed, "value.txt"), "fixed");
        live = (await request.reproCheck?.(request.root ?? this.dir, new AbortController().signal)) ?? [];
      }
      return { output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Fixed the value", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    const result = await super.execute(request);
    if (request.profile.output === "review" && this.corrections === 0)
      result.output = {
        ...ReviewSchema.parse(result.output),
        verdict: "changes_requested",
        findings: [{ id: "unfixed", kind: "correctness", severity: "high", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "value.txt", symbol: null, evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [], claim: "The value is not fixed", impact: "Wrong value", suggestedFix: "Write fixed", repro: { executable: "bun", args: ["-e", `console.log(await Bun.file(${JSON.stringify(join(this.installed, "value.txt"))}).text())`], expected: "fixed", actual: "ready" } }],
      };
    return result;
  }
}

describe("scenario: a repro that reads an installed copy of the code (#2287)", () => {
  test("the second unchanged output after an edit of the finding's file records repro_blind, and the gate is unchanged", async () => {
    const installed = mkdtempSync(join(tmpdir(), "baked-installed-"));
    cleanups.push(() => rmSync(installed, { recursive: true, force: true }));
    writeFileSync(join(installed, "value.txt"), "ready");
    const fixture = workflowFixture({ policy, executor: (root) => new InstalledCopy(root, installed) });
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    await service.drive(run.runId, new AbortController().signal);
    // Shadow: the repro still sent the correction back twice before the copy was fixed.
    expect(executor.corrections).toBe(3);
    const checks = service.store
      .artifacts(run.runId)
      .filter((a) => /^tasks\/[^/]+\/repro-check-/.test(a.logical_path))
      .map((a) => JSON.parse(service.store.readArtifact(run.runId, a.id)) as { outcomes: { status: string; fileHash?: string }[]; blind?: string[] });
    expect(checks.map((c) => c.outcomes[0]?.status)).toEqual(["reproduced", "reproduced", "refuted"]);
    expect(checks.every((c) => typeof c.outcomes[0]?.fileHash === "string")).toBe(true);
    expect(checks.map((c) => c.blind ?? [])).toEqual([[], [expect.any(String)], []]);
    const stops = service.store
      .eventsOfType(run.runId, "decision.would_stop")
      .flatMap((e) => (e.type === "decision.would_stop" && e.payload.reason === "repro_blind" ? [e.payload] : []));
    expect(stops).toHaveLength(1);
    expect(stops[0]?.mode).toBe("shadow");
    expect(stops[0]?.inputs).toMatchObject({ outside: [join(installed, "value.txt")] });
  }, 90_000);
});
