import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { smokeChecks, smokeLine } from "../src/core/workflows/check-preflight.js";
import { formatWrittenChecks } from "../src/core/workflows/format-written.js";
import { detectGates } from "../src/core/workflows/gates.js";
import { missingComposerScript, missingPackages, PACKAGE_PRESENT, packageNeeds } from "../src/core/workflows/package-probe.js";
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

// Follow-up to #2817: the same defect where the program resolves and the formatter is not a
// package. `php` resolves before `composer install` has written `vendor/bin/pint`, and a Swift 5
// `swift` resolves without the `swift format` subcommand Swift 6 bundles. Each got a required
// format-written check that failed with its fixer on every attempt.
const PINT_PROJECT = { "composer.json": JSON.stringify({ "require-dev": { "laravel/pint": "^1" } }), "src/Sum.php": "<?php\n" };
const CS_FIXER_PROJECT = { "composer.json": "{}\n", ".php-cs-fixer.dist.php": "<?php return new PhpCsFixer\\Config();\n", "src/Sum.php": "<?php\n" };
const SWIFT_PROJECT = { "Package.swift": "// swift-tools-version:5.9\n", ".swift-format": "{}\n", "Sources/Calc/Calc.swift": "public func add() {}\n" };

/** What `composer install` leaves for a tool: its `vendor/bin` proxy script. */
function composerInstall(root: string, tool: string): void {
  mkdirSync(join(root, "vendor", "bin"), { recursive: true });
  writeFileSync(join(root, "vendor", "bin", tool), "<?php\n");
}

/**
 * A stand-in `swift` on the PATH: Swift 5, whose `swift format` fails as the real one does, or
 * Swift 6, whose `swift format lint --help` lists `--strict`.
 */
function fakeSwift(version: 5 | 6): string {
  const bin = mkdtempSync(join(tmpdir(), "baked-fake-swift-"));
  cleanups.push(() => rmSync(bin, { recursive: true, force: true }));
  const swift = join(bin, "swift");
  const format =
    version === 6
      ? `echo "USAGE: swift-format lint [--strict] <paths> ..."; echo "  -s, --strict  Fail on warnings."; exit 0`
      : `echo "error: unable to invoke subcommand: /usr/bin/swift-format (No such file or directory)" >&2; exit 1`;
  writeFileSync(swift, `#!/bin/sh\nif [ "$1" = format ]; then ${format}; fi\nexit 0\n`);
  chmodSync(swift, 0o755);
  return swift;
}

describe("scenario: a formatter whose program resolves and whose formatter is not there (follow-up to #2817)", () => {
  const which = (c: string) => `/usr/bin/${c}`;
  const written = (root: string, path: string, options: Parameters<typeof formatWrittenChecks>[6] = {}) =>
    formatWrittenChecks(root, [], [{ path, action: "create" }], which, undefined, undefined, options).map((c) => [c.id, [c.executable, ...c.args].join(" ")]);

  test("Pint and PHP-CS-Fixer: no format-written check before composer install; with vendor/bin, the check", () => {
    const pint = project(PINT_PROJECT);
    expect(written(pint, "src/Sum.php")).toEqual([]);
    expect(missingComposerScript({ executable: "php", args: ["vendor/bin/pint", "--test"] }, pint)).toBe("vendor/bin/pint");
    composerInstall(pint, "pint");
    expect(written(pint, "src/Sum.php")).toEqual([["pint-written", "php vendor/bin/pint --test src/Sum.php"]]);
    expect(missingComposerScript({ executable: "php", args: ["vendor/bin/pint", "--test"] }, pint)).toBeNull();
    const fixer = project(CS_FIXER_PROJECT);
    expect(written(fixer, "src/Sum.php")).toEqual([]);
    composerInstall(fixer, "php-cs-fixer");
    expect(written(fixer, "src/Sum.php")).toEqual([["php-cs-fixer-written", "php vendor/bin/php-cs-fixer fix --dry-run --diff src/Sum.php"]]);
    // A program that is not a Composer script needs none.
    expect(missingComposerScript({ executable: "ruff", args: ["format", "--check", "."] }, fixer)).toBeNull();
  });

  test("swift format: the probe asks the lint help for --strict", () => {
    const needs = packageNeeds({ executable: "swift", args: ["format", "lint", "--strict", "--recursive", "."] });
    expect(needs.map((n) => [n.name, n.probe.join(" "), n.marker])).toEqual([["swift-format", "format lint --help", "--strict"]]);
    expect(packageNeeds({ executable: "C:\\Swift\\bin\\swift.exe", args: ["format", "format", "--in-place"] }).map((n) => n.name)).toEqual(["swift-format"]);
    expect(packageNeeds({ executable: "swift", args: ["build"] })).toEqual([]);
    const root = project(SWIFT_PROJECT);
    expect(written(root, "Sources/Calc/Calc.swift", { packages: () => false })).toEqual([]);
    expect(written(root, "Sources/Calc/Calc.swift", { packages: () => true })).toEqual([["swift-format-written", "swift format lint --strict Sources/Calc/Calc.swift"]]);
  });

  // A stand-in swift run for real on the PATH: the default probe, format-written and the start smoke.
  test.skipIf(process.platform === "win32")("a live Swift 5 swift: no swift-format-written, and the start smoke names it", async () => {
    const savedPath = process.env.PATH;
    cleanups.push(() => {
      process.env.PATH = savedPath;
    });
    const gate = { ...(detectGates(project(SWIFT_PROJECT)).find((s) => s.check.id === "swift-format")?.check as Check), required: true };
    for (const version of [5, 6] as const) {
      const swift = fakeSwift(version);
      process.env.PATH = `${dirname(swift)}${delimiter}${savedPath ?? ""}`;
      // The default probe caches by directory, so each version probes from its own.
      const at = project(SWIFT_PROJECT);
      const ids = formatWrittenChecks(at, [], [{ path: "Sources/Calc/Calc.swift", action: "create" }], () => swift).map((c) => c.id);
      expect([version, ids]).toEqual([version, version === 6 ? ["swift-format-written"] : []]);
      const [smoke] = await smokeChecks([{ ...gate, executable: swift }], at);
      expect([version, smoke?.status]).toEqual([version, version === 6 ? "started" : "missing_package"]);
      if (version === 5) expect(smokeLine(smoke!)).toBe(`check swift-format: ${swift} starts, but swift format (the swift-format tool) is not installed (a Swift 6 toolchain, which bundles swift format)`);
    }
  });
});
