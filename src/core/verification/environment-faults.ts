import { type NoRow, none } from "../intelligence/language-records.js";
import {
  readsPackages,
  unpreparedDependencies,
  unpreparedProblem,
} from "../workflows/dependency-dirs.js";
import type { GateToolchain } from "../workflows/gates.js";
import { toolchainCommand } from "../workflows/toolchain.js";

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
 * The machine-level failure signatures of each gate toolchain, or `none(reason)` for a toolchain
 * with no known one. A new toolchain gets a row (#2273).
 */
export const ENVIRONMENT_SIGNATURES: Readonly<
  Record<GateToolchain, readonly EnvironmentSignature[] | NoRow>
> = {
  gradle: [JDK_LOOPBACK(["gradle", "gradlew"], ["-q", "help"])],
  maven: [JDK_LOOPBACK(["mvn", "mvnw"])],
  sbt: [JDK_LOOPBACK(["sbt"])],
  npm: none("no machine-level failure observed"),
  python: none("no machine-level failure observed"),
  go: none("no machine-level failure observed"),
  cargo: none("no machine-level failure observed"),
  dotnet: none("no machine-level failure observed"),
  swift: none("no machine-level failure observed"),
  mix: none("no machine-level failure observed"),
  dart: none("no machine-level failure observed"),
  zig: none("no machine-level failure observed"),
  dune: none("no machine-level failure observed"),
  bundler: none("no machine-level failure observed"),
  luarocks: none("no machine-level failure observed"),
  shell: none("no machine-level failure observed"),
  composer: none("no machine-level failure observed"),
  cmake: none("no machine-level failure observed"),
  clang: none("no machine-level failure observed"),
  sqlfluff: none("no machine-level failure observed"),
  pwsh: none("no machine-level failure observed"),
  rscript: none("no machine-level failure observed"),
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
