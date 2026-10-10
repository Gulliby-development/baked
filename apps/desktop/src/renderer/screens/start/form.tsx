import { useState } from "react";
import type { RunSnapshot } from "../../../shared/api.js";
import {
  isMissingEndpoint,
  type PreRunEstimate,
  type RunPolicy,
  type StartBody,
  start,
} from "../../client/start.js";
import { projectHref } from "../../router.js";
import {
  BUDGET_PRESETS,
  type BudgetPreset,
  presetText,
  presetTokens,
  scaledPolicy,
} from "./logic.js";
import { message, useLoad } from "./panels.js";

/** The configured policy, or why the presets that scale it are unavailable. */
export interface PolicyState {
  policy: RunPolicy | null;
  /** Shown next to presets other than `standard` when they cannot be used. */
  unavailable: string | null;
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
  if (error)
    return {
      policy: null,
      unavailable: isMissingEndpoint(error)
        ? "Other presets need a newer BAKED (GET /v1/config)."
        : `Other presets are unavailable: ${message(error)}`,
      loading: false,
    };
  if (value === null) return { policy: null, unavailable: null, loading: true };
  if (value === "none")
    return {
      policy: null,
      unavailable:
        "The configuration sets no workflow policy, so only the built-in default (standard) applies.",
      loading: false,
    };
  return { policy: value, unavailable: null, loading: false };
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
    <fieldset className="start-fieldset">
      <legend className="start-legend">Budget preset</legend>
      <div className="start-chips">
        {BUDGET_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className="seg start-chip"
            aria-pressed={value === preset}
            disabled={preset !== "standard" && !policy.policy}
            onClick={() => onChange(preset)}
          >
            {preset}
          </button>
        ))}
      </div>
      <span className="start-hint">{presetText(value, base)}</span>
      {policy.unavailable ? (
        <span className="start-hint">{policy.unavailable}</span>
      ) : (
        <span className="start-hint">Built into the app, nothing is downloaded.</span>
      )}
    </fieldset>
  );
}

/** The policy to send for a preset: none for `standard`, which is the configured policy. */
export function policyFor(preset: BudgetPreset, policy: RunPolicy | null): RunPolicy | undefined {
  if (preset === "standard" || !policy) return undefined;
  return scaledPolicy(policy, preset);
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
