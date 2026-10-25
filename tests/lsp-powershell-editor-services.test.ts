import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { findPlatformAsset, type MasonPackage } from "../src/core/intelligence/backends/lsp/installer.js";
import {
  lspServerCandidates,
  serverBundle,
  serverLaunch,
} from "../src/core/intelligence/backends/lsp/server-registry.js";
import { StandaloneLspClient } from "../src/core/intelligence/backends/lsp/standalone-client.js";
import { commandExists, pwshExecutable } from "../src/core/platform/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";

// #2125: PowerShell files got no language server. PowerShell Editor Services is a release bundle
// that PowerShell starts, not a program on PATH, so its start command is built from the folder
// it is installed in.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PSES = "powershell-editor-services";

describe("PowerShell Editor Services (#2125)", () => {
  test("serves PowerShell files as a bundle named after its Mason package", () => {
    const candidate = lspServerCandidates().find((c) => c.command === PSES);
    expect(candidate?.languages).toEqual(["powershell"]);
    expect(serverBundle(PSES)?.entry).toBe(join("PowerShellEditorServices", "Start-EditorServices.ps1"));
    expect(serverBundle("gopls")).toBeUndefined();
  });

  test.each([
    ["POSIX", "/home/dev/.baked/lsp-servers/powershell-editor-services"],
    ["Windows", "C:\\Users\\O'Neil\\AppData\\Local\\baked\\lsp-servers\\powershell-editor-services"],
  ])("the start command is built from a %s install path", (_, folder) => {
    const launch = serverLaunch(PSES, folder, []);
    expect(launch.command).toBe(pwshExecutable());
    expect(launch.args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    const script = launch.args[4] ?? "";
    // PowerShell single quotes double an apostrophe inside a path. The start script is joined with
    // the host's separator, so a POSIX folder reads `\home\dev\...` on Windows.
    const quoted = (path: string) => `'${path.replaceAll("'", "''")}'`;
    const start = join(folder, "PowerShellEditorServices", "Start-EditorServices.ps1");
    expect(script.startsWith(`& ${quoted(start)} `)).toBe(true);
    expect(script).toContain(`-BundledModulesPath ${quoted(folder)}`);
    expect(script).toMatch(/ -Stdio /);
    expect(script).toMatch(/-HostVersion \d+\.\d+\.\d+/);
    // Its log and session file go to BAKED's data folder, never the project.
    expect(script).toMatch(/-LogPath '[^']*powershell-editor-services[\\/]logs'/);
    expect(script).toMatch(/-SessionDetailsPath '[^']*powershell-editor-services[\\/]session\.json'/);
    // A program runs as itself.
    expect(serverLaunch("gopls", "/usr/bin/gopls", ["serve"])).toEqual({ command: "/usr/bin/gopls", args: ["serve"] });
  });

  test("a Mason asset with no target is the same file on every platform", () => {
    const pkg = (asset: MasonPackage["source"]["asset"]): MasonPackage => ({
      name: PSES,
      description: "",
      homepage: "",
      licenses: [],
      languages: ["PowerShell"],
      categories: ["LSP"],
      source: { id: "pkg:github/PowerShell/PowerShellEditorServices@v4.7.0", asset },
    });
    expect(findPlatformAsset(pkg({ file: "PowerShellEditorServices.zip" }))).toEqual({ file: "PowerShellEditorServices.zip" });
    expect(findPlatformAsset(pkg([{ target: "none_such", file: "x.zip" }]))).toBeNull();
  });

  // A real server on a .ps1 file, when the bundle is installed (BAKED_PSES_BUNDLE, or where `/lsp` puts it).
  const bundle = process.env.BAKED_PSES_BUNDLE ?? join(homedir(), ".baked", "lsp-servers", PSES);
  const installed = existsSync(join(bundle, "PowerShellEditorServices", "Start-EditorServices.ps1")) && commandExists(pwshExecutable());
  test.skipIf(!installed)("the started server reports a PSScriptAnalyzer diagnostic and writes nothing into the project", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-pses-"));
    cleanups.push(() => removeTempDir(root));
    const file = join(root, "sum.ps1");
    writeFileSync(file, "function Get-Sum {\n    param($a, $b)\n    $unused = 1\n    return $a + $b\n}\n");
    const client = new StandaloneLspClient({ ...serverLaunch(PSES, bundle, []), language: "powershell" }, root);
    cleanups.push(() => client.stop());
    await client.start();
    const diagnostics = await client.getDiagnostics(file);
    expect(diagnostics.map((d) => d.code)).toContain("PSUseDeclaredVarsMoreThanAssignments");
    expect(readdirSync(root)).toEqual(["sum.ps1"]);
  }, 120_000);
});
