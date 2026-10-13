import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRouteOverrides } from "../core/llm/model-routing.js";
import type { DoctorReport, PreRunRequest } from "../core/workflows/doctor.js";
import { type PreRunEstimate, rangeText, usdRangeText } from "../core/workflows/estimate.js";
import { BOLD, DIM, GREEN, RED, RST, YELLOW } from "./constants.js";
import type { WorkflowArgs } from "./workflow-parse.js";

/** The `doctor` / `estimate` request from command-line flags; `--policy` is read from `cwd`. */
export function preRunRequest(args: WorkflowArgs, cwd: string): PreRunRequest {
  const text = (name: string): string | undefined =>
    typeof args.flags[name] === "string" ? args.flags[name] : undefined;
  const workflowId = text("workflow") ?? args.positional[0];
  const policy = text("policy");
  const writers = text("writers");
  const candidates = text("candidates");
  const route = text("route");
  const confirmation = text("confirm-auto-approval");
  return {
    ...(workflowId ? { workflowId } : {}),
    ...(text("model") ? { model: text("model") } : {}),
    ...(route ? { routes: parseRouteOverrides(route) } : {}),
    ...(policy ? { policy: JSON.parse(readFileSync(resolve(cwd, policy), "utf8")) } : {}),
    ...(args.flags.worktree === true ? { worktree: true } : {}),
    ...(args.flags["model-strict"] === true ? { modelStrict: true } : {}),
    ...(writers ? { writers: Number(writers) } : {}),
    ...(candidates ? { candidates: Number(candidates) } : {}),
    ...(confirmation ? { autoApprovalConfirmation: confirmation } : {}),
  };
}

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i]?.length ?? 0))) ?? [];
  return rows
    .map((r) =>
      r
        .map((cell, i) => (i < r.length - 1 ? cell.padEnd(widths[i] ?? 0) : cell))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function formatEstimate(estimate: PreRunEstimate): string {
  const cost = (r: PreRunEstimate["costUsd"]): string => (r ? usdRangeText(r) : "-");
  const stages = table([
    ["STAGE", "TYPE", "TOKENS", "COST", "MODEL", "BASIS"],
    ...estimate.stages.map((s) => [
      s.stageId,
      s.type,
      s.tokens.high ? rangeText(s.tokens) : "0",
      cost(s.costUsd),
      s.models.join(", ") || "-",
      s.basis,
    ]),
  ]);
  const models = table([
    ["MODEL", "TOKENS", "COST", "PRICE", "STAGES"],
    ...estimate.models.map((m) => [
      m.model,
      rangeText(m.tokens),
      cost(m.costUsd),
      m.price,
      m.stages.join(", "),
    ]),
  ]);
  const budget = `Budget ${estimate.budget.maxTotalTokens.toLocaleString("en-US")} tokens: ${
    { yes: "fits", maybe: "may be exceeded", no: "will very likely be exceeded" }[
      estimate.budget.fits
    ]
  }`;
  const notes = estimate.notes.map((n) => `${DIM}${n}${RST}`).join("\n");
  return `${BOLD}${estimate.label}${RST}\n${budget}\n\n${stages}\n\n${models}\n${notes ? `\n${notes}\n` : ""}`;
}

export function formatDoctor(report: DoctorReport): string {
  const mark = {
    ok: `${GREEN()}ok  ${RST}`,
    warn: `${YELLOW()}warn${RST}`,
    fail: `${RED()}fail${RST}`,
    skip: `${DIM}skip${RST}`,
  };
  const lines = report.checks.map((c) => {
    const extra = [
      c.detail ? `       ${DIM}${c.detail}${RST}` : "",
      c.status !== "ok" && c.fix ? `       fix: ${c.fix}` : "",
    ].filter(Boolean);
    return [`${mark[c.status]}  ${c.title}`, ...extra].join("\n");
  });
  const verdict = report.ready
    ? `${GREEN()}Ready to run${RST}`
    : `${RED()}Not ready: fix the failed checks${RST}`;
  const estimate = report.estimate ? `\n${DIM}${report.estimate.label}${RST}` : "";
  return `${BOLD}Workflow ${report.workflowId}${RST}${report.runModel ? `, run model ${report.runModel}` : ""}\n\n${lines.join("\n")}\n\n${verdict}${estimate}\n`;
}
