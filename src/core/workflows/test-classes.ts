import { readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { type LanguageRecord, none, rowOf } from "../intelligence/language-records.js";
import { detectLanguageFromPath } from "../intelligence/types.js";
import { INLINE_ROWS_BEGIN } from "./acceptance-rows-inline.js";
import { maskNonCode } from "./quality/code-mask.js";

/**
 * A test class a written-tests check selects by name (#2363): the runner's fully qualified name of
 * a top-level type of a test file that holds a test, and whether the inline acceptance rows block
 * (#1763) is nested in it.
 */
export interface TestClass {
  name: string;
  rows: boolean;
}

/**
 * How a language's test runner names the test classes of a file, for a runner the host narrows by
 * class (`dotnet test --filter`, maven's `-Dtest`, gradle's `--tests`).
 */
export interface TestClassReader {
  /** What marks a type as holding a test: a test attribute, annotation or test base class. */
  marker: RegExp;
  /** `package a.b` applies to the whole file (Java, Kotlin); C#'s `namespace` may be a block. */
  scope: "package" | "namespace";
  /**
   * The class the compiler puts a file's top-level functions in (Kotlin's `FileKt`), named by the
   * file and its `@file:JvmName`; absent where a test is always a member of a declared type.
   */
  fileClass?: (path: string, text: string) => string;
  /** A test file whose class is not named like the file, for the language's parity golden. */
  example: { path: string; text: string };
}

const JVM_TEST =
  /@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|Property|Example)\b/;

/**
 * The test classes of each language whose runner the host narrows by class (#2363), one row per
 * supported language. A file's name is not its class: maskback (bench round 75) wrote the class
 * `FailureExceptionTests` into the scaffold's `UnitTest1.cs`, the filter `FullyQualifiedName~UnitTest1.`
 * selected no test and the run spent 1.31M tokens keeping a `UnitTest1` class to satisfy it.
 */
export const TEST_CLASSES: LanguageRecord<TestClassReader> = {
  typescript: none("bun test, vitest, jest and node --test take the test file's path"),
  javascript: none("bun test, vitest, jest and node --test take the test file's path"),
  python: none("pytest and unittest take the test file's path"),
  go: none("go test takes the package directory"),
  rust: none("cargo test --test takes the integration test's file stem, which names its binary"),
  java: {
    marker: JVM_TEST,
    scope: "package",
    example: {
      path: "src/test/java/com/example/UnitTest1.java",
      text: "package com.example;\n\nimport org.junit.jupiter.api.Test;\n\nclass FailureExceptionTest {\n  @Test\n  void keepsMessage() {}\n}\n\nclass Helper {}\n",
    },
  },
  kotlin: {
    marker:
      /@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b|:\s*[\w.]*Spec\s*\(/,
    scope: "package",
    // Top-level functions live in `FileKt`, the file's stem with its first letter in upper case.
    fileClass: (path, text) =>
      /@file\s*:\s*JvmName\s*\(\s*"(\w+)"\s*\)/.exec(text)?.[1] ??
      `${stem(path).replace(/^./, (c) => c.toUpperCase())}Kt`,
    example: {
      path: "src/test/kotlin/com/example/UnitTest1.kt",
      text: "package com.example\n\nimport kotlin.test.Test\n\nclass FailureExceptionTest {\n    @Test\n    fun keepsMessage() {}\n}\n\n@Test\nfun topLevel() {}\n\nclass Helper(val name: String)\n",
    },
  },
  scala: none(
    "the written-tests check runs no Scala file: its compiled test files are C#, Rust, Java and Kotlin",
  ),
  csharp: {
    marker:
      /[[,]\s*(?:global::)?(?:[\w.]+\.)?(?:Fact|Theory|Test|TestCase|TestCaseSource|TestMethod|DataTestMethod)\s*[\](,]/,
    scope: "namespace",
    example: {
      path: "Maskback.Tests/UnitTest1.cs",
      text: "namespace Maskback.Tests;\n\npublic class FailureExceptionTests\n{\n    [Fact]\n    public void KeepsMessage() { }\n}\n\npublic sealed class Helper { }\n",
    },
  },
  c: none("no written-tests runner narrows C test files"),
  cpp: none("no written-tests runner narrows C++ test files"),
  ruby: none("rspec and rake test take the test file's path"),
  php: none("phpunit and pest take the test file's path"),
  swift: none("swift test --filter is not built for written tests"),
  lua: none("busted takes the spec file's path"),
  elixir: none("mix test takes the test file's path"),
  dart: none("dart test and flutter test take the test file's path"),
  zig: none("zig test takes the file"),
  bash: none("bats takes the test file's path"),
  ocaml: none("dune runs a test directory"),
  objc: none("no written-tests runner narrows Objective-C test files"),
  vue: none("Vue components are tested from `.spec.ts` or `.test.ts` files, by path"),
  svelte: none("Svelte components are tested from `.spec.ts` or `.test.ts` files, by path"),
  rescript: none("ReScript tests run through a JavaScript runner, by path"),
  solidity: none("forge test is not narrowed for written tests"),
  sql: none("pgTAP and dbt run test files by path"),
  powershell: none("Pester takes its test files in `Run.Path`"),
  r: none("testthat selects files by its `filter` on their names, its own rule"),
};

const stem = (path: string): string =>
  posix.basename(path.replaceAll("\\", "/")).replace(/\.\w+$/, "");

const TOKEN =
  /[{}();]|\b(namespace|package)\s+([\w.]+)|\b(?:record\s+(?:class|struct)|class|interface|record|struct|object)\s+(\w+)|\bfun\b/g;

interface Span {
  name: string;
  scope: string;
  start: number;
  end: number;
}

/**
 * The top-level types of a file's code (`masked`: strings and comments blanked), each with the
 * namespace or package it is in and the text from its keyword to its closing brace, or to the next
 * declaration when it has no body (a Kotlin class whose tests are a constructor lambda).
 */
function topLevelTypes(masked: string, reader: TestClassReader): Span[] {
  const spans: Span[] = [];
  const scopes: { name: string; depth: number }[] = [];
  let depth = 0;
  let parens = 0;
  let namespace: string | null = null;
  let pending: Omit<Span, "end"> | null = null;
  let open: (Omit<Span, "end"> & { depth: number }) | null = null;
  const scopeName = () => scopes.map((s) => s.name).join(".");
  // A type without a body ends before the annotations and attributes of the declaration after it.
  const close = (end: number) => {
    if (!pending) return;
    const lines = masked.slice(pending.start, end).split("\n");
    while (lines.length > 1 && /^\s*(?:[@[].*)?$/.test(lines.at(-1) ?? "")) lines.pop();
    spans.push({ ...pending, end: pending.start + lines.join("\n").length });
    pending = null;
  };
  for (const match of masked.matchAll(TOKEN)) {
    const token = match[0];
    const at = match.index;
    const declaration = token !== "(" && token !== ")" && token !== "{" && token.length > 1;
    if (pending && parens === 0 && (token === ";" || token === "}" || declaration)) close(at);
    if (token === "(") parens++;
    else if (token === ")") parens = Math.max(0, parens - 1);
    else if (token === "{") {
      depth++;
      if (namespace !== null) {
        scopes.push({ name: namespace, depth });
        namespace = null;
      } else if (pending && parens === 0) {
        open = { ...pending, depth };
        pending = null;
      }
    } else if (token === "}") {
      if (open && depth === open.depth) {
        const { depth: _, ...span } = open;
        spans.push({ ...span, end: at + 1 });
        open = null;
      }
      if (scopes.at(-1)?.depth === depth) scopes.pop();
      depth = Math.max(0, depth - 1);
    } else if (token === ";") {
      // C#'s file-scoped `namespace A.B;` holds the rest of the file at this depth.
      if (namespace !== null) scopes.push({ name: namespace, depth });
      namespace = null;
    } else if (match[1]) {
      if (match[1] === "package" || reader.scope === "package")
        scopes.push({ name: match[2] as string, depth });
      else namespace = match[2] as string;
    } else if (match[3] && !open && !pending && depth === (scopes.at(-1)?.depth ?? 0))
      pending = { name: match[3], scope: scopeName(), start: at };
  }
  close(masked.length);
  return spans;
}

/**
 * The test classes a file declares by its language's reader (#2363), or null for a language whose
 * runner does not select by class. Empty when the file declares no type that holds a test: the
 * caller then names the class after the file, as before.
 */
export function declaredTestClasses(path: string, text: string): TestClass[] | null {
  const reader = rowOf(TEST_CLASSES, detectLanguageFromPath(path));
  if (!reader) return null;
  const masked = maskNonCode(path, text);
  const spans = topLevelTypes(masked, reader);
  const rowsAt = INLINE_ROWS_BEGIN.exec(text)?.index ?? -1;
  const qualified = (scope: string, name: string) => (scope ? `${scope}.${name}` : name);
  const found: TestClass[] = spans
    .filter((span) => reader.marker.test(masked.slice(span.start, span.end)))
    .map((span) => ({
      name: qualified(span.scope, span.name),
      rows: rowsAt > span.start && rowsAt < span.end,
    }));
  if (reader.fileClass) {
    let outside = masked;
    for (const span of spans)
      outside = `${outside.slice(0, span.start)}${" ".repeat(span.end - span.start)}${outside.slice(span.end)}`;
    if (reader.marker.test(outside)) {
      const scope = spans[0]?.scope ?? /^\s*package\s+([\w.]+)/m.exec(masked)?.[1] ?? "";
      found.push({ name: qualified(scope, reader.fileClass(path, text)), rows: false });
    }
  }
  return [...new Map(found.map((c) => [c.name, c])).values()];
}

const MAX_READ_BYTES = 512 * 1024;

/**
 * The declared test classes of each file under `root` whose language's runner selects by class
 * and that declares at least one (#2363). A file missing it is left to the file-name fallback.
 */
export function readTestClasses(root: string, files: readonly string[]): Map<string, TestClass[]> {
  const out = new Map<string, TestClass[]>();
  for (const path of files) {
    if (!rowOf(TEST_CLASSES, detectLanguageFromPath(path))) continue;
    try {
      const full = join(root, path);
      if (statSync(full).size > MAX_READ_BYTES) continue;
      const classes = declaredTestClasses(path, readFileSync(full, "utf8"));
      if (classes?.length) out.set(path, classes);
    } catch {
      /* absent or unreadable: the file-name fallback */
    }
  }
  return out;
}
