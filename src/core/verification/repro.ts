import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { z } from "zod";
import { commentOnlyChange } from "../intelligence/comments.js";
import type { SandboxRequest } from "../security/sandbox.js";
import { buildSafeEnv } from "../spawn.js";
import { BATTERY_CASES } from "../workflows/finding-chain.js";
import type { ProcessScope } from "../workflows/process-scope.js";
import { ProbeSchema, type Repro, ReproSchema, type Review } from "../workflows/schemas.js";
import type { HostTool } from "../workflows/types.js";
import { caseCrash } from "./edge-inputs.js";
import { entryPointCommand } from "./entry-points.js";
import { confidenceOnlyNote } from "./findings.js";
import { changedPaths, sourceManifest } from "./snapshot.js";

/** Time a repro may run; it shows one input, not a test suite. */
export const REPRO_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 4000;
/** Repros one review attempt may try before it submits. */
export const REPRO_TRIES = 8;

export interface ReproOutcome {
  /**
   * `reproduced` when a line of the output is `actual` (an empty `actual`: the output is empty); `refuted` when the command exited 0
   * without printing it; `inconclusive` when it could not run, failed without printing `actual`,
   * timed out or changed source files.
   */
  status: "reproduced" | "refuted" | "inconclusive";
  reason: string;
  exitCode: number | null;
  output: string;
  /**
   * Absolute paths of another root of the run (the review's worktree, the workspace) that the
   * repro's files or arguments named and the host replaced with the root it ran in (#2279).
   */
  rewritten?: string[];
}

const normalize = (text: string) => text.replace(/\r\n?/g, "\n").trim();

/**
 * Whether the output shows `text`: as one of its lines or, for several lines, as a block. An empty
 * `text` ("prints nothing") is shown only by an output that is empty too (#1947).
 */
export function outputShows(output: string, text: string): boolean {
  const out = normalize(output);
  const wanted = normalize(text);
  if (!wanted) return !out;
  if (wanted.includes("\n")) return out.includes(wanted);
  return out.split("\n").some((line) => line.trim() === wanted);
}

/**
 * The runtime that runs what a check's build tool or package manager builds or installs (#1529).
 * caesar 21bc3a53 (Java 17, one check `mvn -B -q verify`) wrote README examples as
 * `java -cp target/classes caesar.Main ...`; run_probe refused java, the implementer would not
 * invent the output, and the run blocked with every check green. The checks already run the
 * project's code through that runtime (tests, plugins, scripts), so it adds no new trust.
 */
const RUNTIMES: Record<string, readonly string[]> = {
  mvn: ["java"],
  mvnw: ["java"],
  gradle: ["java"],
  gradlew: ["java"],
  sbt: ["java"],
  npm: ["node"],
  npx: ["node"],
  pnpm: ["node"],
  yarn: ["node"],
  pytest: ["python", "python3"],
  python: ["python", "python3"],
  python3: ["python", "python3"],
  uv: ["python", "python3"],
  poetry: ["python", "python3"],
  tox: ["python", "python3"],
};

/** A program's name without its directory or Windows launcher extension: `./mvnw.cmd` is `mvnw`. */
const programName = (executable: string): string =>
  basename(executable.replaceAll("\\", "/"))
    .replace(/\.(?:cmd|bat|exe)$/i, "")
    .toLowerCase();

/**
 * Programs a repro or probe may start: those the run's approved checks start, and the runtime of
 * each check's toolchain (java for Maven and Gradle, node for npm, python for pytest). The
 * approval covers what those programs run on the workspace, so a repro adds no program the user
 * did not approve. Go, Cargo and .NET run their programs themselves (`go run`, `cargo run`,
 * `dotnet run`).
 */
export function reproExecutables(checks: readonly { executable: string }[]): string[] {
  const own = checks.map((c) => c.executable);
  return [...new Set([...own, ...own.flatMap((e) => RUNTIMES[programName(e)] ?? [])])];
}

/**
 * Removes a scratch copy a program the host ran worked in. On Windows a program stopped at the
 * timeout can hold its directory for a moment (EBUSY): removal is retried, and a directory that
 * stays locked is left to the temp cleanup instead of replacing the run's result with the error.
 */
export function removeScratch(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // The result already stands; a leftover temp directory costs nothing.
  }
}

/**
 * The environment of a repro: the safe environment, plus `PYTHONPATH` for a Python project with
 * a `src` layout, so `python -c "import pkg"` finds the package without an install (endfix
 * 2295dbbd: "repro failed to import endfix"; a check cannot install, and a reviewer must not).
 */
export function reproEnv(root: string): Record<string, string | undefined> {
  const env = buildSafeEnv();
  const python = ["pyproject.toml", "setup.py", "setup.cfg"].some((name) =>
    existsSync(join(root, name)),
  );
  if (python && existsSync(join(root, "src")))
    env.PYTHONPATH = [join(root, "src"), root, env.PYTHONPATH].filter(Boolean).join(delimiter);
  return env;
}

/** Trimmed lines at least this long are code two files share, not boilerplate such as braces. */
const SHARED_LINE = 16;

/**
 * The workspace file that a repro input file is a copy of, or null: one with the same base name
 * that shares its code lines (#1348). narrowfit 3c2e3629 ran `go run {files}/sum.go`, a pasted
 * copy of `internal/constraint/sum.go`; the corrective fixed the real file and the copy kept
 * printing the old value, so the task ended invalid_output after every attempt. A probe of its
 * own that only calls the workspace code shares no lines with it and is not a copy.
 */
export function shadowedPath(
  file: { name: string; content: string },
  workspace: ReadonlyMap<string, string>,
): string | null {
  const lines = (text: string) =>
    new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length >= SHARED_LINE),
    );
  const own = lines(file.content);
  if (!own.size) return null;
  for (const [path, content] of workspace) {
    if (basename(path).toLowerCase() !== file.name.toLowerCase()) continue;
    const theirs = lines(content);
    const shared = [...own].filter((line) => theirs.has(line)).length;
    if (shared >= Math.min(3, own.size)) return path;
  }
  return null;
}

/** The workspace files among `paths` that have the base name of one of the repro's input files. */
function namesakes(root: string, repro: Repro, paths: readonly string[]): Map<string, string> {
  const names = new Set((repro.files ?? []).map((f) => f.name.toLowerCase()));
  const found = new Map<string, string>();
  for (const path of new Set(paths)) {
    if (!names.has(basename(path).toLowerCase())) continue;
    try {
      found.set(path, readFileSync(join(root, path), "utf8"));
    } catch {
      // A path the run deleted has nothing a copy could shadow.
    }
  }
  return found;
}

/**
 * Runs a finding's repro in the workspace and judges the claim by its output (#155). Run 5b703388
 * corrected a "regex accepts a trailing newline" claim that is true in Python but false in
 * JavaScript, and spent about 200k tokens on it.
 */
/** The project's own command, run through its toolchain's launcher when it is not on PATH (#1821). */
function throughEntryPoint(
  command: { executable: string; args: string[] },
  options: { root: string; executables: readonly string[] },
): { executable: string; args: string[] } {
  if (options.executables.includes(command.executable)) return command;
  const entry = entryPointCommand(
    options.root,
    [command.executable, ...command.args],
    options.executables,
  );
  return entry
    ? { executable: entry.argv[0] as string, args: entry.argv.slice(1) }
    : { executable: command.executable, args: command.args };
}

/** The `.baked/worktrees/<run>/<name>` tail of a run worktree's root, anchored at its separator. */
const WORKTREE_TAIL = /[\\/]\.baked[\\/]worktrees[\\/][^\\/"'`\s]+[\\/][^\\/"'`\s]+/g;
const slashes = (path: string) => path.replace(/\\/g, "/");
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The repro's text with `{root}` and every other root of the run replaced by `root`, the root the
 * repro runs in (#2279). A reviewer writes a probe project against the code it read, by the
 * absolute path of its own snapshot: R73 evalpin's `Cargo.toml` named `.../worktrees/<run>/main`
 * while the corrective ran in `.../worktrees/<run>/T003`, so the probe built the unchanged code and
 * reproduced after every fix (2.45M tokens). Another run worktree's root, and the workspace a
 * worktree belongs to, are rewritten; the spelling keeps the text's slashes, and `{root}` in file
 * content takes forward slashes, which every toolchain reads on Windows too.
 */
export function rerootRepro(
  text: string,
  root: string,
  forContent: boolean,
): { text: string; rewritten: string[] } {
  const rewritten: string[] = [];
  const own = slashes(root).toLowerCase();
  const swap = (found: string) => {
    if (slashes(found).toLowerCase() === own) return found;
    rewritten.push(found);
    return found.includes("\\") && !forContent ? root : slashes(root);
  };
  let out = text.replaceAll("{root}", forContent ? slashes(root) : root);
  // The workspace the root belongs to (the root itself when it is no run worktree).
  const workspace = slashes(root).split("/.baked/worktrees/")[0] ?? slashes(root);
  // Each worktree of that workspace: a worktree tail right after the workspace's own spelling.
  let joined = "";
  let last = 0;
  for (const match of out.matchAll(WORKTREE_TAIL)) {
    const at = match.index ?? 0;
    const start = at - workspace.length;
    if (start < last || slashes(out.slice(start, at)).toLowerCase() !== workspace.toLowerCase())
      continue;
    const end = at + match[0].length;
    joined += out.slice(last, start) + swap(out.slice(start, end));
    last = end;
  }
  out = joined + out.slice(last);
  // The workspace itself, when the repro runs in one of its worktrees.
  if (workspace !== slashes(root)) {
    const spelled = new RegExp(
      `${escapeRegExp(workspace).replace(/\//g, "[\\\\/]")}(?![\\\\/]\\.baked[\\\\/]worktrees)(?=$|[\\\\/"'\`\\s])`,
      "gi",
    );
    out = out.replace(spelled, swap);
  }
  return { text: out, rewritten: [...new Set(rewritten)] };
}

export async function runRepro(
  processes: ProcessScope,
  requested: Repro,
  options: {
    root: string;
    executables: readonly string[];
    generated: string[];
    signal: AbortSignal;
    /** The run's OS sandbox (see runSandbox), or null. */
    sandbox: SandboxRequest | null;
    /**
     * Workspace files a fix may change (the finding's file, the files the run changed): an input
     * file that is a copy of one of them makes the repro inconclusive without running it.
     */
    shadows?: readonly string[];
  },
): Promise<ReproOutcome> {
  const rewritten = new Set<string>();
  const reroot = (text: string, forContent: boolean) => {
    const result = rerootRepro(text, options.root, forContent);
    for (const path of result.rewritten) rewritten.add(path);
    return result.text;
  };
  const rooted: Repro = {
    ...requested,
    args: requested.args.map((arg) => reroot(arg, false)),
    ...(requested.files
      ? { files: requested.files.map((f) => ({ ...f, content: reroot(f.content, true) })) }
      : {}),
  };
  const repro = { ...rooted, ...throughEntryPoint(rooted, options) };
  const outcome = await executeRepro(processes, repro, options);
  return rewritten.size ? { ...outcome, rewritten: [...rewritten] } : outcome;
}

async function executeRepro(
  processes: ProcessScope,
  repro: Repro,
  options: Parameters<typeof runRepro>[2],
): Promise<ReproOutcome> {
  if (!options.executables.includes(repro.executable))
    return {
      status: "inconclusive",
      reason: `${repro.executable} is not a program the run's checks or their toolchains start (${options.executables.join(", ") || "none"})`,
      exitCode: null,
      output: "",
    };
  const workspace = namesakes(options.root, repro, options.shadows ?? []);
  for (const file of workspace.size ? (repro.files ?? []) : []) {
    const path = shadowedPath(file, workspace);
    if (path)
      return {
        status: "inconclusive",
        reason: `Input file ${file.name} is a copy of ${path}: the repro runs the copy, so no fix to ${path} can change its result. Run the workspace's own code instead (a single test, the package path, a project script, or a probe file that calls the code without copying it).`,
        exitCode: null,
        output: "",
      };
  }
  const before = await sourceManifest(options.root, options.generated, options.signal);
  const executable = repro.executable === "bun" ? process.execPath : repro.executable;
  // Input files live outside the workspace, so a repro still changes no source file (#528).
  const files = repro.files?.length ? mkdtempSync(join(tmpdir(), "baked-repro-files-")) : null;
  for (const file of repro.files ?? []) writeFileSync(join(files ?? "", file.name), file.content);
  const args = files ? repro.args.map((arg) => arg.replaceAll("{files}", files)) : repro.args;
  let result: Awaited<ReturnType<ProcessScope["execute"]>>;
  try {
    result = await processes.execute(executable, args, {
      cwd: options.root,
      env: reproEnv(options.root),
      timeoutMs: REPRO_TIMEOUT_MS,
      signal: options.signal,
      sandbox: options.sandbox,
      ...(repro.stdin !== undefined ? { stdin: repro.stdin } : {}),
    });
  } catch (error) {
    if (files) removeScratch(files);
    options.signal.throwIfAborted();
    return {
      status: "inconclusive",
      reason: `The command did not start: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: null,
      output: "",
    };
  }
  if (files) removeScratch(files);
  const output = result.output.slice(-OUTPUT_LIMIT);
  const after = await sourceManifest(options.root, options.generated);
  const inconclusive = (reason: string): ReproOutcome => ({
    status: "inconclusive",
    reason,
    exitCode: result.exitCode,
    output,
  });
  if (changedPaths(before, after).length)
    return inconclusive("The command changed source files; a repro must only read them");
  if (result.timedOut) return inconclusive(`The command ran longer than ${REPRO_TIMEOUT_MS} ms`);
  if (result.cancelled) return inconclusive("The command was cancelled");
  if (outputShows(result.output, repro.actual))
    return {
      status: "reproduced",
      reason: "The output shows the claimed actual value",
      exitCode: result.exitCode,
      output,
    };
  if (result.exitCode === 0)
    return {
      status: "refuted",
      reason: outputShows(result.output, repro.expected)
        ? "The output shows the expected value, not the claimed actual one"
        : "The command exited 0 without printing the claimed actual value",
      exitCode: 0,
      output,
    };
  return inconclusive(
    `The command exited ${result.exitCode ?? "without a code"} without printing the claimed actual value`,
  );
}

/**
 * Whether a finding may start a correction given its repro. A refuted claim is a note. A claim
 * whose repro could not show anything, and a correctness claim without a repro, are notes unless
 * the finding is a security finding or critical. When the run has no program a repro could start,
 * findings keep blocking as before.
 */
export function reproAllows(
  finding: Pick<Review["findings"][number], "kind" | "severity">,
  outcome: ReproOutcome["status"] | undefined,
  available: boolean,
): boolean {
  if (outcome === "reproduced") return true;
  if (outcome === "refuted") return false;
  if (!available) return true;
  const exempt = finding.kind === "security" || finding.severity === "critical";
  if (outcome === "inconclusive") return exempt;
  return exempt || finding.kind !== "correctness";
}

/**
 * Whether a reviewer's inconclusive repro crashed inside the finding's own file (#2152, sibling of
 * #2136): `edgeCrashDecision` on the output's tail against the finding's file, the decision the
 * edge probe makes for a probed case. `reproAllows` still keeps such a finding a note; the review
 * and convergence gates record this decision on the finding (`crash`) and an `edge_crash_finding`
 * would-stop when it would have repaired. Null when the repro was not inconclusive. A repro that
 * fails on its own (a syntax error, a missing module, frames only outside the file) is `pass`.
 */
export function reproCrash(
  outcome: Pick<ReproOutcome, "status" | "output"> | undefined,
  file: string | null | undefined,
): { crash: "finding" | "pass"; actual: string | null } | null {
  if (outcome?.status !== "inconclusive") return null;
  const { crash, actual } = caseCrash(outcome, [file ?? null]);
  return { crash, actual };
}

/**
 * Whether the convergence walker's finding passes the repro gate before it starts a correction:
 * medium and low findings do, high and critical ones repair on the walker's word (#930).
 */
export function convergenceReproGated(
  finding: Pick<Review["findings"][number], "severity">,
): boolean {
  return finding.severity === "medium" || finding.severity === "low";
}

/**
 * A `noRepro` reason that says the review had no way to run anything. Round 11 reviewers wrote
 * "No execution/reproduction tool is available in this session" while run_repro was offered.
 */
const NO_TOOL =
  /\bno\b[^.]*\b(tool|execution|run_repro)\b[^.]*\b(available|offered|provided|given)\b|\b(tool|execution|run_repro)\b[^.]*\bnot\b[^.]*\b(available|offered|provided|given)\b/i;

export function claimsNoReproTool(reason: string): boolean {
  return NO_TOOL.test(reason);
}

/**
 * Advice for a review whose correctness findings have neither a repro nor `noRepro`: a claim about
 * how runnable code behaves should come with the command that shows it, or say why none can.
 * With `programs` (run_repro is offered), a `noRepro` that says no tool was available is advised
 * too, naming the tool and what it can start (#528).
 */
export function missingReproAdvice(
  review: Review,
  programs?: readonly string[],
  earlier?: Review,
): string[] {
  // Asked once per finding across rounds: a repeat of a finding the previous round already gave a
  // noRepro for keeps that reason (`carryNoRepro`) instead of being asked again (#528).
  const settled = new Set(earlier?.findings.filter((f) => f.noRepro).map((f) => f.id));
  const correctness = review.findings.filter(
    (f) => f.kind === "correctness" && !f.repro && !(f.repeatOf && settled.has(f.repeatOf)),
  );
  const missing = correctness.filter((f) => !f.noRepro);
  const unseen = programs?.length
    ? correctness.filter((f) => f.noRepro && claimsNoReproTool(f.noRepro))
    : [];
  const advice: string[] = [];
  if (missing.length)
    advice.push(
      `Correctness finding(s) ${missing.map((f) => f.id).join(", ")} have no repro. For each, try a command with run_repro that prints the actual value where the spec requires the expected one, and attach it as repro; when no command can show the claim, set noRepro to say why. A finding without either is reported as unverified. Then call submit_result again with the complete review.`,
    );
  if (unseen.length && programs)
    advice.push(
      `Correctness finding(s) ${unseen.map((f) => f.id).join(", ")} say no tool was available to reproduce them, but this review offers run_repro, which starts ${programs.join(", ")} with your arguments in the workspace root. Try the claim with run_repro and attach the repro; keep noRepro only for a reason a command cannot overcome. Then call submit_result again with the complete review.`,
    );
  return advice;
}

/**
 * Advice for a dimension or convergence review whose missing or correctness findings on behavior
 * the request names fall below the confidence threshold without a repro: such a finding is a note
 * unless a repro shows it, so the reviewer is asked once to try it (#1210, #1415).
 */
export function unconfidentReproAdvice(review: Review, minConfidence: number): string[] {
  const unshown = review.findings.filter(
    (f) => !f.repro && !f.noRepro && confidenceOnlyNote(f, minConfidence),
  );
  if (!unshown.length) return [];
  return [
    `Finding(s) ${unshown.map((f) => f.id).join(", ")} are below the confidence threshold (${minConfidence}) and would be kept as notes, but they name behavior the request or spec asks for. For each, run the command the request describes with run_repro on the input the claim names and attach the repro when it prints actual: a reproduced claim starts a correction whatever its confidence. When it does not reproduce, leave the finding without a repro. Then call submit_result again with the complete review.`,
  ];
}

/**
 * Gives a repeated correctness finding without a repro the `noRepro` reason of the earlier finding
 * it repeats, so a reason given once holds in later rounds and the report shows it (linehunk
 * f0b66451 raised one finding in four rounds with the same reason).
 */
export function carryNoRepro(review: Review, earlier: Review | undefined): void {
  if (!earlier) return;
  const reasons = new Map(earlier.findings.flatMap((f) => (f.noRepro ? [[f.id, f.noRepro]] : [])));
  for (const finding of review.findings) {
    if (finding.kind !== "correctness" || finding.repro || finding.noRepro || !finding.repeatOf)
      continue;
    const reason = reasons.get(finding.repeatOf);
    if (reason) finding.noRepro = reason;
  }
}

/**
 * The input of `run_repro`: one repro, or `cases`, a list of repros run in one call (#1959). R62
 * md-site called run_repro 28 times for 2.12M tokens, each call sending the whole context again.
 */
export const ReproToolInputSchema = ReproSchema.partial()
  .extend({ cases: z.array(ReproSchema).min(1).max(BATTERY_CASES).optional() })
  .strict()
  .superRefine((input, context) => {
    if (input.cases) return;
    if (!ReproSchema.safeParse(input).success)
      context.addIssue({
        code: "custom",
        message: "Give executable, args, expected and actual, or cases: a list of such repros",
      });
  });

/** Each case of a battery, run one after the other, with its index and outcome. */
export async function runReproBattery(
  cases: readonly Repro[],
  run: (repro: Repro) => Promise<ReproOutcome>,
): Promise<(ReproOutcome & { case: number })[]> {
  const results: (ReproOutcome & { case: number })[] = [];
  for (const [index, repro] of cases.entries())
    results.push({ case: index, ...(await run(repro)) });
  return results;
}

/** The host tool a reviewer tries a repro with before it attaches the repro to a finding. */
export function reproTool(
  executables: readonly string[],
  run: (repro: Repro) => Promise<ReproOutcome>,
): HostTool {
  let tries = 0;
  return {
    description: `Run a repro the way the runtime will run it for a finding: the program (one of ${executables.join(", ")}) and its arguments, without a shell, in the workspace root, for up to ${REPRO_TIMEOUT_MS / 1000} s. For a program that reads its input, give the text as stdin, or input files as files (name and content), written to a temporary directory that {files} in an argument names. It must print the observed value on its own line and change no file. It must run the workspace's own code: an input file that copies a workspace file is refused, since no fix to that file could change the copy's output. Returns reproduced when a line of the output equals actual (an empty actual: the program prints nothing), refuted when it exits 0 without printing actual, inconclusive otherwise, with the output. To try several inputs, pass cases (up to ${BATTERY_CASES} repros) instead of one repro: they run in one call and the result lists each case's outcome. At most ${REPRO_TRIES} calls.`,
    inputSchema: ReproToolInputSchema,
    execute: async (input) => {
      if (++tries > REPRO_TRIES)
        return {
          status: "inconclusive",
          reason: `Only ${REPRO_TRIES} repro runs are allowed per review`,
        };
      const parsed = ReproToolInputSchema.parse(input);
      if (!parsed.cases) return run(ReproSchema.parse(input));
      const results = await runReproBattery(parsed.cases, run);
      return {
        status: results.some((r) => r.status === "reproduced") ? "reproduced" : "not_reproduced",
        reproduced: results.filter((r) => r.status === "reproduced").map((r) => r.case),
        results,
      };
    },
  };
}

/** Probes one repair attempt may run before it must edit or report. */
export const PROBE_TRIES = 8;

export interface ProbeOutcome {
  status: "ran" | "refused";
  reason?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  output: string;
}

/**
 * Runs a program the run's checks start, without a shell, in the task's root, to look at what a
 * library or the runtime does (hookdrop c325575b: `bun:sqlite` dropped a leading U+FEFF, which
 * the repair task could not see from the test output). Like a repro it may read the workspace
 * but not change it; a probe that changed source files is reported as refused.
 */
export async function runProbe(
  processes: ProcessScope,
  requested: { executable: string; args: string[] },
  options: {
    root: string;
    executables: readonly string[];
    generated: string[];
    signal: AbortSignal;
    /** The run's OS sandbox (see runSandbox), or null. */
    sandbox: SandboxRequest | null;
  },
): Promise<ProbeOutcome> {
  const probe = throughEntryPoint(requested, options);
  if (!options.executables.includes(probe.executable))
    return {
      status: "refused",
      reason: `${probe.executable} is not a program the run's checks or their toolchains start (${options.executables.join(", ") || "none"})`,
      output: "",
    };
  const before = await sourceManifest(options.root, options.generated, options.signal);
  const executable = probe.executable === "bun" ? process.execPath : probe.executable;
  let result: Awaited<ReturnType<ProcessScope["execute"]>>;
  try {
    result = await processes.execute(executable, probe.args, {
      cwd: options.root,
      env: reproEnv(options.root),
      timeoutMs: REPRO_TIMEOUT_MS,
      signal: options.signal,
      sandbox: options.sandbox,
    });
  } catch (error) {
    options.signal.throwIfAborted();
    return {
      status: "refused",
      reason: `The command did not start: ${error instanceof Error ? error.message : String(error)}`,
      output: "",
    };
  }
  const after = await sourceManifest(options.root, options.generated);
  if (changedPaths(before, after).length)
    return {
      status: "refused",
      reason: "The command changed source files; a probe must only read them. Edit with edit_file.",
      output: result.output.slice(-OUTPUT_LIMIT),
    };
  return {
    status: "ran",
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    output: result.output.slice(-OUTPUT_LIMIT),
  };
}

/** The host tool a repair task isolates a failure with before it edits again. */
/** README, Markdown and reStructuredText files: where a task writes command examples. */
const DOCUMENT = /(^|\/)readme(\.[^/]*)?$|\.(md|mdx|rst)$/i;

/**
 * Whether a task writes documentation. Such a task gets `run_probe` even when it is planned, so
 * the examples it writes come from a real invocation of the program, not from the spec (#716).
 */
export function writesDocumentation(writes: readonly { path: string; action: string }[]): boolean {
  return writes.some((w) => w.action !== "delete" && DOCUMENT.test(w.path.replaceAll("\\", "/")));
}

/**
 * Whether a finding about a document carries a repro that never reads that document: it shows
 * what the code does, which a fix to the document cannot change (#1375). ranktally d8bc82f7: F1
 * on README.md ran the tally with `expected: "[]"`, the corrective rewrote the README, the repro
 * still printed `["A","B"]` (what the claim itself says the code does), and the worker raised a
 * spec conflict that waited for a person. Such a repro is evidence for the finding, not a gate on
 * its correction.
 */
export function reproBlindToDocument(file: string | null | undefined, repro: Repro): boolean {
  if (!file || !DOCUMENT.test(file.replaceAll("\\", "/"))) return false;
  const name = basename(file.replaceAll("\\", "/")).toLowerCase();
  return ![repro.executable, ...repro.args].some((arg) => arg.toLowerCase().includes(name));
}

/**
 * Whether a finding's repro cannot see its correction, so it is evidence for the finding and not
 * a gate on the corrective task: a document finding whose repro runs code (#1375), or a finding
 * on a source file whose correction changed only its comments and docstrings (#1517). intsmith
 * ca6f3023: F2 said the docstring of cfrac.py wrongly bounds the period by 2*isqrt(d), and its
 * repro printed the code's period against that bound, which no docstring edit changes.
 */
export function reproCannotSeeCorrection(
  file: string | null | undefined,
  repro: Repro,
  change?: { before: string; after: string } | null,
): boolean {
  if (reproBlindToDocument(file, repro)) return true;
  return !!file && !!change && commentOnlyChange(file, change.before, change.after);
}

export function probeTool(
  executables: readonly string[],
  run: (probe: { executable: string; args: string[] }) => Promise<ProbeOutcome>,
): HostTool {
  let tries = 0;
  return {
    description: `Run a program (one of ${executables.join(", ")}) with arguments, without a shell, in the workspace root, for up to ${REPRO_TIMEOUT_MS / 1000} s, and read its output and exit code. Use it to isolate a failing check (one test alone, a few lines that call the library the code relies on), to confirm what the runtime or a library does before editing again, and to capture what a command prints before you document it. It must not change any file. At most ${PROBE_TRIES} runs.`,
    inputSchema: ProbeSchema,
    execute: async (input) => {
      if (++tries > PROBE_TRIES)
        return { status: "refused", reason: `Only ${PROBE_TRIES} probes are allowed per attempt` };
      return run(ProbeSchema.parse(input));
    },
  };
}
