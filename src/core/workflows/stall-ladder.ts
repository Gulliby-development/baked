import { lowerEffort, type RouteEffort } from "../llm/model-routing.js";
import { lostAnswer } from "../llm/provider-answer.js";
import { ProviderUnreachableError } from "../llm/provider-health.js";
import { canonical, hashJson } from "../specs/hash.js";
import type { WorkflowStore } from "./store.js";

/**
 * The recovery ladder of a stalled provider call (#1877). A call that got no first byte, or whose
 * stream ended without a finish, is tried again at once one rung further, instead of repeating the
 * same call on the same transport until the circuit stops the run for a person. Each rung keeps
 * what the rungs before it changed. Bench round 58 (wheeltags): 10 attempts, 3 resumes and a
 * reroute over 97 minutes on Codex native, while `codex exec` finished the stalled stage in 126 s.
 */
export const LADDER_RUNGS = [
  "fresh-session",
  "other-transport",
  "lower-effort",
  "next-model",
] as const;
export type LadderRung = (typeof LADDER_RUNGS)[number];

/** How the next attempt of a stalled stage is placed; every field is cumulative. */
export interface RecoveryPlacement {
  rung: LadderRung;
  /** Every step of the attempt starts a new provider session (no resumed Codex thread). */
  freshSession?: true;
  /** The attempt runs on Codex's `exec` transport instead of the app-server. */
  transport?: "exec";
  effort?: RouteEffort;
  /** Position in the route's model chain the attempt runs on. */
  fallbackIndex: number;
  /**
   * A model outside the route's chain the attempt runs on instead: a sibling of the stalled model
   * on its provider that answered another call of the run's workspace a moment ago (#2271).
   */
  model?: string;
}

export interface LadderStep {
  rung: LadderRung | "first";
  attemptId: string;
  modelId: string;
  seconds: number;
  error: string;
}

export interface Ladder {
  steps: LadderStep[];
  /** The rung the next attempt runs on: a resumed or restarted driver continues there. */
  next?: RecoveryPlacement;
  /** Every rung failed and the run stopped for a person; their resume starts a new ladder. */
  exhausted?: true;
}

/** A call the provider never answered, as opposed to a refused or dropped connection. */
export function isStall(error: unknown): boolean {
  return (
    error instanceof ProviderUnreachableError &&
    /^(?:No model response within \d+ seconds|Provider stream ended without a response finish)$/.test(
      error.message,
    )
  );
}

/**
 * A call the ladder climbs on: a stall, or a turn that finished with no usable answer (#1957). The
 * provider answered the second one, but the same input on the same settings ends the same way, so
 * waiting out an outage that is not there only repeats it.
 */
export function recoverableCall(error: unknown): "stall" | "lost-answer" | null {
  if (isStall(error)) return "stall";
  return lostAnswer(error) ? "lost-answer" : null;
}

/** Only Codex over its app-server keeps a session between steps and has a second transport. */
function codexNative(model: string): boolean {
  return model.startsWith("codex/") && process.env.BAKED_CODEX_TRANSPORT !== "exec";
}

const provider = (model: string) => model.split("/")[0];

/**
 * The rungs in the order a call climbs them. When another model of the stalled model's provider
 * answered a moment ago, the endpoint of this model is what is down, so the next model comes
 * before the lower effort, which cannot help a model that does not answer (#2271).
 */
export function ladderOrder(siblings: readonly string[] | undefined): readonly LadderRung[] {
  return siblings?.length
    ? ["fresh-session", "other-transport", "next-model", "lower-effort"]
    : LADDER_RUNGS;
}

/**
 * The first rung after `current` that changes something for this call, or null when none is left.
 * The next model prefers another provider: a stall can belong to the account or the transport.
 * With no later model in the route's chain, it takes the first of `siblings`: models of the same
 * provider the run routes other calls to that answered a moment ago (#2271, `siblingFallbacks`).
 */
export function nextRung(
  current: RecoveryPlacement | undefined,
  call: {
    model: string;
    models: string[];
    fallbackIndex: number;
    effort: RouteEffort | undefined;
    siblings?: readonly string[];
  },
): RecoveryPlacement | null {
  const order = ladderOrder(call.siblings);
  const from = current ? order.indexOf(current.rung) + 1 : 0;
  const base: RecoveryPlacement = {
    rung: "fresh-session",
    ...(current?.freshSession ? { freshSession: true } : {}),
    ...(current?.transport ? { transport: current.transport } : {}),
    ...((current?.effort ?? call.effort) ? { effort: current?.effort ?? call.effort } : {}),
    fallbackIndex: call.fallbackIndex,
    ...(current?.model ? { model: current.model } : {}),
  };
  for (const rung of order.slice(from)) {
    if (rung === "fresh-session" && codexNative(call.model) && !base.freshSession)
      return { ...base, rung, freshSession: true };
    if (rung === "other-transport" && codexNative(call.model) && !base.transport)
      return { ...base, rung, transport: "exec" };
    if (rung === "lower-effort") {
      const lower = lowerEffort(base.effort);
      if (lower) return { ...base, rung, effort: lower };
    }
    if (rung === "next-model") {
      const later = call.models
        .map((model, index) => ({ model, index }))
        .filter(({ model, index }) => index > call.fallbackIndex && model !== call.model);
      const pick = later.find(({ model }) => provider(model) !== provider(call.model)) ?? later[0];
      // A new model starts from its own route effort and transport.
      if (pick) return { rung, fallbackIndex: pick.index };
      const sibling = call.siblings?.find((model) => model !== call.model);
      if (sibling) return { rung, fallbackIndex: call.fallbackIndex, model: sibling };
    }
  }
  return null;
}

/** One ladder per stage, profile, task, run input and route: a reroute starts a new one. */
export function ladderPath(scope: {
  stageId: string | null;
  profileId: string;
  taskId: string | null;
  inputHash: string;
  models: string[];
}): string {
  return `recovery/ladder-${hashJson(scope)}.json`;
}

export function readLadder(store: WorkflowStore, runId: string, path: string): Ladder {
  const saved = store.latestArtifact(runId, path);
  return saved ? (JSON.parse(store.readArtifact(runId, saved.id)) as Ladder) : { steps: [] };
}

export function writeLadder(store: WorkflowStore, runId: string, path: string, ladder: Ladder) {
  store.artifact(runId, "recovery", path, canonical(ladder));
}

const RUNG_TEXT: Record<LadderStep["rung"], string> = {
  first: "as routed",
  "fresh-session": "fresh session",
  "other-transport": "codex exec transport",
  "lower-effort": "lower reasoning effort",
  "next-model": "next model of the route",
};

export function rungText(rung: LadderStep["rung"]): string {
  return RUNG_TEXT[rung];
}

/** The rungs tried, for the stop text: "as routed on codex/a (190 s), fresh session ...". */
export function ladderSummary(steps: LadderStep[]): string {
  const total = ladderSeconds(steps);
  return `${steps
    .map((step) => `${RUNG_TEXT[step.rung]} on ${step.modelId} (${step.seconds} s)`)
    .join(", ")}; ${formatLadderTime(total)} in all`;
}

/** The time every rung of a ladder waited, so a 19 minute climb is visible (#2271). */
export function ladderSeconds(steps: readonly LadderStep[]): number {
  return steps.reduce((sum, step) => sum + step.seconds, 0);
}

export function formatLadderTime(seconds: number): string {
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** Waits before the automatic resumes of a run parked after its ladder ran out on a stall. */
export const STALL_PARK_DELAYS_S = [600, 1200, 1200] as const;
export const STALL_PARK_ARTIFACT = "provider/stall-park.json";

/**
 * A run whose recovery ladder ran out on a stall, parked as `provider_stall` (#2271). In R72 the
 * loop's plain resume 25 to 50 minutes later completed all three such runs, so the park would
 * resume on its own after 10, then 20, then 20 minutes, and leave the fourth stop to a person. It
 * ships in shadow: the decision is recorded and a person still resumes; its promotion is a pull
 * request of its own after bench rounds show the would-resumes were right.
 */
export interface StallPark {
  schemaVersion: 1;
  reason: "provider_stall";
  mode: "shadow";
  /** The attempt whose ladder ran out, as the provider circuit records it. */
  attemptId: string;
  /** Parks in a row, this one included, with no completed attempt of the run between them. */
  tries: number;
  decision: { would_resume: boolean; afterSeconds?: number };
  at: number;
}

export function stallParkDecision(tries: number): StallPark["decision"] {
  const after = STALL_PARK_DELAYS_S[tries - 1];
  return after === undefined
    ? { would_resume: false }
    : { would_resume: true, afterSeconds: after };
}

function latestJson<T>(store: WorkflowStore, runId: string, path: string): T | null {
  const saved = store.latestArtifact(runId, path);
  return saved ? (JSON.parse(store.readArtifact(runId, saved.id)) as T) : null;
}

/**
 * The park of a run the provider circuit stopped after a stalled ladder, recorded once per stop:
 * null when the circuit is closed or stopped for another reason (a lost answer, zero-token
 * attempts).
 */
export function recordStallPark(
  store: WorkflowStore,
  runId: string,
  now = Date.now(),
): StallPark | null {
  const circuit = latestJson<{ open: boolean; attemptId?: string; stall?: true }>(
    store,
    runId,
    "provider/circuit.json",
  );
  if (!circuit?.open || !circuit.stall || !circuit.attemptId) return null;
  const previous = latestJson<StallPark>(store, runId, STALL_PARK_ARTIFACT);
  if (previous?.attemptId === circuit.attemptId) return previous;
  const answeredSince =
    previous &&
    store
      .attempts(runId)
      .some((attempt) => attempt.status === "completed" && attempt.started_at > previous.at);
  const tries = previous && !answeredSince ? previous.tries + 1 : 1;
  const park: StallPark = {
    schemaVersion: 1,
    reason: "provider_stall",
    mode: "shadow",
    attemptId: circuit.attemptId,
    tries,
    decision: stallParkDecision(tries),
    at: now,
  };
  store.artifact(runId, "recovery", STALL_PARK_ARTIFACT, canonical(park));
  return park;
}

/** The park of the run's current circuit stop, for the run views and `baked serve`. */
export function readStallPark(store: WorkflowStore, runId: string): StallPark | null {
  const circuit = latestJson<{ open: boolean; attemptId?: string }>(
    store,
    runId,
    "provider/circuit.json",
  );
  const park = latestJson<StallPark>(store, runId, STALL_PARK_ARTIFACT);
  return circuit?.open && park && park.attemptId === circuit.attemptId ? park : null;
}
