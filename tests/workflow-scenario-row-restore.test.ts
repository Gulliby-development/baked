import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ROW_RESTORE_DIR,
  type RowRestoreRecord,
  type RowRestoreSite,
  restoredLine,
  rowRestoreDecision,
  rowRestorePlan,
  rowRestores,
} from "../src/core/workflows/row-restore.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { replayRowRestores } from "../src/core/workflows/trace.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
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

/** One case per row notation the host restores (AGENTS.md: a new notation adds its case here). */
const RESTORE_SHAPES: Record<string, RestoreShape> = {
  c: TINYFLATE,
  "c-macro": INFLATE,
  dart: SLOTPROMPT,
  typescript: DELTAGLUE,
  elixir: RATDEC,
  go: GO,
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
    expect(records.find((r) => (r as { at?: string }).at === "task")).toMatchObject({ mode: "on", restore: [2, 3], verdict: "restored" });
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
