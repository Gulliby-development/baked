import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixerCommand } from "../src/core/workflows/check-policy.js";
import { detectGates } from "../src/core/workflows/gates.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});
const workspace = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "fixer-command-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
};
/** The fixer command of every suggested gate that declares one, for `path`. */
const fixers = (root: string, path: string) =>
  detectGates(root).flatMap((s) =>
    s.check.fix ? [{ id: s.check.id, ...fixerCommand(s.check.fix, path) }] : [],
  );

// Bench round 08, commitbump: `cargo fmt src/main.rs` is rejected by cargo and formatted nothing.
describe("the command that applies a fixer to one file", () => {
  test("Rust: cargo takes file arguments after --", () => {
    const root = workspace({ "Cargo.toml": '[package]\nname = "c"\nversion = "0.1.0"\n' });
    expect(fixers(root, "src/lib.rs")).toEqual([
      { id: "cargo-fmt", executable: "cargo", args: ["fmt", "--", "src/lib.rs"] },
    ]);
  });

  test("Go: gofmt formats a file, go fmt only takes packages", () => {
    const root = workspace({ "go.mod": "module m\n\ngo 1.21\n" });
    expect(fixers(root, "pkg/a.go")).toEqual([
      { id: "go-vet", executable: "gofmt", args: ["-w", "pkg/a.go"] },
    ]);
  });

  test(".NET: dotnet format selects the file with --include", () => {
    const one = workspace({ "app.csproj": "<Project />" });
    expect(fixers(one, "src/A.cs")).toEqual([
      { id: "dotnet-format", executable: "dotnet", args: ["format", "--include", "src/A.cs"] },
    ]);
    const several = workspace({ "a.csproj": "<Project />", "b.csproj": "<Project />" });
    expect(fixers(several, "A.cs")[0]?.args).toEqual(["format", "a.csproj", "--include", "A.cs"]);
  });

  test("Python, TypeScript and Maven: a trailing path, or no fixer", () => {
    const py = workspace({ "ruff.toml": "", "pyproject.toml": "[tool.ruff]\n" });
    expect(fixers(py, "app/x.py")).toEqual([
      { id: "ruff", executable: "ruff", args: ["check", "--fix", "app/x.py"] },
    ]);
    expect(
      fixerCommand({ executable: "bun", args: ["x", "biome", "check", "--write"] }, "src/a.ts"),
    ).toEqual({ executable: "bun", args: ["x", "biome", "check", "--write", "src/a.ts"] });
    expect(fixers(workspace({ "pom.xml": "<project />" }), "src/A.java")).toEqual([]);
  });

  test("an explicit passthrough or include is kept; windows executable names match", () => {
    expect(fixerCommand({ executable: "cargo", args: ["fmt", "--", "--edition", "2021"] }, "a.rs").args).toEqual([
      "fmt", "--", "--edition", "2021", "a.rs",
    ]);
    expect(fixerCommand({ executable: String.raw`C:\tools\cargo.exe`, args: ["fmt"] }, "a.rs").args).toEqual(["fmt", "--", "a.rs"]);
  });
});

const available = (command: string, args: string[]): boolean => {
  try {
    return Bun.spawnSync([command, ...args], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
};

describe("the fixer command formats a file with the real tool", () => {
  test.skipIf(!available("cargo", ["fmt", "--version"]))("cargo fmt -- <file>", () => {
    const root = workspace({
      "Cargo.toml": '[package]\nname = "c"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": "pub   fn   x( ){ }\n",
    });
    const fix = { executable: "cargo", args: ["fmt"] };
    const command = fixerCommand(fix, "src/lib.rs");
    const run = Bun.spawnSync([command.executable, ...command.args], { cwd: root });
    expect(run.exitCode).toBe(0);
    expect(readFileSync(join(root, "src/lib.rs"), "utf8").replace(/\r\n/g, "\n")).toBe("pub fn x() {}\n");
    // The shape the runs used before is rejected by cargo and formats nothing.
    writeFileSync(join(root, "src/lib.rs"), "pub   fn   x( ){ }\n");
    const old = Bun.spawnSync(["cargo", "fmt", "src/lib.rs"], { cwd: root, stderr: "pipe" });
    expect(old.exitCode).not.toBe(0);
    expect(readFileSync(join(root, "src/lib.rs"), "utf8")).toContain("pub   fn");
  });

  test.skipIf(!available("gofmt", ["-h"]) && !available("gofmt", ["-l", "."]))("gofmt -w <file>", () => {
    const root = workspace({ "go.mod": "module m\n\ngo 1.21\n", "a.go": "package m\nfunc  A( ) { }\n" });
    const command = fixerCommand({ executable: "go", args: ["fmt", "./..."] }, "a.go");
    expect(Bun.spawnSync([command.executable, ...command.args], { cwd: root }).exitCode).toBe(0);
    expect(readFileSync(join(root, "a.go"), "utf8").replace(/\r\n/g, "\n")).toBe("package m\n\nfunc A() {}\n");
  });
});
