import { describe, expect, test } from "bun:test";
import { compressShellOutput } from "../src/core/tools/shell-compress.js";

// Helper: generate N lines of a pattern
const repeat = (line: string, n: number) => Array.from({ length: n }, () => line).join("\n");
const lines = (s: string) => s.split("\n").length;

describe("compressShellOutput", () => {
  test("returns raw output for short outputs (<20 lines)", () => {
    const short = "line1\nline2\nline3";
    expect(compressShellOutput(short)).toBe(short);
  });

  test("returns raw output when compression saves <10%", () => {
    const raw = Array.from({ length: 25 }, (_, i) => `unique line ${i}: ${crypto.randomUUID()}`).join("\n");
    expect(compressShellOutput(raw)).toBe(raw);
  });

  // ── JS/TS Test Runners ────────────────────────────────────────────────

  describe("JS/TS (jest/vitest/bun:test)", () => {
    test("collapses passing tests with checkmarks", () => {
      const raw = [
        "Running 50 tests...",
        ...Array.from({ length: 50 }, (_, i) => `  ✓ test case ${i + 1} should work`),
        "50 passed, 0 failed",
      ].join("\n");
      const out = compressShellOutput(raw);
      expect(out).toContain("✓ test case 1");
      expect(out).toContain("passing tests omitted");
      expect(out).not.toContain("test case 25");
      expect(out).toContain("50 passed, 0 failed");
    });

    test("preserves failures and their stack traces", () => {
      const raw = [
        "Running 5 tests...",
        ...Array.from({ length: 20 }, (_, i) => `  ✓ passing test ${i + 1}`),
        "  ✗ failing test",
        "    Error: expected 1 to be 2",
        "    at Object.<anonymous> (test/foo.test.ts:42:5)",
        "    at Module._compile (internal/modules/cjs/loader.js:1072:14)",
        "    at Object.Module._extensions..js (internal/modules/cjs/loader.js:1101:10)",
        "20 passed, 1 failed",
      ].join("\n");
      const out = compressShellOutput(raw);
      expect(out).toContain("✗ failing test");
      expect(out).toContain("Error: expected 1 to be 2");
      expect(out).toContain("at Object.<anonymous>");
    });

    test("truncates deep stack traces to 5 frames", () => {
      const frames = Array.from(
        { length: 15 },
        (_, i) => `    at frame${i} (file${i}.js:${i}:1)`,
      );
      const raw = [
        "header line",
        ...Array.from({ length: 20 }, () => "some output"),
        "Error: boom",
        ...frames,
        "end of output",
      ].join("\n");
      const out = compressShellOutput(raw);
      expect(out).toContain("at frame0");
      expect(out).toContain("at frame4");
      expect(out).not.toContain("at frame5");
      expect(out).toContain("more frames");
      expect(out).toContain("end of output");
    });
  });

  // ── Python ────────────────────────────────────────────────────────────

  describe("Python (pytest)", () => {
    test("collapses pytest PASSED lines", () => {
      const raw = [
        "============================= test session starts ==============================",
        "collected 100 items",
        "",
        ...Array.from({ length: 100 }, (_, i) => `tests/test_mod.py::test_case_${i} PASSED`),
        "",
        "============================== 100 passed ==============================",
      ].join("\n");
      const out = compressShellOutput(raw);
      expect(out).toContain("test_case_0 PASSED");
      expect(out).toContain("passing tests omitted");
      expect(out).not.toContain("test_case_50");
      expect(out).toContain("100 passed");
    });

    test("preserves pytest failures with Python stack traces", () => {
      const raw = [
        "collected 25 items",
        "",
        ...Array.from({ length: 20 }, (_, i) => `tests/test_a.py::test_${i} PASSED`),
        "tests/test_b.py::test_fail FAILED",
        "",
        "=================================== FAILURES ===================================",
        "    def test_fail():",
        ">       assert False",
        "E       AssertionError",
        "",
        '  File "/app/tests/test_b.py", line 10, in test_fail',
        '  File "/app/src/utils.py", line 5, in helper',
        '  File "/usr/lib/python3.11/importlib/__init__.py", line 126, in import_module',
        '  File "/usr/lib/python3.11/importlib/_bootstrap.py", line 1206, in _gcd_import',
        '  File "/usr/lib/python3.11/importlib/_bootstrap.py", line 1178, in _find_and_load',
        '  File "/usr/lib/python3.11/importlib/_bootstrap.py", line 1149, in _find_and_load_unlocked',
        '  File "/usr/lib/python3.11/importlib/_bootstrap.py", line 690, in _load_unlocked',
        '  File "/usr/lib/python3.11/importlib/_bootstrap_external.py", line 940, in exec_module',
        "",
        "1 failed, 24 passed",
      ].join("\n");
      const out = compressShellOutput(raw);
      expect(out).toContain("test_fail FAILED");
      expect(out).toContain("assert False");
      // First 5 Python frames preserved
      expect(out).toContain('File "/app/tests/test_b.py"');
      expect(out).toContain('File "/usr/lib/python3.11/importlib/_bootstrap.py", line 1178');
      // Frames beyond 5 collapsed
      expect(out).toContain("more frames");
    });
  });

  // ── Go ────────────────────────────────────────────────────────────────

  describe("Go (go test)", () => {
    test("collapses Go PASS lines", () => {
      const raw = [
        "=== RUN   TestMain",
        ...Array.from({ length: 30 }, (_, i) => `--- PASS: TestCase${i} (0.00s)`),
        "PASS",
        "ok  \tgithub.com/user/pkg\t0.123s",
      ].join("\n");
      const out = compressShellOutput(raw);
      expect(out).toContain("--- PASS: TestCase0");
      expect(out).toContain("passing tests omitted");
      expect(out).toContain("ok  \tgithub.com/user/pkg");
    });
  });

  // ── Rust ──────────────────────────────────────────────────────────────

  describe("Rust (cargo test)", () => {
    test("collapses Rust test ok lines", () => {
      const raw = [
        "running 50 tests",
        ...Array.from({ length: 50 }, (_, i) => `test tests::test_case_${i} ... ok`),
        "",
        "test result: ok. 50 passed; 0 failed; 0 ignored",
      ].join("\n");
      const out = compressShellOutput(raw);
      expect(out).toContain("test_case_0 ... ok");
      expect(out).toContain("passing tests omitted");
      expect(out).toContain("50 passed; 0 failed");
    });

    test("preserves Rust panic with backtrace", () => {
      const raw = [
        "running 25 tests",
        ...Array.from({ length: 20 }, (_, i) => `test tests::test_ok_${i} ... ok`),
        "test tests::test_panic ... FAILED",
        "",
        "---- tests::test_panic stdout ----",
        "thread 'tests::test_panic' panicked at 'assertion failed'",
        "   0: std::panicking::begin_panic",
        "   1: myapp::module::function",
        "   2: myapp::tests::test_panic",
        "   3: core::ops::function::FnOnce::call_once",
        "   4: std::sys_common::backtrace::__rust_begin_short_backtrace",
        "   5: std::panicking::try::do_call",
        "   6: std::panicking::try",
        "   7: std::panic::catch_unwind",
        "   8: test::run_test_in_process",
        "   9: test::run_test",
        "  10: test::console::run_tests_console",
        "",
        "test result: FAILED. 20 passed; 1 failed",
      ].join("\n");
      const out = compressShellOutput(raw);
      expect(out).toContain("test_panic ... FAILED");
      expect(out).toContain("panicked at");
      // First 5 backtrace frames
      expect(out).toContain("0: std::panicking::begin_panic");
      expect(out).toContain("4: std::sys_common::backtrace");
      // Rest collapsed
      expect(out).toContain("more frames");
      expect(out).toContain("1 failed");
    });
  });

  // ── TAP Format ────────────────────────────────────────────────────────

  describe("TAP format (Perl/Node TAP)", () => {
    test("collapses TAP ok lines", () => {
      const raw = [
        "TAP version 13",
        "1..40",
        ...Array.from({ length: 40 }, (_, i) => `ok ${i + 1} - test description ${i}`),
        "# tests 40",
        "# pass  40",
      ].join("\n");
      const out = compressShellOutput(raw);
      expect(out).toContain("ok 1 - test description 0");
      expect(out).toContain("passing tests omitted");
      expect(out).toContain("# pass  40");
    });
  });

  // ── Repeated Warnings ─────────────────────────────────────────────────

  describe("repeated warnings (all languages)", () => {
    test("collapses repeated similar lines", () => {
      const raw = [
        "Building project...",
        ...Array.from({ length: 30 }, (_, i) => `src/file${i}.ts(${i},1): warning TS6133: 'x' is declared but never used.`),
        "Build complete with 30 warnings.",
      ].join("\n");
      const out = compressShellOutput(raw);
      expect(out).toContain("warning TS6133");
      expect(out).toContain("more similar lines");
      expect(out).toContain("Build complete");
      expect(lines(out)).toBeLessThan(10);
    });

    test("collapses repeated lint warnings", () => {
      const raw = [
        "Linting...",
        ...Array.from({ length: 25 }, (_, i) => `  ${i + 1}:5  warning  Unexpected console statement  no-console`),
        "25 problems (0 errors, 25 warnings)",
      ].join("\n");
      const out = compressShellOutput(raw);
      expect(out).toContain("no-console");
      expect(out).toContain("more similar lines");
      expect(out).toContain("25 problems");
    });
  });

  // ── Progress/Noise Suppression ────────────────────────────────────────

  describe("noise suppression", () => {
    test("suppresses progress bars", () => {
      const raw = [
        "Installing dependencies...",
        ...Array.from({ length: 20 }, () => "some real output"),
        "███████████████░░░░░",
        "████████████████████",
        "Done.",
      ].join("\n");
      const out = compressShellOutput(raw);
      expect(out).not.toContain("███");
      expect(out).toContain("Done.");
    });

    test("suppresses download/install progress", () => {
      const raw = [
        "npm install",
        ...Array.from({ length: 20 }, (_, i) => `Downloading package-${i}...`),
        "added 150 packages in 3s",
      ].join("\n");
      const out = compressShellOutput(raw);
      expect(out).toContain("added 150 packages");
      // "Downloading..." lines are noise and should be suppressed
      expect(out).not.toContain("Downloading package-10");
    });
  });

  // ── Java/JVM ──────────────────────────────────────────────────────────

  describe("Java (JUnit/Gradle)", () => {
    test("truncates Java stack traces", () => {
      const frames = Array.from(
        { length: 20 },
        (_, i) => `\tat com.example.pkg${i}.Class${i}.method${i}(Class${i}.java:${i * 10})`,
      );
      const raw = [
        "JUnit test results:",
        ...Array.from({ length: 20 }, () => "some test output line"),
        "java.lang.NullPointerException: value was null",
        ...frames,
        "Tests: 50, Failures: 1",
      ].join("\n");
      const out = compressShellOutput(raw);
      expect(out).toContain("NullPointerException");
      expect(out).toContain("com.example.pkg0");
      expect(out).toContain("com.example.pkg4");
      expect(out).not.toContain("com.example.pkg5");
      expect(out).toContain("more frames");
    });
  });

  // ── Ruby ──────────────────────────────────────────────────────────────

  describe("Ruby (RSpec)", () => {
    test("truncates Ruby stack traces", () => {
      const frames = Array.from(
        { length: 12 },
        (_, i) => `\tfrom /app/lib/module${i}.rb:${i * 5}:in \`method${i}'`,
      );
      const raw = [
        "Failures:",
        "",
        ...Array.from({ length: 20 }, () => "some rspec output"),
        "RuntimeError: something went wrong",
        ...frames,
        "1 example, 1 failure",
      ].join("\n");
      const out = compressShellOutput(raw);
      expect(out).toContain("RuntimeError");
      expect(out).toContain("module0.rb");
      expect(out).toContain("more frames");
      expect(out).toContain("1 failure");
    });
  });

  // ── Edge Cases ────────────────────────────────────────────────────────

  describe("edge cases", () => {
    test("preserves error-only output (no passes to compress)", () => {
      const raw = [
        "ERROR: Build failed",
        "src/main.ts:5:1 - error TS2304: Cannot find name 'foo'.",
        ...Array.from({ length: 20 }, () => "some build output"),
        "1 error found",
      ].join("\n");
      const out = compressShellOutput(raw);
      expect(out).toContain("Cannot find name 'foo'");
      expect(out).toContain("1 error found");
    });

    test("handles mixed pass/fail interleaved output", () => {
      const raw = [
        "Test suite:",
        ...Array.from({ length: 10 }, (_, i) => `  ✓ passing ${i}`),
        "  ✗ FAIL: something broke",
        "    Error: oops",
        ...Array.from({ length: 15 }, (_, i) => `  ✓ passing ${i + 10}`),
        "  ✗ FAIL: another thing",
        "    Error: nope",
        "25 passed, 2 failed",
      ].join("\n");
      const out = compressShellOutput(raw);
      expect(out).toContain("FAIL: something broke");
      expect(out).toContain("FAIL: another thing");
      expect(out).toContain("25 passed, 2 failed");
    });

    test("handles empty input", () => {
      expect(compressShellOutput("")).toBe("");
    });

    test("handles output with only newlines", () => {
      expect(compressShellOutput("\n\n\n")).toBe("\n\n\n");
    });
  });
});
