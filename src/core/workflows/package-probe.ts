import { basename } from "node:path";

/**
 * A package a check's program loads before it can do anything (#2817): an R package an `Rscript
 * -e` expression calls as `pkg::fn`, or the PowerShell module whose cmdlet a `pwsh -Command`
 * script runs. The program resolving on the PATH says nothing about it: with Rscript installed and
 * styler not, the required `styler-written` check failed on every attempt with "there is no
 * package called 'styler'" and the run ended in repeated_failure.
 */
export interface PackageNeed {
  language: "r" | "powershell";
  name: string;
  /** The arguments, after the check's own program, that print `PACKAGE_PRESENT` when it loads. */
  probe: string[];
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
  return out;
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
    (need) => !probe({ executable: check.executable, args: need.probe }, cwd, PACKAGE_PRESENT),
  );
}
