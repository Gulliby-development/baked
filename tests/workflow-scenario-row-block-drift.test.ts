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
