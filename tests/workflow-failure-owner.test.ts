import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { correctiveSources, importedFiles } from "../src/core/workflows/invalidation.js";
import type { Task, TaskGraph } from "../src/core/workflows/schemas.js";
import type { TaskRow } from "../src/core/workflows/store.js";
import { failureOwner, failureOwnerNote } from "../src/core/workflows/task-graph.js";

const task = (id: string, path: string): Task => ({ id, title: id, description: id, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path, action: "modify" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Fixture" });
const graph = (...tasks: Task[]): TaskGraph => ({ schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks });
const row = (t: Task, status: string): TaskRow => ({ id: t.id, status } as TaskRow);

describe("failureOwner (#1563, #1564)", () => {
  const source = task("T001", "src/cli.ts");
  for (const [path, output] of [
    ["tests/cli.test.ts", "tests/cli.test.ts:\n(fail) defaults\n  at /work/src/cli.ts:4:1"],
    ["cli_test.go", "--- FAIL: TestCLI (0.00s)\n    cli_test.go:42: mismatch"],
    ["tests/cli.rs", "thread 'cli' panicked at tests/cli.rs:42:5"],
    ["tests/test_cli.py", "FAILED tests/test_cli.py::test_cli - assert 1 == 2"],
    ["src/test/java/com/example/CliTest.java", "[ERROR] com.example.CliTest.defaults:42 expected"],
    ["src/test/kotlin/com/example/CliTest.kt", "at com.example.CliTest.defaults(CliTest.kt:42)"],
    ["Tests/CliTests.cs", "Failed CliTests.Defaults [8 ms]"],
  ]) test(`hands a failing ${path} to its pending writer, including dependent writers`, () => {
    const update = { ...task("T002", path as string), dependsOn: ["T001"] };
    const owner = failureOwner(graph(source, update), [row(source, "implemented"), row(update, "pending")], {}, source, output as string);
    expect(owner).toMatchObject({ kind: "test-update", owners: ["T002"] });
    expect(failureOwnerNote(owner)).toContain("Stop rerunning this check and submit");
    expect(failureOwner(graph(source, update), [row(update, "verified")], {}, source, output as string).kind).not.toBe("test-update");
    expect(failureOwner(graph(source, update), [row(update, "pending")], {}, { ...source, origin: "repair" }, output as string).kind).not.toBe("test-update");
  });
  test("mixed failures stay with the task; a source declaration alone does not prevent a test handoff", () => {
    const update = task("T002", "tests/cli.test.ts");
    const g = graph(source, update);
    const rows = [row(update, "pending")];
    expect(failureOwner(g, rows, {}, source, "tests/cli.test.ts(1,1): error TS2769\n    src/cli.ts(1,1): declared here").kind).toBe("test-update");
    expect(failureOwner(g, rows, {}, source, "tests/cli.test.ts: error\nsrc/cli.ts: error").kind).toBe("self");
    expect(failureOwner(g, rows, {}, source, "one test failed").kind).toBe("unowned");
  });
  test("names the finished source owner without giving another profile write access", () => {
    const producer = task("T001", "a/parse.go");
    const tests = task("T002", "a/parse_test.go");
    const output = "panic: index out of range\n\t/work/a/parse.go:82 +0x12\n\t/work/a/parse_test.go:8 +0x20";
    const owner = failureOwner(graph(producer, tests), [row(producer, "implemented")], {}, tests, output);
    expect(owner).toMatchObject({ kind: "finished", owners: ["T001"], files: ["a/parse.go"] });
    expect(failureOwnerNote(owner)).toContain("Do not rewrite tests to hide the failure");
    expect(failureOwner(graph({ ...producer, profileId: "other" }, tests), [row(producer, "implemented")], {}, tests, output).kind).not.toBe("finished");
    expect(failureOwner(graph({ ...producer, profileId: "other" }, tests), [row(producer, "implemented")], {}, tests, output, { crossProfile: true })).toMatchObject({ kind: "finished", owners: ["T001"] });
    expect(failureOwner(graph(producer, tests), [row(producer, "pending")], {}, tests, output).kind).not.toBe("finished");
  });
  test("pending source dependencies still defer their checks", () => {
    const dependency = task("T002", "src/dep.ts");
    const owner = failureOwner(graph(source, dependency), [row(dependency, "pending")], {}, source, "src/dep.ts:1: error");
    expect(owner).toMatchObject({ kind: "pending", owners: ["T002"] });
    expect(failureOwnerNote(owner)).toContain("host reruns the check");
  });
  test("an import in a failing assertion's excerpt is not an upstream defect", () => {
    const tests = task("T002", "tests/cli.test.ts");
    const output = 'tests/cli.test.ts:\n1 | import { cli } from "../src/cli.ts";\n2 | expect(cli()).toBe(true);\n(fail) cli\n    at /work/tests/cli.test.ts:2:10';
    expect(failureOwner(graph(source, tests), [row(source, "implemented")], {}, tests, output).kind).toBe("self");
  });
  for (const [path, output] of [
    ["src/parse.ts", "TypeError: bad value\n    at parse (/work/src/parse.ts:82:3)"],
    ["src/parse.py", 'Traceback (most recent call last):\n  File "/work/src/parse.py", line 82, in parse\n    raise ValueError()\nValueError'],
    ["src/main/java/p/Parse.java", "at p.Parse.run(Parse.java:82)"],
    ["src/main/java/p/Parse.java", "[ERROR] /work/src/main/java/p/Parse.java:[82,3] cannot find symbol"],
    ["src/Parse.cs", "at Parse.Run() in C:\\work\\src\\Parse.cs:line 82"],
  ]) test(`recognizes the production diagnostic ${output?.split("\n").at(-1)}`, () => {
    const producer = task("T001", path as string);
    const tests = task("T002", "tests/caller.test.ts");
    expect(failureOwner(graph(producer, tests), [row(producer, "verified")], {}, tests, output as string)).toMatchObject({ kind: "finished", owners: ["T001"], files: [path] });
  });
});

describe("correctiveSources (#1564)", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  for (const [language, files, tests, sources] of [
    ["Go", { "a/parse_test.go": 'package a\nimport "example.com/p/cli"\n', "a/parse.go": "package a\n", "a/other.go": "package a\n", "cli/cmd.go": "package cli\n" }, ["a/parse_test.go"], ["a/parse.go", "a/other.go", "cli/cmd.go"]],
    ["JVM", { "src/test/java/p/ParseTest.java": "package p; class ParseTest { Parse p; Other o; }", "src/main/java/p/Parse.java": "package p; class Parse {}", "src/main/java/p/Other.java": "package p; class Other {}" }, ["src/test/java/p/ParseTest.java"], ["src/main/java/p/Parse.java", "src/main/java/p/Other.java"]],
    ["TypeScript", { "tests/parse.test.ts": 'import { parse } from "../src/parse.ts";\n', "src/parse.ts": 'import "./other.ts";\n', "src/other.ts": "export {};\n" }, ["tests/parse.test.ts"], ["src/parse.ts", "src/other.ts"]],
  ] as const) test(`${language} uses named sources and falls back to the import closure only without them`, () => {
    const root = mkdtempSync(join(tmpdir(), "baked-owned-scope-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    expect(importedFiles(root, tests, sources)).toEqual([...sources]);
    expect(correctiveSources(root, tests, sources, [sources[0]])).toEqual([sources[0]]);
    expect(correctiveSources(root, tests, sources, [])).toEqual([...sources]);
    expect(correctiveSources(root, tests, sources, [sources[0]], 1)).toEqual([sources[0]]);
  });
});
