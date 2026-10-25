import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { toolchainCommand } from "../workflows/toolchain.js";

/**
 * Gradle prints no test total (#1489): `gradle -q check` is silent on success, and its failure
 * lines (`CalcTest > fails() FAILED`) give no count, so the check baseline compared nothing for a
 * Gradle project. Gradle writes a JUnit XML report per test class under each project's
 * `build/test-results/<task>/`; after a Gradle check the host reads the reports that run wrote and
 * appends their totals and failed tests to the output as one JUnit `<testsuites>` block, which the
 * `junit` test runner counts. A test task Gradle skipped as up to date writes no report, so it adds
 * nothing and the run compares nothing.
 */

/** Gradle programs whose runs write the reports. */
const GRADLE = new Set(["gradle", "gradlew"]);
/** How deep under the check's folder a subproject's `build/` may be. */
const MAX_DEPTH = 4;
const SKIPPED_DIRS = new Set([".git", ".gradle", "node_modules", ".baked", "src"]);

/** The JUnit XML report files under `root/.../build/test-results/` changed at or after `since`. */
function reportFiles(root: string, since: number): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    if (names.includes("build")) {
      const results = join(dir, "build", "test-results");
      let tasks: string[] = [];
      try {
        tasks = readdirSync(results);
      } catch {
        // No tests ran in this project.
      }
      for (const task of tasks.sort()) {
        let files: string[] = [];
        try {
          files = readdirSync(join(results, task));
        } catch {
          continue;
        }
        for (const file of files.sort()) {
          if (!/^TEST-.*\.xml$/.test(file)) continue;
          const path = join(results, task, file);
          try {
            // File times have a coarse resolution on some file systems.
            if (statSync(path).mtimeMs >= since - 2000) found.push(path);
          } catch {
            // Removed meanwhile.
          }
        }
      }
    }
    if (depth >= MAX_DEPTH) return;
    for (const name of names.sort()) {
      if (name === "build" || SKIPPED_DIRS.has(name) || name.startsWith(".")) continue;
      const path = join(dir, name);
      try {
        if (statSync(path).isDirectory()) walk(path, depth + 1);
      } catch {
        // Unreadable.
      }
    }
  };
  walk(root, 0);
  return found;
}

const attribute = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/**
 * The totals of the Gradle test reports a run wrote in `cwd` since `since`, as a JUnit block, or
 * null when the command is not Gradle or wrote no report.
 */
export function gradleTestReport(
  executable: string,
  args: readonly string[],
  cwd: string,
  since: number,
): string | null {
  if (!GRADLE.has(toolchainCommand(executable, args).program)) return null;
  const files = reportFiles(cwd, since);
  if (!files.length) return null;
  const totals = { tests: 0, skipped: 0, failures: 0, errors: 0 };
  const failed: string[] = [];
  for (const file of files) {
    let xml: string;
    try {
      xml = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const suite of xml.matchAll(/<testsuite\b[^>]*>/g)) {
      totals.tests += Number(attribute(suite[0], "tests") ?? 0);
      totals.skipped += Number(attribute(suite[0], "skipped") ?? 0);
      totals.failures += Number(attribute(suite[0], "failures") ?? 0);
      totals.errors += Number(attribute(suite[0], "errors") ?? 0);
    }
    for (const test of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g))
      if (/<(?:failure|error)\b/.test(test[2] ?? ""))
        failed.push(
          `  <testcase classname="${attribute(test[1] ?? "", "classname") ?? ""}" name="${attribute(test[1] ?? "", "name") ?? ""}"><failure/></testcase>`,
        );
  }
  return [
    `Gradle test reports (${files.length} file${files.length === 1 ? "" : "s"} under build/test-results, read by BAKED):`,
    `<testsuites tests="${totals.tests}" skipped="${totals.skipped}" failures="${totals.failures}" errors="${totals.errors}">`,
    ...failed,
    "</testsuites>",
  ].join("\n");
}
