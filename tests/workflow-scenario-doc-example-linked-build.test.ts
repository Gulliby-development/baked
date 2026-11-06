import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rowOf, SUPPORTED_LANGUAGES } from "../src/core/intelligence/language-records.js";
import { extractFixtures, LINKED_DIRS, runDocExamples, writeIntoCopy } from "../src/core/verification/doc-examples.js";
import { EXAMPLE_BUILD } from "../src/core/verification/example-build.js";
import type { ProcessScope } from "../src/core/workflows/process-scope.js";
import { ProcessScope as RealScope } from "../src/core/workflows/process-scope.js";

// Bench round 101 (#2947). dieodds-update's README named its built program in a sentence that ended
// with a colon ("... or `src/Dieodds/bin/Release/net10.0/dieodds.exe` on Windows. You can also
// invoke the assembly on any supported platform:"), so the block after it became a fixture saved
// under the build folder. The host had linked the workspace's `bin` into its copy for
// `dotnet run --no-build`, so the write went through the link: on Windows with the copy in %TEMP%
// the recursive mkdir threw EEXIST and the review ended with host_error; elsewhere the file landed
// in the run's real build folder.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const fence = "```";

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-doc-linked-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** Every file of the tree, by relative path, with its bytes: the workspace must not change. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path.slice(root.length + 1).replaceAll("\\", "/")] = readFileSync(path, "utf8");
  }
  return out;
}

/** A process scope that answers every command with the documented output and records the argv. */
function fakeScope(output: string, calls: string[][]): ProcessScope {
  return {
    execute: async (program: string, args: string[]) => {
      calls.push([program, ...args]);
      return { exitCode: 0, signal: null, output, timedOut: false, cancelled: false };
    },
  } as unknown as ProcessScope;
}

const options = (root: string, files: string[], executables: string[]) => ({
  root,
  files,
  executables,
  signal: new AbortController().signal,
  sandbox: () => null,
});

/** The README of R101 dieodds-update, lines 17 to 21, and its `stats` example. */
const DIEODDS = [
  "## Running",
  "The executable is `src/Dieodds/bin/Release/net10.0/dieodds` on macOS and Linux, or `src/Dieodds/bin/Release/net10.0/dieodds.exe` on Windows. You can also invoke the assembly on any supported platform:",
  "",
  `${fence}sh`,
  "dotnet src/Dieodds/bin/Release/net10.0/dieodds.dll COMMAND",
  fence,
  "",
  "For example:",
  `${fence}sh`,
  "dieodds stats 2d6+3",
  fence,
  fence,
  "min 5, max 15, mean 10",
  fence,
].join("\n");

describe("scenario: dieodds-update 10442b68, a README fixture under a linked build folder (#2947)", () => {
  test("C#: the example gets a result and nothing is written into the workspace's bin", async () => {
    const files = {
      "src/Dieodds/Dieodds.csproj":
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><AssemblyName>dieodds</AssemblyName></PropertyGroup></Project>',
      "src/Dieodds/Program.cs": "Console.WriteLine();\n",
    };
    const root = project({
      ...files,
      "src/Dieodds/bin/Debug/net10.0/dieodds.dll": "built",
      "src/Dieodds/obj/project.assets.json": "{}",
    });
    const before = tree(root);
    const calls: string[][] = [];
    const results = await runDocExamples(
      fakeScope("min 5, max 15, mean 10\n", calls),
      [{ path: "README.md", text: DIEODDS }],
      options(root, Object.keys(files), ["dotnet"]),
    );
    const stats = results.find((r) => r.command === "dieodds stats 2d6+3");
    expect(stats?.status).toBe("match");
    expect(calls.at(-1)).toContain("--no-build");
    expect(tree(root)).toEqual(before);
  });

  test("a sentence naming a built program is no fixture", () => {
    expect(extractFixtures(DIEODDS)).toEqual([]);
  });
});

describe("every linked toolchain folder refuses a fixture under it", () => {
  // The build folder of each toolchain the runner links, with a binary a README names by path.
  const cases: [string, string][] = [
    ["csharp", "src/App/bin/Release/net10.0/app.exe"],
    ["csharp obj", "src/App/obj/Debug/app.dll"],
    ["rust", "target/release/tool.exe"],
    ["swift", ".build/release/tool.o"],
    ["elixir", "_build/dev/lib/x.beam"],
    ["zig", "zig-out/bin/tool.exe"],
    ["zig cache", ".zig-cache/o/tool.o"],
    ["dart", ".dart_tool/build/tool.dill"],
    ["ocaml", "_build/default/tool.exe"],
    ["maven", "target/tool.jar"],
    ["gradle", "build/libs/tool.jar"],
    ["typescript", "dist/cli.js"],
    ["java out", "out/Main.class"],
  ];
  for (const [name, path] of cases)
    test(`${name}: ${path}`, () => {
      const readme = [`The program is \`${path}\`, run it like this:`, `${fence}sh`, `${path} --help`, fence].join("\n");
      expect(extractFixtures(readme)).toEqual([]);
      // The same block under a source path is still a fixture the reader saves.
      const saved = readme.replaceAll(path, "data/input.txt");
      expect(extractFixtures(saved).map((f) => f.path)).toEqual(["data/input.txt"]);
    });

  test("every folder a toolchain row or entry point links is in LINKED_DIRS", () => {
    const rows = SUPPORTED_LANGUAGES.flatMap((language) => rowOf(EXAMPLE_BUILD, language)?.link ?? []);
    expect(rows.length).toBeGreaterThan(0);
    for (const dir of [...rows, "bin", "obj", "target", "dist", "build", "out", "_build"]) expect(LINKED_DIRS.has(dir)).toBe(true);
  });
});

describe("writes into the copy go through writeIntoCopy (#2947)", () => {
  test("a path through a linked folder is refused and the linked folder is unchanged", () => {
    const workspace = project({ "bin/keep.txt": "keep" });
    const copy = project({});
    symlinkSync(join(workspace, "bin"), join(copy, "bin"), process.platform === "win32" ? "junction" : "dir");
    const reason = writeIntoCopy(copy, "bin/Release/out.txt", "x");
    expect(reason).toContain("bin/Release/out.txt is in bin");
    expect(tree(workspace)).toEqual({ "bin/keep.txt": "keep" });
  });

  test("a file where a folder is needed gives a reason, not an exception", () => {
    const copy = project({ "data": "a file" });
    expect(writeIntoCopy(copy, "data/input.txt", "x")).toStartWith("the host could not write data/input.txt into the copy:");
    expect(writeIntoCopy(copy, "fresh/input.txt", "x")).toBeNull();
    expect(statSync(join(copy, "fresh/input.txt")).isFile()).toBe(true);
  });

  test("a redirect into a folder the copy linked is not run and leaves the workspace as it was", async () => {
    const readme = [`${fence}console`, "$ bun dist/cli.js", "hi", "$ printf 'x' > dist/out.txt", "$ bun dist/cli.js", "hi", fence].join("\n");
    const root = project({ "dist/cli.js": "console.log('hi')\n", "package.json": "{}" });
    const before = tree(root);
    const results = await runDocExamples(new RealScope(), [{ path: "README.md", text: readme }], options(root, ["package.json"], ["bun"]));
    expect(results.map((r) => [r.command, r.status])).toEqual([
      ["bun dist/cli.js", "match"],
      ["printf 'x' > dist/out.txt", "not_run"],
      ["bun dist/cli.js", "match"],
    ]);
    expect(results[1]?.reason).toContain("dist/out.txt is in dist");
    expect(tree(root)).toEqual(before);
  });

  test("a fixture the host cannot write is not run, never a crash", async () => {
    const readme = [
      "Save this as `data/input.txt`:",
      fence,
      "x",
      fence,
      `${fence}sh`,
      "bun -e \"console.log(1)\"",
      fence,
      fence,
      "1",
      fence,
    ].join("\n");
    // A file named `data` where the fixture needs a folder: the host's mkdir throws ENOTDIR.
    const root = project({ data: "a file" });
    const before = tree(root);
    const results = await runDocExamples(new RealScope(), [{ path: "README.md", text: readme }], options(root, ["data"], ["bun"]));
    expect(results.map((r) => r.status)).toEqual(["not_run"]);
    expect(results[0]?.reason).toStartWith("the host could not write data/input.txt into the copy:");
    expect(tree(root)).toEqual(before);
  });
});
