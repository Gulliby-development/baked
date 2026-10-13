import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cargoMutants,
  detectMutationTool,
  diffChange,
  goMutants,
  mutmutResults,
  pitMutants,
  runMutationTool,
  strykerMutants,
  type ToolShell,
} from "../src/core/workflows/quality/mutation-tools.js";
import { readablePath } from "../src/core/specs/validate.js";
import { proposedMutants } from "../src/core/workflows/quality/mutation.js";

// Trimmed from reports the tools wrote for these files (Stryker 10, cargo-mutants 27,
// PIT 1.17, avito-tech go-mutesting).
const JS = { path: "src/math.js", before: null, content: "export function clamp(x, lo, hi) {\n  if (x < lo) return lo;\n  if (x > hi) return hi;\n  return x;\n}\n" };
const RUST = { path: "src/lib.rs", before: null, content: "pub fn clamp(x: i32, lo: i32, hi: i32) -> i32 {\n    if x < lo {\n        return lo;\n    }\n    x\n}\n" };
const JAVA = { path: "src/main/java/com/example/Calc.java", before: null, content: "package com.example;\n\npublic class Calc {\n    public static int clamp(int x, int lo, int hi) {\n        if (x < lo) return lo;\n        return x;\n    }\n}\n" };
const GO = { path: "calc.go", before: null, content: "package calc\n\nfunc Clamp(x, lo, hi int) int {\n\tif x < lo {\n\t\treturn lo\n\t}\n\treturn x\n}\n" };

describe("tool reports", () => {
  test("Stryker's mutation-testing-elements report", () => {
    const report = JSON.stringify({
      schemaVersion: "1.0",
      files: {
        "/work/src/math.js": {
          language: "javascript",
          mutants: [
            { id: "3", mutatorName: "EqualityOperator", replacement: "x <= lo", status: "Survived", location: { start: { line: 2, column: 7 }, end: { line: 2, column: 13 } } },
            { id: "4", mutatorName: "EqualityOperator", replacement: "x >= lo", status: "Killed", killedBy: ["0"], location: { start: { line: 2, column: 7 }, end: { line: 2, column: 13 } } },
            { id: "0", mutatorName: "BlockStatement", replacement: "{}", status: "Killed", location: { start: { line: 1, column: 34 }, end: { line: 5, column: 2 } } },
            { id: "6", mutatorName: "ConditionalExpression", replacement: "false", status: "NoCoverage", location: { start: { line: 3, column: 7 }, end: { line: 3, column: 13 } } },
            { id: "9", mutatorName: "StringLiteral", replacement: '""', status: "CompileError", location: { start: { line: 3, column: 7 }, end: { line: 3, column: 13 } } },
          ],
        },
        "src/other.js": { mutants: [{ id: "1", status: "Survived", location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }] },
      },
    });
    const mutants = strykerMutants(report, [JS], "/work");
    expect(mutants.map((m) => [m.line, m.status, m.mutated, m.description ?? null])).toEqual([
      [2, "survived", "  if (x <= lo) return lo;", null],
      [2, "killed", "  if (x >= lo) return lo;", null],
      [1, "killed", "export function clamp(x, lo, hi) {", "BlockStatement: {}"],
      [3, "survived", "  if (false) return hi;", null],
    ]);
  });

  test("cargo-mutants' outcomes, PIT's mutations.xml and go-mutesting's report.json", () => {
    const span = (line: number, start: number, end: number) => ({ start: { line, column: start }, end: { line, column: end } });
    const cargo = JSON.stringify({
      outcomes: [
        { scenario: "Baseline", summary: "Success" },
        { scenario: { Mutant: { name: "src/lib.rs:2:10: replace < with <= in clamp", file: "src/lib.rs", span: span(2, 10, 11), replacement: "<=", genre: "BinaryOperator" } }, summary: "MissedMutant" },
        { scenario: { Mutant: { name: "src/lib.rs:2:5: replace clamp -> i32 with 0", file: "src/lib.rs", span: { start: { line: 2, column: 5 }, end: { line: 4, column: 6 } }, replacement: "0", genre: "FnValue" } }, summary: "CaughtMutant" },
        { scenario: { Mutant: { file: "src/lib.rs", span: span(2, 10, 11), replacement: "==" } }, summary: "Unviable" },
      ],
    });
    expect(cargoMutants(cargo, [RUST])).toEqual([
      { file: "src/lib.rs", line: 2, operator: "BinaryOperator", original: "    if x < lo {", mutated: "    if x <= lo {", status: "survived" },
      { file: "src/lib.rs", line: 2, operator: "FnValue", original: "    if x < lo {", mutated: "    if x < lo {", description: "replace clamp -> i32 with 0", status: "killed", killedBy: "cargo test" },
    ]);
    expect(cargoMutants(JSON.stringify({ outcomes: [{ scenario: "Baseline", summary: "Failure" }] }), [RUST])).toBe(
      "the tests fail without mutants",
    );

    const pit = `<?xml version="1.0" encoding="UTF-8"?>
<mutations partial="true">
<mutation detected='false' status='SURVIVED' numberOfTestsRun='1'><sourceFile>Calc.java</sourceFile><mutatedClass>com.example.Calc</mutatedClass><mutatedMethod>clamp</mutatedMethod><lineNumber>5</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.ConditionalsBoundaryMutator</mutator><killingTest/><description>changed conditional boundary</description></mutation>
<mutation detected='true' status='KILLED' numberOfTestsRun='1'><sourceFile>Calc.java</sourceFile><mutatedClass>com.example.Calc$Inner</mutatedClass><mutatedMethod>clamp</mutatedMethod><lineNumber>6</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.returns.PrimitiveReturnsMutator</mutator><killingTest>com.example.CalcTest</killingTest><description>replaced int return with 0 for com/example/Calc::clamp</description></mutation>
<mutation detected='false' status='NON_VIABLE'><sourceFile>Calc.java</sourceFile><mutatedClass>com.example.Calc</mutatedClass><lineNumber>5</lineNumber><mutator>x</mutator><description>y</description></mutation>
</mutations>`;
    expect(pitMutants(pit, [JAVA]).map((m) => [m.line, m.status, m.operator, m.description])).toEqual([
      [5, "survived", "ConditionalsBoundaryMutator", "changed conditional boundary"],
      [6, "killed", "PrimitiveReturnsMutator", "replaced int return with 0 for com/example/Calc::clamp"],
    ]);

    const go = JSON.stringify({
      stats: { totalMutantsCount: 2 },
      escaped: [
        { mutator: { mutatorName: "expression/comparison", originalFilePath: "calc.go", originalStartLine: 4 }, diff: "--- Original\n+++ New\n@@ -1,7 +1,7 @@\n package calc\n \n func Clamp(x, lo, hi int) int {\n-\tif x < lo {\n+\tif x <= lo {\n \t\treturn lo\n" },
      ],
      killed: [
        { mutator: { mutatorName: "branch/if", originalFilePath: "calc.go", originalStartLine: 5 }, diff: "--- Original\n+++ New\n@@ -2,7 +2,8 @@\n \n func Clamp(x, lo, hi int) int {\n \tif x < lo {\n-\t\treturn lo\n+\t\t_ = lo\n+\n \t}\n" },
      ],
      errored: [],
    });
    expect(goMutants(go, [GO]).map((m) => [m.line, m.status, m.mutated])).toEqual([
      [5, "killed", "\t\t_ = lo"],
      [4, "survived", "\tif x <= lo {"],
    ]);
  });

  test("mutmut's results and shown diff", () => {
    expect(
      mutmutResults("    calc.x_clamp__mutmut_1: survived\n    calc.x_is_adult__mutmut_2: killed\n    noise\n"),
    ).toEqual([
      { name: "calc.x_clamp__mutmut_1", status: "survived" },
      { name: "calc.x_is_adult__mutmut_2", status: "killed" },
    ]);
    expect(
      diffChange(
        "# calc.x_clamp__mutmut_2: survived\n--- src/calc/__init__.py\n+++ src/calc/__init__.py\n@@ -1,5 +1,5 @@\n def clamp(x, lo, hi):\n     if x < lo:\n         return lo\n-    if x > hi:\n+    if x >= hi:\n         return hi\n",
      ),
    ).toEqual({ line: 4, original: "    if x > hi:", mutated: "    if x >= hi:" });
  });
});

/** A machine with the given files and commands; a run writes `writes` and answers with `answer`. */
function fakeShell(
  files: Record<string, string>,
  commands: string[],
  answer: (args: string[]) => { writes?: Record<string, string>; exitCode?: number; output?: string; timedOut?: boolean } = () => ({}),
): ToolShell & { runs: string[][]; removed: string[] } {
  const runs: string[][] = [];
  const removed: string[] = [];
  // Directories stay when their files are removed, as on a disk.
  const dirs = new Set<string>();
  const write = (entries: Record<string, string>) => {
    for (const [path, text] of Object.entries(entries)) {
      files[path] = text;
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
  };
  write({ ...files });
  return {
    root: "/work",
    scratch: "/tmp/scratch",
    platform: "linux",
    runs,
    removed,
    run: async (executable, args) => {
      runs.push([executable, ...args]);
      const result = answer(args);
      write(result.writes ?? {});
      return { exitCode: result.exitCode ?? 0, output: result.output ?? "", timedOut: result.timedOut ?? false };
    },
    read: (path) => files[path] ?? null,
    exists: (path) => path in files || dirs.has(path),
    remove: (path) => {
      removed.push(path);
      for (const f of Object.keys(files)) if (f === path || f.startsWith(`${path}/`)) delete files[f];
      for (const d of [...dirs]) if (d === path || d.startsWith(`${path}/`)) dirs.delete(d);
    },
    which: (command) => (commands.includes(command) ? `/usr/bin/${command}` : null),
    now: () => 0,
  };
}

describe("running a tool", () => {
  const STRYKER = "node_modules/@stryker-mutator/core/bin/stryker.js";

  test("only an installed tool of the changed code's language is used", () => {
    const changed = [{ path: "src/a.ts", before: null, content: "x\n" }, { path: "tests/a.test.ts", before: null, content: "t\n" }];
    expect(detectMutationTool(changed, fakeShell({}, ["node", "mutmut"]))).toBeNull();
    expect(detectMutationTool(changed, fakeShell({ [STRYKER]: "" }, ["node"]))).toEqual({
      tool: "stryker",
      files: [{ path: "src/a.ts", before: null, content: "x\n" }],
    });
    expect(detectMutationTool([{ path: "lib.rs", before: null, content: "" }], fakeShell({}, ["cargo", "cargo-mutants"]))).toBeNull();
    expect(
      detectMutationTool([{ path: "src/lib.rs", before: null, content: "" }], fakeShell({ "Cargo.toml": "" }, ["cargo", "cargo-mutants"]))?.tool,
    ).toBe("cargo-mutants");
    expect(
      detectMutationTool([{ path: "a.py", before: null, content: "" }], fakeShell({ ".venv/bin/mutmut": "" }, []))?.tool,
    ).toBe("mutmut");
    expect(
      detectMutationTool([JAVA], fakeShell({ "pom.xml": "<artifactId>pitest-maven</artifactId>" }, ["mvn"]))?.tool,
    ).toBe("pit");
  });

  test("Stryker's mutants on the added lines are kept and the report it created is removed", async () => {
    const file = { path: "src/math.js", before: "export function clamp(x, lo, hi) {\n  if (x < lo) return lo;\n", content: JS.content };
    const report = JSON.stringify({
      files: {
        "src/math.js": {
          mutants: [
            // Line 2 was there before the run: its mutant is not the run's.
            { mutatorName: "EqualityOperator", replacement: "x <= lo", status: "Survived", location: { start: { line: 2, column: 7 }, end: { line: 2, column: 13 } } },
            { mutatorName: "EqualityOperator", replacement: "x >= hi", status: "Survived", location: { start: { line: 3, column: 7 }, end: { line: 3, column: 13 } } },
          ],
        },
      },
    });
    const shell = fakeShell({ [STRYKER]: "", "reports/keep.txt": "" }, ["node"], () => ({
      writes: { "reports/mutation/mutation.json": report },
      exitCode: 1,
    }));
    const run = await runMutationTool("stryker", [file], shell, 60_000);
    expect(run).toEqual({
      tool: "stryker",
      mutants: [
        { file: "src/math.js", line: 3, operator: "EqualityOperator", original: "  if (x > hi) return hi;", mutated: "  if (x >= hi) return hi;", status: "survived" },
      ],
    });
    expect(shell.runs[0]).toEqual([
      "/usr/bin/node",
      STRYKER,
      "run",
      "--mutate",
      "src/math.js",
      "--reporters",
      "json",
      "--incremental",
      "--incrementalFile",
      "/tmp/scratch/stryker-incremental.json",
      "--tempDirName",
      "/tmp/scratch/stryker-tmp",
      "--cleanTempDir",
      "always",
    ]);
    // `reports` held a file of the project before the run, so only what Stryker added goes.
    expect(shell.removed).toEqual(["reports/mutation/mutation.json", "reports/mutation"]);
    expect(shell.exists("reports/keep.txt")).toBe(true);
  });

  test("a tool without a report fails, and one out of time is inconclusive", async () => {
    const failing = fakeShell({ [STRYKER]: "" }, ["node"], () => ({ exitCode: 1, output: "no test runner configured" }));
    expect(await runMutationTool("stryker", [JS], failing, 60_000)).toEqual({
      tool: "stryker",
      failure: "exit 1: no test runner configured",
    });
    const slow = fakeShell({ [STRYKER]: "" }, ["node"], () => ({ timedOut: true }));
    expect(await runMutationTool("stryker", [JS], slow, 60_000)).toEqual({
      tool: "stryker",
      mutants: [],
      note: "stryker did not finish within the time budget of 60s",
    });
  });

  test("mutmut shows each mutant of a changed file to find its line", async () => {
    const file = {
      path: "src/calc/__init__.py",
      before: null,
      content: "def clamp(x, lo, hi):\n    if x < lo:\n        return lo\n    return x\n\n\ndef is_adult(age):\n    return age >= 18\n",
    };
    const shell = fakeShell({}, ["mutmut"], (args) => {
      if (args[0] === "results")
        return { output: "    calc.x_clamp__mutmut_1: killed\n    calc.x_is_adult__mutmut_1: survived\n    other.x_f__mutmut_1: survived\n" };
      // mutmut numbers the lines of the function, not of the file.
      if (args[1] === "calc.x_is_adult__mutmut_1")
        return { output: "--- src/calc/__init__.py\n+++ src/calc/__init__.py\n@@ -1,2 +1,2 @@\n def is_adult(age):\n-    return age >= 18\n+    return age > 18\n" };
      if (args[0] === "show")
        return { output: "--- src/calc/__init__.py\n+++ src/calc/__init__.py\n@@ -1,4 +1,4 @@\n def clamp(x, lo, hi):\n-    if x < lo:\n+    if x <= lo:\n" };
      return {};
    });
    const run = await runMutationTool("mutmut", [file], shell, 60_000);
    expect(run).toEqual({
      tool: "mutmut",
      mutants: [
        { file: file.path, line: 8, operator: "mutmut", original: "    return age >= 18", mutated: "    return age > 18", status: "survived" },
        { file: file.path, line: 2, operator: "mutmut", original: "    if x < lo:", mutated: "    if x <= lo:", status: "killed", killedBy: "mutmut" },
      ],
    });
    expect(shell.runs.map((r) => r.slice(1).join(" "))).toEqual([
      "run",
      "results --all true",
      "show calc.x_is_adult__mutmut_1",
      "show calc.x_clamp__mutmut_1",
    ]);
  });
});

describe("tool paths in a worktree", () => {
  test("a tool in the node_modules a worktree links to the working copy is found; other escapes are refused", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "baked-tool-path-")));
    try {
      const bin = "node_modules/@stryker-mutator/core/bin/stryker.js";
      mkdirSync(join(workspace, "node_modules/@stryker-mutator/core/bin"), { recursive: true });
      writeFileSync(join(workspace, bin), "");
      const worktree = join(workspace, ".baked/worktrees/run-1");
      mkdirSync(worktree, { recursive: true });
      symlinkSync(join(workspace, "node_modules"), join(worktree, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      writeFileSync(join(workspace, "secret.txt"), "");
      symlinkSync(join(workspace, "secret.txt"), join(worktree, "report.json"));
      expect(existsSync(readablePath(worktree, bin))).toBe(true);
      expect(() => readablePath(worktree, "node_modules/../../../secret.txt")).toThrow();
      expect(() => readablePath(worktree, "report.json")).toThrow();
      expect(readablePath(worktree, "reports/mutation/mutation.json")).toBe(join(worktree, "reports/mutation/mutation.json"));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("agent mutants", () => {
  test("only a proposal that changes an added line as it is becomes a mutant, three per criterion", () => {
    const file = { path: "src/a.ts", before: "const keep = 1;\n", content: "const keep = 1;\nexport const f = (n: number) => n > 10;\n" };
    const proposal = (over: Partial<{ criterionId: string; file: string; line: number; original: string; mutated: string }>) => ({
      criterionId: "AC-001",
      file: "src/a.ts",
      line: 2,
      original: "export const f = (n: number) => n > 10;",
      mutated: "export const f = (n: number) => n >= 10;",
      ...over,
    });
    const mutants = proposedMutants(
      [
        proposal({}),
        proposal({ line: 1, original: "const keep = 1;", mutated: "const keep = 2;" }),
        proposal({ original: "something else" }),
        proposal({ mutated: "export const f = (n: number) => n > 10;" }),
        proposal({ file: "tests/a.test.ts" }),
        proposal({ mutated: "export const f = (n: number) => n > 11;" }),
        proposal({ mutated: "export const f = (n: number) => n < 10;" }),
        proposal({ mutated: "export const f = (n: number) => true;" }),
        proposal({ criterionId: "AC-002", mutated: "export const f = (n: number) => n > 10;  " }),
      ],
      [file],
      [{ id: "M1", file: "src/a.ts", line: 2, operator: "boundary", original: "", mutated: "export const f = (n: number) => n >= 10;" }],
    );
    expect(mutants.map((m) => [m.id, m.mutated, m.criterionId])).toEqual([
      ["M2", "export const f = (n: number) => n > 11;", "AC-001"],
      ["M3", "export const f = (n: number) => n < 10;", "AC-001"],
      ["M4", "export const f = (n: number) => true;", "AC-001"],
    ]);
  });
});
