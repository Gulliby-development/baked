import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandPickerConfig } from "../src/components/modals/CommandPicker.js";
import { handlePackages } from "../src/core/commands/packages.js";
import type { CommandContext } from "../src/core/commands/types.js";
import { PackageError } from "../src/core/packages/manifest.js";
import {
  describePlan,
  type InspectOptions,
  inspectPackage,
  installPackage,
  listPackages,
  readLock,
  removePackage,
} from "../src/core/packages/packages.js";
import { hashBytes } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { confirmGates, loadGateLibrary, readConfirmations, unconfirmedGates } from "../src/core/workflows/v2/library.js";
import { runPackagesCli } from "../src/headless/packages.js";
import { packageFiles, SKILL_TEXT, writePackage } from "./helpers/package-fixture.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await removeTempDir(dir);
});

function workspace(): { root: string; options: InspectOptions } {
  const root = mkdtempSync(join(tmpdir(), "baked-packages-ws-"));
  const user = mkdtempSync(join(tmpdir(), "baked-packages-user-"));
  cleanups.push(root, user);
  // The user's own gate folder is a temporary one, so the developer's ~/.baked never counts.
  return { root, options: { policy: defaultWorkflowPolicy, gateDirectories: { user, project: join(root, "baked", "gates") } } };
}
function pkg(...args: Parameters<typeof writePackage>): string {
  const root = writePackage(...args);
  cleanups.push(root);
  return root;
}
function refusal(action: () => unknown): PackageError {
  try {
    action();
  } catch (error) {
    if (error instanceof PackageError) return error;
    throw error;
  }
  throw new Error("expected a PackageError");
}
const read = (root: string, path: string) => readFileSync(join(root, ...path.split("/")), "utf8");

describe("package checks", () => {
  test("a valid package plans every file into baked/ and validates its definitions", () => {
    const { root, options } = workspace();
    const plan = inspectPackage(pkg(), root, options);
    expect(plan.problems).toEqual([]);
    expect(plan.name).toBe("acme-review");
    expect(plan.files.map((f) => f.target).sort()).toEqual(Object.keys(packageFiles()).map((p) => `baked/${p}`).sort());
    expect(plan.files.every((f) => f.status === "new")).toBe(true);
    expect(plan.contents).toEqual({ agents: ["pkg-reviewer"], skills: ["review-notes"], workflows: ["pkg-quick"], gates: ["lint", "task-tests", "tests", "typecheck"] });
    expect(plan.gatesToConfirm.sort()).toEqual(["lint", "task-tests", "tests", "typecheck"]);
    expect(describePlan(plan).join("\n")).toContain("baked workflow gates confirm");
    // Inspecting writes nothing.
    expect(existsSync(join(root, "baked"))).toBe(false);
  });

  test("a hash mismatch is refused", () => {
    const { root, options } = workspace();
    const dir = pkg(packageFiles(), { manifest: (m) => ((m.files as { sha256: string }[])[0] as { sha256: string }).sha256 = "0".repeat(64) });
    expect(refusal(() => inspectPackage(dir, root, options)).code).toBe("HASH_MISMATCH");
  });

  test("paths that leave the package or the package kinds are refused", () => {
    const { root, options } = workspace();
    for (const path of ["../escape.json", "agents/../../x.json", "/etc/passwd", "C:/x.json", "agents\\x.json", "docs/readme.md", "agents/a/b.json", "skills/SKILL.md", "gates/run.sh", "agents/.hidden.json"]) {
      const dir = pkg({ "agents/x.json": "{}" }, { manifest: (m) => (m.files = [{ path, sha256: hashBytes("{}") }]) });
      expect(refusal(() => inspectPackage(dir, root, options)).code).toBe("INVALID_PATH");
    }
  });

  test("files not listed in the manifest, missing files and duplicate paths are refused", () => {
    const { root, options } = workspace();
    expect(refusal(() => inspectPackage(pkg(packageFiles(), { extra: { "gates/extra.sh": "echo\n" } }), root, options)).code).toBe("UNLISTED_FILE");
    const missing = pkg(packageFiles(), { manifest: (m) => (m.files as unknown[]).push({ path: "gates/gone.json", sha256: "a".repeat(64) }) });
    expect(refusal(() => inspectPackage(missing, root, options)).code).toBe("MISSING_FILE");
    const twice = pkg(packageFiles(), { manifest: (m) => (m.files as unknown[]).push({ path: "GATES/lint.json", sha256: "a".repeat(64) }) });
    expect(refusal(() => inspectPackage(twice, root, options)).code).toBe("INVALID_PATH");
  });

  test("manifest schema errors are refused", () => {
    const { root, options } = workspace();
    for (const change of [
      (m: Record<string, unknown>) => (m.version = "1.0"),
      (m: Record<string, unknown>) => (m.name = "Acme Review"),
      (m: Record<string, unknown>) => (m.extra = true),
      (m: Record<string, unknown>) => (m.files = []),
    ]) {
      expect(refusal(() => inspectPackage(pkg(packageFiles(), { manifest: change }), root, options)).code).toBe("INVALID_MANIFEST");
    }
    expect(refusal(() => inspectPackage(join(root, "nowhere"), root, options)).code).toBe("NOT_FOUND");
  });

  test.skipIf(process.platform === "win32")("a symbolic link in the package is refused", () => {
    // Creating symbolic links needs extra rights on Windows.
    const { root, options } = workspace();
    const dir = pkg();
    symlinkSync("/etc/hostname", join(dir, "gates", "scripts", "link.sh"));
    expect(refusal(() => inspectPackage(dir, root, options)).code).toBe("SYMLINK");
  });

  test("an invalid workflow, gate or profile is reported and blocks the install", () => {
    const { root, options } = workspace();
    const files = packageFiles();
    delete files["gates/lint.json"];
    files["agents/broken.json"] = JSON.stringify({ ...JSON.parse(files["agents/pkg-reviewer.json"] ?? "{}"), id: "broken", allowedTools: ["edit_file"], skills: [] });
    files["gates/bad.json"] = JSON.stringify({ schemaVersion: 1, id: "other" });
    const plan = inspectPackage(pkg(files), root, options);
    const problems = plan.problems.join("\n");
    expect(problems).toContain("workflows/pkg-quick.json");
    expect(problems).toContain("lint");
    expect(problems).toContain("agents/broken.json");
    expect(problems).toContain("gates/bad.json");
    expect(refusal(() => installPackage(plan, { approved: true, ...options })).code).toBe("INVALID_PACKAGE");
    expect(existsSync(join(root, "baked"))).toBe(false);
  });

  test("a profile that needs a skill nobody ships is reported", () => {
    const { root, options } = workspace();
    const files = packageFiles();
    delete files["skills/review-notes/SKILL.md"];
    delete files["skills/review-notes/checklist.txt"];
    expect(inspectPackage(pkg(files), root, options).problems.join("\n")).toContain("needs skill review-notes");
    mkdirSync(join(root, "baked", "skills", "review-notes"), { recursive: true });
    writeFileSync(join(root, "baked", "skills", "review-notes", "SKILL.md"), SKILL_TEXT);
    expect(inspectPackage(pkg(files), root, options).problems).toEqual([]);
  });
});

describe("package install", () => {
  test("installs only with approval, records the lock file and leaves gates unconfirmed", () => {
    const { root, options } = workspace();
    const dir = pkg();
    const plan = inspectPackage(dir, root, options);
    expect(refusal(() => installPackage(plan, { approved: false as unknown as true, ...options })).code).toBe("NOT_APPROVED");
    const result = installPackage(plan, { approved: true, ...options });
    expect(result.written.length).toBe(plan.files.length);
    for (const [path, text] of Object.entries(packageFiles())) expect(read(root, `baked/${path}`)).toBe(text);
    const lock = readLock(root);
    expect(lock).toHaveLength(1);
    expect(lock[0]).toMatchObject({ name: "acme-review", version: "1.0.0" });
    expect(lock[0]?.files.find((f) => f.path === "baked/gates/lint.json")?.sha256).toBe(hashBytes(packageFiles()["gates/lint.json"] ?? ""));
    expect(Number.isNaN(Date.parse(lock[0]?.installedAt ?? ""))).toBe(false);

    // Installed gates are ordinary project gates: a run still asks for their confirmation.
    expect(readConfirmations(root)).toEqual({});
    const library = loadGateLibrary(root, defaultWorkflowPolicy, options.gateDirectories);
    expect(unconfirmedGates(root, library, ["lint", "tests", "typecheck"]).map((e) => e.gate.id).sort()).toEqual(["lint", "tests", "typecheck"]);
    confirmGates(root, library, ["lint"]);
    expect(inspectPackage(dir, root, options).gatesToConfirm.sort()).toEqual(["task-tests", "tests", "typecheck"]);

    // A second install of the same version changes nothing.
    const again = inspectPackage(dir, root, options);
    expect(again.installed).toBe("1.0.0");
    expect(again.files.every((f) => f.status === "identical")).toBe(true);
    expect(installPackage(again, { approved: true, ...options }).written).toEqual([]);
    expect(listPackages(root)[0]?.changed).toEqual([]);
  });

  test("refuses to overwrite a different project file unless asked", () => {
    const { root, options } = workspace();
    mkdirSync(join(root, "baked", "gates"), { recursive: true });
    writeFileSync(join(root, "baked", "gates", "lint.json"), "{\"mine\": true}\n");
    const plan = inspectPackage(pkg(), root, options);
    expect(plan.overwrites).toBe(1);
    expect(plan.files.find((f) => f.target === "baked/gates/lint.json")?.status).toBe("overwrite");
    expect(refusal(() => installPackage(plan, { approved: true, ...options })).code).toBe("CONFLICT");
    expect(read(root, "baked/gates/lint.json")).toBe("{\"mine\": true}\n");
    expect(existsSync(join(root, "baked", "agents"))).toBe(false);
    installPackage(plan, { approved: true, overwrite: true, ...options });
    expect(read(root, "baked/gates/lint.json")).toBe(packageFiles()["gates/lint.json"] ?? "");
  });

  test("refuses a plan when the package or the project changed after it was shown", () => {
    const { root, options } = workspace();
    const dir = pkg();
    const plan = inspectPackage(dir, root, options);
    mkdirSync(join(root, "baked", "agents"), { recursive: true });
    writeFileSync(join(root, "baked", "agents", "pkg-reviewer.json"), "{}");
    expect(refusal(() => installPackage(plan, { approved: true, overwrite: true, ...options })).code).toBe("STALE_PLAN");
  });

  test("refuses files another installed package owns", () => {
    const { root, options } = workspace();
    installPackage(inspectPackage(pkg(), root, options), { approved: true, ...options });
    const other = inspectPackage(pkg(packageFiles(), { name: "other" }), root, options);
    expect(other.problems.join("\n")).toContain("belongs to the installed package acme-review");
  });

  test("an upgrade removes unchanged files the new version dropped and keeps edited ones", () => {
    const { root, options } = workspace();
    installPackage(inspectPackage(pkg(), root, options), { approved: true, ...options });
    writeFileSync(join(root, "baked", "skills", "review-notes", "checklist.txt"), "my edges\n");
    const files = packageFiles();
    delete files["skills/review-notes/checklist.txt"];
    delete files["gates/scripts/check.sh"];
    const plan = inspectPackage(pkg(files, { version: "1.1.0" }), root, options);
    expect(plan.installed).toBe("1.0.0");
    expect(plan.stale).toEqual(
      expect.arrayContaining([
        { target: "baked/skills/review-notes/checklist.txt", action: "keep" },
        { target: "baked/gates/scripts/check.sh", action: "remove" },
      ]),
    );
    const result = installPackage(plan, { approved: true, ...options });
    expect(result.removed).toEqual(["baked/gates/scripts/check.sh"]);
    expect(result.kept).toEqual(["baked/skills/review-notes/checklist.txt"]);
    expect(existsSync(join(root, "baked", "gates", "scripts"))).toBe(false);
    expect(readLock(root)[0]?.version).toBe("1.1.0");
  });

  test.skipIf(process.platform === "win32")("refuses to write through a symbolic link in the project", () => {
    // Creating symbolic links needs extra rights on Windows.
    const { root, options } = workspace();
    const outside = mkdtempSync(join(tmpdir(), "baked-packages-outside-"));
    cleanups.push(outside);
    mkdirSync(join(root, "baked"), { recursive: true });
    symlinkSync(outside, join(root, "baked", "gates"));
    const plan = inspectPackage(pkg(), root, options);
    expect(plan.problems.join("\n")).toContain("baked/gates is a symbolic link");
  });
});

describe("package removal", () => {
  test("deletes unchanged files, keeps edited ones and drops the lock entry", () => {
    const { root, options } = workspace();
    installPackage(inspectPackage(pkg(), root, options), { approved: true, ...options });
    writeFileSync(join(root, "baked", "agents", "pkg-reviewer.json"), "{\"edited\": true}\n");
    expect(listPackages(root)[0]?.changed).toEqual(["baked/agents/pkg-reviewer.json"]);
    const result = removePackage(root, "acme-review");
    expect(result.kept).toEqual(["baked/agents/pkg-reviewer.json"]);
    expect(result.removed).toHaveLength(Object.keys(packageFiles()).length - 1);
    expect(read(root, "baked/agents/pkg-reviewer.json")).toBe("{\"edited\": true}\n");
    expect(existsSync(join(root, "baked", "skills", "review-notes"))).toBe(false);
    expect(existsSync(join(root, "baked", "workflows", "pkg-quick.json"))).toBe(false);
    expect(readLock(root)).toEqual([]);
    expect(refusal(() => removePackage(root, "acme-review")).code).toBe("NOT_INSTALLED");
  });

  test("a lock file that names a path outside baked/ is refused", () => {
    const { root } = workspace();
    mkdirSync(join(root, "baked"), { recursive: true });
    writeFileSync(join(root, "baked", "packages.json"), JSON.stringify({ schemaVersion: 1, packages: [{ name: "x", version: "1.0.0", installedAt: "2026-01-01T00:00:00Z", files: [{ path: "baked/../src/index.ts", sha256: "a".repeat(64) }] }] }));
    expect(refusal(() => removePackage(root, "x")).code).toBe("INVALID_LOCK");
  });
});

describe("baked add and baked packages", () => {
  test("prints the plan without --yes, installs with it, lists and removes", async () => {
    const { root, options } = workspace();
    const dir = pkg();
    let out = "";
    const print = (text: string) => {
      out += text;
    };
    const deps = { workspace: root, print, isInteractive: false, options };
    expect(await runPackagesCli(["add", dir], deps)).toBe(1);
    expect(out).toContain("Run again with --yes");
    expect(existsSync(join(root, "baked"))).toBe(false);
    out = "";
    expect(await runPackagesCli(["add", dir, "--yes", "--json"], deps)).toBe(0);
    const json = JSON.parse(out) as { plan: { name: string }; result: { written: string[] } };
    expect(json.plan.name).toBe("acme-review");
    expect(json.result.written.length).toBeGreaterThan(0);
    out = "";
    expect(await runPackagesCli(["list", "--cwd", root], deps)).toBe(0);
    expect(out).toContain("acme-review 1.0.0");
    out = "";
    expect(await runPackagesCli(["remove", "acme-review", "--json"], deps)).toBe(0);
    expect((JSON.parse(out) as { removed: string[] }).removed.length).toBeGreaterThan(0);
    expect(await runPackagesCli(["remove", "acme-review"], deps)).toBe(2);
    expect(await runPackagesCli(["add"], deps)).toBe(2);
  });

  test("an interactive add asks before it installs", async () => {
    const { root, options } = workspace();
    const dir = pkg();
    const asked: string[] = [];
    const deps = { workspace: root, print: () => {}, isInteractive: true, options, confirm: async (q: string) => (asked.push(q), false) };
    expect(await runPackagesCli(["add", dir], deps)).toBe(1);
    expect(asked).toHaveLength(1);
    expect(existsSync(join(root, "baked"))).toBe(false);
    expect(await runPackagesCli(["add", dir], { ...deps, confirm: async () => true })).toBe(0);
    expect(readLock(root)).toHaveLength(1);
  });
});

describe("/packages in the terminal UI", () => {
  function fakeContext(cwd: string) {
    const messages: string[] = [];
    const pickers: CommandPickerConfig[] = [];
    const ctx = {
      cwd,
      chat: { setMessages: (update: (prev: { content: string }[]) => { content: string }[]) => messages.push(update([]).at(-1)?.content ?? "") },
      openCommandPicker: (config: CommandPickerConfig) => pickers.push(config),
    } as unknown as CommandContext;
    return { ctx, messages, pickers };
  }

  test("add shows the plan and installs only after Install is picked", () => {
    const { root, options } = workspace();
    const dir = pkg();
    const { ctx, messages, pickers } = fakeContext(root);
    handlePackages(`/packages add ${dir}`, ctx, () => options);
    expect(messages[0]).toContain("Package acme-review 1.0.0");
    expect(pickers[0]?.options.map((o) => o.value)).toEqual(["install", "cancel"]);
    pickers[0]?.onSelect("cancel");
    expect(existsSync(join(root, "baked"))).toBe(false);
    pickers[0]?.onSelect("install");
    expect(messages.at(-1)).toContain("Installed acme-review 1.0.0");
    expect(readLock(root)).toHaveLength(1);

    handlePackages("/packages", ctx, () => options);
    expect(messages.at(-1)).toContain("acme-review 1.0.0");
    handlePackages("/packages remove acme-review", ctx, () => options);
    pickers.at(-1)?.onSelect("remove");
    expect(messages.at(-1)).toContain("Removed acme-review 1.0.0");
    expect(readLock(root)).toEqual([]);
  });

  test("a broken package is reported without asking", () => {
    const { root, options } = workspace();
    const { ctx, messages, pickers } = fakeContext(root);
    handlePackages(`/packages add ${pkg(packageFiles(), { extra: { "agents/stray.json": "{}" } })}`, ctx, () => options);
    expect(messages[0]).toContain("Files not listed");
    expect(pickers).toEqual([]);
    handlePackages("/packages nope", ctx, () => options);
    expect(messages.at(-1)).toContain("Usage: /packages");
  });
});
