/**
 * The documented surface of a documentation feature (#2569): the commands the request lists, which
 * a README of a command-line program describes and whose examples the documented-example review
 * runs. The initiative estimate prices such a feature at a per-command rate times those commands
 * plus one README correction round, instead of by its two-file boundary (`README.md`, `LICENSE`):
 * bench round 83 priced bytemerge's `documentation` at the same 723k expected as its one-file
 * command features and it used 2.25M, and pnmforge's `docs` 1.13M against 1.56M. Nothing here runs
 * a model or reads a store; `sizing.documentedSurface` decides whether the estimate applies it.
 */
import { isTestFile } from "../../intelligence/language-traits.js";
import type { TokenRange } from "../estimate.js";
import type { FeatureRunSample } from "./estimate.js";
import { describesCode, type InitiativeFeature } from "./plan.js";

/**
 * One README correction round: the corrective task the documented-example review raises for a
 * README of a program with many commands. Bench round 83: 508k (bytemerge `documentation` T002,
 * after F1 and F2) and 507k (pnmforge `docs`, after a review that ran the examples).
 */
export const README_CORRECTION_TOKENS = 507_000;

/**
 * Tokens per listed command of a documentation feature before `MIN_DOCS_SAMPLES` finished ones
 * are measured: each run's tokens past one correction round over the commands, for the two bench
 * round 83 runs of a 15-command program: pnmforge (1.56M) 70.2k and bytemerge (2,252,251) 116,350,
 * rounded up so the dearer run lands inside the range.
 */
export const DEFAULT_PER_COMMAND: TokenRange = { low: 70_200, high: 116_400 };

/** Finished documentation features with listed commands before their rate replaces the default. */
export const MIN_DOCS_SAMPLES = 2;

/** What a command a documentation feature documents costs, and the correction round on top. */
export interface DocumentedSurfaceRate {
  perCommand: TokenRange;
  correction: number;
  /** Finished documentation features the rate is measured on; 0 for the default. */
  samples: number;
  basis: "measured" | "defaults";
}

/** Files that ship beside a README and hold no code: a licence, a notice, the authors. */
const LEGAL =
  /(?:^|\/)(?:licen[cs]e|copying|notice|authors|contributors|credits)(?:[.-][\w.-]*)?$/i;
/** A test of the documentation itself, such as R65 uritpl's `tests/test_docs.py`. */
const DOCS_TEST = /doc|readme|example/i;

/**
 * Whether a feature documents the program: its boundary describes code (a README, `docs/`,
 * examples) and holds nothing else but legal files and tests of the documentation. Wider than
 * `isDocumentationFeature`, which orders features and reads `README.md` with `LICENSE` as code.
 */
export function documentsProgram(feature: Pick<InitiativeFeature, "boundary">): boolean {
  const paths = feature.boundary.paths;
  return (
    paths.some(describesCode) &&
    paths.every(
      (path) =>
        describesCode(path) || LEGAL.test(path) || (isTestFile(path) && DOCS_TEST.test(path)),
    )
  );
}

const SUBCOMMAND = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const PROMPT = /^\s*(?:[$>%#]\s+)?/;
const LAUNCHERS = new Set([
  "java",
  "python",
  "python3",
  "node",
  "bun",
  "dotnet",
  "cargo",
  "go",
  "npx",
  "sudo",
  "cd",
  "git",
  "make",
  "cmake",
  "echo",
  "cat",
]);
const COMMANDS_HEADING = /^#{1,6}\s+.*\bcommands?\b/i;

/** The program and its first argument of an invocation line, when the argument reads as a command. */
function invocation(line: string): [string, string] | null {
  const words = line.replace(PROMPT, "").trim().split(/\s+/);
  const program = (words[0] ?? "")
    .replace(/^\.\//, "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.exe$/i, "");
  const command = words[1] ?? "";
  if (!program || LAUNCHERS.has(program.toLowerCase()) || !SUBCOMMAND.test(command)) return null;
  return [program, command];
}

/**
 * The commands the request lists for its program, sorted: the distinct first arguments of the
 * program that invocations in code (fenced blocks and inline spans, a `$ ` prompt allowed) give two
 * or more of, and the leading inline-code word of each list item under a heading that names
 * commands. Empty for a request that lists no commands (a library), whose documentation feature
 * keeps its class price.
 */
export function requestCommands(request: string): string[] {
  const lines = request.split(/\r?\n/);
  const code: string[] = [];
  const listed = new Set<string>();
  let fenced = false;
  let underCommands = false;
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      code.push(line);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) underCommands = COMMANDS_HEADING.test(line);
    const spans = [...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");
    code.push(...spans);
    const item = underCommands ? /^\s*(?:[-*+]|\d+[.)])\s+`([^`\s]+)/.exec(line) : null;
    if (item?.[1] && SUBCOMMAND.test(item[1])) listed.add(item[1]);
  }
  const byProgram = new Map<string, Set<string>>();
  for (const line of code) {
    const found = invocation(line);
    if (!found) continue;
    const [program, command] = found;
    const commands = byProgram.get(program) ?? new Set<string>();
    commands.add(command);
    byProgram.set(program, commands);
  }
  const invoked = [...byProgram.values()]
    .filter((commands) => commands.size >= 2)
    .sort((a, b) => b.size - a.size)[0];
  return [...new Set([...(invoked ?? []), ...listed])].sort();
}

/**
 * Tokens per documented command, measured on finished documentation features with listed
 * commands: each run's tokens past one correction round over its commands, from the lowest rate
 * (a floor no measured run stayed under, #1806) up to their median; the default below
 * `MIN_DOCS_SAMPLES` of them.
 */
export function documentedSurfaceRate(
  samples: readonly Pick<FeatureRunSample, "tokens" | "documentedCommands">[],
): DocumentedSurfaceRate {
  const rates = samples
    .filter((s) => (s.documentedCommands ?? 0) > 0 && s.tokens > README_CORRECTION_TOKENS)
    .map((s) => (s.tokens - README_CORRECTION_TOKENS) / (s.documentedCommands ?? 1))
    .sort((a, b) => a - b);
  if (rates.length < MIN_DOCS_SAMPLES)
    return {
      perCommand: DEFAULT_PER_COMMAND,
      correction: README_CORRECTION_TOKENS,
      samples: 0,
      basis: "defaults",
    };
  const mid = Math.floor(rates.length / 2);
  const median =
    rates.length % 2 ? (rates[mid] ?? 0) : ((rates[mid - 1] ?? 0) + (rates[mid] ?? 0)) / 2;
  return {
    perCommand: { low: Math.round(rates[0] ?? 0), high: Math.round(median) },
    correction: README_CORRECTION_TOKENS,
    samples: rates.length,
    basis: "measured",
  };
}

/** The need of a documentation feature of `commands` listed commands at `rate`. */
export const documentedSurfacePrice = (
  commands: number,
  rate: DocumentedSurfaceRate,
): TokenRange => ({
  low: Math.round(rate.perCommand.low * commands + rate.correction),
  high: Math.round(rate.perCommand.high * commands + rate.correction),
});
