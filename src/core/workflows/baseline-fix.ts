import { posix } from "node:path";
import { diagnosticCount } from "../verification/output-counts.js";
import { relativeHeaded } from "../verification/task-end-check.js";

/**
 * A required check that already fails before any change, on files no task of the plan writes
 * (#2215). R70 namesound docs 55ca8f8b: rubocop failed at approval with three `[Correctable]`
 * offenses in spec/cmd/cli_spec.rb, a file of an accepted feature outside the docs plan, and the
 * check carried `fix: bundle exec rubocop -a`. Nothing acted on that at approval: the tasks spent
 * 1.03M tokens, and only the checks stage stopped the run on `baseline_failure`.
 *
 * At the check baseline, for each failing required check that lints or formats one file at a time
 * (not a test suite, not a whole-unit analyzer, whose errors may come from the files the plan
 * changes), the host reads the located findings of its output and decides:
 * - `none`: the findings are unread or incomplete (fewer than the tool's own summary count), a
 *   task of the plan writes one of the named files, so the plan may still repair it, or the checks
 *   stage passes the failure as static debt (`staticBaseline: "relative"`);
 * - `repair`: with `baselineFix: "on"`, every finding is marked correctable by the tool, the check
 *   has a `fix` and git tracks every named file: the host runs the fixer on those files before the
 *   first task, keeps the edit only when the check then passes, and measures the baseline again;
 * - `would_stop`: otherwise; the stop reason `baseline_unrepairable` records it (shadow).
 *
 * Each decision records its inputs as `baseline-fix/<check>.json` (kind `baseline-fix`, kept in
 * bench traces, no prose) and `replayBaselineFailures` (`trace.ts`) decides it again; a repair adds
 * `baseline-fix/<check>-repair.json` with what the fixer changed and whether the check passed.
 */
export const BASELINE_FIX_KIND = "baseline-fix";
export const BASELINE_FIX_DIR = "baseline-fix/";

export const baselineFixPath = (checkId: string): string => `${BASELINE_FIX_DIR}${checkId}.json`;
export const baselineRepairPath = (checkId: string): string =>
  `${BASELINE_FIX_DIR}${checkId}-repair.json`;

/**
 * The marks a linter prints on a finding its own fixer corrects. A tool whose findings carry no
 * such mark is never repaired by the host; its findings count as not correctable.
 */
export const CORRECTABLE_MARKERS: readonly { tool: string; marker: RegExp }[] = [
  // `spec/a_spec.rb:3:5: C: [Correctable] Style/StringLiterals: ...`
  { tool: "rubocop", marker: /\[Correctable\]/ },
  // `src/a.py:1:8: F401 [*] \`os\` imported but unused` (concise) or the header of the full form.
  { tool: "ruff", marker: /\b[A-Z]{1,4}\d{2,4}\s+\[\*\]\s/ },
  // `src/a.ts:3:7 lint/style/useConst FIXABLE ━━━`
  { tool: "biome", marker: /\sFIXABLE\s/ },
];

/** RuboCop's summary: `5 files inspected, 3 offenses detected, 3 offenses autocorrectable`. */
const RUBOCOP_SUMMARY = /\b\d+ files? inspected, (\d+|no) offenses? detected\b/;

/** What a baseline failure decision reads. */
export interface BaselineFailureInput {
  /** The check lints or formats one file at a time: static, not a test suite, not whole-unit. */
  fileLocal: boolean;
  /** The check has a `fix` command. */
  fix: boolean;
  /** Located findings in the failing output. */
  findings: number;
  /** The findings account for the tool's own summary count, so none hides from the parser. */
  complete: boolean;
  /** Findings the tool marks as correctable by its fixer. */
  correctable: number;
  /** Named files that a task of the plan writes. */
  planned: number;
  /** Named files git does not track. */
  untracked: number;
  /** `baselineFix: "on"`. */
  enabled: boolean;
  /**
   * The checks stage passes the failure as static debt anyway (`staticBaseline: "relative"` with
   * the debt recorded and a summary count to hold it to, #1222). Absent in older records.
   */
  exempt?: boolean;
}

export type BaselineFailureDecision = "none" | "repair" | "would_stop";

/** What `baseline-fix/<check>.json` records. */
export interface BaselineFailureRecord extends BaselineFailureInput {
  checkId: string;
  /** The files the findings name, workspace-relative. */
  files: string[];
  decision: BaselineFailureDecision;
  /** Decided again on the base a planned-ahead run was released onto (#2228). */
  release?: boolean;
}

/** What `baseline-fix/<check>-repair.json` records. */
export interface BaselineRepairRecord {
  checkId: string;
  files: string[];
  /** The fixer changed a file. */
  changed: boolean;
  /** The check passed after the fixer ran. */
  passed: boolean;
  /** The fixer's edits stay; otherwise the files were put back. */
  kept: boolean;
}

export type BaselineFailureRule = (input: BaselineFailureInput) => BaselineFailureDecision;

/** The one rule over the recorded inputs. */
export const baselineFailureDecision: BaselineFailureRule = (input) => {
  if (input.exempt || !input.fileLocal || !input.findings || !input.complete || input.planned > 0)
    return "none";
  return input.enabled && input.fix && input.correctable === input.findings && input.untracked === 0
    ? "repair"
    : "would_stop";
};

/** The located findings of a failing check's output in `root`, read for the decision. */
export function baselineFindings(
  output: string,
  root: string,
  cwd: string,
): { files: string[]; findings: number; correctable: number; complete: boolean } {
  const found = relativeHeaded(output, root).map((d) => ({
    ...d,
    // A tool prints paths from its own directory.
    path:
      cwd === "." || d.path.startsWith("/") || /^[A-Za-z]:\//.test(d.path)
        ? d.path
        : posix.join(cwd, d.path),
  }));
  const rubocop = RUBOCOP_SUMMARY.exec(output)?.[1];
  const summary =
    rubocop !== undefined
      ? rubocop === "no"
        ? 0
        : Number(rubocop)
      : (diagnosticCount(output)?.count ?? null);
  return {
    files: [...new Set(found.map((d) => d.path))].sort(),
    findings: found.length,
    correctable: found.filter((d) => CORRECTABLE_MARKERS.some((m) => m.marker.test(d.line))).length,
    complete: summary !== null && found.length >= summary,
  };
}
