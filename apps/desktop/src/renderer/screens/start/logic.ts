import type {
  DoctorCheck,
  DoctorReport,
  DoctorStatus,
  Fit,
  PolicyLimits,
  PreRunInput,
  TokenRange,
} from "../../client/start.js";
import { tokens } from "../../format.js";

/**
 * Pure logic of the start forms. The server scales the policy for a budget preset
 * (`presetPolicy` in `src/core/workflows/budget.ts`); the token limits shown here follow it, and
 * feature IDs follow `src/core/workflows/feature-id.ts`, so a run started here gets the policy
 * and ID the terminal UI and the CLI would give it.
 */

export const BUDGET_PRESETS = ["quick", "standard", "extended", "checkpoints"] as const;
export type BudgetPreset = (typeof BUDGET_PRESETS)[number];

const factorOf = (preset: BudgetPreset): number => (preset === "quick" ? 0.5 : 2);

/** The token limits of a preset from the configured token cap alone, for display. */
export function presetTokens(
  maxTotalTokens: number,
  preset: BudgetPreset,
  checkpointTokens: number | null = null,
): { cap: number | null; checkpoint: number | null } {
  if (preset === "standard") return { cap: maxTotalTokens, checkpoint: null };
  if (preset === "checkpoints")
    return {
      cap: null,
      checkpoint: checkpointTokens ?? Math.max(10000, Math.round(maxTotalTokens / 2)),
    };
  return { cap: Math.max(1000, Math.round(maxTotalTokens * factorOf(preset))), checkpoint: null };
}

/** Whether an estimate fits a token cap, by the core's rule; no cap always fits. */
export function fitOf(range: TokenRange, cap: number | null): Fit {
  if (cap === null) return "yes";
  return range.high <= cap ? "yes" : range.low > cap ? "no" : "maybe";
}

export const FIT_TEXT: Record<Fit, string> = {
  yes: "fits the budget",
  maybe: "may exceed the budget",
  no: "exceeds the budget",
};

export function presetText(
  preset: BudgetPreset,
  limits: Pick<PolicyLimits, "maxTotalTokens" | "checkpointTokens"> | null,
): string {
  if (!limits) return "The standard limits, scaled by the preset.";
  const { cap, checkpoint } = presetTokens(
    limits.maxTotalTokens,
    preset,
    limits.checkpointTokens ?? null,
  );
  switch (preset) {
    case "quick":
      return `${tokens(cap ?? 0)} tokens, half the standard limits`;
    case "standard":
      return `${tokens(cap ?? 0)} tokens, the standard limits`;
    case "extended":
      return `${tokens(cap ?? 0)} tokens, double the standard limits`;
    case "checkpoints":
      return `no token cap, pauses every ${tokens(checkpoint ?? 0)} for your go-ahead`;
  }
}

export function rangeText(range: TokenRange): string {
  return range.low === range.high
    ? tokens(range.low)
    : `${tokens(range.low)}–${tokens(range.high)}`;
}

export function usdRange(range: TokenRange | null): string {
  if (!range) return "–";
  const one = (n: number): string => (n < 10 ? n.toFixed(2) : String(Math.round(n)));
  return range.low === range.high ? `$${one(range.low)}` : `$${one(range.low)}–${one(range.high)}`;
}

const CYRILLIC: Record<string, string> = Object.fromEntries(
  "а:a б:b в:v г:g д:d е:e ё:e ж:zh з:z и:i й:y к:k л:l м:m н:n о:o п:p р:r с:s т:t у:u ф:f х:h ц:ts ч:ch ш:sh щ:sch ъ: ы:y ь: э:e ю:yu я:ya і:i ї:yi є:ye ґ:g"
    .split(" ")
    .map((pair) => pair.split(":") as [string, string]),
);

/** A feature ID derived from free text (`featureSlug` in the core); empty for empty text. */
export function featureSlug(text: string): string {
  return [...text.toLowerCase()]
    .map((ch) => CYRILLIC[ch] ?? ch)
    .join("")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
}

/** The slug, with -2, -3, ... appended while a run already uses it (`uniqueFeatureId`). */
export function uniqueFeatureId(text: string, taken: (id: string) => boolean): string {
  const base = featureSlug(text);
  if (!base) return "";
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const id = `${base.slice(0, 90)}-${n}`;
    if (!taken(id)) return id;
  }
  return `${base.slice(0, 80)}-${Date.now().toString(36)}`;
}

export const isFeatureId = (id: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id);

/** Why the start button is disabled, or null when the task can start. */
export function quickBlocker(input: {
  prompt: string;
  feature: string;
  hasWorkflow: boolean | null;
}): string | null {
  if (input.hasWorkflow === false) return "This project has no quick workflow.";
  if (!input.prompt.trim()) return "Describe the change first.";
  if (!isFeatureId(input.feature))
    return "Fix the feature ID: letters, digits, - and _, starting with a letter or digit.";
  return null;
}

/** A stage ID as a label: `implement` → `Implement`, `ai-acceptance` → `Ai acceptance`. */
export function stageLabel(id: string): string {
  const text = id.replace(/[-_]+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The model without its provider, as the stage rows show it. */
export const shortModel = (model: string): string => model.slice(model.indexOf("/") + 1);

/** Failures first, then warnings, then the rest, each group in the doctor's order. */
export function orderChecks(checks: DoctorCheck[]): DoctorCheck[] {
  const rank: Record<DoctorStatus, number> = { fail: 0, warn: 1, ok: 2, skip: 3 };
  return checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => rank[a.check.status] - rank[b.check.status] || a.index - b.index)
    .map((entry) => entry.check);
}

export function doctorLine(report: DoctorReport): string {
  const fails = report.checks.filter((c) => c.status === "fail").length;
  const warns = report.checks.filter((c) => c.status === "warn").length;
  const warnText = warns ? `, ${warns} warning${warns === 1 ? "" : "s"}` : "";
  return report.ready
    ? `Doctor: ready${warnText}`
    : `Doctor: ${fails} problem${fails === 1 ? "" : "s"}${warnText}`;
}

/** The query string of `GET /v1/workflow/doctor` and `/estimate`; defaults are left out. */
export function preRunQuery(input: PreRunInput): string {
  const params = new URLSearchParams();
  if (input.workflow) params.set("workflow", input.workflow);
  if (input.model) params.set("model", input.model);
  if (input.worktree) params.set("worktree", "true");
  if (input.writers !== undefined && input.writers > 1)
    params.set("writers", String(input.writers));
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The hint under the recipes: what was proposed from the request, and whether the pick differs. */
export function proposalText(
  proposal: { workflowId: string; reason: string; budget: string },
  workflow: string,
): string {
  return workflow === proposal.workflowId
    ? `Proposed from your request: ${proposal.reason} (${proposal.budget} budget). Pick another recipe to change it.`
    : `Proposed ${proposal.workflowId}: ${proposal.reason}. Your pick, ${workflow}, is kept and recorded with the run.`;
}
