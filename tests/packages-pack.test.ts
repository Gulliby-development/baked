import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandPickerConfig } from "../src/components/modals/CommandPicker.js";
import { handlePackages, parsePackArgs } from "../src/core/commands/packages.js";
import type { CommandContext } from "../src/core/commands/types.js";
import { MANIFEST_FILE, PackageError, readPackage } from "../src/core/packages/manifest.js";
import { describePack, packPackage } from "../src/core/packages/pack.js";
import { type InspectOptions, inspectPackage, installPackage } from "../src/core/packages/packages.js";
import { hashBytes } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { runPackagesCli } from "../src/headless/packages.js";
import { packageFiles } from "./helpers/package-fixture.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await removeTempDir(dir);
});

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
};
/** A package folder with the files but no manifest. */
function folder(files: Record<string, string> = packageFiles()): string {
  const root = temp("baked-pack-");
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}
function workspace(): { root: string; options: InspectOptions } {
  const root = temp("baked-pack-ws-");
  const user = temp("baked-pack-user-");
  return { root, options: { policy: defaultWorkflowPolicy, gateDirectories: { user, project: join(root, "baked", "gates") } } };
}
const manifestText = (dir: string) => readFileSync(join(dir, MANIFEST_FILE), "utf8");
function refusal(action: () => unknown): PackageError {
  try {
    action();
  } catch (error) {
    if (error instanceof PackageError) return error;
    throw error;
  }
  throw new Error("expected a PackageError");
}

describe("packPackage", () => {
  test("writes sorted files with their hashes, 2-space JSON and a trailing newline", () => {
    const files = packageFiles();
    const dir = folder(files);
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    const result = packPackage(dir, { name: "acme-review", version: "1.0.0", description: "Review kit", policy: defaultWorkflowPolicy });
    expect(result.problems).toEqual([]);
    expect(result.written).toBe(true);
    expect(result.existing).toBe(false);
    const expected = {
      schemaVersion: 1,
      name: "acme-review",
      version: "1.0.0",
      description: "Review kit",
      files: Object.keys(files)
        .sort()
        .map((path) => ({ path, sha256: hashBytes(files[path] ?? "") })),
    };
    expect(manifestText(dir)).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(result.contents.workflows).toEqual(["pkg-quick"]);
    // Nothing but the manifest was written, and no temp file is left.
    expect(readdirSync(dir).sort()).toEqual([".git", "agents", MANIFEST_FILE, "gates", "skills", "workflows"]);
    expect(readPackage(dir).manifest).toEqual(expected);
  });

  test("refreshes the hashes and keeps the existing name, version and description", () => {
    const dir = folder();
    packPackage(dir, { name: "acme-review", version: "1.0.0", description: "Kit" });
    writeFileSync(join(dir, "skills", "review-notes", "checklist.txt"), "more edges\n");
    expect(packPackage(dir, { check: true }).upToDate).toBe(false);
    const result = packPackage(dir);
    expect(result.written).toBe(true);
    const manifest = JSON.parse(manifestText(dir));
    expect([manifest.name, manifest.version, manifest.description]).toEqual(["acme-review", "1.0.0", "Kit"]);
    expect(manifest.files.find((f: { path: string }) => f.path === "skills/review-notes/checklist.txt").sha256).toBe(hashBytes("more edges\n"));
    // A new version replaces the old one; an empty description removes it.
    packPackage(dir, { version: "1.1.0", description: "" });
    expect(JSON.parse(manifestText(dir))).toMatchObject({ name: "acme-review", version: "1.1.0" });
    expect(JSON.parse(manifestText(dir)).description).toBeUndefined();
    // An unchanged package leaves the file alone.
    const before = statSync(join(dir, MANIFEST_FILE)).mtimeMs;
    const again = packPackage(dir);
    expect([again.written, again.upToDate]).toEqual([false, true]);
    expect(statSync(join(dir, MANIFEST_FILE)).mtimeMs).toBe(before);
  });

  test("check reports stale and up to date without writing", () => {
    const dir = folder();
    const missing = packPackage(dir, { name: "acme-review", version: "1.0.0", check: true });
    expect([missing.written, missing.upToDate, missing.existing]).toEqual([false, false, false]);
    expect(missing.manifest?.files.length).toBe(Object.keys(packageFiles()).length);
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
    expect(describePack(missing, true).join("\n")).toContain("does not exist yet");

    packPackage(dir, { name: "acme-review", version: "1.0.0" });
    // Order and formatting do not make a manifest stale.
    const manifest = JSON.parse(manifestText(dir));
    manifest.files.reverse();
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest));
    const fresh = packPackage(dir, { check: true });
    expect([fresh.upToDate, fresh.written]).toEqual([true, false]);
    expect(describePack(fresh, true).join("\n")).toContain("is up to date");

    writeFileSync(join(dir, "gates", "scripts", "check.sh"), "#!/bin/sh\nexit 1\n");
    const stale = packPackage(dir, { check: true });
    expect(stale.upToDate).toBe(false);
    expect(describePack(stale, true).join("\n")).toContain("out of date");
    expect(JSON.parse(manifestText(dir))).toEqual(manifest);
    // A different version given with --check is stale too.
    writeFileSync(join(dir, "gates", "scripts", "check.sh"), "#!/bin/sh\nexit 0\n");
    expect(packPackage(dir, { check: true }).upToDate).toBe(true);
    expect(packPackage(dir, { check: true, version: "2.0.0" }).upToDate).toBe(false);
  });

  test("refuses a broken layout and writes nothing", () => {
    for (const extra of [{ "docs/readme.md": "x" }, { "agents/a/b.json": "{}" }, { "gates/run.sh": "echo\n" }, { "skills/notes/.hidden": "x" }]) {
      const dir = folder({ ...packageFiles(), ...extra });
      const result = packPackage(dir, { name: "acme-review", version: "1.0.0" });
      expect(result.problems.length).toBeGreaterThan(0);
      expect(result.written).toBe(false);
      expect(result.manifest).toBeNull();
      expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
    }
    const noSkill = folder({ ...packageFiles(), "skills/other/notes.md": "x" });
    expect(packPackage(noSkill, { name: "a", version: "1.0.0" }).problems).toContain("skills/other/ has no SKILL.md");
    const empty = temp("baked-pack-empty-");
    expect(packPackage(empty, { name: "a", version: "1.0.0" }).problems).toEqual(["The package holds no files besides the manifest"]);
  });

  test("refuses definitions an install would refuse, checked against the package alone", () => {
    const files = packageFiles();
    delete files["gates/lint.json"];
    files["gates/bad.json"] = JSON.stringify({ schemaVersion: 1, id: "other" });
    const dir = folder(files);
    const problems = packPackage(dir, { name: "acme-review", version: "1.0.0" }).problems.join("\n");
    expect(problems).toContain("workflows/pkg-quick.json");
    expect(problems).toContain("gates/bad.json");
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);

    // A profile's skill must ship in the package; the project's skills do not count here.
    const noSkill = packageFiles();
    delete noSkill["skills/review-notes/SKILL.md"];
    delete noSkill["skills/review-notes/checklist.txt"];
    expect(packPackage(folder(noSkill), { name: "a", version: "1.0.0" }).problems.join("\n")).toContain("needs skill review-notes");
  });

  test("an existing manifest that is not JSON needs a name and a version", () => {
    const dir = folder();
    writeFileSync(join(dir, MANIFEST_FILE), "not json");
    expect(refusal(() => packPackage(dir)).code).toBe("INVALID_ARGUMENT");
    expect(packPackage(dir, { name: "acme-review", version: "1.0.0" }).written).toBe(true);
  });

  test.skipIf(process.platform === "win32")("refuses symbolic links", () => {
    // Creating symbolic links needs extra rights on Windows.
    const dir = folder();
    symlinkSync("/etc/hostname", join(dir, "gates", "scripts", "link.sh"));
    const result = packPackage(dir, { name: "acme-review", version: "1.0.0" });
    expect(result.problems.join("\n")).toContain("gates/scripts/link.sh is a symbolic link");
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
  });

  test("refuses files over the size limit", () => {
    const dir = folder({ ...packageFiles(), "gates/scripts/big.bin": "x".repeat(2 * 1024 * 1024 + 1) });
    expect(packPackage(dir, { name: "a", version: "1.0.0" }).problems).toContain("gates/scripts/big.bin is larger than 2097152 bytes");
  });

  test("bad arguments and missing folders throw", () => {
    const dir = folder();
    expect(refusal(() => packPackage(dir)).code).toBe("INVALID_ARGUMENT");
    expect(refusal(() => packPackage(dir, { name: "a" })).message).toContain("a version");
    expect(refusal(() => packPackage(dir, { name: "Acme Review", version: "1.0.0" })).code).toBe("INVALID_ARGUMENT");
    expect(refusal(() => packPackage(dir, { name: "a", version: "1.0" })).code).toBe("INVALID_ARGUMENT");
    expect(refusal(() => packPackage(join(dir, "nowhere"), { name: "a", version: "1.0.0" })).code).toBe("NOT_FOUND");
    expect(refusal(() => packPackage(join(dir, "gates", "lint.json"), { name: "a", version: "1.0.0" })).code).toBe("INVALID_PACKAGE");
    // The manifest path names its folder.
    packPackage(dir, { name: "a", version: "1.0.0" });
    expect(packPackage(join(dir, MANIFEST_FILE), { check: true }).upToDate).toBe(true);
  });

  test("a packed package plans and installs with baked add", () => {
    const dir = folder();
    packPackage(dir, { name: "acme-review", version: "1.0.0" });
    const { root, options } = workspace();
    const plan = inspectPackage(dir, root, options);
    expect(plan.problems).toEqual([]);
    expect(installPackage(plan, { approved: true, ...options }).written.length).toBe(Object.keys(packageFiles()).length);
  });
});

describe("baked packages pack", () => {
  const capture = () => {
    const out = { text: "" };
    return { out, print: (text: string) => void (out.text += text) };
  };

  test("writes, checks and refuses with the documented exit codes", async () => {
    const { root, options } = workspace();
    const dir = folder();
    const { out, print } = capture();
    const deps = { workspace: root, print, isInteractive: false, options };
    expect(await runPackagesCli(["pack", dir, "--name", "acme-review", "--version=1.0.0", "--description", "Review kit"], deps)).toBe(0);
    expect(out.text).toContain("Wrote");
    expect(JSON.parse(manifestText(dir)).description).toBe("Review kit");
    expect(await runPackagesCli(["pack", dir, "--check"], deps)).toBe(0);
    writeFileSync(join(dir, "skills", "review-notes", "checklist.txt"), "changed\n");
    expect(await runPackagesCli(["pack", dir, "--check"], deps)).toBe(1);
    out.text = "";
    expect(await runPackagesCli(["pack", dir, "--json"], deps)).toBe(0);
    expect(JSON.parse(out.text)).toMatchObject({ name: "acme-review", written: true, problems: [] });
    expect(await runPackagesCli(["pack", dir, "--check"], deps)).toBe(0);
    // Refused: a file outside the layout.
    writeFileSync(join(dir, "notes.txt"), "x");
    expect(await runPackagesCli(["pack", dir], deps)).toBe(1);
    expect(await runPackagesCli(["pack", dir, "--check"], deps)).toBe(1);
  });

  test("bad arguments and missing paths exit 2", async () => {
    const { root, options } = workspace();
    const dir = folder();
    const deps = { workspace: root, print: () => {}, isInteractive: false, options };
    expect(await runPackagesCli(["pack"], deps)).toBe(2);
    expect(await runPackagesCli(["pack", dir, "--name"], deps)).toBe(2);
    expect(await runPackagesCli(["pack", dir, "--bogus"], deps)).toBe(2);
    expect(await runPackagesCli(["pack", dir], deps)).toBe(2);
    expect(await runPackagesCli(["pack", dir, "--name", "Bad Name", "--version", "1.0.0"], deps)).toBe(2);
    expect(await runPackagesCli(["pack", join(dir, "nowhere"), "--name", "a", "--version", "1.0.0"], deps)).toBe(2);
    expect(await runPackagesCli(["list", "--check"], deps)).toBe(2);
    expect(await runPackagesCli(["add", dir, "--name", "a"], deps)).toBe(2);
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
  });
});

describe("/packages pack in the terminal UI", () => {
  test("parses its arguments", () => {
    expect(parsePackArgs('pkgs/acme --name acme --version 1.0.0 --description "A kit" --check')).toEqual({ path: "pkgs/acme", name: "acme", version: "1.0.0", description: "A kit", check: true });
    expect(parsePackArgs("my pkg")).toEqual({ path: "my pkg", check: false });
    expect(parsePackArgs("pkg --name")).toBeNull();
    expect(parsePackArgs("pkg --other")).toBeNull();
    expect(parsePackArgs("--check")).toBeNull();
  });

  test("writes the manifest and prints the result", () => {
    const { root, options } = workspace();
    const dir = folder();
    const messages: string[] = [];
    const pickers: CommandPickerConfig[] = [];
    const ctx = {
      cwd: root,
      chat: { setMessages: (update: (prev: { content: string }[]) => { content: string }[]) => messages.push(update([]).at(-1)?.content ?? "") },
      openCommandPicker: (config: CommandPickerConfig) => pickers.push(config),
    } as unknown as CommandContext;
    handlePackages(`/packages pack ${dir} --name acme-review --version 1.0.0`, ctx, () => options);
    expect(messages.at(-1)).toContain("Wrote");
    expect(JSON.parse(manifestText(dir)).name).toBe("acme-review");
    handlePackages(`/packages pack ${dir} --check`, ctx, () => options);
    expect(messages.at(-1)).toContain("is up to date");
    handlePackages(`/packages pack ${join(dir, "nowhere")}`, ctx, () => options);
    expect(messages.at(-1)).toContain("does not exist");
    handlePackages("/packages pack", ctx, () => options);
    expect(messages.at(-1)).toContain("Usage: /packages");
    expect(pickers).toEqual([]);
  });
});
