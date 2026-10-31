import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { isNoRow } from "../src/core/intelligence/language-records.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import * as placeRowsModule from "../src/core/tools/place-rows.js";
import { PLACE_ROWS_DIR, type PlaceRowsInput, type PlaceRowsRecord, placeRows, placeRowTargets } from "../src/core/tools/place-rows.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { layoutFree } from "../src/core/workflows/acceptance-rows-inline.js";
import { type HostApplyWrite, hostApplyDecision, hostApplyRecords, rowFileTasks } from "../src/core/workflows/host-apply.js";
import * as rowBlockModule from "../src/core/workflows/row-block-drift.js";
import { ROW_FILE_SHAPES, type RowFileInputs, rowArity, rowFilePlan, rowFileRefusal } from "../src/core/workflows/row-file.js";
import { ROW_RESTORE_DIR, type RowRestoreRecord, rowEditBreaks, rowRestorePlan } from "../src/core/workflows/row-restore.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import { runRootPath } from "../src/core/workflows/effects.js";
import { newId } from "../src/core/workflows/store.js";
import { INTEGRITY_DIR } from "../src/core/workflows/test-integrity.js";
import { exportTrace, replayRowBlocks, replayTrace } from "../src/core/workflows/trace.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";

// #2528 (step 2 of #2522): a task whose only content is the rows a request prescribes for a test
// file opened a model session that transcribed them. Bench round 82: those tasks were 5.1M of the
// two initiatives' 18.1M tokens (tinyflate core T006-T009 1.16M, inflate T002-T005 1.75M, deflate
// T003-T006 1.0M, slotprompt core T004-T008 1.18M), and deflate's long hex runs came back
// miscounted (303 bytes of `78` for the row's 300, 238 of `71` for 259). Each row task carried
// `reference: tests/scaffold_test.c`, the file's shape. The host now writes the file from that
// shape and the request's rows (`rowFileWrite: "on"`; shadow by default), and no session opens.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface WriteShape {
  path: string;
  reference: { path: string; text: string };
  /** The request's fenced row block, header first. */
  block: string[];
  /** The file the host writes: the reference's preamble and epilogue around the rows. */
  written: string;
}

const hexRun = (byte: string, count: number) => byte.repeat(count);

// tinyflate (C) deflate: struct rows with long runs of one byte; the scaffold has one row.
const DEFLATE_PATH = "tests/deflate_match_test.c";
const deflateFile = (rows: string[]) =>
  [
    "#include <string.h>",
    '#include "check.h"',
    "",
    "struct row { const char *input_hex; const char *output_hex; };",
    "",
    "static const struct row rows[] = {",
    ...rows.map((r) => `  ${r},`),
    "};",
    "",
    "int main(void) { return check_rows(rows, sizeof rows / sizeof rows[0]); }",
    "",
  ].join("\n");
const DEFLATE_ROWS = ['{ "616263", "4b4c4a0600" }', `{ "${hexRun("78", 300)}", "abaa50120400" }`, `{ "${hexRun("71", 259)}", "2b2c1c050400" }`];
const TINYFLATE: WriteShape = {
  path: DEFLATE_PATH,
  reference: { path: "tests/scaffold_test.c", text: deflateFile(['{ "00", "0300" }']) },
  block: [`DeflateMatchTests in ${DEFLATE_PATH} (3 rows, { input_hex, output_hex })`, ...DEFLATE_ROWS],
  written: deflateFile(DEFLATE_ROWS),
};

// tinyflate (C) inflate: a macro statement per row inside main, a comment between the rows.
const INFLATE_PATH = "tests/inflate_rows_test.c";
const inflateFile = (rows: string[], comment = false) =>
  ['#include "check.h"', "", "int main(void) {", ...rows.flatMap((r, i) => [...(comment && i === 1 ? ["  /* stored block */"] : []), `  ${r};`]), "  return check_done();", "}", ""].join("\n");
const INFLATE_ROWS = ['INFLATE_ROW("4b4c4a0600", "616263")', 'INFLATE_ROW("cb48cdc9c90700", "68656c6c6f")', 'INFLATE_ROW("010000ffff", "")'];
const INFLATE: WriteShape = {
  path: INFLATE_PATH,
  reference: { path: "tests/scaffold_test.c", text: inflateFile(['INFLATE_ROW("0300", "")', 'INFLATE_ROW("0100", "")'], true) },
  block: [`InflateRows in ${INFLATE_PATH} (3 rows, INFLATE_ROW(input_hex, output_hex))`, ...INFLATE_ROWS],
  written: inflateFile(INFLATE_ROWS),
};

// slotprompt (Dart) core text_test: `row(template, values, out)` with `\$` escaping the dollar.
const TEXT_PATH = "test/text_test.dart";
const textFile = (rows: string[]) =>
  ["import 'package:slotprompt/slotprompt.dart';", "import 'package:test/test.dart';", "", "import 'rows.dart';", "", "final rows = [", ...rows.map((r) => `  ${r},`), "];", "", "void main() => runRows(rows, render);", ""].join("\n");
const TEXT_ROWS = [
  "row('Hello {{name}}', {'name': 'Ann'}, 'Hello Ann')",
  "row('Price: \\${{p}} {{currency}}', {'p': '5', 'currency': 'EUR'}, 'Price: \\$5 EUR')",
  "row('{{a}}{{b}}', {'a': 'x', 'b': ''}, 'x')",
];
const SLOTPROMPT: WriteShape = {
  path: TEXT_PATH,
  reference: { path: "test/scaffold_test.dart", text: textFile(["row('', {}, '')"]) },
  block: [`TextTests in ${TEXT_PATH} (3 rows, row(template, values, out))`, ...TEXT_ROWS],
  written: textFile(TEXT_ROWS),
};

// pnmforge (C++, R83) cli T004: nine rows for `tests/cli_test.cpp`, the two usage rows long runs of
// `\n` escapes (1,412 characters) that attempt 1 spent 1.57M on. Five such rows here, braced rows in
// a `std::vector`; the host writes the request's text, so every escape is the file's as given.
const CLI_PATH = "tests/cli_test.cpp";
const cliFile = (rows: string[]) =>
  [
    "#include <gtest/gtest.h>",
    "",
    '#include "cli.h"',
    "",
    "static const std::vector<CliRow> rows = {",
    ...rows.map((r) => `    ${r},`),
    "};",
    "",
    "TEST(CliTest, Rows) { checkRows(rows); }",
    "",
  ].join("\n");
const USAGE = "usage: pnmforge <command> [options]\\n\\ncommands:\\n  info FILE          print the header\\n  invert IN OUT      invert every sample\\n  scale N IN OUT     scale by N\\n";
const CLI_ROWS = [
  '{{"--version"}, 0, "pnmforge 0.1.0\\n", ""}',
  `{{"--help"}, 0, "${USAGE}", ""}`,
  `{{}, 2, "", "${USAGE}"}`,
  '{{"info", "missing.pnm"}, 1, "", "pnmforge: missing.pnm: cannot open\\n"}',
  '{{"scale", "x", "a.pnm", "b.pnm"}, 2, "", "pnmforge: scale: \\"x\\" is not a number\\n"}',
];
const PNMFORGE: WriteShape = {
  path: CLI_PATH,
  reference: { path: "tests/scaffold_test.cpp", text: cliFile(['{{}, 0, "", ""}']) },
  block: [`CliRows in ${CLI_PATH} (5 rows, {args, code, out, err})`, ...CLI_ROWS],
  written: cliFile(CLI_ROWS),
};

// bytemerge (Java, R83) encoding: `Arguments.of(text, ids)` rows in a `Stream.of(`, the last row
// closing the list (`));`). T006 (291k) corrected rows 6 and 8, whose Java escapes differed from
// the request; model T003 delivered `256 \\ n \n` one escape layer off.
const ENCODE_PATH = "src/test/java/bytemerge/EncodeIdsTest.java";
const encodeFile = (rows: string[]) =>
  [
    "package bytemerge;",
    "",
    "class EncodeIdsTest {",
    "  static Stream<Arguments> rows() {",
    "    return Stream.of(",
    ...rows.map((r, i) => `        ${r}${i === rows.length - 1 ? "));" : ","}`),
    "  }",
    "",
    "  @ParameterizedTest",
    '  @MethodSource("rows")',
    "  void encodesIds(String text, String ids) {",
    "    assertEquals(ids, Encoder.encodeIds(text).toString());",
    "  }",
    "}",
    "",
  ].join("\n");
const ENCODE_ROWS = [
  'Arguments.of("hello", "[104, 101, 108, 108, 111]")',
  'Arguments.of("", "[]")',
  'Arguments.of("a\\tb", "[97, 9, 98]")',
  'Arguments.of("\\"q\\"", "[34, 113, 34]")',
  'Arguments.of("\\u00e9", "[195, 169]")',
  'Arguments.of("256 \\\\ n \\n", "[50, 53, 54, 32, 92, 32, 110, 32, 10]")',
  'Arguments.of("\\0", "[0]")',
  'Arguments.of("C:\\\\tmp\\\\new", "[67, 58, 92, 116, 109, 112, 92, 110, 101, 119]")',
];
const BYTEMERGE: WriteShape = {
  path: ENCODE_PATH,
  reference: { path: "src/test/java/bytemerge/ScaffoldTest.java", text: encodeFile(['Arguments.of("x", "[120]")', 'Arguments.of("y", "[121]")']) },
  block: [`EncodeIdsTest in ${ENCODE_PATH} (8 rows, Arguments.of(text, ids))`, ...ENCODE_ROWS],
  written: encodeFile(ENCODE_ROWS),
};

const rowsOf = (shape: WriteShape) => shape.block.slice(1);
const plan = (shape: WriteShape, text = shape.reference.text, source: "file" | "reference" = "reference") =>
  rowFilePlan(shape.path, rowsOf(shape), { source, text });
const OK: Omit<RowFileInputs, "count"> = { language: true, shape: "reference", runs: 1, oneLine: true, sameHead: true, arity: true, separated: true };

describe("rowFilePlan: the host writes a prescribed row file from its shape (#2528)", () => {
  for (const [name, shape] of Object.entries({ "c deflate": TINYFLATE, "c macro": INFLATE, "dart slotprompt": SLOTPROMPT, "cpp pnmforge": PNMFORGE, "java bytemerge": BYTEMERGE }))
    test(`${name}: the reference's preamble and epilogue around one prescribed row per line`, () => {
      const { inputs, content } = plan(shape);
      expect(inputs).toEqual({ count: rowsOf(shape).length, ...OK });
      expect(content).toBe(shape.written);
      expect(rowFileRefusal(shape.path, inputs)).toBeNull();
      // Every row as the request gives it, on its own line: the long runs keep their 300 and 259 bytes.
      // The last row of a Java `Stream.of(` keeps the list's close (`));`).
      for (const row of rowsOf(shape)) expect(content?.split("\n").some((l) => l.trim().startsWith(row) && /^[)\]}]*[,;]?$/.test(l.trim().slice(row.length)))).toBe(true);
    });

  test("the file in the task's base is its own shape: every row is written as the request gives it", () => {
    const drifted = deflateFile(['{ "616263", "4b4c4a0600" }', `{ "${hexRun("78", 303)}", "abaa50120400" }`, `{ "${hexRun("71", 238)}", "2b2c1c050400" }`]);
    const { inputs, content } = plan(TINYFLATE, drifted, "file");
    expect(inputs.shape).toBe("file");
    expect(content).toBe(TINYFLATE.written);
  });

  test("a CRLF shape gives CRLF rows", () => {
    const { content } = plan(SLOTPROMPT, SLOTPROMPT.reference.text.replaceAll("\n", "\r\n"));
    expect(content).toBe(SLOTPROMPT.written.replaceAll("\n", "\r\n"));
  });

  test("the last row keeps the shape's last separator (an Elixir list)", () => {
    const shape = ["  rows([", '    row(["a"], "", 0, "", ""),', '    row(["b"], "", 0, "", "")', "  ])", ""].join("\n");
    const rows = ['row(["eval"], "1", 0, "1", "")', 'row(["eval"], "2", 0, "2", "")', 'row(["eval"], "3", 0, "3", "")'];
    expect(rowFilePlan("test/eval_rows_test.exs", rows, { source: "reference", text: shape }).content).toBe(
      ["  rows([", ...rows.slice(0, 2).map((r) => `    ${r},`), `    ${rows[2]}`, "  ])", ""].join("\n"),
    );
  });

  test("C++: gtest `Values(` rows keep the call's close on the last row; Catch2 table rows", () => {
    const values = (rows: string[]) =>
      ["INSTANTIATE_TEST_SUITE_P(", "    Rows, CliTest,", "    ::testing::Values(", ...rows.map((r, i) => `        ${r}${i === rows.length - 1 ? "));" : ","}`), ""].join("\n");
    const typed = ['CliRow{{"--version"}, 0, "pnmforge 0.1.0\\n", ""}', `CliRow{{"--help"}, 0, "${USAGE}", ""}`, `CliRow{{}, 2, "", "${USAGE}"}`];
    expect(rowFilePlan("tests/cli_test.cpp", typed, { source: "reference", text: values(['CliRow{{"a"}, 0, "", ""}', 'CliRow{{"b"}, 0, "", ""}']) }).content).toBe(values(typed));
    const table = (rows: string[]) =>
      ['TEST_CASE("header rows") {', "  auto [input, width, height] = GENERATE(table<std::string, int, int>({", ...rows.map((r) => `      ${r},`), "  }));", "  CHECK(parse_header(input) == Size{width, height});", "}", ""].join("\n");
    const headers = ['{"P1\\n1 1\\n0\\n", 1, 1}', '{"P2\\n2 1\\n255\\n0 0\\n", 2, 1}', '{"P5\\n# c\\n3 2\\n255\\n", 3, 2}'];
    expect(rowFilePlan("tests/header_test.cpp", headers, { source: "reference", text: table(['{"", 0, 0}']) }).content).toBe(table(headers));
  });

  test("Java: a `Stream.of(` with one row gives no separator between rows, its `));` closes the list", () => {
    const one = BYTEMERGE.reference.text.replace('        Arguments.of("x", "[120]"),\n', "");
    const { inputs } = rowFilePlan(ENCODE_PATH, rowsOf(BYTEMERGE), { source: "reference", text: one });
    expect(rowFileRefusal(ENCODE_PATH, inputs)).toContain("no separator");
    // One prescribed row takes the one row's place, close and all.
    expect(rowFilePlan(ENCODE_PATH, rowsOf(BYTEMERGE).slice(0, 1), { source: "reference", text: one }).content).toBe(encodeFile(rowsOf(BYTEMERGE).slice(0, 1)));
  });

  test("a shape the host cannot read declines with its reason", () => {
    const refusal = (text: string | null, rows = rowsOf(TINYFLATE), path = TINYFLATE.path) =>
      rowFileRefusal(path, rowFilePlan(path, rows, text === null ? null : { source: "reference", text }).inputs);
    expect(refusal(null)).toContain("no shape");
    // Two runs of rows in the notation: which one the rows replace is not known.
    expect(refusal(`${TINYFLATE.reference.text}static const struct row more[] = {\n  { "01", "02" },\n};\n`)).toContain("2 runs");
    expect(refusal('#include "check.h"\nint main(void) { return 0; }\n')).toContain("0 runs");
    // The scaffold's rows have three fields.
    expect(refusal(deflateFile(['{ "00", "0300", 0 }']))).toContain("argument count");
    // A row spread over lines.
    expect(refusal(deflateFile(['{ "00",\n    "0300" }']))).toContain("spreads a row");
    // One row with no separator: the separator between rows is not known.
    expect(refusal(['  rows([', '    row(["a"], "", 0, "", "")', "  ])", ""].join("\n"), ['row(["b"], "", 0, "", "")', 'row(["c"], "", 0, "", "")'], "test/eval_rows_test.exs")).toContain("no separator");
    // Rows of two heads.
    expect(refusal(TINYFLATE.reference.text, ['{ "a", "b" }', 'ROW("a", "b")'])).toContain("one row head");
    // A language without a row yet (#2553).
    expect(refusal("const ROWS: &[(&str, &str)] = &[\n    (\"a\", \"b\"),\n];\n", ['("c", "d")'], "tests/rows.rs")).toContain("language");
  });

  test("rowArity counts a row's top-level arguments, strings and nested brackets skipped", () => {
    expect(rowArity('{ "a,b", "c" }')).toBe(2);
    expect(rowArity("row('Price: \\${{p}}', {'p': '5', 'q': 1}, 'x'),")).toBe(3);
    expect(rowArity('INFLATE_ROW("4b", "61");')).toBe(2);
    expect(rowArity('{"a", "b",}')).toBe(2);
    expect(rowArity("{ }")).toBe(0);
    expect(rowArity('{ "a",')).toBeNull();
  });

  test("the host apply decision writes a rows write it can read, and declines one it cannot", () => {
    const write = (rows: RowFileInputs): HostApplyWrite => ({ path: DEFLATE_PATH, action: "create", files: 0, diffs: 0, whole: false, exists: false, applies: null, rows });
    expect(hostApplyDecision([write({ count: 3, ...OK })])).toEqual({ wouldApply: true, reason: null });
    expect(hostApplyDecision([write({ count: 3, ...OK, runs: 2 })]).reason).toContain("2 runs");
    // A second write with nothing the request gives keeps the session.
    expect(hostApplyDecision([write({ count: 3, ...OK }), { ...write({ count: 3, ...OK }), path: "src/deflate.c", rows: undefined }]).reason).toContain("no verbatim block for src/deflate.c");
  });

  test("rowFileTasks names the planned tasks whose every write is a prescribed row file", () => {
    const request = ["```text", ...TINYFLATE.block, "```"].join("\n");
    const graph = { tasks: [
      { id: "T001", origin: "planned", writes: [{ path: "src/deflate.c", action: "create" }] },
      { id: "T002", origin: "planned", writes: [{ path: DEFLATE_PATH, action: "create" }] },
      { id: "T003", origin: "planned", writes: [{ path: DEFLATE_PATH, action: "modify" }, { path: "src/deflate.c", action: "modify" }] },
    ] } as unknown as Pick<TaskGraph, "tasks">;
    expect(rowFileTasks(request, graph)).toEqual(["T002"]);
  });
});

// Each language row's written example is a fixed point of the language's default formatter: the
// host keeps the shape's layout, so a formatted shape gives a file the formatter leaves as written.
const has = (program: string, args: string[] = ["--version"]) => spawnSync(program, args).status === 0;
const FORMATTERS: Record<string, { program: string; args: (file: string) => string[]; probe?: string[] } | undefined> = {
  c: { program: "clang-format", args: (f) => ["-i", "-style=LLVM", f] },
  go: { program: "gofmt", args: (f) => ["-w", f], probe: ["-l", "."] },
  python: { program: "black", args: (f) => ["-q", f] },
  elixir: { program: "mix", args: (f) => ["format", f] },
  typescript: { program: "prettier", args: (f) => ["--write", "--log-level", "silent", f] },
  javascript: { program: "prettier", args: (f) => ["--write", "--log-level", "silent", f] },
  dart: { program: "dart", args: (f) => ["format", f] },
  cpp: { program: "clang-format", args: (f) => ["-i", "-style=LLVM", f] },
  java: { program: "google-java-format", args: (f) => ["-i", f] },
};

describe("the written row file is a fixed point of its language's formatter (#2528)", () => {
  for (const [language, row] of Object.entries(ROW_FILE_SHAPES)) {
    if (isNoRow(row)) continue;
    const formatter = FORMATTERS[language];
    test.skipIf(!formatter || !has(formatter.program, formatter.probe))(`${language}: ${formatter?.program ?? "no formatter"}`, () => {
      const { path, reference, rows } = row.example;
      const { content } = rowFilePlan(path, rows, { source: "reference", text: reference });
      expect(content).not.toBeNull();
      const dir = mkdtempSync(join(tmpdir(), "baked-row-file-"));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      const file = join(dir, path.slice(path.lastIndexOf("/") + 1));
      writeFileSync(file, content ?? "");
      const run = spawnSync(formatter!.program, formatter!.args(file), { cwd: dir, encoding: "utf8" });
      expect(run.status).toBe(0);
      const formatted = readFileSync(file, "utf8");
      expect(layoutFree(formatted, path)).toBe(layoutFree(content ?? "", path));
      expect(formatted).toBe(content ?? "");
    });
  }
  // The C++ row forms besides the example's `std::vector`: a gtest `Values(` call (its last row
  // closes the call) and a Catch2 `GENERATE(table<...>({...}))` list.
  test.skipIf(!has("clang-format"))("clang-format leaves the C++ gtest Values and Catch2 table forms as written", () => {
    const gtest = (rows: string[]) =>
      ["#include <gtest/gtest.h>", "", '#include "cli.h"', "", "class CliTest : public ::testing::TestWithParam<CliRow> {};", "", "TEST_P(CliTest, Runs) { EXPECT_EQ(run(GetParam().args), GetParam().result()); }", "", "INSTANTIATE_TEST_SUITE_P(", "    Rows, CliTest,", "    ::testing::Values(", ...rows.map((r, i) => `        ${r}${i === rows.length - 1 ? "));" : ","}`), ""].join("\n");
    const catch2 = (rows: string[]) =>
      ["#include <catch2/catch_test_macros.hpp>", "#include <catch2/generators/catch_generators.hpp>", "", '#include "pnm.h"', "", 'TEST_CASE("header rows") {', "  auto [input, width, height] = GENERATE(table<std::string, int, int>({", ...rows.map((r) => `      ${r},`), "  }));", "  CHECK(parse_header(input) == Size{width, height});", "}", ""].join("\n");
    const cases = [
      { path: "tests/cli_test.cpp", file: gtest, shape: ['CliRow{{"--version"}, 0, "pnmforge 0.1.0\\n", ""}', 'CliRow{{"--help"}, 0, "usage: pnmforge <command> [options]\\n", ""}'], rows: ['CliRow{{"info", "missing.pnm"}, 1, "", "pnmforge: cannot open\\n"}', 'CliRow{{}, 2, "", "usage: pnmforge <command> [options]\\n"}', 'CliRow{{"scale", "x", "a.pnm", "b.pnm"}, 2, "", "pnmforge: bad N\\n"}'] },
      { path: "tests/header_test.cpp", file: catch2, shape: ['{"P1\\n1 1\\n0\\n", 1, 1}'], rows: ['{"P2\\n2 1\\n255\\n0 0\\n", 2, 1}', '{"P5\\n# comment\\n3 2\\n255\\n", 3, 2}'] },
    ];
    const dir = mkdtempSync(join(tmpdir(), "baked-row-file-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const { path, file, shape, rows } of cases) {
      const reference = file(shape);
      const target = join(dir, path.slice(path.lastIndexOf("/") + 1));
      // The shape is a fixed point itself, and so is the file written from it.
      for (const text of [reference, rowFilePlan(path, rows, { source: "reference", text: reference }).content]) {
        expect(text).toBe(text === reference ? reference : file(rows));
        writeFileSync(target, text ?? "");
        expect(spawnSync("clang-format", ["-i", "-style=LLVM", target]).status).toBe(0);
        expect(readFileSync(target, "utf8")).toBe(text ?? "");
      }
    }
  });
  test("the ruff formatter leaves the Python example as written", () => {
    if (!has("ruff")) return;
    const row = ROW_FILE_SHAPES.python;
    if (isNoRow(row)) throw new Error("python has a row");
    const { content } = rowFilePlan(row.example.path, row.example.rows, { source: "reference", text: row.example.reference });
    const dir = mkdtempSync(join(tmpdir(), "baked-row-file-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "test_rows.py"), content ?? "");
    expect(spawnSync("ruff", ["format", "--isolated", "--check", "test_rows.py"], { cwd: dir }).status).toBe(0);
  });
});

/** T001 writes the source; T002 writes the row file, with the scaffold as its reference. */
class RowFileExecutor extends FixtureExecutor {
  sessions: string[] = [];
  constructor(
    private workspace: string,
    private shape: WriteShape,
  ) {
    super(workspace);
    mkdirSync(dirname(join(workspace, shape.reference.path)), { recursive: true });
    writeFileSync(join(workspace, shape.reference.path), shape.reference.text);
  }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const graph = (result.output as { taskGraph: TaskGraph }).taskGraph;
      const first = graph.tasks[0]!;
      graph.tasks.push({ ...first, id: "T002", title: "Row file", dependsOn: ["T001"], writes: [{ path: this.shape.path, action: "create" }], reference: this.shape.reference.path, checkIds: [] });
    }
    if (request.profile.output === "implementation") {
      this.sessions.push(request.task?.id ?? "");
      // A session transcribes the rows as given.
      if (request.task?.id === "T002") {
        mkdirSync(dirname(join(this.workspace, this.shape.path)), { recursive: true });
        writeFileSync(join(this.workspace, this.shape.path), this.shape.written);
      }
    }
    return result;
  }
}

// The rows check: fails while the file does not hold every prescribed row as given.
const rowsCheck = (shape: WriteShape) => ({
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

const requestOf = (shape: WriteShape) =>
  ["Create ready value.", "", "The prescribed rows, one test each:", "", "```text", ...shape.block, "```", ""].join("\n");

async function deliver(shape: WriteShape, extra: Partial<RunPolicy>) {
  const policy: RunPolicy = { ...fixturePolicy, checks: [...fixturePolicy.checks, rowsCheck(shape)], ...extra };
  let executor: RowFileExecutor | undefined;
  const fixture = workflowFixture({
    policy,
    executor: (root) => {
      executor = new RowFileExecutor(root, shape);
      return executor;
    },
  });
  cleanups.push(fixture.dispose);
  const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: requestOf(shape), ownerLabel: "test", policy });
  let current = await fixture.service.drive(run.runId, new AbortController().signal);
  for (let i = 0; i < 8 && current.status === "waiting"; i++) {
    if (fixture.service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
    await fixture.approve(run.runId);
    current = await fixture.service.drive(run.runId, new AbortController().signal);
  }
  const store = fixture.service.store;
  const integrity = store.latestArtifact(run.runId, `${INTEGRITY_DIR}tasks/T002.json`);
  const tree = join(fixture.root, runRootPath(store, run.runId));
  return {
    final: await fixture.service.get(run.runId),
    file: readFileSync(join(tree, shape.path), "utf8"),
    sessions: executor?.sessions ?? [],
    record: hostApplyRecords(store, run.runId).find((r) => r.taskId === "T002"),
    skipped: integrity ? (JSON.parse(store.readArtifact(run.runId, integrity.id)) as { skipped?: string }).skipped : undefined,
    fixture,
    runId: run.runId,
  };
}

describe("scenario: R82, a row-file task the host writes without a session (#2528)", () => {
  for (const [language, shape] of Object.entries({ c: TINYFLATE, "c-macro": INFLATE, dart: SLOTPROMPT, cpp: PNMFORGE, java: BYTEMERGE }))
    test(`${language}: with rowFileWrite on the host writes ${shape.path} from the reference and no session opens for it`, async () => {
      const { final, file, sessions, record, skipped } = await deliver(shape, { rowFileWrite: "on" });
      expect(final.status).toBe("completed");
      // T001 only: no session transcribed the rows.
      expect(sessions).toEqual(["T001"]);
      expect(file).toBe(shape.written);
      expect(record).toMatchObject({ mode: "on", wouldApply: true, applied: true });
      expect(record?.writes[0]?.rows).toEqual({ count: rowsOf(shape).length, ...OK });
      expect(skipped).toBe("host-written");
    }, 120000);

  test("c: shadow by default, the host records the write it would make and a session writes the file", async () => {
    const { final, sessions, record, file } = await deliver(TINYFLATE, {});
    expect(final.status).toBe("completed");
    expect(sessions).toEqual(["T001", "T002"]);
    expect(record).toMatchObject({ mode: "shadow", wouldApply: true, reason: null });
    expect(record?.applied).toBeUndefined();
    expect(file).toBe(TINYFLATE.written);
  }, 120000);

  test("c: hostApply on alone does not write a row file", async () => {
    const { sessions, record } = await deliver(TINYFLATE, { hostApply: "on" });
    expect(sessions).toEqual(["T001", "T002"]);
    expect(record).toMatchObject({ mode: "shadow", wouldApply: true });
  }, 120000);

  test("dart: a reference the host cannot read keeps the session, with the reason", async () => {
    const twoRuns = { ...SLOTPROMPT, reference: { ...SLOTPROMPT.reference, text: `${SLOTPROMPT.reference.text}final more = [\n  row('a', {}, 'a'),\n];\n` } };
    const { sessions, record, final } = await deliver(twoRuns, { rowFileWrite: "on" });
    expect(final.status).toBe("completed");
    expect(sessions).toEqual(["T001", "T002"]);
    expect(record).toMatchObject({ mode: "on", wouldApply: false, applied: false });
    expect(record?.reason).toContain("2 runs of rows");
  }, 120000);

  test("the replay decides the recorded rows write again; a rule without the rows kind is a new decision", async () => {
    const { fixture, runId } = await deliver(TINYFLATE, { rowFileWrite: "on" });
    const dir = mkdtempSync(join(tmpdir(), "row-file-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(fixture.root, out);
    const replayed = replayTrace(out).runs.find((r) => r.runId === runId);
    expect(replayed?.hostApply.map((b) => [b.taskId, b.recorded, b.replayed])).toEqual([["T002", true, true]]);
    expect(replayed?.newApplyDecisions).toBe(0);
    // The decision before #2528: a write the request gives no verbatim block of keeps the session.
    const before = replayTrace(out, { hostApplyRule: (writes) => hostApplyDecision(writes.map(({ rows: _, ...w }) => w)) }).runs.find((r) => r.runId === runId);
    expect(before?.newApplyDecisions).toBe(1);
  }, 120000);
});

// #2564: a row file whose language has no `ROW_FILE_SHAPES` row (C++ and Java, #2553), or whose
// shape the host cannot read, still opened a session that retyped the rows through its edit tool.
// Bench round 83: pnmforge (C++) `cli` T004 spent 2.74M tokens on nine rows, 1.57M of them on the
// two usage rows through four escape layers; bytemerge (Java) `model` T003 failed `verify-written`
// on a row one escape layer off. With `rowFileWrite: "on"` the session gets `place_rows`, which
// inserts the request's rows from `suppliedRows` after a line of the file, and never types a row.

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

/** Route `openai/*` to a scripted model; returns the prompts and tool names it was sent. */
function scriptModel(script: (() => LanguageModelV3GenerateResult)[]) {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const seen = { prompts: [] as string[], tools: [] as string[][] };
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      seen.prompts.push(JSON.stringify(options.prompt));
      seen.tools.push((options.tools ?? []).map((t) => t.name));
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

interface PlaceShape {
  path: string;
  /** The file in the task's base: everything but the rows. */
  scaffold: string;
  /** The line of the scaffold the rows follow. */
  line: number;
  /** The request's fenced row block, header first. */
  block: string[];
  /** What the session passes besides path, line and rows. */
  options: Record<string, string>;
  /** The file once the rows are placed. */
  written: string;
  formatter?: { program: string; args: (file: string) => string[] };
}

// pnmforge (C++) cli: the usage rows carry `\n` escapes in the request's C++ notation.
const PLACE_CLI_PATH = "tests/cli_test.cpp";
const placeCliFile = (rows: string[]) =>
  ['#include "check.h"', "", "static const Row rows[] = {", ...rows.map((r) => `    ${r},`), "};", "", "int main() { return run_rows(rows); }", ""].join("\n");
const PLACE_CLI_ROWS = [
  '{"--help", 0, "usage: pnmforge [--invert] [--scale N] FILE\\n"}',
  '{"--version", 0, "pnmforge 1.0\\n"}',
  '{"--scale", 2, "pnmforge: --scale needs a value\\n"}',
];
const PLACE_PNMFORGE: PlaceShape = {
  path: PLACE_CLI_PATH,
  scaffold: placeCliFile([]),
  line: 3,
  block: [`CliTests in ${PLACE_CLI_PATH} (3 rows, { args, code, out })`, ...PLACE_CLI_ROWS],
  options: {},
  written: placeCliFile(PLACE_CLI_ROWS),
  formatter: { program: "clang-format", args: (f) => ["-i", "-style=LLVM", f] },
};

// bytemerge (Java) encoding: `List.of(...)` takes no comma after its last row.
const PLACE_ENCODE_PATH = "src/test/java/bytemerge/EncodeIdsTest.java";
const placeEncodeFile = (rows: string[]) =>
  [
    "package bytemerge;",
    "",
    "import java.util.List;",
    "",
    "class EncodeIdsTest {",
    "  record Row(String text, int[] ids) {}",
    "",
    "  static final List<Row> ROWS =",
    "      List.of(",
    ...rows.map((r, i) => `          ${r}${i === rows.length - 1 ? "" : ","}`),
    "      );",
    "}",
    "",
  ].join("\n");
const PLACE_ENCODE_ROWS = [
  'new Row("ab", new int[] {97, 98})',
  'new Row("a\\nb", new int[] {97, 10, 98})',
  'new Row("256 \\\\ n", new int[] {256, 32, 92, 32, 110})',
];
const PLACE_BYTEMERGE: PlaceShape = {
  path: PLACE_ENCODE_PATH,
  scaffold: placeEncodeFile([]),
  line: 9,
  block: [`EncodeIdsTest in ${PLACE_ENCODE_PATH} (3 rows, new Row(text, ids))`, ...PLACE_ENCODE_ROWS],
  options: { indent: "          ", lastSeparator: "" },
  written: placeEncodeFile(PLACE_ENCODE_ROWS),
};

/** Plans one task that places the rows in the scaffold and runs it through the real executor. */
class PlaceRowsExecutor extends FixtureExecutor {
  native: NativeAgentExecutor | null = null;
  constructor(
    workspace: string,
    private shape: PlaceShape,
  ) {
    super(workspace);
    mkdirSync(dirname(join(workspace, shape.path)), { recursive: true });
    writeFileSync(join(workspace, shape.path), shape.scaffold);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const markdown = "# Plan\n## Context\nRows.\n## Decisions\nDEC-001: FR-001 takes the rows.\n## Components\ntests\n## Data\nText\n## Verification\nCheck the rows\n## Risks\nNone for fixture";
      const output = {
        schemaVersion: 1,
        markdown,
        taskGraph: {
          schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown),
          tasks: [{ id: "T001", title: "Row file", description: `Place the prescribed rows in ${this.shape.path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: this.shape.path, action: "modify", reason: "the request prescribes its rows" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }],
        },
      };
      return { output, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output !== "implementation") return super.execute(request);
    if (!this.native) throw new Error("native executor missing");
    return this.native.execute({ ...request, profile: { ...request.profile, model: "openai/fixture-model" } });
  }
}

const placeRequest = (shape: PlaceShape) =>
  ["Place the prescribed rows.", "", "The prescribed rows, one test each:", "", "```text", ...shape.block, "```", ""].join("\n");
const placeAll = (shape: PlaceShape) => () => call("place_rows", { path: shape.path, line: shape.line, rows: [1, shape.block.length - 1], ...shape.options });
const submitRows = (shape: PlaceShape) => () =>
  call("submit_result", { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: `Placed the rows of ${shape.path}`, evidenceIds: [], unresolved: [] });

async function placeScenario(shape: PlaceShape, extra: Partial<RunPolicy>, script: (() => LanguageModelV3GenerateResult)[], checks?: RunPolicy["checks"]) {
  const asShape = { path: shape.path, block: shape.block } as WriteShape;
  const policy: RunPolicy = { ...fixturePolicy, checks: checks ?? [rowsCheck(asShape)], ...extra };
  const fixture = workflowFixture({ policy, executor: (root) => new PlaceRowsExecutor(root, shape) });
  cleanups.push(fixture.dispose);
  const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, { ...fixture.config, repoMap: false });
  cleanups.push(() => native.dispose());
  fixture.executor.native = native;
  const seen = scriptModel(script);
  const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: placeRequest(shape), ownerLabel: "test", policy });
  let current = await fixture.service.drive(run.runId, new AbortController().signal);
  for (let i = 0; i < 8 && current.status === "waiting"; i++) {
    if (fixture.service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
    await fixture.approve(run.runId);
    current = await fixture.service.drive(run.runId, new AbortController().signal);
  }
  const store = fixture.service.store;
  const tree = join(fixture.root, runRootPath(store, run.runId));
  const record = store.latestArtifact(run.runId, `${PLACE_ROWS_DIR}T001.json`);
  return {
    final: await fixture.service.get(run.runId),
    file: readFileSync(join(tree, shape.path), "utf8"),
    seen,
    record: record ? (JSON.parse(store.readArtifact(run.runId, record.id)) as PlaceRowsRecord) : undefined,
    rowBlocks: replayRowBlocks(store, run.runId).filter((b) => b.path === shape.path),
    restores: store
      .artifacts(run.runId)
      .filter((a) => a.logical_path.startsWith(ROW_RESTORE_DIR))
      .map((a) => JSON.parse(store.readArtifact(run.runId, a.id)) as RowRestoreRecord),
  };
}

describe("scenario: R83, a session places the prescribed rows with place_rows and never types one (#2564)", () => {
  for (const [language, shape] of Object.entries({ cpp: PLACE_PNMFORGE, java: PLACE_BYTEMERGE }))
    test(`${language}: with rowFileWrite on the session gets place_rows and the file holds the request's rows as written`, async () => {
      const { final, file, seen, record, rowBlocks } = await placeScenario(shape, { rowFileWrite: "on" }, [placeAll(shape), submitRows(shape)]);
      expect(seen.tools[0]).toContain("place_rows");
      // The brief says the rows are placed, never typed.
      expect(seen.prompts[0]).toContain("You must place them with place_rows and never type a row");
      expect(seen.prompts[1]).toContain(`Placed rows 1 to 3 of the request's rows for ${shape.path} at lines ${shape.line + 1} to ${shape.line + 3}`);
      expect(final.status).toBe("completed");
      // One model call per scripted step: no edit_file, no correction.
      expect(seen.prompts).toHaveLength(2);
      expect(file).toBe(shape.written);
      expect(record).toMatchObject({ mode: "on", offered: true, files: [{ path: shape.path, rows: 3 }] });
      // The row-block comparison finds nothing to repair: no drift, no added, duplicated or moved row.
      expect(rowBlocks.length).toBeGreaterThan(0);
      for (const boundary of rowBlocks) {
        expect(boundary.recorded).toEqual([]);
        expect(boundary.moves?.recorded ?? { added: [], duplicated: [], reordered: [] }).toEqual({ added: [], duplicated: [], reordered: [] });
      }
      // The placed file is a fixed point of the language's formatter.
      const formatter = shape.formatter;
      if (formatter && has(formatter.program)) {
        const dir = mkdtempSync(join(tmpdir(), "baked-place-rows-"));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const target = join(dir, shape.path.slice(shape.path.lastIndexOf("/") + 1));
        writeFileSync(target, file);
        expect(spawnSync(formatter.program, formatter.args(target), { cwd: dir }).status).toBe(0);
        expect(readFileSync(target, "utf8")).toBe(file);
      }
    });

  test("cpp: a row the request does not hold and a path that is not the row file are refused with the change to make", async () => {
    const { final, file, seen } = await placeScenario(PLACE_PNMFORGE, { rowFileWrite: "on" }, [
      () => call("place_rows", { path: PLACE_CLI_PATH, line: 3, rows: [1, 9] }),
      () => call("place_rows", { path: "src/cli.cpp", line: 1, rows: [1, 3] }),
      () => call("place_rows", { path: PLACE_CLI_PATH, line: 3, rows: [1, 2] }),
      // Row 2 is in the file: placing it again is refused, naming its line.
      () => call("place_rows", { path: PLACE_CLI_PATH, line: 5, rows: [2, 3] }),
      () => call("place_rows", { path: PLACE_CLI_PATH, line: 5, rows: [3] }),
      submitRows(PLACE_PNMFORGE),
    ]);
    expect(seen.prompts[1]).toContain(`The request prescribes rows 1 to 3 for ${PLACE_CLI_PATH}; row 9 is not one of them. Call place_rows with rows [first, last] between 1 and 3.`);
    expect(seen.prompts[2]).toContain(`src/cli.cpp is not a file this task's prescribed rows go in; place_rows writes the request's rows only into ${PLACE_CLI_PATH}. Change src/cli.cpp with edit_file.`);
    expect(seen.prompts[4]).toContain(`${PLACE_CLI_PATH} already holds row 2 (line 5).`);
    expect(final.status).toBe("completed");
    expect(file).toBe(PLACE_PNMFORGE.written);
  });

  test("java: shadow by default, the tool is not offered and place-rows records what would have been", async () => {
    const typed = PLACE_ENCODE_ROWS.map((r, i) => `          ${r}${i === PLACE_ENCODE_ROWS.length - 1 ? "" : ","}`).join("\n");
    const { final, file, seen, record } = await placeScenario(PLACE_BYTEMERGE, {}, [
      () => call("edit_file", { path: PLACE_ENCODE_PATH, oldString: "      List.of(\n", newString: `      List.of(\n${typed}\n` }),
      submitRows(PLACE_BYTEMERGE),
    ]);
    expect(seen.tools[0]).not.toContain("place_rows");
    expect(seen.prompts[0]).not.toContain("place_rows");
    expect(record).toEqual({ schemaVersion: 1, taskId: "T001", mode: "shadow", offered: false, files: [{ path: PLACE_ENCODE_PATH, rows: 3, shaped: expect.any(Boolean) }] });
    expect(final.status).toBe("completed");
    expect(file).toBe(PLACE_BYTEMERGE.written);
  });
});

// #2585: R84 sseknit (Rust) 9e40f4b8 T008. Under `rowFileWrite: "on"` a row-file task's first
// session runs on the single-writer path in the run root (the host tries its no-session write
// first, #2528) and places the rows there; its retry is no longer pending, so with two writers it
// runs in a batch worker whose worktree base already holds those rows. The worker counted only
// its own manifest and journal, saw no change and refused the retry's result: "reported
// implemented but changed none of its files". The task's earlier writes still in place count on
// every path (`taskEditsInPlace`), whatever tool made them.
const PLACE_PARSE_PATH = "tests/parse_rows.rs";
const placeParseFile = (rows: string[]) =>
  ["use sseknit::parse;", "", "struct Row {", "    input: &'static str,", "    events: &'static [&'static str],", "}", "", "const ROWS: &[Row] = &[", ...rows.map((r) => `    ${r},`), "];", "", "#[test]", "fn rows() {", "    for r in ROWS {", "        assert_eq!(parse(r.input), r.events);", "    }", "}", ""].join("\n");
const PLACE_PARSE_ROWS = ['Row { input: "data: a\\n\\n", events: &["a"] }', 'Row { input: ": c\\n\\n", events: &[] }', 'Row { input: "data: x\\ndata: y\\n\\n", events: &["x\\ny"] }'];
const PLACE_SSEKNIT: PlaceShape = {
  path: PLACE_PARSE_PATH,
  scaffold: placeParseFile([]),
  line: 8,
  block: [`ParseRows in ${PLACE_PARSE_PATH} (3 rows, Row { input, events })`, ...PLACE_PARSE_ROWS],
  options: {},
  written: placeParseFile(PLACE_PARSE_ROWS),
};

/** The place_rows executor in a Git repository, so the run can cut task worktrees. */
class WorktreePlaceRowsExecutor extends PlaceRowsExecutor {
  constructor(workspace: string, shape: PlaceShape) {
    super(workspace, shape);
    writeFileSync(join(workspace, ".gitignore"), ".baked/\n");
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "Test User"], ["config", "user.email", "test@example.test"], ["config", "commit.gpgsign", "false"], ["config", "core.autocrlf", "false"], ["add", "."], ["commit", "-q", "-m", "Initial"]]) {
      const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    }
  }
}

describe("scenario: R84, a retry in a batch worker counts the rows its first session placed (#2585)", () => {
  test("rust: the first session places the rows and ends unfinished; the retry only submits, and the task completes", async () => {
    const shape = PLACE_SSEKNIT;
    const policy: RunPolicy = { ...fixturePolicy, checks: [rowsCheck({ path: shape.path, block: shape.block } as WriteShape)], rowFileWrite: "on", clarification: "assume" };
    const fixture = workflowFixture({ policy, executor: (root) => new WorktreePlaceRowsExecutor(root, shape) });
    cleanups.push(fixture.dispose);
    const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, { ...fixture.config, repoMap: false });
    cleanups.push(() => native.dispose());
    fixture.executor.native = native;
    const seen = scriptModel([
      placeAll(shape),
      // Unfinished: under clarification assume the host restarts the task.
      () => call("submit_result", { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Placed the rows", evidenceIds: [], unresolved: ["the parser still has to read them"] }),
      // The retry: the rows are in place, so it only submits.
      submitRows(shape),
      submitRows(shape),
    ]);
    const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: placeRequest(shape), ownerLabel: "test", policy, executionMode: "worktree", maxConcurrentWriters: 2 });
    let current = await fixture.service.drive(run.runId, new AbortController().signal);
    for (let i = 0; i < 8 && current.status === "waiting"; i++) {
      if (fixture.service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
      await fixture.approve(run.runId);
      current = await fixture.service.drive(run.runId, new AbortController().signal);
    }
    const store = fixture.service.store;
    const steps = store.steps(run.runId).filter((s) => s.stage_id === "task-T001");
    const roots = store
      .effects(run.runId)
      .filter((e) => e.kind === "file_patch")
      .map((e) => JSON.parse(e.intent_json) as { path: string; tool?: string; root?: string })
      .filter((intent) => intent.path === shape.path && intent.tool === "edit_file")
      .map((intent) => intent.root ?? "");
    const refusals = store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/") && store.readArtifact(run.runId, a.id).includes("changed none of its files"));
    // The rows were placed once, by the first session in the run root; the retry ran in its own
    // task worktree.
    expect(roots).toEqual([runRootPath(store, run.runId)]);
    expect(store.artifacts(run.runId).some((a) => a.logical_path.startsWith("tasks/batches/"))).toBe(true);
    expect(steps.length).toBeGreaterThanOrEqual(2);
    // No refusal of the retry's result, and no third session: three model calls in all.
    expect(refusals.map((a) => store.readArtifact(run.runId, a.id))).toEqual([]);
    expect(seen.prompts).toHaveLength(3);
    expect(current.status).toBe("completed");
    expect(readFileSync(join(fixture.root, runRootPath(store, run.runId), shape.path), "utf8")).toBe(shape.written);
  });
});

describe("placeRows: the request's rows after a line, from suppliedRows and restoredLine (#2564)", () => {
  const targets = new Map([[PLACE_CLI_PATH, PLACE_CLI_ROWS]]);
  const input = (rows: number[], line = 3, more: Partial<PlaceRowsInput> = {}): PlaceRowsInput => ({ path: PLACE_CLI_PATH, line, rows, ...more });
  test("one row per line with the default indentation and separator, CRLF kept", () => {
    expect(placeRows(input([1, 3]), targets, PLACE_PNMFORGE.scaffold)).toMatchObject({ content: PLACE_PNMFORGE.written, placed: [1, 2, 3], lines: [4, 6] });
    expect(placeRows(input([1, 3]), targets, PLACE_PNMFORGE.scaffold.replaceAll("\n", "\r\n"))).toMatchObject({ content: PLACE_PNMFORGE.written.replaceAll("\n", "\r\n") });
    // A tab-indented file gets a tab; the separator and the last row's separator are the caller's.
    const tabbed = "var rows = []row{\n\t{\"x\"},\n}\n";
    expect(placeRows({ path: "t_test.go", line: 2, rows: [1], separator: ";" }, new Map([["t_test.go", ['{"y"}']]]), tabbed)).toMatchObject({ content: 'var rows = []row{\n\t{"x"},\n\t{"y"};\n}\n' });
    expect(placeRows(input([1, 2], 3, { indent: "  ", lastSeparator: "" }), targets, PLACE_PNMFORGE.scaffold)).toMatchObject({
      content: placeCliFile([]).replace("= {\n", `= {\n  ${PLACE_CLI_ROWS[0]},\n  ${PLACE_CLI_ROWS[1]}\n`),
    });
  });
  test("refusals name the change the worker can make", () => {
    const refusal = (result: ReturnType<typeof placeRows>) => ("refusal" in result ? result.refusal : null);
    expect(refusal(placeRows(input([0, 2]), targets, PLACE_PNMFORGE.scaffold))).toContain("row 0 is not one of them");
    expect(refusal(placeRows(input([3, 1]), targets, PLACE_PNMFORGE.scaffold))).toContain("end before they start");
    expect(refusal(placeRows(input([1]), targets, null))).toContain("does not exist yet. Create it with edit_file");
    expect(refusal(placeRows(input([1], 40), targets, PLACE_PNMFORGE.scaffold))).toContain(`${PLACE_CLI_PATH} has 6 lines; line 40 is not one of them`);
    expect(refusal(placeRows({ ...input([1]), path: "src/cli.cpp" }, targets, ""))).toContain("is not a file this task's prescribed rows go in");
  });
  test("placeRowTargets reads the task's row files from suppliedRows only", () => {
    const request = placeRequest(PLACE_PNMFORGE);
    expect([...placeRowTargets(request, { writes: [{ path: PLACE_CLI_PATH, action: "modify" }, { path: "src/cli.cpp", action: "modify" }] })]).toEqual([[PLACE_CLI_PATH, PLACE_CLI_ROWS]]);
    expect(placeRowTargets(request, { writes: [{ path: PLACE_CLI_PATH, action: "delete" }] }).size).toBe(0);
  });
});

// #2583: some requests give their rows in their own notation, not as code of the file's language.
// Bench round 84 (`rowFileWrite: "on"`): wrapsmith (PowerShell) T002 got `place_rows`, which wrote
// rows like `run "cols" "3" stdin=... => 0 "..." "",` into `tests/*.Tests.ps1`; Pester failed to
// parse the file, and the prescribed-row edit guard put back every edit that rewrote a row as an
// executable `Row` call (the translation spells `\n` as PowerShell's `` `n ``), so the run stuck.

const WRAP_PATH = "tests/Cols.Tests.ps1";
const wrapFile = (rows: string[]) => ['BeforeAll { . "$PSScriptRoot/Row.ps1" }', "", "Describe 'cols' {", ...rows.map((r) => `    ${r}`), "}", ""].join("\n");
const WRAP_ROWS = ['run "cols" "3" stdin="abc def ghi\\n" => 0 "abc\\ndef\\nghi\\n" "",', 'run "cols" "5" stdin="a b c\\n" => 0 "a b c\\n" "",'];
// The session's translation: Pester calls with PowerShell's own escapes.
const WRAP_CALLS = ["Row @('cols', '3') -Stdin \"abc def ghi`n\" -Code 0 -Out \"abc`ndef`nghi`n\" -Err ''", "Row @('cols', '5') -Stdin \"a b c`n\" -Code 0 -Out \"a b c`n\" -Err ''"];
const WRAPSMITH: PlaceShape = {
  path: WRAP_PATH,
  scaffold: wrapFile([]),
  line: 3,
  block: [`cols rows in ${WRAP_PATH} (2 rows)`, ...WRAP_ROWS],
  options: { separator: "" },
  written: wrapFile(WRAP_CALLS),
};
// The pester-written check's stand-in: a notation line is a ParseException; every row is a `Row` call.
const pesterCheck = {
  id: "pester-written",
  executable: "bun",
  args: ["-e", `const t = await Bun.file(${JSON.stringify(WRAP_PATH)}).text(); if (/^\\s*run\\s.*=>/m.test(t)) { console.log("ParseException: ${WRAP_PATH}"); process.exit(1); } if ((t.match(/^\\s*Row @\\(/gm) ?? []).length !== 2) { console.log("${WRAP_PATH}: a row is missing"); process.exit(1); }`],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "feature" as const,
  envNames: [],
  writes: [],
};
const translate = (from: string, to: string) => () => call("edit_file", { path: WRAP_PATH, oldString: from, newString: to });

describe("scenario: R84 wrapsmith, rows in the request's notation are translated by the session, never placed (#2583)", () => {
  test("powershell: place_rows is not offered for notation rows, and the session's Pester calls stand", async () => {
    const { final, file, seen, record } = await placeScenario(
      WRAPSMITH,
      { rowFileWrite: "on" },
      [translate("Describe 'cols' {\n", `Describe 'cols' {\n${WRAP_CALLS.map((c) => `    ${c}`).join("\n")}\n`), submitRows(WRAPSMITH)],
      [pesterCheck],
    );
    expect(seen.tools[0]).not.toContain("place_rows");
    expect(seen.prompts[0]).not.toContain("You must place them with place_rows");
    expect(seen.prompts[0]).toContain(`The request gives the rows of ${WRAP_PATH} (every row) in its own notation`);
    expect(seen.prompts[1]).not.toContain("Edit put back");
    expect(record).toMatchObject({ mode: "on", offered: false, files: [{ path: WRAP_PATH, rows: 2, notation: 2 }] });
    expect(final.status).toBe("completed");
    expect(file).toBe(WRAPSMITH.written);
    expect(file).not.toContain("=>");
  });

  test("powershell resume: a file holding the notation rows place_rows wrote is converted without a refusal or a restore", async () => {
    const { final, file, seen, restores } = await placeScenario(
      { ...WRAPSMITH, scaffold: wrapFile(WRAP_ROWS) },
      { rowFileWrite: "on", rowRestore: "on" },
      [translate(WRAP_ROWS[0] ?? "", WRAP_CALLS[0] ?? ""), translate(WRAP_ROWS[1] ?? "", WRAP_CALLS[1] ?? ""), submitRows(WRAPSMITH)],
      [pesterCheck],
    );
    for (const prompt of seen.prompts.slice(1, 3)) expect(prompt).not.toContain("Edit put back");
    expect(final.status).toBe("completed");
    expect(file).toBe(WRAPSMITH.written);
    // Nothing writes the request's notation back over the executable rows.
    expect(restores.filter((r) => r.verdict === "restored" || r.verdict === "would_restore")).toEqual([]);
  });

  test("placeRows refuses a notation row with the change to make; code rows of the same task still place", () => {
    const targets = new Map<string, readonly string[]>([[WRAP_PATH, WRAP_ROWS], [PLACE_CLI_PATH, PLACE_CLI_ROWS]]);
    const refused = placeRows({ path: WRAP_PATH, line: 3, rows: [1, 2] }, targets, WRAPSMITH.scaffold);
    expect("refusal" in refused ? refused.refusal : null).toContain(`${WRAP_PATH}: the request gives rows 1, 2 in its own notation`);
    expect("refusal" in refused ? refused.refusal : null).toContain("Write these rows yourself with edit_file as the test framework's call");
    expect(placeRows({ path: PLACE_CLI_PATH, line: 3, rows: [1, 3] }, targets, PLACE_PNMFORGE.scaffold)).toMatchObject({ content: PLACE_PNMFORGE.written });
    const forms = placeRowsModule.placeRowForms(targets);
    expect([...forms.code.keys()]).toEqual([PLACE_CLI_PATH]);
    expect([...forms.notation]).toEqual([[WRAP_PATH, [1, 2]]]);
  });

  test("the edit guard lets a notation row become code, and still guards the code row afterwards", () => {
    const request = placeRequest(WRAPSMITH);
    expect(rowEditBreaks(request, WRAP_PATH, wrapFile(WRAP_ROWS), wrapFile([WRAP_CALLS[0] ?? "", WRAP_ROWS[1] ?? ""]))).toBeNull();
    // A code row that holds the request's row is guarded as before: changing its output is put back.
    const held = "Row @('cols', '5') -Stdin 'a b c' -Code 0 -Out 'a b c' -Err ''";
    const rows = ['run "cols" "5" stdin="a b c" => 0 "a b c" ""'];
    const plain = ["Prescribed.", "", "```text", `cols rows in ${WRAP_PATH} (1 row)`, ...rows, "```", ""].join("\n");
    expect(rowEditBreaks(plain, WRAP_PATH, wrapFile([held]), wrapFile([held.replace("-Out 'a b c'", "-Out 'a b'")]))?.rows).toEqual([1]);
  });

  test("the whole-line restore never writes the request's notation over code that shares its head", () => {
    // A Pester helper named after the notation: the same head, `run`, but PowerShell's own call.
    const code = "run @('cols', '3') -Stdin \"abc def ghi`n\" -Code 0 -Out \"abc`ndef`nghi`n\" -Err ''";
    const file = wrapFile([code, WRAP_ROWS[1] ?? ""]);
    const plan = rowRestorePlan(WRAP_ROWS, file);
    expect(plan.sites).toMatchObject([{ row: 1, line: 4, sameHead: false }]);
    expect(plan.restore).toEqual([]);
    expect(plan.after).toBe(file);
  });

  test("rowNotation tells the request's notation from code rows of every shape; the host write declines notation rows", () => {
    for (const row of [...WRAP_ROWS, 'run "deflate" "--hex" stdin="7171" => 0 "cd\\n" ""', "run ls => 0 \"<dir>/out.txt\\n\"", "split \"a,b\" => \"a|b\""]) expect(rowBlockModule.rowNotation(row)).toBe(true);
    const code = [
      ...PLACE_CLI_ROWS,
      ...PLACE_ENCODE_ROWS,
      ...WRAP_CALLS,
      ...Object.values(ROW_FILE_SHAPES).flatMap((shape) => (isNoRow(shape) ? [] : shape.example.rows)),
      "yield 'cols 3' => ['cols', '3', 0, \"abc\\n\"],",
      "['args' => ['cols'], 'code' => 0],",
      '@test "cols 3" {',
      'it "maps a => b" do',
      "assert_row \"cols\" \"3\"",
    ];
    for (const row of code) expect([row, rowBlockModule.rowNotation(row)]).toEqual([row, false]);
    // `rowFilePlan` needs every row to be a row line of the language, so notation rows decline.
    for (const shape of [TINYFLATE, PNMFORGE, BYTEMERGE]) expect(rowFilePlan(shape.path, WRAP_ROWS, { source: "reference", text: shape.reference.text }).inputs.sameHead).toBe(false);
  });
});
