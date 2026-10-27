import type { AgentProfile } from "../agents/profiles/schema.js";
import { ROUTING_ARTIFACT, RoutingRecordSchema } from "../llm/model-routing.js";
import { canonical } from "../specs/hash.js";
import { implementationModels } from "./routing.js";
import { PolicySchema, ProfileSchema } from "./schemas.js";
import type { WorkflowStore } from "./store.js";
import { loadGateLibrary } from "./v2/library.js";
import { parseRunDefinition } from "./v2/runtime.js";

/** How recent another model's answer is for the stall ladder to take it as a fallback (#2271). */
export const SIBLING_WINDOW_MS = 10 * 60_000;

/**
 * The calls the ladder may move to a model their route does not name: the checking calls, whose
 * result does not depend on the model that wrote the code. Implementation and authoring calls
 * keep their route's chain.
 */
const DERIVED_FALLBACK_OUTPUTS: ReadonlySet<AgentProfile["output"]> = new Set([
  "analysis",
  "review",
  "approval-review",
  "critique",
  "refutation",
  "convergence",
]);

/**
 * The derived fallback of a stalled call, kept with its inputs at `provider/fallback/<attempt>.json`
 * so the stop detail can say what answered and a replay decides the ladder the same way.
 */
export interface FallbackDecision {
  schemaVersion: 1;
  attemptId: string;
  model: string;
  profileId: string;
  /** Other models of the stalled model's provider that the run routes a call to. */
  routed: string[];
  /** Models the implementation uses: a review moved there would not be independent. */
  excluded: string[];
  /** Seconds since each routed model last answered, for the ones that did within the window. */
  answeredSecondsAgo: Record<string, number>;
  /** What the ladder may take, most recent answer first; empty when none answered. */
  siblings: string[];
}

const provider = (model: string) => model.split("/")[0];

/**
 * Models of `model`'s provider from `routed` that answered within `SIBLING_WINDOW_MS` of `now`,
 * the most recent first, without the stalled model and the `excluded` ones.
 */
export function siblingModels(input: {
  model: string;
  routed: readonly string[];
  excluded: ReadonlySet<string>;
  answered: ReadonlyMap<string, number>;
  now: number;
}): string[] {
  return [...new Set(input.routed)]
    .filter(
      (candidate) =>
        candidate !== input.model &&
        provider(candidate) === provider(input.model) &&
        !input.excluded.has(candidate) &&
        (input.answered.get(candidate) ?? -Infinity) >= input.now - SIBLING_WINDOW_MS,
    )
    .sort((a, b) => (input.answered.get(b) ?? 0) - (input.answered.get(a) ?? 0));
}

export const fallbackPath = (attemptId: string) => `provider/fallback/${attemptId}.json`;

/**
 * The derived fallback of a stalled checking call on `model` (#2271): the models the run's frozen
 * routing sends other calls to on the same provider that answered a call of this workspace in the
 * last 10 minutes, never one the implementation uses. Null for a call the ladder keeps on its
 * route, or a run without a routing record. In R72 gpt-6.1-sol stalled for 25 minutes in three
 * runs at once while luna and astra answered, and every run stopped for a person.
 */
export function siblingFallbacks(
  store: WorkflowStore,
  runId: string,
  attemptId: string,
  profile: AgentProfile,
  now = Date.now(),
): FallbackDecision | null {
  if (!DERIVED_FALLBACK_OUTPUTS.has(profile.output)) return null;
  const saved = store.latestArtifact(runId, ROUTING_ARTIFACT);
  if (!saved) return null;
  const record = RoutingRecordSchema.parse(JSON.parse(store.readArtifact(runId, saved.id)));
  const routed = [
    record.runModel,
    ...[...Object.values(record.stages), ...Object.values(record.profiles)].flatMap((entry) => [
      entry.model,
      ...(entry.fallback ?? []),
    ]),
  ].filter(
    (candidate) => candidate !== profile.model && provider(candidate) === provider(profile.model),
  );
  const row = store.run(runId);
  const policy = PolicySchema.parse(JSON.parse(row.policy_json));
  const excluded = implementationModels(
    record,
    parseRunDefinition(row.definition_json).definition,
    policy,
    loadGateLibrary(store.workspace, policy).gates,
    ProfileSchema.array().parse(JSON.parse(row.profiles_json)),
  );
  const answered = store.answeredModels(now - SIBLING_WINDOW_MS);
  const unique = [...new Set(routed)].sort();
  return {
    schemaVersion: 1,
    attemptId,
    model: profile.model,
    profileId: profile.id,
    routed: unique,
    excluded: unique.filter((candidate) => excluded.has(candidate)),
    answeredSecondsAgo: Object.fromEntries(
      unique.flatMap((candidate) => {
        const at = answered.get(candidate);
        return at === undefined ? [] : [[candidate, Math.max(0, Math.round((now - at) / 1000))]];
      }),
    ),
    siblings: siblingModels({ model: profile.model, routed: unique, excluded, answered, now }),
  };
}

export function writeFallback(store: WorkflowStore, runId: string, decision: FallbackDecision) {
  store.artifact(runId, "recovery", fallbackPath(decision.attemptId), canonical(decision));
}

export function readFallback(
  store: WorkflowStore,
  runId: string,
  attemptId: string,
): FallbackDecision | null {
  const saved = store.latestArtifact(runId, fallbackPath(attemptId));
  return saved ? (JSON.parse(store.readArtifact(runId, saved.id)) as FallbackDecision) : null;
}

/** " codex/gpt-6-astra answered 2 min ago.", for the stop text; empty when no other model did. */
export function siblingNote(decision: FallbackDecision | null): string {
  if (!decision) return "";
  const ago = (model: string) => {
    const seconds = decision.answeredSecondsAgo[model] ?? 0;
    return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
  };
  const sibling = decision.siblings[0];
  if (sibling) return ` ${sibling} answered ${ago(sibling)} ago.`;
  const kept = Object.keys(decision.answeredSecondsAgo)[0];
  return kept
    ? ` ${kept} answered ${ago(kept)} ago; the implementation uses it, so this call stays off it.`
    : "";
}
