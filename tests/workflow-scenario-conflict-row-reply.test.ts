import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { conflictRowDiff, conflictRowEvidence } from "../src/core/workflows/conflict-row-reply.js";
import { evidenceDecision } from "../src/core/workflows/evidence-decisions.js";
import { rowBlockDrifts } from "../src/core/workflows/row-block-drift.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { replayEvidenceDecisions } from "../src/core/workflows/trace.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// R80 deltaglue cli T010 (run 25985b82, #2493): the model transcribed row 2 of
// `tests/problems-choices-b.test.ts` without the input's final `data: [DONE]\n\n` event, the
// program (correct) printed one more line, and the model reported a "contradictory prescribed
// row". The host settled "the approved spec and the request win over the test this run wrote",
// and the next attempt changed the EXPECTED output instead of restoring the input (1,176,244
// tokens in 13 attempts, the changed row delivered). The host now compares a conflict's
// prescribed-row file with the request's rows (`rowBlockDrifts`) and answers with the row diff,
// keeping the request side, without a model settle (`conflictRowReply: "on"`; shadow otherwise).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

interface Shape {
  path: string;
  /** The request's fenced row block, header first. */
  block: string[];
  /** The test file with every row as the request gives it. */
  faithful: string;
  /** The file with one row's input shortened (or its expected output changed). */
  drifted: string;
  row: number;
  /** The literal the drifted file lacks, as the request spells it. */
  missing: string;
}

// One case per row notation, as in tests/workflow-scenario-row-block-drift.test.ts.
const RATDEC: Shape = {
  path: "test/stdin_test.exs",
  block: [
    "StdinTest in test/stdin_test.exs (2 rows, row(ARGS, STDIN, CODE, OUT, ERR))",
    'row(["eval"], "7/3\\n", 0, "7/3\\n", "")',
    'row(["eval", "--as", "mixed"], "7/3\\n", 0, "2 1/3\\n", "")',
  ],
  faithful: [
    "defmodule Ratdec.StdinTest do",
    "  use ExUnit.Case, async: true",
    "",
    '  test "eval reads stdin" do',
    '    assert_row(["eval"], "7/3\\n", 0, "7/3\\n", "")',
    "  end",
    "",
    '  test "eval --as mixed" do',
    '    assert_row(["eval", "--as", "mixed"], "7/3\\n", 0, "2 1/3\\n", "")',
    "  end",
    "end",
    "",
  ].join("\n"),
  drifted: "",
  row: 2,
  missing: "2 1/3\\n",
};
// R80 ratdec core T014: the row expects the error the code under test returned.
RATDEC.drifted = RATDEC.faithful.replace('"mixed"], "7/3\\n", 0, "2 1/3\\n", "")', '"mixed"], "7/3\\n", 1, "", "ratdec: 7/3: unsupported format\\n")');

const CHUNK = (content: string) => `data: {\\"choices\\":[{\\"delta\\":{\\"content\\":\\"${content}\\"}}]}\\n\\n`;
const DELTAGLUE: Shape = {
  path: "tests/problems-choices-b.test.ts",
  block: [
    "ProblemsChoicesBTests in tests/problems-choices-b.test.ts (2 rows, { args, stdin, code, out, err })",
    `{ args: ["problems", "--choices"], stdin: "${CHUNK("Hello")}", code: 0, out: "Hello\\n", err: "" }`,
    `{ args: ["problems", "--choices"], stdin: "${CHUNK("world")}data: [DONE]\\n\\n", code: 0, out: "world\\n", err: "" }`,
  ],
  faithful: [
    'import { expect, test } from "bun:test";',
    'import { run } from "./helpers/run";',
    "",
    "const rows = [",
    `  { args: ["problems", "--choices"], stdin: 'data: {"choices":[{"delta":{"content":"Hello"}}]}\\n\\n', code: 0, out: "Hello\\n", err: "" },`,
    `  { args: ["problems", "--choices"], stdin: 'data: {"choices":[{"delta":{"content":"world"}}]}\\n\\n' +`,
    `      'data: [DONE]\\n\\n', code: 0, out: "world\\n", err: "" },`,
    "];",
    "",
    "for (const [i, row] of rows.entries())",
    "  test(`row ${i + 1}`, async () => expect(await run(row.args, row.stdin)).toEqual({ code: row.code, out: row.out, err: row.err }));",
    "",
  ].join("\n"),
  drifted: "",
  row: 2,
  missing: `${CHUNK("world")}data: [DONE]\\n\\n`,
};
// R80 deltaglue cli T010: the input lost its final event.
DELTAGLUE.drifted = DELTAGLUE.faithful.replace(`\\n\\n' +\n      'data: [DONE]\\n\\n', code: 0`, `\\n\\n', code: 0`);

const SHAPES: Record<string, Shape> = { elixir: RATDEC, typescript: DELTAGLUE };

const request = (shape: Shape) =>
  ["Build the CLI. Write value.txt with ready.", "", "The prescribed rows, one test each:", "", "```text", ...shape.block, "```", ""].join("\n");

interface Script {
  shape: Shape;
  /** The file the conflicting attempt leaves: the drifted one, or every row as given. */
  file: "drifted" | "faithful";
  mode?: "on";
}

async function conflict(script: Script) {
  const { shape } = script;
  const policy: RunPolicy = { ...fixturePolicy, clarification: "assume", ...(script.mode ? { conflictRowReply: script.mode } : {}) };
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const original = executor.execute.bind(executor);
  const prompts: string[] = [];
  let conflicts = 0;
  executor.execute = async (req: ExecutionRequest) => {
    if (req.profile.output === "plan") {
      const out = await original(req);
      const graph = (out.output as { taskGraph: { tasks: (Record<string, unknown> & { writes: { path: string; action: string }[] })[] } }).taskGraph;
      const code = graph.tasks[0]!;
      graph.tasks = [{ ...code, id: "T001", writes: [...code.writes, { path: shape.path, action: "create" }] }];
      return out;
    }
    if (req.profile.output !== "implementation") return original(req);
    const work = req.root ?? root;
    prompts.push(req.prompt);
    mkdirSync(join(work, dirname(shape.path)), { recursive: true });
    writeFileSync(join(work, "value.txt"), "ready");
    if (conflicts > 0) {
      writeFileSync(join(work, shape.path), shape.faithful);
      return { output: { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Restored the row as given", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    conflicts++;
    writeFileSync(join(work, shape.path), script.file === "drifted" ? shape.drifted : shape.faithful);
    return {
      output: {
        schemaVersion: 1,
        taskId: "T001",
        outcome: "spec_conflict",
        summary: `Row ${shape.row} of ${shape.path} is a contradictory prescribed row: the program prints another output than the row expects.`,
        evidenceIds: [],
        unresolved: ["Which side is right?"],
        conflictSides: [
          { kind: "request", quote: shape.block[shape.row] ?? "" },
          { kind: "test", ref: shape.path, quote: "row" },
        ],
      },
      inputTokens: 25,
      outputTokens: 25,
    };
  };
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: request(shape), ownerLabel: "test", policy });
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
    prompts,
    read,
    status: (await service.get(started.runId)).status,
    evidence: () => replayEvidenceDecisions(service.store, started.runId).filter((b) => b.site === "prescribed-rows"),
  };
}

describe("scenario: a spec conflict about a prescribed-row file is answered with the row diff (#2493)", () => {
  for (const [language, shape] of Object.entries(SHAPES)) {
    test(`${language}: with conflictRowReply on, the host names the row and the missing literal and keeps the request side`, async () => {
      const result = await conflict({ shape, file: "drifted", mode: "on" });
      const lacks = `row ${shape.row} of ${shape.path} lacks "${shape.missing}"`;
      expect(result.read("conflicts/rows/T001-1.json")).toMatchObject({ schemaVersion: 1, taskId: "T001", report: 1, mode: "on", decision: true, files: [{ path: shape.path, delivered: true, rows: 2, drifting: [shape.row] }] });
      expect(result.read("conflicts/rows/T001-1.json")?.reply).toContain(lacks);
      expect(result.read("conflicts/evidence/prescribed-rows-T001-1.json")).toMatchObject({ site: "prescribed-rows", eligible: true, evidence: "verified", decision: true });
      expect(result.read("assumptions/conflicts/T001-rows.json")?.assumed).toContain("The request's rows win");
      // No model settle: neither the request settle nor the own-test settle was taken.
      expect(result.read("assumptions/conflicts/T001.json")).toBeNull();
      expect(result.read("assumptions/conflicts/T001-request.json")).toBeNull();
      expect(result.prompts).toHaveLength(2);
      // The next attempt reads it inside its JSON input.
      expect(result.prompts[1]).toContain(JSON.stringify(lacks).slice(1, -1));
      expect(result.prompts[1]).toContain("change no other row and no expected output to fit the program");
      expect(result.evidence()).toEqual([{ site: "prescribed-rows", ref: "T001", report: 1, recorded: true, replayed: true }]);
      expect(result.status).toBe("completed");
    }, 90_000);

    test(`${language}: in shadow the reply is only recorded, and the conflict takes today's path`, async () => {
      const result = await conflict({ shape, file: "drifted" });
      expect(result.read("conflicts/rows/T001-1.json")).toMatchObject({ mode: "shadow", decision: true });
      expect(result.read("conflicts/rows/T001-1.json")?.reply).toContain(`row ${shape.row} of ${shape.path} lacks`);
      expect(result.read("assumptions/conflicts/T001-rows.json")).toBeNull();
      expect(result.prompts[1] ?? "").not.toContain("The host compared the file with the request's rows");
    }, 90_000);

    test(`${language}: a file that keeps every row is offered evidence the host could not find, and settles nothing`, async () => {
      const result = await conflict({ shape, file: "faithful", mode: "on" });
      expect(result.read("conflicts/rows/T001-1.json")).toMatchObject({ mode: "on", decision: false, reply: null, files: [{ path: shape.path, delivered: true, drifting: [] }] });
      expect(result.read("conflicts/evidence/prescribed-rows-T001-1.json")).toMatchObject({ evidence: "unverified", decision: false });
      expect(result.read("assumptions/conflicts/T001-rows.json")).toBeNull();
    }, 90_000);
  }
});

describe("the row diff and its evidence (#2493)", () => {
  const graph = (path: string) => ({ tasks: [{ id: "T010", origin: "planned", writes: [{ path, action: "create" }] }] }) as unknown as Pick<TaskGraph, "tasks">;

  test("the diff reads the drifting rows only through rowBlockDrifts", () => {
    const [compared] = rowBlockDrifts(request(DELTAGLUE), graph(DELTAGLUE.path), () => DELTAGLUE.drifted);
    expect(conflictRowDiff(compared?.drifts ?? [])).toBe(`row 2 of ${DELTAGLUE.path} lacks "${DELTAGLUE.missing}" (the row as the request gives it: ${DELTAGLUE.block[2]})`);
  });

  test("absent without a prescribed-row file, unverified when it keeps its rows or is not there, verified when it drifts", () => {
    expect(conflictRowEvidence([])).toBe("absent");
    expect(conflictRowEvidence([{ path: "a", delivered: true, rows: 2, drifting: [] }])).toBe("unverified");
    expect(conflictRowEvidence([{ path: "a", delivered: false, rows: 0, drifting: [] }])).toBe("unverified");
    expect(conflictRowEvidence([{ path: "a", delivered: true, rows: 2, drifting: [2] }])).toBe("verified");
    // The site has no wording rule: only the row comparison settles.
    for (const evidence of ["verified", "unverified", "absent"] as const)
      expect(evidenceDecision({ site: "prescribed-rows", eligible: true, evidence, wording: false, fallback: false })).toBe(evidence === "verified");
  });
});
