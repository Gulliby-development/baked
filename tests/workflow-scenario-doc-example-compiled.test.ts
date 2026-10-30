import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isNoRow, SUPPORTED_LANGUAGES } from "../src/core/intelligence/language-records.js";
import { runDocExamples } from "../src/core/verification/doc-examples.js";
import { commandShape, EXAMPLE_BUILD, exampleBuildOf, prepareExampleBuild } from "../src/core/verification/example-build.js";
import type { ProcessResult, ProcessScope } from "../src/core/workflows/process-scope.js";

// #2505, R81 hintsieve-update (Swift): the README's 11 `swift run hintsieve ...` examples ran in a
// copy of the source files with no `.build`; 8 compiled from nothing under the 30 s example timeout
// and were killed (244 s of a 687 s run), 3 hit the example limit, none was compared. vtsnap-update
// (C#) skipped `dotnet src/Vtsnap/bin/Release/net10.0/vtsnap.dll` as "needs build". The examples now
// reuse the build the checks made, and a command that timed out once is not waited for again.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-doc-compiled-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const fence = "```";
const README = [
  "# hintsieve",
  ...[1, 2, 3].flatMap((n) => [`${fence}console`, `$ swift run hintsieve count ${n}`, `${n} hints`, fence]),
].join("\n");
const SOURCES = { "Package.swift": "// swift-tools-version:5.9\n", "Sources/hintsieve/main.swift": "print(1)\n" };

/** A toolchain that times out unless it runs with the no-build flag next to a linked `.build`. */
function swift(calls: string[][]): ProcessScope {
  const result = (output: string, timedOut = false): ProcessResult => ({ exitCode: timedOut ? null : 0, signal: null, output, timedOut, cancelled: false, truncated: false, durationMs: 1 });
  return {
    execute: async (program: string, args: string[], options: { cwd: string }) => {
      calls.push([program, ...args]);
      const built = existsSync(join(options.cwd, ".build", "debug", "hintsieve"));
      if (!args.includes("--skip-build") || !built) return result("", true);
      return result(`${args.at(-1)} hints\n`);
    },
  } as unknown as ProcessScope;
}

const run = (root: string, scope: ProcessScope, files: string[]) =>
  runDocExamples(scope, [{ path: "README.md", text: README }], { root, files, executables: ["swift"], signal: new AbortController().signal, sandbox: () => null });

describe("scenario: R81 hintsieve-update, swift run in a copy without .build (#2505)", () => {
  test("with the checks' build in the workspace, the examples reuse it and match", async () => {
    const root = project({ ...SOURCES, ".build/debug/hintsieve": "binary" });
    const calls: string[][] = [];
    const results = await run(root, swift(calls), Object.keys(SOURCES));
    expect(results.map((r) => r.status)).toEqual(["match", "match", "match"]);
    expect(calls[0]).toEqual(["swift", "run", "--skip-build", "hintsieve", "count", "1"]);
    // The workspace's build directory was linked, never copied or changed.
    expect(existsSync(join(root, ".build", "debug", "hintsieve"))).toBe(true);
  });

  test("without a build, the first timeout stops the rest of that command without waiting", async () => {
    const root = project(SOURCES);
    const calls: string[][] = [];
    const results = await run(root, swift(calls), Object.keys(SOURCES));
    // One wait instead of three; the command keeps its form, since there is no build to reuse.
    expect(calls).toEqual([["swift", "run", "hintsieve", "count", "1"]]);
    expect(results.map((r) => r.status)).toEqual(["not_run", "not_run", "not_run"]);
    expect(results[1]?.reason).toStartWith("an earlier example of swift run (README.md:3) did not finish within 30 s");
  });
});

describe("the build a documented example reuses (#2505)", () => {
  test("per toolchain: the no-build flag after the subcommand, only when a build directory was linked", () => {
    const rows: [string[], Record<string, string>, string[]][] = [
      [["swift", "run", "x", "a"], { ".build/debug/x": "" }, ["swift", "run", "--skip-build", "x", "a"]],
      [["dotnet", "run", "--project", "src/App", "--", "a"], { "src/App/bin/Debug/app.dll": "", "src/App/obj/x": "" }, ["dotnet", "run", "--no-build", "--project", "src/App", "--", "a"]],
      [["mix", "run", "-e", "Ratdec.main()"], { "_build/dev/lib/ratdec/ebin/x": "" }, ["mix", "run", "--no-compile", "-e", "Ratdec.main()"]],
      [["dune", "exec", "--", "ratdec"], { "_build/default/bin/ratdec.exe": "" }, ["dune", "exec", "--no-build", "--", "ratdec"]],
      [["cargo", "run", "--", "a"], { "target/debug/x": "" }, ["cargo", "run", "--", "a"]],
      [["zig", "build", "run"], { "zig-out/bin/x": "" }, ["zig", "build", "run"]],
    ];
    for (const [argv, built, expected] of rows) {
      const root = project({ "src/main": "", ...built });
      const copy = project({ "src/main": "" });
      expect(prepareExampleBuild(argv, root, copy)).toEqual(expected);
      for (const path of Object.keys(built)) expect(existsSync(join(copy, path))).toBe(true);
      // No build in the workspace: the command runs as written.
      expect(prepareExampleBuild(argv, project({ "src/main": "" }), project({ "src/main": "" }))).toEqual(argv);
    }
  });

  test("the command shape a timeout stands for", () => {
    expect(commandShape(["swift", "run", "hintsieve", "count"])).toBe("swift run");
    expect(commandShape(["zig", "build", "run"])).toBe("zig build run");
    expect(commandShape(["./ratdec", "check", "a"])).toBe("./ratdec check");
    expect(commandShape(["python", "-m", "pkg"])).toBe("python pkg");
    expect(exampleBuildOf(["swift", "build"])).toBeNull();
  });

  test("every supported language has a row or says why not", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const row = EXAMPLE_BUILD[language];
      if (isNoRow(row)) expect(row.none.length).toBeGreaterThan(10);
      else expect(row.link.length).toBeGreaterThan(0);
    }
  });
});

describe("scenario: R81 vtsnap-update, an example that names a build output (#2505)", () => {
  test("the dll the checks built is linked into the copy and the example runs", async () => {
    const files = { "src/Vtsnap/Vtsnap.csproj": "<Project/>", "src/Vtsnap/Program.cs": "class P {}" };
    const root = project({ ...files, "src/Vtsnap/bin/Release/net10.0/vtsnap.dll": "dll" });
    const readme = [`${fence}console`, "$ dotnet src/Vtsnap/bin/Release/net10.0/vtsnap.dll diff a", "same", fence].join("\n");
    const calls: string[][] = [];
    const scope = {
      execute: async (program: string, args: string[], options: { cwd: string }) => {
        calls.push([program, ...args]);
        const output = existsSync(join(options.cwd, args[0] as string)) ? "same\n" : "missing\n";
        return { exitCode: 0, signal: null, output, timedOut: false, cancelled: false, truncated: false, durationMs: 1 };
      },
    } as unknown as ProcessScope;
    const results = await runDocExamples(scope, [{ path: "README.md", text: readme }], { root, files: Object.keys(files), executables: ["dotnet"], signal: new AbortController().signal, sandbox: () => null });
    expect(results.map((r) => r.status)).toEqual(["match"]);
    expect(calls).toEqual([["dotnet", "src/Vtsnap/bin/Release/net10.0/vtsnap.dll", "diff", "a"]]);
  });
});
