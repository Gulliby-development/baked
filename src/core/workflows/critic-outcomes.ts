/**
 * The late outcomes of the critic outcome log (#646 step 2): what happened to a run's delivered
 * commit and how many of the lines its tasks added are still in the project. The scores and the
 * early labels (task checks, acceptance) are written by the scheduler and the store as the run
 * goes; these need Git and time, so they are refreshed on demand and before each new run.
 */
import { existsSync, readFileSync } from "node:fs";
import { workspacePath } from "../specs/validate.js";
import { type CriticCalibration, calibrateCritic } from "./critic-calibration.js";
import { git } from "./delivery-git.js";
import type { CriticOutcomeRow, WorkflowStore } from "./store.js";

/** Days after a run completed when the survival of its lines is final. */
export const SURVIVAL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Lines a unified patch adds, by file; blank lines and the patch headers are left out. */
export function addedLines(patch: string): Map<string, string[]> {
  const files = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      current = target === "/dev/null" ? null : [];
      if (current) files.set(target.replace(/^b\//, ""), current);
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (current && line.startsWith("+") && line.slice(1).trim()) current.push(line.slice(1).trim());
  }
  return files;
}

/**
 * The share of added lines that the files hold now, compared by trimmed text, or null when the
 * patch adds none. A line moved within its file still counts; a deleted file counts as gone.
 */
export function lineSurvival(
  added: Map<string, string[]>,
  read: (path: string) => string | null,
): number | null {
  let total = 0;
  let kept = 0;
  for (const [path, lines] of added) {
    if (!lines.length) continue;
    const now = new Set((read(path) ?? "").split("\n").map((l) => l.trim()));
    total += lines.length;
    kept += lines.filter((l) => now.has(l)).length;
  }
  return total ? kept / total : null;
}

/** When the run completed, from its events; null when it did not. */
function completedAt(store: WorkflowStore, runId: string): number | null {
  let after = 0;
  for (;;) {
    const page = store.events(runId, after, 500);
    if (!page.length) return null;
    const done = page.find(
      (e) => e.type === "run.state_changed" && (e.payload as { to?: string }).to === "completed",
    );
    if (done) return Date.parse(done.at);
    after = page.at(-1)?.seq ?? after;
    if (page.length < 500) return null;
  }
}

/** The fate of a delivered commit on the branch it was proposed for, or null without Git. */
async function deliveryOf(
  store: WorkflowStore,
  runId: string,
): Promise<CriticOutcomeRow["delivery"] | undefined> {
  const result = store
    .artifacts(runId)
    .filter((a) => a.kind === "delivery")
    .at(-1);
  if (!result) return undefined;
  const body = JSON.parse(store.readArtifact(runId, result.id)) as {
    planId: string;
    commit: string | null;
  };
  const plan = store.latestArtifact(runId, `delivery/${body.planId}/plan.json`);
  if (!body.commit || !plan) return undefined;
  const base = (JSON.parse(store.readArtifact(runId, plan.id)) as { base?: { branch?: string } })
    .base?.branch;
  if (!base) return undefined;
  const workspace = store.workspace;
  const reverts = await git(workspace, [
    "log",
    base,
    "--format=%H",
    `--grep=This reverts commit ${body.commit}`,
  ]);
  if (reverts.code === 0 && reverts.stdout.trim()) return "reverted";
  const merged = await git(workspace, ["merge-base", "--is-ancestor", body.commit, base]);
  if (merged.code === 0) return "merged";
  return merged.code === 1 ? "open" : undefined;
}

/**
 * Fills the delivery and survival labels of every completed run whose survival is not final yet.
 * Errors of one run (a missing commit, no Git) leave its labels as they were.
 */
export async function refreshCriticOutcomes(
  store: WorkflowStore,
  now = Date.now(),
): Promise<{ runs: number }> {
  const pending = [
    ...new Set(
      store
        .criticOutcomes()
        .filter((r) => !r.survival_final && r.acceptance === "accepted")
        .map((r) => r.run_id),
    ),
  ];
  let runs = 0;
  for (const runId of pending) {
    let done: number | null;
    try {
      done = completedAt(store, runId);
    } catch {
      continue; // The run was removed; its scores stay as they are.
    }
    if (done === null) continue;
    const delivery = await deliveryOf(store, runId).catch(() => undefined);
    if (delivery !== undefined) store.criticLateOutcome(runId, null, { delivery });
    const final = now - done >= SURVIVAL_DAYS * DAY_MS;
    const tasks = new Set(
      store
        .criticOutcomes(runId)
        .filter((r) => !r.survival_final)
        .map((r) => r.task_id),
    );
    for (const taskId of tasks) {
      const diff = store.latestArtifact(runId, `tasks/${taskId}/diff.json`);
      if (!diff) continue;
      const patch = (JSON.parse(store.readArtifact(runId, diff.id)) as { patch?: string }).patch;
      const survival = lineSurvival(addedLines(patch ?? ""), (path) => {
        const file = workspacePath(store.workspace, path);
        return existsSync(file) ? readFileSync(file, "utf8") : null;
      });
      if (survival !== null) store.criticLateOutcome(runId, taskId, { survival, final });
    }
    runs += 1;
  }
  return { runs };
}

export interface CriticOutcomeView {
  runId: string;
  taskId: string;
  attempt: number;
  model: string | null;
  score: number;
  taskResult: CriticOutcomeRow["task_result"];
  acceptance: CriticOutcomeRow["acceptance"];
  delivery: CriticOutcomeRow["delivery"];
  survival: number | null;
  survivalFinal: boolean;
}
export interface CriticOutcomes {
  /** Mean critic score per label; null where no attempt has the label. */
  summary: {
    scored: number;
    passed: { count: number; meanScore: number | null };
    repaired: { count: number; meanScore: number | null };
    accepted: number;
    rejected: number;
    merged: number;
    reverted: number;
    /** Mean final survival of the attempts whose survival is final. */
    meanSurvival: number | null;
  };
  /** Whether `select` and `earlyStop` may decide, from the whole log. */
  calibration: CriticCalibration;
  criticOutcomes: CriticOutcomeView[];
}

const mean = (values: number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

/** The outcome log as the CLI, the TUI and the bench loop read it. */
export function criticOutcomesView(store: WorkflowStore, runId?: string): CriticOutcomes {
  const rows = store.criticOutcomes(runId);
  const by = (result: "passed" | "repaired") => {
    const scores = rows.filter((r) => r.task_result === result).map((r) => r.score);
    return { count: scores.length, meanScore: mean(scores) };
  };
  const count = (pick: (r: CriticOutcomeRow) => boolean) => rows.filter(pick).length;
  return {
    summary: {
      scored: rows.length,
      passed: by("passed"),
      repaired: by("repaired"),
      accepted: count((r) => r.acceptance === "accepted"),
      rejected: count((r) => r.acceptance === "rejected"),
      merged: count((r) => r.delivery === "merged"),
      reverted: count((r) => r.delivery === "reverted"),
      meanSurvival: mean(
        rows.filter((r) => r.survival_final && r.survival !== null).map((r) => r.survival ?? 0),
      ),
    },
    calibration: calibrateCritic(runId ? store.criticOutcomes() : rows),
    criticOutcomes: rows.map((r) => ({
      runId: r.run_id,
      taskId: r.task_id,
      attempt: r.attempt,
      model: r.model,
      score: r.score,
      taskResult: r.task_result,
      acceptance: r.acceptance,
      delivery: r.delivery,
      survival: r.survival,
      survivalFinal: r.survival_final === 1,
    })),
  };
}

const fixed = (value: number | null, digits = 2) => (value === null ? "-" : value.toFixed(digits));

/** Plain text of the outcome log: the summary, then one line per scored attempt (newest last). */
export function formatCriticOutcomes(view: CriticOutcomes, limit = 30): string {
  const s = view.summary;
  const lines = [
    `Critic outcome log: ${s.scored} scored attempt(s).`,
    `Task checks passed: ${s.passed.count} (mean score ${fixed(s.passed.meanScore)}); repaired: ${s.repaired.count} (mean score ${fixed(s.repaired.meanScore)}).`,
    `Runs accepted: ${s.accepted}, rejected: ${s.rejected}; delivered and merged: ${s.merged}, reverted: ${s.reverted}; mean ${SURVIVAL_DAYS}-day line survival: ${s.meanSurvival === null ? "-" : `${Math.round(s.meanSurvival * 100)}%`}.`,
  ];
  const c = view.calibration;
  lines.push(
    c.calibrated
      ? `Calibrated on ${c.samples} labelled attempts (AUC ${(c.auc ?? 0).toFixed(2)}): select and earlyStop decide at score ${fixed(c.threshold)}.`
      : `Not calibrated (${c.reason}): select and earlyStop act like advise.`,
  );
  const rows = view.criticOutcomes.slice(-limit);
  if (rows.length)
    lines.push("", "RUN       TASK  #  SCORE  CHECKS    RUN END   DELIVERY  SURVIVAL");
  for (const r of rows)
    lines.push(
      [
        r.runId.slice(0, 8),
        r.taskId.padEnd(5),
        String(r.attempt).padEnd(2),
        fixed(r.score).padEnd(6),
        (r.taskResult ?? "-").padEnd(9),
        (r.acceptance ?? "-").padEnd(9),
        (r.delivery ?? "-").padEnd(9),
        r.survival === null
          ? "-"
          : `${Math.round(r.survival * 100)}%${r.survivalFinal ? "" : " so far"}`,
      ].join(" "),
    );
  return `${lines.join("\n")}\n`;
}
