import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { failingFilesInOutput } from "../src/core/verification/convergence.js";
import { importedFiles } from "../src/core/workflows/invalidation.js";
import type { Task } from "../src/core/workflows/schemas.js";
import { outOfScopeFailure } from "../src/core/workflows/scheduler.js";
import type { TaskRow } from "../src/core/workflows/store.js";
import { pendingOwners, siblingCorrections } from "../src/core/workflows/task-graph.js";

// Sibling bugs of #1291, #1359, #1295 and #1333 (#1419, #1420). The corrective decisions asked
// which files a check names, and jest, vitest and verbose pytest name every test file they ran,
// passing ones too, while Go and Maven name none by path. A corrective then saw its own task's
// passing test, did not wait for the sibling fixing the failing one and opened a correction of
// itself; with Go or JVM output it saw nothing at all.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const planned = (id: string, paths: string[]): Task => ({ id, title: id, description: id, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: paths.map((path) => ({ path, action: "create" as const })), readHints: [], checkIds: ["tests-written"], origin: "planned", findingIds: [], rationale: id });

const OUTPUTS: Record<string, string> = {
  jest: "PASS tests/a.test.ts\nFAIL tests/b.test.ts\n  ● b renders\n    expect(received).toBe(expected)\n\nTests: 1 failed, 2 passed, 3 total",
  vitest: " ✓ tests/a.test.ts (2 tests) 3ms\n ❯ tests/b.test.ts (1 test | 1 failed) 5ms\n   × b renders\n\n FAIL  tests/b.test.ts > b renders\nAssertionError: expected 'x' to be 'ok'",
  pytest: "tests/a.test.ts::test_a PASSED  [ 50%]\ntests/b.test.ts::test_b FAILED  [100%]\n\nFAILED tests/b.test.ts::test_b - assert 'x' == 'ok'",
  "pytest dots": "tests/a.test.ts ..  [ 50%]\ntests/b.test.ts .F  [100%]\n\nFAILED tests/b.test.ts::test_b - assert 'x' == 'ok'",
  bun: "tests/a.test.ts:\n(pass) a renders [0.2ms]\n\ntests/b.test.ts:\n(pass) b parses [0.1ms]\n(fail) b renders [0.3ms]\n\n 2 pass\n 1 fail",
};

describe("failingFilesInOutput", () => {
  const tasks = [planned("T001", ["src/a.ts", "src/b.ts"]), planned("T002", ["tests/a.test.ts"]), planned("T003", ["tests/b.test.ts"])];
  for (const [runner, output] of Object.entries(OUTPUTS))
    test(`${runner}: only the failing test file`, () => {
      expect(failingFilesInOutput(output, tasks)).toEqual(["tests/b.test.ts"]);
    });

  test("compiler and linter output keeps every file it names", () => {
    expect(failingFilesInOutput("src/a.ts(3,1): error TS2322\nsrc/b.ts:4:2 lint/style", tasks)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("go test: the assertion's base name and its package", () => {
    const go = [planned("T001", ["internal/cli/cli.go", "internal/cli/cli_test.go", "internal/fmt/fmt_test.go"])];
    const output = "--- FAIL: TestUsage (0.00s)\n    cli_test.go:42: usage mismatch\nFAIL\nFAIL\texample.com/m/internal/cli\t0.2s\nok  \texample.com/m/internal/fmt\t0.1s";
    expect(failingFilesInOutput(output, go)).toEqual(["internal/cli/cli_test.go"]);
  });

  test("Maven Surefire: the failing class", () => {
    const jvm = [planned("T001", ["src/main/java/com/acme/Query.java", "src/test/java/com/acme/QueryTest.java", "src/test/java/com/acme/OtherTest.java"])];
    const output = "[INFO] Tests run: 2, Failures: 0 in com.acme.OtherTest\n[ERROR] Tests run: 3, Failures: 1 in com.acme.QueryTest\n[ERROR]   QueryTest.depthCuts:42 expected:<2> but was:<3>";
    expect(failingFilesInOutput(output, jvm)).toContain("src/test/java/com/acme/QueryTest.java");
  });
});

describe("corrective decisions read only the failing files", () => {
  const fix = (id: string, findingId: string): Task => ({ ...planned(id, ["src/a.ts", "src/b.ts", "tests/a.test.ts", "tests/b.test.ts"]), origin: "repair", findingIds: [findingId] });
  const tasks = [planned("T001", ["src/a.ts", "src/b.ts"]), planned("T002", ["tests/a.test.ts"]), planned("T003", ["tests/b.test.ts"]), fix("T004", "F1"), fix("T005", "F2")];
  const graph = { schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks };
  const rows = [{ id: "T004", status: "running" }, { id: "T005", status: "pending" }] as unknown as TaskRow[];
  for (const [runner, output] of Object.entries(OUTPUTS))
    test(`${runner}: the corrective of T002 waits for T005, which fixes T003's failing test`, () => {
      expect(siblingCorrections(graph, rows, tasks[3] as Task, output, { F1: "T002", F2: "T003" })).toEqual(["T005"]);
    });

  test("a planned task's passing own test does not make a sibling's failure its own", () => {
    const own = planned("T002", ["tests/a.test.ts"]);
    const later = { ...planned("T003", ["tests/b.test.ts"]) };
    const g = { ...graph, tasks: [planned("T001", ["src/a.ts", "src/b.ts"]), own, later] };
    const pending = [{ id: "T001", status: "verified" }, { id: "T002", status: "running" }, { id: "T003", status: "pending" }] as unknown as TaskRow[];
    expect(pendingOwners(g, pending, {}, own, OUTPUTS.jest ?? "")).toEqual(["T003"]);
  });

  test("a corrective's failure outside its files ignores the passing files the runner lists", () => {
    const narrow = { ...planned("T006", ["tests/a.test.ts"]), origin: "repair" as const, findingIds: ["F3"] };
    expect(outOfScopeFailure(narrow, { status: "failed", output: OUTPUTS.vitest }, tasks)).toEqual(["tests/b.test.ts"]);
  });
});

describe("importedFiles across languages (#1420)", () => {
  const workspace = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "baked-imports-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };

  test("Go: the test's own package and the packages it imports", () => {
    const root = workspace({ "internal/cli/cli_test.go": 'package cli\nimport "testing"\n', "internal/cli/cli.go": "package cli\n", "internal/other/o.go": "package other\n", "cmd/app/main_test.go": 'package main\nimport (\n\t"testing"\n\t"example.com/m/internal/cli"\n)\n' });
    expect(importedFiles(root, ["internal/cli/cli_test.go"], ["internal/cli/cli.go", "internal/other/o.go"])).toEqual(["internal/cli/cli.go"]);
    expect(importedFiles(root, ["cmd/app/main_test.go"], ["internal/cli/cli.go", "internal/other/o.go"])).toEqual(["internal/cli/cli.go"]);
  });

  test("Rust: `use <crate>::` from an integration test and `mod` from the crate root", () => {
    const root = workspace({ "tests/parse.rs": "use mycrate::parse::run;\n", "src/lib.rs": "pub mod parse;\n", "src/parse/mod.rs": "", "src/other.rs": "" });
    expect(importedFiles(root, ["tests/parse.rs"], ["src/parse/mod.rs", "src/other.rs"])).toEqual(["src/parse/mod.rs"]);
    expect(importedFiles(root, ["src/lib.rs"], ["src/parse/mod.rs", "src/other.rs"])).toEqual(["src/parse/mod.rs"]);
  });

  test("Java: a class of the test's own package that it names", () => {
    const root = workspace({ "src/test/java/com/acme/QueryTest.java": "package com.acme;\nclass QueryTest { Query q; }\n", "src/main/java/com/acme/Query.java": "package com.acme;\n", "src/main/java/com/acme/Other.java": "package com.acme;\n" });
    expect(importedFiles(root, ["src/test/java/com/acme/QueryTest.java"], ["src/main/java/com/acme/Query.java", "src/main/java/com/acme/Other.java"])).toEqual(["src/main/java/com/acme/Query.java"]);
  });

  test("Python: relative imports", () => {
    const root = workspace({ "pkg/tests/test_p.py": "from ..parser import x\nfrom . import helpers\n", "pkg/parser.py": "", "pkg/tests/helpers.py": "", "pkg/z.py": "" });
    expect(importedFiles(root, ["pkg/tests/test_p.py"], ["pkg/parser.py", "pkg/tests/helpers.py", "pkg/z.py"])).toEqual(["pkg/parser.py", "pkg/tests/helpers.py"]);
  });
});
