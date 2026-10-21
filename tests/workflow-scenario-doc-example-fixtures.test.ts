import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractExamples, extractFixtures, missingInput, runDocExamples } from "../src/core/verification/doc-examples.js";
import { entryPointCommand } from "../src/core/verification/entry-points.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import { reproEnv } from "../src/core/verification/repro.js";

// Bench round 57 (#1849). hdrlens-update's README showed its two inputs as blocks ("save the
// following response fields as `resp.txt`:") and then ran `hdrlens check resp.txt`; the host ran
// both examples in a copy without those files and recorded two mismatches ("cannot read the file").
// modeplan's README introduced each example in a sentence with an inline command and the host
// extracted none of its seven.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const fence = "```";

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-doc-fixtures-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** The README of R57 hdrlens-update, lines 58 to 80, with the program's name in its commands. */
const HDRLENS = [
  "## Checking a response",
  "For example, save the following response fields as `resp.txt`:",
  `${fence}text`,
  "Content-Type: text/plain",
  "Content-Length: 12",
  "Cache-Control: no-cache",
  "ETag: \"x\"",
  "Vary: Accept",
  "Date: Tue, 21 Oct 2026 10:00:00 GMT",
  "Server: demo",
  fence,
  `${fence}sh`,
  "hdrlens check resp.txt",
  fence,
  fence,
  "ok, 7 fields",
  fence,
  "Save these request fields as `req.txt`:",
  `${fence}text`,
  "Accept: application/json;q=0.5, image/png",
  fence,
  `${fence}sh`,
  "hdrlens accept req.txt application/json text/plain image/png",
  fence,
  fence,
  "image/png",
  fence,
  "A file the reader brings is not the program's fault:",
  `${fence}sh`,
  "hdrlens check yours.txt",
  fence,
  fence,
  "ok, 3 fields",
  fence,
].join("\n");

const CLI = `const fs = require("fs");
const [cmd, file, ...types] = process.argv.slice(2);
if (!fs.existsSync(file)) { console.log('hdrlens: "' + file + '": cannot read the file'); process.exit(1); }
const lines = fs.readFileSync(file, "utf8").split("\\n").filter(Boolean);
if (cmd === "check") console.log("ok, " + lines.length + " fields");
else console.log(types.find((t) => lines[0].includes(t) && !lines[0].includes(t + ";")) ?? "none");
`;

describe("scenario: hdrlens-update 97e933f3, examples that read files the README saves (#1849)", () => {
  test("the saved blocks are written before the examples that read them, and a file nobody saves is not run", async () => {
    const files = { "package.json": JSON.stringify({ name: "hdrlens", bin: { hdrlens: "cli.js" } }), "cli.js": CLI };
    const root = project(files);
    const results = await runDocExamples(new ProcessScope(), [{ path: "README.md", text: HDRLENS }], {
      root,
      files: Object.keys(files),
      executables: ["bun"],
      signal: new AbortController().signal,
      sandbox: () => null,
    });
    expect(results.map((r) => [r.command, r.status])).toEqual([
      ["hdrlens check resp.txt", "match"],
      ["hdrlens accept req.txt application/json text/plain image/png", "match"],
      ["hdrlens check yours.txt", "not_run"],
    ]);
    expect(results[2]?.reason).toStartWith("input file yours.txt is not in the repository");
    // The fixtures went into the copy, never the workspace.
    expect(readdirSync(root).sort()).toEqual(["cli.js", "package.json"]);
  });

  test("a fixture is saved only for the examples after it and never over a workspace file", async () => {
    const readme = [
      `${fence}sh`,
      "bun -e \"console.log(require('fs').existsSync('late.txt'))\"",
      fence,
      fence,
      "true",
      fence,
      "Save this as `late.txt`:",
      fence,
      "x",
      fence,
      "Save this as `keep.txt`:",
      fence,
      "from the readme",
      fence,
      `${fence}sh`,
      "bun -e \"console.log(require('fs').readFileSync('keep.txt', 'utf8').trim())\"",
      fence,
      fence,
      "from the workspace",
      fence,
    ].join("\n");
    const root = project({ "keep.txt": "from the workspace\n" });
    const results = await runDocExamples(new ProcessScope(), [{ path: "README.md", text: readme }], {
      root,
      files: ["keep.txt"],
      executables: ["bun"],
      signal: new AbortController().signal,
      sandbox: () => null,
    });
    expect(results.map((r) => r.status)).toEqual(["mismatch", "match"]);
    expect(results[0]?.firstDifference).toMatchObject({ expected: "true", actual: "false" });
  });
});

describe("documented fixtures and prose examples", () => {
  test("blocks introduced as files are fixtures under their names; output blocks and unsafe names are not", () => {
    expect(extractFixtures(HDRLENS).map((f) => [f.path, f.content.split("\n")[0]])).toEqual([
      ["resp.txt", "Content-Type: text/plain"],
      ["req.txt", "Accept: application/json;q=0.5, image/png"],
    ]);
    const other = [
      "Given this input file:",
      fence,
      "# data/net.sp",
      "struct A {}",
      fence,
      "Save it as `../outside.txt`:",
      fence,
      "x",
      fence,
      "It prints:",
      fence,
      "out.txt",
      fence,
    ].join("\n");
    expect(extractFixtures(other).map((f) => f.path)).toEqual(["data/net.sp"]);
  });

  test("an inline command in a sentence followed by its output block is an example (modeplan)", () => {
    const readme = [
      "For example, `modeplan apply 0644 u+x,go-r` shows each step of the change:",
      `${fence}text`,
      "0644 -> 0744 (u+x)",
      "0744 -> 0700 (go-r)",
      fence,
      "The file `modes.txt` shows:",
      `${fence}text`,
      "not a command",
      fence,
      "Run `modeplan --help` or `modeplan apply` to see it; it prints:",
      `${fence}text`,
      "two commands, no example",
      fence,
    ].join("\n");
    expect(extractExamples("README.md", readme).map((e) => [e.command, e.argv, e.documented])).toEqual([
      ["modeplan apply 0644 u+x,go-r", ["modeplan", "apply", "0644", "u+x,go-r"], "0644 -> 0744 (u+x)\n0744 -> 0700 (go-r)"],
    ]);
  });

  test("a missing input is one the copy lacks and the output names", () => {
    const copy = project({ "here.txt": "x" });
    expect(missingInput(["check", "gone.txt"], copy, 'tool: "gone.txt": cannot read the file')).toBe("gone.txt");
    expect(missingInput(["check", "here.txt"], copy, "here.txt is malformed")).toBeNull();
    expect(missingInput(["--out", "new.json"], copy, "wrote nothing")).toBeNull();
    expect(missingInput(["../x.txt"], copy, "../x.txt missing")).toBeNull();
  });
});

describe("the same README under each toolchain's entry point", () => {
  // The fixtures are written by the host whatever runs the program; each entry point maps the
  // README's `hdrlens check resp.txt` to its launcher with the fixture path as the argument.
  const cases: [string, Record<string, string>, string[], string[]][] = [
    ["go", { "go.mod": "module example.com/hdrlens\n\ngo 1.23\n", "main.go": "package main\n\nfunc main() {}\n" }, ["go"], ["go", "run", "."]],
    ["cargo", { "Cargo.toml": '[package]\nname = "hdrlens"\n', "src/main.rs": "fn main() {}" }, ["cargo"], ["cargo", "run", "--quiet", "--bin", "hdrlens", "--"]],
    ["python", { "pyproject.toml": '[project]\nname = "hdrlens"\n\n[project.scripts]\nhdrlens = "hdrlens.cli:main"\n' }, ["python"], ["python", "-c"]],
    ["bun", { "package.json": JSON.stringify({ bin: { hdrlens: "cli.js" } }) }, ["bun"], ["bun", "cli.js"]],
    ["dotnet", { "Hdrlens.csproj": '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><AssemblyName>hdrlens</AssemblyName></PropertyGroup></Project>' }, ["dotnet"], ["dotnet", "run", "--project", "Hdrlens.csproj", "--"]],
    ["mvn", { "pom.xml": "<project><artifactId>hdrlens</artifactId><build><plugins><plugin><configuration><mainClass>ex.Main</mainClass></configuration></plugin></plugins></build></project>" }, ["mvn", "java"], ["java", "-cp", "target/classes", "ex.Main"]],
  ];
  for (const [name, files, executables, launcher] of cases)
    test(`${name}: the example reads the fixture the README saves`, () => {
      const [example] = extractExamples("README.md", HDRLENS);
      const argv = entryPointCommand(project(files), example?.argv ?? [], executables)?.argv ?? [];
      expect(argv.slice(0, launcher.length)).toEqual(launcher);
      expect(argv.slice(-2)).toEqual(["check", "resp.txt"]);
      expect(extractFixtures(HDRLENS)[0]?.line).toBeLessThan(example?.line ?? 0);
    });

  test.if(spawnSync("go", ["version"]).status === 0)("go: the R57 shape runs end to end and matches", async () => {
    const main = `package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	data, err := os.ReadFile(os.Args[2])
	if err != nil {
		fmt.Printf("hdrlens: %q: cannot read the file\\n", os.Args[2])
		os.Exit(1)
	}
	n := 0
	for _, l := range strings.Split(string(data), "\\n") {
		if l != "" {
			n++
		}
	}
	fmt.Printf("ok, %d fields\\n", n)
}
`;
    const files = { "go.mod": "module example.com/hdrlens\n\ngo 1.21\n", "main.go": main };
    const root = project(files);
    const readme = HDRLENS.split("Save these request fields")[0] as string;
    // A cold `go run` compiles the standard library first, which on a loaded Windows runner took
    // longer than the 30 s an example may run, so the example was not run. The test is about the
    // fixture, not the compiler: warm the build cache the example's `go run` reads.
    const built = mkdtempSync(join(tmpdir(), "baked-go-warm-"));
    spawnSync("go", ["build", "-o", join(built, "hdrlens"), "."], { cwd: root, env: reproEnv(root) });
    rmSync(built, { recursive: true, force: true });
    const results = await runDocExamples(new ProcessScope(), [{ path: "README.md", text: readme }], {
      root,
      files: Object.keys(files),
      executables: ["go"],
      signal: new AbortController().signal,
      sandbox: () => null,
    });
    expect(results.map((r) => r.status)).toEqual(["match"]);
  }, 120000);
});
