import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isNoRow } from "../src/core/intelligence/language-records.js";
import { layoutFree } from "../src/core/workflows/acceptance-rows-inline.js";
import { type HostApplyWrite, hostApplyDecision, hostApplyRecords, rowFileTasks } from "../src/core/workflows/host-apply.js";
import { ROW_FILE_SHAPES, type RowFileInputs, rowArity, rowFilePlan, rowFileRefusal } from "../src/core/workflows/row-file.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import { runRootPath } from "../src/core/workflows/effects.js";
import { newId } from "../src/core/workflows/store.js";
import { INTEGRITY_DIR } from "../src/core/workflows/test-integrity.js";
import { exportTrace, replayTrace } from "../src/core/workflows/trace.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

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
