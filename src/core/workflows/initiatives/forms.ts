/**
 * Input shared by every front end that starts or edits an initiative: the start request with the
 * project's defaults, a suggested initiative ID, and the short text forms the terminal UI reads
 * for split parts and budget limits. The service stays the authority on what it accepts.
 */
import { z } from "zod";
import type { AppConfig } from "../../../types/index.js";
import { defaultWorkflowPolicy } from "../defaults.js";
import { WorkflowFault } from "../errors.js";
import { featureSlug } from "../feature-id.js";
import { PolicySchema, SafeId } from "../schemas.js";
import { IssueSourceSchema } from "../types.js";
import { FeatureKey, InitiativeId, InitiativePlanSchema } from "./plan.js";
import type { CostView, FeatureView, InitiativeStartRequest, InitiativeView } from "./service.js";
import { type BudgetLimitsValue, CostToleranceSchema } from "./store.js";

const PositiveInt = z.number().int().min(1);

/** What a person fills in to start an initiative; the `POST /v1/initiatives` body without IDs. */
export const InitiativeStartInputSchema = z.strictObject({
  initiativeId: InitiativeId,
  prompt: z.string().min(1),
  plan: InitiativePlanSchema.optional(),
  workflow: SafeId.optional(),
  policy: z.unknown().optional(),
  model: z.string().min(1).optional(),
  budget: z
    .strictObject({ tokens: PositiveInt, calls: PositiveInt, timeMs: PositiveInt })
    .optional(),
  /** The dollar cap feature runs share (#1317), with its tolerance band. */
  budgetUsd: z.number().positive().optional(),
  costTolerance: CostToleranceSchema.optional(),
  tieredApproval: z.strictObject({ maxTasks: PositiveInt, maxFiles: PositiveInt }).optional(),
  confirmAutoApproval: z.string().min(1).optional(),
  /** The GitHub issue of each feature of `plan`, by feature ID; delivery of its runs closes it. */
  featureIssues: z.record(FeatureKey, IssueSourceSchema).optional(),
  /** Feature runs execute in worktrees, so independent features run side by side. */
  worktree: z.boolean().optional(),
  /** Hold feature starts while the estimate's low end is above the shared budget. */
  forecastStop: z.boolean().optional(),
  /** Keep the decomposer's small features apart instead of merging siblings into one run. */
  keepFeatures: z.boolean().optional(),
});
export type InitiativeStartInput = z.infer<typeof InitiativeStartInputSchema>;

/** Tiered approval limits a form offers when a person turns tiered approval on. */
export const DEFAULT_TIERED_APPROVAL = { maxTasks: 5, maxFiles: 10 } as const;

/**
 * The service request for a start form, with the project's policy and default workflow where the
 * form leaves them out. Without a budget the service derives one from the policy and the split.
 */
export function initiativeStartRequest(
  input: InitiativeStartInput,
  config: Pick<AppConfig, "workflows">,
  identity: { commandId: string; ownerLabel: string },
): InitiativeStartRequest {
  const form = InitiativeStartInputSchema.parse(input);
  return {
    commandId: identity.commandId,
    initiativeId: form.initiativeId,
    prompt: form.prompt,
    ...(form.plan ? { plan: form.plan } : {}),
    policy: PolicySchema.parse({
      ...PolicySchema.parse(form.policy ?? config.workflows?.policy ?? defaultWorkflowPolicy),
      ...(form.worktree ? { executionMode: "worktree" } : {}),
    }),
    workflowId: form.workflow ?? config.workflows?.defaultWorkflow ?? "sdd",
    budget: form.budget
      ? {
          maxTotalTokens: form.budget.tokens,
          maxAgentCalls: form.budget.calls,
          maxActiveMs: form.budget.timeMs,
        }
      : null,
    costBudget:
      form.budgetUsd !== undefined
        ? { maxCostUsd: form.budgetUsd, costTolerance: form.costTolerance ?? "off" }
        : null,
    featureAutoApproval: form.tieredApproval ?? null,
    ...(form.confirmAutoApproval ? { autoApprovalConfirmation: form.confirmAutoApproval } : {}),
    ...(form.model ? { model: form.model } : {}),
    ...(form.featureIssues ? { featureIssues: form.featureIssues } : {}),
    ...(form.forecastStop ? { forecastStop: true } : {}),
    ...(form.keepFeatures ? { keepFeatures: true } : {}),
    ownerLabel: identity.ownerLabel,
  };
}

/** An initiative ID from the request text that no initiative in `taken` uses. */
export function suggestInitiativeId(prompt: string, taken: readonly string[] = []): string {
  const base =
    featureSlug(prompt).replace(/_/g, "-").slice(0, 34).replace(/-+$/, "").replace(/^-+/, "") ||
    "initiative";
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const id = `${base}-${n}`;
    if (!taken.includes(id)) return id;
  }
  return `${base.slice(0, 30)}-${Date.now().toString(36)}`.slice(0, 40);
}

/**
 * Split parts from text: one part per line or `;`, each `id: title` (or `id title`). Scope, paths
 * and contract are inherited from the split feature, as `baked workflow initiative split` does.
 */
export function parseSplitParts(text: string): { id: string; title: string }[] {
  const parts = text
    .split(/[;\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^([^\s:]+)\s*[:\s]\s*(.+)$/.exec(part);
      const id = (match?.[1] ?? part).trim();
      if (!FeatureKey.safeParse(id).success)
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `Feature ID ${id}: lowercase letters, digits and - only, up to 40 characters`,
        );
      const title = match?.[2]?.trim();
      if (!title) throw new WorkflowFault("INVALID_DEFINITION", `Give feature ${id} a title`);
      return { id, title };
    });
  if (parts.length < 2)
    throw new WorkflowFault("INVALID_DEFINITION", "A split needs at least two parts");
  return parts;
}

const TOKEN_UNITS: Record<string, number> = { "": 1, k: 1_000, m: 1_000_000 };
const TIME_UNITS: Record<string, number> = { "": 1, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

function amount(text: string, units: Record<string, number>, what: string): number {
  const match = /^(\d+(?:\.\d+)?)([a-z]*)$/i.exec(text);
  const unit = units[match?.[2]?.toLowerCase() ?? "x"];
  const value = match && unit !== undefined ? Math.round(Number(match[1]) * unit) : Number.NaN;
  if (!Number.isFinite(value) || value < 1)
    throw new WorkflowFault("INVALID_DEFINITION", `${what} ${text} is not a positive amount`);
  return value;
}

/**
 * Budget limits from text: `TOKENS [CALLS [TIME]]`, such as `8M 400 4h`, and a dollar cap as a
 * word starting with `$`, such as `$40`. Tokens take k or M, time takes ms, s, m or h; `-` leaves a
 * limit out. Empty text gives no limits.
 */
export function parseBudgetText(
  text: string,
): Partial<BudgetLimitsValue> & { maxCostUsd?: number } {
  const all = text.trim().split(/\s+/).filter(Boolean);
  const dollars = all.filter((w) => w.startsWith("$"));
  const words = all.filter((w) => !w.startsWith("$"));
  if (words.length > 3 || dollars.length > 1)
    throw new WorkflowFault("INVALID_DEFINITION", "Give at most tokens, calls, time and $dollars");
  const usd = dollars[0] ? Number(dollars[0].slice(1)) : undefined;
  if (usd !== undefined && !(Number.isFinite(usd) && usd > 0))
    throw new WorkflowFault("INVALID_DEFINITION", `Dollars ${dollars[0]} is not a positive amount`);
  const [tokens, calls, time] = words;
  return {
    ...(usd !== undefined ? { maxCostUsd: usd } : {}),
    ...(tokens && tokens !== "-" ? { maxTotalTokens: amount(tokens, TOKEN_UNITS, "Tokens") } : {}),
    ...(calls && calls !== "-" ? { maxAgentCalls: amount(calls, { "": 1 }, "Calls") } : {}),
    ...(time && time !== "-" ? { maxActiveMs: amount(time, TIME_UNITS, "Time") } : {}),
  };
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** The initiative's dollars in one line; null without a cap and before anything is spent. */
export function costText(cost: CostView | undefined): string | null {
  if (!cost) return null;
  if (cost.capUsd === null) return cost.spentUsd > 0 ? `${usd(cost.spentUsd)} spent` : null;
  const ceiling =
    cost.ceilingUsd !== null && cost.ceilingUsd > cost.capUsd
      ? ` (ceiling ${usd(cost.ceilingUsd)})`
      : "";
  return [
    `${usd(cost.spentUsd)} of ${usd(cost.capUsd)}${ceiling}`,
    `${usd(cost.remainingUsd ?? 0)} left`,
    ...(cost.forecastUsd !== null ? [`forecast ${usd(cost.forecastUsd)}`] : []),
  ].join(" · ");
}

const terminal = (view: Pick<InitiativeView, "status">): boolean =>
  view.status === "completed" || view.status === "refused";

/** Whether merge, split, remove and rename are accepted: a split waiting for approval, or paused. */
export const splitEditable = (
  view: Pick<InitiativeView, "status" | "approvedPlanRevision">,
): boolean =>
  view.status === "awaiting_approval" ||
  (view.status === "paused" && view.approvedPlanRevision !== null);

/** Whether `feature` can run again from research (`replan`). */
export const canReplanFeature = (
  view: Pick<InitiativeView, "status" | "approvedPlanRevision">,
  feature: Pick<FeatureView, "runId" | "runStatus">,
): boolean =>
  !!feature.runId &&
  feature.runStatus !== "running" &&
  view.approvedPlanRevision !== null &&
  (view.status === "active" || view.status === "paused");

/** Whether the shared budget can be raised: any initiative that has not finished. */
export const canExtendBudget = (view: Pick<InitiativeView, "status">): boolean => !terminal(view);
