#!/usr/bin/env bun
/**
 * Runs bench suite tasks k times each through `baked workflow quick` and
 * prints a pass^k table. See .agents/skills/bench-suite/SKILL.md.
 *
 *   bun bench/suite/run.ts [--task ID ...] [--per-language] [--k N] [--model ID]
 *     [--max-tokens N] [--out DIR] [--previous summary.json] [--history nights.jsonl]
 *   bun bench/suite/run.ts --self-check [--task ID ...]
 *
 * --self-check runs no model: it checks that each task's hidden check fails on
 * the seed and passes on the seed with its reference solution copied over.
 */
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  drops,
  graduationCandidates,
  loadRegression,
  loadTasks,
  pickPerLanguage,
  renderTable,
  type SkippedTask,
  type SuiteTask,
  summarize,
  type TaskSummary,
  type TrialResult,
} from "./lib.ts";

const BOOT = resolve(import.meta.dir, "../../src/boot.tsx");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flags(name: string): string[] {
  return process.argv.flatMap((a, i) =>
    a === `--${name}` && process.argv[i + 1] ? [process.argv[i + 1] as string] : [],
  );
}

const k = Number(flag("k") ?? 3);
const model = flag("model") ?? "claude-code/haiku";
const maxTokens = Number(flag("max-tokens") ?? 1_500_000);
const day = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86_400_000);
const outDir = resolve(
  flag("out") ?? join("bench-suite-results", new Date().toISOString().slice(0, 10)),
);

interface RunStatus {
  runId: string;
  status: string;
  reason: string;
  revision: number;
  tokenUsage?: number;
  estimatedCostUsd?: number;
  worktree?: { path: string; present: boolean };
  stopDetail?: unknown;
  requests?: { id: string; kind: string; status: string; digest: string; body_json: string }[];
}

function baked(cwd: string, args: string[]): RunStatus | null {
  const p = Bun.spawnSync(["bun", "run", BOOT, "workflow", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = p.stdout.toString();
  const start = out.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(out.slice(start)) as RunStatus;
  } catch {
    return null;
  }
}

function prepare(task: SuiteTask): string {
  const ws = mkdtempSync(join(tmpdir(), `bench-suite-${task.id}-`));
  cpSync(join(task.dir, "seed"), ws, { recursive: true });
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=bench", "-c", "user.email=bench@localhost", ...args], {
      cwd: ws,
    });
  git("init", "-q");
  writeFileSync(join(ws, ".git", "info", "exclude"), ".baked/\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  mkdirSync(join(ws, ".baked"), { recursive: true });
  const checks = task.checks.map((c) => ({
    id: c.id,
    executable: c.executable,
    args: c.args,
    cwd: ".",
    timeoutMs: c.timeoutMs ?? 300_000,
    required: true,
    scope: "feature",
    envNames: [],
    writes: [],
    ...(c.fix ? { fix: c.fix } : {}),
  }));
  const policy = {
    maxTotalTokens: maxTokens,
    clarification: "assume",
    autoApproval: {
      renewal: true,
      limits: {
        maxTasks: 6,
        maxFiles: 12,
        allowedPaths: task.allowedPaths,
        allowDelete: false,
        allowNewDependencies: false,
        maxTotalTokens: maxTokens,
      },
    },
    checks,
  };
  writeFileSync(
    join(ws, ".baked", "config.json"),
    JSON.stringify({ workflows: { enabled: true, policy } }, null, 2),
  );
  return ws;
}

function planInScope(task: SuiteTask, body: string): boolean {
  const writes = (JSON.parse(body) as { writes?: { path: string }[] }).writes ?? [];
  const globs = task.allowedPaths.map((p) => new Bun.Glob(p));
  return writes.every((w) => globs.some((g) => g.match(w.path)));
}

function trial(task: SuiteTask, n: number): TrialResult {
  const ws = prepare(task);
  const result: TrialResult = {
    taskId: task.id,
    trial: n,
    runId: null,
    status: "error",
    passed: false,
    approvals: 0,
    interventions: 0,
    tokens: 0,
    costUsd: 0,
  };
  let status = baked(ws, [
    "quick",
    "--prompt-file",
    join(task.dir, "prompt.md"),
    "--budget",
    "quick",
    "--model",
    model,
    "--model-strict",
    "--worktree",
  ]);
  for (let step = 0; status && status.status === "waiting" && step < 6; step++) {
    const full = baked(ws, ["status", status.runId]) ?? status;
    const pending = full.requests?.find((r) => r.status === "pending");
    if (
      full.reason !== "approval" ||
      pending?.kind !== "approval" ||
      !planInScope(task, pending.body_json)
    )
      break;
    result.approvals++;
    status = baked(ws, [
      "approve",
      full.runId,
      "--request",
      pending.id,
      "--digest",
      pending.digest,
      "--expected-revision",
      String(full.revision),
    ]);
  }
  if (status) {
    const final = baked(ws, ["status", status.runId]) ?? status;
    result.runId = final.runId;
    result.status = final.status === "completed" ? "completed" : `${final.status}:${final.reason}`;
    result.tokens = final.tokenUsage ?? 0;
    result.costUsd = final.estimatedCostUsd ?? 0;
    if (final.status !== "completed") {
      result.interventions = 1;
      result.detail = JSON.stringify(final.stopDetail ?? null);
    } else if (final.worktree?.present) {
      const check = runCheck(task, join(ws, final.worktree.path));
      result.passed = check.exitCode === 0;
      if (!result.passed)
        result.detail = (check.stdout.toString() + check.stderr.toString()).slice(-2000);
    }
  }
  if (result.passed) rmSync(ws, { recursive: true, force: true });
  else result.detail = `${result.detail ?? ""}\nworkspace kept at ${ws}`.trim();
  return result;
}

const all = loadTasks();
const named = flags("task");
let selected = named.length > 0 ? all.filter((t) => named.includes(t.id)) : all;
if (process.argv.includes("--per-language")) selected = pickPerLanguage(selected, day);

const skipped: SkippedTask[] = [];
const runnable = selected.filter((task) => {
  const missing = task.requires.filter((exe) => !Bun.which(exe));
  if (missing.length > 0) skipped.push({ task, missing });
  return missing.length === 0;
});

function runCheck(task: SuiteTask, cwd: string) {
  return Bun.spawnSync(["bash", join(task.dir, "check.sh")], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 600_000,
  });
}

if (process.argv.includes("--self-check")) {
  let bad = 0;
  for (const task of runnable) {
    const ws = mkdtempSync(join(tmpdir(), `bench-suite-self-${task.id}-`));
    cpSync(join(task.dir, "seed"), ws, { recursive: true });
    const onSeed = runCheck(task, ws).exitCode;
    cpSync(join(task.dir, "solution"), ws, { recursive: true });
    const solved = runCheck(task, ws);
    const ok = onSeed !== 0 && solved.exitCode === 0;
    if (!ok) bad++;
    process.stdout.write(
      `${ok ? "ok  " : "FAIL"} ${task.id}: seed exit ${onSeed}, solution exit ${solved.exitCode}\n`,
    );
    if (solved.exitCode !== 0)
      process.stdout.write(
        `${(solved.stdout.toString() + solved.stderr.toString()).slice(-1500)}\n`,
      );
    rmSync(ws, { recursive: true, force: true });
  }
  for (const s of skipped) process.stdout.write(`skip ${s.task.id}: no ${s.missing.join(", ")}\n`);
  process.exit(bad > 0 ? 1 : 0);
}

mkdirSync(outDir, { recursive: true });
const results: TrialResult[] = [];
for (const task of runnable) {
  for (let n = 1; n <= k; n++) {
    const r = trial(task, n);
    results.push(r);
    appendFileSync(join(outDir, "results.jsonl"), `${JSON.stringify(r)}\n`);
    process.stderr.write(`${task.id} #${n}: ${r.status} passed=${r.passed} tokens=${r.tokens}\n`);
  }
}

const regression = loadRegression();
const summaries = summarize(runnable, results, k, regression);
const previousFile = flag("previous");
const previous = new Map<string, number>(
  previousFile && existsSync(previousFile)
    ? (JSON.parse(readFileSync(previousFile, "utf8")) as TaskSummary[]).map((s) => [
        s.taskId,
        s.passK,
      ])
    : [],
);
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summaries, null, 2));

let graduates: string[] = [];
const historyFile = flag("history");
if (historyFile) {
  appendFileSync(historyFile, `${JSON.stringify(summaries)}\n`);
  const nights = readFileSync(historyFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TaskSummary[]);
  graduates = graduationCandidates(nights, regression);
}

const report = [
  renderTable(summaries, skipped, k),
  "",
  ...drops(summaries, previous).map(
    (s) => `- Dropped: ${s.taskId} pass^${k} ${s.passK.toFixed(2)} (runs ${s.runIds.join(", ")})`,
  ),
  ...(graduates.length > 0 ? [`- Graduation candidates: ${graduates.join(", ")}`] : []),
].join("\n");
writeFileSync(join(outDir, "table.md"), `${report}\n`);
process.stdout.write(`${report}\n`);
