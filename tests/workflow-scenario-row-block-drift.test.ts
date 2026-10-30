import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  measureRows,
  ROW_BLOCK_DIR,
  type RowMeasure,
  rowBlockDriftSummary,
  rowBlockDrifts,
  rowLiterals,
} from "../src/core/workflows/row-block-drift.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { exportTrace, replayRowBlocks, replayTrace } from "../src/core/workflows/trace.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #2486: the case walk demands only the literals a criterion cites, and the request's row blocks
// were read only for pricing (#2455) and row slices (#2466). Bench round 80 accepted two changed
// rows: deltaglue cli T010 transcribed row 2 of `tests/problems-choices-b.test.ts` without the
// input's final `data: [DONE]\n\n` event (then changed the expected output to match), and ratdec
// core T014 rewrote the stdin row `eval --as mixed` of `test/stdin_test.exs` to expect an error the
// brief never names. The host now compares each prescribed row's quoted literals with the
// delivered file at the checks stage (shadow).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Shape {
  path: string;
  /** The request's fenced row block, header first. */
  block: string[];
  /** The test file with every row as the request gives it, in the language's own spelling. */
  faithful: string;
  /** The R80 file: one row changed or shortened. */
  drifted: string;
  /** The drifting row and the literals the drifted file lacks, as the request spells them. */
  row: number;
  missing: string[];
}

// ratdec (Elixir): `row(ARGS, STDIN, CODE, OUT, ERR)` rows; the test spells a two-line output as a
// heredoc, whose lines carry the test's indentation.
const RATDEC: Shape = {
  path: "test/stdin_test.exs",
  block: [
    "StdinTest in test/stdin_test.exs (3 rows, row(ARGS, STDIN, CODE, OUT, ERR))",
    'row(["eval"], "7/3\\n", 0, "7/3\\n", "")',
    'row(["eval", "--steps"], "1/2 + 1/3\\n", 0, "1/2 + 1/3\\n= 5/6\\n", "")',
    'row(["eval", "--as", "mixed"], "7/3\\n", 0, "2 1/3\\n", "")',
  ],
  faithful: [
    "defmodule Ratdec.StdinTest do",
    "  use ExUnit.Case, async: true",
    "  import Ratdec.RowCase",
    "",
    '  test "eval reads stdin" do',
    '    assert_row(["eval"], "7/3\\n", 0, "7/3\\n", "")',
    "  end",
    "",
    '  test "eval --steps" do',
    '    assert_row(["eval", "--steps"], "1/2 + 1/3\\n", 0, """',
    "    1/2 + 1/3",
    "    = 5/6",
    '    """, "")',
    "  end",
    "",
    '  test "eval --as mixed" do',
    '    assert_row(["eval", "--as", "mixed"], "7/3\\n", 0, "2 1/3\\n", "")',
    "  end",
    "end",
    "",
  ].join("\n"),
  drifted: "",
  row: 3,
  missing: ["2 1/3\\n"],
};
// R80 T014: the row now expects the placeholder error core's own render returned.
RATDEC.drifted = RATDEC.faithful.replace(
  '"mixed"], "7/3\\n", 0, "2 1/3\\n", "")',
  '"mixed"], "7/3\\n", 1, "", "ratdec: 7/3: unsupported format\\n")',
);

// deltaglue (TypeScript): object rows; the test spells the JSON inside single-quoted strings and
// splits row 2's input into two adjacent strings.
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
  missing: [`${CHUNK("world")}data: [DONE]\\n\\n`],
};
// R80 T010: the input lost its final event, and the expected output was changed to match.
DELTAGLUE.drifted = DELTAGLUE.faithful.replace(
  `\\n\\n' +\n      'data: [DONE]\\n\\n', code: 0, out: "world\\n"`,
  `\\n\\n', code: 0, out: "world\\nstream ended without [DONE]\\n"`,
);

const SHAPES: Record<string, Shape> = { elixir: RATDEC, typescript: DELTAGLUE };

const request = (shape: Shape) =>
  ["Build the CLI.", "", "The prescribed rows, one test each:", "", "```text", ...shape.block, "```", ""].join("\n");
const graphOf = (path: string, id = "T010"): Pick<TaskGraph, "tasks"> =>
  ({ tasks: [{ id, origin: "planned", writes: [{ path, action: "create" }] }] }) as unknown as Pick<TaskGraph, "tasks">;

describe("rowBlockDrifts: delivered test files against the request's prescribed rows (#2486)", () => {
  for (const [language, shape] of Object.entries(SHAPES)) {
    test(`${language}: the file with every row as given records its rows and no drift`, () => {
      expect(shape.drifted).not.toBe(shape.faithful);
      const [compared] = rowBlockDrifts(request(shape), graphOf(shape.path), () => shape.faithful);
      expect(compared?.record).toMatchObject({ schemaVersion: 1, path: shape.path, tasks: ["T010"], mode: "shadow", delivered: true, drifting: [] });
      expect(compared?.record.rows).toHaveLength(shape.block.length - 1);
      expect(compared?.record.rows.every((r) => r.literals > 0 && !r.missing.length)).toBe(true);
      expect(compared?.drifts).toEqual([]);
    });

    test(`${language}: the R80 file with one row changed drifts on that row, naming the literal it lacks`, () => {
      const [compared] = rowBlockDrifts(request(shape), graphOf(shape.path), () => shape.drifted);
      expect(compared?.record.drifting).toEqual([shape.row]);
      expect(compared?.drifts).toHaveLength(1);
      const [drift] = compared?.drifts ?? [];
      expect(drift).toMatchObject({ path: shape.path, tasks: ["T010"], row: shape.row, text: shape.block[shape.row] });
      expect(drift?.missing.map((m) => m.text)).toEqual(shape.missing);
      expect(rowBlockDriftSummary(drift!)).toBe(
        `T010 delivered ${shape.path} without row ${shape.row} of the request's row block as given: the file lacks ${shape.missing.map((m) => `"${m}"`).join(", ")} (row: ${shape.block[shape.row]}). A repair task would restore the row from the request's text; the prescribed row wins over a test this run wrote.`,
      );
    });
  }

  test("each quoted literal of a row is read, double or single quoted, escapes kept; an apostrophe in a word is no quote", () => {
    expect(rowLiterals('row(["eval", "--as"], "7/3\\n", 0, "say \\"hi\\"", \'x\')')).toEqual(["eval", "--as", "7/3\\n", 'say \\"hi\\"', "x"]);
    expect(rowLiterals("run it's fine => 0 \"ok\"")).toEqual(["ok"]);
  });

  test("an empty literal says nothing, and a <placeholder> stands for what the test chooses", () => {
    expect(measureRows(['row(["a"], "", 0, "", "")'], 'assert_row(["a"], "x", 0, "y", "z")')).toEqual([{ row: 1, literals: 1, missing: [] }]);
    expect(measureRows(['run ls => 0 "<dir>/out.txt\\n"'], 'expect(out).toBe(`${tmp}/out.txt\\n`)')).toEqual([{ row: 1, literals: 1, missing: [] }]);
  });

  test("only test files the graph writes are compared; a file that is not there records no rows", () => {
    expect(rowBlockDrifts(request(DELTAGLUE), graphOf("src/cli.ts"), () => DELTAGLUE.drifted)).toEqual([]);
    const [compared] = rowBlockDrifts(request(DELTAGLUE), graphOf(DELTAGLUE.path), () => null);
    expect(compared?.record).toMatchObject({ delivered: false, rows: [], drifting: [] });
    expect(compared?.drifts).toEqual([]);
  });
});

/** The fixture flow, whose one task also writes `shape.path` with `content`. */
class RowsExecutor extends FixtureExecutor {
  constructor(
    private workspace: string,
    private path: string,
    private content: string,
  ) {
    super(workspace);
  }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const graph = (result.output as { taskGraph: TaskGraph }).taskGraph;
      graph.tasks[0]?.writes.push({ path: this.path, action: "create" });
    }
    if (request.profile.output === "implementation") {
      const target = join(this.workspace, this.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, this.content);
    }
    return result;
  }
}

async function deliver(shape: Shape, content: string, workflowId: "sdd" | "quick" = "sdd") {
  const policy: RunPolicy = { ...fixturePolicy, ...(workflowId === "quick" ? { clarification: "assume" as const } : {}) };
  const fixture = workflowFixture({ policy, executor: (root) => new RowsExecutor(root, shape.path, content) });
  cleanups.push(fixture.dispose);
  const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId, prompt: `Create ready value.\n\n${request(shape)}`, ownerLabel: "test", policy });
  let current = await fixture.service.drive(run.runId, new AbortController().signal);
  for (let i = 0; i < 5 && current.status === "waiting"; i++) {
    if (fixture.service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
    await fixture.approve(run.runId);
    current = await fixture.service.drive(run.runId, new AbortController().signal);
  }
  const wouldStops = fixture.service.store
    .eventsOfType(run.runId, "decision.would_stop")
    .map((e) => e.payload as { reason: string; mode: string; key: string; summary: string; inputs: Record<string, unknown> })
    .filter((p) => p.reason === "row_block_drift");
  return { final: await fixture.service.get(run.runId), wouldStops, fixture, runId: run.runId };
}

describe("scenario: R80, a run delivers a prescribed row file with one row changed (#2486)", () => {
  for (const [language, shape] of Object.entries(SHAPES))
    test(`${language}: the checks stage records a shadow row_block_drift naming the row, and the run still completes`, async () => {
      const { final, wouldStops, fixture, runId } = await deliver(shape, shape.drifted);
      expect(wouldStops).toHaveLength(1);
      expect(wouldStops[0]).toMatchObject({
        mode: "shadow",
        key: `${shape.path}#row-${shape.row}`,
        inputs: { path: shape.path, tasks: ["T001"], row: shape.row, missing: shape.missing.map((text) => ({ text })) },
      });
      expect(wouldStops[0]?.summary).toContain(`without row ${shape.row} of the request's row block`);
      // Shadow: nothing stops.
      expect(final.status).toBe("completed");
      // The record holds counts only, and the replay decides it as the run did.
      const replayed = replayRowBlocks(fixture.service.store, runId);
      expect(replayed.length).toBeGreaterThan(0);
      expect(replayed.every((b) => b.path === shape.path && JSON.stringify(b.recorded) === JSON.stringify(b.replayed))).toBe(true);
      expect(replayed.at(-1)?.recorded).toEqual([shape.row]);
      const records = fixture.service.store.artifacts(runId).filter((a) => a.logical_path === `${ROW_BLOCK_DIR}${shape.path}.json`);
      expect(records.length).toBeGreaterThan(0);
    });

  test("the quick workflow's command-gate stage records it too", async () => {
    const { wouldStops } = await deliver(DELTAGLUE, DELTAGLUE.drifted, "quick");
    expect(wouldStops.map((w) => w.key)).toEqual([`${DELTAGLUE.path}#row-2`]);
  });

  test("a file with every row as given records nothing", async () => {
    const { final, wouldStops } = await deliver(RATDEC, RATDEC.faithful);
    expect(wouldStops).toEqual([]);
    expect(final.status).toBe("completed");
  });

  test("the trace keeps the record without the rows' text, and the replay gate counts a rule that decides differently", async () => {
    const { fixture, runId } = await deliver(DELTAGLUE, DELTAGLUE.faithful);
    const dir = mkdtempSync(join(tmpdir(), "baked-row-block-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "trace.sqlite.gz");
    exportTrace(fixture.root, out);
    expect(Buffer.from(Bun.gunzipSync(readFileSync(out))).includes("data: [DONE]")).toBe(false);
    const runOf = (replay: ReturnType<typeof replayTrace>) => replay.runs.find((r) => r.runId === runId);
    expect(runOf(replayTrace(out))?.rowBlocks.length).toBeGreaterThan(0);
    expect(runOf(replayTrace(out))?.newRowBlockDrifts).toBe(0);
    // A rule that calls every row a drift finds the two rows the recorded comparison kept.
    const every = (rows: readonly RowMeasure[]) => rows.map((r) => r.row);
    expect(runOf(replayTrace(out, { rowBlockRule: every }))?.newRowBlockDrifts).toBeGreaterThanOrEqual(2);
  });
});
