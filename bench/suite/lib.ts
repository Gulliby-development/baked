import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A check the run's own gates execute, in the shape of `workflows.policy.checks`. */
export interface SuiteCheck {
  id: string;
  executable: string;
  args: string[];
  timeoutMs?: number;
  fix?: { executable: string; args: string[] };
}

export interface SuiteTask {
  id: string;
  /** Language family the task counts for in the per-language table. */
  language: string;
  /** Toolchain within the language (bun, npm, pytest, maven, gradle, ...). */
  toolchain: string;
  /** Executables that must be on PATH; the runner skips the task without them. */
  requires: string[];
  /** Paths the plan may write; a plan writing elsewhere is an unplanned intervention. */
  allowedPaths: string[];
  checks: SuiteCheck[];
  /** Issue the task was rebuilt from, when it reproduces a past stop. */
  origin?: string;
  /**
   * Policy fields the run gets on top of the runner's, for a task that measures an opt-in host
   * behavior (`{ "chainRewrite": "on" }`, #1981). Only `POLICY_FIELDS` are allowed.
   */
  policy?: Record<string, unknown>;
  dir: string;
}

export interface TrialResult {
  taskId: string;
  trial: number;
  runId: string | null;
  /** Final workflow status, or `skipped` / `error` when the runner could not run it. */
  status: string;
  /** The hidden check passed on the finished workspace. */
  passed: boolean;
  /** Plan approvals the runner gave inside `allowedPaths` (planned, not interventions). */
  approvals: number;
  /** Stops a person would have had to handle: an out-of-scope plan, a budget stop, a block. */
  interventions: number;
  tokens: number;
  costUsd: number;
  detail?: string;
}

export interface TaskSummary {
  taskId: string;
  language: string;
  trials: number;
  passes: number;
  passK: number;
  interventionsPerRun: number;
  tokensPerRun: number;
  costPerRun: number;
  regression: boolean;
  runIds: string[];
}

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Opt-in policy fields a task may set; the runner owns budgets, approval and checks. */
export const POLICY_FIELDS: Readonly<Record<string, readonly unknown[]>> = {
  chainRewrite: ["on"],
  chainProbe: ["on"],
  defectClasses: ["on"],
};

export function suiteRoot(): string {
  return import.meta.dir;
}

/** Problems with one task directory; an empty list means the task is well-formed. */
export function validateTask(dir: string, raw: unknown): string[] {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object") return ["task.json is not an object"];
  const t = raw as Record<string, unknown>;
  const name = dir.split(/[\\/]/).pop() ?? "";
  if (typeof t.id !== "string" || !ID.test(t.id))
    problems.push("id must be lowercase words joined by hyphens");
  else if (t.id !== name) problems.push(`id ${t.id} does not match directory ${name}`);
  for (const key of ["language", "toolchain"]) {
    if (typeof t[key] !== "string" || !(t[key] as string)) problems.push(`${key} is required`);
  }
  for (const key of ["requires", "allowedPaths"]) {
    const v = t[key];
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x)) {
      problems.push(`${key} must be a non-empty list of strings`);
    }
  }
  if (!Array.isArray(t.checks) || t.checks.length === 0)
    problems.push("checks must list at least one check");
  else {
    for (const c of t.checks as Record<string, unknown>[]) {
      if (typeof c?.id !== "string" || typeof c.executable !== "string" || !Array.isArray(c.args)) {
        problems.push("each check needs id, executable and args");
      }
    }
  }
  if (t.origin !== undefined && (typeof t.origin !== "string" || !/^#\d+$/.test(t.origin))) {
    problems.push("origin must look like #N");
  }
  if (t.policy !== undefined) {
    if (!t.policy || typeof t.policy !== "object" || Array.isArray(t.policy))
      problems.push("policy must be an object");
    else
      for (const [key, value] of Object.entries(t.policy as Record<string, unknown>))
        if (!POLICY_FIELDS[key]?.includes(value))
          problems.push(`policy.${key} is not an opt-in field the suite allows`);
  }
  for (const file of ["prompt.md", "check.sh"]) {
    if (!existsSync(join(dir, file))) problems.push(`${file} is missing`);
  }
  for (const sub of ["seed", "solution"]) {
    if (!existsSync(join(dir, sub))) problems.push(`${sub}/ is missing`);
    else if (readdirSync(join(dir, sub)).length === 0) problems.push(`${sub}/ is empty`);
  }
  return problems;
}

export function loadTasks(root = suiteRoot()): SuiteTask[] {
  const tasksDir = join(root, "tasks");
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = join(tasksDir, e.name);
      const raw = JSON.parse(readFileSync(join(dir, "task.json"), "utf8")) as Omit<
        SuiteTask,
        "dir"
      >;
      return { ...raw, dir };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function loadRegression(root = suiteRoot()): string[] {
  const file = join(root, "regression.json");
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, "utf8")) as { tasks?: string[] };
  return data.tasks ?? [];
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/**
 * Unbiased pass^k estimate from n trials with c passes: the chance that k
 * trials drawn from them all pass, C(c, k) / C(n, k). With n = k it is 1 when
 * every trial passed and 0 otherwise.
 */
export function passHatK(n: number, c: number, k: number): number {
  if (n <= 0 || k <= 0 || k > n) return 0;
  return choose(c, k) / choose(n, k);
}

/** One task per language, rotating through each language's tasks by `seed` (the day of year). */
export function pickPerLanguage(tasks: SuiteTask[], seed: number): SuiteTask[] {
  const byLanguage = new Map<string, SuiteTask[]>();
  for (const t of tasks) byLanguage.set(t.language, [...(byLanguage.get(t.language) ?? []), t]);
  return [...byLanguage.keys()].sort().map((lang) => {
    const list = byLanguage.get(lang) ?? [];
    return list[seed % list.length] as SuiteTask;
  });
}

export function summarize(
  tasks: SuiteTask[],
  results: TrialResult[],
  k: number,
  regression: string[],
): TaskSummary[] {
  const out: TaskSummary[] = [];
  for (const task of tasks) {
    const rs = results.filter((r) => r.taskId === task.id && r.status !== "skipped");
    if (rs.length === 0) continue;
    const passes = rs.filter((r) => r.passed).length;
    const sum = (f: (r: TrialResult) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
    out.push({
      taskId: task.id,
      language: task.language,
      trials: rs.length,
      passes,
      passK: passHatK(rs.length, passes, Math.min(k, rs.length)),
      interventionsPerRun: sum((r) => r.interventions),
      tokensPerRun: Math.round(sum((r) => r.tokens)),
      costPerRun: sum((r) => r.costUsd),
      regression: regression.includes(task.id),
      runIds: rs.flatMap((r) => (r.runId ? [r.runId] : [])),
    });
  }
  return out;
}

/** Tasks to report: a regression task below 100%, or a capability task whose pass^k fell from 1. */
export function drops(summaries: TaskSummary[], previous: Map<string, number>): TaskSummary[] {
  return summaries.filter((s) => s.passK < 1 && (s.regression || previous.get(s.taskId) === 1));
}

/** Capability tasks with pass^k = 1 on each of the last `nights` recorded nights. */
export function graduationCandidates(
  history: TaskSummary[][],
  regression: string[],
  nights = 5,
): string[] {
  const recent = history.slice(-nights);
  if (recent.length < nights) return [];
  const ids = new Set(recent.flatMap((night) => night.map((s) => s.taskId)));
  return [...ids]
    .filter((id) => !regression.includes(id))
    .filter((id) => recent.every((night) => night.find((s) => s.taskId === id)?.passK === 1))
    .sort();
}

export interface SkippedTask {
  task: SuiteTask;
  missing: string[];
}

export function renderTable(summaries: TaskSummary[], skipped: SkippedTask[], k: number): string {
  const lines = [
    `| Task | Language | pass^${k} | Passed | Interventions/run | Tokens/run | Cost/run |`,
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const s of summaries) {
    const name = s.regression ? `${s.taskId} (regression)` : s.taskId;
    lines.push(
      `| ${name} | ${s.language} | ${s.passK.toFixed(2)} | ${s.passes}/${s.trials} | ${s.interventionsPerRun.toFixed(1)} | ${s.tokensPerRun.toLocaleString("en-US")} | $${s.costPerRun.toFixed(2)} |`,
    );
  }
  for (const s of skipped) {
    lines.push(
      `| ${s.task.id} | ${s.task.language} | skipped | no ${s.missing.join(", ")} | | | |`,
    );
  }
  return lines.join("\n");
}
