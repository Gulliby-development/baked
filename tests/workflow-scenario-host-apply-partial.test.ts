import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashBytes } from "../src/core/specs/hash.js";
import { runRootPath } from "../src/core/workflows/effects.js";
import {
  type HostApplyWrite,
  hostApplyDecision,
  hostApplyPartialSplit,
  hostApplyRecord,
  hostApplyRecords,
  hostApplyWriteReason,
  hostPartialTasks,
} from "../src/core/workflows/host-apply.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { exportTrace, replayTrace } from "../src/core/workflows/trace.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #2937, follow-up of #2930 (R99 skillseek `terms-score` T004, Ruby): the task had seven prescribed
// row files and one of them declined, so the host wrote none and a session wrote all seven
// (655,288 tokens). With `hostApplyPartial: "on"` the host writes the files it can and the session
// gets only the declined one; the default `shadow` records that split and changes nothing; `off`
// records nothing. The declined file here is a statement row with no separator, which #2936 keeps
// declined on purpose.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// The appliable file: a minitest `ROWS = [` list whose base holds two rows.
const LIST_PATH = "test/split_rows_test.rb";
const listFile = (rows: string[]) =>
  ['require "minitest/autorun"', 'require_relative "../lib/split"', "", "class SplitRowsTest < Minitest::Test", "  ROWS = [", ...rows.map((r, i) => `    ${r}${i === rows.length - 1 ? "" : ","}`), "  ].freeze", "", "  def test_rows", "    ROWS.each { |input, out| assert_equal out, Split.split(input) }", "  end", "end", ""].join("\n");
const LIST_ROWS = ['["a,b", ["a", "b"]]', '["a,,b", ["a", "", "b"]]', '["\\"q,r\\",s", ["q,r", "s"]]'];
const LIST_BASE = listFile(['["", []]', '[",", ["", ""]]']);
// The declined file: one call statement per row, and the base holds one, so no separator is known.
const STATEMENT_PATH = "test/check_rows_test.rb";
const statementFile = (rows: string[]) => ["def test_rows", ...rows.map((r) => `  ${r}`), "end", ""].join("\n");
const STATEMENT_ROWS = ['check("b", 2)', 'check("c", 3)'];
const STATEMENT_BASE = statementFile(['check("a", 1)']);
const STATEMENT_WRITTEN = statementFile(['check("a", 1)', ...STATEMENT_ROWS]);

const REQUEST = [
  "Create ready value.",
  "",
  "The prescribed rows, one test each:",
  "",
  "```text",
  `SplitRows in ${LIST_PATH} (3 rows, [input, out])`,
  ...LIST_ROWS,
  "```",
  "",
  "```text",
  `CheckRows in ${STATEMENT_PATH} (2 rows, check(input, count))`,
  ...STATEMENT_ROWS,
  "```",
  "",
].join("\n");

const DECLINED = `the shape for ${STATEMENT_PATH} has one row with no separator, so the separator between rows is not known`;

/** T002 writes both row files; a session writes each file it may write as the request gives it. */
class PartialExecutor extends FixtureExecutor {
  /** The writable paths and read hints of each T002 session. */
  sessions: { writes: string[]; readHints: string[]; prompt: string }[] = [];
  implemented: string[] = [];
  constructor(private workspace: string) {
    super(workspace);
    mkdirSync(join(workspace, "test"), { recursive: true });
    writeFileSync(join(workspace, LIST_PATH), LIST_BASE);
    writeFileSync(join(workspace, STATEMENT_PATH), STATEMENT_BASE);
  }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const graph = (result.output as { taskGraph: TaskGraph }).taskGraph;
      const first = graph.tasks[0]!;
      graph.tasks.push({ ...first, id: "T002", title: "Row files", dependsOn: ["T001"], writes: [{ path: LIST_PATH, action: "modify" }, { path: STATEMENT_PATH, action: "modify" }], checkIds: [] });
    }
    if (request.profile.output === "implementation") {
      this.implemented.push(request.task?.id ?? "");
      if (request.task?.id === "T002") {
        const writes = request.task.writes.map((w) => w.path);
        this.sessions.push({ writes, readHints: request.task.readHints, prompt: request.prompt });
        const final: Record<string, string> = { [LIST_PATH]: listFile(LIST_ROWS), [STATEMENT_PATH]: STATEMENT_WRITTEN };
        for (const path of writes) {
          mkdirSync(dirname(join(this.workspace, path)), { recursive: true });
          writeFileSync(join(this.workspace, path), final[path] ?? "");
        }
      }
    }
    return result;
  }
}

// Fails while either file lacks one of its prescribed rows.
const rowsCheck = {
  id: "rows",
  executable: "bun",
  args: ["-e", `const files = ${JSON.stringify({ [LIST_PATH]: LIST_ROWS, [STATEMENT_PATH]: STATEMENT_ROWS })}; for (const [path, rows] of Object.entries(files)) { const t = await Bun.file(path).text(); if (!rows.every((r) => t.includes(r))) { console.log(path + ": a row differs"); process.exit(1); } }`],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "feature" as const,
  envNames: [],
  writes: [],
};

async function deliver(extra: Partial<RunPolicy>) {
  const policy: RunPolicy = { ...fixturePolicy, checks: [...fixturePolicy.checks, rowsCheck], ...extra };
  let executor: PartialExecutor | undefined;
  const fixture = workflowFixture({
    policy,
    executor: (root) => {
      executor = new PartialExecutor(root);
      return executor;
    },
  });
  cleanups.push(fixture.dispose);
  const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy });
  let current = await fixture.service.drive(run.runId, new AbortController().signal);
  for (let i = 0; i < 8 && current.status === "waiting"; i++) {
    if (fixture.service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
    await fixture.approve(run.runId);
    current = await fixture.service.drive(run.runId, new AbortController().signal);
  }
  const store = fixture.service.store;
  const tree = join(fixture.root, runRootPath(store, run.runId));
  return {
    final: await fixture.service.get(run.runId),
    files: { list: readFileSync(join(tree, LIST_PATH), "utf8"), statement: readFileSync(join(tree, STATEMENT_PATH), "utf8") },
    calls: executor?.implemented ?? [],
    sessions: executor?.sessions ?? [],
    record: hostApplyRecords(store, run.runId).find((r) => r.taskId === "T002"),
    fixture,
    runId: run.runId,
  };
}

describe("scenario: one row file of a task declines, the host writes the other (#2937)", () => {
  test("hostApplyPartial on: the host writes the appliable file, and the session gets only the declined one", async () => {
    const { final, files, calls, sessions, record } = await deliver({ rowFileWrite: "on", hostApplyPartial: "on" });
    expect(final.status).toBe("completed");
    expect(calls).toEqual(["T001", "T002"]);
    // The session may write the declined file only; the host's file is a read hint, named in its brief.
    expect(sessions.map((s) => s.writes)).toEqual([[STATEMENT_PATH]]);
    expect(sessions[0]?.readHints).toContain(LIST_PATH);
    expect(sessions[0]?.prompt).toContain("hostWritten");
    expect(files.list).toBe(listFile(LIST_ROWS));
    expect(files.statement).toBe(STATEMENT_WRITTEN);
    expect(record).toMatchObject({ mode: "on", wouldApply: false, reason: DECLINED, applied: false, partial: { written: [LIST_PATH], session: [STATEMENT_PATH], applied: true } });
    expect(record?.written).toEqual({ [LIST_PATH]: hashBytes(listFile(LIST_ROWS)) });
  }, 120000);

  test("shadow by default: the record names the split, and a session writes both files as before", async () => {
    const { final, files, sessions, record } = await deliver({ rowFileWrite: "on" });
    expect(final.status).toBe("completed");
    expect(sessions.map((s) => s.writes)).toEqual([[LIST_PATH, STATEMENT_PATH]]);
    expect(sessions[0]?.prompt).not.toContain("hostWritten");
    expect(files.list).toBe(listFile(LIST_ROWS));
    expect(files.statement).toBe(STATEMENT_WRITTEN);
    expect(record).toMatchObject({ mode: "on", wouldApply: false, reason: DECLINED, applied: false, partial: { written: [LIST_PATH], session: [STATEMENT_PATH] } });
    expect(record?.partial?.applied).toBeUndefined();
    expect(record?.written).toBeUndefined();
  }, 120000);

  test("shadow with every host setting at its default: the shadow record before the session names the split", async () => {
    const { sessions, record } = await deliver({});
    expect(sessions.map((s) => s.writes)).toEqual([[LIST_PATH, STATEMENT_PATH]]);
    expect(record).toMatchObject({ mode: "shadow", wouldApply: false, partial: { written: [LIST_PATH], session: [STATEMENT_PATH] } });
    expect(record?.applied).toBeUndefined();
  }, 120000);

  test("hostApplyPartial on without rowFileWrite on writes nothing: each kind stays under its own setting", async () => {
    const { sessions, record } = await deliver({ hostApplyPartial: "on" });
    expect(sessions.map((s) => s.writes)).toEqual([[LIST_PATH, STATEMENT_PATH]]);
    expect(record).toMatchObject({ mode: "shadow", partial: { written: [LIST_PATH], session: [STATEMENT_PATH] } });
    expect(record?.partial?.applied).toBeUndefined();
  }, 120000);

  test("off: no split is recorded, and a session writes both files", async () => {
    const { final, sessions, record } = await deliver({ rowFileWrite: "on", hostApplyPartial: "off" });
    expect(final.status).toBe("completed");
    expect(sessions.map((s) => s.writes)).toEqual([[LIST_PATH, STATEMENT_PATH]]);
    expect(record).toMatchObject({ mode: "on", wouldApply: false, reason: DECLINED, applied: false });
    expect(record?.partial).toBeUndefined();
  }, 120000);

  test("the replay decides the recorded split again from the recorded writes", async () => {
    const { fixture, runId } = await deliver({ rowFileWrite: "on", hostApplyPartial: "on" });
    const dir = mkdtempSync(join(tmpdir(), "host-apply-partial-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(fixture.root, out);
    const replayed = replayTrace(out).runs.find((r) => r.runId === runId);
    const split = { written: [LIST_PATH], session: [STATEMENT_PATH] };
    expect(replayed?.hostApply).toEqual([{ taskId: "T002", recorded: false, replayed: false, reason: DECLINED, partial: { recorded: split, replayed: split } }]);
    expect(replayed?.newApplyDecisions).toBe(0);
  }, 120000);
});

const rowsWrite = (path: string, separated: boolean): HostApplyWrite => ({
  path,
  action: "modify",
  files: 0,
  diffs: 0,
  whole: false,
  exists: true,
  applies: null,
  rows: { count: 2, language: true, shape: "file", runs: 1, oneLine: true, sameHead: true, arity: true, separated },
});
const fileWrite = (path: string, extra: Partial<HostApplyWrite> = {}): HostApplyWrite => ({ path, action: "create", files: 1, diffs: 0, whole: true, exists: false, applies: null, ...extra });

describe("hostApplyWriteReason: the per-write verdict the task verdict and the split share (#2937)", () => {
  // Every decline reason of `hostApplyDecision`, one write each.
  const declines: [string, HostApplyWrite, string][] = [
    ["a delete", fileWrite("a.txt", { action: "delete" }), "the task deletes a.txt"],
    ["no verbatim block", fileWrite("a.txt", { files: 0 }), "the request gives no verbatim block for a.txt"],
    ["a file and a diff", fileWrite("a.txt", { diffs: 1 }), "the request gives both a fenced file and a diff for a.txt"],
    ["two fenced files", fileWrite("a.txt", { files: 2 }), "the request gives 2 fenced blocks for a.txt"],
    ["a shared section heading", fileWrite("a.md", { exists: true, region: { level: 2, matches: 2 } }), "has a heading that 2 sections of the file share"],
    ["a listing", fileWrite("a.ts", { listing: true }), "may be a listing"],
    ["an excerpt", fileWrite("a.ts", { exists: true, whole: false }), "may be an excerpt"],
    ["a diff that does not apply", fileWrite("a.ts", { files: 0, diffs: 1, applies: false, refusal: "patch failed" }), "does not apply to the task's base: patch failed"],
    ["a row shape without a separator", rowsWrite("t.rb", false), "no separator"],
  ];
  for (const [name, write, reason] of declines)
    test(`${name}: the write declines, and so does a task of it alone`, () => {
      expect(hostApplyWriteReason(write)).toContain(reason);
      expect(hostApplyDecision([write]).reason).toBe(hostApplyWriteReason(write));
    });

  test("writes that apply: a whole file, a section, a created diff already present, a row file", () => {
    for (const write of [fileWrite("a.ts"), fileWrite("a.md", { exists: true, whole: false, region: { level: 2, matches: 1 } }), fileWrite("a.ts", { files: 0, diffs: 1, applies: false, present: true }), rowsWrite("t.rb", true)])
      expect(hostApplyWriteReason(write)).toBeNull();
  });

  test("the task verdict is the first write's reason; the split keeps write order and needs both sides", () => {
    const writes = [rowsWrite("a.rb", true), rowsWrite("b.rb", false), fileWrite("c.ts"), fileWrite("d.ts", { files: 0 })];
    expect(hostApplyDecision(writes).reason).toBe(hostApplyWriteReason(writes[1]!));
    expect(hostApplyPartialSplit(writes)).toEqual({ written: ["a.rb", "c.ts"], session: ["b.rb", "d.ts"] });
    expect(hostApplyPartialSplit([rowsWrite("a.rb", true)])).toBeNull();
    expect(hostApplyPartialSplit([rowsWrite("b.rb", false)])).toBeNull();
    // A supplied-checks conflict names no file the host could keep out: nothing splits.
    expect(hostApplyPartialSplit(writes, "lint fails")).toBeNull();
  });

  test("hostApplyRecord records the split only under shadow or on, and never for a task that applies whole", () => {
    const writes = [rowsWrite("a.rb", true), rowsWrite("b.rb", false)];
    expect(hostApplyRecord("T1", writes).partial).toBeUndefined();
    expect(hostApplyRecord("T1", writes, hostApplyDecision, "shadow", null, "off").partial).toBeUndefined();
    expect(hostApplyRecord("T1", writes, hostApplyDecision, "shadow", null, "shadow").partial).toEqual({ written: ["a.rb"], session: ["b.rb"] });
    expect(hostApplyRecord("T1", [rowsWrite("a.rb", true)], hostApplyDecision, "on", null, "on").partial).toBeUndefined();
  });

  test("hostPartialTasks routes a task with a supplied write of an enabled kind, only under on", () => {
    const graph = { tasks: [{ id: "T002", title: "Rows", description: "Rows", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: LIST_PATH, action: "modify" as const }, { path: "lib/split.rb", action: "create" as const }], readHints: [], checkIds: [], origin: "planned" as const, findingIds: [], rationale: "r" }] };
    expect(hostPartialTasks(REQUEST, graph, { rowFileWrite: "on", hostApplyPartial: "on" })).toEqual(["T002"]);
    expect(hostPartialTasks(REQUEST, graph, { rowFileWrite: "on" })).toEqual([]);
    expect(hostPartialTasks(REQUEST, graph, { hostApply: "on", hostApplyPartial: "on" })).toEqual([]);
  });
});
