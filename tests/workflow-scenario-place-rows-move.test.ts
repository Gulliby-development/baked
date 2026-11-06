import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { isNoRow, rowOf } from "../src/core/intelligence/language-records.js";
import { detectLanguageFromPath } from "../src/core/intelligence/types.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { MOVE_NOTE, placeRows, placeRowsDescription, placeRowTargets } from "../src/core/tools/place-rows.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { runRootPath } from "../src/core/workflows/effects.js";
import { ROW_FILE_SHAPES, rowFilePlan } from "../src/core/workflows/row-file.js";
import { asksForMove, rowEditBreaks, rowEditBreakText } from "../src/core/workflows/row-restore.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";

// Bench round 102 (#2955). tailcut `filters` T002 wrote the two-list C++ row files with every row in
// `rows`, `totals` empty, and rows 13 to 18 between rows 4 and 5 (#2956). The corrective T003 had to
// restore the order and split the rows between the lists, and no tool could: the row guard (#2558)
// judges each call alone and put back the one-line edit_file that deleted a held row, and place_rows
// refused rows the file held ("already holds ... Place only the rows the file does not hold yet").
// The put-back answer said to keep the literals and change the source. T003 ran 8 attempts and
// 4.34M tokens, and the run stopped `invalid_output` four times. place_rows now takes `move: true`
// (one write that leaves every row in the file, which the guard keeps), and the put-back answer
// names the move when the task asks for one or the row is still in the file.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fence = "```";
const requestOf = (path: string, rows: readonly string[]) =>
  ["Correct the row file.", "", "The prescribed rows, one test each:", "", `${fence}text`, `Rows in ${path} (${rows.length} rows)`, ...rows, fence, ""].join("\n");

/** A two-list row file per language: `rows` takes rows 1 to 4, `totals` rows 5 and 6. */
interface TwoLists {
  language: string;
  path: string;
  rows: string[];
  /** The opening line of the second list, as the file holds it. */
  totals: string;
  file: (first: string[], second: string[]) => string;
  options: { indent?: string; separator?: "," | ";" | ""; lastSeparator?: "," | ";" | "" };
}

const CPP: TwoLists = {
  language: "C++",
  path: "tests/topk_test.cpp",
  rows: ['{"topk", "2", "5 1 4", "5 4"}', '{"topk", "1", "3 9", "9"}', '{"topk", "3", "1 2 3", "3 2 1"}', '{"topk", "0", "7", ""}', '{"total", "1 2", "3"}', '{"total", "4 4", "8"}'],
  totals: "static const std::vector<Row> totals = {",
  file: (first, second) =>
    ['#include "topk.h"', "", "static const std::vector<Row> rows = {", ...first.map((r) => `    ${r},`), "};", "", "static const std::vector<Row> totals = {", ...second.map((r) => `    ${r},`), "};", "", "int main() { return run(rows, totals); }", ""].join("\n"),
  options: {},
};

const JAVA: TwoLists = {
  language: "Java",
  path: "src/test/java/tail/TopkTest.java",
  rows: ['Arguments.of("topk", "2", "5 1 4", "5 4")', 'Arguments.of("topk", "1", "3 9", "9")', 'Arguments.of("topk", "3", "1 2 3", "3 2 1")', 'Arguments.of("topk", "0", "7", "")', 'Arguments.of("total", "1 2", "3")', 'Arguments.of("total", "4 4", "8")'],
  totals: "static final List<Arguments> TOTALS = List.of(",
  file: (first, second) =>
    ["package tail;", "", "class TopkTest {", "  static final List<Arguments> ROWS = List.of(", ...first.map((r, i) => `      ${r}${i === first.length - 1 ? "" : ","}`), "  );", "", "  static final List<Arguments> TOTALS = List.of(", ...second.map((r, i) => `      ${r}${i === second.length - 1 ? "" : ","}`), "  );", "}", ""].join("\n"),
  options: { indent: "      ", lastSeparator: "" },
};

const ELIXIR: TwoLists = {
  language: "Elixir",
  path: "test/topk_test.exs",
  rows: ['{"topk", "2", "5 1 4", "5 4"}', '{"topk", "1", "3 9", "9"}', '{"topk", "3", "1 2 3", "3 2 1"}', '{"topk", "0", "7", ""}', '{"total", "1 2", "3"}', '{"total", "4 4", "8"}'],
  totals: "@totals [",
  file: (first, second) =>
    ["defmodule TopkTest do", "  use ExUnit.Case", "", "  @rows [", ...first.map((r) => `    ${r},`), "  ]", "", "  @totals [", ...second.map((r) => `    ${r},`), "  ]", "", "  test \"rows\", do: Rows.run(@rows ++ @totals)", "end", ""].join("\n"),
  options: {},
};

/** R102's delivered layout: every row in the first list, rows 5 and 6 between rows 2 and 3. */
const delivered = (l: TwoLists) => {
  const [r1, r2, r3, r4, r5, r6] = l.rows as [string, string, string, string, string, string];
  return l.file([r1, r2, r5, r6, r3, r4], []);
};
const wanted = (l: TwoLists) => l.file(l.rows.slice(0, 4), l.rows.slice(4));
/** The file with the line that holds `row` taken out: a one-line delete, as T003's edit_file. */
const without = (text: string, row: string) =>
  text
    .split("\n")
    .filter((line) => !line.includes(row))
    .join("\n");

for (const layout of [CPP, JAVA, ELIXIR]) {
  const request = requestOf(layout.path, layout.rows);
  const targets = placeRowTargets(request, { writes: [{ path: layout.path, action: "modify" }] });

  describe(`${layout.language}: R102 tailcut, a held row in the wrong order and list moves in one call (#2955)`, () => {
    test("place_rows move: true puts rows 5 and 6 in the second list, restoring the order and the split", () => {
      const moved = placeRows({ path: layout.path, after: layout.totals, rows: [5, 6], move: true, ...layout.options }, targets, delivered(layout));
      expect(moved).toMatchObject({ moved: true, placed: [5, 6], content: wanted(layout) });
      // The result names the list that now holds them (#2956's placedWhere).
      expect(moved).toMatchObject({ list: { text: layout.totals } });
    });

    test("without move the held rows are refused, and the refusal names the move", () => {
      const refused = placeRows({ path: layout.path, after: layout.totals, rows: [5, 6], ...layout.options }, targets, delivered(layout));
      expect(refused).toEqual({ refusal: expect.stringContaining("call place_rows with move: true") });
    });

    test("the guard keeps the move and puts back a deletion alone", () => {
      const moved = placeRows({ path: layout.path, after: layout.totals, rows: [5, 6], move: true, ...layout.options }, targets, delivered(layout));
      const after = "content" in moved ? moved.content : null;
      expect(rowEditBreaks(request, layout.path, delivered(layout), after)).toBeNull();
      const broken = rowEditBreaks(request, layout.path, wanted(layout), without(wanted(layout), layout.rows[5]!));
      expect(broken).toMatchObject({ path: layout.path, rows: [6] });
    });

    test("move refuses a row the file does not hold, and a line that is one of the moved rows", () => {
      const partial = without(delivered(layout), layout.rows[5]!);
      expect(placeRows({ path: layout.path, after: layout.totals, rows: [5, 6], move: true }, targets, partial)).toEqual({
        refusal: `${layout.path} does not hold row 6 yet, so there is nothing to move. Place it with place_rows without move first.`,
      });
      const line = delivered(layout).split("\n").findIndex((l) => l.includes(layout.rows[4]!)) + 1;
      expect(placeRows({ path: layout.path, line, rows: [5, 6], move: true }, targets, delivered(layout))).toEqual({
        refusal: expect.stringContaining(`line ${line} of ${layout.path} is one of the rows to move`),
      });
    });
  });
}

// Every language with a host row shape (`ROW_FILE_SHAPES`): the guard reads rows through
// `suppliedRows` and `measureFileRows` and never branches on a language, so a swap in one call is
// kept and a deletion alone is put back in each.
describe("ROW_FILE_SHAPES: a move in one call is kept, a deletion alone is put back (#2955)", () => {
  for (const [language, record] of Object.entries(ROW_FILE_SHAPES)) {
    if (isNoRow(record)) continue;
    test(language, () => {
      const { path, reference, rows } = record.example;
      expect(rowOf(ROW_FILE_SHAPES, detectLanguageFromPath(path))).not.toBeNull();
      const file = rowFilePlan(path, rows, { source: "reference", text: reference }).content ?? "";
      expect(file).not.toBe("");
      const request = requestOf(path, rows);
      const targets = placeRowTargets(request, { writes: [{ path, action: "modify" }] });
      const lines = file.split("\n");
      const bare = (text: string) => text.trim().replace(/[,;]$/, "").trimEnd();
      let guarded = 0;
      for (const [index, row] of rows.entries()) {
        const at = lines.findIndex((line) => bare(line) === bare(row));
        if (at < 0) continue;
        // A deletion of the row alone: a break wherever the guard holds the row.
        const broken = rowEditBreaks(request, path, file, lines.filter((_, i) => i !== at).join("\n"));
        if (!broken) continue;
        expect(broken.rows).toEqual([index + 1]);
        guarded++;
        // The same row moved in one call (before the line above it, a swap with the row there
        // when there is one): every row stays in the file, and the guard keeps it.
        const moved = placeRows({ path, line: at - 1, rows: [index + 1], move: true }, targets, file);
        if (!("content" in moved)) throw new Error(moved.refusal);
        expect(moved.moved).toBe(true);
        expect(moved.content).not.toBe(file);
        expect(rowEditBreaks(request, path, file, moved.content)).toBeNull();
      }
      expect(guarded).toBeGreaterThan(0);
    });
  }
});

describe("the put-back answer names the move when one is asked (#2955)", () => {
  const request = requestOf(CPP.path, CPP.rows);
  const broken = rowEditBreaks(request, CPP.path, wanted(CPP), without(wanted(CPP), CPP.rows[5]!));

  test("a deletion in a task that asks for no move keeps the literal advice only", () => {
    expect(broken).not.toBeNull();
    const text = rowEditBreakText(broken!);
    expect(text).toContain("keep the test's literals as they are and change the source");
    expect(text).not.toContain("move: true");
  });

  test("a corrective whose finding asks for the order or the list gets both routes", () => {
    const finding = { title: "Correct topk_test.cpp", description: "F1 (partial): rows 13 to 18 stand between rows 4 and 5, and every row is in rows; restore the request's order and split the rows between rows and totals." };
    expect(asksForMove(finding)).toBe(true);
    expect(asksForMove({ title: "Fix topk", description: "The source returns the wrong count." })).toBe(false);
    expect(asksForMove(null)).toBe(false);
    const text = rowEditBreakText(broken!, asksForMove(finding));
    expect(text).toContain("place_rows with move: true");
    expect(text).toContain("a single multi_edit that removes the rows and inserts them at their new place");
  });

  test("a row still a line of the file is held there, so only a deletion is put back", () => {
    // Row 1 dropped from its place and written after the second list in the same edit: kept.
    const elsewhere = wanted(CPP).replace(`    ${CPP.rows[0]},\n`, "").replace("};\n\nint", `};\n    ${CPP.rows[0]},\n\nint`);
    expect(rowEditBreaks(request, CPP.path, wanted(CPP), elsewhere)).toBeNull();
  });

  test("the tool's description states the move", () => {
    expect(placeRowsDescription(new Map([[CPP.path, CPP.rows]]))).toContain(MOVE_NOTE);
  });
});

const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};
const call = (name: string, input: unknown): LanguageModelV3GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});

/** Route `openai/*` to a scripted model; returns the prompts it was sent. */
function scriptModel(script: (() => LanguageModelV3GenerateResult)[]) {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const seen = { prompts: [] as string[] };
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      seen.prompts.push(JSON.stringify(options.prompt));
      const next = script[index++];
      if (!next) throw new Error("script exhausted");
      return next();
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
  return seen;
}

const T003 = {
  title: "Correct the order and lists of topk_test.cpp",
  description: "F1 (partial): every row is in rows and totals is empty, and rows 5 and 6 stand between rows 2 and 3. Move rows 5 and 6 into totals so each list holds its rows in the request's order.",
};

/** Plans T003 over R102's delivered file and runs it through the real executor and tool guard. */
class MoveExecutor extends FixtureExecutor {
  native: NativeAgentExecutor | null = null;
  constructor(workspace: string) {
    super(workspace);
    mkdirSync(dirname(join(workspace, CPP.path)), { recursive: true });
    writeFileSync(join(workspace, CPP.path), delivered(CPP));
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const markdown = "# Plan\n## Context\nRows.\n## Decisions\nDEC-001: FR-001 takes the rows.\n## Components\ntests\n## Data\nText\n## Verification\nCheck the rows\n## Risks\nNone for fixture";
      const output = {
        schemaVersion: 1,
        markdown,
        taskGraph: {
          schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown),
          tasks: [{ id: "T001", ...T003, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: CPP.path, action: "modify", reason: "the request prescribes its rows" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }],
        },
      };
      return { output, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output !== "implementation") return super.execute(request);
    if (!this.native) throw new Error("native executor missing");
    return this.native.execute({ ...request, profile: { ...request.profile, model: "openai/fixture-model" } });
  }
}

describe("scenario: R102 tailcut 898cd4af filters T003, the corrective that must move held rows (#2955)", () => {
  test("a one-line delete is put back with the move named, place_rows move: true is kept, and the task completes", async () => {
    // The task's required check: each list holds its rows in the request's order.
    const layoutCheck = {
      id: "rows", executable: "bun", cwd: ".", timeoutMs: 10000, required: true, scope: "feature" as const, envNames: [], writes: [],
      args: ["-e", `const t = await Bun.file(${JSON.stringify(CPP.path)}).text(); if (t !== ${JSON.stringify(wanted(CPP))}) process.exit(1);`],
    };
    const policy: RunPolicy = { ...fixturePolicy, checks: [layoutCheck], rowFileWrite: "on" };
    const fixture = workflowFixture({ policy, executor: (root) => new MoveExecutor(root) });
    cleanups.push(fixture.dispose);
    const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, { ...fixture.config, repoMap: false });
    cleanups.push(() => native.dispose());
    fixture.executor.native = native;
    const deleteLine = `    ${CPP.rows[3]},\n`;
    const seen = scriptModel([
      // T003's recorded call: a one-line edit_file that deletes a held row (row 4, which stands in place).
      () => call("edit_file", { path: CPP.path, oldString: deleteLine, newString: "" }),
      () => call("place_rows", { path: CPP.path, after: CPP.totals, rows: [5, 6], move: true }),
      () => call("submit_result", { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: `Moved rows 5 and 6 of ${CPP.path} into totals`, evidenceIds: [], unresolved: [] }),
    ]);
    const prompt = requestOf(CPP.path, CPP.rows);
    const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy });
    let current = await fixture.service.drive(run.runId, new AbortController().signal);
    for (let i = 0; i < 8 && current.status === "waiting"; i++) {
      if (fixture.service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
      await fixture.approve(run.runId);
      current = await fixture.service.drive(run.runId, new AbortController().signal);
    }
    // The delete is put back, and the answer names the one-call move (the task asks for one).
    expect(seen.prompts[1]).toContain("Edit put back: it changed the request's prescribed row of tests/topk_test.cpp that the file held: row 4");
    expect(seen.prompts[1]).toContain("place_rows with move: true");
    // On main: "already holds row 5 (line 6), row 6 (line 7). Place only the rows the file does not hold yet".
    expect(seen.prompts[2]).toContain(`Moved rows 5 to 6 of the request's rows for ${CPP.path}`);
    expect(seen.prompts[2]).toContain(JSON.stringify(CPP.totals));
    expect((await fixture.service.get(run.runId)).status).toBe("completed");
    expect(seen.prompts).toHaveLength(3);
    const store = fixture.service.store;
    expect(readFileSync(join(fixture.root, runRootPath(store, run.runId), CPP.path), "utf8")).toBe(wanted(CPP));
  }, 60000);
});
