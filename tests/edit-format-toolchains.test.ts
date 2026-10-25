import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { canAutoFormat, cargoEdition, formatProbeCommand, resetFormatCache, singleFileFormat } from "../src/core/tools/auto-format.js";
import { BUN_FMT } from "../src/core/tools/bun-fmt.js";
import { detectProfile, formatFile } from "../src/core/tools/project.js";

// #1681: bare rustfmt parses as Rust 2015, so an `async fn` in a 2021 crate failed the probe and
// no Rust file was formatted after an edit; formatting lib.rs rewrote every module it declares;
// a prettier configuration kept in package.json was not found.

const dirs: string[] = [];
afterEach(() => {
  resetFormatCache();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "baked-edit-format-")));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

// The test preload points HOME at an empty profile, where the rustup proxy finds no toolchain;
// os.homedir() still names the real home (as in the gate matrix's toolchain tier).
process.env.RUSTUP_HOME ??= join(homedir(), ".rustup");
const hasRustfmt = spawnSync("rustfmt", ["--version"], { stdio: "ignore", timeout: 60_000 }).status === 0;
// `bun fmt` ships with Bun 1.4.4; an older Bun lists no `--range-start` here.
const hasStylua = spawnSync("stylua", ["--version"], { stdio: "ignore", timeout: 60_000 }).status === 0;
const hasBunFmt = (spawnSync("bun", ["fmt", "--no-script", "--help", "--all"], { encoding: "utf8", timeout: 60_000 }).stdout ?? "").includes("--range-start");
const CRATE = '[package]\nname = "c"\nversion = "0.1.0"\nedition = "2021"\n';

describe("edit-time formatting per toolchain (#1681)", () => {
  test("reads the crate's edition, inherited from the workspace too", () => {
    const root = project({
      "Cargo.toml": '[workspace]\nmembers = ["svc"]\n\n[workspace.package]\nedition = "2024"\n',
      "svc/Cargo.toml": '[package]\nname = "svc"\nedition.workspace = true\n',
      "svc/src/lib.rs": "",
      "old/Cargo.toml": '[package]\nname = "old"\n',
      "old/src/lib.rs": "",
      "new/Cargo.toml": CRATE,
      "new/src/lib.rs": "",
    });
    expect(cargoEdition(join(root, "svc/src/lib.rs"))).toBe("2024");
    expect(cargoEdition(join(root, "old/src/lib.rs"))).toBeNull();
    expect(cargoEdition(join(root, "new/src/lib.rs"))).toBe("2021");
    expect(singleFileFormat("rustfmt", join(root, "new/src/lib.rs"))).toStartWith("rustfmt --edition 2021 --config skip_children=true ");
  });

  test.skipIf(!hasRustfmt)("formats an async fn of a 2021 crate and leaves the modules it declares alone", async () => {
    const root = project({ "Cargo.toml": CRATE, "src/lib.rs": "mod util;\npub async fn go()   {}\n", "src/util.rs": "pub fn   u() {}\n" });
    expect(await formatFile(join(root, "src/lib.rs"), root)).toBe(true);
    expect(readFileSync(join(root, "src/lib.rs"), "utf8")).toBe("mod util;\npub async fn go() {}\n");
    expect(readFileSync(join(root, "src/util.rs"), "utf8")).toBe("pub fn   u() {}\n");
    // A formatted pre-image proves the formatter clean, so the file is formatted after an edit.
    expect(await canAutoFormat(join(root, "src/lib.rs"), "mod util;\npub async fn go() {}\n", root)).toBe(true);
  });

  test("finds prettier configured in package.json and in the other config names", async () => {
    const key = project({ "package.json": JSON.stringify({ name: "x", prettier: { semi: false } }) });
    expect((await detectProfile(key)).formatFile).toBe("npx prettier --write");
    const toml = project({ "package.json": JSON.stringify({ name: "x" }), ".prettierrc.toml": "semi = false\n" });
    expect((await detectProfile(toml)).formatFile).toBe("npx prettier --write");
    const ts = project({ "package.json": JSON.stringify({ name: "x" }), "bun.lock": "", "prettier.config.ts": "export default {};\n" });
    expect((await detectProfile(ts)).formatFile).toBe("bunx prettier --write");
  });

  test("dprint and deno get a stdin probe, so they format after an edit", () => {
    expect(formatProbeCommand("bunx dprint fmt", "/w/a.ts")).toMatch(/^bunx dprint fmt --stdin .*a\.ts.?$/);
    expect(formatProbeCommand("deno fmt", "/w/a.tsx")).toBe("deno fmt --ext tsx -");
  });

  // #1920: `bun fmt` is used where a project opted in with `[fmt]` in bunfig.toml.
  test("finds bun fmt from a [fmt] section, after biome and dprint and ahead of prettier", async () => {
    const pkg = JSON.stringify({ name: "x", scripts: { fmt: "echo not-the-formatter" } });
    const bunfig = "[fmt]\nprintWidth = 100\n";
    expect((await detectProfile(project({ "package.json": pkg, "bun.lock": "", "bunfig.toml": bunfig }))).formatFile).toBe(BUN_FMT);
    expect((await detectProfile(project({ "package.json": pkg, "bunfig.toml": bunfig, ".prettierrc": "{}" }))).formatFile).toBe(BUN_FMT);
    expect((await detectProfile(project({ "package.json": pkg, "bun.lock": "", "bunfig.toml": bunfig, "biome.json": "{}" }))).formatFile).toBe("bunx biome format --write");
    expect((await detectProfile(project({ "package.json": pkg, "bun.lock": "", "bunfig.toml": bunfig, "dprint.json": "{}" }))).formatFile).toBe("bunx dprint fmt");
    // No [fmt] section (or an unreadable bunfig): nothing changes.
    expect((await detectProfile(project({ "package.json": pkg, "bun.lock": "", "bunfig.toml": "[test]\ntimeout = 5000\n" }))).formatFile).toBeNull();
    expect((await detectProfile(project({ "package.json": pkg, "bun.lock": "", "bunfig.toml": "[fmt\n" }))).formatFile).toBeNull();
    expect(formatProbeCommand(BUN_FMT, "/w/a.ts")).toMatch(/^bun fmt --no-script --stdin-filepath .*a\.ts.?$/);
  });

  // #1495: StyLua reads the pre-image from stdin with the file's path for its config and ignores.
  test("StyLua gets a stdin probe", () => {
    expect(formatProbeCommand("stylua", "/w/a.lua")).toMatch(/^stylua --stdin-filepath .*a\.lua.? -$/);
  });

  // #1497: shfmt reads the pre-image from stdin and the path for its .editorconfig.
  test("shfmt gets a stdin probe", () => {
    expect(formatProbeCommand("shfmt -w", "/w/a.sh")).toMatch(/^shfmt --filename .*a\.sh.?$/);
  });

  // #1490: clang-format reads the pre-image from stdin and the path for its .clang-format.
  test("clang-format gets a stdin probe", () => {
    expect(formatProbeCommand("clang-format -i", "/w/a.cpp")).toMatch(/^clang-format --assume-filename=.*a\.cpp.?$/);
  });

  test.skipIf(!hasStylua)("StyLua formats one edited file only when it was clean", async () => {
    const root = project({ "stylua.toml": "", ".luacheckrc": "", "src/a.lua": "local a = {b=1}\n", "src/b.lua": "local b = {c=2}\n" });
    expect(await formatFile(join(root, "src/a.lua"), root)).toBe(true);
    expect(readFileSync(join(root, "src/a.lua"), "utf8")).toBe("local a = { b = 1 }\n");
    expect(readFileSync(join(root, "src/b.lua"), "utf8")).toBe("local b = {c=2}\n");
    expect(await canAutoFormat(join(root, "src/a.lua"), "local a = { b = 1 }\n", root)).toBe(true);
    expect(await canAutoFormat(join(root, "src/a.lua"), "local a = {b=1}\n", root)).toBe(false);
  });

  test.skipIf(!hasBunFmt)("bun fmt formats one file after an edit, not the project's fmt script", async () => {
    const root = project({
      "package.json": JSON.stringify({ name: "x", scripts: { fmt: "echo not-the-formatter" } }),
      "bunfig.toml": "[fmt]\n",
      "src/a.ts": "const a = {b:1}\n",
      "src/b.ts": "const b = {c:2}\n",
    });
    expect(await formatFile(join(root, "src/a.ts"), root)).toBe(true);
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("const a = { b: 1 };\n");
    expect(readFileSync(join(root, "src/b.ts"), "utf8")).toBe("const b = {c:2}\n");
    expect(await canAutoFormat(join(root, "src/a.ts"), "const a = { b: 1 };\n", root)).toBe(true);
    expect(await canAutoFormat(join(root, "src/a.ts"), "const a = {b:1}\n", root)).toBe(false);
  });
});
