// Reports the tests of a `bun test --reporter=junit` run that came close to their time limit:
// `bun scripts/slow-tests.ts <junit.xml> <default limit ms> [--fail]`. A test above half of its
// limit is a warning annotation; above 80 percent it is an error, and with `--fail` the script
// exits non-zero. Windows merge-queue runs timed out at 18 to 41 s against a 30 s limit (#1589):
// the tests had grown into their limits over several PRs, and the first sign was a PR ejected from
// the queue (#1656).
import { readFileSync } from "node:fs";

export const WARN_SHARE = 0.5;
export const FAIL_SHARE = 0.8;

export interface SlowTest {
  file: string;
  line: number;
  name: string;
  ms: number;
  limitMs: number;
  share: number;
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
 * The index just past the call whose opening parenthesis is at `open`, or -1. Strings, template
 * literals and comments are skipped; a regular expression literal with a parenthesis in it can
 * end the scan early, and the caller then falls back to the default limit.
 */
function callEnd(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      for (i++; i < source.length && source[i] !== char; i++) if (source[i] === "\\") i++;
    } else if (char === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      if (i === -1) return -1;
    } else if (char === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i);
      if (i === -1) return -1;
      i++;
    } else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * The time limit a test passes as the last argument of its `test(...)` or `it(...)` call at
 * `line` (a number such as `120_000`), or null when it passes none or not as a literal.
 */
export function ownLimit(source: string, line: number): number | null {
  const lines = source.split("\n");
  const start = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
  const call = /\b(?:test|it)(?:\.\w+)*\s*\(/g;
  call.lastIndex = start;
  const found = call.exec(source);
  if (!found || found.index >= start + (lines[line - 1]?.length ?? 0)) return null;
  const end = callEnd(source, found.index + found[0].length - 1);
  if (end === -1) return null;
  const limit = /,\s*([\d_]+)\s*,?\s*\)$/.exec(source.slice(found.index, end))?.[1];
  return limit === undefined ? null : Number(limit.replaceAll("_", ""));
}

/** The tests of a junit report above `WARN_SHARE` of their limit, slowest share first. */
export function slowTests(
  xml: string,
  defaultLimitMs: number,
  read: (file: string) => string | null,
): SlowTest[] {
  const sources = new Map<string, string | null>();
  const slow: SlowTest[] = [];
  for (const match of xml.matchAll(/<testcase\b[^>]*>/g)) {
    const tag = match[0];
    const file = attribute(tag, "file");
    const ms = Number(attribute(tag, "time") ?? "0") * 1000;
    // Below half a second no limit a test sets is close; the source is not read.
    if (!file || !(ms >= 500)) continue;
    const line = Number(attribute(tag, "line") ?? "0");
    if (!sources.has(file)) sources.set(file, read(file));
    const source = sources.get(file);
    const limitMs = (source && line ? ownLimit(source, line) : null) ?? defaultLimitMs;
    const share = ms / limitMs;
    if (share > WARN_SHARE)
      slow.push({ file, line, name: attribute(tag, "name") ?? "", ms, limitMs, share });
  }
  return slow.sort((a, b) => b.share - a.share);
}

/** One GitHub annotation line per slow test. */
export function annotations(slow: readonly SlowTest[]): string[] {
  return slow.map((test) => {
    const level = test.share > FAIL_SHARE ? "error" : "warning";
    const text = `${test.name} took ${(test.ms / 1000).toFixed(1)} s of its ${(test.limitMs / 1000).toFixed(0)} s limit (${Math.round(test.share * 100)} percent)`;
    return `::${level} file=${test.file},line=${String(test.line)}::${text}`;
  });
}

if (import.meta.main) {
  const [path, limit, flag] = process.argv.slice(2);
  if (!path || !Number(limit)) {
    console.error("usage: bun scripts/slow-tests.ts <junit.xml> <default limit ms> [--fail]");
    process.exit(2);
  }
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  const slow = slowTests(readFileSync(path, "utf8"), Number(limit), read);
  for (const line of annotations(slow)) console.log(line);
  const failing = slow.filter((test) => test.share > FAIL_SHARE).length;
  console.log(
    `${String(slow.length)} tests above ${String(WARN_SHARE * 100)} percent of their limit, ${String(failing)} above ${String(FAIL_SHARE * 100)} percent.`,
  );
  if (flag === "--fail" && failing) process.exit(1);
}
