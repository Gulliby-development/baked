import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  measureFileRows,
  measureRows,
  ROW_BLOCK_DIR,
  type RowMeasure,
  rowBlockDriftSummary,
  rowBlockDrifts,
  rowBlockExtraSummary,
  rowLiterals,
  rowMoveDecision,
  rowRunFindings,
  rowRunText,
} from "../src/core/workflows/row-block-drift.js";
import { runLengthCompare, runsHeld } from "../src/core/verification/byte-runs.js";
import { testsHold, verbatimHeld } from "../src/core/verification/criteria-cases.js";
import { misquotation } from "../src/core/workflows/conflict-rows.js";
import { misquoteFixPlan } from "../src/core/workflows/misquote-fix.js";
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
//
// #2503: the comparison mapped each prescribed row to the file and never the file's rows back to
// the block. Bench round 81 ratdec exact-cli T011 added
// `row(["eval", "--as", "frac", "7/3"], "", 0, "7/3\n", "")` to `test/cli_test.exs` as a 14th row
// of 13 prescribed; the record said 13 rows, none drifting, and the review's corrective cost
// 368,154 tokens to remove the line. The file's rows are now read back: added, duplicated and
// reordered rows are recorded, the first two as shadow would-stops.

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
  /** The R81 file: every row as given and one the request does not prescribe. */
  added: string;
  /** The line the added row is on, from 1. */
  addedLine: number;
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
  added: "",
  addedLine: 0,
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
  added: "",
  addedLine: 0,
};
// R80 T010: the input lost its final event, and the expected output was changed to match.
DELTAGLUE.drifted = DELTAGLUE.faithful.replace(
  `\\n\\n' +\n      'data: [DONE]\\n\\n', code: 0, out: "world\\n"`,
  `\\n\\n', code: 0, out: "world\\nstream ended without [DONE]\\n"`,
);

// R81 T011: a criterion case's arguments added as a row of their own.
RATDEC.added = RATDEC.faithful.replace(
  /\nend\n$/,
  ['', '', '  test "eval --as frac" do', '    assert_row(["eval", "--as", "frac", "7/3"], "", 0, "7/3\\n", "")', "  end", "end", ""].join("\n"),
);
RATDEC.addedLine = RATDEC.added.split("\n").findIndex((line) => line.includes('"frac"')) + 1;
DELTAGLUE.added = DELTAGLUE.faithful.replace(
  "\n];",
  `\n  { args: ["problems", "--choices", "--raw"], stdin: 'data: {"choices":[]}\\n\\n', code: 0, out: "", err: "" },\n];`,
);
DELTAGLUE.addedLine = DELTAGLUE.added.split("\n").findIndex((line) => line.includes('"--raw"')) + 1;

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

  for (const [language, shape] of Object.entries(SHAPES)) {
    test(`${language}: the file's rows map back to the block; a row changed in place takes its row's place and is not added (#2503)`, () => {
      const [faithful] = rowBlockDrifts(request(shape), graphOf(shape.path), () => shape.faithful);
      expect(faithful?.record.fileRows?.map((r) => r.matches)).toEqual(shape.block.slice(1).map((_, i) => [i + 1]));
      expect(faithful?.record.moves).toEqual({ added: [], duplicated: [], reordered: [] });
      expect(faithful?.extras).toEqual([]);
      const [drifted] = rowBlockDrifts(request(shape), graphOf(shape.path), () => shape.drifted);
      expect(drifted?.record.fileRows?.find((r) => !r.matches.length)?.replaces).toBe(shape.row);
      expect(drifted?.record.moves?.added).toEqual([]);
      expect(drifted?.extras).toEqual([]);
    });

    test(`${language}: the R81 file with a row the request does not prescribe records it added, every prescribed row held`, () => {
      const [compared] = rowBlockDrifts(request(shape), graphOf(shape.path), () => shape.added);
      expect(compared?.record.drifting).toEqual([]);
      expect(compared?.drifts).toEqual([]);
      expect(compared?.record.moves).toEqual({ added: [shape.addedLine], duplicated: [], reordered: [] });
      const added = compared?.record.fileRows?.find((r) => r.line === shape.addedLine);
      expect(added).toMatchObject({ matches: [], replaces: null });
      expect(compared?.extras).toHaveLength(1);
      const [extra] = compared?.extras ?? [];
      const text = (shape.added.split("\n")[shape.addedLine - 1] ?? "").trim();
      expect(extra).toEqual({ path: shape.path, tasks: ["T010"], kind: "added", line: shape.addedLine, text, row: null, prescribed: shape.block.length - 1 });
      expect(rowBlockExtraSummary(extra!)).toBe(
        `T010 delivered ${shape.path} with a row the request's row block does not prescribe (line ${shape.addedLine}: ${text}); the block prescribes ${shape.block.length - 1} rows. A repair would remove the line; the prescribed rows win over a row this run added.`,
      );
    });
  }

  test("a prescribed row written twice is duplicated, and rows out of the block's order are reordered (recorded, no would-stop)", () => {
    const lines = RATDEC.faithful.split("\n");
    const first = lines.findIndex((line) => line.includes('assert_row(["eval"], '));
    const twice = [...lines.slice(0, first + 1), lines[first] as string, ...lines.slice(first + 1)].join("\n");
    const [duplicated] = rowBlockDrifts(request(RATDEC), graphOf(RATDEC.path), () => twice);
    expect(duplicated?.record.moves).toEqual({ added: [], duplicated: [first + 2], reordered: [] });
    expect(duplicated?.extras.map((e) => [e.kind, e.line, e.row])).toEqual([["duplicated", first + 2, 1]]);
    expect(rowBlockExtraSummary(duplicated!.extras[0]!)).toContain(`with row 1 of the request's row block a second time (line ${first + 2}:`);
    // Rows 1 and 2 of deltaglue swapped: the second file row is row 1, after row 2.
    const rows = DELTAGLUE.faithful.split("\n");
    const at = rows.findIndex((line) => line.includes('"Hello\\n"'));
    const swapped = [...rows.slice(0, at), rows[at + 1], rows[at + 2], rows[at], ...rows.slice(at + 3)].join("\n");
    const [reordered] = rowBlockDrifts(request(DELTAGLUE), graphOf(DELTAGLUE.path), () => swapped);
    expect(reordered?.record.drifting).toEqual([]);
    expect(reordered?.record.moves).toEqual({ added: [], duplicated: [], reordered: [at + 3] });
    expect(reordered?.extras).toEqual([]);
  });

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

// #2503 Sweep: every supported language's one-per-line row spelling, read back against a block of
// three rows. `items` are the arguments as the language quotes them; the file wraps the rows in
// lines no row matches.
interface Spelling {
  row: (items: string, stdin: string, out: string) => string;
  quote?: (text: string) => string;
}
const dq = (text: string) => `"${text}"`;
const sq = (text: string) => `'${text}'`;
const SPELLINGS: Record<string, Spelling> = {
  elixir: { row: (a, i, o) => `assert_row([${a}], ${dq(i)}, 0, ${dq(o)}, "")` },
  typescript: { row: (a, i, o) => `{ args: [${a}], stdin: ${dq(i)}, code: 0, out: ${dq(o)}, err: "" },` },
  javascript: { row: (a, i, o) => `[[${a}], ${sq(i)}, 0, ${sq(o)}, ''],`, quote: sq },
  python: { row: (a, i, o) => `([${a}], ${dq(i)}, 0, ${dq(o)}, ""),` },
  go: { row: (a, i, o) => `{[]string{${a}}, ${dq(i)}, 0, ${dq(o)}, ""},` },
  rust: { row: (a, i, o) => `(&[${a}], ${dq(i)}, 0, ${dq(o)}, ""),` },
  java: { row: (a, i, o) => `Arguments.of(List.of(${a}), ${dq(i)}, 0, ${dq(o)}, ""),` },
  kotlin: { row: (a, i, o) => `row(listOf(${a}), ${dq(i)}, 0, ${dq(o)}, ""),` },
  scala: { row: (a, i, o) => `(Seq(${a}), ${dq(i)}, 0, ${dq(o)}, ""),` },
  csharp: { row: (a, i, o) => `new object[] { new[] { ${a} }, ${dq(i)}, 0, ${dq(o)}, "" },` },
  c: { row: (a, i, o) => `{ { ${a}, NULL }, ${dq(i)}, 0, ${dq(o)}, "" },` },
  cpp: { row: (a, i, o) => `{{${a}}, ${dq(i)}, 0, ${dq(o)}, ""},` },
  ruby: { row: (a, i, o) => `[[${a}], ${dq(i)}, 0, ${dq(o)}, ""],`, quote: sq },
  php: { row: (a, i, o) => `[[${a}], ${dq(i)}, 0, ${dq(o)}, ''],`, quote: sq },
  swift: { row: (a, i, o) => `([${a}], ${dq(i)}, 0, ${dq(o)}, ""),` },
  lua: { row: (a, i, o) => `{ { ${a} }, ${dq(i)}, 0, ${dq(o)}, "" },` },
  dart: { row: (a, i, o) => `([${a}], ${sq(i)}, 0, ${sq(o)}, ''),`, quote: sq },
  zig: { row: (a, i, o) => `.{ .args = &.{ ${a} }, .stdin = ${dq(i)}, .code = 0, .out = ${dq(o)}, .err = "" },` },
  ocaml: { row: (a, i, o) => `([${a.replaceAll(",", ";")}], ${dq(i)}, 0, ${dq(o)}, "");` },
  rescript: { row: (a, i, o) => `(list{${a}}, ${dq(i)}, 0, ${dq(o)}, ""),` },
  objc: { row: (a, i, o) => `@[ @[ ${a} ], @${dq(i)}, @0, @${dq(o)}, @"" ],`, quote: (t) => `@"${t}"` },
  r: { row: (a, i, o) => `list(c(${a}), ${dq(i)}, 0L, ${dq(o)}, ""),` },
  solidity: { row: (a, i, o) => `rows.push(Row(${a}, ${dq(i)}, 0, ${dq(o)}, ""));` },
  // Single-file components are tested from TypeScript or JavaScript files.
  vue: { row: (a, i, o) => `{ args: [${a}], stdin: ${dq(i)}, code: 0, out: ${dq(o)}, err: "" },` },
  svelte: { row: (a, i, o) => `[[${a}], ${sq(i)}, 0, ${sq(o)}, ''],`, quote: sq },
};
// Rows in the request's notation, and the R81 added row.
const ROWS: [string[], string, string][] = [
  [["eval"], "7/3\\n", "7/3\\n"],
  [["eval", "--steps"], "1/2 + 1/3\\n", "1/2 + 1/3\\n= 5/6\\n"],
  [["eval", "--as", "mixed"], "7/3\\n", "2 1/3\\n"],
];
const R81_ROW: [string[], string, string] = [["eval", "--as", "frac", "7/3"], "", "7/3\\n"];
const BLOCK = ROWS.map(([args, stdin, out]) => `row([${args.map(dq).join(", ")}], ${dq(stdin)}, 0, ${dq(out)}, "")`);
const spelled = (spelling: Spelling, rows: readonly [string[], string, string][]) =>
  [
    'header("rows of the cli", "see the request")',
    "rows = [",
    ...rows.map(([args, stdin, out]) => `  ${spelling.row(args.map(spelling.quote ?? dq).join(", "), stdin, out)}`),
    "]",
    'check_rows(rows, "ratdec")',
    "",
  ].join("\n");

describe("#2503: the file's rows read back in every supported language's one-per-line spelling", () => {
  for (const [language, spelling] of Object.entries(SPELLINGS))
    test(`${language}: every row as given places each; an added, a duplicated and a swapped row are recorded`, () => {
      const moves = (rows: readonly [string[], string, string][]) => rowMoveDecision(measureFileRows(BLOCK, spelled(spelling, rows)));
      const none = { added: [], duplicated: [], reordered: [] };
      expect(measureFileRows(BLOCK, spelled(spelling, ROWS)).map((r) => [r.line, r.matches])).toEqual([[3, [1]], [4, [2]], [5, [3]]]);
      expect(moves(ROWS)).toEqual(none);
      expect(moves([...ROWS, R81_ROW])).toEqual({ ...none, added: [6] });
      expect(moves([ROWS[0]!, ROWS[1]!, ROWS[0]!, ROWS[2]!])).toEqual({ ...none, duplicated: [5] });
      expect(moves([ROWS[0]!, ROWS[2]!, ROWS[1]!])).toEqual({ ...none, reordered: [5] });
    });

  test("bash: a bats `@test` per row is read by its `run` line, which holds the row's arguments and input", () => {
    const bats = (rows: readonly [string[], string, string][]) =>
      rows
        .map(([args, stdin, out]) => [`@test "${args.join(" ")}" {`, `  run_row "${stdin}" ${args.map(dq).join(" ")}`, `  [ "$output" = "${out}" ]`, "}"].join("\n"))
        .join("\n\n");
    expect(measureFileRows(BLOCK, bats(ROWS)).map((r) => [r.line, r.matches])).toEqual([[2, [1]], [7, [2]], [12, [3]]]);
    expect(rowMoveDecision(measureFileRows(BLOCK, bats([...ROWS, R81_ROW])))).toEqual({ added: [17], duplicated: [], reordered: [] });
  });

  test("rows that are one string each (Java @CsvSource) or a quoting the reader does not decode (PowerShell) record no file rows", () => {
    const csv = ["@CsvSource({", ...ROWS.concat([R81_ROW]).map(([args, stdin, out]) => `  "${args.join(" ")}, ${stdin}, 0, ${out}",`), "})", "void row(String args) {}"].join("\n");
    const powershell = ROWS.concat([R81_ROW])
      .map(([args, stdin, out]) => `@{ Args = @(${args.map(sq).join(", ")}); Stdin = "${stdin.replaceAll("\\n", "`n")}"; Out = "${out.replaceAll("\\n", "`n")}" }`)
      .join("\n");
    for (const file of [csv, powershell]) expect(measureFileRows(BLOCK, file)).toEqual([]);
    for (const file of [csv, powershell]) expect(rowMoveDecision(measureFileRows(BLOCK, file))).toEqual({ added: [], duplicated: [], reordered: [] });
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

  for (const [language, shape] of Object.entries(SHAPES))
    test(`${language}: R81, a file with a row the request does not prescribe records a shadow added would-stop, and the run still completes (#2503)`, async () => {
      const { final, wouldStops, fixture, runId } = await deliver(shape, shape.added);
      expect(wouldStops).toHaveLength(1);
      expect(wouldStops[0]).toMatchObject({
        mode: "shadow",
        key: `${shape.path}#added-line-${shape.addedLine}`,
        inputs: { path: shape.path, tasks: ["T001"], kind: "added", line: shape.addedLine, row: null, prescribed: shape.block.length - 1 },
      });
      expect(wouldStops[0]?.summary).toContain("with a row the request's row block does not prescribe");
      expect(final.status).toBe("completed");
      const replayed = replayRowBlocks(fixture.service.store, runId);
      expect(replayed.at(-1)?.recorded).toEqual([]);
      expect(replayed.at(-1)?.moves?.recorded.added).toEqual([shape.addedLine]);
      expect(replayed.every((b) => JSON.stringify(b.moves?.recorded) === JSON.stringify(b.moves?.replayed))).toBe(true);
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
    // A move rule that calls every file row added finds the two rows the recording placed (#2503).
    expect(runOf(replayTrace(out))?.newRowBlockMoves).toBe(0);
    const added = (fileRows: readonly { line: number }[]) => ({ added: fileRows.map((r) => r.line), duplicated: [], reordered: [] });
    expect(runOf(replayTrace(out, { rowMoveRule: added }))?.newRowBlockMoves).toBeGreaterThanOrEqual(2);
  });
});

// #2515: a long input given as a repeated byte run was compared verbatim, so 300 bytes were held
// inside 303 and a run spelled in another notation was never matched as a whole. Bench round 82:
// tinyflate (C) deflate run 82f19908 T007 wrote `tests/deflate_match_test.c` with 303 bytes of
// 0x78 on line 11 where the brief prescribes 300, and 238 bytes of 0x71 on line 12 where it
// prescribes 259; the failing check read as a source failure and every corrective rewrote a
// correct `src/deflate.c` until the run ended `invalid_output`.
const hexRun = (byte: string, count: number) => byte.repeat(count);
const DEFLATE_PATH = "tests/deflate_match_test.c";
const DEFLATE_BLOCK = [
  `DeflateMatchTests in ${DEFLATE_PATH} (3 rows, { input_hex, output_hex })`,
  '{ "616263", "4b4c4a0600" }',
  `{ "${hexRun("78", 300)}", "abaa50120400" }`,
  `{ "${hexRun("71", 259)}", "2b2c1c050400" }`,
];
const deflateTest = (x: number, q: number) =>
  [
    '#include <string.h>',
    '#include "../src/deflate.h"',
    '#include "check.h"',
    "",
    "struct row { const char *input_hex; const char *output_hex; };",
    "",
    "/* The prescribed rows, one test each. */",
    "",
    "static const struct row rows[] = {",
    '  { "616263", "4b4c4a0600" },',
    `  { "${hexRun("78", x)}", "abaa50120400" },`,
    `  { "${hexRun("71", q)}", "2b2c1c050400" },`,
    "};",
    "",
    "int main(void) { return check_rows(rows, sizeof rows / sizeof rows[0]); }",
    "",
  ].join("\n");
const R82_TEST = deflateTest(303, 238);
const R82_FAITHFUL = deflateTest(300, 259);
const deflateRequest = ["Build tinyflate's deflate.", "", "The prescribed rows, one test each:", "", "```text", ...DEFLATE_BLOCK, "```", ""].join("\n");

describe("#2515: a long byte run of a prescribed row is compared by its count", () => {
  test("R82: the C test with 303 bytes of 0x78 and 238 of 0x71 drifts on rows 2 and 3, by 3 and 21 bytes, at lines 11 and 12", () => {
    const [compared] = rowBlockDrifts(deflateRequest, graphOf(DEFLATE_PATH, "T007"), () => R82_TEST);
    expect(compared?.record.drifting).toEqual([2, 3]);
    expect(compared?.record.rows.map((r) => r.runs)).toEqual([
      undefined,
      [{ line: 11, byte: 0x78, prescribed: 300, found: 303 }],
      [{ line: 12, byte: 0x71, prescribed: 259, found: 238 }],
    ]);
    expect(compared?.drifts.map((d) => [d.row, d.runs.map((r) => [r.line, r.bytes])])).toEqual([
      [2, [[11, 3]]],
      [3, [[12, 21]]],
    ]);
    // A row changed in place takes its row's place; nothing is added.
    expect(compared?.record.moves).toEqual({ added: [], duplicated: [], reordered: [] });
    expect(rowBlockDriftSummary(compared!.drifts[0]!)).toContain(
      `the test's input literal differs from the criterion row by 3 bytes (${DEFLATE_PATH} line 11: 303 bytes of 0x78 where row 2 of the request's row block gives 300)`,
    );
    expect(rowRunText(compared!.drifts[1]!)).toBe(
      `the test's input literal differs from the criterion row by 21 bytes (${DEFLATE_PATH} line 12: 238 bytes of 0x71 where row 3 of the request's row block gives 259)`,
    );
    const [faithful] = rowBlockDrifts(deflateRequest, graphOf(DEFLATE_PATH, "T007"), () => R82_FAITHFUL);
    expect(faithful?.record.drifting).toEqual([]);
    expect(faithful?.record.rows.every((r) => r.runs === undefined)).toBe(true);
  });

  // Each language's spelling of 303 bytes of 0x78 (the drifted count) against the row's 300, and
  // of 300 (held). The C row is the R82 hex string; the others are the idioms tests use.
  const RUN_SPELLINGS: Record<string, (n: number) => string[]> = {
    c: (n) => [`  { "${hexRun("78", n)}", "abaa50120400" },`, `  { {${Array(n).fill("0x78").join(", ")}}, "abaa50120400" },`, `  memset(input, 0x78, ${n}); check(input, "abaa50120400");`],
    cpp: (n) => [`  {"${"\\x78".repeat(n)}", "abaa50120400"},`],
    python: (n) => [`    (bytes.fromhex("78" * ${n}), "abaa50120400"),`, `    (b"x" * ${n}, "abaa50120400"),`, `    (${n} * b"\\x78", "abaa50120400"),`],
    typescript: (n) => [`  { input: "78".repeat(${n}), out: "abaa50120400" },`, `  { input: Buffer.alloc(${n}, 0x78), out: "abaa50120400" },`, `  { input: new Uint8Array(${n}).fill(0x78), out: "abaa50120400" },`],
    rust: (n) => [`    (vec![0x78u8; ${n}], "abaa50120400"),`, `    (&[0x78; ${n}], "abaa50120400"),`, `    ("78".repeat(${n}), "abaa50120400"),`],
    go: (n) => [`	{bytes.Repeat([]byte{0x78}, ${n}), "abaa50120400"},`, `	{strings.Repeat("78", ${n}), "abaa50120400"},`],
    elixir: (n) => [`    row(:binary.copy(<<0x78>>, ${n}), "abaa50120400")`, `    row(String.duplicate("78", ${n}), "abaa50120400")`],
    java: (n) => [`      Arguments.of("${hexRun("78", n)}", "abaa50120400"),`],
  };
  // The request may spell the row's run itself as an expression, too.
  const PRESCRIBED = [`{ "${hexRun("78", 300)}", "abaa50120400" }`, '{ "78" * 300, "abaa50120400" }', "{ 0x78 × 300, \"abaa50120400\" }"];
  for (const [language, spell] of Object.entries(RUN_SPELLINGS))
    test(`${language}: 303 bytes of 0x78 drift from the row's 300 by 3 bytes in every spelling, and 300 are held`, () => {
      for (const prescribed of PRESCRIBED)
        for (const [i, line] of spell(303).entries()) {
          const file = ["// rows", line, ""].join("\n");
          expect(measureRows([prescribed], file)[0]?.runs, `${prescribed.slice(0, 20)} / ${line.slice(0, 40)}`).toEqual([{ line: 2, byte: 0x78, prescribed: 300, found: 303 }]);
          const held = ["// rows", spell(300)[i] as string, ""].join("\n");
          expect(measureRows([prescribed], held)[0]?.runs).toBeUndefined();
          expect(verbatimHeld(held, hexRun("78", 300))).toBe(true);
          expect(verbatimHeld(file, hexRun("78", 300))).toBe(false);
        }
    });

  test("a short repeat is no run, and a run line that lines up with nothing leaves the verbatim lookup to decide", () => {
    expect(runLengthCompare('{ "7878", "00" }', '{ "7878", "00" }')).toBeNull();
    expect(runsHeld("no bytes here", hexRun("78", 300))).toBeNull();
    // 300 bytes of 0x78 are not held inside 303 any more; a file with both counts holds the row.
    expect(verbatimHeld(`"${hexRun("78", 303)}"`, hexRun("78", 300))).toBe(false);
    expect(verbatimHeld(`"${hexRun("78", 303)}",\n"${hexRun("78", 300)}"`, hexRun("78", 300))).toBe(true);
    // Short runs around a long one must match inside, and may go on at either end.
    expect(runLengthCompare(`"01${hexRun("78", 300)}ff"`, `"01${hexRun("78", 300)}ff"`)).toMatchObject({ spans: 1, held: 1, drifts: [] });
    expect(runLengthCompare(`"0001${hexRun("78", 300)}ffff"`, `"01${hexRun("78", 300)}ff"`)).toMatchObject({ held: 1 });
    expect(runLengthCompare(`"02${hexRun("78", 300)}ff"`, `"01${hexRun("78", 300)}ff"`)).toMatchObject({ held: 0, drifts: [] });
  });

  test("the case walk and the misquote reading share the comparison", () => {
    // `testsHold` is the case walk's lookup; it held 300 inside a 303-byte spaced list before.
    const spaced = Array(300).fill("78").join(" ");
    expect(testsHold(`{${Array(303).fill("0x78").join(", ")}}`, spaced)).toBe(false);
    expect(testsHold(`{${Array(300).fill("0x78").join(", ")}}`, spaced)).toBe(true);
    // `misquotation` names the test's spelling of the miscounted run, in its own notation.
    expect(misquotation(hexRun("78", 300), [`check(bytes.fromhex("78" * 303))`])).toBe('"78" * 303');
    expect(misquotation(hexRun("78", 300), [`check("${hexRun("78", 303)}")`])).toBe(`"${hexRun("78", 303)}"`);
    expect(misquotation(hexRun("78", 300), [`check("${hexRun("78", 300)}")`])).toBeNull();
    // The host's exact edit writes the row's count in the test's notation.
    const files = [{ path: DEFLATE_PATH, text: R82_TEST }];
    const plan = misquoteFixPlan([{ id: "AC-002", literal: hexRun("78", 300), quoted: `"${hexRun("78", 303)}"` }], files);
    expect(plan.sites).toEqual([{ criterionId: "AC-002", occurrences: 1, unescaped: true, plain: true, held: true }]);
    expect(plan.edits[0]?.after).toBe(deflateTest(300, 238));
    const repeat = [{ path: "tests/test_deflate.py", text: 'ROWS = [(bytes.fromhex("78" * 303), "abaa50120400")]\n' }];
    const fixed = misquoteFixPlan([{ id: "AC-002", literal: hexRun("78", 300), quoted: '"78" * 303' }], repeat);
    expect(fixed.edits[0]?.after).toBe('ROWS = [(bytes.fromhex("78" * 300), "abaa50120400")]\n');
    expect(fixed.sites[0]?.held).toBe(true);
  });

  test("a failing check's findings say the test differs; with the route on they go to the test's task only", () => {
    const [compared] = rowBlockDrifts(deflateRequest, graphOf(DEFLATE_PATH, "T007"), () => R82_TEST);
    const finding = (file: string | null) => ({ id: `F-${file}`, kind: "correctness" as const, severity: "high" as const, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file, symbol: null, evidenceIds: ["E1"], claim: "Required check rows failed", impact: "Implementation cannot be accepted", suggestedFix: "Inspect command evidence E1 and correct the implementation within approved scope." });
    const tasks = [
      { id: "T006", writes: [{ path: "src/deflate.c", action: "create" as const }], requirementIds: ["FR-001"], criterionIds: ["AC-001"] },
      { id: "T007", writes: [{ path: DEFLATE_PATH, action: "create" as const }], requirementIds: ["FR-002"], criterionIds: ["AC-002"] },
    ];
    const built = [finding("src/deflate.c"), finding(DEFLATE_PATH)];
    let n = 0;
    const shadow = rowRunFindings("rows", built, compared!.drifts, tasks, false, () => `N${++n}`);
    expect(shadow.findings.map((f) => f.file)).toEqual(["src/deflate.c", DEFLATE_PATH]);
    for (const f of shadow.findings) {
      expect(f.suggestedFix.startsWith(`The test's input literal differs from the criterion row by 3 bytes (${DEFLATE_PATH} line 11: 303 bytes of 0x78 where row 2 of the request's row block gives 300); the test's input literal differs from the criterion row by 21 bytes (${DEFLATE_PATH} line 12: 238 bytes of 0x71 where row 3 of the request's row block gives 259).`)).toBe(true);
      expect(f.suggestedFix).toContain("Inspect command evidence E1");
    }
    expect(shadow.record).toEqual({ schemaVersion: 1, checkId: "rows", mode: "shadow", tests: [DEFLATE_PATH], tasks: ["T007"], bytes: [3, 21], before: ["src/deflate.c", DEFLATE_PATH], after: [DEFLATE_PATH] });
    const routed = rowRunFindings("rows", [finding("src/deflate.c")], compared!.drifts, tasks, true, () => `N${++n}`);
    expect(routed.findings.map((f) => [f.file, f.requirementIds, f.criterionIds])).toEqual([[DEFLATE_PATH, ["FR-002"], ["AC-002"]]]);
    expect(routed.findings[0]?.suggestedFix).toContain(`Edit ${DEFLATE_PATH} only; the other rows and the source stay as written.`);
    expect(routed.record?.mode).toBe("on");
    // No run drift: the findings stay as built and nothing is recorded.
    const [faithful] = rowBlockDrifts(deflateRequest, graphOf(DEFLATE_PATH, "T007"), () => R82_FAITHFUL);
    expect(rowRunFindings("rows", built, faithful!.drifts, tasks, true, () => "N")).toEqual({ findings: built, record: null });
  });
});

/** The R82 flow: T001 writes the source, T002 the test file; a corrective writes it as given. */
class DeflateExecutor extends FixtureExecutor {
  constructor(
    private workspace: string,
    private content: string,
  ) {
    super(workspace);
  }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const graph = (result.output as { taskGraph: TaskGraph }).taskGraph;
      const first = graph.tasks[0]!;
      first.writes.push({ path: "src/deflate.c", action: "create" });
      graph.tasks.push({ ...first, id: "T002", title: "Deflate rows", dependsOn: ["T001"], writes: [{ path: DEFLATE_PATH, action: "create" }] });
    }
    if (request.profile.output === "implementation") {
      const write = (path: string, text: string) => {
        mkdirSync(dirname(join(this.workspace, path)), { recursive: true });
        writeFileSync(join(this.workspace, path), text);
      };
      if (request.task?.id === "T001") write("src/deflate.c", "int deflate(void) { return 0; }\n");
      else if (request.task?.id === "T002") write(DEFLATE_PATH, this.content);
      else write(DEFLATE_PATH, R82_FAITHFUL);
    }
    return result;
  }
}

// The deflate rows check: fails while the test's rows are not the prescribed ones, naming the test
// line and the source it exercises, as the R82 check output did.
const ROWS_CHECK = {
  id: "rows",
  executable: "bun",
  args: ["-e", `const t = await Bun.file(${JSON.stringify(DEFLATE_PATH)}).text(); if (t.includes("${hexRun("78", 301)}") || !t.includes("${hexRun("71", 259)}")) { console.log("${DEFLATE_PATH}:11: deflate_match row 2 output differs from src/deflate.c"); process.exit(1); }`],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "feature" as const,
  envNames: [],
  writes: [],
};

async function deliverDeflate(route: boolean) {
  const policy: RunPolicy = { ...fixturePolicy, checks: [...fixturePolicy.checks, ROWS_CHECK], ...(route ? { rowRunRoute: "on" as const } : {}) };
  const fixture = workflowFixture({ policy, executor: (root) => new DeflateExecutor(root, R82_TEST) });
  cleanups.push(fixture.dispose);
  const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: `Create ready value.\n\n${deflateRequest}`, ownerLabel: "test", policy });
  let current = await fixture.service.drive(run.runId, new AbortController().signal);
  for (let i = 0; i < 8 && current.status === "waiting"; i++) {
    if (fixture.service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
    await fixture.approve(run.runId);
    current = await fixture.service.drive(run.runId, new AbortController().signal);
  }
  const store = fixture.service.store;
  const findings = store
    .findings(run.runId)
    .map((f) => JSON.parse(f.body_json) as { file: string | null; claim: string; suggestedFix: string })
    .filter((f) => f.claim === "Required check rows failed");
  const wouldStops = store
    .eventsOfType(run.runId, "decision.would_stop")
    .map((e) => e.payload as { reason: string; key: string; inputs: { runs?: { line: number; bytes: number }[] } })
    .filter((p) => p.reason === "row_block_drift");
  const routes = store.artifacts(run.runId).filter((a) => a.logical_path === "row-runs/rows.json").map((a) => JSON.parse(store.readArtifact(run.runId, a.id)));
  const prompts = fixture.executor.prompts.implementation ?? [];
  return { final: await fixture.service.get(run.runId), findings, wouldStops, routes, prompts };
}

describe("scenario: R82, a test rewrites two prescribed long hex inputs with the wrong run length (#2515)", () => {
  test("the checks stage records both runs, and the failing check's corrective says the test differs, naming line and byte", async () => {
    const { final, findings, wouldStops, routes, prompts } = await deliverDeflate(false);
    expect(wouldStops.map((w) => [w.key, w.inputs.runs?.map((r) => [r.line, r.bytes])])).toEqual([
      [`${DEFLATE_PATH}#row-2`, [[11, 3]]],
      [`${DEFLATE_PATH}#row-3`, [[12, 21]]],
    ]);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings)
      expect(f.suggestedFix).toStartWith(`The test's input literal differs from the criterion row by 3 bytes (${DEFLATE_PATH} line 11: 303 bytes of 0x78 where row 2 of the request's row block gives 300); the test's input literal differs from the criterion row by 21 bytes (${DEFLATE_PATH} line 12: 238 bytes of 0x71 where row 3 of the request's row block gives 259).`);
    // The corrective's brief carries it.
    expect(prompts.some((p) => p.includes("differs from the criterion row by 21 bytes"))).toBe(true);
    // Shadow: the findings keep their files (the source among them), and the route is recorded.
    expect(findings.map((f) => f.file)).toContain("src/deflate.c");
    expect(routes[0]).toMatchObject({ mode: "shadow", tests: [DEFLATE_PATH], bytes: [3, 21], after: [DEFLATE_PATH] });
    expect(final.status).toBe("completed");
  });

  test("with rowRunRoute on, the correction goes to the test's task only, not src/deflate.c", async () => {
    const { final, findings, routes } = await deliverDeflate(true);
    expect(findings.map((f) => f.file)).toEqual([DEFLATE_PATH]);
    expect(findings[0]?.suggestedFix).toContain(`the test's input literal differs from the criterion row by 21 bytes (${DEFLATE_PATH} line 12: 238 bytes of 0x71 where row 3 of the request's row block gives 259)`);
    expect(routes[0]).toMatchObject({ mode: "on", tests: [DEFLATE_PATH] });
    expect(final.status).toBe("completed");
  });
});
