/**
 * Proposes the workflow and budget for a request before a run starts (`--auto-preset`). Plain
 * rules on the request text, no model call: a review of existing changes, research without
 * changes, a failing check, a docs-only or small change, or a large change. The person sees the
 * proposal and its reason and may pick another workflow; the run records both.
 */
import { z } from "zod";
import { BUDGET_PRESETS, type BudgetPresetId } from "./budget.js";

export const REQUEST_KINDS = [
  "review",
  "research",
  "ci-fix",
  "docs",
  "small",
  "large",
  "default",
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export interface WorkflowProposal {
  workflowId: string;
  budget: BudgetPresetId;
  kind: RequestKind;
  /** high: a clear signal and its preset is available; low: no signal, the project default. */
  confidence: "high" | "medium" | "low";
  reason: string;
  /** The words of the request the rule matched. */
  signals: string[];
}

/** What a run started with `--auto-preset` records: the proposal and the workflow it ran. */
export const PresetChoiceSchema = z
  .object({
    proposed: z.string().min(1),
    chosen: z.string().min(1),
    overridden: z.boolean(),
    budget: z.enum(BUDGET_PRESETS),
    kind: z.enum(REQUEST_KINDS),
    confidence: z.enum(["high", "medium", "low"]),
    reason: z.string(),
  })
  .strict();
export type PresetChoice = z.infer<typeof PresetChoiceSchema>;

const CHANGE =
  /\b(add|adds|adding|implement|create|build|fix|fixes|change|update|write|refactor|remove|delete|rename|replace|support|migrate|introduce|make)\b/g;
const REVIEW = /\b(review|audit)\b/g;
const REVIEW_OBJECT = /\b(diff|pull request|pr|changes|branch|commits?|patch)\b/g;
const RESEARCH =
  /\b(investigate|research|explore|evaluate|compare|spike|feasibility|options for|find out|look into|analy[sz]e|assess|how (?:could|should|would|do|can) we)\b/g;
const CHECK = /\b(ci|pipeline|build|checks?|tests?|lint|typecheck|type check|workflow run)\b/g;
const BROKEN = /\b(fail|fails|failing|failed|failure|red|broken|breaks|breaking|flaky)\b/g;
const DOCS =
  /\b(readme|docs?|documentation|changelog|typos?|comments?|wording|spelling|docstrings?|guide)\b/g;
const CODE =
  /\b(api|endpoint|function|class|module|database|schema|command|flag|screen|component|ui)\b/g;
const SMALL =
  /\b(typos?|rename|bump|tweak|small|minor|one-line|one line|label|message|copy|constant|version)\b/g;
const LARGE =
  /\b(architecture|redesign|rewrite|migrate|migration|from scratch|end-to-end|new (?:service|app|application|system|module|subsystem)|several|multiple|across the (?:codebase|project))\b/g;

const matches = (text: string, pattern: RegExp): string[] => [
  ...new Set([...text.matchAll(pattern)].map((m) => m[0])),
];

/**
 * The proposal for `request`. `available` lists the workflows a run can start from now (without
 * validation problems); a preset that is missing there falls back to `defaultWorkflow`.
 */
export function proposeWorkflow(
  request: string,
  available: readonly string[],
  defaultWorkflow: string,
): WorkflowProposal {
  const text = request.toLowerCase().replace(/\s+/g, " ").trim();
  const words = text ? text.split(" ").length : 0;
  const change = matches(text, CHANGE);
  const pick = (
    preferred: readonly string[],
    kind: RequestKind,
    budget: BudgetPresetId,
    signals: string[],
    reason: string,
  ): WorkflowProposal => {
    const id = preferred.find((p) => available.includes(p));
    return id
      ? { workflowId: id, budget, kind, confidence: "high", reason, signals }
      : {
          workflowId: defaultWorkflow,
          budget,
          kind,
          confidence: "medium",
          reason: `${reason}; ${preferred.join(" and ")} cannot start here, so the project default`,
          signals,
        };
  };

  const review = matches(text, REVIEW);
  const reviewed = matches(text, REVIEW_OBJECT);
  if (review.length && reviewed.length && !change.length)
    return pick(
      ["review-only"],
      "review",
      "standard",
      [...review, ...reviewed],
      "a review of existing changes: no file changes",
    );
  const research = matches(text, RESEARCH);
  if (research.length && !change.length)
    return pick(
      ["spike"],
      "research",
      "standard",
      research,
      "research without a change: a written report",
    );
  const check = matches(text, CHECK);
  const broken = matches(text, BROKEN);
  if (check.length && broken.length)
    return pick(
      ["fix-ci"],
      "ci-fix",
      "standard",
      [...check, ...broken],
      "a failing check: reproduce it, fix and rerun the same checks",
    );
  const large = matches(text, LARGE);
  const docs = matches(text, DOCS);
  if (docs.length && !large.length && !matches(text, CODE).length && words <= 80)
    return pick(["quick"], "docs", "quick", docs, "a docs-only change: the quick preset");
  const small = matches(text, SMALL);
  if (small.length && !large.length && words <= 30)
    return pick(["quick"], "small", "quick", small, "a small change: the quick preset");
  if (large.length || words >= 150)
    return {
      workflowId: defaultWorkflow,
      budget: "extended",
      kind: "large",
      confidence: "medium",
      reason: `a large change${large.length ? "" : ` (${words} words)`}: the project default with the extended budget`,
      signals: large,
    };
  return {
    workflowId: defaultWorkflow,
    budget: "standard",
    kind: "default",
    confidence: "low",
    reason: "no strong signal: the project default",
    signals: [],
  };
}

const RISKY =
  /\b(delete|deletes|deleting|drop|migrat\w*|schema|database|auth\w*|security|secrets?|credentials?|payments?|billing|release|deploy\w*|production|prod|permissions?|encrypt\w*)\b/g;

/** How big and how risky a request looks, and how many parts it lists, from its text alone. */
export interface RequestAssessment {
  kind: RequestKind;
  size: "small" | "medium" | "large";
  /** high: it names data, security, release or deletion; medium: it changes code; low: read only. */
  risk: "low" | "medium" | "high";
  /** List items in the request (`- `, `* `, `1. `); two or more may run side by side. */
  parts: number;
  signals: string[];
}

/** The assessment the coordinator states before it proposes a workflow or parallel chats. */
export function assessRequest(request: string, proposal: WorkflowProposal): RequestAssessment {
  const text = request.toLowerCase().replace(/\s+/g, " ").trim();
  const risky = matches(text, RISKY);
  const reads = proposal.kind === "review" || proposal.kind === "research";
  const parts = request
    .split("\n")
    .filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line)).length;
  return {
    kind: proposal.kind,
    size:
      proposal.kind === "large" || parts >= 4
        ? "large"
        : (proposal.kind === "small" || proposal.kind === "docs") && parts < 2
          ? "small"
          : "medium",
    risk: reads ? "low" : risky.length ? "high" : "medium",
    parts,
    signals: [...proposal.signals, ...risky],
  };
}

/** The record of a run started with `--auto-preset`; `chosen` is the workflow the person kept. */
export function presetChoice(proposal: WorkflowProposal, chosen: string): PresetChoice {
  return {
    proposed: proposal.workflowId,
    chosen,
    overridden: chosen !== proposal.workflowId,
    budget: proposal.budget,
    kind: proposal.kind,
    confidence: proposal.confidence,
    reason: proposal.reason,
  };
}

/** One line for the CLI, the TUI form and the run report. */
export function describeProposal(proposal: WorkflowProposal): string {
  return `${proposal.workflowId} (${proposal.reason}; budget ${proposal.budget}; ${proposal.confidence} confidence)`;
}
