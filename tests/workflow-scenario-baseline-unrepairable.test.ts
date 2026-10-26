import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BaselineFailureRecord,
  type BaselineRepairRecord,
  baselineFailureDecision,
  baselineFindings,
} from "../src/core/workflows/baseline-fix.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { exportTrace, replayTrace } from "../src/core/workflows/trace.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #2215, R70 namesound docs 55ca8f8b: a required rubocop check failed at approval with three
// `[Correctable]` offenses in a file no task of the docs plan wrote. The check had a fixer, yet
// the tasks spent 1.03M tokens and only the checks stage stopped the run on `baseline_failure`.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const LEGACY = "lib/legacy.rb";

/**
 * A RuboCop stand-in: a double-quoted string is a `[Correctable]` offense, a lower-case `todo`
 * annotation one RuboCop cannot correct here. Output and summary as `rubocop` prints them.
 */
const RUBOCOP = `const fs = require("fs");
const text = fs.existsSync(${JSON.stringify(LEGACY)}) ? fs.readFileSync(${JSON.stringify(LEGACY)}, "utf8") : "";
const offenses = [];
text.split("\\n").forEach((line, i) => {
  if (line.includes('"')) offenses.push(${JSON.stringify(LEGACY)} + ":" + (i + 1) + ":5: C: [Correctable] Style/StringLiterals: Prefer single-quoted strings when you don't need string interpolation or special symbols.");
  if (line.includes("todo")) offenses.push(${JSON.stringify(LEGACY)} + ":" + (i + 1) + ":3: C: Style/CommentAnnotation: Annotation keywords like todo should be all upper case.");
});
console.log("Inspecting 1 file\\n" + (offenses.length ? "C" : ".") + "\\n\\nOffenses:\\n\\n" + offenses.join("\\n"));
console.log("\\n1 file inspected, " + (offenses.length || "no") + " offense" + (offenses.length === 1 ? "" : "s") + " detected");
process.exit(offenses.length ? 1 : 0);`;

/** `rubocop -a` on the file it is given: single quotes for double ones. */
const FIX = `const fs = require("fs"); const p = process.argv[1]; fs.writeFileSync(p, fs.readFileSync(p, "utf8").replaceAll('"', "'"));`;
/** A fixer that changes the file and leaves the offense. */
const BROKEN_FIX = `const fs = require("fs"); const p = process.argv[1]; fs.writeFileSync(p, fs.readFileSync(p, "utf8").replaceAll('"', '""'));`;

const rubocop = (fix: string | null, id = "rubocop") => ({
  id,
  executable: "bun",
  args: ["-e", RUBOCOP],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "feature" as const,
  envNames: [],
  writes: [],
  ...(fix ? { fix: { executable: "bun", args: ["-e", fix] } } : {}),
});

async function scenario(options: {
  legacy: string;
  baselineFix: boolean;
  fix?: string | null;
  id?: string;
  workflowId?: "sdd" | "quick";
}) {
  const policy: RunPolicy = {
    ...fixturePolicy,
    ...(options.workflowId === "quick" ? { clarification: "assume" as const } : {}),
    checks: [...fixturePolicy.checks, rubocop(options.fix === undefined ? FIX : options.fix, options.id)],
    ...(options.baselineFix ? { baselineFix: "on" as const } : {}),
  };
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { root, service } = fixture;
  mkdirSync(join(root, "lib"));
  writeFileSync(join(root, LEGACY), options.legacy);
  writeFileSync(join(root, ".gitignore"), ".baked/\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", [
    "-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@baked.dev",
    "commit", "-q", "-m", "Fixture",
  ]);
  const run = await service.start({
    commandId: newId(),
    featureId: "fixture",
    workflowId: options.workflowId ?? "sdd",
    prompt: "Create ready value",
    ownerLabel: "test",
    policy,
  });
  // Up to the approval: the baseline is measured, no task has run.
  let current = await service.drive(run.runId, signal());
  const atApproval = {
    implementations: fixture.executor.calls.filter((c) => c === "implementation").length,
    wouldStops: wouldStops(fixture, run.runId),
  };
  for (let i = 0; i < 5 && current.status === "waiting"; i++) {
    if (service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
    await fixture.approve(run.runId);
    current = await service.drive(run.runId, signal());
  }
  return { fixture, runId: run.runId, atApproval, final: await service.get(run.runId) };
}

function wouldStops(fixture: ReturnType<typeof workflowFixture>, runId: string) {
  return fixture.service.store
    .eventsOfType(runId, "decision.would_stop")
    .map((e) => e.payload as { reason: string; key: string; summary: string; inputs: Record<string, unknown> })
    .filter((p) => p.reason === "baseline_unrepairable");
}

function artifact<T>(fixture: ReturnType<typeof workflowFixture>, runId: string, path: string): T | null {
  const row = fixture.service.store.latestArtifact(runId, path);
  return row ? (JSON.parse(fixture.service.store.readArtifact(runId, row.id)) as T) : null;
}

const CORRECTABLE = 'def greet\n  puts "hello"\n  puts "world"\nend\n';
const UNCORRECTABLE = '# todo: rename\ndef greet\n  puts "hello"\nend\n';

describe("scenario: a required lint check fails at baseline outside the plan (#2215)", () => {
  test("off: the would-stop is recorded at approval, before any task runs", async () => {
    const { fixture, runId, atApproval, final } = await scenario({ legacy: CORRECTABLE, baselineFix: false });
    expect(atApproval.implementations).toBe(0);
    expect(atApproval.wouldStops.map((w) => w.key)).toEqual(["check-rubocop"]);
    expect(atApproval.wouldStops[0]?.summary).toContain(`required check rubocop fails before any change on ${LEGACY}`);
    expect(atApproval.wouldStops[0]?.summary).toContain("is off (baselineFix)");
    const record = artifact<BaselineFailureRecord>(fixture, runId, "baseline-fix/rubocop.json");
    expect(record).toMatchObject({ files: [LEGACY], findings: 2, correctable: 2, complete: true, planned: 0, untracked: 0, fix: true, enabled: false, decision: "would_stop" });
    // Shadow: the run goes on and stops where it did before, after its tasks.
    expect(final.status).toBe("blocked");
    expect(fixture.executor.calls).toContain("implementation");
    expect(readFileSync(join(fixture.root, LEGACY), "utf8")).toBe(CORRECTABLE);
    // The replay hook decides the record again from the bench trace.
    const dir = mkdtempSync(join(tmpdir(), "baseline-fix-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(fixture.root, out);
    const replayed = replayTrace(out).runs.find((r) => r.runId === runId);
    expect(replayed?.baselineFailures.find((b) => b.checkId === "rubocop")).toEqual({ checkId: "rubocop", findings: 2, recorded: "would_stop", replayed: "would_stop" });
    expect(replayed?.newBaselineDecisions).toBe(0);
    expect(replayTrace(out, { baselineFailureRule: () => "none" }).runs.find((r) => r.runId === runId)?.newBaselineDecisions).toBe(1);
  }, 60000);

  test("on: the host fixer repairs the files before the first task and the run completes", async () => {
    const { fixture, runId, atApproval, final } = await scenario({ legacy: CORRECTABLE, baselineFix: true });
    expect(atApproval.implementations).toBe(0);
    expect(atApproval.wouldStops).toEqual([]);
    expect(artifact<BaselineFailureRecord>(fixture, runId, "baseline-fix/rubocop.json")?.decision).toBe("repair");
    expect(artifact<BaselineRepairRecord>(fixture, runId, "baseline-fix/rubocop-repair.json")).toEqual({ checkId: "rubocop", files: [LEGACY], changed: true, passed: true, kept: true });
    expect(readFileSync(join(fixture.root, LEGACY), "utf8")).toBe("def greet\n  puts 'hello'\n  puts 'world'\nend\n");
    // Journaled as a host fixer edit with its pre-image, like the checks stage's fixer runs.
    const fixes = fixture.service.store
      .effects(runId)
      .map((e) => JSON.parse(e.intent_json) as { path?: string; tool?: string; checkId?: string })
      .filter((i) => i.tool === "apply_fix" && i.path === LEGACY);
    expect(fixes.map((i) => i.checkId)).toEqual(["rubocop"]);
    expect(final.status).toBe("completed");
    expect(wouldStops(fixture, runId)).toEqual([]);
  }, 60000);

  test("on: a finding the tool cannot correct gets no repair, and the would-stop stays", async () => {
    const { fixture, runId, atApproval, final } = await scenario({ legacy: UNCORRECTABLE, baselineFix: true });
    expect(atApproval.implementations).toBe(0);
    expect(atApproval.wouldStops.map((w) => w.summary)).toEqual([expect.stringContaining("cannot correct 1 of its 2 findings")]);
    expect(artifact<BaselineFailureRecord>(fixture, runId, "baseline-fix/rubocop.json")).toMatchObject({ findings: 2, correctable: 1, decision: "would_stop" });
    expect(artifact(fixture, runId, "baseline-fix/rubocop-repair.json")).toBeNull();
    expect(readFileSync(join(fixture.root, LEGACY), "utf8")).toBe(UNCORRECTABLE);
    expect(final.status).toBe("blocked");
  }, 60000);

  test("on: a fixer that leaves the check failing has its edit put back", async () => {
    const { fixture, runId, final } = await scenario({ legacy: CORRECTABLE, baselineFix: true, fix: BROKEN_FIX });
    expect(artifact<BaselineRepairRecord>(fixture, runId, "baseline-fix/rubocop-repair.json")).toEqual({ checkId: "rubocop", files: [LEGACY], changed: true, passed: false, kept: false });
    expect(readFileSync(join(fixture.root, LEGACY), "utf8")).toBe(CORRECTABLE);
    expect(wouldStops(fixture, runId).map((w) => w.summary)).toEqual([expect.stringContaining("left the check failing")]);
    expect(final.status).toBe("blocked");
  }, 60000);

  // Without a fixer, a check counts as a linter by its name (`lint` here; RuboCop's own name is
  // #2110's), so the decision still sees it.
  test("a linter without a fixer records the would-stop with the flag on", async () => {
    const { fixture, runId, atApproval } = await scenario({ legacy: CORRECTABLE, baselineFix: true, fix: null, id: "lint" });
    expect(atApproval.wouldStops.map((w) => w.summary)).toEqual([expect.stringContaining("has no fix command")]);
    expect(artifact(fixture, runId, "baseline-fix/lint-repair.json")).toBeNull();
  }, 60000);

  // The v2 command-gate stage (`runCheckStage`) stops on the same baseline failure: the decision
  // and the repair run in the approval and task stages both definitions share.
  test("quick (v2): the repair comes before the first task and the command gate passes", async () => {
    const { fixture, runId, atApproval, final } = await scenario({ legacy: CORRECTABLE, baselineFix: true, workflowId: "quick" });
    expect(atApproval.implementations).toBe(0);
    expect(artifact<BaselineRepairRecord>(fixture, runId, "baseline-fix/rubocop-repair.json")?.kept).toBe(true);
    expect(final.status).toBe("completed");
  }, 60000);

  test("quick (v2), off: the would-stop is recorded before the first task", async () => {
    const { atApproval, final } = await scenario({ legacy: CORRECTABLE, baselineFix: false, workflowId: "quick" });
    expect(atApproval.implementations).toBe(0);
    expect(atApproval.wouldStops.map((w) => w.key)).toEqual(["check-rubocop"]);
    expect(final.status).toBe("blocked");
  }, 60000);
});

describe("baseline failure decision (#2215)", () => {
  const base = { fileLocal: true, fix: true, findings: 2, complete: true, correctable: 2, planned: 0, untracked: 0, enabled: true };
  test("repairs only correctable, tracked findings outside the plan with the flag on", () => {
    expect(baselineFailureDecision(base)).toBe("repair");
    expect(baselineFailureDecision({ ...base, enabled: false })).toBe("would_stop");
    expect(baselineFailureDecision({ ...base, fix: false })).toBe("would_stop");
    expect(baselineFailureDecision({ ...base, correctable: 1 })).toBe("would_stop");
    expect(baselineFailureDecision({ ...base, untracked: 1 })).toBe("would_stop");
  });
  test("decides nothing where the plan or the checks stage may still settle it", () => {
    expect(baselineFailureDecision({ ...base, planned: 1 })).toBe("none");
    expect(baselineFailureDecision({ ...base, fileLocal: false })).toBe("none");
    expect(baselineFailureDecision({ ...base, complete: false })).toBe("none");
    expect(baselineFailureDecision({ ...base, findings: 0, correctable: 0 })).toBe("none");
    expect(baselineFailureDecision({ ...base, exempt: true })).toBe("none");
  });
  test("reads the correctable marks of RuboCop, Ruff and Biome", () => {
    const rubocop = "Offenses:\n\nspec/cli_spec.rb:3:5: C: [Correctable] Style/StringLiterals: Prefer single quotes.\nspec/cli_spec.rb:9:1: C: Metrics/BlockLength: Block has too many lines.\n\n1 file inspected, 2 offenses detected, 1 offense autocorrectable";
    expect(baselineFindings(rubocop, "/w", ".")).toEqual({ files: ["spec/cli_spec.rb"], findings: 2, correctable: 1, complete: true });
    const ruffFull = "F401 [*] `os` imported but unused\n --> tools/legacy.py:1:8\n  |\n1 | import os\n  |        ^^\n\nFound 1 error.\n[*] 1 fixable with the `--fix` option.";
    expect(baselineFindings(ruffFull, "/w", ".")).toEqual({ files: ["tools/legacy.py"], findings: 1, correctable: 1, complete: true });
    const ruffConcise = "tools/a.py:1:8: F401 [*] `os` imported but unused\ntools/a.py:3:1: E741 Ambiguous variable name: `l`\nFound 2 errors.";
    expect(baselineFindings(ruffConcise, "/w", ".")).toMatchObject({ findings: 2, correctable: 1, complete: true });
    const biome = "src/a.ts:3:7 lint/style/useConst FIXABLE ━━━━\nsrc/b.ts:1:1 lint/suspicious/noExplicitAny ━━━━\nChecked 2 files in 3ms. No fixes applied.\nFound 2 errors.";
    expect(baselineFindings(biome, "/w", ".")).toEqual({ files: ["src/a.ts", "src/b.ts"], findings: 2, correctable: 1, complete: true });
    // A tool path from the check's own directory, and a summary that counts more than was read.
    expect(baselineFindings(rubocop, "/w", "app").files).toEqual(["app/spec/cli_spec.rb"]);
    expect(baselineFindings("spec/a.rb:1:1: C: [Correctable] X\n\n1 file inspected, 4 offenses detected", "/w", ".").complete).toBe(false);
  });
});
