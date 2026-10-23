import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  hasInlineRows,
  type InlineRowTest,
  inlineRowFile,
  layoutFree,
  withInlineRows,
} from "../src/core/workflows/acceptance-rows-inline.js";
import { rowFileProblems, rowFiles } from "../src/core/workflows/acceptance-rows.js";
import type { AcceptanceRow } from "../src/core/workflows/acceptance-rows-model.js";

// Scenario of bench round 60, wheeltags (Python, ruff check and ruff format gates, rowsAsData on),
// #1927. The host's inline block in tests/test_platforms.py and tests/test_target.py failed ruff
// (I001 for its own import block, then ruff format for a long row line and decorator), and the rows
// check refused any change to the block, so T003 and T004 each stopped on spec_conflict. The block
// is now lint- and format-clean, and a formatter's layout of any block is not an edit.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const rows: AcceptanceRow[] = [
  {
    id: "AC-003:1",
    criterionId: "AC-003",
    source: "",
    input: { platform: "manylinux_2_17_x86_64", tags: ["cp311", "abi3"], note: "it's a \\ back\nslash ✓" },
    expected: { ok: true, values: [1, 2.5, null, 'a "quoted" text'] },
  },
  { id: "AC-003:2", criterionId: "AC-003", source: "", input: "macosx_11_0_arm64", expected: false },
];

const PLATFORMS = `"""Tests of platform tags."""

from wheeltags.platforms import parse_platform


def acceptance_actual(value):
    return parse_platform(value)


def test_parse_any():
    assert parse_platform("any") == "any"
`;

const pytest: InlineRowTest = { mode: "inline", framework: "pytest", test: "tests/test_platforms.py" };
const ruff = spawnSync("ruff", ["--version"]).status === 0 ? "ruff" : null;
const RULES = "E,F,I,W,UP,B,Q,FLY,ISC,PL,SIM,C4,RUF";

function temp(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-rows-lint-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** The ruff findings of a file at a line length, empty when it passes both gates. */
function ruffProblems(root: string, path: string, length: number): string {
  const run = (args: string[]) => spawnSync(ruff ?? "ruff", ["--isolated", ...args, "--line-length", String(length), path], { cwd: root, encoding: "utf8" });
  const check = run(["check", "--select", RULES, "--quiet"]);
  const format = run(["format", "--check", "--quiet"]);
  return [check.status ? check.stdout : "", format.status ? `format: ${format.stdout}` : ""].join("").trim();
}

/** What a lint gate reads first, with no tool: the lines of the block and the imports in it. */
function lineProblems(text: string): string[] {
  return text.split("\n").flatMap((line, i) => [
    ...(line.length > 79 ? [`line ${i + 1} is ${line.length} columns`] : []),
    ...(/^(?:import|from) \w/.test(line) && i > 3 ? [`line ${i + 1} is an import below the file's code`] : []),
  ]);
}

describe("scenario: wheeltags R60, host-written Python rows pass ruff (#1927)", () => {
  const written = withInlineRows(PLATFORMS, inlineRowFile(pytest, rows));

  test("the inline block has no import statement and no line over 79 columns", () => {
    expect(lineProblems(written)).toEqual([]);
    expect(written).toContain("# BEGIN acceptance rows");
    for (const row of rows) expect(written).toContain(row.id);
  });

  test.skipIf(!ruff)("the inline block passes ruff check (isort) and ruff format at any line length", () => {
    const root = temp({ [pytest.test]: written });
    for (const length of [79, 88, 100, 120]) expect(ruffProblems(root, pytest.test, length)).toBe("");
  });

  test("the inline block's string literals decode to the rows", () => {
    const list = written.slice(written.indexOf("_ACCEPTANCE_TEXT = ["), written.indexOf("\n]\n"));
    const literals = [...list.matchAll(/^ {4}(['"])(.*)\1,$/gm)].map(([, quote, body]) =>
      (body ?? "").replace(/\\(x[0-9a-f]{2}|.)/g, (_, esc: string) =>
        esc.startsWith("x") && esc.length === 3 ? String.fromCharCode(Number.parseInt(esc.slice(1), 16)) : esc === quote || esc === "\\" ? esc : `\\${esc}`,
      ),
    );
    expect(JSON.parse(literals.join(""))).toEqual(rows.map(({ id, input, expected }) => ({ id, input, expected })));
  });

  const fileTest = { framework: "pytest" as const, harness: "tests/support/platform_tags_harness.py", test: "tests/test_platform_tags_rows.py", data: "tests/data/platform_tags_rows.json" };
  const task = { id: "T003", rows: ["AC-003"], rowTest: fileTest } as never;
  const files = rowFiles(task, { tasks: [{ rows: ["AC-003"], rowTest: fileTest }], rows } as never);
  const fileModeTest = files.find((file) => file.path === fileTest.test)?.content ?? "";

  test("the file mode's test has isort's groups and no line over 79 columns", () => {
    expect(fileModeTest).toContain("from pathlib import Path\n\nimport pytest\n");
    expect(fileModeTest.split("\n").filter((line) => line.length > 79)).toEqual([]);
  });

  test.skipIf(!ruff)("the file mode's test passes ruff check and ruff format at any line length", () => {
    const root = temp({ [fileTest.test]: fileModeTest });
    for (const length of [79, 88, 100, 120]) expect(ruffProblems(root, fileTest.test, length)).toBe("");
  });

  test("a block from an earlier version is replaced, and the file keeps one block", () => {
    const old = `${PLATFORMS}\n# BEGIN acceptance rows: host-written from the audited spec table. Edit acceptance_actual, not this block.\nimport json as _acceptance_json\nimport pytest as _acceptance_pytest\n\n_ACCEPTANCE_ROWS = _acceptance_json.loads("[]")\n# END acceptance rows\n`;
    const replaced = withInlineRows(old, inlineRowFile(pytest, rows));
    expect(replaced).toContain(inlineRowFile(pytest, rows).tail);
    expect(replaced).not.toContain("import json as _acceptance_json");
    expect(replaced.match(/BEGIN acceptance rows/g)?.length).toBe(1);
  });
});

/** Formatter layouts of each language's block, made by hand so the test needs no toolchain. */
const LAYOUTS: { name: string; test: InlineRowTest; harness: string; format: (text: string) => string }[] = [
  {
    name: "pytest, black with a wider line: the decorator on one line, single quotes",
    test: pytest,
    harness: PLATFORMS,
    format: (text) =>
      text
        .replace('parametrize(\n    "row",\n    _ACCEPTANCE_ROWS,\n    ids=[row["id"] for row in _ACCEPTANCE_ROWS],\n)', 'parametrize(\n    \'row\', _ACCEPTANCE_ROWS, ids=[row[\'id\'] for row in _ACCEPTANCE_ROWS]\n)'),
  },
  {
    name: "rust, cargo fmt: struct fields and match arms laid out again",
    test: { mode: "inline", framework: "rust", test: "tests/platforms.rs" },
    harness: "fn acceptance_actual(input: &AcceptanceJson) -> AcceptanceJson {\n    input.clone()\n}\n",
    format: (text) => text.replace(/\n {8}/g, "\n            ").replace(/\{\n(\s+)/, "{ ").replace(/,\n(\s*)\}/g, "\n$1}"),
  },
  {
    name: "bun, biome: single quotes and a trailing comma",
    test: { mode: "inline", framework: "bun", test: "tests/platforms.test.ts" },
    harness: "function acceptanceActual(input: unknown): unknown {\n  return input;\n}\n",
    format: (text) => text.replace('from "bun:test"', "from 'bun:test'").replace(/\(row\.input\)\)\.toEqual\(row\.expected\)/, "(row.input)).toEqual(\n    row.expected,\n  )"),
  },
  {
    // What Biome wrote with semicolons "asNeeded" and single quotes (#1936).
    name: "bun, Biome asNeeded or Prettier semi false: no semicolons",
    test: { mode: "inline", framework: "bun", test: "tests/platforms.test.ts" },
    harness: "function acceptanceActual(input: unknown): unknown {\n  for (;;) return input;\n}\n",
    format: (text) => text.replace(/;$/gm, "").replaceAll('"bun:test"', "'bun:test'"),
  },
  {
    // Prettier's semi false puts a semicolon before a line that opens with a bracket.
    name: "bun, Prettier semi false: a leading semicolon",
    test: { mode: "inline", framework: "bun", test: "tests/platforms.test.ts" },
    harness: "function acceptanceActual(input: unknown): unknown {\n  return input;\n}\n",
    format: (text) => text.replace(/;$/gm, "").replace("acceptanceTest.each(", ";acceptanceTest.each("),
  },
  {
    name: "xunit, dotnet format: indentation with tabs",
    test: { mode: "inline", framework: "xunit", package: "Wheeltags.Tests", test: "tests/PlatformsTests.cs" },
    harness: "namespace Wheeltags.Tests;\n\npublic class PlatformsTests\n{\n    public static object? AcceptanceActual(System.Text.Json.Nodes.JsonNode? input) => input;\n}\n",
    format: (text) => text.replace(/^( {4})+/gm, (spaces) => "\t".repeat(spaces.length / 4)),
  },
];

describe("scenario: a formatter gate's fixer lays the block out again, in every language (#1927)", () => {
  for (const layout of LAYOUTS) {
    const file = inlineRowFile(layout.test, rows);
    const written = withInlineRows(layout.harness, file);
    const formatted = layout.format(written);

    test(`${layout.name}: the layout is kept and passes the rows check`, () => {
      expect(formatted).not.toBe(written);
      expect(hasInlineRows(formatted, file)).toBe(true);
      expect(withInlineRows(formatted, file)).toBe(formatted);
    });

    test(`${layout.name}: a changed row is still caught and put back`, () => {
      const tampered = formatted.replace("macosx_11_0_arm64", "macosx_12_0_arm64");
      expect(tampered).not.toBe(formatted);
      expect(hasInlineRows(tampered, file)).toBe(false);
      expect(withInlineRows(tampered, file)).toContain("macosx_11_0_arm64");
    });
  }

  test("a semicolon inside a for header or a string still counts, and Python keeps its semicolons (#1936)", () => {
    expect(layoutFree("for (;;) x;\ny;", "a.ts")).toBe(layoutFree("for (;;) x\ny", "a.ts"));
    expect(layoutFree("for (;;) x", "a.ts")).not.toBe(layoutFree("for () x", "a.ts"));
    expect(layoutFree('s = "a;"\n', "a.ts")).not.toBe(layoutFree('s = "a"\n', "a.ts"));
    expect(layoutFree("x = 1;\n", "a.rs")).not.toBe(layoutFree("x = 1\n", "a.rs"));
  });

  test("the file mode's check accepts a semicolon-free layout of the bun test (#1936)", async () => {
    const fileTest = { framework: "bun" as const, harness: "tests/harness.ts", test: "tests/rows.test.ts", data: "tests/rows.json" };
    const task = { id: "T003", rows: ["AC-003"], rowTest: fileTest } as never;
    const files = rowFiles(task, { tasks: [{ rows: ["AC-003"], rowTest: fileTest }], rows } as never);
    const content = (path: string) => files.find((file) => file.path === path)?.content ?? "";
    const formatted = {
      [fileTest.data]: content(fileTest.data),
      [fileTest.test]: content(fileTest.test).replace(/;$/gm, ""),
      [fileTest.harness]: "export const actual = (input: unknown) => input\n",
    };
    expect(formatted[fileTest.test]).not.toBe(content(fileTest.test));
    expect(await rowFileProblems(temp(formatted), files)).toEqual([]);
  });

  test("the file mode's check accepts a formatter's layout of a host file and refuses a row change", async () => {
    const fileTest = { framework: "bun" as const, harness: "tests/harness.ts", test: "tests/rows.test.ts", data: "tests/rows.json" };
    const task = { id: "T003", rows: ["AC-003"], rowTest: fileTest } as never;
    const files = rowFiles(task, { tasks: [{ rows: ["AC-003"], rowTest: fileTest }], rows } as never);
    const data = files.find((file) => file.path === fileTest.data)?.content ?? "";
    const testFile = files.find((file) => file.path === fileTest.test)?.content ?? "";
    const formatted = {
      [fileTest.data]: `${JSON.stringify(JSON.parse(data))}\n`,
      [fileTest.test]: testFile.replaceAll('"', "'"),
      [fileTest.harness]: "export const actual = (input: unknown) => input;\n",
    };
    expect(layoutFree(formatted[fileTest.data] ?? "")).toBe(layoutFree(data));
    expect(await rowFileProblems(temp(formatted), files)).toEqual([]);
    const tampered = { ...formatted, [fileTest.data]: (formatted[fileTest.data] ?? "").replace("macosx_11_0_arm64", "x") };
    expect(await rowFileProblems(temp(tampered), files)).not.toEqual([]);
  });
});

// #1948: Prettier 3 with semi false and printWidth 40 (recorded output, so no toolchain is needed).
// The block once typed its rows with a type literal whose member separators Prettier dropped.
const PRETTIER_NARROW =
  "// BEGIN acceptance rows: host-written from the audited spec table. Edit acceptanceActual, not this block.\nimport {\n  expect as acceptanceExpect,\n  test as acceptanceTest,\n} from \"bun:test\"\nconst acceptanceRows: Record<\n  string,\n  unknown\n>[] = JSON.parse(\n  '[{\"id\":\"AC-003:2\",\"input\":\"macosx_11_0_arm64\",\"expected\":false}]',\n)\nacceptanceTest.each(acceptanceRows)(\n  \"$id\",\n  async ({ input, expected }) => {\n    acceptanceExpect(\n      await acceptanceActual(input),\n    ).toEqual(expected)\n  },\n)\n// END acceptance rows\n";

test("a narrow semicolon-free Prettier layout of the inline bun block is kept (#1948)", () => {
  const file = inlineRowFile({ mode: "inline", framework: "bun", test: "tests/platforms.test.ts" }, rows.slice(1));
  const formatted = `function acceptanceActual(\n  input: unknown,\n): unknown {\n  return input\n}\n\n${PRETTIER_NARROW}`;
  expect(hasInlineRows(formatted, file)).toBe(true);
  expect(withInlineRows(formatted, file)).toBe(formatted);
  const tampered = formatted.replace('"expected":false', '"expected":true');
  expect(hasInlineRows(tampered, file)).toBe(false);
});

/** A tool if it runs here: the fixed-point checks below need no toolchain to pass in CI. */
const tool = (command: string, ...args: string[]) => (spawnSync(command, args).status === 0 ? command : null);
const BIN = join(import.meta.dir, "..", "node_modules", ".bin");
const biome = tool(join(BIN, "biome"), "--version");
const tsc = tool(join(BIN, "tsc"), "--version");
const rustfmt = tool("rustfmt", "--version");
const gofmt = tool("gofmt", "-l", import.meta.dir);

function fileMode(rowTest: Record<string, string>) {
  const task = { id: "T003", rows: ["AC-003"], rowTest } as never;
  const files = rowFiles(task, { tasks: [{ rows: ["AC-003"], rowTest }], rows } as never);
  return Object.fromEntries(files.map((file) => [file.path, file.content])) as Record<string, string>;
}
const run = (cwd: string, command: string, ...args: string[]) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return `${result.status} ${result.stdout}${result.stderr}`.trim();
};

// #1942 (R61 md-site): each file-mode test is a fixed point of its language's formatter, linter and
// typechecker, so no fixer rewrites a file the host owns.
describe("scenario: the host's file-mode rows tests pass their language's gates as written (#1942)", () => {
  test("bun: one relative import, and the harness has no file extension", () => {
    const files = fileMode({ framework: "bun", harness: "tests/support/links.rows.ts", test: "tests/links.rows.test.ts", data: "tests/links.rows.json" });
    const text = files["tests/links.rows.test.ts"] ?? "";
    expect(text.match(/^import .* from "\.\.?\//gm)).toHaveLength(1);
    expect(text).toContain('await import("./support/links.rows")');
    expect(text).not.toMatch(/import\(".*\.ts"\)/);
  });

  test.skipIf(!biome || !tsc)("bun: biome check and tsc --noEmit print nothing", () => {
    const files = fileMode({ framework: "bun", harness: "tests/support/links.rows.ts", test: "tests/links.rows.test.ts", data: "tests/links.rows.json" });
    const root = temp({
      ...files,
      "tests/support/links.rows.ts": "export const actual = async (input: unknown): Promise<unknown> => input;\n",
      "biome.json": '{\n  "formatter": { "indentStyle": "space", "lineWidth": 100 }\n}\n',
      "tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ESNext", module: "Preserve", moduleResolution: "bundler", strict: true, noEmit: true, skipLibCheck: true, types: ["bun-types"], typeRoots: [join(import.meta.dir, "..", "node_modules")] }, include: ["tests"] })}\n`,
    });
    expect(run(root, biome ?? "", "check", "tests/links.rows.test.ts")).toStartWith("0 ");
    expect(run(root, tsc ?? "", "-p", ".")).toBe("0");
  });

  test.skipIf(!rustfmt)("rust: rustfmt --check prints nothing", () => {
    const files = fileMode({ framework: "rust", harness: "tests/support/platform_tags_harness.rs", test: "tests/platform_tags_rows.rs", data: "tests/data/a_long_directory_for_acceptance_rows/platform_tags_rows.json" });
    const root = temp({ ...files, "tests/support/platform_tags_harness.rs": "pub fn actual(v: serde_json::Value) -> serde_json::Value {\n    v\n}\n" });
    expect(run(root, rustfmt ?? "", "--check", "--edition", "2021", "tests/platform_tags_rows.rs")).toBe("0");
  });

  test.skipIf(!gofmt)("go: gofmt -l prints nothing", () => {
    const files = fileMode({ framework: "go", package: "platformtags", harness: "platform_tags_harness.go", test: "platform_tags_rows_test.go", data: "testdata/platform_tags_rows.json" });
    expect(run(temp(files), gofmt ?? "", "-l", ".")).toBe("0");
  });

  test.skipIf(!ruff)("pytest: ruff check and ruff format --check print nothing", () => {
    const files = fileMode({ framework: "pytest", harness: "tests/support/platform_tags_harness.py", test: "tests/test_platform_tags_rows.py", data: "tests/data/platform_tags_rows.json" });
    const root = temp(files);
    expect(run(root, "ruff", "check", "--isolated", "--select", RULES, ".")).toStartWith("0 ");
    expect(run(root, "ruff", "format", "--isolated", "--check", ".")).toStartWith("0 ");
  });

  test("junit and xunit: no code line over 100 columns, only the rows' own literals", () => {
    for (const rowTest of [
      { framework: "junit", package: "com.example.platformtags", harness: "src/test/java/com/example/platformtags/PlatformTagsHarness.java", test: "src/test/java/com/example/platformtags/PlatformTagsRowsTest.java", data: "src/test/resources/platform_tags_rows.json" },
      { framework: "xunit", package: "PlatformTags.Tests", harness: "tests/PlatformTagsHarness.cs", test: "tests/PlatformTagsRowsTests.cs", data: "tests/data/platform_tags_rows.json" },
    ]) {
      const text = fileMode(rowTest)[rowTest.test] ?? "";
      const long = text.split("\n").filter((line) => line.length > 100 && !/^\s+row\(|const string Rows/.test(line));
      expect({ framework: rowTest.framework, long }).toEqual({ framework: rowTest.framework, long: [] });
    }
  });
});

// #1961 (adversarial review of #1953): a project formatter's options pick spellings of their own.
// Prettier `arrowParens: "avoid"` and Biome `arrowParentheses: "asNeeded"` wrote `async row =>` for
// the bun templates' `async (row) =>`, and google-java-format reflowed a long Java row literal into
// `"..." + "..."` at its own boundaries; the inline block was restored in a loop and a file-mode
// test was refused input_changed. Each template is a fixed point of each option below.
const prettier = tool("prettier", "--version");
const googleJavaFormat = tool("google-java-format", "--version");

/** Prettier's arrowParens avoid and Biome's asNeeded, as they treat a single bare parameter. */
const avoidArrowParens = (text: string) => text.replace(/\(([A-Za-z_$][\w$]*)\) =>/g, "$1 =>");

describe("scenario: the bun templates are fixed points of arrowParens avoid and asNeeded (#1961)", () => {
  for (const ext of ["ts", "js"]) {
    test(`inline .${ext}: the block is kept, and a changed expected value is still put back`, () => {
      const file = inlineRowFile({ mode: "inline", framework: "bun", test: `tests/platforms.test.${ext}` }, rows);
      const written = withInlineRows("function acceptanceActual(input) {\n  return input;\n}\n", file);
      const formatted = avoidArrowParens(written);
      expect(hasInlineRows(formatted, file)).toBe(true);
      expect(withInlineRows(formatted, file)).toBe(formatted);
      const tampered = formatted.replace('\\"expected\\":false', '\\"expected\\":true');
      expect(tampered).not.toBe(formatted);
      expect(hasInlineRows(tampered, file)).toBe(false);
    });

    test(`file .${ext}: rowFileProblems and the pre-attempt compare accept it, and refuse a changed expected value`, async () => {
      const rowTest = { framework: "bun", harness: `tests/support/harness.${ext}`, test: `tests/rows.test.${ext}`, data: "tests/rows.json" };
      const files = fileMode(rowTest);
      const task = { id: "T003", rows: ["AC-003"], rowTest } as never;
      const generated = rowFiles(task, { tasks: [{ rows: ["AC-003"], rowTest }], rows } as never);
      const content = files[rowTest.test] ?? "";
      const formatted = { ...files, [rowTest.test]: avoidArrowParens(content), [rowTest.harness]: "export const actual = input => input\n" };
      expect(layoutFree(formatted[rowTest.test] ?? "", rowTest.test)).toBe(layoutFree(content, rowTest.test));
      expect(await rowFileProblems(temp(formatted), generated)).toEqual([]);
      const tampered = { ...formatted, [rowTest.data]: (formatted[rowTest.data] ?? "").replace('"expected": false', '"expected": true') };
      expect(tampered[rowTest.data]).not.toBe(formatted[rowTest.data]);
      expect(await rowFileProblems(temp(tampered), generated)).not.toEqual([]);
    });
  }

  test("a single bare arrow parameter reads the same with or without parentheses, in JavaScript only", () => {
    expect(layoutFree("each(rows)('$id', async row => {\n  check(row)\n})", "a.ts")).toBe(layoutFree('each(rows)("$id", async (row) => {\n  check(row);\n});', "a.ts"));
    expect(layoutFree("f(x => x)", "a.js")).toBe(layoutFree("f((x) => x)", "a.js"));
    expect(layoutFree("f((x, y) => x)", "a.ts")).not.toBe(layoutFree("f((y, x) => x)", "a.ts"));
    expect(layoutFree("f((row) => row.input)", "a.ts")).not.toBe(layoutFree("f((row) => row.expected)", "a.ts"));
    expect(layoutFree('s = "(x) => x"', "a.ts")).not.toBe(layoutFree('s = "x => x"', "a.ts"));
    expect(layoutFree("x => y", "A.cs")).not.toBe(layoutFree("(x) => y", "A.cs"));
  });

  test.skipIf(!prettier)("Prettier with arrowParens avoid keeps the blocks' arrows as written", () => {
    for (const ext of ["ts", "js"]) {
      const inline = withInlineRows("", inlineRowFile({ mode: "inline", framework: "bun", test: `tests/platforms.test.${ext}` }, rows));
      const rowTest = { framework: "bun", harness: `tests/support/harness.${ext}`, test: `tests/rows.test.${ext}`, data: "tests/rows.json" };
      const root = temp({ [`tests/platforms.test.${ext}`]: inline, ...fileMode(rowTest) });
      for (const path of [`tests/platforms.test.${ext}`, rowTest.test]) {
        const out = spawnSync(prettier ?? "", ["--arrow-parens", "avoid", path], { cwd: root, encoding: "utf8" }).stdout;
        expect(out).toContain("async ({ input, expected }) =>");
      }
    }
  });

  test.skipIf(!biome)("Biome with arrowParentheses asNeeded leaves the file-mode test unchanged", () => {
    const rowTest = { framework: "bun", harness: "tests/support/harness.ts", test: "tests/rows.test.ts", data: "tests/rows.json" };
    const files = fileMode(rowTest);
    const root = temp({ ...files, "biome.json": '{\n  "formatter": { "indentStyle": "space", "lineWidth": 100 },\n  "javascript": { "formatter": { "arrowParentheses": "asNeeded" } }\n}\n' });
    expect(run(root, biome ?? "", "format", rowTest.test)).toStartWith("0 ");
  });
});

// A row string of 231 characters with spaces, quotes, a backslash and a newline, and the row line
// google-java-format 1.22 wrote for it under its default settings from the single literal of the
// earlier template (recorded, so no toolchain is needed).
const PROSE = 'Given a document with "quoted" headings and a back\\slash, when the reader opens it\nthen every link under the second heading resolves to its anchor, and the table of contents lists them in order of appearance.';
const proseRows: AcceptanceRow[] = [{ id: "AC-010:1", criterionId: "AC-010", source: "", input: { text: PROSE, depth: 2 }, expected: PROSE.toUpperCase() }];
const GJF_REFLOW = String.raw`        row(
            "AC-010:1",
            map(
                "text",
                "Given a document with \"quoted\" headings and a back\\slash, when the reader opens"
                    + " it\012then every link under the second heading resolves to its anchor, and"
                    + " the table of contents lists them in order of appearance.",
                "depth",
                2L),
            "GIVEN A DOCUMENT WITH \"QUOTED\" HEADINGS AND A BACK\\SLASH, WHEN THE READER OPENS"
                + " IT\012THEN EVERY LINK UNDER THE SECOND HEADING RESOLVES TO ITS ANCHOR, AND THE"
                + " TABLE OF CONTENTS LISTS THEM IN ORDER OF APPEARANCE."));`;

describe("scenario: the junit templates are fixed points of google-java-format's string reflow (#1961)", () => {
  const rowTest = { framework: "junit", package: "com.example.links", harness: "src/test/java/com/example/links/LinksHarness.java", test: "src/test/java/com/example/links/LinksRowsTest.java", data: "src/test/resources/links_rows.json" };
  const task = { id: "T003", rows: ["AC-010"], rowTest } as never;
  const generated = rowFiles(task, { tasks: [{ rows: ["AC-010"], rowTest }], rows: proseRows } as never);
  const content = generated.find((file) => file.path === rowTest.test && !file.inline)?.content ?? "";
  const rowLine = content.split("\n").find((line) => line.startsWith("        row(")) ?? "";
  const files = Object.fromEntries(generated.map((file) => [file.path, file.inline ? "" : file.content]));

  test("no string literal of a row is over 62 columns with its quotes", () => {
    const literals = rowLine.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
    expect(literals.length).toBeGreaterThan(6);
    expect(literals.filter((text) => text.length > 62)).toEqual([]);
  });

  test("the reflowed layout is accepted by rowFileProblems and the pre-attempt compare; a changed character is refused", async () => {
    const formatted = content.replace(`${rowLine}\n`, `${GJF_REFLOW}\n`);
    expect(formatted).not.toBe(content);
    expect(layoutFree(formatted, rowTest.test)).toBe(layoutFree(content, rowTest.test));
    expect(await rowFileProblems(temp({ ...files, [rowTest.test]: formatted }), generated)).toEqual([]);
    const tampered = formatted.replace("in order of appearance.", "in order of appearance!");
    expect(await rowFileProblems(temp({ ...files, [rowTest.test]: tampered }), generated)).not.toEqual([]);
  });

  test("the inline block keeps the reflowed layout and puts back a changed character", () => {
    const file = inlineRowFile({ mode: "inline", framework: "junit", package: "com.example.links", test: "src/test/java/com/example/links/LinksTest.java" }, proseRows);
    const written = withInlineRows("package com.example.links;\n\nclass LinksTest {\n  static Object acceptanceActual(Object input) {\n    return input;\n  }\n}\n", file);
    const line = written.split("\n").find((text) => text.trimStart().startsWith('row("AC-010:1"')) ?? "";
    const indent = line.length - line.trimStart().length - 8;
    const formatted = written.replace(line, GJF_REFLOW.replace(/^/gm, " ".repeat(indent)));
    expect(formatted).not.toBe(written);
    expect(hasInlineRows(formatted, file)).toBe(true);
    expect(withInlineRows(formatted, file)).toBe(formatted);
    const tampered = formatted.replace("in order of appearance.", "in order of appearance!");
    expect(hasInlineRows(tampered, file)).toBe(false);
  });

  test("joined literals read as one only where + is the outermost operator", () => {
    expect(layoutFree('f("ab" + "c", x)', "A.java")).toBe(layoutFree('f("a" + "bc", x)', "A.java"));
    expect(layoutFree('f("a" + "b" * 2)', "a.js")).not.toBe(layoutFree('f("ab" * 2)', "a.js"));
    expect(layoutFree('f(x * "a" + "b")', "a.js")).not.toBe(layoutFree('f(x * "ab")', "a.js"));
    expect(layoutFree('f("a" + "b".length)', "a.js")).not.toBe(layoutFree('f("ab".length)', "a.js"));
  });

  const inline = inlineRowFile({ mode: "inline", framework: "junit", package: "com.example.links", test: "src/test/java/com/example/links/LinksTest.java" }, proseRows);
  const inlineWritten = withInlineRows("package com.example.links;\n\nclass LinksTest {\n  static Object acceptanceActual(Object input) {\n    return input;\n  }\n}\n", inline);

  test("no comment line of the inline block is over 100 columns, which google-java-format wraps", () => {
    expect(inlineWritten.split("\n").filter((line) => /^\s*\/\//.test(line) && line.length > 100)).toEqual([]);
  });

  test.skipIf(!googleJavaFormat)("google-java-format changes only whitespace in the file-mode test and the inline block", () => {
    const root = temp({ [rowTest.test]: content, [inline.path]: inlineWritten });
    const out = spawnSync(googleJavaFormat ?? "", [rowTest.test], { cwd: root, encoding: "utf8" }).stdout;
    expect(out.match(/"(?:[^"\\]|\\.)*"/g)).toEqual(content.match(/"(?:[^"\\]|\\.)*"/g));
    const formatted = spawnSync(googleJavaFormat ?? "", [inline.path], { cwd: root, encoding: "utf8" }).stdout;
    expect(formatted).not.toBe(inlineWritten);
    expect(hasInlineRows(formatted, inline)).toBe(true);
  });
});
