/**
 * The anti-slop rule pack (#639): patterns agents leave behind that pass tests but hide
 * failures (empty catch blocks, a catch that returns a default, swallowed Python exceptions,
 * ignored Go errors), new suppressions (`@ts-expect-error`, `eslint-disable`, `# noqa`, `#[allow]`,
 * `//nolint`), `unwrap` in Rust library code and placeholder bodies. The host checks the lines
 * the run added in each checks stage. An `error` rule is a blocking finding that names the rule;
 * a `warning` is a note in the run report. The pack is always on; a project disables single
 * rules, changes their severity and adds ast-grep rule files of its own.
 */
import { spawnSync } from "node:child_process";
import { extname } from "node:path";
import { workspacePath } from "../../specs/validate.js";
import { BUILTIN_RULES, type RuleSeverity } from "./builtin-rules.js";
import { isTestCodePath } from "./duplication.js";

export {
  BUILTIN_RULE_IDS,
  BUILTIN_RULES,
  type QualityRule,
  type RuleSeverity,
} from "./builtin-rules.js";

/** The rule choices of a `quality` config block as a policy field, or undefined for none. */
export function configuredRules(
  quality:
    | {
        disabledRules?: string[] | undefined;
        ruleSeverity?: Record<string, RuleSeverity> | undefined;
        ruleFiles?: string[] | undefined;
      }
    | undefined,
): RuleSettings | undefined {
  const out: { disabled?: string[]; severity?: Record<string, RuleSeverity>; files?: string[] } =
    {};
  if (quality?.disabledRules?.length) out.disabled = [...quality.disabledRules];
  if (quality?.ruleSeverity && Object.keys(quality.ruleSeverity).length)
    out.severity = { ...quality.ruleSeverity };
  if (quality?.ruleFiles?.length) out.files = [...quality.ruleFiles];
  return Object.keys(out).length ? out : undefined;
}

/** Artifact of the latest rule check of a run. */
export const QUALITY_RULES = "quality/rules.json";
/** The planned code files as they were at approval: the rule pack's baseline. */
export const QUALITY_BASELINE_FILES = "quality/baseline-files.json";
/** Whether a finding's claim is one the rule pack made, so a clean check closes it. */
export const ruleClaim = (claim: unknown): boolean =>
  typeof claim === "string" && /^Rule [\w.-]+: /.test(claim);

/** The project's choices, as frozen in the run policy. */
export interface RuleSettings {
  /** Rules that do not run (built-in or ast-grep rule IDs). */
  disabled?: readonly string[] | undefined;
  /** Severity per rule ID, built-in or ast-grep. */
  severity?: Readonly<Record<string, RuleSeverity>> | undefined;
  /** ast-grep rule files, relative to the workspace. */
  files?: readonly string[] | undefined;
}

export interface RuleFinding {
  rule: string;
  severity: RuleSeverity;
  file: string;
  /** 1-based line of the match. */
  line: number;
  text: string;
  message: string;
  fix: string;
  /** Whether it blocks: an `error` on lines the run added to a file whose baseline is known. */
  blocking: boolean;
  source: "builtin" | "ast-grep";
}

export interface RulesResult {
  schemaVersion: 1;
  findings: RuleFinding[];
  disabled: string[];
  /** ast-grep rule files: run, or why not. */
  astGrep: { files: string[]; ran: boolean; note?: string } | null;
}

export interface ChangedFile {
  path: string;
  content: string;
  /** The file at baseline: null when the run created it, undefined when it is not known. */
  before: string | null | undefined;
}

/**
 * The 0-based lines of `after` the run added. Lines are matched as a multiset of trimmed text,
 * so moved lines are not new. A file whose baseline is unknown counts every line as new.
 */
export function addedLines(before: string | null | undefined, after: string): Set<number> {
  const lines = after.split("\n");
  if (!before) return new Set(lines.map((_, i) => i));
  const pool = new Map<string, number>();
  for (const line of before.split("\n")) {
    const key = line.trim();
    pool.set(key, (pool.get(key) ?? 0) + 1);
  }
  const added = new Set<number>();
  lines.forEach((line, i) => {
    const key = line.trim();
    const left = pool.get(key) ?? 0;
    if (left > 0) pool.set(key, left - 1);
    else added.add(i);
  });
  return added;
}

const severityOf = (settings: RuleSettings, id: string, fallback: RuleSeverity): RuleSeverity =>
  settings.severity?.[id] ?? fallback;

/** Runs the built-in rules over the lines the run added. */
export function checkBuiltinRules(files: ChangedFile[], settings: RuleSettings): RuleFinding[] {
  const disabled = new Set(settings.disabled ?? []);
  const out: RuleFinding[] = [];
  for (const file of files) {
    const ext = extname(file.path).toLowerCase();
    const test = isTestCodePath(file.path);
    const lines = file.content.split("\n");
    const added = addedLines(file.before, file.content);
    if (!added.size) continue;
    for (const rule of BUILTIN_RULES) {
      if (disabled.has(rule.id) || (test && !rule.inTests)) continue;
      if (rule.extensions.length && !rule.extensions.includes(ext)) continue;
      for (let i = 0; i < lines.length; i++) {
        const span = rule.match(lines, i);
        if (!span?.some((line) => added.has(line))) continue;
        const severity = severityOf(settings, rule.id, rule.severity);
        out.push({
          rule: rule.id,
          severity,
          file: file.path,
          line: i + 1,
          text: (lines[i] ?? "").trim().slice(0, 200),
          message: rule.message,
          fix: rule.fix,
          blocking: severity === "error" && file.before !== undefined,
          source: "builtin",
        });
      }
    }
  }
  return out;
}

// --- ast-grep -------------------------------------------------------------------------------

/** The ast-grep executable on this machine, or null. `sg` alone is often another program. */
export function astGrepExecutable(): string | null {
  for (const name of ["ast-grep", "sg"]) {
    const probe = spawnSync(name, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (probe.status === 0 && /ast-grep/i.test(`${probe.stdout}${probe.stderr}`)) return name;
  }
  return null;
}

interface AstGrepMatch {
  file?: string;
  ruleId?: string;
  severity?: string;
  message?: string;
  note?: string | null;
  lines?: string;
  range?: { start?: { line?: number } };
}

/**
 * Runs the project's ast-grep rule files on the changed files and keeps the matches on lines
 * the run added. Without ast-grep the files are listed as not run, which never blocks.
 */
export function checkAstGrepRules(
  root: string,
  files: ChangedFile[],
  settings: RuleSettings,
  executable: string | null = astGrepExecutable(),
): { findings: RuleFinding[]; astGrep: RulesResult["astGrep"] } {
  const ruleFiles = [...(settings.files ?? [])];
  if (!ruleFiles.length) return { findings: [], astGrep: null };
  if (!executable)
    return {
      findings: [],
      astGrep: { files: ruleFiles, ran: false, note: "ast-grep is not installed" },
    };
  const disabled = new Set(settings.disabled ?? []);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const added = new Map(files.map((f) => [f.path, addedLines(f.before, f.content)]));
  const out: RuleFinding[] = [];
  const notes: string[] = [];
  for (const ruleFile of ruleFiles) {
    const result = spawnSync(
      executable,
      ["scan", "--rule", workspacePath(root, ruleFile), "--json=compact", ...byPath.keys()],
      { cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
    );
    let matches: AstGrepMatch[];
    try {
      matches = JSON.parse(result.stdout || "[]") as AstGrepMatch[];
    } catch {
      notes.push(`${ruleFile}: ${(result.stderr || "no JSON output").trim().slice(0, 200)}`);
      continue;
    }
    for (const match of matches) {
      const path = (match.file ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
      const file = byPath.get(path);
      const line = match.range?.start?.line ?? -1;
      const id = match.ruleId ?? ruleFile;
      if (!file || disabled.has(id) || !added.get(path)?.has(line)) continue;
      const severity = severityOf(settings, id, match.severity === "error" ? "error" : "warning");
      out.push({
        rule: id,
        severity,
        file: path,
        line: line + 1,
        text: (match.lines ?? "").trim().split("\n")[0]?.slice(0, 200) ?? "",
        message: match.message ?? id,
        fix: match.note ?? "Change the code so the rule no longer matches.",
        blocking: severity === "error" && file.before !== undefined,
        source: "ast-grep",
      });
    }
  }
  return {
    findings: out,
    astGrep: { files: ruleFiles, ran: true, ...(notes.length ? { note: notes.join("; ") } : {}) },
  };
}

/** The whole pack: built-in rules, then the project's ast-grep files. */
export function checkQualityRules(
  root: string,
  files: ChangedFile[],
  settings: RuleSettings,
  executable?: string | null,
): RulesResult {
  const astGrep = checkAstGrepRules(root, files, settings, executable);
  return {
    schemaVersion: 1,
    findings: [...checkBuiltinRules(files, settings), ...astGrep.findings],
    disabled: [...(settings.disabled ?? [])],
    astGrep: astGrep.astGrep,
  };
}
