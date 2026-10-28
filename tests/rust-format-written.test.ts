import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fixerCommand } from "../src/core/workflows/check-policy.js";
import { rustFormatWrittenChecks } from "../src/core/workflows/format-written.js";

// #2248: the task-end rustfmt check against the real rustfmt: it fails on the task's unformatted
// file, its fixer formats that file only, and the check then passes.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The test preload points HOME at an empty profile, where the rustup proxy finds no toolchain.
process.env.RUSTUP_HOME ??= join(homedir(), ".rustup");
const hasRustfmt = spawnSync("rustfmt", ["--version"], { stdio: "ignore", timeout: 60_000 }).status === 0;

describe("task-end rustfmt check (#2248)", () => {
  test.skipIf(!hasRustfmt)("fails on the task's unformatted file, and its fixer formats that file only", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "baked-rustfmt-written-")));
    dirs.push(root);
    const files = {
      "Cargo.toml": '[package]\nname = "p"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": "pub async fn go()   {}\n",
      "tests/json.rs": "#[test]\nfn parses(){assert_eq!(1,1);}\n",
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const [check, ...rest] = rustFormatWrittenChecks(root, [], [{ path: "tests/json.rs", action: "create" }]);
    expect(rest).toEqual([]);
    const run = (c: { executable: string; args: string[] }) => spawnSync(c.executable, c.args, { cwd: root, encoding: "utf8" });
    expect(run(check!).status).toBe(1);
    expect(run(fixerCommand(check!.fix!, "tests/json.rs")).status).toBe(0);
    expect(run(check!).status).toBe(0);
    expect(readFileSync(join(root, "tests/json.rs"), "utf8")).toBe("#[test]\nfn parses() {\n    assert_eq!(1, 1);\n}\n");
    // The crate's other file is left as it was.
    expect(readFileSync(join(root, "src/lib.rs"), "utf8")).toBe("pub async fn go()   {}\n");
  });
});
