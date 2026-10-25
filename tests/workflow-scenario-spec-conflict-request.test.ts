import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashJson } from "../src/core/specs/hash.js";
import type { Analysis, RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { replayConflictFinishes, replayRequestConflicts } from "../src/core/workflows/trace.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 65, uritpl cli T003 (#2016). AC-005 gives `t.txt:1:6` for the template
// `{a}{a}` while the request's own example (`/x y/{id}{id}` -> column 11, first at 7) shows name
// columns, so the second `a` is at column 5. The implementer's test asserted 5. Its first report
// said "the detailed contract defines", which the host's wording rule did not take for the
// request; the host settled for the run's own test instead, the second report said "the request
// defines", the one-shot rule was spent, and a person was asked (1.42M tokens, 19.7 minutes). The
// host now checks the conflict's sides against the request itself, on every report.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const EXAMPLE = 't.txt:3:11: UT104 variable "id" appears again (first at column 7)';
const REQUEST = `Build the uritpl check command. It prints each problem as FILE:LINE:COLUMN: CODE message, where COLUMN is the 1-based code-point position of the variable name. For line 3 \`/x y/{id}{id}\` of t.txt it prints \`${EXAMPLE}\`. Write value.txt with ready.`;
const WRONG = 't.txt:1:6: UT104 variable "a" appears again (first at column 2)';
const RIGHT = 't.txt:1:5: UT104 variable "a" appears again (first at column 2)';
const TEST = "tests/test_cli.py";
const LEGACY = "tests/test_legacy.py";

const spec: Spec = {
  ...fixtureSpec,
  requirements: [
    ...fixtureSpec.requirements,
    { id: "FR-005", text: "A problem names FILE:LINE:COLUMN with the 1-based code-point column", priority: "must", verification: "automated", sourceRefs: ["request"] },
  ],
  criteria: [
    ...fixtureSpec.criteria,
    { id: "AC-005", requirementIds: ["FR-005"], given: "t.txt holds the template `{a}{a}` on line 1", when: "uritpl check t.txt runs", then: `it prints \`${WRONG}\``, method: "automated" },
  ],
};

type Side = { kind: "criterion" | "requirement" | "request" | "test"; ref?: string; quote: string };

interface Script {
  /** The report's summary at each conflict, in order; the last one repeats. */
  summaries: string[];
  sides?: Side[];
  /** The request re-audit's derivation of AC-005, if it gives one. */
  reaudit?: NonNullable<Analysis["derivations"]>[number];
  /**
   * The test spells the whole line with the request's column, one character from the criterion's,
   * which the misquote check (#1709) would take for a slip of transcription.
   */
  literal?: boolean;
  /** A test that existed before the run. */
  legacy?: boolean;
  policy?: RunPolicy;
  /**
   * The reporting attempt already wrote the test with the request's column and `value.txt` (the
   * task's `unit` check wants `ready`), as T003's did (#2033); `on` sets `conflictFinish`.
   */
  finish?: { mode?: "on"; value: string };
  /** The task also carries AC-006, whose literal the attempt's test lacks. */
  unheld?: boolean;
}

const UNHELD: Spec["criteria"][number] = { id: "AC-006", requirementIds: ["FR-005"], given: "t.txt holds `{b}` on line 2", when: "uritpl check t.txt runs", then: "it prints `t.txt:2:2: UT101 unused variable \"b\"`", method: "automated" };

/** The task's own check: the code's output is in place. */
const UNIT: RunPolicy["checks"][number] = {
  id: "unit",
  executable: "bun",
  args: ["-e", "if (await Bun.file('value.txt').text() !== 'ready') process.exit(1)"],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "task",
  envNames: [],
  writes: [],
};

async function conflict(script: Script) {
  const base: RunPolicy = script.policy ?? { ...fixturePolicy, clarification: "assume" };
  const policy: RunPolicy = script.finish
    ? { ...base, checks: [...base.checks, UNIT], ...(script.finish.mode ? { conflictFinish: script.finish.mode } : {}) }
    : base;
  const runSpec: Spec = script.unheld ? { ...spec, criteria: [...spec.criteria, UNHELD] } : spec;
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  if (script.legacy) {
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, LEGACY), "def test_legacy():\n    assert True\n");
  }
  const original = executor.execute.bind(executor);
  const prompts: string[] = [];
  const walks: string[][] = [];
  let conflicts = 0;
  let reaudits = 0;
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "spec") return { output: runSpec, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "plan") {
      const out = await original(request);
      const graph = (out.output as { taskGraph: { specHash: string; tasks: Record<string, unknown>[] } }).taskGraph;
      const code = graph.tasks[0] as Record<string, unknown> & { writes: { path: string; action: string }[] };
      graph.specHash = hashJson(runSpec);
      graph.tasks = [{ ...code, id: "T001", criterionIds: ["AC-001", "AC-005", ...(script.unheld ? ["AC-006"] : [])], ...(script.finish ? { checkIds: ["unit"] } : {}), writes: [...code.writes, { path: TEST, action: "create" }] }];
      return out;
    }
    if (request.profile.output === "analysis") {
      const out = await original(request);
      if (request.prompt.includes("Request re-audit")) {
        reaudits++;
        if (script.reaudit) out.output = { ...(out.output as object), derivations: [script.reaudit] };
      }
      return out;
    }
    if (request.profile.output === "review" || request.profile.output === "convergence") {
      const out = await original(request);
      const review = out.output as { coverage: { criterionId: string }[] };
      review.coverage = [...review.coverage, ...review.coverage.map((c) => ({ ...c, criterionId: "AC-005" }))];
      return out;
    }
    if (request.profile.output !== "implementation") return original(request);
    const work = request.root ?? root;
    prompts.push(request.prompt);
    // The test asserts the request's column, as T003's did.
    const writeTest = () => {
      mkdirSync(join(work, dirname(TEST)), { recursive: true });
      writeFileSync(join(work, TEST), script.literal ? `def test_repeat():\n    assert check("t.txt") == ${JSON.stringify(RIGHT)}\n` : `def test_repeat():\n    assert check("t.txt").column == 5\n`);
    };
    if (request.prompt.includes("Settled spec conflict (assumptions/conflicts/T001-request.json)")) {
      writeTest();
      writeFileSync(join(work, "value.txt"), "ready");
      walks.push((await request.caseCheck?.(work)) ?? []);
      return { output: { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "The test asserts the column the request gives", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    // The misquote check reads the test as the conflict leaves it.
    if (script.literal || script.finish) writeTest();
    if (script.finish) writeFileSync(join(work, "value.txt"), script.finish.value);
    const summary = script.summaries[Math.min(conflicts, script.summaries.length - 1)] ?? "";
    conflicts++;
    return {
      output: { schemaVersion: 1, taskId: "T001", outcome: "spec_conflict", summary, evidenceIds: [], unresolved: ["Which column is right?"], ...(script.sides ? { conflictSides: script.sides } : {}) },
      inputTokens: 25,
      outputTokens: 25,
    };
  };
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy });
  for (let i = 0; i < 10; i++) {
    const current = await service.get(started.runId);
    if (["completed", "blocked", "failed"].includes(current.status)) break;
    const pending = service.store.requests(started.runId).find((r) => r.status === "pending");
    if (pending?.kind === "approval") await fixture.approve(started.runId);
    else if (pending?.kind === "clarification") break;
    else if (current.status === "paused" || current.status === "created") await fixture.resume(started.runId);
    await service.drive(started.runId, signal());
  }
  const read = (path: string) => {
    const artifact = service.store.latestArtifact(started.runId, path);
    return artifact ? JSON.parse(service.store.readArtifact(started.runId, artifact.id)) : null;
  };
  return {
    status: (await service.get(started.runId)).status,
    asked: service.store.requests(started.runId).filter((r) => r.kind === "clarification"),
    conflicts,
    reaudits,
    prompts,
    walks,
    read,
    records: service.store.artifacts(started.runId).filter((a) => a.logical_path.startsWith("conflicts/request/")).map((a) => JSON.parse(service.store.readArtifact(started.runId, a.id)) as { report: number; decision: string; sides: { kind: string; verified: boolean }[]; reaudit: unknown }),
    // The replay hook decides each recorded report again, with the current rule or another one.
    replay: (rule?: Parameters<typeof replayRequestConflicts>[2]) => replayRequestConflicts(service.store, started.runId, rule),
    finishes: (rule?: Parameters<typeof replayConflictFinishes>[2]) => replayConflictFinishes(service.store, started.runId, rule),
    decisions: service.store.artifacts(started.runId).filter((a) => a.logical_path.startsWith("decisions/clarification-")).map((a) => JSON.parse(service.store.readArtifact(started.runId, a.id)) as { criterionIds?: string[]; requestId: string }),
  };
}

// The first report's phrasings vary, so the decision cannot hang on one word (#2016).
const FIRST = [
  `AC-005 says ${WRONG}, but the detailed contract defines columns as 1-based code-point positions; ${TEST} asserts 5.`,
  `AC-005 expects column 6; the brief's example counts name columns, so the second name is at 5.`,
  `AC-005 and the task text disagree on the column of the repeated name (6 against 5).`,
  `The criterion AC-005 contradicts the request: the second {a} name sits at column 5, not 6.`,
];
const SECOND = `AC-005 says column 6, but the detailed request defines 1-based code-point positions; a person must choose.`;
const SIDES: Side[] = [
  { kind: "criterion", ref: "AC-005", quote: WRONG },
  { kind: "request", quote: EXAMPLE },
  { kind: "test", ref: TEST, quote: RIGHT },
];

describe("scenario: uritpl cli T003, a criterion that contradicts the request's example (#2016)", () => {
  for (const [i, first] of FIRST.entries())
    test(`the request wins at the first report on its verified quote (phrasing ${i + 1})`, async () => {
      const result = await conflict({ summaries: [first, SECOND], sides: SIDES });
      expect(result.asked).toEqual([]);
      expect(result.conflicts).toBe(1);
      // The quotes decided it: no re-audit, no third session.
      expect(result.reaudits).toBe(0);
      expect(result.prompts).toHaveLength(2);
      expect(result.read("assumptions/conflicts/T001-request.json")?.assumed).toContain("The request wins over AC-005");
      expect(result.read("assumptions/conflicts/T001.json")).toBeNull();
      expect(result.read("amendments/conflict-T001.json")).toMatchObject({ criterionIds: ["AC-005"], requirementIds: ["FR-005"], authority: "request" });
      expect(result.decisions.find((d) => d.requestId === "request-T001")?.criterionIds).toEqual(["AC-005"]);
      expect(result.records).toEqual([expect.objectContaining({ report: 1, decision: "request", reaudit: null })]);
      expect(result.replay()).toEqual([{ taskId: "T001", report: 1, recorded: "request", replayed: "request" }]);
      // The rule before #2016 never settled on the sides: the hook shows the difference.
      expect(result.replay(() => "none")).toEqual([{ taskId: "T001", report: 1, recorded: "request", replayed: "none" }]);
      // The case walk no longer demands the overruled `t.txt:1:6` in the test.
      expect(result.walks).toEqual([[]]);
      expect(result.status).toBe("completed");
    }, 90_000);

  test("a test that spells the request's line is not sent back as a misquoted row", async () => {
    const result = await conflict({ summaries: [FIRST[0] ?? "", SECOND], sides: SIDES, literal: true });
    expect(result.asked).toEqual([]);
    expect(result.conflicts).toBe(1);
    expect(result.read("assumptions/conflicts/T001-misquoted.json")).toBeNull();
    expect(result.read("assumptions/conflicts/T001-request.json")?.assumed).toContain("The request wins over AC-005");
    expect(result.status).toBe("completed");
  }, 90_000);

  test("a report without sides goes to a re-audit against the request, whose quote settles it", async () => {
    const result = await conflict({
      summaries: [FIRST[0] ?? "", SECOND],
      reaudit: { criterionId: "AC-005", row: WRONG, recomputed: RIGHT, matches: false, derivation: "The example counts name columns: { is 4, a is 5", quote: EXAMPLE },
    });
    expect(result.asked).toEqual([]);
    expect(result.conflicts).toBe(1);
    expect(result.reaudits).toBe(1);
    expect(result.read("assumptions/conflicts/T001-request.json")?.assumed).toContain("a re-audit against the request");
    expect(result.decisions.find((d) => d.requestId === "request-T001")?.criterionIds).toEqual(["AC-005"]);
    expect(result.records[0]).toMatchObject({ report: 1, decision: "request", reaudit: [{ criterionId: "AC-005", matches: false, quoteVerified: true }] });
    expect(result.replay().map((b) => b.replayed)).toEqual(["request"]);
    expect(result.walks).toEqual([[]]);
    expect(result.status).toBe("completed");
  }, 90_000);

  test("a request quote the request does not hold settles nothing, and a person is asked", async () => {
    const invented = 't.txt:1:5: UT104 variable "a" appears again';
    const result = await conflict({
      summaries: [FIRST[0] ?? "", SECOND],
      sides: [SIDES[0] as Side, { kind: "request", quote: invented }],
      reaudit: { criterionId: "AC-005", row: WRONG, recomputed: RIGHT, matches: false, derivation: "The request gives it", quote: invented },
    });
    expect(result.read("assumptions/conflicts/T001-request.json")).toBeNull();
    expect(result.records.map((r) => r.decision)).toEqual(["none", "none"]);
    // One re-audit per task, on the first report only.
    expect(result.reaudits).toBe(1);
    expect(result.asked).toHaveLength(1);
    expect(result.status).toBe("waiting");
  }, 90_000);

  test("a conflict that names a test the run did not write still asks a person", async () => {
    const result = await conflict({
      legacy: true,
      summaries: [`AC-005 says column 6 and ${LEGACY} agrees with it, but the detailed contract defines name columns.`],
      sides: [SIDES[0] as Side, SIDES[1] as Side, { kind: "test", ref: LEGACY, quote: "assert True" }],
    });
    expect(result.reaudits).toBe(0);
    expect(result.read("assumptions/conflicts/T001-request.json")).toBeNull();
    expect(result.records[0]).toMatchObject({ foreignTests: 1, decision: "none" });
    expect(result.conflicts).toBe(1);
    expect(result.asked).toHaveLength(1);
    expect(result.status).toBe("waiting");
  }, 90_000);

  test("under clarification ask the person is asked, as before", async () => {
    const result = await conflict({ summaries: [FIRST[0] ?? ""], sides: SIDES, policy: { ...fixturePolicy, clarification: "ask" } });
    expect(result.records).toEqual([]);
    expect(result.asked).toHaveLength(1);
  }, 90_000);

  // #2033: the reporting attempt's test already asserts the request's column and its check
  // passes, so the session after the settlement would only record that (410,310 tokens in R65).
  test("with conflictFinish on, the host finishes the task on the attempt's passing tree", async () => {
    const result = await conflict({ summaries: [FIRST[0] ?? "", SECOND], sides: SIDES, finish: { mode: "on", value: "ready" } });
    expect(result.asked).toEqual([]);
    expect(result.conflicts).toBe(1);
    // One implementer session: the one that reported the conflict.
    expect(result.prompts).toHaveLength(1);
    expect(result.read("assumptions/conflicts/T001-request.json")?.assumed).toContain("The request wins over AC-005");
    expect(result.read("conflicts/finish/T001-request.json")).toMatchObject({ taskId: "T001", branch: "request", mode: "on", settledBy: "assumptions/conflicts/T001-request.json", cases: 0, checks: [{ id: "check", status: "passed" }, { id: "unit", status: "passed" }], finish: true });
    expect(result.read("tasks/T001/host-finish.json")).toMatchObject({ taskId: "T001", branch: "request", checks: ["check", "unit"] });
    expect(result.finishes()).toEqual([{ taskId: "T001", branch: "request", mode: "on", ready: true, recorded: true, replayed: true }]);
    expect(result.finishes(() => false).map((b) => b.replayed)).toEqual([false]);
    expect(result.status).toBe("completed");
  }, 90_000);

  test("a failing check keeps the session after the settlement", async () => {
    const result = await conflict({ summaries: [FIRST[0] ?? "", SECOND], sides: SIDES, finish: { mode: "on", value: "draft" } });
    expect(result.asked).toEqual([]);
    expect(result.prompts).toHaveLength(2);
    expect(result.read("conflicts/finish/T001-request.json")).toMatchObject({ mode: "on", checks: [{ id: "check", status: "failed" }], finish: false });
    expect(result.read("tasks/T001/host-finish.json")).toBeNull();
    expect(result.walks).toEqual([[]]);
    expect(result.status).toBe("completed");
  }, 90_000);

  test("a case the attempt's test lacks keeps the session, with no check run", async () => {
    // AC-005 is released by the settlement; AC-006 is not, and the test does not test it.
    const result = await conflict({ summaries: [FIRST[0] ?? "", SECOND], sides: SIDES, finish: { mode: "on", value: "ready" }, unheld: true });
    expect(result.prompts.length).toBeGreaterThan(1);
    expect(result.read("conflicts/finish/T001-request.json")).toMatchObject({ mode: "on", checks: null, finish: false });
    expect((result.read("conflicts/finish/T001-request.json") as { cases: number }).cases).toBeGreaterThan(0);
  }, 90_000);

  test("without conflictFinish the decision is shadow: recorded, and the session opens", async () => {
    const result = await conflict({ summaries: [FIRST[0] ?? "", SECOND], sides: SIDES, finish: { value: "ready" } });
    expect(result.prompts).toHaveLength(2);
    expect(result.read("conflicts/finish/T001-request.json")).toMatchObject({ mode: "shadow", edits: 2, cases: 0, checks: null, finish: false });
    expect(result.finishes()).toEqual([{ taskId: "T001", branch: "request", mode: "shadow", ready: true, recorded: false, replayed: false }]);
  }, 90_000);

  test("a criterion against its requirement finishes on the host too, with the criterion released", async () => {
    const result = await conflict({ summaries: ["AC-005 gives column 6, but FR-005 requires the 1-based code-point column of the name, which is 5."], finish: { mode: "on", value: "ready" } });
    expect(result.asked).toEqual([]);
    expect(result.prompts).toHaveLength(1);
    expect(result.read("conflicts/finish/T001-requirements.json")).toMatchObject({ branch: "requirements", settledBy: "assumptions/conflicts/T001.json", cases: 0, finish: true });
    expect(result.read("amendments/conflict-T001.json")).toMatchObject({ criterionIds: ["AC-005"], authority: "requirement" });
    expect(result.status).toBe("completed");
  }, 90_000);

  test("a platform limit releases no criterion, so a case the attempt's test lacks keeps the session", async () => {
    const result = await conflict({ summaries: ["The terminal encoding cannot represent the column AC-005 prints, so the test asserts another one."], finish: { mode: "on", value: "ready" } });
    expect(result.prompts.length).toBeGreaterThan(1);
    const record = result.read("conflicts/finish/T001-platform.json") as { cases: number } | null;
    expect(record).toMatchObject({ branch: "platform", settledBy: "assumptions/conflicts/T001.json", checks: null, finish: false });
    expect(record?.cases).toBeGreaterThan(0);
  }, 90_000);
});
