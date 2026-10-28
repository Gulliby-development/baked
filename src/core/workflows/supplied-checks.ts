import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { runGit } from "../git/status.js";
import { copyWorkspace } from "../verification/doc-examples.js";
import { removeScratch } from "../verification/repro.js";
import { sourceManifest } from "../verification/snapshot.js";
import { relativeHeaded } from "../verification/task-end-check.js";
import { isCodePath, isStaticCheck, isWholeUnitCheck } from "./check-policy.js";
import { changedLineRanges, type LineRange } from "./format-written.js";
import { crlfPatch } from "./host-apply.js";
import { isTestCheck } from "./quality/mutation.js";
import { suppliedBlocks } from "./sizing.js";
import type { WorkflowStore } from "./store.js";
import type { Check, Task } from "./types.js";

/**
 * The project's own static checks run on the content a request supplies verbatim, before the
 * task's first implementer session (#2275). R72 namesound-update (Ruby): the request gave a block
 * for `group_command.rb` and required a clean `bundle exec rubocop`, and the block failed
 * Style/IfUnlessModifier. T001 found the conflict only by running rubocop itself, could not win it
 * (the supplied text and the lint gate disagree), and spent 858k tokens over 7 attempts and 24
 * rubocop runs, then a review corrective of 103k rewrote the delivered code to the supplied diff.
 *
 * The host now writes the task's supplied blocks (whole files, and diffs applied with `git apply`)
 * into a scratch copy of its base (`copyWorkspace`, the documented-example runner's copy), runs
 * each required file-local static check of the task (`coveringChecks`' kind: linters and
 * formatters, never tests or whole-unit tools) there once, and keeps the diagnostics located on
 * lines the supplied content sets. Any such diagnostic is a conflict between the request's two
 * demands, which only a person can settle: `suppliedCheckText` is the `spec_conflict` it would
 * raise, naming the check, the rule and the line.
 *
 * It ships in shadow: the record is `supplied-checks/tasks/<task>.json` (kind `supplied-check`,
 * kept in bench traces with paths, lines and rule ids, no tool messages), the implementer still
 * runs, and `baked workflow status` lists the records under `suppliedChecks`. Promoting the
 * conflict to an analysis finding settled by the request conflict decision is a pull request of
 * its own, once bench rounds show the records.
 */
export const SUPPLIED_CHECK_KIND = "supplied-check";
/** One record per planned task with supplied code: `supplied-checks/tasks/<task>.json`. */
export const SUPPLIED_CHECK_DIR = "supplied-checks/tasks/";
/** Diagnostics a record keeps per check. */
const OFFENSE_LIMIT = 20;

/** A diagnostic located on a line the request's content sets. */
export interface SuppliedOffense {
  path: string;
  /** 1-based; null when the tool's output gives no line (a header and `-->` location). */
  line: number | null;
  /** The tool's rule id (`Style/IfUnlessModifier`, `lint/style/useConst`, `F401`), when it prints one. */
  rule: string | null;
}

/** One check's run on the copy with the supplied content written in. */
export interface SuppliedCheckRun {
  checkId: string;
  status: "passed" | "failed" | "inconclusive" | "skipped";
  /** Why a check did not run: a whole-unit tool, which fails on files later tasks write. */
  reason?: string;
  offenses: SuppliedOffense[];
}

/** What `supplied-checks/tasks/<task>.json` records. */
export interface SuppliedCheckRecord {
  taskId: string;
  mode: "shadow";
  /** The task's code files the request supplies, with the lines its content sets. */
  files: { path: string; kind: "file" | "diff"; lines: LineRange[] }[];
  /** Why no check ran on the copy; null when the checks ran. */
  skipped: string | null;
  checks: SuppliedCheckRun[];
  /** Some check reports a diagnostic on a supplied line: the request asks for both and cannot get both. */
  conflict: boolean;
}

/** Runs a check with `root` as the workspace (the scheduler's `CheckRunner.measure`). */
export type SuppliedCheckRunner = (
  check: Check,
  root: string,
) => Promise<{ status: "passed" | "failed" | "inconclusive"; output: string }>;

/** A rule id a linter prints with its message. */
const RULE =
  /\b(?:lint\/[\w-]+\/[\w-]+|[A-Z][A-Za-z]+\/[A-Z][A-Za-z0-9]+|[A-Z]{1,4}\d{2,4}|[a-z]+(?:-[a-z]+)+(?=\]|\)|$))\b/;
/** `path:3:5`, `path:3` or `path(3,5)` at the start of a diagnostic's line. */
const LOCATION = /^\s*(?:\S+?\.[A-Za-z0-9]+)(?::(\d+)|\((\d+),\d+\))/;

/** The rule id a diagnostic's text or line names, or null. */
export function diagnosticRule(text: string): string | null {
  return RULE.exec(text)?.[0] ?? null;
}

/** The diagnostics of a check's output on lines `files` sets, located from the check's directory. */
export function suppliedOffenses(
  output: string,
  root: string,
  cwd: string,
  files: readonly { path: string; lines: readonly LineRange[]; whole: boolean }[],
): SuppliedOffense[] {
  const out: SuppliedOffense[] = [];
  for (const d of relativeHeaded(output, root)) {
    // A tool prints paths from its own directory.
    const path = cwd === "." || d.path.startsWith("/") ? d.path : posix.join(cwd, d.path);
    const file = files.find((f) => f.path === path || path.endsWith(`/${f.path}`));
    if (!file) continue;
    const located = LOCATION.exec(d.line);
    const line = located ? Number(located[1] ?? located[2]) : null;
    // Without a line only a file the request gives whole is known to be the request's.
    if (line === null ? !file.whole : !file.lines.some(([a, b]) => line >= a && line <= b))
      continue;
    const offense = { path: file.path, line, rule: diagnosticRule(d.text) };
    if (!out.some((o) => o.path === offense.path && o.line === line && o.rule === offense.rule))
      out.push(offense);
  }
  return out.slice(0, OFFENSE_LIMIT);
}

const lf = (text: string) => text.replace(/\r\n/g, "\n");

/** The supplied content of a task's code writes: the text each file has once it is written in. */
async function suppliedContent(
  copy: string,
  request: string,
  task: Pick<Task, "writes">,
): Promise<
  | { files: { path: string; kind: "file" | "diff"; lines: LineRange[]; whole: boolean }[] }
  | { skipped: string }
> {
  const writes = task.writes.filter((w) => w.action !== "delete" && isCodePath(w.path));
  const blocks = suppliedBlocks(
    request,
    writes.map((w) => w.path),
  );
  const files: { path: string; kind: "file" | "diff"; lines: LineRange[]; whole: boolean }[] = [];
  for (const write of writes) {
    const supplied = blocks.get(write.path) ?? [];
    if (!supplied.length) continue;
    const target = join(copy, write.path);
    const before = existsSync(target) ? readFileSync(target, "utf8") : null;
    const diffs = supplied.flatMap((b) => (b.kind === "diff" ? [b.patch] : []));
    const [only] = supplied;
    if (supplied.length === 1 && only?.kind === "file") {
      // A block for a file that exists is an excerpt unless the prose says it is the whole file.
      if (before !== null && !only.whole) continue;
      writeFileSync(target, only.content);
    } else if (diffs.length === supplied.length) {
      const patch = join(copy, ".baked-supplied.patch");
      // Git for Windows sets core.autocrlf: the copy holds the request's bytes, not CRLF ones.
      const apply = async (text: string) => {
        writeFileSync(patch, text);
        return runGit(
          ["-c", "core.autocrlf=false", "apply", "--recount", "-p1", patch],
          copy,
          30_000,
        );
      };
      let applied = await apply(diffs.join(""));
      // A base with CRLF ends takes the request's LF diff with CRLF hunk lines, as host apply does.
      if (!applied.ok && before?.includes("\r\n")) applied = await apply(crlfPatch(diffs.join("")));
      removeScratch(patch);
      if (!applied.ok) return { skipped: `the diff for ${write.path} does not apply` };
    } else continue;
    const after = readFileSync(target, "utf8");
    files.push({
      path: write.path,
      kind: diffs.length ? "diff" : "file",
      // A CRLF base and the request's LF content differ on every line, not on the request's lines.
      lines: changedLineRanges(lf(before ?? ""), lf(after)),
      whole: before === null || !diffs.length,
    });
  }
  return { files };
}

/**
 * Runs the task's required file-local static checks on a copy of `root` with the request's
 * verbatim content for the task's code files written in. Null when the request supplies none of
 * them: nothing to check. `generated` are the policy's generated paths, left out of the copy.
 */
export async function suppliedCheckRecord(
  taskId: string,
  task: Pick<Task, "writes">,
  root: string,
  request: string,
  checks: readonly Check[],
  run: SuppliedCheckRunner,
  generated: string[] = [],
): Promise<SuppliedCheckRecord | null> {
  const paths = task.writes.filter((w) => w.action !== "delete" && isCodePath(w.path));
  const supplied = suppliedBlocks(
    request,
    paths.map((w) => w.path),
  );
  if (!paths.some((w) => supplied.has(w.path))) return null;
  const record = (
    files: SuppliedCheckRecord["files"],
    skipped: string | null,
    runs: SuppliedCheckRun[] = [],
  ): SuppliedCheckRecord => ({
    taskId,
    mode: "shadow",
    files,
    skipped,
    checks: runs,
    conflict: runs.some((r) => r.offenses.length > 0),
  });
  const statics = checks.filter(
    (c) => c.scope === "feature" && c.required && isStaticCheck(c) && !isTestCheck(c),
  );
  if (!statics.length) return record([], "no required static check covers the task's files");
  const copy = copyWorkspace(root, Object.keys(await sourceManifest(root, generated)));
  if (!copy) return record([], "the workspace is larger than the copy limit");
  try {
    const content = await suppliedContent(copy, request, task);
    if ("skipped" in content) return record([], content.skipped);
    const files = content.files.map(({ path, kind, lines }) => ({ path, kind, lines }));
    if (!files.length)
      return record([], "no supplied block is a whole file or a diff of the task's code");
    const runs: SuppliedCheckRun[] = [];
    for (const check of statics) {
      // A whole-unit tool resolves every module, so it fails on files later tasks write.
      if (isWholeUnitCheck(check)) {
        runs.push({ checkId: check.id, status: "skipped", reason: "whole-unit", offenses: [] });
        continue;
      }
      const result = await run(check, copy);
      runs.push({
        checkId: check.id,
        status: result.status,
        offenses:
          result.status === "failed"
            ? suppliedOffenses(result.output, copy, check.cwd ?? ".", content.files)
            : [],
      });
    }
    return record(files, null, runs);
  } finally {
    removeScratch(copy);
  }
}

/** The `spec_conflict` a record's conflict raises, naming the check, rule and line; null without one. */
export function suppliedCheckText(record: SuppliedCheckRecord): string | null {
  const failing = record.checks.filter((c) => c.offenses.length);
  if (!failing.length) return null;
  const where = failing
    .map(
      (c) =>
        `${c.checkId} at ${c.offenses
          .map(
            (o) => `${o.path}${o.line === null ? "" : `:${o.line}`}${o.rule ? ` (${o.rule})` : ""}`,
          )
          .join(", ")}`,
    )
    .join("; ");
  return `Supplied content fails the project's checks: ${where}. The request gives this content verbatim and requires the check to pass; no implementer can deliver both. Ask which one wins: the verbatim content, or the check (the content changed until it passes).`;
}

/** The run's recorded probes, latest per task, in task order. */
export function suppliedCheckRecords(
  store: Pick<WorkflowStore, "artifacts" | "readArtifact">,
  runId: string,
): SuppliedCheckRecord[] {
  const records = new Map<string, SuppliedCheckRecord>();
  for (const artifact of store.artifacts(runId)) {
    if (
      artifact.kind !== SUPPLIED_CHECK_KIND ||
      !artifact.logical_path.startsWith(SUPPLIED_CHECK_DIR)
    )
      continue;
    try {
      const record = JSON.parse(store.readArtifact(runId, artifact.id)) as SuppliedCheckRecord;
      records.set(record.taskId, record);
    } catch {}
  }
  return [...records.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
}

/** The recorded probes as `baked workflow status` prints them. */
export function suppliedCheckSummary(
  store: Pick<WorkflowStore, "artifacts" | "readArtifact">,
  runId: string,
): { taskId: string; conflict: boolean; skipped: string | null; finding: string | null }[] {
  return suppliedCheckRecords(store, runId).map((record) => ({
    taskId: record.taskId,
    conflict: record.conflict,
    skipped: record.skipped,
    finding: suppliedCheckText(record),
  }));
}
