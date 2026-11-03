import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { smokeChecks, smokeLine } from "../src/core/workflows/check-preflight.js";
import { formatWrittenChecks } from "../src/core/workflows/format-written.js";
import { detectGates } from "../src/core/workflows/gates.js";
import { missingPackages, PACKAGE_PRESENT, packageNeeds } from "../src/core/workflows/package-probe.js";
import { PS_FORMAT_CHECK } from "../src/core/workflows/ps-format.js";
import { STYLER_CHECK } from "../src/core/workflows/r-tools.js";
import type { Check } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #2817: an R project on a machine with Rscript and without the styler package. Rscript resolves,
// so the required `styler-written` check was added for every R file a task wrote, failed on every
// attempt ("there is no package called 'styler'"), and the run ended in repeated_failure.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-formatter-package-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** A stand-in Rscript with lintr only: it prints the marker for a probe of lintr, nothing else. */
function fakeRscript(): string {
  const bin = mkdtempSync(join(tmpdir(), "baked-fake-rscript-"));
  cleanups.push(() => rmSync(bin, { recursive: true, force: true }));
  const rscript = join(bin, "Rscript");
  writeFileSync(rscript, `#!/bin/sh\ncase "$2" in *"'lintr'"*) echo ${PACKAGE_PRESENT} ;; esac\nexit 0\n`);
  chmodSync(rscript, 0o755);
  return rscript;
}

const R_PROJECT = { DESCRIPTION: "Package: xmlvet\n", "tests/testthat/test-cli.R": "", "R/cli.R": "run <- function(x){\nx}\n" };
const PS_PROJECT = { "PSScriptAnalyzerSettings.psd1": "@{}\n", "src/Sum.ps1": "function Get-Sum {}\n" };

/** The probe of a machine with the given packages; it records each package it was asked about. */
function machine(installed: string[], asked: string[] = []) {
  return (command: { executable: string; args: string[] }) => {
    const name = /requireNamespace\('([^']+)'|-Name (\w+)/.exec(command.args.join(" "));
    const pkg = name?.[1] ?? name?.[2] ?? "";
    asked.push(pkg);
    return installed.includes(pkg);
  };
}

describe("scenario: a formatter gate whose program is installed and whose package is not (#2817)", () => {
  test("no styler-written or psformat-written check without styler or PSScriptAnalyzer; with them, the check", () => {
    const which = (c: string) => `/usr/bin/${c}`;
    const written = (files: Record<string, string>, path: string, installed: string[]) =>
      formatWrittenChecks(project(files), [], [{ path, action: "create" }], which, undefined, undefined, { packages: machine(installed) }).map((c) => c.id);
    expect(written(R_PROJECT, "R/cli.R", [])).toEqual([]);
    expect(written(R_PROJECT, "R/cli.R", ["styler"])).toEqual(["styler-written"]);
    expect(written(PS_PROJECT, "src/Sum.ps1", [])).toEqual([]);
    expect(written(PS_PROJECT, "src/Sum.ps1", ["PSScriptAnalyzer"])).toEqual(["psformat-written"]);
  });

  test.skipIf(process.platform === "win32")("the start smoke names the package a required check lacks", async () => {
    const root = project(R_PROJECT);
    const rscript = fakeRscript();
    const gates = detectGates(root).map((s) => s.check);
    const at = (id: string, required: boolean) => ({ ...(gates.find((c) => c.id === id) as Check), executable: rscript, required });
    const smoke = await smokeChecks([at("styler", true), at("lintr", false)], root, undefined, undefined, machine(["lintr"]));
    expect(Object.fromEntries(smoke.map((s) => [s.checkId, s.status]))).toEqual({ styler: "missing_package", lintr: "started" });
    expect(smokeLine(smoke[0]!)).toBe(`check styler: ${rscript} starts, but the R package styler is not installed (install.packages("styler"))`);
  });

  // A stand-in Rscript that has no packages, run for real: the probe and the start refusal.
  test.skipIf(process.platform === "win32")("a live Rscript without styler: the run does not start", async () => {
    const rscript = fakeRscript();
    const bin = dirname(rscript);
    expect(missingPackages({ executable: rscript, args: ["-e", STYLER_CHECK] }, bin).map((n) => n.name)).toEqual(["styler"]);
    expect(missingPackages({ executable: rscript, args: ["-e", "lintr::lint_dir('.')"] }, bin)).toEqual([]);
    const fixture = workflowFixture({
      policy: { ...fixturePolicy, checks: [{ ...(fixturePolicy.checks[0] as Check), id: "styler", executable: rscript, args: ["-e", STYLER_CHECK], required: true }] },
    });
    cleanups.push(fixture.dispose);
    fixture.service.providerReady = async () => ({ known: true, ready: true });
    await expect(fixture.start()).rejects.toMatchObject({ code: "CAPABILITY_DENIED", details: { reason: "check_unavailable" } });
  });

  test("what a command needs: R packages it calls, never base R; the module of a PowerShell cmdlet", () => {
    const names = (executable: string, args: string[]) => packageNeeds({ executable, args }).map((n) => `${n.language}:${n.name}`);
    expect(names("Rscript", ["-e", STYLER_CHECK])).toEqual(["r:styler"]);
    expect(names("C:\\R\\bin\\Rscript.exe", ["-e", "testthat::test_local(reporter = testthat::CheckReporter$new())"])).toEqual(["r:testthat"]);
    expect(names("Rscript", ["-e", "utils::head(base::letters); x <- foo.bar:::baz()"])).toEqual(["r:foo.bar"]);
    expect(names("pwsh", ["-NoProfile", "-Command", PS_FORMAT_CHECK])).toEqual(["powershell:PSScriptAnalyzer"]);
    expect(names("powershell.exe", ["-Command", "Invoke-Pester -CI"])).toEqual(["powershell:Pester"]);
    expect(names("ruff", ["format", "--check", "."])).toEqual([]);
  });
});
