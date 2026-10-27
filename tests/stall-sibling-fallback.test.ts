import { afterEach, describe, expect, test } from "bun:test";
import { ROUTING_ARTIFACT, type RoutingRecord } from "../src/core/llm/model-routing.js";
import { ProviderUnreachableError } from "../src/core/llm/provider-health.js";
import { canonical } from "../src/core/specs/hash.js";
import { providerCircuitOpen } from "../src/core/workflows/retry.js";
import {
  ladderOrder,
  nextRung,
  readStallPark,
  stallParkDecision,
} from "../src/core/workflows/stall-ladder.js";
import {
  fallbackPath,
  readFallback,
  SIBLING_WINDOW_MS,
  siblingModels,
} from "../src/core/workflows/stall-siblings.js";
import { replayStallLadder } from "../src/core/workflows/trace.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 72 (#2271): codex/gpt-6.1-sol, the spec reviewer and analyzer, stalled for 25
// minutes in three runs at once while gpt-6-luna and gpt-6-astra answered. Each run walked four
// rungs of sol (fresh session, codex exec, lower effort, a fourth call), 19 minutes from the first
// call to the stop, because the `next-model` rung had no fallback configured; the loop's plain
// resume 25 to 50 minutes later completed all three. 3 interventions in one round.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SOL = "codex/gpt-6.1-sol";
const ASTRA = "codex/gpt-6-astra";
const LUNA = "codex/gpt-6-luna";

const stall = (model: string) =>
  new ProviderUnreachableError(model, "No model response within 227 seconds");

/** The usage a stalled attempt records: its last call got no first response. */
function recordStalls(store: WorkflowStore, runId: string) {
  for (const attempt of store.attempts(runId))
    if (attempt.model_id === SOL && attempt.status === "failed")
      store.artifact(
        runId,
        "usage",
        `attempts/${attempt.id}/usage.json`,
        canonical({ profileId: "spec-reviewer", effort: "medium", steps: [], calls: [{ firstByteMs: null, durationMs: 227_000 }] }),
      );
}

/** An sdd run routed as R72's: plan on `planModel`, analyze and review on sol, code on luna. */
async function solOutage(planModel: string, solAnswers: () => boolean = () => false) {
  const analyses: { model: string; transport: string | null; effort: string | null }[] = [];
  const fixture = workflowFixture({
    executor: (root) =>
      new (class extends FixtureExecutor {
        override async execute(request: ExecutionRequest) {
          if (request.profile.output === "analysis") {
            analyses.push({
              model: request.profile.model,
              transport: request.transport ?? null,
              effort: request.effort ?? null,
            });
            if (request.profile.model === SOL && !solAnswers()) throw stall(SOL);
          }
          return super.execute(request);
        }
      })(root),
  });
  cleanups.push(fixture.dispose);
  fixture.service.providerProbe = async () => ({});
  fixture.service.providerDelay = async () => {};
  const run = await fixture.start();
  const { store } = fixture.service;
  const artifact = store.latestArtifact(run.runId, ROUTING_ARTIFACT);
  if (!artifact) throw new Error("Routing record missing");
  const routing = JSON.parse(store.readArtifact(run.runId, artifact.id)) as RoutingRecord;
  const route = (model: string) => ({ model, effort: "medium" as const, source: "scenario" });
  routing.stages.plan = route(planModel);
  routing.stages.analyze = route(SOL);
  routing.stages.implement = route(LUNA);
  routing.stages.review = route(SOL);
  store.artifact(run.runId, "routing", ROUTING_ARTIFACT, canonical(routing));
  const signal = new AbortController().signal;
  const snapshot = await fixture.service.drive(run.runId, signal);
  const recoveries = store
    .events(run.runId, 0, 10_000)
    .flatMap((event) => (event.type === "attempt.recovery" ? [event.payload] : []));
  return { fixture, run, snapshot, analyses, recoveries, signal };
}

describe("scenario: R72 sol stall, the next-model rung takes a sibling that answered (#2271)", () => {
  test("a stalled analyze call moves to the provider's model that answered a moment ago, with no stop", async () => {
    const { fixture, run, snapshot, analyses, recoveries } = await solOutage(ASTRA);
    // Without the derived fallback the ladder ran out on sol and the run stopped for a person.
    expect(snapshot.reason).not.toBe("no_progress");
    expect(snapshot.status).not.toBe("blocked");
    expect(providerCircuitOpen(fixture.service.store, run.runId)).toBe(false);
    // `next-model` before `lower-effort`: a lower effort cannot help a model that does not answer.
    expect(recoveries.map((r) => r.rung)).toEqual(["fresh-session", "other-transport", "next-model"]);
    expect(recoveries[2]).toMatchObject({ modelId: ASTRA });
    expect(analyses.map((a) => a.model)).toEqual([SOL, SOL, SOL, ASTRA]);
    // The sibling starts from the stage's route effort and its own transport.
    expect(analyses[3]).toEqual({ model: ASTRA, transport: null, effort: "medium" });
    const { store } = fixture.service;
    const stalled = store
      .attempts(run.runId)
      .filter((a) => a.model_id === SOL && a.status === "failed")
      .map((a) => a.id);
    const decision = readFallback(store, run.runId, stalled.at(-1) as string);
    expect(decision).toMatchObject({ model: SOL, siblings: [ASTRA], excluded: [LUNA] });
    expect(Object.keys(decision?.answeredSecondsAgo ?? {})).toContain(ASTRA);
    // The replay takes the same sibling from the recorded decision.
    recordStalls(store, run.runId);
    const replay = replayStallLadder(store, run.runId).filter((b) => b.model === SOL);
    expect(replay.map((b) => b.replayed)).toEqual(["fresh-session", "other-transport", "next-model"]);
    expect(replay.map((b) => b.recorded)).toEqual(replay.map((b) => b.replayed));
    expect(replay[2]?.replayedModel).toBe(ASTRA);
  });

  test("a review never moves to the implementation's model: the ladder runs out, the stop names the sibling it kept off, and the park would resume", async () => {
    let answers = false;
    const { fixture, run, snapshot, analyses, recoveries, signal } = await solOutage(
      LUNA,
      () => answers,
    );
    expect(snapshot).toMatchObject({ status: "blocked", reason: "no_progress" });
    expect(recoveries.map((r) => r.rung)).toEqual(["fresh-session", "other-transport", "lower-effort"]);
    expect(analyses.every((a) => a.model === SOL)).toBe(true);
    const { store } = fixture.service;
    const advice = store
      .artifacts(run.runId)
      .filter((a) => a.kind === "diagnostic")
      .map((a) => store.readArtifact(run.runId, a.id))
      .join("\n");
    expect(advice).toContain(`${LUNA} answered`);
    expect(advice).toContain("the implementation uses it");
    expect(advice).toMatch(/s in all/);
    // Shadow: the park records what its automatic resume would do; a person still resumes.
    expect(readStallPark(store, run.runId)).toMatchObject({
      reason: "provider_stall",
      mode: "shadow",
      tries: 1,
      decision: { would_resume: true, afterSeconds: 600 },
    });
    recordStalls(store, run.runId);
    const replay = replayStallLadder(store, run.runId).filter((b) => b.model === SOL);
    expect(replay.at(-1)?.park).toEqual({ would_resume: true, afterSeconds: 600 });

    answers = true;
    await fixture.resume(run.runId);
    const done = await fixture.service.drive(run.runId, signal);
    expect(done.status).not.toBe("blocked");
    expect(readStallPark(store, run.runId)).toBeNull();
  });
});

describe("derived fallback of the next-model rung", () => {
  const call = {
    model: SOL,
    models: [SOL],
    fallbackIndex: 0,
    effort: "medium" as const,
  };

  test("with a sibling the next model comes before the lower effort and keeps the route position", () => {
    expect(ladderOrder([ASTRA])).toEqual(["fresh-session", "other-transport", "next-model", "lower-effort"]);
    const exec = { rung: "other-transport" as const, freshSession: true as const, transport: "exec" as const, effort: "medium" as const, fallbackIndex: 0 };
    expect(nextRung(exec, { ...call, siblings: [ASTRA] })).toEqual({ rung: "next-model", fallbackIndex: 0, model: ASTRA });
    // Without one the order and the stop stay as they were.
    expect(nextRung(exec, call)).toMatchObject({ rung: "lower-effort", effort: "low" });
    // A sibling that stalls too still gets the lower effort, on the sibling.
    const sibling = { rung: "next-model" as const, fallbackIndex: 0, model: ASTRA };
    expect(nextRung(sibling, { ...call, model: ASTRA, siblings: [ASTRA] })).toEqual({ rung: "lower-effort", fallbackIndex: 0, model: ASTRA, effort: "low" });
  });

  test("a later model the route names comes before a derived one", () => {
    const exec = { rung: "other-transport" as const, freshSession: true as const, transport: "exec" as const, fallbackIndex: 0 };
    expect(nextRung(exec, { ...call, models: [SOL, "claude-code/opus"], effort: undefined, siblings: [ASTRA] })).toEqual({ rung: "next-model", fallbackIndex: 1 });
  });

  test("siblings are the provider's routed models that answered within the window, latest first, without excluded ones", () => {
    const now = 1_000_000_000;
    const answered = new Map([
      [ASTRA, now - 120_000],
      [LUNA, now - 30_000],
      ["codex/old", now - SIBLING_WINDOW_MS - 1],
      ["claude-code/opus", now - 1_000],
    ]);
    const routed = [SOL, ASTRA, LUNA, "codex/old", "claude-code/opus", "codex/never"];
    expect(siblingModels({ model: SOL, routed, excluded: new Set(), answered, now })).toEqual([LUNA, ASTRA]);
    expect(siblingModels({ model: SOL, routed, excluded: new Set([LUNA]), answered, now })).toEqual([ASTRA]);
  });

  test("the park would resume after 10, 20 and 20 minutes, then leaves the stop to a person", () => {
    expect([1, 2, 3, 4].map(stallParkDecision)).toEqual([
      { would_resume: true, afterSeconds: 600 },
      { would_resume: true, afterSeconds: 1200 },
      { would_resume: true, afterSeconds: 1200 },
      { would_resume: false },
    ]);
    expect(fallbackPath("a1")).toBe("provider/fallback/a1.json");
  });
});
