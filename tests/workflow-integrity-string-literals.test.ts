import { expect, test } from "bun:test";
import { blankStringLiterals } from "../src/core/intelligence/comments.js";
import { scanTestIntegrity } from "../src/core/workflows/test-integrity.js";

// Bench round 45, md-site 43b0daed (#1549): the front-matter test data
// "---\ntitle: 'A title'\ncustom_value: any text\n---" in tests/frontmatter.property.test.ts was
// counted as a new `: any` annotation, and two correctives (448k tokens) hunted a suppression
// that was not there.

const rules = (path: string, before: string, after: string) =>
  scanTestIntegrity([{ path, before, after }]).map((f) => f.rule);

/** Per language: text a test carries as data, and the real construct of the same rule. */
const SUPPRESSION_CASES: [path: string, data: string, real: string][] = [
  [
    "tests/frontmatter.property.test.ts",
    'const input = "---\\ntitle: \'A title\'\\ncustom_value: any text\\n---\\nbody";\n',
    "const input: any = read();\n",
  ],
  ["src/cast.ts", "const message = `pass it as any value`;\n", "const value = read() as any;\n"],
  ["src/lint.ts", 'const rule = "// eslint-disable-next-line no-console";\n', "// eslint-disable-next-line no-console\n"],
  ["src/check.ts", "const help = 'add @ts-ignore above the line';\n", "// @ts-ignore\n"],
  ["tests/test_lint.py", 'FIXTURE = "import os  # noqa: F401"\n', "import os  # noqa: F401\n"],
  ["tests/test_types.py", "SOURCE = '''x = f()  # type: ignore'''\n", "x = f()  # type: ignore\n"],
  ["src/lib.rs", 'const SRC: &str = r#"#[allow(dead_code)] fn f() {}"#;\n', "#[allow(dead_code)]\nfn f() {}\n"],
  ["src/Main.java", 'String doc = "@SuppressWarnings(\\"unchecked\\")";\n', '@SuppressWarnings("unchecked")\nclass Main {}\n'],
  ["lint_test.go", "const src = `x := 1 //nolint:ineffassign`\n", "x := 1 //nolint:ineffassign\n"],
  ["src/Program.cs", 'var src = @"#pragma warning disable CS0168";\n', "#pragma warning disable CS0168\n"],
];

test("a suppression pattern inside a string literal is test data, a real one still counts", () => {
  for (const [path, data, real] of SUPPRESSION_CASES) {
    expect([path, rules(path, "", data)]).toEqual([path, []]);
    expect([path, rules(path, "", real)]).toEqual([path, ["suppression"]]);
  }
});

test("tests, assertions and skips quoted as data are not counted", () => {
  const path = "tests/runner.test.ts";
  const real = 'test("adds", () => {\n  expect(add(1, 2)).toBe(3);\n});\n';
  // A test of a test runner carries test source as text: replacing it is not a removed test.
  const quoted = `${real}const SOURCE = \`test("x", () => { expect(1).toBe(1); });\`;\n`;
  expect(rules(path, quoted, real)).toEqual([]);
  expect(rules(path, real, `${real}const SKIPPED = "it.skip(\\"later\\")";\n`)).toEqual([]);
  expect(rules(path, real, `${real}it.skip("later", () => {});\n`)).toEqual(["skip"]);
  expect(rules(path, real, "")).toEqual(["test-count", "assertions"]);
});

test("a test-runner branch and a verification bypass still count when a string carries them", () => {
  expect(rules("src/env.ts", "", 'if (process.env.NODE_ENV === "test") return 1;\n')).toEqual(["test-hook"]);
  expect(rules("src/env.ts", "", 'const doc = "if NODE_ENV is test, skip the cache";\n')).toEqual([]);
  // A command in a string runs: the bypass is real.
  expect(rules("scripts/commit.ts", "", 'execSync("git commit --no-verify");\n')).toEqual(["verification-bypass"]);
  expect(rules("package.json", "{}\n", '{ "scripts": { "test": "jest --passWithNoTests" } }\n')).toEqual([
    "verification-bypass",
  ]);
});

test("string content is blanked in place and comments, quotes and code stay", () => {
  const text = 'const a: any = "b: any"; // it\'s fine\nconst t = `x\ny`;\nif (env === "test") {}\n';
  const blank = blankStringLiterals("a.ts", text);
  expect(blank.length).toBe(text.length);
  expect(blank.split("\n")).toEqual([
    'const a: any = "      "; // it\'s fine',
    "const t = ` ",
    " `;",
    'if (env === "test") {}',
    "",
  ]);
  // A Rust lifetime is code, so the string after it is still read as a string.
  expect(blankStringLiterals("a.rs", "fn f<'a>(s: &'a str) { g(\"x: any\") }\n")).toBe(
    "fn f<'a>(s: &'a str) { g(\"      \") }\n",
  );
  expect(blankStringLiterals("a.py", '"""Docs: any."""\nx = "# noqa"  # noqa\n')).toBe(
    '"""          """\nx = "      "  # noqa\n',
  );
  expect(blankStringLiterals("notes.yaml", "a: 'b: any'\n")).toBe("a: 'b: any'\n");
});

test("the code-quality rules for suppressions, any, unwrap and TODOs read code and comments only", async () => {
  const { checkBuiltinRules } = await import("../src/core/workflows/quality/rules.js");
  const found = (path: string, content: string) =>
    checkBuiltinRules([{ path, content, before: "" }], {}).map((f) => f.rule);
  expect(found("src/front.ts", 'export const sample = "custom_value: any text // TODO later";\n')).toEqual([]);
  expect(found("src/front.ts", "export const value: any = 1; // TODO later\n")).toEqual(["explicit-any", "todo-comment"]);
  expect(found("tests/fixture.test.ts", 'const src = "// @ts-ignore\\n// eslint-disable-line";\n')).toEqual([]);
  expect(found("tests/fixture.test.ts", "// @ts-ignore\n")).toEqual(["ts-ignore"]);
  expect(found("src/lib.rs", 'pub const DOC: &str = "call x.unwrap() here";\n')).toEqual([]);
  expect(found("src/lib.rs", "pub fn f() -> u8 { g().unwrap() }\n")).toEqual(["rust-unwrap"]);
  expect(found("src/tool.py", 'HELP = "add # noqa to silence"\n')).toEqual([]);
  expect(found("src/tool.py", "import os  # noqa\n")).toEqual(["lint-suppression"]);
});
