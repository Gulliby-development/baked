/**
 * The budget growth the host made on its own, as opposed to limits a person set. The host grows a
 * run's tokens, active time and cost cap without asking (plan sizing, the planning floor,
 * auto-growth, auto-extend) and records each step as a policy revision with
 * `approvedBy: "sizing"`. Checks that compare a policy with one a person approved or answered
 * read that growth through here, so it never counts as a change a person has to decide again
 * (#1430, #1433).
 */
import type { RunPolicy } from "./schemas.js";
import type { ArtifactRow } from "./store.js";

/** Limits the host grows by itself. */
export const HOST_GROWN_KEYS = ["maxTotalTokens", "maxActiveMs", "maxCostUsd"] as const;
type HostGrownKey = (typeof HOST_GROWN_KEYS)[number];

export interface HostGrowth {
  /** Hash of the policy before the host's growth steps: one a person or the start set. */
  baseHash: string;
  /** The grown limits as they were at `baseHash`; a limit the host did not grow is absent. */
  base: Partial<Pick<RunPolicy, HostGrownKey>>;
  /** Every cost cap the run had along the way, from the current one back to the base. */
  caps: number[];
}

interface SizingRevision {
  previousPolicyHash: string;
  policyHash: string;
  previous: Record<string, unknown>;
}

/**
 * Walks the host's growth revisions back from `policyHash` until a policy the host did not grow
 * into, or one of `stopAt` (an approved or operator-set policy). Each revision names the policy
 * hash before and after its step, so only an unbroken chain of host steps is undone.
 */
export function hostGrowth(
  artifacts: ArtifactRow[],
  read: (artifact: ArtifactRow) => string,
  policyHash: string,
  stopAt: ReadonlySet<string> = new Set(),
): HostGrowth {
  const byResult = new Map<string, SizingRevision>();
  for (const artifact of artifacts) {
    if (artifact.kind !== "policy-revision") continue;
    let body: Partial<SizingRevision> & { approvedBy?: unknown };
    try {
      body = JSON.parse(read(artifact)) as typeof body;
    } catch {
      continue;
    }
    if (
      body.approvedBy === "sizing" &&
      typeof body.policyHash === "string" &&
      typeof body.previousPolicyHash === "string" &&
      body.previous !== null &&
      typeof body.previous === "object"
    )
      byResult.set(body.policyHash, body as SizingRevision);
  }
  const base: HostGrowth["base"] = {};
  const caps: number[] = [];
  const seen = new Set<string>();
  let hash = policyHash;
  for (;;) {
    const step = byResult.get(hash);
    if (!step || stopAt.has(hash) || seen.has(hash)) break;
    seen.add(hash);
    for (const key of HOST_GROWN_KEYS) {
      const value = step.previous[key];
      if (typeof value === "number") base[key] = value;
    }
    if (typeof step.previous.maxCostUsd === "number") caps.push(step.previous.maxCostUsd);
    hash = step.previousPolicyHash;
  }
  return { baseHash: hash, base, caps };
}

/** The policy with the host's growth undone: the limits as a person or the start set them. */
export function withoutHostGrowth(policy: RunPolicy, growth: HostGrowth): RunPolicy {
  return { ...policy, ...growth.base };
}
