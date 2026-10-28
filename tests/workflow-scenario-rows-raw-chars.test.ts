import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type RowsArtifact, rowFiles } from "../src/core/workflows/acceptance-rows.js";
import {
  hasInlineRows,
  INLINE_ROWS_BEGIN,
  type InlineRowTest,
  inlineRowFile,
  LITERAL_ESCAPED,
  withInlineRows,
} from "../src/core/workflows/acceptance-rows-inline.js";
import type { AcceptanceRow } from "../src/core/workflows/acceptance-rows-model.js";
import type { Task } from "../src/core/workflows/types.js";

// Bench round 64, cfgquill lint (#1995). Row AC-004 was `["\ufeff#😀\r\r\n#\u2028\r",{}]`. The
// host wrote the Go block with the U+FEFF raw inside a string literal, which Go rejects anywhere
// but the start of a file ("illegal byte order mark"), so gofmt, vet and the tests failed before
// any model action. Every model escaped it; the block check compared bytes and put the raw
// character back each time: 9.72M tokens, 86 percent of the feature.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
// The test preload points HOME at an empty profile, where rustup finds no default toolchain;
// os.homedir() still names the real home. Without this the rust case passed only when an earlier
// file of its shard had set these (a macOS shard of #2269 ran it first: "no default is configured").
process.env.RUSTUP_HOME ??= join(homedir(), ".rustup");
process.env.CARGO_HOME ??= join(homedir(), ".cargo");

/** Every class of character the brief of R64 held, and the ones a literal may not hold raw. */
const RAW = "\ufeff\u200b\u00a0\u3000\u2028\u2029\u0085\r\u0000\u0007\u202e\u{e0001}😀 x\t\"'\\";
const rows: AcceptanceRow[] = [
  { id: "AC-004:1", criterionId: "AC-004", source: "spec", input: ["\ufeff#😀\r\r\n#\u2028\r", {}], expected: ["\ufeff#😀\r\r\n#\u2028\r", {}] },
  { id: "AC-004:2", criterionId: "AC-004", source: "spec", input: { [RAW]: [RAW, null, 1.5] }, expected: { [RAW]: [RAW, null, 1.5] } },
];

const INLINE: Record<InlineRowTest["framework"], InlineRowTest> = {
  bun: { mode: "inline", framework: "bun", test: "tests/lint.test.ts" },
  pytest: { mode: "inline", framework: "pytest", test: "tests/test_lint.py" },
  go: { mode: "inline", framework: "go", package: "lint", test: "lint/rules_test.go" },
  junit: { mode: "inline", framework: "junit", package: "com.ex.lint", test: "src/test/java/com/ex/lint/RulesTest.java" },
  rust: { mode: "inline", framework: "rust", test: "tests/rules.rs" },
  xunit: { mode: "inline", framework: "xunit", package: "Lint.Tests", test: "Lint.Tests/RulesTests.cs" },
  rspec: { mode: "inline", framework: "rspec", test: "spec/rules_spec.rb" },
  phpunit: { mode: "inline", framework: "phpunit", package: "Lint.Tests", test: "tests/RulesTest.php" },
  testthat: { mode: "inline", framework: "testthat", test: "tests/testthat/test-rules.R" },
  busted: { mode: "inline", framework: "busted", test: "spec/rules_spec.lua" },
  minitest: { mode: "inline", framework: "minitest", test: "test/rules_test.rb" },
  pest: { mode: "inline", framework: "pest", test: "tests/RulesTest.php" },
  exunit: { mode: "inline", framework: "exunit", test: "test/rules_test.exs" },
};

/** A block's text with the line breaks and indentation of its own layout taken out. */
const literalText = (text: string) => text.replace(/[\n\t]/g, "");

describe("host-written literals hold no invisible character raw (#1995)", () => {
  test.each(Object.entries(INLINE))("%s inline block", (_name, rowTest) => {
    const file = inlineRowFile(rowTest, rows);
    const text = `${file.head ?? ""}${file.tail}`;
    expect([...literalText(text).matchAll(LITERAL_ESCAPED)].map((m) => m[0])).toEqual([]);
  });

  test("the C# file-mode test", () => {
    const rowTest = { framework: "xunit", package: "Lint.Tests", harness: "Lint.Tests/Harness.cs", test: "Lint.Tests/RowsTest.cs", data: "Lint.Tests/rows.json" };
    const task = { id: "T003", rows: ["AC-004"], rowTest } as unknown as Task;
    const [, test] = rowFiles(task, { tasks: [{ id: "T003", rows: ["AC-004"], rowTest }], rows } as unknown as RowsArtifact);
    expect(test?.content).toContain("private const string Rows = ");
    expect([...literalText(test?.content ?? "").matchAll(LITERAL_ESCAPED)].map((m) => m[0])).toEqual([]);
  });
});

/** A project per framework whose harness returns its input, so a row passes only if it reads back whole. */
const PROJECTS: Partial<Record<InlineRowTest["framework"], { files: Record<string, string>; existing: string; run: string[][] }>> = {
  go: {
    files: { "go.mod": "module example.com/lint\n\ngo 1.21\n" },
    existing: "package lint\n\nfunc acceptanceActual(input any) (any, error) {\n\treturn input, nil\n}\n",
    run: [["go", "test", "./..."]],
  },
  bun: {
    files: { "package.json": '{"name":"lint","private":true}\n' },
    existing: "function acceptanceActual(input: unknown): unknown {\n  return input;\n}\n",
    run: [[process.execPath, "test", "./tests/lint.test.ts"]],
  },
  pytest: {
    files: {},
    existing: "def acceptance_actual(value):\n    return value\n",
    run: [["python3", "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests/test_lint.py"]],
  },
  rust: {
    files: {},
    existing: "fn acceptance_actual(input: &AcceptanceJson) -> AcceptanceJson {\n    input.clone()\n}\n",
    run: [["rustc", "--edition", "2021", "--test", "tests/rules.rs", "-o", "rules-test"], ["./rules-test"]],
  },
  rspec: {
    files: {},
    existing: "# frozen_string_literal: true\n\ndef acceptance_actual(input)\n  input\nend\n",
    run: [["rspec", "spec/rules_spec.rb"]],
  },
  phpunit: {
    files: {},
    existing: "<?php\n\nnamespace Lint\\Tests;\n\nuse PHPUnit\\Framework\\TestCase;\n\nfinal class RulesTest extends TestCase\n{\n    public static function acceptanceActual(mixed $input): mixed\n    {\n        return $input;\n    }\n}\n",
    run: [["phpunit", "tests/RulesTest.php"]],
  },
  testthat: {
    files: {},
    existing: "acceptance_actual <- function(input) {\n  input\n}\n",
    run: [["Rscript", "-e", "testthat::test_dir('tests/testthat', stop_on_failure = TRUE)"]],
  },
  busted: {
    files: {},
    existing: "local function acceptance_actual(input)\n\treturn input\nend\n",
    run: [["busted", "spec/rules_spec.lua"]],
  },
  minitest: {
    files: {},
    existing: "# frozen_string_literal: true\n\nrequire 'minitest/autorun'\n\ndef acceptance_actual(input)\n  input\nend\n",
    run: [["ruby", "test/rules_test.rb"]],
  },
  pest: {
    files: {},
    existing: "<?php\n\n$acceptanceActual = function (mixed $input): mixed {\n    return $input;\n};\n",
    run: [["pest", "tests/RulesTest.php"]],
  },
  exunit: {
    files: {
      "mix.exs": "defmodule Rules.MixProject do\n  use Mix.Project\n\n  def project, do: [app: :rules, version: \"0.1.0\", deps: []]\nend\n",
      ".formatter.exs": "[inputs: [\"{mix,.formatter}.exs\", \"test/**/*.exs\"]]\n",
      "test/test_helper.exs": "ExUnit.start()\n",
    },
    existing: "defmodule RulesTest do\n  use ExUnit.Case\n\n  defp acceptance_actual(input), do: input\nend\n",
    run: [["mix", "test"], ["mix", "format", "--check-formatted"]],
  },
};

const has = (command: string[]) => {
  try {
    return Bun.spawnSync(command, { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
};
const AVAILABLE: Record<string, boolean> = {
  go: has(["go", "version"]) && Bun.which("gofmt") !== null,
  bun: true,
  pytest: has(["python3", "-m", "pytest", "--version"]),
  rust: has(["rustc", "--version"]) && process.platform !== "win32",
  rspec: Bun.which("rspec") !== null,
  phpunit: Bun.which("phpunit") !== null,
  testthat: has(["Rscript", "-e", "library(testthat); library(jsonlite)"]),
  busted: Bun.which("busted") !== null,
  minitest: has(["ruby", "-e", "require 'minitest'"]),
  pest: Bun.which("pest") !== null,
  // JSON is in Elixir's standard library from 1.18.
  exunit: has(["elixir", "-e", 'JSON.decode!("1")']),
};

describe("scenario: cfgquill lint R64, rows with a U+FEFF run in the project's own toolchain (#1995)", () => {
  test.each(Object.keys(PROJECTS).map((name) => [name]))("%s: the block compiles, is formatted, and every row reads back whole", (name) => {
    const framework = name as InlineRowTest["framework"];
    const project = PROJECTS[framework];
    if (!project || !AVAILABLE[framework]) return;
    const root = mkdtempSync(join(tmpdir(), `baked-raw-rows-${framework}-`));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const rowTest = INLINE[framework];
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    for (const [path, text] of Object.entries(project.files)) write(path, text);
    write(rowTest.test, withInlineRows(project.existing, inlineRowFile(rowTest, rows)));
    for (const command of project.run) {
      const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, GOFLAGS: "-mod=mod" } });
      expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
    }
    if (framework === "go") {
      // R64: `gofmt -l` named the file, with "illegal byte order mark" at 26:2217.
      const fmt = Bun.spawnSync(["gofmt", "-l", "-e", "."], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(fmt.stdout.toString() + fmt.stderr.toString()).toBe("");
    }
  }, 120_000);
});

describe("the block check compares what the block means (#1995)", () => {
  const go = inlineRowFile(INLINE.go, rows.slice(0, 1));
  const written = withInlineRows("package lint\n", go);

  test("a block whose literal spells a row's character another way is the host's block", () => {
    // What every R64 session did: write the character as a Go escape instead of the JSON one.
    const respelled = written.replace("\\\\ufeff", "\\ufeff");
    expect(respelled).not.toBe(written);
    expect(hasInlineRows(respelled, go)).toBe(true);
    expect(withInlineRows(respelled, go)).toBe(respelled);
  });

  test("a block whose row changed is put back", () => {
    const changed = written.replace("#\\\\u2028", "#x");
    expect(changed).not.toBe(written);
    expect(hasInlineRows(changed, go)).toBe(false);
    expect(withInlineRows(changed, go)).toBe(written);
  });
});

describe("delivered block markers (#2004)", () => {
  test("the first line names the spec's acceptance table, not the tool", () => {
    for (const rowTest of Object.values(INLINE)) {
      const file = inlineRowFile(rowTest, rows);
      expect(file.tail).not.toContain("host-written");
      expect(INLINE_ROWS_BEGIN.test(file.tail)).toBe(true);
    }
  });

  test("a block written with the earlier words is still the host's block, and is found", () => {
    const go = inlineRowFile(INLINE.go, rows.slice(0, 1));
    const written = withInlineRows("package lint\n", go);
    const earlier = written.replaceAll(": cases from the spec's acceptance table.", ": host-written from the audited spec table.");
    expect(earlier).toContain("BEGIN acceptance rows: host-written");
    expect(INLINE_ROWS_BEGIN.test(earlier)).toBe(true);
    expect(hasInlineRows(earlier, go)).toBe(true);
  });
});
