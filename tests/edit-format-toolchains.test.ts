import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canAutoFormat, cargoEdition, formatProbeCommand, resetFormatCache, singleFileFormat } from "../src/core/tools/auto-format.js";
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

const hasRustfmt = Bun.which("rustfmt") !== null;
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
});
