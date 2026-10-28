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
 *
 * Maven's surefire writes the same reports under each module's `target/surefire-reports/`, and
 * `mvn -q` prints no summary either (#2378). A narrowed run (`-Dtest=`, with
 * `-Dsurefire.failIfNoSpecifiedTests=false` so a module without the classes does not fail) that
 * selected no test exits 0 and writes no report: Maven never skips surefire as up to date, so such
 * a run is read as zero tests, which a check that must run tests fails on.
 */

interface ReportLayout {
  /** The folder a project or module builds into: `build`, `target`. */
  build: string;
  /** The reports folder under it. */
  reports: string;
  /** Whether the reports sit one folder deeper, per test task (Gradle's `test-results/<task>/`). */
  perTask: boolean;
}

const LAYOUTS: Record<"gradle" | "maven", ReportLayout> = {
  gradle: { build: "build", reports: "test-results", perTask: true },
  maven: { build: "target", reports: "surefire-reports", perTask: false },
};

/** The programs whose runs write the reports. */
const PROGRAMS: Record<string, keyof typeof LAYOUTS> = {
  gradle: "gradle",
  gradlew: "gradle",
  mvn: "maven",
  mvnw: "maven",
};
/** How deep under the check's folder a subproject's `build/` may be. */
const MAX_DEPTH = 4;
const SKIPPED_DIRS = new Set([".git", ".gradle", ".mvn", "node_modules", ".baked", "src"]);

/** The JUnit XML report files of `layout` under `root` changed at or after `since`. */
function reportFiles(root: string, since: number, layout: ReportLayout): string[] {
  const found: string[] = [];
  const collect = (dir: string) => {
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      return;
    }
    for (const file of files.sort()) {
      if (!/^TEST-.*\.xml$/.test(file)) continue;
      const path = join(dir, file);
      try {
        // File times have a coarse resolution on some file systems.
        if (statSync(path).mtimeMs >= since - 2000) found.push(path);
      } catch {
        // Removed meanwhile.
      }
    }
  };
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    if (names.includes(layout.build)) {
      const results = join(dir, layout.build, layout.reports);
      if (!layout.perTask) collect(results);
      else {
        let tasks: string[] = [];
        try {
          tasks = readdirSync(results);
        } catch {
          // No tests ran in this project.
        }
        for (const task of tasks.sort()) collect(join(results, task));
      }
    }
    if (depth >= MAX_DEPTH) return;
    for (const name of names.sort()) {
      if (name === layout.build || SKIPPED_DIRS.has(name) || name.startsWith(".")) continue;
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

/** How much of a failure's message and text the appended block keeps (#2272). */
const MESSAGE_CHARS = 500;
const TEXT_LINES = 10;

const decodeXml = (text: string) =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, raw: string) =>
      raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    )
    .replace(/&(lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_, entity: string) => {
      const named: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'" };
      if (named[entity]) return named[entity];
      return String.fromCodePoint(
        Number.parseInt(entity.slice(/^#x/i.test(entity) ? 2 : 1), /^#x/i.test(entity) ? 16 : 10),
      );
    })
    .replace(/&amp;/g, "&");
const escapeXml = (text: string, quotes: boolean) => {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return quotes ? escaped.replace(/"/g, "&quot;") : escaped;
};

/**
 * The `<failure>` of a failed testcase's body, with the report's `message` (cut at
 * `MESSAGE_CHARS`), `type` and the first `TEXT_LINES` lines of its text, re-escaped. `gradle -q`
 * prints no failure text, so a bare `<failure/>` gave the model only the test's name and cost a
 * rerun per failing run: 19 runs in jvmsig, R72 (#2272). An `<error>` is written as a failure.
 */
function failureElement(body: string): string {
  const match = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
  if (!match) return "<failure/>";
  const message = attribute(match[2] ?? "", "message");
  const type = attribute(match[2] ?? "", "type");
  const lines = decodeXml(match[3] ?? "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .split("\n");
  const text = lines.slice(0, TEXT_LINES).join("\n") + (lines.length > TEXT_LINES ? "\n\t..." : "");
  const attributes = [
    message === undefined
      ? ""
      : ` message="${escapeXml(decodeXml(message).slice(0, MESSAGE_CHARS), true)}"`,
    type === undefined ? "" : ` type="${escapeXml(decodeXml(type), true)}"`,
  ].join("");
  return text
    ? `<failure${attributes}>${escapeXml(text, false)}</failure>`
    : `<failure${attributes}/>`;
}

/**
 * The totals of the Gradle or Maven test reports a run wrote in `cwd` since `since`, as a JUnit
 * block, or null when the command is neither or wrote no report. A narrowed Maven run that exited
 * 0 without a report gets a block of zero tests (#2378).
 */
export function testReport(
  executable: string,
  args: readonly string[],
  cwd: string,
  since: number,
  exitCode: number | null = null,
): string | null {
  const tool = PROGRAMS[toolchainCommand(executable, args).program];
  if (!tool) return null;
  const files = reportFiles(cwd, since, LAYOUTS[tool]);
  const where = `${LAYOUTS[tool].build}/${LAYOUTS[tool].reports}`;
  if (!files.length)
    return tool === "maven" && exitCode === 0 && args.some((arg) => arg.startsWith("-Dtest="))
      ? [
          `Maven test reports (none under ${where}, read by BAKED): the -Dtest selection ran no test class.`,
          '<testsuites tests="0" skipped="0" failures="0" errors="0">',
          "</testsuites>",
        ].join("\n")
      : null;
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
          `  <testcase classname="${attribute(test[1] ?? "", "classname") ?? ""}" name="${attribute(test[1] ?? "", "name") ?? ""}">${failureElement(test[2] ?? "")}</testcase>`,
        );
  }
  return [
    `${tool === "maven" ? "Maven" : "Gradle"} test reports (${files.length} file${files.length === 1 ? "" : "s"} under ${where}, read by BAKED):`,
    `<testsuites tests="${totals.tests}" skipped="${totals.skipped}" failures="${totals.failures}" errors="${totals.errors}">`,
    ...failed,
    "</testsuites>",
  ].join("\n");
}
