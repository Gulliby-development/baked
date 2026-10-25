import { describe, expect, test } from "bun:test";
import {
  isCodeFile,
  isManifestFile,
  isTestFile,
  LANGUAGE_TRAITS,
} from "../src/core/intelligence/language-traits.js";
import { EXT_TO_LANGUAGE } from "../src/core/intelligence/types.js";
import { isTestCodePath } from "../src/core/workflows/quality/duplication.js";
import { isCodePath } from "../src/core/workflows/check-policy.js";
import { fileKind } from "../src/core/workflows/sizing.js";
import { isTestPath } from "../src/core/workflows/test-integrity.js";
import { isSourcePath } from "../src/core/workflows/workspace-facts.js";
import { TEST_FILE } from "../src/core/verification/output-counts.js";
import { testOrDocFile } from "../src/core/verification/convergence-stop.js";

// One language table for the workflow rules (#1488). The lists used to disagree: `.lua` was a
// language but not code for lint scoping, busted's `spec/` tests were test files for search but
// not for test integrity, and each site had its own manifest list.

const codeExtensions = Object.entries(EXT_TO_LANGUAGE)
  .filter(([, language]) => LANGUAGE_TRAITS[language]?.code)
  .map(([extension]) => extension);

describe("the language table", () => {
  test("every extension of a programming language is code and source for every rule", () => {
    expect(codeExtensions.length).toBeGreaterThan(40);
    for (const extension of codeExtensions) {
      const path = `src/module${extension}`;
      expect({ path, code: isCodePath(path), source: isSourcePath(path), test: isTestPath(path) }).toEqual({
        path,
        code: true,
        source: true,
        test: false,
      });
    }
  });

  test("the languages the per-language issues name are code (#1489-#1500)", () => {
    // SQL is a language since #1499: SQLFluff lints it, so a task that writes SQL gets the lint gate.
    for (const path of ["a.lua", "a.luau", "a.dart", "a.scala", "a.kt", "a.c", "a.cc", "a.hpp", "a.swift", "a.rb", "a.php", "a.sh", "a.svelte", "a.pyi", "a.sql", "a.ps1", "a.psm1", "a.R", "a.r"])
      expect([path, isCodeFile(path)]).toEqual([path, true]);
  });

  test("markup and styles are source but not code", () => {
    for (const path of ["a.css", "a.scss", "a.html"]) {
      expect([path, isSourcePath(path), isCodePath(path)]).toEqual([path, true, false]);
    }
    for (const path of ["README.md", "data.json", "notes.txt", "Makefile"]) expect([path, isSourcePath(path)]).toEqual([path, false]);
  });

  // Each convention, with a near miss that is not a test.
  const tests: [string, string][] = [
    ["src/sum.test.ts", "src/sum.ts"],
    ["tests/test_sum.py", "src/testing.py"],
    ["pkg/sum_test.go", "pkg/sum.go"],
    ["tests/sum.rs", "src/sum.rs"],
    ["src/test/java/com/acme/SumTest.java", "src/main/java/com/acme/Sum.java"],
    ["app/SumSpec.scala", "app/Sum.scala"],
    ["Tests/SumTests.cs", "src/Sum.cs"],
    ["spec/sum_spec.rb", "lib/sum.rb"],
    ["spec/sum_spec.lua", "src/sum.lua"],
    ["lib/sum_spec.lua", "lib/spectrum.lua"],
    ["test/sum_test.dart", "lib/sum.dart"],
    ["tests/Unit/SumTest.php", "src/Sum.php"],
    ["SumTests.swift", "Sum.swift"],
    ["sum_test.exs", "sum.ex"],
    ["test_sum.c", "sum.c"],
    // #1683: Django, Rust test modules, .NET test projects, NestJS end-to-end tests.
    ["polls/tests.py", "src/tests_helpers.py"],
    ["src/parser/tests.rs", "src/parser/contests.rs"],
    ["src/lib_tests.rs", "src/lib.rs"],
    ["App.Tests/CalculatorShould.cs", "App/Calculator.cs"],
    ["src/App.UnitTests/Adding/WhenAdding.cs", "src/App/Adding.cs"],
    ["src/app.e2e-spec.ts", "src/app.controller.ts"],
  ];
  test("every language's test files are tests for test integrity, sizing, duplication, baselines and review notes alike", () => {
    for (const [test, near] of tests) {
      expect({
        test,
        integrity: isTestPath(test),
        shared: isTestFile(test),
        sizing: fileKind(test),
        duplication: isTestCodePath(test),
        baseline: TEST_FILE.test(test),
        notes: testOrDocFile(test),
      }).toEqual({ test, integrity: true, shared: true, sizing: "test", duplication: true, baseline: true, notes: true });
      expect([near, isTestPath(near), fileKind(near)]).toEqual([near, false, "code"]);
    }
  });

  test("specs/ holds a workflow's specifications, not tests", () => {
    expect(isTestPath("specs/feature/spec.json")).toBe(false);
    expect(isTestPath("spec/models/user_spec.rb")).toBe(true);
  });

  test("manifests of every language are manifests", () => {
    for (const path of [
      "package.json",
      "tsconfig.build.json",
      "pyproject.toml",
      "requirements-dev.txt",
      "go.mod",
      "go.work",
      "Cargo.toml",
      "pom.xml",
      "settings.gradle.kts",
      "App.csproj",
      "Gemfile",
      "composer.json",
      "mix.exs",
      "pubspec.yaml",
      "build.sbt",
      "Package.swift",
      "CMakeLists.txt",
      "rocks/sum-1.0-1.rockspec",
      "Makefile",
      "justfile",
    ])
      expect([path, isManifestFile(path), fileKind(path)]).toEqual([path, true, "manifest"]);
    expect(isManifestFile("src/package.ts")).toBe(false);
  });
});
