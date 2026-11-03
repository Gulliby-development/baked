import { isAbsolute, relative } from "node:path";
import { SPEC_PUBLICATION_FILES } from "../specs/render.js";
import { isTestCheck } from "../workflows/quality/mutation.js";
import type { Check } from "../workflows/types.js";
import { plainOutput } from "./plain-output.js";

/**
 * The files a formatter's check output reports unformatted, and the count its summary line gives,
 * or null when the output is not that formatter's report. One reader per formatter that formats
 * Markdown or JSON, the formats of the documents a run publishes (#2641).
 */
type FormatReport = { files: string[]; count: number };

const PATH_LINE = /^[^\s:]+\.[A-Za-z0-9]+$/;

export const FORMAT_FAILURE_READERS: Record<
  string,
  (lines: readonly string[]) => FormatReport | null
> = {
  // `[warn] specs/a/spec.json` per file, then `[warn] Code style issues found in 2 files.` or
  // `... found in the above file.`; an `[error]` line (a file Prettier cannot parse) is no format report.
  prettier: (lines) => {
    if (lines.some((line) => line.startsWith("[error]"))) return null;
    let count: number | null = null;
    const files: string[] = [];
    for (const line of lines) {
      const summary =
        /^\[warn\] Code style issues (?:found )?in (?:(\d+) files|the above file)/.exec(line);
      if (summary) count = summary[1] ? Number(summary[1]) : 1;
      else if (line.startsWith("[warn] ")) files.push(line.slice(7).trim());
    }
    return count === null ? null : { files, count };
  },
  // `bun fmt --check`: the files alone, then `2 files need formatting.` or `1 file needs formatting.`
  "bun fmt": (lines) => {
    const at = lines.findIndex((line) => /^\d+ files? needs? formatting\b/.test(line));
    if (at < 0) return null;
    const files = lines.slice(0, at).filter((line) => PATH_LINE.test(line));
    return { files, count: Number(/^\d+/.exec(lines[at] ?? "")?.[0]) };
  },
  // dprint check and deno fmt --check: `from <path>:` above each diff, then
  // `Found 2 not formatted files.` (deno adds `in 9 files`).
  "dprint, deno fmt": (lines) => {
    const summary = lines
      .map((line) => /\bFound (\d+) not formatted files?\b/.exec(line))
      .find(Boolean);
    if (!summary) return null;
    const files = lines.flatMap((line) => {
      const from = /^from (.+?):\s*$/.exec(line);
      return from?.[1] ? [from[1]] : [];
    });
    return { files, count: Number(summary[1]) };
  },
  // Biome: a header per diagnostic, `specs/a/spec.json format ━━━` or
  // `src/a.ts:3:1 lint/style/useConst ━━━`, then `Found 1 error.` and `Found 2 warnings.`.
  biome: (lines) => {
    let count: number | null = null;
    const files: string[] = [];
    for (const line of lines) {
      const found = /^Found (\d+) (?:errors?|warnings?|infos?)\b/.exec(line);
      if (found) count = (count ?? 0) + Number(found[1]);
      const header =
        /^(\S+?)(?::\d+:\d+)? (?:format|lint\/\S+|assist\/\S+|parse|organizeImports|check)\b.*━/.exec(
          line,
        );
      if (header?.[1]) files.push(header[1]);
    }
    return count === null ? null : { files, count };
  },
};

const DOCUMENT = new RegExp(
  `^specs/[^/]+/(?:${SPEC_PUBLICATION_FILES.map((name) => name.replace(/\./g, "\\.")).join("|")})$`,
);

/**
 * Whether `path`, as a check run in `cwd` prints it, is a document the host publishes for a run:
 * `specs/<feature>/spec.json`, `spec.md`, `plan.md`, `tasks.json` or `tasks.md`, its own or an
 * upstream feature's an initiative placed in its base. No task writes them (`validate.ts` refuses
 * a write under `specs/`).
 */
export function isHostDocument(path: string, cwd?: string): boolean {
  const file = checkRelative(path, cwd);
  return file !== null && DOCUMENT.test(file);
}

/** `path` relative to the check's directory, `/`-separated; null for an absolute path without one. */
function checkRelative(path: string, cwd?: string): string | null {
  const file = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!isAbsolute(path) && !/^[A-Za-z]:\//.test(file)) return file;
  return cwd === undefined ? null : relative(cwd, path).replaceAll("\\", "/");
}

/**
 * The host-published documents a failed formatter check reports, when they are all it reports
 * (#2641), or null. R87 slk: the run published `specs/<feature>/` unformatted, the project's
 * whole-tree `prettier --check .` reported those five files and nothing else, no task may write
 * `specs/`, and the fixer runs only on a task's files, so the task ended unfinished twice and the
 * run blocked. Such a failure is the host's, not the task's. A report that also names any other file, a file the formatter could not parse, or a
 * summary count that does not match the files read stays a failure. The check's own result stays
 * failed (a passed result has exit 0); the run's decisions read it through `hostDocumentDebt` in
 * `scheduler.ts` and `hostPassedChecks`.
 */
export function hostDocumentFailure(
  check: Pick<Check, "id" | "executable" | "args">,
  output: string,
  cwd?: string,
): string[] | null {
  if (isTestCheck(check)) return null;
  const lines = plainOutput(output)
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  for (const read of Object.values(FORMAT_FAILURE_READERS)) {
    const report = read(lines);
    if (!report?.files.length || report.files.length !== report.count) continue;
    const files = report.files.map((file) => checkRelative(file, cwd));
    return files.every((file) => file !== null && DOCUMENT.test(file)) ? (files as string[]) : null;
  }
  return null;
}

/** The note a check that failed only on host-published documents gets with its output. */
export const hostDocumentNote = (check: Pick<Check, "id">, files: readonly string[]): string =>
  `Note: ${check.id} reported only documents the host publishes for the run (${files.join(", ")}); no task writes them and they are not the task's work, so the run does not count this failure against the check. Do not edit them. A project that does not want them formatted lists specs/ in the formatter's ignore file.`;
