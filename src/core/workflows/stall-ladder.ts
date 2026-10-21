import { lowerEffort, type RouteEffort } from "../llm/model-routing.js";
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

/** Only Codex over its app-server keeps a session between steps and has a second transport. */
function codexNative(model: string): boolean {
  return model.startsWith("codex/") && process.env.BAKED_CODEX_TRANSPORT !== "exec";
}

const provider = (model: string) => model.split("/")[0];

/**
 * The first rung after `current` that changes something for this call, or null when none is left.
 * The next model prefers another provider: a stall can belong to the account or the transport.
 */
export function nextRung(
  current: RecoveryPlacement | undefined,
  call: { model: string; models: string[]; fallbackIndex: number; effort: RouteEffort | undefined },
): RecoveryPlacement | null {
  const from = current ? LADDER_RUNGS.indexOf(current.rung) + 1 : 0;
  const base: RecoveryPlacement = {
    rung: "fresh-session",
    ...(current?.freshSession ? { freshSession: true } : {}),
    ...(current?.transport ? { transport: current.transport } : {}),
    ...((current?.effort ?? call.effort) ? { effort: current?.effort ?? call.effort } : {}),
    fallbackIndex: call.fallbackIndex,
  };
  for (const rung of LADDER_RUNGS.slice(from)) {
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
  return steps
    .map((step) => `${RUNG_TEXT[step.rung]} on ${step.modelId} (${step.seconds} s)`)
    .join(", ");
}
