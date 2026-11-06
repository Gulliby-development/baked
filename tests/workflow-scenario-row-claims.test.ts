import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical, hashJson } from "../src/core/specs/hash.js";
import { conflictDecisions, settledConflicts } from "../src/core/workflows/conflict-decisions.js";
import { derivationRowConflicts, ROW_CLAIM_DIR, type RowClaimRecord, rowClaimConflicts, runClaims } from "../src/core/workflows/row-claims.js";
import type { Analysis, RunPolicy, Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 82, tinyflate deflate 82f19908 (#2561). The request prescribes
// `tests/deflate_match_test.c` rows with 300 bytes of `0x78` (expected `ab1805440300`) and 259 of
// `0x71` (`2b1c0500`). A reviewer wrote "the request supplies 306 repeated x bytes and 283 repeated
// q bytes", a skeptic confirmed it, T008 wrote 306/283 and reported a spec conflict, and T009's
// second audit settled it for the requirements ("The settled clarification specifies 306 repeated
// x bytes ... This yields ab1805240200") although its request quote was not in the request. With
// the file back at 300/259 and every check passing, T009's brief still demanded 306/283, and the
// run blocked `invalid_output` at rev 56.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const TEST = "tests/deflate_match_test.c";
const SRC = "src/deflate.c";
const row = (input: string, out: string) => `run "deflate" "--level" "fixed" "--hex" stdin="${input}" => 0 "${out}\\n" ""`;
const ROWS = [row("61616161", "4b040200"), row("78".repeat(300), "ab1805440300"), row("71".repeat(259), "2b1c0500")];
const REQUEST = ["Create ready value.", "", "```text", `deflate_match_test in ${TEST} (3 rows)`, ...ROWS, "```", ""].join("\n");
const PATHS = [TEST];
/** The test file with `x` and `q` bytes in the long rows and their expected outputs. */
const testFile = (x: number, q: number, xOut = "ab1805440300", qOut = "2b1c0500") =>
  [
    '#include "harness.h"',
    "int main(void) {",
    "  int failed = 0;",
    `  failed += row(ARGS("deflate", "--level", "fixed", "--hex"), "61616161", 0, "4b040200\\n", "");`,
    `  failed += row(ARGS("deflate", "--level", "fixed", "--hex"), "${"78".repeat(x)}", 0, "${xOut}\\n", "");`,
    `  failed += row(ARGS("deflate", "--level", "fixed", "--hex"), "${"71".repeat(q)}", 0, "${qOut}\\n", "");`,
    "  return failed;",
    "}",
    "",
  ].join("\n");

// The restatements of the run, verbatim (art-290 F1, art-298, art-374, art-448, art-332, art-435).
const WRONG = {
  finding: "Lines 11–12 shorten the prescribed input literals: the request supplies 306 repeated x bytes and 283 repeated q bytes, but the delivered rows contain 300 and 259 respectively.",
  skeptic: `The current ${TEST} lines 11–12 contain shortened repeated-input literals (300 x bytes and 259 q bytes), rather than the prescribed 306 and 283 bytes.`,
  second: "The first long matcher input is still not the prescribed literal: line 11 contains 312 repeated x bytes instead of the required 306.",
  brief: `Restore the exact prescribed 306-byte x input in ${TEST} and update only its expected stream to the FR-003 result, ab1805240200.; Update the q-row expected stream to the FR-003 result for its prescribed 283-byte input, 2b1c05b80000`,
  conflict: "Restored the prescribed long matcher inputs to 306 repeated x bytes and 283 repeated q bytes while leaving the encoder's FR-003 greedy behavior unchanged.",
  decision: "The settled clarification specifies 306 repeated x bytes. The constructed byte index table is 0 through 305.",
};
const RIGHT = [
  "line 11 contains 303 repeated x bytes instead of the required 300, and line 12 has 238 bytes of 0x71 where the request gives 259.",
  "Restore the prescribed 300-byte x input; the request supplies 259 repeated q bytes.",
  "The encoder emits (length 258, distance 1) and (length 41, distance 1) for the row's input.",
];
const REAUDIT: NonNullable<Analysis["derivations"]> = [
  {
    criterionId: "AC-006",
    row: `${TEST} row 2`,
    recomputed: 'exit 0; stdout "ab1805240200\\n"; stderr ""',
    matches: false,
    quote: "change only the assertions there that contradict them to what they state, keep every other assertion and test, and make the code pass.",
    derivation: `${WRONG.decision} FR-003 therefore emits literal 120, (length 258,distance 1), (length 47,distance 1), EOB and zero padding. This yields ab1805240200, not the original supplied ab1805440300. The settled request authorizes correcting only the conflicting expected assertion.`,
  },
];

describe("the request's rows against a restatement of them (#2561)", () => {
  test("each R82 restatement that miscounts a long run contradicts the row; a faithful one does not", () => {
    for (const [name, text] of Object.entries(WRONG)) {
      const found = rowClaimConflicts(REQUEST, PATHS, text);
      expect({ name, claimed: found.map((c) => c.claimed).sort() }).toMatchObject({ name });
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((c) => c.kind === "run" && c.path === TEST)).toBe(true);
    }
    expect(rowClaimConflicts(REQUEST, PATHS, WRONG.finding)).toEqual([
      { path: TEST, row: 2, kind: "run", byte: 0x78, claimed: 306, prescribed: 300 },
      { path: TEST, row: 3, kind: "run", byte: 0x71, claimed: 283, prescribed: 259 },
    ]);
    for (const text of RIGHT) expect(rowClaimConflicts(REQUEST, PATHS, text)).toEqual([]);
  });

  test("a count the clause gives the file is no claim about the request", () => {
    expect(runClaims(WRONG.second)).toEqual([{ count: 306, byte: 0x78 }]);
    expect(runClaims("the delivered rows contain 300 and 259 respectively")).toEqual([]);
  });

  test("a re-audit's recomputed expected value for a prescribed row is checked against the row", () => {
    expect(derivationRowConflicts(REQUEST, PATHS, REAUDIT)).toEqual([
      { path: TEST, row: 2, kind: "literal", claimed: "ab1805240200", prescribed: "ab1805440300\\n" },
    ]);
    expect(derivationRowConflicts(REQUEST, PATHS, [{ ...REAUDIT[0]!, recomputed: 'exit 0; stdout "ab1805440300\\n"' }])).toEqual([]);
  });
});

// The conflict of T009 at rev 56, as the host settles it: a test task writes the prescribed rows
// with 306/283 (the miscounted finding's counts), the encoder disagrees and the task reports a
// spec conflict; the derivation audit verified AC-006 and the second audit recomputes row 2 from
// the restatement, citing request text the request does not hold.
const spec: Spec = {
  ...fixtureSpec,
  requirements: [
    ...fixtureSpec.requirements,
    { id: "FR-003", text: "Fixed encoding emits the longest match with the smallest distance at each position", priority: "must", verification: "automated", sourceRefs: [] },
    { id: "FR-006", text: "Deliver exactly the supplied encoding rows, unchanged and in order. Preserve every input, status, stdout and stderr literal from the request.", priority: "must", verification: "automated", sourceRefs: [] },
  ],
  criteria: [
    ...fixtureSpec.criteria,
    { id: "AC-006", requirementIds: ["FR-006", "FR-003"], given: "the encoding test programs and the supplied request row blocks", when: "their source and results are checked", then: `${TEST} contains exactly its 3 supplied rows, in the prescribed order with identical literals, and they pass`, method: "automated" },
  ],
};
const REPORT = "AC-006 requires ab1805440300 for the restored prescribed 306 repeated x bytes input, but the FR-003 encoder gives ab1805240200; the 283-byte q row gives 2b1c05b80000 instead of 2b1c0500.";

async function conflict(extra: Partial<RunPolicy> = {}) {
  const policy: RunPolicy = { ...fixturePolicy, clarification: "ask", rowRunRestore: "off", rowEditGuard: "off", ...extra };
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const original = executor.execute.bind(executor);
  const prompts: string[] = [];
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "plan") {
      const out = await original(request);
      const graph = (out.output as { taskGraph: { specHash: string; tasks: Record<string, unknown>[] } }).taskGraph;
      const code = graph.tasks[0] as Record<string, unknown> & { writes: { path: string; action: string }[] };
      graph.specHash = hashJson(spec);
      graph.tasks = [{ ...code, id: "T001", criterionIds: ["AC-001", "AC-006"], writes: [...code.writes, { path: TEST, action: "create" }] }];
      return out;
    }
    if (request.profile.output === "analysis") {
      const out = await original(request);
      const second = request.prompt.includes("Derivation re-audit");
      out.output = { ...(out.output as object), derivations: second ? REAUDIT : [{ ...REAUDIT[0]!, recomputed: 'exit 0; stdout "ab1805440300\\n"', matches: true, quote: undefined, derivation: "Recomputed from FR-003" }] };
      return out;
    }
    if (request.profile.output === "review" || request.profile.output === "convergence") {
      const out = await original(request);
      const review = out.output as { coverage: { criterionId: string }[] };
      review.coverage = [...review.coverage, ...review.coverage.map((c) => ({ ...c, criterionId: "AC-006" }))];
      return out;
    }
    if (request.profile.output !== "implementation") return original(request);
    const work = request.root ?? root;
    prompts.push(request.prompt);
    mkdirSync(join(work, dirname(TEST)), { recursive: true });
    writeFileSync(join(work, "value.txt"), "ready");
    // The task follows what the host settled: the request's rows, or the requirements' streams for
    // the miscounted inputs, as T009 was told at rev 56.
    const forRequest = /the request's text wins/.test(request.prompt);
    const forRequirements = /Implement what FR-006 state/.test(request.prompt);
    if (forRequest || forRequirements) {
      writeFileSync(join(work, TEST), forRequest ? testFile(300, 259) : testFile(306, 283, "ab1805240200", "2b1c05b80000"));
      return { output: { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Matcher rows", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    writeFileSync(join(work, TEST), testFile(306, 283));
    return {
      output: { schemaVersion: 1, taskId: "T001", outcome: "spec_conflict", summary: REPORT, evidenceIds: [], unresolved: ["Which expected streams are right?"] },
      inputTokens: 25,
      outputTokens: 25,
    };
  };
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy });
  for (let i = 0; i < 10; i++) {
    const current = await service.get(run.runId);
    if (["completed", "blocked", "failed"].includes(current.status)) break;
    const pending = service.store.requests(run.runId).find((r) => r.status === "pending");
    if (pending?.kind === "approval") await fixture.approve(run.runId);
    else if (pending?.kind === "clarification") break;
    else if (current.status === "paused" || current.status === "created") await fixture.resume(run.runId);
    await service.drive(run.runId, signal());
  }
  const read = (path: string) => {
    const artifact = service.store.latestArtifact(run.runId, path);
    return artifact ? JSON.parse(service.store.readArtifact(run.runId, artifact.id)) : null;
  };
  return {
    status: (await service.get(run.runId)).status,
    prompts,
    read,
    file: () => readFileSync(join(root, TEST), "utf8"),
    claims: service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith(ROW_CLAIM_DIR)).map((a) => JSON.parse(service.store.readArtifact(run.runId, a.id)) as RowClaimRecord),
    decisions: conflictDecisions(service.store, run.runId),
  };
}

describe("scenario: R82 tinyflate T009, a conflict settled against the request's rows (#2561)", () => {
  test("the re-audit's unquoted recomputation does not settle for the requirements: the request's rows win", async () => {
    const result = await conflict();
    expect(result.read("assumptions/conflicts/T001-reaudited.json")).toBeNull();
    expect(result.decisions.map((d) => d.requestId)).toEqual(["request-rows-T001"]);
    expect(result.read("assumptions/conflicts/T001-request-rows.json")?.assumed).toContain("ab1805440300");
    const record = result.claims.find((c) => c.site === "decision");
    expect(record).toMatchObject({ mode: "on", verdict: "overridden", taskId: "T001" });
    expect(record?.conflicts).toContainEqual({ path: TEST, row: 2, kind: "literal", claimed: "ab1805240200", prescribed: "ab1805440300\\n" });
    expect(record?.conflicts).toContainEqual({ path: TEST, row: 2, kind: "run", byte: 0x78, claimed: 306, prescribed: 300 });
    // The task's next session is told the rows as the request gives them, and keeps them.
    expect(result.prompts.at(-1)).toContain(`${TEST} row 2 as the request gives it`);
    expect(result.prompts.at(-1)).toContain("[78 repeated 300 times]");
    expect(result.file()).toBe(testFile(300, 259));
    expect(result.status).toBe("completed");
  }, 90_000);

  test("with rowClaimCheck off the record is shadow and the conflict settles for the requirements, as at rev 56", async () => {
    const result = await conflict({ rowClaimCheck: "off" });
    expect(result.claims.find((c) => c.site === "decision")).toMatchObject({ mode: "shadow", verdict: "would_override" });
    expect(result.decisions.map((d) => d.requestId)).toEqual(["reaudited-T001"]);
    // The task is told to fit the expected streams to the miscounted inputs.
    expect(result.prompts.at(-1)).toMatch(/Implement what FR-006/);
    expect(result.prompts.at(-1)).not.toContain(`${TEST} row 2 as the request gives it`);
  }, 90_000);
});

// The resume of rev 56: the run is blocked `invalid_output` at the source task with the file at
// the request's 300/259, and holds a decision, a settled conflict and a confirmed finding that
// give the rows 306/283 and the fitted streams. T003's session keeps demanding them until the run
// stops holding them.
const DECISION = "decisions/clarification-reaudited-T003.json";
const ASSUMPTION = "assumptions/conflicts/T003-reaudited.json";
const AMENDMENT = "amendments/conflict-T003.json";
const ANSWER = `Settled by a second audit (${ASSUMPTION}): The requirements FR-006 win over the criteria AC-006: a second audit of the contested rows against the report recomputed AC-006 row "${TEST} row 2": the requirements give "exit 0; stdout \\"ab1805240200\\\\n\\"; stderr \\"\\"" (${WRONG.decision} This yields ab1805240200, not the original supplied ab1805440300.).`;
const DEMAND = "I cannot keep tests/deflate_match_test.c rows 2 and 3 at 300 and 259 bytes: the settled clarification requires the exact prescribed 306-byte x input with ab1805240200.";

class BlockedExecutor extends FixtureExecutor {
  sessions: string[] = [];
  briefs: Record<string, string[]> = {};
  constructor(private workspace: string) {
    super(workspace);
  }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const graph = (result.output as { taskGraph: TaskGraph }).taskGraph;
      const first = graph.tasks[0]!;
      graph.tasks.push(
        { ...first, id: "T002", title: "Deflate match rows", dependsOn: ["T001"], writes: [{ path: TEST, action: "create" }], checkIds: [] },
        { ...first, id: "T003", title: "Deflate matcher", dependsOn: ["T002"], writes: [{ path: SRC, action: "create" }], checkIds: [] },
      );
    }
    if (request.profile.output !== "implementation") return result;
    const id = request.task?.id ?? "";
    this.sessions.push(id);
    (this.briefs[id] ??= []).push(request.prompt);
    const path = (p: string) => join(this.workspace, p);
    if (id === "T002") {
      mkdirSync(dirname(path(TEST)), { recursive: true });
      writeFileSync(path(TEST), testFile(300, 259));
    }
    if (id !== "T003") return result;
    if (/the request's text wins/.test(request.prompt)) {
      mkdirSync(dirname(path(SRC)), { recursive: true });
      writeFileSync(path(SRC), "int deflate(void) { return 0; }\n");
      return result;
    }
    return { ...result, output: { schemaVersion: 1, taskId: id, outcome: "blocked", summary: DEMAND, evidenceIds: [], unresolved: [DEMAND] } };
  }
}

async function blockedAtRev56(extra: Partial<RunPolicy> = {}) {
  const policy: RunPolicy = { ...fixturePolicy, ...extra };
  let executor: BlockedExecutor | undefined;
  const fixture = workflowFixture({
    policy,
    executor: (root) => {
      executor = new BlockedExecutor(root);
      return executor;
    },
  });
  cleanups.push(fixture.dispose);
  const { service } = fixture;
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy });
  const drive = () => service.drive(run.runId, signal());
  let current = await drive();
  for (let i = 0; i < 8 && current.status === "waiting"; i++) {
    if (service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
    await fixture.approve(run.runId);
    current = await drive();
  }
  // What rev 56 had settled before the block.
  const store = service.store;
  const evidence = store.artifact(run.runId, "review", `reviews/${newId()}.json`, "{}");
  store.transaction(() => {
    store.artifact(run.runId, "assumption", ASSUMPTION, canonical({ taskId: "T003", assumed: ANSWER.slice(ANSWER.indexOf("The requirements")), derivations: REAUDIT }));
    store.artifact(run.runId, "assumption", AMENDMENT, canonical({ findingId: "conflict-T003", criterionIds: ["AC-006"], requirementIds: ["FR-006"], paths: [], claim: `${WRONG.conflict} Re-audit: ${WRONG.decision}`, suggestedFix: "Read AC-006 as FR-006 state.", authority: "requirement" }));
    store.artifact(run.runId, "decision", DECISION, canonical({ requestId: "reaudited-T003", taskId: "T003", findingIds: [], criterionIds: ["AC-006"], answer: ANSWER }));
    const finding = { id: "F1", kind: "correctness", severity: "high", basis: "spec", confidence: 1, requirementIds: ["FR-006"], criterionIds: ["AC-006"], file: TEST, symbol: null, evidenceIds: [evidence.id], claim: WRONG.finding, impact: "The rows are not the request's", suggestedFix: WRONG.brief };
    const id = store.addFinding(run.runId, finding as never, hashJson(finding), evidence.id);
    store.findingStatus(run.runId, id, "confirmed");
  });
  return { fixture, runId: run.runId, executor: executor!, drive, store };
}

describe("scenario: R82 tinyflate rev 56, resumed with a settled answer that contradicts the request's rows (#2561)", () => {
  test("the resume overrides the decision and the settled conflict, refutes the finding, and T003 completes on the request's rows", async () => {
    const { fixture, runId, executor, drive, store } = await blockedAtRev56();
    expect(store.run(runId)).toMatchObject({ status: "blocked", reason: "invalid_output" });
    expect(conflictDecisions(store, runId).map((d) => d.requestId)).toEqual(["reaudited-T003"]);
    await fixture.resume(runId);
    const records = store.artifacts(runId).filter((a) => a.logical_path.startsWith(`${ROW_CLAIM_DIR}resume-`)).map((a) => JSON.parse(store.readArtifact(runId, a.id)) as RowClaimRecord);
    expect(records.map((r) => r.ref).sort()).toEqual([AMENDMENT, ASSUMPTION, DECISION, "finding-F1"].sort());
    expect(records.find((r) => r.ref === DECISION)).toMatchObject({ mode: "on", verdict: "overridden", overrides: [DECISION, ASSUMPTION] });
    expect(conflictDecisions(store, runId)).toEqual([]);
    expect(settledConflicts(store, runId).some((c) => c.path === ASSUMPTION)).toBe(false);
    expect(store.findings(runId).find((f) => f.id === "F1")?.status).toBe("refuted");
    expect(store.state(runId).prompt).toContain("Row claims overridden on resume");
    const final = await drive();
    expect(final.status).toBe("completed");
    expect(executor.briefs.T003?.at(-1)).toContain(`${TEST} row 2 as the request gives it`);
    expect(readFileSync(join(fixture.root, TEST), "utf8")).toBe(testFile(300, 259));
  }, 90_000);

  test("with rowClaimCheck off the resume records in shadow, the decision stands and T003 blocks again", async () => {
    const { fixture, runId, drive, store } = await blockedAtRev56({ rowClaimCheck: "off" });
    await fixture.resume(runId);
    const records = store.artifacts(runId).filter((a) => a.logical_path.startsWith(`${ROW_CLAIM_DIR}resume-`)).map((a) => JSON.parse(store.readArtifact(runId, a.id)) as RowClaimRecord);
    expect(records.every((r) => r.mode === "shadow" && r.verdict === "would_override" && !r.overrides)).toBe(true);
    expect(conflictDecisions(store, runId).map((d) => d.requestId)).toEqual(["reaudited-T003"]);
    await drive();
    expect(store.run(runId)).toMatchObject({ status: "blocked", reason: "invalid_output" });
  }, 90_000);

  test("a task whose description restates the rows otherwise is briefed with the request's rows", async () => {
    const policy: RunPolicy = { ...fixturePolicy, rowRunRestore: "off" };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    const briefs: string[] = [];
    executor.execute = async (request: ExecutionRequest) => {
      const out = await original(request);
      if (request.profile.output === "plan") {
        const graph = (out.output as { taskGraph: TaskGraph }).taskGraph;
        graph.tasks[0] = { ...graph.tasks[0]!, description: WRONG.brief, writes: [...graph.tasks[0]!.writes, { path: TEST, action: "create" }] };
      }
      if (request.profile.output === "implementation") {
        briefs.push(request.prompt);
        mkdirSync(join(fixture.root, dirname(TEST)), { recursive: true });
        writeFileSync(join(fixture.root, TEST), testFile(300, 259));
      }
      return out;
    };
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy });
    let current = await service.drive(run.runId, signal());
    for (let i = 0; i < 8 && current.status === "waiting"; i++) {
      await fixture.approve(run.runId);
      current = await service.drive(run.runId, signal());
    }
    expect(briefs[0]).toContain("Task T001 restates prescribed rows differently from the request");
    const record = service.store.latestArtifact(run.runId, `${ROW_CLAIM_DIR}task-T001.json`);
    expect(record && JSON.parse(service.store.readArtifact(run.runId, record.id))).toMatchObject({ site: "task", mode: "on" });
  }, 90_000);
});

// The origin of the chain (art-290, art-298): a review finding that miscounts the request's rows
// against a file that holds them, which a skeptic confirmed.
describe("scenario: R82 tinyflate, a review finding that restates the request's rows otherwise (#2561)", () => {
  async function reviewed(extra: Partial<RunPolicy> = {}) {
    const policy: RunPolicy = { ...fixturePolicy, rowRunRestore: "off", ...extra };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    let reviews = 0;
    const sessions: string[] = [];
    executor.execute = async (request: ExecutionRequest) => {
      // The skeptic confirms the miscount with evidence, as art-298 did.
      if (request.profile.output === "refutation") {
        const context = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { extra: { evidence?: { id: string }[] } };
        const evidenceIds = (context.extra.evidence ?? []).map((e) => e.id).slice(0, 1);
        return { output: { schemaVersion: 1, findingId: "F1", decision: "confirmed", evidenceIds, explanation: WRONG.skeptic }, inputTokens: 25, outputTokens: 25 };
      }
      const out = await original(request);
      if (request.profile.output === "plan") {
        const graph = (out.output as { taskGraph: TaskGraph }).taskGraph;
        graph.tasks[0] = { ...graph.tasks[0]!, writes: [...graph.tasks[0]!.writes, { path: TEST, action: "create" }] };
      }
      if (request.profile.output === "implementation") {
        sessions.push(request.task?.id ?? "");
        mkdirSync(join(fixture.root, dirname(TEST)), { recursive: true });
        writeFileSync(join(fixture.root, TEST), testFile(300, 259));
      }
      if (request.profile.output === "review" && reviews++ === 0) {
        const context = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { extra: { evidence?: { id: string }[] } };
        out.output = {
          ...(out.output as object),
          verdict: "changes_requested",
          findings: [{ id: "F1", kind: "partial", severity: "high", basis: "spec", confidence: 1, noRepro: "This finding concerns exact source-literal transcription, not runtime behavior.", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: TEST, symbol: "main", evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [], claim: WRONG.finding, impact: "The passing suite does not preserve the required rows.", suggestedFix: "Restore both input literals exactly as supplied." }],
        };
      }
      return out;
    };
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy });
    let current = await service.drive(run.runId, signal());
    for (let i = 0; i < 8 && current.status === "waiting"; i++) {
      await fixture.approve(run.runId);
      current = await service.drive(run.runId, signal());
    }
    const errors = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/")).map((a) => service.store.readArtifact(run.runId, a.id));
    return { service, runId: run.runId, sessions, status: current.status, errors };
  }

  test("the host refutes the finding against the request's rows, and no corrective rewrites the file", async () => {
    const { service, runId, sessions, status } = await reviewed();
    expect(service.store.findings(runId).find((f) => f.id === "F1")?.status).toBe("refuted");
    const record = service.store.latestArtifact(runId, `${ROW_CLAIM_DIR}finding-F1.json`);
    expect(record && JSON.parse(service.store.readArtifact(runId, record.id))).toMatchObject({ site: "finding", mode: "on", verdict: "overridden" });
    expect(sessions).toEqual(["T001"]);
    expect(status).toBe("completed");
  }, 90_000);

  test("with rowClaimCheck off the record is shadow, the skeptic's confirmation stands and a corrective opens for the miscount", async () => {
    const { service, runId, sessions, errors } = await reviewed({ rowClaimCheck: "off" });
    const record = service.store.latestArtifact(runId, `${ROW_CLAIM_DIR}finding-F1.json`);
    expect(record && JSON.parse(service.store.readArtifact(runId, record.id))).toMatchObject({ mode: "shadow", verdict: "would_override" });
    // The refutation was valid: the run did not stop on it.
    expect(errors.some((e) => e.includes("Invalid refutation result"))).toBe(false);
    expect(errors).toEqual([]);
    // The confirmed miscount opens a corrective session for the file, as T008 was at R82.
    expect(service.store.findings(runId).find((f) => f.id === "F1")?.repair_task_id).toBe("T002");
    expect(sessions).toEqual(["T001", "T002"]);
  }, 90_000);
});
