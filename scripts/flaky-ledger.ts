// Tells a flaky failure from a real one after a failed test run: `bun scripts/flaky-ledger.ts
// <junit.xml> <timeout ms> <ledger.json>`. Each failed test is run again alone on the same commit
// and OS, `RERUNS` times; one that passes any rerun is likely flaky, one that fails every rerun is
// real. The ledger records each test's reruns for the job artifact, and an annotation names the
// verdict. The run stays failed either way: a flaky test is fixed, never skipped (#1724). About a
// fifth of the merge-queue OS-tests runs failed over three days, and each was told apart by hand
// (#1656).
import { writeFileSync } from "node:fs";

export const RERUNS = 3;
/** More failures than this are a broken change, not flakes; the rest are listed unrerun. */
export const MAX_RERUN_TESTS = 5;

export interface FailedTest {
  file: string;
  line: number;
  /** The describe blocks, outermost first, then the test's own name. */
  path: string[];
}

export interface LedgerEntry extends FailedTest {
  reruns: number;
  passes: number;
  verdict: "real" | "likely flaky" | "not rerun";
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|apos|#(\d+));/g, (_, name: string, code?: string) =>
    code ? String.fromCharCode(Number(code)) : (ENTITIES[name] ?? ""),
  );

function attribute(tag: string, name: string): string | undefined {
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  return value === undefined ? undefined : unescape(value);
}

/**
 * The failed tests of a bun junit report. Bun writes a test's describe blocks innermost first in
 * `classname`, joined by " > ", and nests a `<failure>` in the `<testcase>`.
 */
export function failedTests(xml: string): FailedTest[] {
  const failed: FailedTest[] = [];
  for (const match of xml.matchAll(/<testcase\b[^>]*>/g)) {
    const tag = match[0];
    if (tag.endsWith("/>")) continue;
    const start = match.index + tag.length;
    const body = xml.slice(start, xml.indexOf("</testcase>", start));
    if (!body.includes("<failure")) continue;
    const file = attribute(tag, "file")?.replaceAll("\\", "/");
    const name = attribute(tag, "name");
    if (!file || name === undefined) continue;
    const classname = attribute(tag, "classname") ?? "";
    const blocks = classname ? classname.split(" > ").reverse() : [];
    failed.push({ file, line: Number(attribute(tag, "line") ?? "0"), path: [...blocks, name] });
  }
  return failed;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The `bun test -t` pattern that selects exactly this test: bun joins its names with spaces. */
export const namePattern = (test: FailedTest): string => `^${escapeRegex(test.path.join(" "))}$`;

export function verdict(passes: number, reruns: number): LedgerEntry["verdict"] {
  if (reruns === 0) return "not rerun";
  return passes > 0 ? "likely flaky" : "real";
}

/** One annotation per failed test, on its line. */
export function annotations(entries: readonly LedgerEntry[]): string[] {
  return entries.map((entry) => {
    const name = entry.path.join(" > ");
    const level = entry.verdict === "likely flaky" ? "warning" : "error";
    const text =
      entry.verdict === "not rerun"
        ? `${name} failed (not rerun: more than ${String(MAX_RERUN_TESTS)} tests failed)`
        : entry.verdict === "likely flaky"
          ? `${name} failed, likely flaky: ${String(entry.passes)}/${String(entry.reruns)} isolated reruns passed`
          : `${name} failed, real: 0/${String(entry.reruns)} isolated reruns passed`;
    return `::${level} file=${entry.file},line=${String(entry.line)}::${text}`;
  });
}

if (import.meta.main) {
  const [report, timeout, out] = process.argv.slice(2);
  if (!report || !Number(timeout) || !out) {
    console.error("usage: bun scripts/flaky-ledger.ts <junit.xml> <timeout ms> <ledger.json>");
    process.exit(2);
  }
  const failed = failedTests(await Bun.file(report).text());
  const entries: LedgerEntry[] = [];
  for (const [i, test] of failed.entries()) {
    let passes = 0;
    const reruns = i < MAX_RERUN_TESTS ? RERUNS : 0;
    for (let run = 0; run < reruns; run++) {
      const proc = Bun.spawn(
        ["bun", "test", "--timeout", timeout, `./${test.file}`, "-t", namePattern(test)],
        { stdout: "ignore", stderr: "ignore" },
      );
      if ((await proc.exited) === 0) passes++;
    }
    entries.push({ ...test, reruns, passes, verdict: verdict(passes, reruns) });
  }
  const ledger = {
    schemaVersion: 1,
    commit: process.env.GITHUB_SHA ?? null,
    os: process.platform,
    job: process.env.GITHUB_JOB ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    event: process.env.GITHUB_EVENT_NAME ?? null,
    tests: entries,
  };
  writeFileSync(out, `${JSON.stringify(ledger, null, 2)}\n`);
  for (const line of annotations(entries)) console.log(line);
  const flaky = entries.filter((e) => e.verdict === "likely flaky").length;
  console.log(
    `${String(entries.length)} failed tests: ${String(flaky)} likely flaky, ${String(entries.length - flaky)} real or not rerun. Ledger: ${out}`,
  );
}
