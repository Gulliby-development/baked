import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hasInlineRows, type InlineRowTest, inlineRowFile, withInlineRows } from "../src/core/workflows/acceptance-rows-inline.js";
import type { AcceptanceRow } from "../src/core/workflows/acceptance-rows-model.js";
import { writtenTestsCheck } from "../src/core/workflows/affected-tests.js";
import type { Check } from "../src/core/workflows/types.js";

// Scenario of bench round 54, lanewalk (Java 21, Maven, rowsAsData on), #1804. The brief said "one
// top-level type per file". Inline mode appended its rows as a second top-level class
// `<File>AcceptanceRowsTest` after the file's own class, in 7 of 17 test files, and restored it
// after every edit, so the task could not keep the brief's layout and nothing flagged it. The JUnit
// and xUnit blocks now go inside the file's own class.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const rows: AcceptanceRow[] = [
  { id: "AC-004:1", criterionId: "AC-004", source: '`["--lanes","2"]` | `2`', input: ["--lanes", "2"], expected: 2 },
  { id: "AC-004:2", criterionId: "AC-004", source: '`["--lanes","x"]` | `"bad lanes"`', input: ["--lanes", "x"], expected: "bad lanes" },
];
const BEGIN = "// BEGIN acceptance rows: cases from";
const END = "// END acceptance rows";

/** Top-level type declarations, at column 0 as Java and file-scoped C# files write them. */
const topLevelTypes = (text: string) => text.match(/^(?:public |final |abstract )*(?:class|record|interface|enum) \w+/gm) ?? [];

const java: InlineRowTest = { mode: "inline", framework: "junit", package: "com.ex.lanes", test: "src/test/java/com/ex/lanes/OptionsTest.java" };
const OPTIONS = `package com.ex.lanes;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/** Options of the command line: a "{" or class Fake { in a comment is not code. */
class OptionsTest {
    private static final String BRACE = "}";
    private static final char CLOSE = '}';
    private static final String BLOCK = """
        class InText {
        """;

    static Object acceptanceActual(Object input) {
        return Options.parse(input);
    }

    @Test
    void defaults() {
        assertEquals(1, Options.parse(java.util.List.of()));
    }

    static final class Lanes {
        int count;
    }
}
`;
/** What the R54 pin appended: a second top-level class after the file's own one. */
const PIN_BLOCK = `\n${BEGIN} from the audited spec table. Edit acceptanceActual, not this block.\nclass OptionsTestAcceptanceRowsTest {\n  @org.junit.jupiter.api.TestFactory\n  java.util.stream.Stream<org.junit.jupiter.api.DynamicTest> acceptanceRows() {\n    return java.util.stream.Stream.of();\n  }\n}\n${END}\n`;

describe("scenario: lanewalk OptionsTest, a brief with one top-level type per file (#1804)", () => {
  const file = inlineRowFile(java, rows);

  test("the JUnit rows are a @Nested class at the end of the file's own class", () => {
    const written = withInlineRows(OPTIONS, file);
    expect(topLevelTypes(written)).toEqual(["class OptionsTest"]);
    expect(written).toContain(`        int count;\n    }\n\n    ${BEGIN}`);
    expect(written).toContain("    @org.junit.jupiter.api.Nested\n    class AcceptanceRows {");
    expect(written.trimEnd()).toEndWith(`    ${END}\n}`);
    // Everything the agent wrote is kept as it was.
    expect(written.startsWith(OPTIONS.slice(0, OPTIONS.lastIndexOf("}")))).toBe(true);
    expect(withInlineRows(written, file)).toBe(written);
    expect(hasInlineRows(written, file)).toBe(true);
  });

  test("a file the pin wrote, with the block as a second top-level class, is moved into the class", () => {
    const pinned = `${OPTIONS}${PIN_BLOCK}`;
    expect(topLevelTypes(pinned)).toHaveLength(2);
    expect(hasInlineRows(pinned, file)).toBe(false);
    const moved = withInlineRows(pinned, file);
    expect(moved).toBe(withInlineRows(OPTIONS, file));
    expect(moved).not.toContain("OptionsTestAcceptanceRowsTest");
  });

  test("an edit that drops the block or moves it out of the class has it put back inside", () => {
    const written = withInlineRows(OPTIONS, file);
    const block = written.slice(written.indexOf(`    ${BEGIN}`), written.indexOf(END) + END.length + 1);
    const outside = `${written.replace(block, "").trimEnd()}\n\n${block.replace(/^ {4}/gm, "")}`;
    expect(hasInlineRows(outside, file)).toBe(false);
    expect(withInlineRows(outside, file)).toBe(written);
    expect(withInlineRows(OPTIONS.replace("    static final class Lanes", "    // more\n    static final class Lanes"), file)).toContain(`    ${BEGIN}`);
  });

  test("a file with no class yet gets the class named after it around the block", () => {
    const started = withInlineRows(null, file);
    expect(started.startsWith("package com.ex.lanes;\n\nclass OptionsTest {\n    // BEGIN")).toBe(true);
    expect(topLevelTypes(started)).toEqual(["class OptionsTest"]);
  });

  test("the rows report each failing row by its id", () => {
    expect(file.tail).toContain("normal(OptionsTest.acceptanceActual(input)), id)");
    // An inner class holds no static member, which needs Java 16.
    expect(file.tail).not.toContain("static");
  });
});

const check = (executable: string, args: string[]): Check =>
  ({ id: "tests", executable, args, cwd: ".", envNames: [], timeoutMs: 300_000, required: true, scope: "feature", writes: [] }) as unknown as Check;

describe("the test run of a file with nested rows names the nested class (#1804)", () => {
  const layouts = [
    { name: "Maven", run: check("mvn", ["-q", "test"]), test: java,
      args: ["-q", "test", "-Dtest=com.ex.lanes.OptionsTest,com.ex.lanes.OptionsTest$AcceptanceRows", "-Dsurefire.failIfNoSpecifiedTests=false"] },
    { name: "Gradle", run: check("./gradlew", ["test"]), test: java,
      args: ["test", "--tests", "com.ex.lanes.OptionsTest", "--tests", "com.ex.lanes.OptionsTest$AcceptanceRows"] },
    { name: "dotnet", run: check("dotnet", ["test"]), test: { mode: "inline", framework: "xunit", package: "Lanes.Tests", test: "Lanes.Tests/OptionsTests.cs" } as InlineRowTest,
      args: ["test", "--filter", "FullyQualifiedName~OptionsTests.|FullyQualifiedName~OptionsTests+AcceptanceRows."] },
  ];
  for (const layout of layouts)
    test(layout.name, () => {
      const root = mkdtempSync(join(tmpdir(), "baked-rows-one-type-"));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      mkdirSync(dirname(join(root, layout.test.test)), { recursive: true });
      writeFileSync(join(root, layout.test.test), withInlineRows(null, inlineRowFile(layout.test, rows)));
      expect(writtenTestsCheck(root, [layout.run], [{ path: layout.test.test, action: "modify" }])?.args).toEqual(layout.args);
    });
});

describe("xUnit rows in the file's own class (#1804)", () => {
  const cs: InlineRowTest = { mode: "inline", framework: "xunit", package: "Lanes.Tests", test: "Lanes.Tests/OptionsTests.cs" };
  const file = inlineRowFile(cs, rows);
  const members = `        private const string Brace = "}";
        private static readonly string Verbatim = @"a ""}"" b";
        private static readonly string Hole = $"{Brace} {{";
        private static readonly string Raw = """
            public class InText {
            """;

        public static object? AcceptanceActual(System.Text.Json.Nodes.JsonNode? input) => Options.Parse(input);
`;

  test("a braced namespace: the rows class nests in the file's class, two levels in", () => {
    const own = `namespace Lanes.Tests\n{\n    public class OptionsTests\n    {\n${members}    }\n}\n`;
    const written = withInlineRows(own, file);
    expect(written).toContain(`Options.Parse(input);\n\n        ${BEGIN}`);
    expect(written).toContain("        public class AcceptanceRows\n        {");
    expect(written.trimEnd()).toEndWith(`        ${END}\n    }\n}`);
    expect(withInlineRows(written, file)).toBe(written);
  });

  test("a file-scoped namespace: one top-level class", () => {
    const own = `namespace Lanes.Tests;\n\npublic sealed class OptionsTests\n{\n${members.replace(/^ {4}/gm, "")}}\n`;
    const written = withInlineRows(own, file);
    expect(written.match(/^public (?:sealed )?class \w+/gm)).toEqual(["public sealed class OptionsTests"]);
    expect(written.trimEnd()).toEndWith(`    ${END}\n}`);
    expect(hasInlineRows(written, file)).toBe(true);
  });

  test("a file with no class yet gets the namespace and the class around the block", () => {
    const started = withInlineRows(null, file);
    expect(started.startsWith("namespace Lanes.Tests\n{\n    public class OptionsTests\n    {\n        // BEGIN")).toBe(true);
    expect(withInlineRows("namespace Lanes.Tests;\n", file).startsWith("namespace Lanes.Tests;\n\npublic class OptionsTests\n{\n    // BEGIN")).toBe(true);
  });
});

describe("the other frameworks add no type, so their block still ends the file (#1804)", () => {
  const others: InlineRowTest[] = [
    { mode: "inline", framework: "bun", test: "tests/options.test.ts" },
    { mode: "inline", framework: "pytest", test: "tests/test_options.py" },
    { mode: "inline", framework: "go", package: "lanes", test: "lanes/options_test.go" },
    { mode: "inline", framework: "rust", test: "tests/options.rs" },
    { mode: "inline", framework: "rspec", test: "spec/options_spec.rb" },
    { mode: "inline", framework: "testthat", test: "tests/testthat/test-options.R" },
  ];
  for (const other of others)
    test(other.framework, () => {
      const file = inlineRowFile(other, rows);
      expect(file.nest).toBeUndefined();
      const written = withInlineRows(other.framework === "go" ? "package lanes\n" : "", file);
      expect(written.trimEnd()).toEndWith(`${["pytest", "rspec", "testthat"].includes(other.framework) ? "#" : "//"} END acceptance rows`);
    });
});

// #2335: PSR-1 keeps one class per PHP file, so the PHPUnit block is methods of the file's class.
describe("PHPUnit rows in the file's own class (#2335)", () => {
  const php: InlineRowTest = { mode: "inline", framework: "phpunit", package: "Lanes.Tests", test: "tests/OptionsTest.php" };
  const file = inlineRowFile(php, rows);
  const own = `<?php

namespace Lanes\\Tests;

use PHPUnit\\Framework\\TestCase;

# A "{" in a comment, and class Fake { in a string, are not code.
final class OptionsTest extends TestCase
{
    private const BRACE = '} class InText { a long single-quoted string with braces }';

    #[\\PHPUnit\\Framework\\Attributes\\Test]
    public function defaults(): void
    {
        $this->assertSame("}", self::BRACE[0]);
    }

    public static function acceptanceActual(mixed $input): mixed
    {
        return Options::parse($input);
    }
}
`;

  test("the rows are methods at the end of the file's own class, and a second write changes nothing", () => {
    const written = withInlineRows(own, file);
    expect(topLevelTypes(written)).toEqual(["final class OptionsTest"]);
    expect(written).toContain(`Options::parse($input);\n    }\n\n    ${BEGIN}`);
    expect(written).toContain("    public function test(): void\n    {");
    expect(written.trimEnd()).toEndWith(`    ${END}\n}`);
    expect(written.startsWith(own.slice(0, own.lastIndexOf("}")))).toBe(true);
    expect(withInlineRows(written, file)).toBe(written);
    expect(hasInlineRows(written, file)).toBe(true);
  });

  test("a block moved out of the class is put back inside", () => {
    const written = withInlineRows(own, file);
    const block = written.slice(written.indexOf(`    ${BEGIN}`), written.indexOf(END) + END.length + 1);
    const outside = `${written.replace(block, "").trimEnd()}\n\n${block.replace(/^ {4}/gm, "")}`;
    expect(hasInlineRows(outside, file)).toBe(false);
    expect(withInlineRows(outside, file)).toBe(written);
  });

  test("a file with no class yet starts with the open tag, the namespace, the import and the class", () => {
    const started = withInlineRows(null, file);
    expect(started.startsWith("<?php\n\nnamespace Lanes\\Tests;\n\nuse PHPUnit\\Framework\\TestCase;\n\nfinal class OptionsTest extends TestCase\n{\n    // BEGIN")).toBe(true);
    // The replay's harness without a class: the class is named in full, after the open tag.
    const harness = withInlineRows("function helper(): int\n{\n    return 1;\n}\n", file);
    expect(harness.startsWith("<?php\n\nfunction helper(): int")).toBe(true);
    expect(harness).toContain("final class OptionsTest extends \\PHPUnit\\Framework\\TestCase\n{");
  });

  test("the written-tests run of the file is the file itself", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-rows-one-type-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(dirname(join(root, php.test)), { recursive: true });
    writeFileSync(join(root, php.test), withInlineRows(own, file));
    expect(writtenTestsCheck(root, [check("php", ["vendor/bin/phpunit", "tests"])], [{ path: php.test, action: "modify" }])?.args).toEqual(["vendor/bin/phpunit", "./tests/OptionsTest.php"]);
  });
});
