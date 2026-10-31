import { existsSync } from "node:fs";
import { workspacePath } from "../specs/validate.js";
import type { Check } from "./types.js";

/**
 * A toolchain gate that needs another gate's output before it can run (#2526): CMake's build,
 * CTest and clang-tidy read the `build/` tree that `cmake-configure` writes, which a fresh task
 * worktree does not have (build outputs are not copied). The host runs the prerequisite first when
 * its marker is missing, and records it as its own check result. R82 tinyflate: `cmake-build` ran
 * before `cmake-configure` 12 times, each a failed required check ("build is not a directory")
 * that the worker read and repeated in the other order.
 *
 * Other toolchains resolve or restore inside their build command (`dotnet build`, `swift build`,
 * `cargo build`, Gradle's wrapper), or keep the step outside the gates (`dart pub get`,
 * `mix deps.get`, the worktree's package preparation), so they have no row.
 */
export interface GatePrerequisite {
  /** The gate that writes what this one reads, as `detectGates` names it. */
  checkId: string;
  /** A path the prerequisite writes; missing in the root means it has not run there. */
  marker: string;
}

export const GATE_PREREQUISITES: Readonly<Record<string, GatePrerequisite>> = {
  "cmake-build": { checkId: "cmake-configure", marker: "build/CMakeCache.txt" },
  ctest: { checkId: "cmake-configure", marker: "build/CMakeCache.txt" },
  "clang-tidy": { checkId: "cmake-configure", marker: "build/CMakeCache.txt" },
};

/**
 * The check to run before `check` in `root`: its prerequisite from the run's checks, when the
 * prerequisite's marker is missing. A run whose checks do not include the prerequisite runs the
 * check as it is.
 */
export function pendingPrerequisite(
  check: Check,
  checks: readonly Check[],
  root: string,
): { check: Check; marker: string } | null {
  const row = Object.hasOwn(GATE_PREREQUISITES, check.id)
    ? GATE_PREREQUISITES[check.id]
    : undefined;
  if (!row) return null;
  const step = checks.find((c) => c.id === row.checkId);
  if (!step || step.id === check.id) return null;
  return existsSync(workspacePath(root, row.marker)) ? null : { check: step, marker: row.marker };
}
