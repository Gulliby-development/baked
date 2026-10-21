import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashJson } from "../src/core/specs/hash.js";
import { indexTable, reauditExtra } from "../src/core/workflows/conflict-rows.js";
import type { Analysis, Spec } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 53, jsonsplice `paths` T006 (#1788). AC-007 gives the document
// `[ /* c */ 1e+02, "a", ]` and the error `trailing comma at column 20`, where FR-005 counts
// columns from 1 and the comma is at 21. The derivation audit miscounted and verified the row; the
// test task ran the parser, saw column 21 and reported spec_conflict. The host trusted the audit
// over the run and settled for the row, the task reported the same conflict again, and a person
// was asked (1.73M tokens).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const INPUT = `[ /* c */ 1e+02, "a", ]`;
const WRONG = "trailing comma at column 20";
const RIGHT = "trailing comma at column 21";
const TEST = "tests/paths_test.go";
const goTest = (error: string) =>
  `package jsonsplice\n\nvar cases = []struct{ doc, err string }{\n\t{\`${INPUT}\`, \`${error}\`},\n}\n`;

const spec: Spec = {
  ...fixtureSpec,
  requirements: [...fixtureSpec.requirements, { id: "FR-005", text: "An error names the 1-based column of the character it is about", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [
    ...fixtureSpec.criteria,
    { id: "AC-007", requirementIds: ["FR-005"], given: `the document \`${INPUT}\``, when: "the parser reads it", then: `it fails with \`${WRONG}\``, method: "automated" },
  ],
};
const derivation = (matches: boolean): NonNullable<Analysis["derivations"]>[number] => ({
  criterionId: "AC-007",
  row: `${INPUT} -> ${WRONG}`,
  recomputed: matches ? "column 20" : "column 21",
  matches,
  derivation: matches ? "The comma after \"a\" is the 20th character" : "Index table: the comma is at UTF-16 index 20, so 1-based column 21",
});

/** `reaudit` is the re-audit's verdict on AC-007; the first audit always verifies the row. */
async function conflict(reaudit: boolean) {
  const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "ask" } });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const original = executor.execute.bind(executor);
  const prompts: string[] = [];
  const walks: string[][] = [];
  let conflicts = 0;
  let reaudits = 0;
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "plan") {
      const out = await original(request);
      const graph = (out.output as { taskGraph: { specHash: string; tasks: Record<string, unknown>[] } }).taskGraph;
      const code = graph.tasks[0] as Record<string, unknown> & { writes: { path: string; action: string }[] };
      graph.specHash = hashJson(spec);
      graph.tasks = [{ ...code, id: "T001", criterionIds: ["AC-001", "AC-007"], writes: [...code.writes, { path: TEST, action: "create" }] }];
      return out;
    }
    if (request.profile.output === "analysis") {
      const out = await original(request);
      const second = request.prompt.includes("Derivation re-audit");
      if (second) reaudits++;
      out.output = { ...(out.output as object), derivations: [derivation(second ? reaudit : true)] };
      return out;
    }
    if (request.profile.output === "review" || request.profile.output === "convergence") {
      const out = await original(request);
      const review = out.output as { coverage: { criterionId: string }[] };
      review.coverage = [...review.coverage, ...review.coverage.map((c) => ({ ...c, criterionId: "AC-007" }))];
      return out;
    }
    if (request.profile.output !== "implementation") return original(request);
    const work = request.root ?? root;
    prompts.push(request.prompt);
    mkdirSync(join(work, dirname(TEST)), { recursive: true });
    // The task follows the requirements once they win; it follows the row only where the re-audit
    // confirms it, as when the implementer had miscounted.
    const forRequirements = /Implement what FR-005 state/.test(request.prompt);
    const forRow = /Keep each row's input and expected value exactly as written/.test(request.prompt);
    writeFileSync(join(work, "value.txt"), forRequirements || forRow ? "ready" : "draft");
    writeFileSync(join(work, TEST), goTest(forRequirements ? RIGHT : WRONG));
    if (forRequirements || (forRow && reaudit)) {
      walks.push((await request.caseCheck?.(work)) ?? []);
      return { output: { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Path tests", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    conflicts++;
    return {
      output: { schemaVersion: 1, taskId: "T001", outcome: "spec_conflict", summary: `AC-007 requires ${WRONG} for ${INPUT}, but the parser reports column 21: FR-005 counts columns from 1 and the comma is the 21st character.`, evidenceIds: [], unresolved: ["Which column is right?"] },
      inputTokens: 25,
      outputTokens: 25,
    };
  };
  const run = await fixture.start();
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
    asked: service.store.requests(run.runId).filter((r) => r.kind === "clarification"),
    conflicts,
    reaudits,
    prompts,
    walks,
    read,
    decisions: service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("decisions/clarification-")).map((a) => JSON.parse(service.store.readArtifact(run.runId, a.id)) as { criterionIds?: string[]; requestId: string }),
  };
}

describe("scenario: jsonsplice paths T006, a miscounted row the derivation audit verified (#1788)", () => {
  test("a second audit against the report overrules the row for the requirements, and no person is asked", async () => {
    const result = await conflict(false);
    expect(result.reaudits).toBe(1);
    expect(result.conflicts).toBe(1);
    expect(result.asked).toEqual([]);
    expect(result.read("assumptions/conflicts/T001-audited.json")).toBeNull();
    expect(result.read("assumptions/conflicts/T001-reaudited.json")?.assumed).toContain("The requirements FR-005 win over the criteria AC-007");
    expect(result.read("amendments/conflict-T001.json")).toMatchObject({ criterionIds: ["AC-007"], requirementIds: ["FR-005"], authority: "requirement" });
    expect(result.decisions.find((d) => d.requestId === "reaudited-T001")?.criterionIds).toEqual(["AC-007"]);
    // Without the release the walk demands the overruled `column 20` in the test.
    expect(result.walks).toEqual([[]]);
    expect(result.status).toBe("completed");
  }, 90_000);

  test("a second audit that agrees still settles for the rows", async () => {
    const result = await conflict(true);
    expect(result.reaudits).toBe(1);
    expect(result.asked).toEqual([]);
    expect(result.read("assumptions/conflicts/T001-audited.json")?.assumed).toContain("a second audit against this report");
    expect(result.prompts.at(-1)).toContain("Keep each row's input and expected value exactly as written");
    expect(result.status).toBe("completed");
  }, 90_000);
});

describe("the index table a re-audit counts positions from (#1788)", () => {
  test("ASCII: UTF-16 indexes only, which are also byte offsets and code points", () => {
    const table = indexTable(INPUT);
    expect(table).toStartWith('UTF-16 index 0:"[" 1:" " 2:"/"');
    expect(table).toContain('20:","');
    expect(table).not.toContain("UTF-8");
  });

  test("multibyte: UTF-8 byte offsets as well, for Go, Rust and C byte columns", () => {
    const table = indexTable(`"é",]`);
    expect(table).toContain('UTF-16 index 0:"\\"" 1:"é" 2:"\\"" 3:"," 4:"]"');
    expect(table).toContain('UTF-8 byte offset 0:"\\"" 1:"é" 3:"\\"" 4:"," 5:"]"');
  });

  test("astral characters: a UTF-16 index skips two units, as JavaScript, Java and C# count", () => {
    const table = indexTable("😀,");
    expect(table).toContain('UTF-16 index 0:"😀" 2:","');
    expect(table).toContain('UTF-8 byte offset 0:"😀" 4:","');
  });

  test("an input too long to tabulate gets no table", () => {
    expect(indexTable("x".repeat(201))).toBe("");
    expect(indexTable("")).toBe("");
  });

  test("the re-audit gets the report and each quoted input with its table", () => {
    const criterion = spec.criteria.at(-1)!;
    const extra = reauditExtra(spec, [{ criterion, misquoted: [], audit: [derivation(true)] }], "the parser reports column 21", []);
    expect(extra.criteria.map((c) => c.id)).toEqual(["AC-007"]);
    expect(extra.requirements.map((r) => r.id)).toEqual(["FR-005"]);
    expect(extra.report).toBe("the parser reports column 21");
    expect(extra.inputs.find((i) => i.literal === INPUT)?.index).toBe(indexTable(INPUT));
    expect(extra.note).toContain("read it off the index table");
  });
});
