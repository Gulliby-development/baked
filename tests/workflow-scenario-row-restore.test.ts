import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ROW_RESTORE_DIR,
  type RowRestoreRecord,
  type RowRestoreSite,
  restoredLine,
  rowRestoreDecision,
  ownedRows,
  rowRestorePlan,
  rowRestores,
  respelledRunLine,
  rowRunRestores,
  relitLine,
  rowEditBreaks,
  taskRowRestores,
} from "../src/core/workflows/row-restore.js";
import { rowBlockDrifts, rowBlockDriftSummary } from "../src/core/workflows/row-block-drift.js";
import type { NativeWorkflowService } from "../src/core/workflows/service.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import { runRoot } from "../src/core/workflows/worktree.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { replayRowRestores } from "../src/core/workflows/trace.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #2522: the host holds every row a request prescribes verbatim, yet a delivered test file that
// changed one went back to a model session to copy it again. Bench round 82: row-file tasks were
// 5.1M of the two initiatives' 18.1M tokens and their corrections another 3.0M. tinyflate (C)
// deflate T007 (2.43M) never got `tests/deflate_match_test.c`'s long hex runs right (303 bytes of
// `78` for the row's 300, 238 of `71` for 259); slotprompt (Dart) core T009 and T010 (0.57M) put
// back arguments a row had lost. The host now restores such a row from the request's text at the
// checks stage (shadow by default; `rowRestore: "on"` writes it), and no session opens for it.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface RestoreShape {
  path: string;
  /** The request's fenced row block, header first. */
  block: string[];
  /** The test file with every row as the request gives it. */
  faithful: string;
  /** The R82 file: rows changed in place, each still on its own line. */
  drifted: string;
  /** The rows (from 1) the host restores. */
  restored: number[];
}

const hexRun = (byte: string, count: number) => byte.repeat(count);

// tinyflate (C) deflate: `{ input_hex, output_hex }` struct rows; the R82 file miscounted two
// long runs of one byte.
const DEFLATE_PATH = "tests/deflate_match_test.c";
const deflateTest = (x: number, q: number) =>
  [
    "#include <string.h>",
    '#include "../src/deflate.h"',
    '#include "check.h"',
    "",
    "struct row { const char *input_hex; const char *output_hex; };",
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
const TINYFLATE: RestoreShape = {
  path: DEFLATE_PATH,
  block: [
    `DeflateMatchTests in ${DEFLATE_PATH} (3 rows, { input_hex, output_hex })`,
    '{ "616263", "4b4c4a0600" }',
    `{ "${hexRun("78", 300)}", "abaa50120400" }`,
    `{ "${hexRun("71", 259)}", "2b2c1c050400" }`,
  ],
  faithful: deflateTest(300, 259),
  drifted: deflateTest(303, 238),
  restored: [2, 3],
};

// tinyflate (C) inflate: a macro per row, each a statement.
const INFLATE_PATH = "tests/inflate_rows_test.c";
const inflateTest = (row2: string) =>
  [
    '#include "check.h"',
    "",
    "int main(void) {",
    '  INFLATE_ROW("4b4c4a0600", "616263");',
    `  ${row2};`,
    "  return check_done();",
    "}",
    "",
  ].join("\n");
const INFLATE: RestoreShape = {
  path: INFLATE_PATH,
  block: [
    `InflateRows in ${INFLATE_PATH} (2 rows, INFLATE_ROW(input_hex, output_hex))`,
    'INFLATE_ROW("4b4c4a0600", "616263")',
    'INFLATE_ROW("cb48cdc9c90700", "68656c6c6f")',
  ],
  faithful: inflateTest('INFLATE_ROW("cb48cdc9c90700", "68656c6c6f")'),
  drifted: inflateTest('INFLATE_ROW("cb48cdc9c90700", "68656c6c70")'),
  restored: [2],
};

// slotprompt (Dart) core: `row(template, values, out)` rows in a list; `\$` escapes the dollar,
// and the R82 file lost an entry of row 2's values with the output that names it.
const SLOT_PATH = "test/render_rows_test.dart";
const slotTest = (row2: string) =>
  [
    "import 'package:slotprompt/slotprompt.dart';",
    "import 'package:test/test.dart';",
    "",
    "import 'rows.dart';",
    "",
    "final rows = [",
    "  row('Hello {{name}}', {'name': 'Ann'}, 'Hello Ann'),",
    `  ${row2},`,
    "];",
    "",
    "void main() => runRows(rows, render);",
    "",
  ].join("\n");
const SLOTPROMPT: RestoreShape = {
  path: SLOT_PATH,
  block: [
    `RenderRows in ${SLOT_PATH} (2 rows, row(template, values, out))`,
    "row('Hello {{name}}', {'name': 'Ann'}, 'Hello Ann')",
    "row('Price: \\${{p}} {{currency}}', {'p': '5', 'currency': 'EUR'}, 'Price: \\$5 EUR')",
  ],
  faithful: slotTest("row('Price: \\${{p}} {{currency}}', {'p': '5', 'currency': 'EUR'}, 'Price: \\$5 EUR')"),
  drifted: slotTest("row('Price: \\${{p}} {{currency}}', {'p': '5'}, 'Price: \\$5 ')"),
  restored: [2],
};

// deltaglue (TypeScript): object rows in an array.
const DELTA_PATH = "tests/problems-rows.test.ts";
const deltaTest = (row2: string) =>
  [
    'import { expect, test } from "bun:test";',
    'import { run } from "./helpers/run";',
    "",
    "const rows = [",
    '  { args: ["problems"], stdin: "a\\n", code: 0, out: "1\\n", err: "" },',
    `  ${row2},`,
    "];",
    "",
    "for (const row of rows) test(row.args.join(' '), async () => expect(await run(row)).toEqual(row));",
    "",
  ].join("\n");
const DELTAGLUE: RestoreShape = {
  path: DELTA_PATH,
  block: [
    `ProblemsRows in ${DELTA_PATH} (2 rows, { args, stdin, code, out, err })`,
    '{ args: ["problems"], stdin: "a\\n", code: 0, out: "1\\n", err: "" }',
    '{ args: ["problems", "--all"], stdin: "a\\nb\\n", code: 0, out: "2\\n", err: "" }',
  ],
  faithful: deltaTest('{ args: ["problems", "--all"], stdin: "a\\nb\\n", code: 0, out: "2\\n", err: "" }'),
  drifted: deltaTest('{ args: ["problems", "--all"], stdin: "a\\n", code: 0, out: "1\\n", err: "" }'),
  restored: [2],
};

// ratdec (Elixir): `row(...)` calls in a list, the request's notation.
const RATDEC_PATH = "test/eval_rows_test.exs";
const ratdecTest = (row2: string) =>
  [
    "defmodule Ratdec.EvalRowsTest do",
    "  use Ratdec.RowCase",
    "",
    "  rows([",
    '    row(["eval"], "7/3\\n", 0, "7/3\\n", ""),',
    `    ${row2}`,
    "  ])",
    "end",
    "",
  ].join("\n");
const RATDEC: RestoreShape = {
  path: RATDEC_PATH,
  block: [
    `EvalRows in ${RATDEC_PATH} (2 rows, row(ARGS, STDIN, CODE, OUT, ERR))`,
    'row(["eval"], "7/3\\n", 0, "7/3\\n", "")',
    'row(["eval", "--as", "mixed"], "7/3\\n", 0, "2 1/3\\n", "")',
  ],
  faithful: ratdecTest('row(["eval", "--as", "mixed"], "7/3\\n", 0, "2 1/3\\n", "")'),
  drifted: ratdecTest('row(["eval", "--as", "mixed"], "7/3\\n", 1, "", "ratdec: unsupported\\n")'),
  restored: [2],
};

// Go: table rows in a slice literal.
const GO_PATH = "cmd/split_rows_test.go";
const goTest = (row2: string) =>
  [
    "package main",
    "",
    'import "testing"',
    "",
    "var rows = []struct{ in, out string }{",
    '\t{"a,b", "a|b"},',
    `\t${row2},`,
    "}",
    "",
    "func TestRows(t *testing.T) { checkRows(t, rows) }",
    "",
  ].join("\n");
const GO: RestoreShape = {
  path: GO_PATH,
  block: [
    `SplitRows in ${GO_PATH} (2 rows, {in, out})`,
    '{"a,b", "a|b"}',
    '{"a,,b", "a||b"}',
  ],
  faithful: goTest('{"a,,b", "a||b"}'),
  drifted: goTest('{"a,,b", "a|b"}'),
  restored: [2],
};

// pnmforge (C++, R83) cli: usage rows with `\n` escapes, here braced rows in a `std::vector`; the
// drifted file lost the usage row's command lines.
const PNM_PATH = "tests/cli_test.cpp";
const PNM_USAGE = "usage: pnmforge <command> [options]\\n\\ncommands:\\n  info FILE\\n  invert IN OUT\\n";
const pnmTest = (row2: string) =>
  [
    "#include <gtest/gtest.h>",
    "",
    '#include "cli.h"',
    "",
    "static const std::vector<CliRow> rows = {",
    '    {{"--version"}, 0, "pnmforge 0.1.0\\n", ""},',
    `    ${row2},`,
    "};",
    "",
    "TEST(CliTest, Rows) { checkRows(rows); }",
    "",
  ].join("\n");
const PNMFORGE: RestoreShape = {
  path: PNM_PATH,
  block: [
    `CliRows in ${PNM_PATH} (2 rows, {args, code, out, err})`,
    '{{"--version"}, 0, "pnmforge 0.1.0\\n", ""}',
    `{{"--help"}, 0, "${PNM_USAGE}", ""}`,
  ],
  faithful: pnmTest(`{{"--help"}, 0, "${PNM_USAGE}", ""}`),
  drifted: pnmTest('{{"--help"}, 0, "usage: pnmforge <command> [options]\\n", ""}'),
  restored: [2],
};

// bytemerge (Java, R83) encoding: `Arguments.of` rows in a `Stream.of(`; the last row closes the
// list on its line (`));`); the drifted last row lost a byte of its ids.
const BYTE_PATH = "src/test/java/bytemerge/EncodeIdsTest.java";
const byteTest = (row2: string) =>
  [
    "package bytemerge;",
    "",
    "class EncodeIdsTest {",
    "  static Stream<Arguments> rows() {",
    "    return Stream.of(",
    '        Arguments.of("hello", "[104, 101, 108, 108, 111]"),',
    `        ${row2}));`,
    "  }",
    "}",
    "",
  ].join("\n");
const BYTEMERGE: RestoreShape = {
  path: BYTE_PATH,
  block: [
    `EncodeIdsTest in ${BYTE_PATH} (2 rows, Arguments.of(text, ids))`,
    'Arguments.of("hello", "[104, 101, 108, 108, 111]")',
    'Arguments.of("256 \\\\ n \\n", "[50, 53, 54, 32, 92, 32, 110, 32, 10]")',
  ],
  faithful: byteTest('Arguments.of("256 \\\\ n \\n", "[50, 53, 54, 32, 92, 32, 110, 32, 10]")'),
  drifted: byteTest('Arguments.of("256 \\\\ n \\n", "[50, 53, 54, 92, 32, 110, 32, 10]")'),
  restored: [2],
};

/** One case per row notation the host restores (AGENTS.md: a new notation adds its case here). */
const RESTORE_SHAPES: Record<string, RestoreShape> = {
  c: TINYFLATE,
  "c-macro": INFLATE,
  dart: SLOTPROMPT,
  typescript: DELTAGLUE,
  elixir: RATDEC,
  go: GO,
  cpp: PNMFORGE,
  java: BYTEMERGE,
};

const requestOf = (shape: RestoreShape) =>
  ["Build it.", "", "The prescribed rows, one test each:", "", "```text", ...shape.block, "```", ""].join("\n");
const rowsOf = (shape: RestoreShape) => shape.block.slice(1);
const graphOf = (path: string, id = "T002"): Pick<TaskGraph, "tasks"> =>
  ({ tasks: [{ id, origin: "planned", writes: [{ path, action: "create" }] }] }) as unknown as Pick<TaskGraph, "tasks">;

describe("rowRestorePlan: the host restores a changed prescribed row from the request's text (#2522)", () => {
  for (const [language, shape] of Object.entries(RESTORE_SHAPES)) {
    test(`${language}: the drifted file's changed rows are restored to the file with every row as given`, () => {
      const plan = rowRestorePlan(rowsOf(shape), shape.drifted);
      expect(plan.restore).toEqual(shape.restored);
      expect(plan.sites.every((s) => s.oneLine && s.sameHead && s.held)).toBe(true);
      expect(plan.after).toBe(shape.faithful);
    });
    test(`${language}: a file with every row as given has no site`, () => {
      const plan = rowRestorePlan(rowsOf(shape), shape.faithful);
      expect(plan.sites).toEqual([]);
      expect(plan.after).toBe(shape.faithful);
    });
  }

  test("R82 tinyflate: both miscounted runs take their rows' places on lines 9 and 10", () => {
    const plan = rowRestorePlan(rowsOf(TINYFLATE), TINYFLATE.drifted);
    expect(plan.sites).toEqual([
      { row: 2, line: 9, oneLine: true, sameHead: true, held: true },
      { row: 3, line: 10, oneLine: true, sameHead: true, held: true },
    ]);
  });

  test("a row the file spells in another notation, or over several lines, is recorded and not restored", () => {
    // The file's rows are `assert_row(...)` calls where the request gives `row(...)`.
    const other = RATDEC.drifted.replaceAll("    row(", "    assert_row(");
    const notation = rowRestorePlan(rowsOf(RATDEC), other);
    expect(notation.sites.map((s) => [s.row, s.sameHead])).toEqual([[2, false]]);
    expect(notation.restore).toEqual([]);
    expect(notation.after).toBe(other);
    // A formatter wrapped the row's strings onto a second line.
    const wrapped = DELTAGLUE.drifted.replace('stdin: "a\\n", code: 0, out: "1\\n", err: "" },\n];', 'stdin: "a\\n" +\n    "", code: 0, out: "1\\n", err: "" },\n];');
    const spread = rowRestorePlan(rowsOf(DELTAGLUE), wrapped);
    expect(spread.sites.find((s) => s.row === 2)?.oneLine).toBe(false);
    expect(spread.restore).toEqual([]);
    // A drifting row no file line takes the place of (the file lacks it).
    const dropped = GO.drifted.replace('\t{"a,,b", "a|b"},\n', "");
    const none = rowRestorePlan(rowsOf(GO), dropped);
    expect(none.sites).toEqual([{ row: 2, line: null, oneLine: false, sameHead: false, held: false }]);
    expect(none.restore).toEqual([]);
  });

  test("the restored line keeps the file's indentation, separator and line ending", () => {
    expect(restoredLine('  { "1", "2" },', '{ "3", "4" }')).toBe('  { "3", "4" },');
    expect(restoredLine('\tROW("1");\r', 'ROW("3")')).toBe('\tROW("3");\r');
    expect(restoredLine("    row(1)", "row(2)")).toBe("    row(2)");
    // The list's close on the last row's line stays (#2553: a Java `Stream.of(`, a gtest `Values(`).
    expect(restoredLine('        Arguments.of("a", 1));', 'Arguments.of("b", 2)')).toBe('        Arguments.of("b", 2));');
    expect(restoredLine("    CliRow{{}, 2, \"\", \"\"}));", 'CliRow{{"-h"}, 0, "u\\n", ""}')).toBe('    CliRow{{"-h"}, 0, "u\\n", ""}));');
  });

  test("rowRestores records sites and verdicts per file; the decision replays from the flags", () => {
    const [shadow] = rowRestores(requestOf(TINYFLATE), graphOf(TINYFLATE.path), () => TINYFLATE.drifted);
    expect(shadow?.record).toMatchObject({ schemaVersion: 1, path: DEFLATE_PATH, tasks: ["T002"], mode: "shadow", restore: [2, 3], verdict: "would_restore", checks: null });
    expect(shadow?.after).toBe(TINYFLATE.faithful);
    const [on] = rowRestores(requestOf(TINYFLATE), graphOf(TINYFLATE.path), () => TINYFLATE.drifted, "on");
    expect(on?.record.verdict).toBe("restored");
    expect(rowRestores(requestOf(TINYFLATE), graphOf(TINYFLATE.path), () => TINYFLATE.faithful)).toEqual([]);
    expect(rowRestores(requestOf(TINYFLATE), graphOf(TINYFLATE.path), () => null)).toEqual([]);
    expect(rowRestoreDecision(shadow?.record.sites ?? [])).toEqual([2, 3]);
  });
});

/** T001 writes the source, T002 the row file as `content`; any later session writes it as given. */
class RowFileExecutor extends FixtureExecutor {
  sessions: string[] = [];
  constructor(
    private workspace: string,
    private shape: RestoreShape,
    private content: string,
    private checkIds: string[] = [],
    private corrected = shape.faithful,
  ) {
    super(workspace);
  }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const graph = (result.output as { taskGraph: TaskGraph }).taskGraph;
      const first = graph.tasks[0]!;
      graph.tasks.push({ ...first, id: "T002", title: "Row file", dependsOn: ["T001"], writes: [{ path: this.shape.path, action: "create" }], checkIds: this.checkIds });
    }
    if (request.profile.output === "implementation") {
      this.sessions.push(request.task?.id ?? "");
      const write = (text: string) => {
        mkdirSync(dirname(join(this.workspace, this.shape.path)), { recursive: true });
        writeFileSync(join(this.workspace, this.shape.path), text);
      };
      if (request.task?.id === "T002") write(this.content);
      else if (request.task?.id !== "T001") write(this.corrected);
    }
    return result;
  }
}

// The rows check: fails while the file does not hold every prescribed row as given, as the R82
// build and run of the row file did.
const rowsCheck = (shape: RestoreShape) => ({
  id: "rows",
  executable: "bun",
  args: ["-e", `const t = await Bun.file(${JSON.stringify(shape.path)}).text(); const rows = ${JSON.stringify(rowsOf(shape))}; if (!rows.every((r) => t.includes(r))) { console.log("${shape.path}: a row differs"); process.exit(1); }`],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "feature" as const,
  envNames: [],
  writes: [],
});

async function deliver(shape: RestoreShape, on: boolean, guard?: { check: RunPolicy["checks"][number]; corrected: string }, extra: Partial<RunPolicy> = {}) {
  const policy: RunPolicy = { ...fixturePolicy, checks: [...fixturePolicy.checks, rowsCheck(shape), ...(guard ? [guard.check] : [])], ...(on ? { rowRestore: "on" as const } : {}), ...extra };
  let executor: RowFileExecutor | undefined;
  const fixture = workflowFixture({
    policy,
    executor: (root) => {
      executor = new RowFileExecutor(root, shape, shape.drifted, guard ? [guard.check.id] : [], guard?.corrected);
      return executor;
    },
  });
  cleanups.push(fixture.dispose);
  const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: `Create ready value.\n\n${requestOf(shape)}`, ownerLabel: "test", policy });
  let current = await fixture.service.drive(run.runId, new AbortController().signal);
  for (let i = 0; i < 8 && current.status === "waiting"; i++) {
    if (fixture.service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
    await fixture.approve(run.runId);
    current = await fixture.service.drive(run.runId, new AbortController().signal);
  }
  const store = fixture.service.store;
  const records = store
    .artifacts(run.runId)
    .filter((a) => a.logical_path === `${ROW_RESTORE_DIR}${shape.path}.json`)
    .map((a) => JSON.parse(store.readArtifact(run.runId, a.id)) as RowRestoreRecord);
  const wouldStops = store
    .eventsOfType(run.runId, "decision.would_stop")
    .map((e) => e.payload as { reason: string; key: string })
    .filter((p) => p.reason === "row_block_drift");
  return {
    final: await fixture.service.get(run.runId),
    file: readFileSync(join(fixture.root, shape.path), "utf8"),
    sessions: executor?.sessions ?? [],
    records,
    wouldStops,
    fixture,
    runId: run.runId,
  };
}

describe("scenario: R82, a run delivers a prescribed row file with rows changed (#2522)", () => {
  for (const [language, shape] of Object.entries({ c: TINYFLATE, dart: SLOTPROMPT }))
    test(`${language}: with rowRestore on the host restores the rows before the checks, and no session opens for them`, async () => {
      const { final, file, sessions, records, wouldStops, fixture, runId } = await deliver(shape, true);
      expect(final.status).toBe("completed");
      // T001 and T002 only: no corrective session copied the rows again.
      expect(sessions).toEqual(["T001", "T002"]);
      expect(file).toBe(shape.faithful);
      expect(records[0]).toMatchObject({ mode: "on", restore: shape.restored, verdict: "restored", tasks: ["T002"] });
      // The rows were restored before the comparison: nothing drifts.
      expect(wouldStops).toEqual([]);
      const replayed = replayRowRestores(fixture.service.store, runId);
      expect(replayed.map((b) => [b.recorded, b.replayed])).toEqual([[shape.restored, shape.restored]]);
    });

  test("c: shadow by default, the host records would_restore, keeps the file and a session corrects it", async () => {
    // With the miscount's restore before a task's session off too (#2543), as in R82.
    const { sessions, records, wouldStops } = await deliver(TINYFLATE, false, undefined, { rowRunRestore: "off" });
    expect(records[0]).toMatchObject({ mode: "shadow", restore: [2, 3], verdict: "would_restore", checks: null });
    expect(wouldStops.length).toBeGreaterThan(0);
    // The failing rows check opened a corrective session, as in R82.
    expect(sessions.length).toBeGreaterThan(2);
  });

  test("c: with rowRestore shadow, the correction's start restores the miscounted runs and no session opens for them (#2543)", async () => {
    const { final, sessions, records, file } = await deliver(TINYFLATE, false);
    expect(records[0]).toMatchObject({ mode: "shadow", verdict: "would_restore" });
    // Restored before the correction runs: by the drive's comparison of every row file (#2551).
    expect(records.find((r) => (r as { at?: string }).at === "drive")).toMatchObject({ mode: "on", restore: [2, 3], verdict: "restored" });
    expect(file).toBe(TINYFLATE.faithful);
    expect(sessions).toEqual(["T001", "T002"]);
    expect(final.status).toBe("completed");
  });

  test("c: with rowRestore on, an edit the writing task's required check fails on is put back and a session corrects the file", async () => {
    // The task's own check wants the file's closing note a session writes, not only the rows.
    const corrected = `${TINYFLATE.faithful}/* rows as given */\n`;
    const check = {
      id: "guard",
      executable: "bun",
      args: ["-e", `const t = await Bun.file(${JSON.stringify(DEFLATE_PATH)}).text(); if (t.includes("${hexRun("71", 259)}") && !t.includes("rows as given")) process.exit(1);`],
      cwd: ".",
      timeoutMs: 10000,
      required: true,
      scope: "task" as const,
      envNames: [],
      writes: [],
    };
    const { final, file, sessions, records } = await deliver(TINYFLATE, true, { check, corrected });
    expect(records[0]).toMatchObject({ mode: "on", restore: [2, 3], verdict: "put_back", checks: "failed" });
    expect(sessions.length).toBeGreaterThan(2);
    expect(file).toBe(corrected);
    expect(final.status).toBe("completed");
  });

  test("the replay counts a rule that restores what the recording did not", async () => {
    const { fixture, runId } = await deliver(TINYFLATE, false);
    const none = (_: readonly RowRestoreSite[]) => [];
    expect(replayRowRestores(fixture.service.store, runId, none).every((b) => b.replayed.length === 0)).toBe(true);
    const every = (sites: readonly RowRestoreSite[]) => sites.map((s) => s.row);
    expect(replayRowRestores(fixture.service.store, runId).every((b) => JSON.stringify(b.recorded) === JSON.stringify(b.replayed))).toBe(true);
    expect(replayRowRestores(fixture.service.store, runId, every)[0]?.replayed).toEqual([2, 3]);
  });
});

// #2543: R82 tinyflate deflate 82f19908 blocked `invalid_output` at T007, whose check reads
// `tests/deflate_match_test.c` (303 bytes of `78` for the row's 300, 238 of `71` for 259) and
// whose session would not change the test's literals. Resumed on main after #2515 and #2522, it
// went straight back to the same block: both ran only at the checks stage, which a run blocked at
// a task never reaches. The resume now records the miscounted rows, and the drive restores them
// from the request before the blocked task's session.
const SRC_PATH = "src/deflate.c";
const BLOCKED_SUMMARY =
  "tests/deflate_match_test.c does not pass against src/deflate.c, and I cannot change the tests while preserving their exact prescribed literals";

/** T002 writes the R82 row file; T003 writes the source and blocks while the test miscounts a row. */
class ResumeExecutor extends FixtureExecutor {
  sessions: string[] = [];
  briefs: Record<string, string[]> = {};
  constructor(
    private workspace: string,
    private checkId: string,
    /** The R82 test task carries the rows check itself: its correction starts on the miscount. */
    private onTest = false,
  ) {
    super(workspace);
  }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const graph = (result.output as { taskGraph: TaskGraph }).taskGraph;
      const first = graph.tasks[0]!;
      graph.tasks.push(
        { ...first, id: "T002", title: "Deflate match rows", dependsOn: ["T001"], writes: [{ path: DEFLATE_PATH, action: "create" }], checkIds: this.onTest ? [this.checkId] : [] },
        { ...first, id: "T003", title: "Deflate matcher", dependsOn: ["T002"], writes: [{ path: SRC_PATH, action: "create" }], checkIds: [this.checkId] },
      );
    }
    if (request.profile.output !== "implementation") return result;
    const id = request.task?.id ?? "";
    this.sessions.push(id);
    (this.briefs[id] ??= []).push(request.prompt);
    const path = (p: string) => join(this.workspace, p);
    if (id === "T002" && !this.briefs.T002?.[1]) {
      mkdirSync(dirname(path(DEFLATE_PATH)), { recursive: true });
      writeFileSync(path(DEFLATE_PATH), TINYFLATE.drifted);
    }
    if (id !== "T003") return result;
    const test = readFileSync(path(DEFLATE_PATH), "utf8");
    if (rowsOf(TINYFLATE).every((r) => test.includes(r))) {
      mkdirSync(dirname(path(SRC_PATH)), { recursive: true });
      writeFileSync(path(SRC_PATH), "int deflate(void) { return 0; }\n");
      return result;
    }
    return {
      ...result,
      output: { schemaVersion: 1, taskId: id, outcome: "blocked", summary: BLOCKED_SUMMARY, evidenceIds: [], unresolved: [BLOCKED_SUMMARY] },
    };
  }
}

async function blockedAtTask(extra: Partial<RunPolicy> = {}, onTest = false) {
  const check = { ...rowsCheck(TINYFLATE), id: "deflate-rows", scope: "task" as const };
  const policy: RunPolicy = { ...fixturePolicy, checks: [...fixturePolicy.checks, check], ...extra };
  let executor: ResumeExecutor | undefined;
  const fixture = workflowFixture({
    policy,
    executor: (root) => {
      executor = new ResumeExecutor(root, check.id, onTest);
      return executor;
    },
  });
  cleanups.push(fixture.dispose);
  const { service } = fixture;
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: `Create ready value.\n\n${requestOf(TINYFLATE)}`, ownerLabel: "test", policy });
  const drive = () => service.drive(run.runId, new AbortController().signal);
  let current = await drive();
  for (let i = 0; i < 8 && current.status === "waiting"; i++) {
    if (service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
    await fixture.approve(run.runId);
    current = await drive();
  }
  const records = (prefix: string) =>
    service.store
      .artifacts(run.runId)
      .filter((a) => a.logical_path === `${prefix}${DEFLATE_PATH}.json`)
      .map((a) => JSON.parse(service.store.readArtifact(run.runId, a.id)) as RowRestoreRecord & { at?: string; blocked?: string[] });
  return {
    fixture,
    runId: run.runId,
    executor: executor!,
    drive,
    records,
    file: () => readFileSync(join(fixture.root, DEFLATE_PATH), "utf8"),
  };
}

describe("scenario: R82 tinyflate, a run blocked invalid_output at a task resumes onto the request's rows (#2543)", () => {
  test("resumed, the miscounted rows are recorded and restored before the task's session, and the task completes", async () => {
    const { fixture, runId, executor, drive, records, file } = await blockedAtTask();
    const { service } = fixture;
    // The R82 block: T003's session ends blocked on the test's literals.
    expect(service.store.run(runId)).toMatchObject({ status: "blocked", reason: "invalid_output" });
    expect(service.store.tasks(runId).find((t) => t.id === "T003")?.status).toBe("blocked");
    expect(file()).toBe(TINYFLATE.drifted);
    await fixture.resume(runId);
    // The resume compares the delivered rows run-length aware and names the blocked task.
    expect(records(`${ROW_RESTORE_DIR}resume/`).at(-1)).toMatchObject({ at: "resume", mode: "shadow", restore: [2, 3], verdict: "would_restore", blocked: ["T003"] });
    const final = await drive();
    // T003 no longer re-fails on the same literal: the host restored the rows first.
    expect(final.status).toBe("completed");
    expect(file()).toBe(TINYFLATE.faithful);
    expect(executor.sessions.filter((s) => s === "T003")).toHaveLength(2);
    expect(executor.sessions.filter((s) => s === "T002")).toHaveLength(1);
    const restored = records(ROW_RESTORE_DIR).find((r) => r.verdict === "restored");
    expect(restored).toMatchObject({ mode: "on", restore: [2, 3], tasks: ["T002"] });
    // The replay reads the resume-time restore like the checks stage's.
    expect(replayRowRestores(service.store, runId).every((b) => JSON.stringify(b.recorded) === JSON.stringify(b.replayed))).toBe(true);
  });

  test("with rowRunRestore off the rows are recorded in shadow and the brief names the miscount", async () => {
    const { fixture, runId, executor, drive, records, file } = await blockedAtTask({ rowRunRestore: "off" });
    await fixture.resume(runId);
    await drive();
    expect(fixture.service.store.run(runId)).toMatchObject({ status: "blocked", reason: "invalid_output" });
    expect(file()).toBe(TINYFLATE.drifted);
    expect(records(ROW_RESTORE_DIR).at(-1)).toMatchObject({ mode: "shadow", restore: [2, 3], verdict: "would_restore" });
    const brief = executor.briefs.T003?.at(-1) ?? "";
    expect(brief).toContain("the test's input literal differs from the criterion row by 3 bytes");
    expect(brief).toContain("the test's input literal differs from the criterion row by 21 bytes");
  });

  test("a task whose own check fails on the miscounted test gets the rows restored at its next session's start", async () => {
    const { fixture, runId, executor, records, file } = await blockedAtTask({}, true);
    expect(fixture.service.store.run(runId).status).toBe("completed");
    expect(file()).toBe(TINYFLATE.faithful);
    expect(records(ROW_RESTORE_DIR).find((r) => r.at === "task")).toMatchObject({ mode: "on", restore: [2, 3], verdict: "restored" });
    // T003 never met the miscount.
    expect(executor.sessions.filter((s) => s === "T003")).toHaveLength(1);
  });

  test("the resume record is an input of the invalid-output repeat key; the same file records nothing new", async () => {
    const { fixture, runId } = await blockedAtTask({ rowRunRestore: "off" });
    const { service } = fixture;
    const count = () => service.store.artifacts(runId).filter((a) => a.logical_path.startsWith(`${ROW_RESTORE_DIR}resume/`)).length;
    await fixture.resume(runId);
    expect(count()).toBe(1);
    await service.drive(runId, new AbortController().signal);
    // The file is unchanged and the stop the same: a second plain resume is a repeat.
    await expect(fixture.resume(runId)).rejects.toThrow();
    expect(count()).toBe(1);
  });
});

// #2551: the #2543 restore never ran on the real run. R82 tinyflate deflate 82f19908's request
// gives its rows as `run "deflate" "--level" "fixed" "--hex" stdin="7878…" => 0 "…\n" ""`, and
// `tests/deflate_match_test.c` spells them `failed += row(ARGS("deflate", …), "7878…", 0, …);`:
// the whole-line restore needs the request's notation (`sameHead`), so both miscounted rows were
// declined, the resume recorded nothing, and T007 ran as a parallel worker (two writers), whose
// session start had no restore. The host now rewrites only the miscounted run, in the file's own
// notation (`respelledRunLine`), and the drive compares every row file before the workers start.
const RUN_ROWS = [
  'run "deflate" "--level" "fixed" "--hex" stdin="61616161" => 0 "4b040200\\n" ""',
  `run "deflate" "--level" "fixed" "--hex" stdin="${hexRun("78", 300)}" => 0 "abaa50120400\\n" ""`,
  `run "deflate" "--level" "fixed" "--hex" stdin="${hexRun("71", 259)}" => 0 "2b2c1c050400\\n" ""`,
];
const runRequest = ["Build it.", "", "```text", `deflate_match_test in ${DEFLATE_PATH} (3 rows)`, ...RUN_ROWS, "```", ""].join("\n");
const byteOf = (b: string) => String.fromCharCode(Number.parseInt(b, 16));
/** Spellings of a long repeated-byte input a test may use, by name (AGENTS.md: a new one adds its case). */
const RUN_INPUTS: Record<string, (b: string, n: number) => string> = {
  "c hex string (R82)": (b, n) => `"${hexRun(b, n)}"`,
  "c upper-case hex": (b, n) => `"${hexRun(b.toUpperCase(), n)}"`,
  "c byte list": (b, n) => `(const unsigned char[]){${Array.from({ length: n }, () => `0x${b}`).join(", ")}}`,
  "c memset": (b, n) => `memset(buf, 0x${b}, ${n})`,
  "python repeat": (b, n) => `"${byteOf(b)}" * ${n}`,
  "hex repeat": (b, n) => `"${b}" * ${n}`,
  "typescript repeat": (b, n) => `"${byteOf(b)}".repeat(${n})`,
  "rust vec": (b, n) => `vec![0x${b}; ${n}]`,
  "go strings.Repeat": (b, n) => `strings.Repeat("${byteOf(b)}", ${n})`,
};
const runTest = (spell: (b: string, n: number) => string, x: number, q: number) =>
  [
    '#include "harness.h"',
    "",
    "int main(void) {",
    "    int failed = 0;",
    '    failed += row(ARGS("deflate", "--level", "fixed", "--hex"), "61616161", 0, "4b040200\\n", "");',
    `    failed += row(ARGS("deflate", "--level", "fixed", "--hex"), ${spell("78", x)}, 0, "abaa50120400\\n", "");`,
    `    failed += row(ARGS("deflate", "--level", "fixed", "--hex"), ${spell("71", q)}, 0, "2b2c1c050400\\n", "");`,
    "    return failed != 0;",
    "}",
    "",
  ].join("\n");
const R82_RUN_FILE = runTest(RUN_INPUTS["c hex string (R82)"]!, 303, 238);
const R82_RUN_FAITHFUL = runTest(RUN_INPUTS["c hex string (R82)"]!, 300, 259);
// R82 rev 51 (#2558): the implementer's own rows after the host's restore, inputs and outputs
// fitted to its encoder.
const R82_REV51_FILE = runTest(RUN_INPUTS["c hex string (R82)"]!, 312, 283)
  .replace('0, "abaa50120400\\n"', '0, "ab1805640100\\n"')
  .replace('0, "2b2c1c050400\\n"', '0, "2b1c05b80000\\n"');

describe("rowRunRestores: a miscounted run in another row notation than the request's (#2551)", () => {
  for (const [name, spell] of Object.entries(RUN_INPUTS))
    test(`${name}: the run is respelled with the row's count, the rest of the line kept`, () => {
      const graph = graphOf(DEFLATE_PATH, "T005");
      const [found] = rowRunRestores(runRequest, graph, () => runTest(spell, 303, 238), "on");
      expect(found?.record.sites.map((s) => [s.row, s.line, s.sameHead, s.respelled])).toEqual([
        [2, 6, false, true],
        [3, 7, false, true],
      ]);
      expect(found?.record).toMatchObject({ restore: [2, 3], verdict: "restored" });
      expect(found?.after).toBe(runTest(spell, 300, 259));
      // The replay decides the record's flags as recorded.
      expect(rowRestoreDecision(found?.record.sites ?? [])).toEqual([2, 3]);
    });

  test("the R82 file: before #2551 the sites were declined (sameHead false, no respelled flag)", () => {
    const [found] = rowRunRestores(runRequest, graphOf(DEFLATE_PATH, "T005"), () => R82_RUN_FILE, "shadow");
    const withoutRespell = (found?.record.sites ?? []).map(({ respelled: _, ...site }) => site);
    expect(rowRestoreDecision(withoutRespell)).toEqual([]);
    expect(found?.record.verdict).toBe("would_restore");
  });

  test("respelledRunLine leaves a line with no miscounted run, or a run it cannot rewrite exactly", () => {
    expect(respelledRunLine('row("61616161")', RUN_ROWS[0]!)).toBeNull();
    // Two copies of the same miscounted spelling on one line: which one is the row's is unknown.
    const twice = `row("${hexRun("78", 303)}", "${hexRun("78", 303)}")`;
    expect(respelledRunLine(twice, RUN_ROWS[1]!)).toBeNull();
  });
});

/** The R82 parallel run: T002 writes the row file, T003 (src and the test) blocks while it miscounts. */
class ParallelRunExecutor extends FixtureExecutor {
  sessions: string[] = [];
  briefs: string[] = [];
  /**
   * #2558: R82 rev 51's T007 implementer, which after the host's restore edits the restored rows to
   * its encoder's output (inputs 312/283 bytes, expected outputs changed) through the run's edit
   * guard. The answers of those edits.
   */
  fit?: NativeWorkflowService;
  answers: unknown[] = [];
  constructor(private workspace: string, private checkId: string) {
    super(workspace);
  }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const graph = (result.output as { taskGraph: TaskGraph }).taskGraph;
      const first = graph.tasks[0]!;
      graph.tasks.push(
        { ...first, id: "T002", title: "Deflate match rows", dependsOn: ["T001"], writes: [{ path: DEFLATE_PATH, action: "create" }], checkIds: [] },
        { ...first, id: "T003", title: "Deflate matcher", dependsOn: ["T002"], writes: [{ path: SRC_PATH, action: "create" }, { path: DEFLATE_PATH, action: "modify" }], checkIds: [this.checkId] },
      );
    }
    if (request.profile.output !== "implementation") return result;
    const id = request.task?.id ?? "";
    const root = request.root ?? this.workspace;
    this.sessions.push(id);
    if (id === "T001") writeFileSync(join(root, "value.txt"), "ready");
    if (id === "T002") {
      mkdirSync(dirname(join(root, DEFLATE_PATH)), { recursive: true });
      writeFileSync(join(root, DEFLATE_PATH), R82_RUN_FILE);
    }
    if (id !== "T003") return result;
    this.briefs.push(request.prompt);
    if (this.fit && readFileSync(join(root, DEFLATE_PATH), "utf8") === R82_RUN_FAITHFUL) {
      const policy = JSON.parse(this.fit.store.run(request.runId).policy_json) as RunPolicy;
      const guard = new WorkflowToolPolicy(this.fit.store, this.fit.leases, request.runId, request.attemptId, request.profile, policy, request.task, root);
      this.answers.push(await guard.execute("edit_file", { path: DEFLATE_PATH }, async () => {
        writeFileSync(join(root, DEFLATE_PATH), R82_REV51_FILE);
        return { success: true, output: "edited" };
      }));
    }
    const test = readFileSync(join(root, DEFLATE_PATH), "utf8");
    if (test === R82_RUN_FAITHFUL) {
      mkdirSync(dirname(join(root, SRC_PATH)), { recursive: true });
      writeFileSync(join(root, SRC_PATH), "int deflate(void) { return 0; }\n");
      return result;
    }
    return { ...result, output: { schemaVersion: 1, taskId: id, outcome: "blocked", summary: BLOCKED_SUMMARY, evidenceIds: [], unresolved: [BLOCKED_SUMMARY] } };
  }
}

describe("scenario: R82 tinyflate 82f19908, a parallel run blocked at the corrective resumes onto the request's counts (#2551)", () => {
  async function parallelBlocked(extra: Partial<RunPolicy> = {}, fit = false) {
    const check = {
      id: "deflate-rows",
      executable: "bun",
      args: ["-e", `const t = await Bun.file(${JSON.stringify(DEFLATE_PATH)}).text(); if (!t.includes('"${hexRun("78", 300)}"') || !t.includes('"${hexRun("71", 259)}"')) { console.log("${DEFLATE_PATH}:11: row failed"); process.exit(1); }`],
      cwd: ".",
      timeoutMs: 10000,
      required: true,
      scope: "task" as const,
      envNames: [],
      writes: [],
    };
    const policy: RunPolicy = { ...fixturePolicy, checks: [...fixturePolicy.checks, check], executionMode: "worktree", maxConcurrentWriters: 2, ...extra };
    let executor: ParallelRunExecutor | undefined;
    const fixture = workflowFixture({ policy, executor: (root) => (executor = new ParallelRunExecutor(root, check.id)) });
    cleanups.push(fixture.dispose);
    if (fit) executor!.fit = fixture.service;
    for (const args of [["init"], ["config", "user.email", "fixture@example.invalid"], ["config", "user.name", "Fixture"]])
      expect(Bun.spawnSync(["git", ...args], { cwd: fixture.root }).exitCode).toBe(0);
    writeFileSync(join(fixture.root, "README.md"), "# Fixture\n");
    expect(Bun.spawnSync(["git", "add", "README.md"], { cwd: fixture.root }).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "-c", "core.hooksPath=", "commit", "-m", "Fixture"], { cwd: fixture.root }).exitCode).toBe(0);
    const { service } = fixture;
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: `Create ready value.\n\n${runRequest}`, ownerLabel: "test", policy, executionMode: "worktree", maxConcurrentWriters: 2 });
    const drive = () => service.drive(run.runId, new AbortController().signal);
    let current = await drive();
    for (let i = 0; i < 8 && current.status === "waiting"; i++) {
      if (service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
      await fixture.approve(run.runId);
      current = await drive();
    }
    const runFile = () => readFileSync(join(runRoot(fixture.root, service.store.state(run.runId)), DEFLATE_PATH), "utf8");
    const records = (prefix: string) =>
      service.store
        .artifacts(run.runId)
        .filter((a) => a.logical_path === `${prefix}${DEFLATE_PATH}.json`)
        .map((a) => JSON.parse(service.store.readArtifact(run.runId, a.id)) as RowRestoreRecord & { at?: string; blocked?: string[] });
    return { fixture, runId: run.runId, executor: executor!, drive, runFile, records };
  }

  test("blocked invalid_output at T003 as in R82, resumed: the rows are recorded, restored before the worker starts, and T003 completes", async () => {
    const { fixture, runId, executor, drive, runFile, records } = await parallelBlocked();
    const { service } = fixture;
    expect(service.store.run(runId)).toMatchObject({ status: "blocked", reason: "invalid_output" });
    expect(runFile()).toBe(R82_RUN_FILE);
    // T002 wrote the file after the drive's comparison: T003's worker brief names the miscount.
    expect(executor.briefs[0]).toContain("the test's input literal differs from the criterion row by 3 bytes");
    await fixture.resume(runId);
    expect(records(`${ROW_RESTORE_DIR}resume/`).at(-1)).toMatchObject({ at: "resume", restore: [2, 3], blocked: ["T003"] });
    const final = await drive();
    expect(final.status).toBe("completed");
    expect(runFile()).toBe(R82_RUN_FAITHFUL);
    expect(records(ROW_RESTORE_DIR).find((r) => r.verdict === "restored")).toMatchObject({ at: "drive", mode: "on", restore: [2, 3] });
    expect(executor.sessions.filter((s) => s === "T003")).toHaveLength(2);
  }, 60000);

  test("with rowRunRestore off the resumed worker's brief still names both miscounts", async () => {
    const { fixture, runId, executor, drive, runFile } = await parallelBlocked({ rowRunRestore: "off" });
    await fixture.resume(runId);
    await drive();
    expect(fixture.service.store.run(runId)).toMatchObject({ status: "blocked", reason: "invalid_output" });
    expect(runFile()).toBe(R82_RUN_FILE);
    expect(executor.briefs.at(-1)).toContain("differs from the criterion row by 21 bytes");
  }, 60000);

  test("#2558 (R82 rev 51): after the restore, the worker's edit of the restored rows is put back, the rows hold and T003 completes", async () => {
    const { fixture, runId, executor, drive, runFile } = await parallelBlocked({}, true);
    await fixture.resume(runId);
    const final = await drive();
    // The implementer fitted the rows to its encoder; the guard put the edit back and said why.
    expect(executor.answers).toEqual([expect.objectContaining({ success: false, error: "prescribed_row" })]);
    expect(String((executor.answers[0] as { output?: unknown }).output)).toContain("row 2");
    expect(String((executor.answers[0] as { output?: unknown }).output)).toContain("change the source");
    expect(final.status).toBe("completed");
    expect(runFile()).toBe(R82_RUN_FAITHFUL);
  }, 60000);

  test("#2558: with rowEditGuard off the edit stands and T003 blocks again on its own rows, as on rev 51", async () => {
    const { fixture, runId, executor, drive, runFile } = await parallelBlocked({ rowEditGuard: "off" }, true);
    await fixture.resume(runId);
    await drive();
    expect(executor.answers).toEqual([{ success: true, output: "edited" }]);
    expect(fixture.service.store.run(runId)).toMatchObject({ status: "blocked", reason: "invalid_output" });
    // The host's restore in the run root is not what the worker's own (unguarded) edit left.
    expect(runFile()).toBe(R82_RUN_FAITHFUL);
  }, 60000);
});

describe("#2558: the rows a session changed after the host restored them", () => {
  test("rowRunRestores restores the rev 51 rows (runs and fitted outputs), and a second pass changes nothing", () => {
    const graph = graphOf(DEFLATE_PATH, "T005");
    const [first] = rowRunRestores(runRequest, graph, () => R82_REV51_FILE, "on");
    expect(first?.record).toMatchObject({ restore: [2, 3], verdict: "restored" });
    expect(first?.record.sites.every((s) => s.respelled)).toBe(true);
    expect(first?.after).toBe(R82_RUN_FAITHFUL);
    // Idempotent: the restored file, the original miscount restored, and the restore restored again.
    expect(rowRunRestores(runRequest, graph, () => first?.after ?? "", "on")).toEqual([]);
    const [again] = rowRunRestores(runRequest, graph, () => R82_RUN_FILE, "on");
    expect(again?.after).toBe(R82_RUN_FAITHFUL);
    expect(rowRunRestores(runRequest, graph, () => again?.after ?? "", "on")).toEqual([]);
  });

  test("relitLine puts each quoted literal back by position, and only when both quote as many", () => {
    const line = '    failed += row(ARGS("deflate", "--hex"), "7878", 0, "ab\\n", "");';
    expect(relitLine(line, 'run "deflate" "--hex" stdin="7171" => 0 "cd\\n" ""')).toBe('    failed += row(ARGS("deflate", "--hex"), "7171", 0, "cd\\n", "");');
    expect(relitLine(line, 'run "deflate" stdin="7171" => 0 "cd\\n" ""')).toBeNull();
    expect(relitLine(line, 'run "deflate" "--hex" stdin="7878" => 0 "ab\\n" ""')).toBeNull();
  });

  test("rowEditBreaks: an edit that breaks a held row is a break; writing rows, other files and new files are not", () => {
    expect(rowEditBreaks(runRequest, DEFLATE_PATH, R82_RUN_FAITHFUL, R82_REV51_FILE)).toMatchObject({ path: DEFLATE_PATH, rows: [2, 3] });
    // The rows did not hold before (the miscount the host restores): fixing or keeping them is free.
    expect(rowEditBreaks(runRequest, DEFLATE_PATH, R82_RUN_FILE, R82_REV51_FILE)).toBeNull();
    expect(rowEditBreaks(runRequest, DEFLATE_PATH, R82_RUN_FILE, R82_RUN_FAITHFUL)).toBeNull();
    // A test task writing its rows one by one.
    const partial = R82_RUN_FAITHFUL.split("\n").filter((l) => !l.includes("7171")).join("\n");
    expect(rowEditBreaks(runRequest, DEFLATE_PATH, partial, R82_RUN_FAITHFUL)).toBeNull();
    expect(rowEditBreaks(runRequest, DEFLATE_PATH, null, R82_REV51_FILE)).toBeNull();
    expect(rowEditBreaks(runRequest, SRC_PATH, "a", "b")).toBeNull();
  });
});

// #2529: #2522 restores only at the checks stage, after every task ran, so a row-file task whose
// own task-scope rows check failed on a changed row went back to its session to copy the row
// again before the checks stage restored it (R82 tinyflate deflate named row 8 drifting at T005
// while the task kept going). The host now restores the rows a task owns at the task's end,
// before its own checks, under the same `rowRestore` setting.
const taskOf = (path: string, extra: Partial<Task> = {}) =>
  ({ id: "T002", origin: "planned", writes: [{ path, action: "create" }], ...extra }) as unknown as Task;

describe("taskRowRestores: the restore at a row-file task's end, on the rows it owns (#2529)", () => {
  test("a whole task restores every changed row of its file; the record says task-end", () => {
    const [planned] = taskRowRestores(requestOf(TINYFLATE), taskOf(DEFLATE_PATH), () => TINYFLATE.drifted, "on");
    expect(planned?.record).toMatchObject({ at: "task-end", blocked: ["T002"], mode: "on", restore: [2, 3], verdict: "restored", tasks: ["T002"] });
    expect(planned?.after).toBe(TINYFLATE.faithful);
    const [shadow] = taskRowRestores(requestOf(TINYFLATE), taskOf(DEFLATE_PATH), () => TINYFLATE.drifted, "shadow");
    expect(shadow?.record.verdict).toBe("would_restore");
    expect(taskRowRestores(requestOf(TINYFLATE), taskOf(DEFLATE_PATH), () => TINYFLATE.faithful, "on")).toEqual([]);
    // A task that does not write the row file has nothing to restore.
    expect(taskRowRestores(requestOf(TINYFLATE), taskOf("src/deflate.c"), () => TINYFLATE.drifted, "on")).toEqual([]);
  });

  test("a row slice restores only its own rows", () => {
    const rows = rowsOf(TINYFLATE);
    const slice = (index: number, own: string[]) =>
      taskOf(DEFLATE_PATH, { sizingSlice: { taskId: "T002", index, count: 2, share: own.length / rows.length, rows: own } });
    const first = slice(0, rows.slice(0, 2));
    const second = slice(1, rows.slice(2));
    expect([...ownedRows(first, rows)]).toEqual([1, 2]);
    expect([...ownedRows(second, rows)]).toEqual([3]);
    const [one] = taskRowRestores(requestOf(TINYFLATE), first, () => TINYFLATE.drifted, "on");
    expect(one?.record.restore).toEqual([2]);
    expect(one?.record.sites.map((s) => s.row)).toEqual([2]);
    // Row 3 is still the file's miscount: the other slice owns it.
    expect(one?.after).toBe(deflateTest(300, 238));
    const [two] = taskRowRestores(requestOf(TINYFLATE), second, () => TINYFLATE.drifted, "on");
    expect(two?.record.restore).toEqual([3]);
    expect(two?.after).toBe(deflateTest(303, 259));
    // A slice that does not carry its rows owns none until the file is whole.
    const bare = taskOf(DEFLATE_PATH, { sizingSlice: { taskId: "T002", index: 0, count: 2, share: 0.5 } });
    expect(taskRowRestores(requestOf(TINYFLATE), bare, () => TINYFLATE.drifted, "on")).toEqual([]);
  });

  test("the drift's summary names the host when its restore is recorded", () => {
    const [compared] = rowBlockDrifts(requestOf(SLOTPROMPT), graphOf(SLOT_PATH), () => SLOTPROMPT.drifted);
    const drift = compared!.drifts[0]!;
    expect(rowBlockDriftSummary(drift)).toContain("A repair task would restore the row");
    expect(rowBlockDriftSummary(drift, "would_restore")).toContain("The host would restore the row from the request's text (rowRestore shadow)");
    expect(rowBlockDriftSummary(drift, "would_restore")).not.toContain("A repair task");
    expect(rowBlockDriftSummary(drift, "put_back")).toContain("put it back when a required check failed");
    expect(rowBlockDriftSummary(drift, "declined")).toContain("The host cannot restore the row in place");
  });
});

// The row-file task's own rows check: task-scope, so it runs at T002's end on the drifted file.
const store = (fixture: { service: { store: { eventsOfType: (runId: string, type: string) => { payload: unknown }[] } } }, runId: string) =>
  fixture.service.store
    .eventsOfType(runId, "decision.would_stop")
    .map((e) => e.payload as { reason: string; key: string; summary: string })
    .filter((p) => p.reason === "row_block_drift");
const ownRows = (shape: RestoreShape) => ({ check: { ...rowsCheck(shape), id: "own-rows", scope: "task" as const }, corrected: shape.faithful });

describe("scenario: R82, a row-file task whose own rows check fails on a changed row (#2529)", () => {
  for (const [language, shape] of Object.entries({ c: TINYFLATE, dart: SLOTPROMPT }))
    test(`${language}: with rowRestore on the task finishes in one session with the host's restore at its end`, async () => {
      const { final, file, sessions, records, wouldStops, fixture, runId } = await deliver(shape, true, ownRows(shape));
      expect(final.status).toBe("completed");
      // No second T002 session and no corrective copied the rows again.
      expect(sessions).toEqual(["T001", "T002"]);
      expect(file).toBe(shape.faithful);
      expect(records[0]).toMatchObject({ at: "task-end", blocked: ["T002"], mode: "on", restore: shape.restored, verdict: "restored", checks: "passed" });
      // The checks stage found the rows as given: nothing to restore, nothing drifts.
      expect(records).toHaveLength(1);
      expect(wouldStops).toEqual([]);
      const replayed = replayRowRestores(fixture.service.store, runId);
      expect(replayed.map((b) => [b.at, b.task, b.recorded, b.replayed])).toEqual([["task-end", "T002", shape.restored, shape.restored]]);
    });

  test("dart: shadow by default, the task end records would_restore and the file stays as written", async () => {
    const { sessions, records, fixture, runId, wouldStops } = await deliver(SLOTPROMPT, false, ownRows(SLOTPROMPT));
    expect(records[0]).toMatchObject({ at: "task-end", mode: "shadow", restore: [2], verdict: "would_restore", checks: null });
    // The failing own check sent the task back to a session, as in R82.
    expect(sessions.length).toBeGreaterThan(2);
    expect(replayRowRestores(fixture.service.store, runId)[0]).toMatchObject({ at: "task-end", task: "T002", recorded: [2], replayed: [2] });
    expect(wouldStops).toEqual([]);
  });

  test("c: the replay keys the task-end records apart from the checks stage's", async () => {
    const { fixture, runId, wouldStops } = await deliver(TINYFLATE, false, undefined, { rowRunRestore: "off" });
    const replayed = replayRowRestores(fixture.service.store, runId);
    expect(replayed.find((b) => b.at === "task-end")).toMatchObject({ task: "T002", candidate: null, mode: "shadow", recorded: [2, 3] });
    expect(replayed.find((b) => b.at === "checks")).toMatchObject({ task: null, mode: "shadow", recorded: [2, 3] });
    // The checks stage's would-stop names the host's shadow restore, not a repair task.
    const summaries = store(fixture, runId).filter((w) => w.key.startsWith(`${DEFLATE_PATH}#row-`));
    expect(summaries.length).toBeGreaterThan(0);
    for (const w of summaries) expect(w.summary).toContain("The host would restore the row");
    expect(wouldStops.length).toBeGreaterThan(0);
  });
});
