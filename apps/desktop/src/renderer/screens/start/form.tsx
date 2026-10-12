import { useState } from "react";
import type { RunSnapshot } from "../../../shared/api.js";
import { type PreRunEstimate, type RunPolicy, type StartBody, start } from "../../client/start.js";
import { projectHref } from "../../router.js";
import { BUDGET_PRESETS, type BudgetPreset, presetText, presetTokens } from "./logic.js";
import { message, useLoad } from "./panels.js";

export const HINT = "text-[12px] text-dim-foreground";
export const HINT_ERR = "text-[12px] text-[color:var(--err)]";
export const LEGEND = "p-0 font-medium text-foreground";
export const FIELD = "flex min-w-0 flex-col gap-2";
export const FIELDSET = "m-0 flex min-w-0 flex-col gap-2 border-0 p-0";
export const CHIPS = "flex flex-wrap items-center gap-2";
/**
 * A segment button standing alone in a row of chips: rounded on every side, with a thin left rule.
 * Written out rather than merged onto `segmentClass`, whose first/last and sibling rules would win.
 */
export const CHIP =
  "min-h-8 cursor-pointer rounded-[8px] border-2 border-l border-border border-l-[color:var(--line)] bg-raised px-[14px] py-0 [font-family:inherit] text-[13px] leading-[inherit] font-semibold text-soft-foreground disabled:cursor-default disabled:opacity-45 aria-pressed:border-[color:var(--accent)] aria-pressed:bg-main aria-pressed:text-main-foreground";
export const INLINE = "flex flex-wrap items-center gap-2";
export const FORM = "flex min-w-0 flex-col gap-5";
export const TITLE = "m-0 text-[20px] font-semibold";
// `!` keeps these above the unlayered `textarea` rule in runs.css while that stylesheet exists.
export const GOAL =
  "resize-y rounded-[var(--radius-lg)] border! border-selected! bg-background! px-[14px]! py-3! text-foreground [font-family:inherit] text-[15px]! leading-[1.5]! focus:border-[color:var(--accent)]! focus:outline-none";
/** Extra classes of the primary submit button. */
export const SUBMIT = "min-h-11 px-[22px]";

/** The configured policy, if the config sets one; presets scale the built-in default otherwise. */
export interface PolicyState {
  policy: RunPolicy | null;
  /** Where the limits the presets scale come from, for the picker's hint; null while loading. */
  source: string | null;
  loading: boolean;
}

/**
 * `useLoad` reports a loaded null and a pending load alike, so a config without a policy is told
 * apart by asking for the policy through this wrapper, which never resolves to null.
 */
export async function loadPolicy(key: string): Promise<RunPolicy | "none"> {
  return (await start.policy(key)) ?? "none";
}

export function usePolicy(key: string): PolicyState {
  const { value, error } = useLoad(key, loadPolicy);
  // The server scales the policy itself (`budget` in the start body), so every preset works even
  // when the config cannot be read here.
  if (error) return { policy: null, source: null, loading: false };
  if (value === null) return { policy: null, source: null, loading: true };
  if (value === "none")
    return {
      policy: null,
      source: "This project sets no workflow policy, so the presets scale BAKED's default limits.",
      loading: false,
    };
  return {
    policy: value,
    source: "The presets scale the workflow policy in this project's config.",
    loading: false,
  };
}

/** The token cap and checkpoint of a preset, from the policy or else the estimate's budget. */
export function presetLimits(
  preset: BudgetPreset,
  policy: RunPolicy | null,
  estimate: PreRunEstimate | null,
): {
  base: { maxTotalTokens: number; checkpointTokens: number | null } | null;
  cap: number | null;
  checkpoint: number | null;
} {
  const base = policy
    ? { maxTotalTokens: policy.maxTotalTokens, checkpointTokens: policy.checkpointTokens ?? null }
    : estimate
      ? { maxTotalTokens: estimate.budget.maxTotalTokens, checkpointTokens: null }
      : null;
  if (!base) return { base, cap: null, checkpoint: null };
  const { cap, checkpoint } = presetTokens(base.maxTotalTokens, preset, base.checkpointTokens);
  return { base, cap, checkpoint };
}

export function BudgetPicker({
  value,
  onChange,
  policy,
  base,
}: {
  value: BudgetPreset;
  onChange: (preset: BudgetPreset) => void;
  policy: PolicyState;
  base: { maxTotalTokens: number; checkpointTokens: number | null } | null;
}) {
  return (
    <fieldset className={FIELDSET}>
      <legend className={LEGEND}>Budget preset</legend>
      <div className={CHIPS}>
        {BUDGET_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={CHIP}
            aria-pressed={value === preset}
            onClick={() => onChange(preset)}
          >
            {preset}
          </button>
        ))}
      </div>
      <span className={HINT}>{presetText(value, base)}</span>
      {policy.source && <span className={HINT}>{policy.source}</span>}
    </fieldset>
  );
}

/** The `budget` field of a start body: omitted for `standard`, which the server applies anyway. */
export function budgetField(preset: BudgetPreset): { budget?: BudgetPreset } {
  return preset === "standard" ? {} : { budget: preset };
}

/** Starts a run and opens it; keeps the error for the form. */
export function useStartRun(key: string): {
  starting: boolean;
  error: string | null;
  run: (body: Omit<StartBody, "commandId">) => Promise<RunSnapshot | null>;
} {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    starting,
    error,
    run: async (body) => {
      setStarting(true);
      setError(null);
      try {
        const snapshot = await start.run(key, { commandId: crypto.randomUUID(), ...body });
        window.location.hash = projectHref(key, "runs", snapshot.runId);
        return snapshot;
      } catch (e) {
        setError(message(e));
        return null;
      } finally {
        setStarting(false);
      }
    },
  };
}
