import { type NoRow, none } from "../intelligence/language-records.js";
import {
  readsPackages,
  unpreparedDependencies,
  unpreparedProblem,
} from "../workflows/dependency-dirs.js";
import type { GateToolchain } from "../workflows/gates.js";
import { toolchainCommand } from "../workflows/toolchain.js";
import { buildFailure, diagnosticCount, failedTests } from "./output-counts.js";

/**
 * Failures of a toolchain that come from the machine, not from the project's code (#2273). R72
 * jvmsig on Windows 11 with a short-path TEMP (`C:\Users\ILYAMY~1\...`): every `gradle check`
 * failed with the JDK's `Unable to establish loopback connection` (its selector pipe goes through a
 * Unix domain socket in the temp directory), while the doctor said "Ready to run" and each failed
 * required check would have opened correctives for code that was correct. A check whose failure
 * output matches a signature of its toolchain is `inconclusive` with reason `environment_broken`,
 * and the doctor runs the toolchain's probe once to say so before a run.
 */
export interface EnvironmentSignature {
  /** The programs (`toolchainCommand(...).program`) whose output this applies to. */
  programs: readonly string[];
  /** What the failing tool prints. */
  pattern: RegExp;
  /** What is wrong, in one sentence. */
  problem: string;
  /** What a person changes on the machine. */
  fix: string;
  /** A quick command (arguments of the same program) that fails the same way; the doctor runs it. */
  probe?: readonly string[];
}

/** The JDK selector pipe of every JVM build tool (sun.nio.ch.PipeImpl). */
const JDK_LOOPBACK = (
  programs: readonly string[],
  probe?: readonly string[],
): EnvironmentSignature => ({
  programs,
  pattern: /Unable to establish loopback connection/,
  problem:
    "The JVM cannot open its loopback pipe: the JDK makes it through a Unix domain socket in the temp directory, which fails on this machine (a short 8.3 TEMP path on Windows).",
  fix: "Set JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=<a short directory such as C:/Temp>, or point TEMP and TMP at a short path, then restart the build daemon (`gradle --stop`).",
  ...(probe ? { probe } : {}),
});

/**
 * SwiftPM crashing on its own build directory (#2418, R76 hintsieve on Windows 11, Swift 6.4.1,
 * task worktrees building at once): `error: Build failed` and `error: fatalError` with no compiler
 * or XCTest `error:` line of a `.swift` file, and the same check passed 29 s later. The
 * `warning: unable to create symbolic link at ...\.build\debug: encountered an I/O error (code:
 * 512)` printed beside it is not the signature: SwiftPM prints it on builds that pass too.
 */
const SWIFTPM_CRASH: EnvironmentSignature = {
  programs: ["swift"],
  pattern:
    // biome-ignore lint/suspicious/noControlCharactersInRegex: swiftc colours its `error:` (#1492)
    /^(?![\s\S]*\.swift:\d+(?::\d+)?: (?:\u001b\[[0-9;]*m)*error)[\s\S]*\berror: Build failed\b[\s\S]*\berror: fatalError\b/,
  problem:
    "SwiftPM crashed (`error: fatalError`) without a compiler error: it does this when several packages or worktrees build on one disk at once and one cannot write its `.build` directory.",
  fix: "Run fewer Swift builds at once (lower the run's parallel tasks or feature runs), or keep each worktree's `.build` on a fast local disk excluded from antivirus scanning.",
};

/** A `none` row's reason: the round and date through which nothing was observed (#2418). */
const NONE_OBSERVED = "no machine-level failure observed through bench round 76 (2026-10-28)";

/**
 * The machine-level failure signatures of each gate toolchain, or `none(reason)` for a toolchain
 * with no known one. A new toolchain gets a row (#2273), and a `none` row says through which
 * bench round and date nothing was observed (#2418).
 */
export const ENVIRONMENT_SIGNATURES: Readonly<
  Record<GateToolchain, readonly EnvironmentSignature[] | NoRow>
> = {
  gradle: [JDK_LOOPBACK(["gradle", "gradlew"], ["-q", "help"])],
  maven: [JDK_LOOPBACK(["mvn", "mvnw"])],
  sbt: [JDK_LOOPBACK(["sbt"])],
  npm: none(NONE_OBSERVED),
  python: none(NONE_OBSERVED),
  go: none(NONE_OBSERVED),
  cargo: none(NONE_OBSERVED),
  dotnet: none(NONE_OBSERVED),
  swift: [SWIFTPM_CRASH],
  mix: none(NONE_OBSERVED),
  dart: none(NONE_OBSERVED),
  zig: none(NONE_OBSERVED),
  dune: none(NONE_OBSERVED),
  bundler: none(NONE_OBSERVED),
  luarocks: none(NONE_OBSERVED),
  shell: none(NONE_OBSERVED),
  composer: none(NONE_OBSERVED),
  cmake: none(NONE_OBSERVED),
  clang: none(NONE_OBSERVED),
  sqlfluff: none(NONE_OBSERVED),
  pwsh: none(NONE_OBSERVED),
  rscript: none(NONE_OBSERVED),
};

const signatures = (): EnvironmentSignature[] =>
  Object.values(ENVIRONMENT_SIGNATURES).flatMap((row) => ("none" in row ? [] : [...row]));

/** The signatures that apply to a command's program. */
export function environmentSignaturesFor(
  executable: string,
  args: readonly string[],
): EnvironmentSignature[] {
  const { program } = toolchainCommand(executable, args);
  return signatures().filter((s) => s.programs.includes(program));
}

/** The signature a failed command's output matches, or null. */
export function environmentFault(
  executable: string,
  args: readonly string[],
  output: string,
): EnvironmentSignature | null {
  return environmentSignaturesFor(executable, args).find((s) => s.pattern.test(output)) ?? null;
}

/** The note a check whose failure matches a signature gets under its output. */
export const environmentNote = (checkId: string, signature: EnvironmentSignature) =>
  `Note: ${checkId} failed because of the machine, not the project's code, so it counts as inconclusive and opens no correction. ${signature.problem} ${signature.fix}`;

/**
 * The note for a failed check of a worktree or copy whose packages its prepare command could not
 * resolve (#2372: `dart pub get --offline` with a package missing from the pub cache), or null.
 * Such a check fails on unresolved imports whatever the code says, so it is inconclusive like a
 * machine fault. The working copy itself resolves its packages as its tools do, so it never gets one.
 */
export function unpreparedNote(
  checkId: string,
  root: string,
  workspace: string,
  executable: string,
  args: readonly string[],
): string | null {
  if (root === workspace) return null;
  const command = toolchainCommand(executable, args);
  const unprepared = unpreparedDependencies(root).find((u) =>
    readsPackages(u.language, command.program, command.args),
  );
  return unprepared
    ? `Note: ${checkId} failed in a worktree whose packages were not resolved, so it counts as inconclusive and opens no correction. ${unpreparedProblem(unprepared)}`
    : null;
}

/**
 * A word of a failure a tool reports about the code: a failed test or assertion, a compiler, lint
 * or format finding, an exception. A crash or kill of the tool itself prints none of them.
 */
const FAILURE_WORD =
  /\b(?:errors?|fail(?:s|ed|ure|ures)?|fatal|panic(?:ked)?|exception|traceback|assert(?:ion)?|warn(?:ing|ings)?|reformat(?:ted)?|violations?|issues? found)\b/i;

/**
 * Whether a failed check's output holds no failure line of any toolchain (#2418): no failed test
 * (`FAILED_TESTS`), no build failure (`BUILD_FAILURES`), no linter or type checker count and no
 * line with a failure word. R76 hintsieve: `swift test` exited 4 after 27.7 s with only SwiftPM
 * progress lines (`[24 / 31] HintSieveCoreTests-test-runner`), opened a 440k-token corrective with
 * an empty diff, and the same tree passed on its next run. Such a failure says nothing about the
 * code, so the checks stage re-runs it once before it opens a correction (`silent_check_failure`).
 */
export function silentFailure(output: string): boolean {
  if (failedTests(output)?.names.length) return false;
  if (buildFailure(output, 1)) return false;
  if (diagnosticCount(output)?.count) return false;
  return !FAILURE_WORD.test(output);
}
