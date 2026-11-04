import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { toolchainCommand } from "./toolchain.js";

/**
 * A package a check's program loads before it can do anything (#2817): an R package an `Rscript
 * -e` expression calls as `pkg::fn`, or the PowerShell module whose cmdlet a `pwsh -Command`
 * script runs. The program resolving on the PATH says nothing about it: with Rscript installed and
 * styler not, the required `styler-written` check failed on every attempt with "there is no
 * package called 'styler'" and the run ended in repeated_failure.
 */
export interface PackageNeed {
  language: "r" | "powershell" | "swift";
  name: string;
  /** What it is, for a person: `the R package styler`. */
  what: string;
  /** The arguments, after the check's own program, that print `marker` when it loads. */
  probe: string[];
  /** What the probe prints when the package is there: `PACKAGE_PRESENT` unless given. */
  marker?: string;
  /** How the user installs it. */
  install: string;
}

/**
 * Printed by a probe when the package is there. Built in the probe from two halves, so the text
 * never appears in the probe itself (an R parse error echoes the expression).
 */
export const PACKAGE_PRESENT = "baked-package-present";
const PRESENT_HALVES = ["baked-package", "-present"] as const;

/** Packages every R installation has: `base::`, `utils::` and the rest never need a probe. */
const R_BASE = new Set([
  "base",
  "utils",
  "stats",
  "methods",
  "tools",
  "graphics",
  "grDevices",
  "datasets",
  "parallel",
  "compiler",
  "grid",
  "splines",
  "stats4",
  "tcltk",
]);

/** The module each cmdlet a gate's PowerShell script runs comes from. */
const PS_MODULES: Record<string, string> = {
  "invoke-formatter": "PSScriptAnalyzer",
  "invoke-scriptanalyzer": "PSScriptAnalyzer",
  "invoke-pester": "Pester",
};

const programOf = (executable: string) =>
  basename(executable.replaceAll("\\", "/"))
    .replace(/\.(?:exe|cmd|bat)$/i, "")
    .toLowerCase();

/** The packages a check's command needs beyond its program, in the order the command names them. */
export function packageNeeds(check: {
  executable: string;
  args: readonly string[];
}): PackageNeed[] {
  const program = programOf(check.executable);
  const text = check.args.join("\n");
  const out: PackageNeed[] = [];
  const add = (need: PackageNeed) => {
    if (!out.some((n) => n.name === need.name)) out.push(need);
  };
  if (program === "rscript") {
    for (const [, name] of text.matchAll(/(?<![\w.])([A-Za-z][\w.]*):::?/g)) {
      if (!name || R_BASE.has(name)) continue;
      const [a, b] = PRESENT_HALVES;
      add({
        language: "r",
        name,
        what: `the R package ${name}`,
        probe: [
          "-e",
          `if (requireNamespace('${name}', quietly = TRUE)) cat(paste0('${a}', '${b}'), '\\n')`,
        ],
        install: `install.packages("${name}")`,
      });
    }
  }
  if (program === "pwsh" || program === "powershell") {
    for (const [, cmdlet] of text.matchAll(/\b(Invoke-[A-Za-z]+)\b/g)) {
      const name = PS_MODULES[(cmdlet ?? "").toLowerCase()];
      if (!name) continue;
      const [a, b] = PRESENT_HALVES;
      add({
        language: "powershell",
        name,
        what: `the PowerShell module ${name}`,
        probe: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `if (Get-Module -ListAvailable -Name ${name}) { '${a}' + '${b}' }`,
        ],
        install: `Install-Module ${name} -Scope CurrentUser`,
      });
    }
  }
  // `swift format` is a subcommand only the Swift 6 toolchain bundles: a Swift 5 `swift` starts
  // and fails every check and fixer with "unable to invoke subcommand" (#2817). Its lint help
  // lists `--strict`, which the gate passes.
  if (program === "swift" && check.args[0] === "format")
    add({
      language: "swift",
      name: "swift-format",
      what: "swift format (the swift-format tool)",
      probe: ["format", "lint", "--help"],
      marker: "--strict",
      install: "a Swift 6 toolchain, which bundles swift format",
    });
  return out;
}

/**
 * The Composer `vendor/bin` script a check runs through `php` (`php vendor/bin/pint`) when it is
 * not under `cwd` (#2817): `php` resolves, and the check fails with "Could not open input file"
 * until `composer install` runs. Null for a check that runs no such script, or whose script is
 * there.
 */
export function missingComposerScript(
  check: { executable: string; args: readonly string[] },
  cwd: string,
): string | null {
  const { script } = toolchainCommand(check.executable, check.args);
  return script && !existsSync(join(cwd, script)) ? script : null;
}

/** Runs a probe: whether its output holds the marker. Unknown (a probe that does not run) is true. */
export type PackageProbe = (
  command: { executable: string; args: string[] },
  cwd: string,
  marker: string,
) => boolean;

const PROBE_TIMEOUT_MS = 20_000;
const probed = new Map<string, boolean>();

/**
 * The default probe, once per program, directory and package. A probe that cannot start, times
 * out or is killed says nothing about the package, so the check is kept: only a probe that ran
 * to its end without the marker leaves a package out.
 */
export const runPackageProbe: PackageProbe = (command, cwd, marker) => {
  const key = JSON.stringify([cwd, command.executable, command.args]);
  let known = probed.get(key);
  if (known === undefined) {
    try {
      const proc = Bun.spawnSync([command.executable, ...command.args], {
        cwd,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: PROBE_TIMEOUT_MS,
      });
      known =
        proc.exitCode === null ||
        Boolean(proc.signalCode) ||
        `${proc.stdout.toString()}`.includes(marker);
    } catch {
      known = true;
    }
    probed.set(key, known);
  }
  return known;
};

/** The packages of `check` its program cannot load, by `probe`. */
export function missingPackages(
  check: { executable: string; args: readonly string[] },
  cwd: string,
  probe: PackageProbe = runPackageProbe,
): PackageNeed[] {
  return packageNeeds(check).filter(
    (need) =>
      !probe(
        { executable: check.executable, args: need.probe },
        cwd,
        need.marker ?? PACKAGE_PRESENT,
      ),
  );
}
