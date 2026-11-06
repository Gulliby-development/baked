import { maskNonCode } from "../workflows/quality/code-mask.js";
import { type LanguageRecord, none, rowOf } from "./language-records.js";
import { isTestContent, isTestFile, TEST_MARKERS } from "./language-traits.js";
import { detectLanguageFromPath } from "./types.js";

/**
 * The tests a file declares, one row per supported language (#2368): a brief's cap ("no file has
 * more than 12 `test(...)` blocks", "at most 12 test methods per class") counts declarations,
 * never the rows of a table test or the subtests a test runs. The task-end cap check
 * (`verification/test-cap.ts`) and the test-integrity guard's `test-count` rule read the same
 * counts. Each row's patterns run over `maskNonCode` text, so a commented-out test or one quoted
 * as data is not counted.
 */
export interface TestDeclarationRow {
  /** One match per declared test: a test function, block or attribute, not a row or a subtest. */
  test: RegExp;
  /**
   * A class (or module, contract, implementation) declaration: the tests below it, up to the next
   * one, are its tests for a per-class cap. Absent where tests are not grouped in classes.
   */
  unit?: RegExp;
  /**
   * Tests `test` does not count one by one, matched over the file's text: a framework that
   * declares them in another form (Kotest's and ScalaTest's spec styles, Go's fuzz targets,
   * fast-check's `test.prop`, PHPUnit's `#[Test]` methods). A file that matches declares tests for
   * `declaresTest` (#2439); the caps do not count it.
   */
  spec?: RegExp;
  /** A test file of the language, counted by the parity fixture. */
  example: { path: string; text: string };
}

const JS_TESTS = /(?<![.\w$])(?:it|test)(?:\.(?:only|skip|todo|failing|concurrent|each))*\s*[(`]/g;
const jsExample = (path: string) => ({
  path,
  text: `describe("sum", () => {
  test("adds", () => expect(sum(1, 2)).toBe(3));
  it.skip("subtracts", () => {});
  // test("commented", () => {});
  const name = "test(";
});
test.each([[1, 2]])("pairs %d", (a, b) => {});
`,
});
/**
 * A test through a modifier `JS_TESTS` does not list (fast-check's `test.prop`, bun's and vitest's
 * `test.skipIf(...)`, `test.runIf(...)`), and Deno's `Deno.test`.
 */
const JS_SPEC = /(?<![.\w$])(?:it|test)(?:\.\w+)+\s*[(`]|\bDeno\.test\s*\(/;
const CLASS = /\bclass\s+\w+/g;

export const TEST_DECLARATIONS: LanguageRecord<TestDeclarationRow> = {
  typescript: { test: JS_TESTS, spec: JS_SPEC, example: jsExample("tests/sum.test.ts") },
  javascript: { test: JS_TESTS, spec: JS_SPEC, example: jsExample("tests/sum.test.js") },
  python: {
    test: /^[ \t]*(?:async[ \t]+)?def[ \t]+test\w*[ \t]*\(/gm,
    // pytest-bdd's `scenarios("x.feature")` declares a test per scenario.
    spec: /^[ \t]*scenarios[ \t]*\(/m,
    unit: /^[ \t]*class[ \t]+\w+/gm,
    example: {
      path: "tests/test_sum.py",
      text: `def test_adds():
    assert sum(1, 2) == 3

class TestSum:
    def test_zero(self):
        assert sum(0, 0) == 0

    def test_negative(self):
        assert sum(-1, 1) == 0

# def test_commented(): pass
SOURCE = "def test_quoted(): pass"
`,
    },
  },
  // Top-level test functions and testify suite methods; `t.Run` subtests and `TestMain` are not tests.
  go: {
    test: /^func[ \t]+(?:\([^)\n]*\)[ \t]*)?Test(?!Main\b)\w*[ \t]*\(/gm,
    // A fuzz target runs its seed corpus as tests.
    spec: /^func[ \t]+Fuzz\w*[ \t]*\(/m,
    example: {
      path: "sum_test.go",
      text: `package sum

import "testing"

func TestAdds(t *testing.T) {
	t.Run("zero", func(t *testing.T) {})
}

func TestNegative(t *testing.T) {}

func TestMain(m *testing.M) {}

// func TestCommented(t *testing.T) {}
`,
    },
  },
  // `#[test]`, `#[tokio::test]` and `#[rstest]`; its `#[case]` rows are not tests of their own.
  rust: {
    test: /#\[(?:\w+::)*(?:test|rstest)\b/g,
    spec: /#\[(?:\w+::)*(?:quickcheck|test_case)\b|\bquickcheck!\s*\{/,
    example: {
      path: "tests/sum.rs",
      text: `#[cfg(test)]
mod tests {
    #[test]
    fn adds() { assert_eq!(super::sum(1, 2), 3); }

    #[tokio::test]
    async fn waits() {}

    // #[test] fn commented() {}
}
`,
    },
  },
  java: {
    test: /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/g,
    unit: CLASS,
    // A qualified annotation (`@org.junit.jupiter.api.Test`), jqwik's properties and examples,
    // JUnit 3's `TestCase` subclasses.
    spec: /@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|Property|Example)\b|\bextends\s+TestCase\b/,
    example: {
      path: "src/test/java/SumTest.java",
      text: `import org.junit.jupiter.api.Test;

class SumTest {
    @Test
    void adds() {}

    @ParameterizedTest
    @ValueSource(ints = {1, 2})
    void rows(int n) {}

    // @Test void commented() {}
    String quoted = "@Test";
}
`,
    },
  },
  kotlin: {
    test: /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b/g,
    // A qualified annotation; Kotest's spec styles declare tests as strings and blocks, without one.
    spec: /@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b|\b(?:Fun|String|Behavior|Should|Describe|Expect|Feature|Word|Free|Annotation)Spec\s*[({]/,
    unit: /\b(?:class|object)\s+\w+/g,
    example: {
      path: "src/test/kotlin/SumTest.kt",
      text: `import kotlin.test.Test

class SumTest {
    @Test
    fun adds() {}

    @Test
    fun zero() {}

    // @Test fun commented() {}
}
`,
    },
  },
  scala: {
    test: /(?<![.\w$])test\s*\(|@Test\b/g,
    // ScalaTest's spec styles, specs2 and ScalaCheck properties.
    spec: /\b(?:Any)?(?:FlatSpec|FunSpec|WordSpec|FreeSpec|FeatureSpec|PropSpec)(?:Like)?\b|\bSpecification\b|(?<![.\w$])property\s*\(/,
    unit: /\b(?:class|object)\s+\w+/g,
    example: {
      path: "src/test/scala/SumSuite.scala",
      text: `class SumSuite extends munit.FunSuite {
  test("adds") { assertEquals(1 + 2, 3) }
  test("zero") { assertEquals(0 + 0, 0) }
  // test("commented") {}
}
`,
    },
  },
  // xUnit, NUnit and MSTest test methods; `[InlineData]` and `[TestCase]` rows are not tests of their own.
  csharp: {
    test: /\[\s*(?:Fact|Theory|Test|TestMethod|DataTestMethod)\b/g,
    // A qualified attribute (`[global::Xunit.Theory]`) and FsCheck's `[Property]`.
    spec: /\[\s*(?:global::)?(?:[\w.]+\.)?(?:Fact|Theory|Test|TestMethod|DataTestMethod|Property)\b/,
    unit: CLASS,
    example: {
      path: "Calc.Tests/SumTests.cs",
      text: `using Xunit;

public class SumTests
{
    [Fact]
    public void Adds() => Assert.Equal(3, Sum.Of(1, 2));

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public void Rows(int n) => Assert.True(n > 0);

    // [Fact] public void Commented() {}
}

public class OtherTests
{
    [Fact]
    public void Zero() => Assert.Equal(0, Sum.Of(0, 0));
}
`,
    },
  },
  // Check's `START_TEST`, Criterion's `Test`, Unity's `void test_name(void)` definitions (not
  // their forward declarations or `RUN_TEST` lines).
  c: {
    test: /^[ \t]*(?:START_TEST|Test|TEST(?:_F|_P)?)[ \t]*\(|^[ \t]*void[ \t]+test_?\w*[ \t]*\([ \t]*void[ \t]*\)[ \t]*\n?[ \t]*\{/gm,
    example: {
      path: "tests/test_sum.c",
      text: `#include "unity.h"

void setUp(void) {}
void test_adds(void);

void test_adds(void) {
    TEST_ASSERT_EQUAL(3, sum(1, 2));
}

void test_zero(void)
{
    TEST_ASSERT_EQUAL(0, sum(0, 0));
}

int main(void) {
    RUN_TEST(test_adds);
    RUN_TEST(test_zero);
    return 0;
}
`,
    },
  },
  // Catch2's `SECTION`s run inside a test case and are not tests of their own.
  cpp: {
    test: /^[ \t]*(?:(?:TYPED_)?TEST(?:_F|_P)?|TYPED_TEST_P|TEST_CASE|SCENARIO|BOOST_AUTO_TEST_CASE)[ \t]*\(/gm,
    example: {
      path: "tests/sum_test.cpp",
      text: `#include <gtest/gtest.h>

TEST(Sum, Adds) { EXPECT_EQ(sum(1, 2), 3); }
TEST_F(SumFixture, Zero) { EXPECT_EQ(sum(0, 0), 0); }
// TEST(Sum, Commented) {}
`,
    },
  },
  ruby: {
    test: /^[ \t]*(?:it|specify|example|scenario|test)\b(?=[ \t]*[("'{]|[ \t]+do\b)|^[ \t]*def[ \t]+test_\w*/gm,
    // Shared examples, an example named by a variable (`it id do`), a Minitest method defined in a loop.
    spec: /^[ \t]*(?:it_behaves_like|it_should_behave_like|include_examples)\b|^[ \t]*(?:it|specify|test)[ \t]+[\w@:]|\bdefine_method[ \t]*\(?[ \t]*["':]test_/m,
    unit: /^[ \t]*class[ \t]+\w+/gm,
    example: {
      path: "test/sum_test.rb",
      text: `require "minitest/autorun"

class SumTest < Minitest::Test
  def test_adds
    assert_equal 3, Sum.of(1, 2)
  end

  test "zero" do
    assert_equal 0, Sum.of(0, 0)
  end

  # def test_commented; end
end
`,
    },
  },
  php: {
    test: /^[ \t]*(?:(?:public|protected|private|static|final)[ \t]+)*function[ \t]+test\w*[ \t]*\(|^[ \t]*(?:it|test)[ \t]*\(/gm,
    // PHPUnit's `#[Test]` attribute and `@test` annotation on a method of any name.
    spec: /#\[\s*(?:\\?PHPUnit\\Framework\\Attributes\\)?Test\b|@test\b/,
    unit: CLASS,
    example: {
      path: "tests/SumTest.php",
      text: `<?php
use PHPUnit\\Framework\\TestCase;

final class SumTest extends TestCase
{
    public function testAdds(): void
    {
        $this->assertSame(3, sum(1, 2));
    }

    public function testZero(): void
    {
        $this->assertSame(0, sum(0, 0));
    }

    // public function testCommented(): void {}
}
`,
    },
  },
  // XCTest's `func test...()` and Swift Testing's `@Test`, counted once for `@Test func testName()`.
  swift: {
    test: /@Test\b|(?<!@Test\b[^\n]*\s*)^[ \t]*(?:(?:override|public|private|internal|static|final|@MainActor|async)[ \t]+)*func[ \t]+test\w*[ \t]*\(/gm,
    unit: /\b(?:class|struct|extension)\s+\w+/g,
    example: {
      path: "Tests/SumTests/SumTests.swift",
      text: `import XCTest

final class SumTests: XCTestCase {
    func testAdds() {
        XCTAssertEqual(sum(1, 2), 3)
    }

    // func testCommented() {}
}

struct SumSuite {
    @Test func zero() {
        #expect(sum(0, 0) == 0)
    }

    @Test("named")
    func testNamed() {}
}
`,
    },
  },
  // busted's `it` blocks and LuaUnit's test functions.
  lua: {
    test: /(?<![.:\w])it[ \t]*\(|^[ \t]*function[ \t]+(?:\w+[.:])?[Tt]est\w*[ \t]*\(/gm,
    example: {
      path: "spec/sum_spec.lua",
      text: `describe("sum", function()
  it("adds", function()
    assert.are.equal(3, sum(1, 2))
  end)
  it("zero", function()
    assert.are.equal(0, sum(0, 0))
  end)
  -- it("commented", function() end)
end)
`,
    },
  },
  elixir: {
    test: /^[ \t]*test[ \t]+"/gm,
    // A test named by an expression (`test @row["id"] do`), StreamData's `property`, ExUnit's `doctest`.
    spec: /^[ \t]*(?:test[ \t]+[@\w(]|property[ \t]+"|doctest[ \t]+\w)/m,
    unit: /^[ \t]*defmodule\b/gm,
    example: {
      path: "test/sum_test.exs",
      text: `defmodule SumTest do
  use ExUnit.Case

  test "adds" do
    assert Sum.of(1, 2) == 3
  end

  test "zero", %{} do
    assert Sum.of(0, 0) == 0
  end

  # test "commented" do
end
`,
    },
  },
  // package:test's `test` and flutter_test's `testWidgets` blocks; `group` is not a test.
  dart: {
    test: /(?<![.\w$])(?:test|testWidgets)[ \t]*\(/g,
    // Through an import prefix: `import 'package:test/test.dart' as t;` then `t.test(...)`.
    spec: /(?<=\w)\.(?:test|testWidgets)[ \t]*\(/,
    example: {
      path: "test/sum_test.dart",
      text: `import 'package:test/test.dart';

void main() {
  group('sum', () {
    test('adds', () => expect(sum(1, 2), 3));
    test('zero', () => expect(sum(0, 0), 0));
  });
  testWidgets('renders', (tester) async {});
  // test('commented', () {});
}
`,
    },
  },
  zig: {
    test: /^[ \t]*test\b[ \t]*(?:"|\{|[A-Za-z_])/gm,
    example: {
      path: "src/sum_test.zig",
      text: `const std = @import("std");

test "adds" {
    try std.testing.expectEqual(@as(i32, 3), sum(1, 2));
}

test {
    _ = @import("sum.zig");
}

// test "commented" {}
`,
    },
  },
  // bats' `@test` blocks and shUnit2's `test...()` functions.
  bash: {
    test: /^[ \t]*@test\b|^[ \t]*(?:function[ \t]+)?test\w*[ \t]*\([ \t]*\)/gm,
    example: {
      path: "test/sum.bats",
      text: `#!/usr/bin/env bats

@test "adds" {
  [ "$(sum 1 2)" -eq 3 ]
}

@test "zero" {
  [ "$(sum 0 0)" -eq 0 ]
}

# @test "commented" {}
`,
    },
  },
  // Alcotest's `test_case`, OUnit's `"name" >::` and ppx_inline_test's `let%test`.
  ocaml: {
    test: /\btest_case[ \t]+"|"[ \t]*>::|^[ \t]*let%(?:test|test_unit|expect_test)\b/gm,
    example: {
      path: "test/test_sum.ml",
      text: `let test_adds () = Alcotest.(check int) "same" 3 (Sum.sum 1 2)

let () =
  Alcotest.run "sum"
    [ ("sum", [ Alcotest.test_case "adds" \`Quick test_adds;
                Alcotest.test_case "zero" \`Quick test_adds ]) ]
(* Alcotest.test_case "commented" \`Quick test_adds *)
`,
    },
  },
  objc: {
    test: /^[ \t]*-[ \t]*\([ \t]*void[ \t]*\)[ \t]*test\w*/gm,
    unit: /^[ \t]*@implementation[ \t]+\w+/gm,
    example: {
      path: "Tests/SumTests.m",
      text: `#import <XCTest/XCTest.h>

@interface SumTests : XCTestCase
@end

@implementation SumTests
- (void)testAdds {
    XCTAssertEqual(sum(1, 2), 3);
}
- (void)testZero {
    XCTAssertEqual(sum(0, 0), 0);
}
// - (void)testCommented {}
@end
`,
    },
  },
  vue: none(
    "Vue components are tested from `.spec.ts` or `.test.ts` files, which the TypeScript row counts",
  ),
  svelte: none(
    "Svelte components are tested from `.spec.ts` or `.test.ts` files, which the TypeScript row counts",
  ),
  rescript: {
    test: /(?<![.\w$])(?:test|it|testAsync|testPromise)[ \t]*\(/g,
    example: {
      path: "__tests__/Sum_test.res",
      text: `open Jest

describe("sum", () => {
  test("adds", () => Expect.expect(Sum.sum(1, 2))->Expect.toBe(3))
  test("zero", () => Expect.expect(Sum.sum(0, 0))->Expect.toBe(0))
  // test("commented", () => ())
})
`,
    },
  },
  // Foundry's `test...` and `invariant...` functions.
  solidity: {
    test: /^[ \t]*function[ \t]+(?:test|invariant)\w*[ \t]*\(/gm,
    unit: /\bcontract\s+\w+/g,
    example: {
      path: "test/Sum.t.sol",
      text: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

contract SumTest is Test {
    function setUp() public {}

    function test_Adds() public {
        assertEq(uint256(1 + 2), 3);
    }

    function testFuzz_Zero(uint256 x) public {
        assertEq(x - x, 0);
    }

    // function test_Commented() public {}
}
`,
    },
  },
  sql: none(
    "pgTAP plans assertions, not test declarations, and tSQLt's tests are procedures named by a convention inside quoted identifiers",
  ),
  // Pester's `It` blocks; PowerShell keywords are case-insensitive.
  powershell: {
    test: /^[ \t]*It\b[ \t]+(?:['"]|-\w)/gim,
    example: {
      path: "tests/Sum.Tests.ps1",
      text: `Describe 'Sum' {
    It 'adds' {
        Get-Sum 1 2 | Should -Be 3
    }
    it 'zero' {
        Get-Sum 0 0 | Should -Be 0
    }
    # It 'commented' {}
}
`,
    },
  },
  r: {
    test: /\btest_that[ \t]*\(/g,
    // testthat's BDD style, `describe("x", { it("y", ...) })`.
    spec: /(?<![.\w])it[ \t]*\(/,
    example: {
      path: "tests/testthat/test-sum.R",
      text: `test_that("adds", {
  expect_equal(sum2(1, 2), 3)
})
test_that("zero", {
  expect_equal(sum2(0, 0), 0)
})
# test_that("commented", {})
`,
    },
  },
};

export interface DeclaredTests {
  /** The tests the file declares. */
  tests: number;
  /** The tests of each class, in the order of the file; empty where the row has no `unit`. */
  units: number[];
}

/**
 * The tests a file declares by its language's `TEST_DECLARATIONS` row, over its code with comments
 * and string content masked. Null for a language without a row. A test belongs to the last class
 * declared above it, so tests after a nested class are counted with it.
 */
export function declaredTests(path: string, text: string): DeclaredTests | null {
  const row = rowOf(TEST_DECLARATIONS, detectLanguageFromPath(path));
  if (!row) return null;
  const code = maskNonCode(path, text);
  const at = [...code.matchAll(new RegExp(row.test.source, flags(row.test)))].map((m) => m.index);
  if (!row.unit) return { tests: at.length, units: [] };
  const starts = [...code.matchAll(new RegExp(row.unit.source, flags(row.unit)))].map(
    (m) => m.index,
  );
  const units = starts.map(
    (from, i) => at.filter((index) => index >= from && index < (starts[i + 1] ?? Infinity)).length,
  );
  return { tests: at.length, units };
}

const flags = (pattern: RegExp): string =>
  pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;

/**
 * Whether a test file declares a test its runner would run (#2439): a test the language's
 * `TEST_DECLARATIONS` row counts in its code, or a form its `spec` matches. A test-tree file that
 * declares none is a support file (fixtures, constants, a harness the tests load), and a name its
 * language shares with domain code without a test marker is source (`isTestContent`, #1848):
 * neither runs a test, so a check that requires tests must not run it alone. A language without a
 * declarations row decides by its `TEST_MARKERS` row, or by the name where it has neither.
 * trailspin (bench round 77): T005 wrote a constants-only `fixtures_test.go`, its tests-written
 * check ran no test and failed, and the correction put a test into a file the request gave
 * verbatim.
 */
export function declaresTest(path: string, text: string): boolean {
  if (isTestFile(path) && !isTestContent(path, text)) return false;
  const language = detectLanguageFromPath(path);
  const row = rowOf(TEST_DECLARATIONS, language);
  if (row) return (declaredTests(path, text)?.tests ?? 0) > 0 || row.spec?.test(text) === true;
  return rowOf(TEST_MARKERS, language)?.test(text) ?? true;
}
