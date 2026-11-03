/**
 * The worktree preflight probe (#2461): before a run's first task, a required test check of a
 * toolchain with a `WORKTREE_PATH_LIMITS` row that failed in the run's worktree is run once more
 * in a short copy of the same tree. Failing deep and passing shallow on the same content is the
 * machine's path length, not the code: the run records `worktree_environment` from that
 * measurement instead of the row's estimate, which was measured on one machine and moves with the
 * SDK's own install path (`dart test` names its frontend server by a cwd-relative path).
 */
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  isNoRow,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "../intelligence/language-records.js";
import { WORKTREE_PATH_LIMITS } from "./dependency-dirs.js";
import type { Check } from "./types.js";

/** The run artifact that records the probe's inputs and decisions. */
export const WORKTREE_PROBE_PATH = "environment/worktree-probe.json";

/** What a probe decided for one check. */
export type WorktreeProbeDecision =
  /** Failed in the worktree, passed in the short copy: the path length. */
  | "environment"
  /** Failed in both: the code or the project, which a task may change. */
  | "code"
  /** Passed in the worktree: the path is short enough on this machine, whatever the row says. */
  | "passed"
  /** Not measured (no baseline, a copy too large or no shorter, a timeout): the row decides. */
  | "not_probed";

export interface WorktreeProbe {
  checkId: string;
  language: SupportedLanguage;
  tool: string;
  /** The row's estimate, for comparison. */
  limit: number;
  /** The run worktree the check ran in at the check baseline, and its length. */
  worktree: string;
  worktreeLength: number;
  /** The short copy the probe ran it in, and its length; null when it did not run. */
  copy: string | null;
  copyLength: number | null;
  inWorktree: "passed" | "failed" | "not_measured";
  inCopy: "passed" | "failed" | "inconclusive" | "not_run";
  /** The end of the worktree run's failing output (the baseline's signature). */
  output: string;
  decision: WorktreeProbeDecision;
  note?: string;
}

/** The record `WORKTREE_PROBE_PATH` holds. */
export interface WorktreeProbeRecord {
  schemaVersion: 1;
  platform: NodeJS.Platform;
  probes: WorktreeProbe[];
}

/** A required check that runs a path-sensitive tool of a language the worktree holds. */
export interface PathSensitiveCheck {
  check: Check;
  language: SupportedLanguage;
  tool: string;
  limit: number;
}

/** The program name of an argument: its base name without a launcher extension, lower case. */
function programName(arg: string): string {
  const name = basename(arg.replaceAll("\\", "/"));
  const ext = extname(name).toLowerCase();
  return (
    [".exe", ".bat", ".cmd", ".ps1", ".ts", ".js"].includes(ext) ? name.slice(0, -ext.length) : name
  ).toLowerCase();
}

/**
 * Whether a command runs `tool` (`dart test`): its program word, by base name (`dart.bat`,
 * `C:\sdk\bin\dart.exe`, a script named `dart` an interpreter runs), followed by the subcommand.
 */
export function runsTool(argv: readonly string[], tool: string): boolean {
  const [program, ...rest] = tool.split(/\s+/);
  if (!program) return false;
  return argv.some(
    (arg, at) =>
      programName(arg) === program && rest.every((word, offset) => argv[at + 1 + offset] === word),
  );
}

/**
 * The project's required feature checks that run a tool with a `WORKTREE_PATH_LIMITS` row on
 * `platform`, for a language whose manifest `root` holds: the record decides which toolchains the
 * probe runs for (#2461).
 */
export function pathSensitiveChecks(
  checks: readonly Check[],
  root: string,
  platform: NodeJS.Platform,
): PathSensitiveCheck[] {
  return SUPPORTED_LANGUAGES.flatMap((language) => {
    const row = WORKTREE_PATH_LIMITS[language];
    if (isNoRow(row) || row.platform !== platform || !existsSync(join(root, row.manifest)))
      return [];
    return checks
      .filter(
        (check) =>
          check.required &&
          check.scope === "feature" &&
          runsTool([check.executable, ...check.args], row.tool),
      )
      .map((check) => ({ check, language, tool: row.tool, limit: row.chars }));
  });
}

/** The probe's decision from the two runs of one check on the same content. */
export function worktreeProbeDecision(
  inWorktree: WorktreeProbe["inWorktree"],
  inCopy: WorktreeProbe["inCopy"],
): WorktreeProbeDecision {
  if (inWorktree === "passed") return "passed";
  if (inWorktree === "not_measured") return "not_probed";
  if (inCopy === "passed") return "environment";
  if (inCopy === "failed") return "code";
  return "not_probed";
}
