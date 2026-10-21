import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractExamples, placeholderOf, runDocExamples } from "../src/core/verification/doc-examples.js";
import { entryPointCommand, projectEntryPoints } from "../src/core/verification/entry-points.js";
import { runProbe } from "../src/core/verification/repro.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";

// Bench round 55 (#1821): the documented-example check ran 0 of 27 README examples in three apps.
// `routeshadow tree app.txt` was skipped because routeshadow is not cargo, `stampbook status`
// because stampbook is not python, `GET` was read as a placeholder, and structpad's
// `python -m structpad --help` was compared with the sample struct file that followed it.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const fence = "```";

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-entry-points-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe("entry points per toolchain", () => {
  const resolve = (files: Record<string, string>, argv: string[], executables: string[]) =>
    entryPointCommand(project(files), argv, executables)?.argv ?? null;

  test("a Cargo package with src/main.rs, and a [[bin]] target", () => {
    expect(
      resolve({ "Cargo.toml": '[package]\nname = "routeshadow"\n', "src/main.rs": "fn main() {}" }, ["routeshadow", "tree", "app.txt"], ["cargo"]),
    ).toEqual(["cargo", "run", "--quiet", "--bin", "routeshadow", "--", "tree", "app.txt"]);
    expect(
      resolve({ "Cargo.toml": '[package]\nname = "kit"\n\n[[bin]]\nname = "kitctl"\npath = "src/cli.rs"\n' }, ["kitctl", "x"], ["cargo"]),
    ).toEqual(["cargo", "run", "--quiet", "--bin", "kitctl", "--", "x"]);
  });

  test("Python [project.scripts], Poetry scripts and setup.cfg console_scripts, run by the environment's interpreter", () => {
    const venv = "/repo/.venv/bin/python";
    expect(
      resolve({ "pyproject.toml": '[project]\nname = "stampbook"\n\n[project.scripts]\nstampbook = "stampbook.cli:main"\n' }, ["stampbook", "status"], ["ruff", venv]),
    ).toEqual([venv, "-c", 'import sys; from stampbook.cli import main; sys.argv[0] = "stampbook"; sys.exit(main())', "status"]);
    expect(
      resolve({ "pyproject.toml": '[tool.poetry.scripts]\npad = "structpad.cli:run"\n' }, ["pad"], ["python3"])?.[0],
    ).toBe("python3");
    expect(
      resolve({ "setup.cfg": "[options.entry_points]\nconsole_scripts =\n    ledger = ledger.main:cli\n" }, ["ledger"], ["python"])?.slice(0, 2),
    ).toEqual(["python", "-c"]);
  });

  test("a Go main package at the module root and under cmd/", () => {
    const files = {
      "go.mod": "module github.com/ex/youngkit\n\ngo 1.23\n",
      "main.go": "package main\n\nfunc main() {}\n",
      "cmd/youngctl/main.go": "package main\n\nfunc main() {}\n",
      "shape/shape.go": "package shape\n",
    };
    expect(resolve(files, ["youngkit", "rank", "4,3"], ["go"])).toEqual(["go", "run", ".", "rank", "4,3"]);
    expect(resolve(files, ["youngctl"], ["go"])).toEqual(["go", "run", "./cmd/youngctl"]);
    expect(resolve(files, ["shape"], ["go"])).toBeNull();
  });

  test("an executable .NET project by its tool command, assembly and file name", () => {
    const csproj = "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Exe</OutputType><AssemblyName>sedstep</AssemblyName></PropertyGroup></Project>";
    const files = { "src/Sedstep.Cli/Sedstep.Cli.csproj": csproj };
    const launcher = ["dotnet", "run", "--project", "src/Sedstep.Cli/Sedstep.Cli.csproj", "--"];
    expect(resolve(files, ["sedstep", "-n"], ["dotnet"])).toEqual([...launcher, "-n"]);
    expect(resolve(files, ["Sedstep.Cli"], ["dotnet"])).toEqual(launcher);
    expect(resolve({ "Lib.csproj": "<Project><PropertyGroup></PropertyGroup></Project>" }, ["Lib"], ["dotnet"])).toBeNull();
  });

  test("a Maven jar with a main class and a Gradle application", () => {
    const pom = "<project><artifactId>lanewalk</artifactId><build><plugins><plugin><configuration><mainClass>com.ex.Main</mainClass></configuration></plugin></plugins></build></project>";
    expect(resolve({ "pom.xml": pom }, ["lanewalk", "a.txt"], ["mvn", "java"])).toEqual(["java", "-cp", "target/classes", "com.ex.Main", "a.txt"]);
    const gradle = 'plugins { kotlin("jvm") version "2.1.0"; application }\napplication { mainClass.set("com.ex.MainKt") }\n';
    expect(
      resolve({ "build.gradle.kts": gradle, "settings.gradle.kts": 'rootProject.name = "propdrift"\n' }, ["propdrift"], ["gradle", "java"]),
    ).toEqual(["java", "-cp", "build/classes/kotlin/main", "com.ex.MainKt"]);
  });

  test("a package.json bin runs under Bun or Node", () => {
    const files = { "package.json": JSON.stringify({ name: "@ex/pngvet", bin: "src/cli.ts" }) };
    expect(resolve(files, ["pngvet", "a.png"], ["bun"])).toEqual(["bun", "src/cli.ts", "a.png"]);
    expect(resolve({ "package.json": JSON.stringify({ bin: { jv: "bin/jv.js" } }) }, ["jv"], ["node"])).toEqual(["node", "bin/jv.js"]);
  });

  test("no entry point, a path, or a launcher the checks do not start gives no command", () => {
    const root = project({ "Cargo.toml": '[package]\nname = "routeshadow"\n', "src/main.rs": "" });
    expect(entryPointCommand(root, ["other"], ["cargo"])).toBeNull();
    expect(entryPointCommand(root, ["./routeshadow"], ["cargo"])).toBeNull();
    expect(entryPointCommand(root, ["routeshadow"], ["bun"])).toBeNull();
    expect(projectEntryPoints(root).map((e) => e.name)).toEqual(["routeshadow"]);
  });
});

describe("README fragments of bench round 55", () => {
  test("HTTP methods and digest names are values, not placeholders", () => {
    expect(placeholderOf("routeshadow match app.txt GET /users/42 --all")).toBeNull();
    expect(placeholderOf("tool hash --algo SHA256 data.bin")).toBeNull();
    expect(placeholderOf("routeshadow match FILE GET /users/42")).toBe("FILE");
  });

  test("a command block followed by a sample file is no example (structpad)", () => {
    const readme = [
      `${fence}sh`,
      "python -m structpad --help",
      fence,
      `${fence}`,
      "// wire structs",
      "struct Header { u8 kind; u16 len; }",
      fence,
      `${fence}sh`,
      "python -m structpad layout net.sp",
      fence,
      "Given this input `net.sp`:",
      fence,
      "struct Header { u8 kind; }",
      fence,
      `${fence}sh`,
      "python -m structpad layout net.sp",
      fence,
      "It prints:",
      fence,
      "Header 1 byte",
      fence,
    ].join("\n");
    expect(extractExamples("README.md", readme).map((e) => [e.command, e.documented])).toEqual([
      ["python -m structpad layout net.sp", "Header 1 byte"],
    ]);
  });

  async function readmeRun(readme: string, files: Record<string, string>, executables: string[]) {
    const root = project(files);
    return runDocExamples(new ProcessScope(), [{ path: "README.md", text: readme }], {
      root,
      files: Object.keys(files),
      executables,
      signal: new AbortController().signal,
      sandbox: () => null,
    });
  }

  const routeshadow = {
    "package.json": JSON.stringify({ name: "routeshadow", bin: { routeshadow: "cli.js" } }),
    "cli.js": `const [cmd, file, method, path] = process.argv.slice(2);
if (cmd === "match") console.log(method + " " + path + " -> users.show (" + require("fs").readFileSync(file, "utf8").trim() + ")");
else console.log("usage: routeshadow match FILE METHOD PATH");`,
    "app.txt": "GET /users/:id users.show",
  };

  test("the project's own command runs through its launcher and matches", async () => {
    const readme = [
      `${fence}console`,
      "$ routeshadow match app.txt GET /users/42",
      "GET /users/42 -> users.show (GET /users/:id users.show)",
      "$ routeshadow",
      "usage: routeshadow match FILE METHOD PATH",
      fence,
    ].join("\n");
    const results = await readmeRun(readme, routeshadow, ["bun"]);
    expect(results.map((r) => r.status)).toEqual(["match", "match"]);
  });

  test("the project's own command that prints something else is a mismatch", async () => {
    const readme = [`${fence}console`, "$ routeshadow match app.txt POST /users", "POST /users -> users.create", fence].join("\n");
    const [result] = await readmeRun(readme, routeshadow, ["bun"]);
    expect(result?.status).toBe("mismatch");
    expect(result?.firstDifference?.actual).toContain("users.show");
  });

  test.skipIf(!Bun.which("python3"))("a Python console script runs through the environment's interpreter (stampbook)", async () => {
    const readme = [`${fence}console`, "$ stampbook status", "0 stamps", fence].join("\n");
    const results = await readmeRun(
      readme,
      {
        "pyproject.toml": '[project]\nname = "stampbook"\n\n[project.scripts]\nstampbook = "stampbook.cli:main"\n',
        "stampbook/__init__.py": "",
        "stampbook/cli.py": "import sys\n\ndef main():\n    print('0 stamps' if sys.argv[1:] == ['status'] else sys.argv[0])\n    return 0\n",
      },
      ["python3"],
    );
    expect(results.map((r) => [r.status, r.reason])).toEqual([["match", undefined]]);
  });

  test("run_probe resolves the project's own command the same way", async () => {
    const root = project(routeshadow);
    const outcome = await runProbe(new ProcessScope(), { executable: "routeshadow", args: ["match", "app.txt", "GET", "/a"] }, {
      root,
      executables: ["bun"],
      generated: [],
      signal: new AbortController().signal,
      sandbox: null,
    });
    expect(outcome.status).not.toBe("refused");
    expect(JSON.stringify(outcome)).toContain("users.show");
  });
});
