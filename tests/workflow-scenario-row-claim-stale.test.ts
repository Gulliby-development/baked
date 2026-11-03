import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical, hashJson } from "../src/core/specs/hash.js";
import { conflictDecisions } from "../src/core/workflows/conflict-decisions.js";
import { repairSpecRows } from "../src/core/workflows/row-claim-repair.js";
import { literalCorrections, type RowClaimRecord, repairRowText } from "../src/core/workflows/row-claims.js";
import type { Analysis, RunPolicy, Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 82, tinyflate deflate 82f19908 rev 73 (#2563). After #2562 the resume overrode the
// decision that gave `tests/deflate_match_test.c` rows 306/283 bytes and refuted the finding, the
// file held the request's 300/259 and ctest passed. The run blocked `invalid_output` again: the
// correction T009 opened for that finding still said "restore the exact prescribed 306-byte x
// input", its last attempt's account and its brief repeated it, and the approved spec still cited
// `ab1805240200`, the stream of a 306-byte input.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const TEST = "tests/deflate_match_test.c";
const row = (input: string, out: string) => `run "deflate" "--level" "fixed" "--hex" stdin="${input}" => 0 "${out}\\n" ""`;
const ROWS = [row("61616161", "4b040200"), row("78".repeat(300), "ab1805440300"), row("71".repeat(259), "2b1c0500")];
const REQUEST = ["Create ready value.", "", "```text", `deflate_match_test in ${TEST} (3 rows)`, ...ROWS, "```", ""].join("\n");
const PATHS = [TEST];
const testFile = (x: number, q: number) =>
  [
    '#include "harness.h"',
    "int main(void) {",
    "  int failed = 0;",
    `  failed += row(ARGS("deflate", "--level", "fixed", "--hex"), "61616161", 0, "4b040200\\n", "");`,
    `  failed += row(ARGS("deflate", "--level", "fixed", "--hex"), "${"78".repeat(x)}", 0, "ab1805440300\\n", "");`,
    `  failed += row(ARGS("deflate", "--level", "fixed", "--hex"), "${"71".repeat(q)}", 0, "2b1c0500\\n", "");`,
    "  return failed;",
    "}",
    "",
  ].join("\n");

// The R82 texts (art-374 F1-2, art-448 T009's diagnostic, art-433/435 the overridden settlement).
const FINDING = "The first long matcher input is still not the prescribed literal: line 5 contains 312 repeated x bytes instead of the required 306.";
const FIX = `Restore the exact prescribed 306-byte x input in ${TEST} and update only its expected stream to the FR-003 result, ab1805240200.`;
const UNRESOLVED = `Restore the exact prescribed 306-byte x input on line 5 of ${TEST} and set its expected stream to ab1805240200.`;
const SETTLED = "The settled clarification specifies 306 repeated x bytes. This yields ab1805240200, not the original supplied ab1805440300.";
const DERIVATIONS: NonNullable<Analysis["derivations"]> = [
  { criterionId: "AC-006", row: `${TEST} row 2`, recomputed: 'exit 0; stdout "ab1805240200\\n"; stderr ""', matches: false, derivation: SETTLED },
];
/** AC-006 as the approved spec carried it at rev 73: the stream of the miscounted input. */
const STALE_THEN = `${TEST} keeps its 3 supplied rows; for the prescribed 306-byte x input the expected stream is ab1805240200, and every row passes`;
const spec: Spec = {
  ...fixtureSpec,
  requirements: [...fixtureSpec.requirements, { id: "FR-006", text: "Deliver exactly the supplied encoding rows, unchanged and in order.", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [...fixtureSpec.criteria, { id: "AC-006", requirementIds: ["FR-006"], given: "the supplied request row blocks", when: "the tests run", then: STALE_THEN, method: "automated" }],
};

describe("the run's texts put back from the request's rows (#2563)", () => {
  const record: RowClaimRecord = {
    schemaVersion: 1,
    site: "resume",
    ref: "decisions/clarification-reaudited-T009.json",
    mode: "on",
    verdict: "overridden",
    conflicts: [
      { path: TEST, row: 2, kind: "literal", claimed: "ab1805240200", prescribed: "ab1805440300\\n" },
      { path: TEST, row: 2, kind: "run", byte: 0x78, claimed: 306, prescribed: 300 },
    ],
  };
  const literals = literalCorrections([record]);

  test("an overridden record's wrong expected values map to the request's", () => {
    expect([...literals]).toEqual([["ab1805240200", "ab1805440300"]]);
    expect(literalCorrections([{ ...record, mode: "shadow" }]).size).toBe(0);
  });

  test("a sentence that gives a row the overridden counts or values is rewritten; the rest is kept", () => {
    const text = `${FIX} Keep src/deflate.c as it is. ${SETTLED}`;
    const { text: repaired, edits } = repairRowText(REQUEST, PATHS, text, literals);
    expect(repaired).toBe(
      `Restore the exact prescribed 300-byte x input in ${TEST} and update only its expected stream to the FR-003 result, ab1805440300. Keep src/deflate.c as it is. The settled clarification specifies 300 repeated x bytes. This yields ab1805440300, not the original supplied ab1805440300.`,
    );
    expect(edits).toHaveLength(3);
    // The q row of T009's diagnostic is named by its byte ("the q-row").
    expect(repairRowText(REQUEST, PATHS, "Update the q-row expected stream for its prescribed 283-byte input.", literals).text).toBe(
      "Update the q-row expected stream for its prescribed 259-byte input.",
    );
    // The host's own account quotes both sides and stays.
    const note = `${TEST} row 2: the request gives 300 bytes of 0x78, not 306; ${TEST} row 2: the request gives "ab1805440300\\n", not "ab1805240200".`;
    expect(repairRowText(REQUEST, PATHS, note, literals).text).toBe(note);
  });

  test("the approved spec's stale citation is repaired from the request's row", () => {
    const { spec: repaired, repaired: fields } = repairSpecRows(REQUEST, PATHS, spec, literals);
    expect(fields).toEqual([{ id: "AC-006", field: "then", before: STALE_THEN, after: STALE_THEN.replace("306", "300").replace("ab1805240200", "ab1805440300") }]);
    expect(repaired.criteria.find((c) => c.id === "AC-006")?.then).toContain("300-byte x input the expected stream is ab1805440300");
  });
});

// The rev 73 state, built as the run built it: T001 delivers the request's rows, a review finding
// miscounts them (as R82's did, before #2561 checked findings), its correction T002 blocks on the
// miscount, and the run holds a settled answer with 306 bytes and `ab1805240200`. The run then
// resumes on the current host, whose row checks are on.
const DECISION = "decisions/clarification-reaudited-T002.json";
const ASSUMPTION = "assumptions/conflicts/T002-reaudited.json";

async function rev73(options: { failing?: boolean; resumeOff?: boolean } = {}) {
  const policy: RunPolicy = { ...fixturePolicy, rowRunRestore: "off", rowClaimCheck: "off" };
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const original = executor.execute.bind(executor);
  const briefs: Record<string, string[]> = {};
  let reviews = 0;
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "refutation") {
      const context = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { extra: { evidence?: { id: string }[] } };
      const evidenceIds = (context.extra.evidence ?? []).map((e) => e.id).slice(0, 1);
      return { output: { schemaVersion: 1, findingId: "F1", decision: "confirmed", evidenceIds, explanation: "Line 5 does not hold the prescribed 306 bytes." }, inputTokens: 25, outputTokens: 25 };
    }
    const out = await original(request);
    if (request.profile.output === "plan") {
      const graph = (out.output as { taskGraph: TaskGraph & { specHash: string } }).taskGraph;
      graph.specHash = hashJson(spec);
      graph.tasks[0] = { ...graph.tasks[0]!, criterionIds: ["AC-001", "AC-006"], requirementIds: ["FR-001", "FR-006"], writes: [...graph.tasks[0]!.writes, { path: TEST, action: "create" }] };
    }
    if (request.profile.output === "review" || request.profile.output === "convergence") {
      const review = out.output as { coverage: { criterionId: string }[] };
      review.coverage = [...review.coverage, ...review.coverage.map((c) => ({ ...c, criterionId: "AC-006" }))];
      if (request.profile.output === "review" && reviews++ === 0) {
        const context = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { extra: { evidence?: { id: string }[] } };
        out.output = {
          ...(out.output as object),
          verdict: "changes_requested",
          findings: [{ id: "F1", kind: "partial", severity: "high", basis: "spec", confidence: 1, noRepro: "This finding concerns exact source-literal transcription.", requirementIds: ["FR-006"], criterionIds: ["AC-006"], file: TEST, symbol: "main", evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [], claim: FINDING, impact: "The x row is not the prescribed literal.", suggestedFix: FIX }],
        };
      }
    }
    if (request.profile.output !== "implementation") return out;
    const id = request.task?.id ?? "";
    (briefs[id] ??= []).push(request.prompt);
    const work = request.root ?? root;
    if (id === "T001") {
      mkdirSync(join(work, dirname(TEST)), { recursive: true });
      writeFileSync(join(work, TEST), testFile(300, 259));
      return out;
    }
    // The correction does what its brief says: it blocks while the brief asks for 306 bytes.
    if (/306-byte x input/.test(request.prompt)) {
      writeFileSync(join(work, "value.txt"), "ready");
      return { ...out, output: { schemaVersion: 1, taskId: id, outcome: "blocked", summary: "The x input cannot be restored to 306 bytes without breaking the rows.", evidenceIds: [], unresolved: [UNRESOLVED] } };
    }
    writeFileSync(join(work, "value.txt"), "ready");
    return { ...out, output: { schemaVersion: 1, taskId: id, outcome: "implemented", summary: "The rows hold as the request gives them.", evidenceIds: [], unresolved: [] } };
  };
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy });
  let current = await service.drive(run.runId, signal());
  for (let i = 0; i < 10 && current.status === "waiting"; i++) {
    if (service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
    await fixture.approve(run.runId);
    current = await service.drive(run.runId, signal());
  }
  const { store } = service;
  const blockedAt = store.run(run.runId);
  // What the run settled before the block (art-433, art-435), as #2562's resume found it.
  store.transaction(() => {
    store.artifact(run.runId, "assumption", ASSUMPTION, canonical({ taskId: "T002", assumed: `The requirements FR-006 win over the criteria AC-006: ${SETTLED}`, derivations: DERIVATIONS }));
    store.artifact(run.runId, "decision", DECISION, canonical({ requestId: "reaudited-T002", taskId: "T002", findingIds: ["F1"], criterionIds: ["AC-006"], answer: `Settled by a second audit (${ASSUMPTION}): ${SETTLED}` }));
    const state = store.state(run.runId);
    state.prompt += `\nSettled spec conflict (${ASSUMPTION}): task T002 reported that the spec contradicts the code. ${SETTLED} Implement what FR-006 state.`;
    store.saveState(run.runId, state);
  });
  if (options.failing) writeFileSync(join(root, "value.txt"), "draft");
  // The run resumes on a host whose row checks are on.
  if (!options.resumeOff) {
    const db = (store as unknown as { db: Database }).db;
    const { rowClaimCheck: _off, ...on } = policy;
    db.run("UPDATE runs SET policy_json=? WHERE id=?", [canonical(on), run.runId]);
  }
  return { fixture, runId: run.runId, store, briefs, blockedAt, root };
}

describe("scenario: R82 tinyflate rev 73, a correction of an overridden restatement (#2563)", () => {
  test("resumed, the spec and the settled notes are repaired, the stale correction is closed by the host and the run completes", async () => {
    const { fixture, runId, store, briefs, blockedAt, root } = await rev73({ failing: false });
    const before = briefs.T002?.length ?? 0;
    // Rev 73 as it was: blocked at the correction, which asked for 306 bytes.
    expect(blockedAt).toMatchObject({ status: "blocked", reason: "invalid_output" });
    expect(store.tasks(runId).find((t) => t.id === "T002")?.status).toBe("blocked");
    expect(briefs.T002?.at(-1)).toContain("306-byte x input");
    await fixture.resume(runId);
    // #2561: the settled answer is overridden and the finding refuted.
    expect(conflictDecisions(store, runId)).toEqual([]);
    expect(store.findings(runId).find((f) => f.id === "F1")?.status).toBe("refuted");
    // #2563: the approved spec's citation and the settled note follow the request.
    const state = store.state(runId);
    expect(state.spec?.criteria.find((c) => c.id === "AC-006")?.then).toContain("300-byte x input the expected stream is ab1805440300");
    expect(state.prompt).toContain("The settled clarification specifies 300 repeated x bytes");
    expect(state.prompt).not.toContain("ab1805240200.");
    const repair = store.artifacts(runId).find((a) => a.logical_path.startsWith("spec-repairs/row-claims-"));
    expect(repair && JSON.parse(store.readArtifact(runId, repair.id)).spec[0]).toMatchObject({ id: "AC-006", field: "then" });
    const final = await fixture.service.drive(runId, signal());
    expect(final.status).toBe("completed");
    // T002 is closed as stale on its passing checks: no session met the miscount again.
    expect(briefs.T002).toHaveLength(before);
    const stale = store.latestArtifact(runId, "tasks/T002/stale-correction.json");
    expect(stale && JSON.parse(store.readArtifact(runId, stale.id))).toMatchObject({ taskId: "T002", findingIds: ["F1"], checks: ["check"] });
    expect(readFileSync(join(root, TEST), "utf8")).toBe(testFile(300, 259));
  }, 90_000);

  test("when the correction's checks fail, its brief is rebuilt from the request's rows and it completes", async () => {
    const { fixture, runId, store, briefs } = await rev73({ failing: true });
    const run = await fixture.service.get(runId);
    // The person keeps the edit that makes the correction's check fail.
    await fixture.service.resume(runId, { commandId: newId(), expectedRevision: run.revision }, { acceptWorkspace: true });
    const final = await fixture.service.drive(runId, signal());
    expect(final.status).toBe("completed");
    expect(store.latestArtifact(runId, "tasks/T002/stale-correction.json")).toBeNull();
    const brief = briefs.T002?.at(-1) ?? "";
    expect(brief).not.toContain("306-byte x input");
    expect(brief).toContain("300-byte x input");
    expect(brief).toContain("ab1805440300");
  }, 90_000);

  test("with rowClaimCheck off the resume repairs nothing and the correction blocks again, as at rev 73", async () => {
    const { fixture, runId, store, briefs } = await rev73({ resumeOff: true });
    await fixture.resume(runId);
    await fixture.service.drive(runId, signal());
    expect(store.run(runId)).toMatchObject({ status: "blocked", reason: "invalid_output" });
    expect(store.state(runId).spec?.criteria.find((c) => c.id === "AC-006")?.then).toBe(STALE_THEN);
    expect(briefs.T002?.at(-1)).toContain("306-byte x input");
  }, 90_000);
});
