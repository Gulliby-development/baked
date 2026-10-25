import { afterEach, describe, expect, test } from "bun:test";
import { generateText } from "ai";
import { FirstByteHistory } from "../src/core/llm/first-byte-history.js";
import {
  ADAPTIVE_FIRST_BYTE_FLOOR_MS,
  adaptiveFirstByteMs,
  type CallTiming,
  promptChars,
  providerFirstByteMs,
  ProviderUnreachableError,
  withProviderHealth,
} from "../src/core/llm/provider-health.js";
import { canonical } from "../src/core/specs/hash.js";
import { isStall } from "../src/core/workflows/stall-ladder.js";
import { replayFirstBytes } from "../src/core/workflows/trace.js";
import { awakeClock } from "./helpers/awake-clock.js";
import { type Fault, faultyModel } from "./helpers/faulty-provider.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 66, nodepluck syntax (#2041). The analysis stage (codex, effort medium) audits every
// derivation of the spec in one silent call, so its first byte is its whole answer. Earlier
// analyses of the project (34 to 56 derivations) answered in 47 to 70 s, which set the shape's
// adaptive deadline to its 180 s floor. The analysis of 86 derivations took 181 to 185 s: it was
// cut off three times, then twice more after the respecify (85 derivations), and each ladder rung
// repeated the same input under the same deadline: 15.2 minutes on the initiative's critical path.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const MODEL = "codex/gpt-6.1-sol";
const SHAPE = { stage: "analysis", effort: "medium" } as const;
const CEILING = providerFirstByteMs("codex", SHAPE);

/** An analysis request: the stage's instructions and plan, then about a kilobyte per derivation. */
const request = (derivations: number) =>
  [
    "y".repeat(20_000),
    ...Array.from({ length: derivations }, (_, i) => `D-${i}: ${"x".repeat(1000)}`),
  ].join("\n");
/** The prompt size the provider-health layer measures for that request. */
const size = (derivations: number) =>
  promptChars([{ role: "user", content: [{ type: "text", text: request(derivations) }] }]) ?? 0;

/** The project's earlier analyses: base 56 derivations in 62 s, json 34 in 70 s, path 36 in 47 s. */
const EARLIER: [number, number][] = [
  [56, 62_000],
  [34, 70_000],
  [36, 47_000],
];
function seeded(sized = true): FirstByteHistory {
  const history = new FirstByteHistory();
  for (const [derivations, ms] of EARLIER)
    history.record(MODEL, {
      provider: "codex",
      ...SHAPE,
      firstByteMs: ms,
      durationMs: ms,
      ...(sized ? { promptChars: size(derivations) } : {}),
    });
  return history;
}

/** One analysis call of `derivations` through the workflow executor's deadline and history. */
async function analysis(history: FirstByteHistory, derivations: number, fault: Fault) {
  const clock = awakeClock();
  const faulty = faultyModel("codex", fault);
  cleanups.push(() => {
    faulty.restore();
    clock.restore();
  });
  const timings: CallTiming[] = [];
  let settled = false;
  const pending = generateText({
    model: withProviderHealth(faulty.model, MODEL, {
      stage: SHAPE.stage,
      firstByteLimit: (ceilingMs, call) => history.deadline(ceilingMs, MODEL, call),
      timing: (call) => {
        timings.push(call);
        history.record(MODEL, call);
      },
    }),
    prompt: request(derivations),
    maxRetries: 0,
    providerOptions: { codex: { reasoningEffort: SHAPE.effort, effort: SHAPE.effort } },
  })
    .then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    )
    .finally(() => {
      settled = true;
    });
  await Bun.sleep(5);
  return {
    advance: async (ms: number) => {
      clock.advance(ms);
      await Bun.sleep(5);
    },
    settled: () => settled,
    outcome: async () => ({ ...(await pending), timings }),
    /** Ends the call's simulated clock, so another call can start one. */
    restore: () => {
      faulty.restore();
      clock.restore();
    },
  };
}

describe("scenario: nodepluck syntax R66, a large silent analysis under the adaptive deadline (#2041)", () => {
  test("before the fix the shape's deadline was the 180 s floor, under the call's honest 183 s", () => {
    const history = seeded();
    expect(adaptiveFirstByteMs(CEILING, history.healthy(MODEL, SHAPE.stage, SHAPE.effort))).toBe(
      ADAPTIVE_FIRST_BYTE_FLOOR_MS,
    );
  });

  test("the analysis of 86 derivations gets a deadline for its size and answers on its first attempt", async () => {
    const history = seeded();
    const deadline = history.deadline(CEILING, MODEL, { ...SHAPE, promptChars: size(86) });
    expect(deadline).toBeGreaterThan(185_000);
    expect(deadline).toBeLessThan(CEILING);
    // A call of the size the shape already answered keeps the floor: only a larger one widens.
    expect(history.deadline(CEILING, MODEL, { ...SHAPE, promptChars: size(30) })).toBe(
      ADAPTIVE_FIRST_BYTE_FLOOR_MS,
    );
    const call = await analysis(history, 86, { kind: "slow", afterMs: 183_000 });
    await call.advance(185_000);
    const { result, error, timings } = await call.outcome();
    expect(error).toBeUndefined();
    expect(result?.text).toBe("OK");
    expect(timings[0]).toMatchObject({ firstByteMs: expect.any(Number), limitMs: deadline });
    expect(timings[0]?.promptChars).toBe(size(86));
  });

  test("a call cut off by an adaptive deadline gets the ceiling next, before the ladder repeats it", async () => {
    // A history without sizes (recorded before #2041) still gives the floor.
    const history = seeded(false);
    const first = await analysis(history, 86, { kind: "slow", afterMs: 183_000 });
    await first.advance(181_000);
    const cut = await first.outcome();
    expect(cut.error).toBeInstanceOf(ProviderUnreachableError);
    expect((cut.error as Error).message).toContain("180 seconds");
    expect(isStall(cut.error)).toBe(true);
    expect(cut.timings[0]).toMatchObject({ firstByteMs: null, limitMs: ADAPTIVE_FIRST_BYTE_FLOOR_MS });
    first.restore();

    // The next attempt of the shape (the ladder's fresh session) waits the ceiling and answers.
    expect(history.deadline(CEILING, MODEL, { ...SHAPE, promptChars: size(86) })).toBe(CEILING);
    const second = await analysis(history, 86, { kind: "slow", afterMs: 183_000 });
    await second.advance(185_000);
    const answered = await second.outcome();
    expect(answered.error).toBeUndefined();
    expect(answered.timings[0]).not.toHaveProperty("limitMs");
    // The answer ends the widening: the shape adapts again, now from a history that knows it.
    expect(history.healthy(MODEL, SHAPE.stage, SHAPE.effort).at(-1)?.ms).toBeGreaterThanOrEqual(183_000);
    history.record(MODEL, { provider: "codex", ...SHAPE, firstByteMs: null, durationMs: 400_000, limitMs: 366_000 });
    expect(history.deadline(CEILING, MODEL, SHAPE)).toBe(CEILING);
  });

  test("a call that really hangs after an expiry still ends at the ceiling", async () => {
    const history = seeded(false);
    history.record(MODEL, { provider: "codex", ...SHAPE, firstByteMs: null, durationMs: 181_000, limitMs: ADAPTIVE_FIRST_BYTE_FLOOR_MS });
    const hung = await analysis(history, 86, { kind: "hang" });
    await hung.advance(CEILING - 5_000);
    expect(hung.settled()).toBe(false);
    await hung.advance(7_000);
    const { error } = await hung.outcome();
    expect(error).toBeInstanceOf(ProviderUnreachableError);
    expect((error as Error).message).toContain(`${CEILING / 1000} seconds`);
    expect(isStall(error)).toBe(true);
  });
});

describe("the adaptive deadline replays on recorded calls (#2041)", () => {
  test("the R66 analyses replay as cut off under the rule before #2041, and answered under the current one", async () => {
    const fx = workflowFixture();
    cleanups.push(() => void fx.dispose());
    const run = await fx.start();
    await fx.service.drive(run.runId, new AbortController().signal);
    await fx.approve(run.runId);
    await fx.service.drive(run.runId, new AbortController().signal);
    const { store } = fx.service;
    const attempts = (
      store.connection
        .query("SELECT id, model_id FROM attempts WHERE run_id=? AND model_id IS NOT NULL ORDER BY started_at, rowid")
        .all(run.runId) as { id: string; model_id: string }[]
    ).slice(0, 4);
    expect(attempts).toHaveLength(4);
    const call = (fields: Partial<CallTiming>): CallTiming => ({ provider: "codex", ...SHAPE, firstByteMs: null, durationMs: 0, ...fields });
    // The recorded round: three answered analyses, then the 86-derivation one cut off three times
    // at the 180 s floor. Each record carries the inputs of its deadline, prompt size included.
    const recorded: CallTiming[][] = [
      EARLIER.map(([derivations, ms]) => call({ firstByteMs: ms, durationMs: ms, promptChars: size(derivations) })),
      [call({ durationMs: 181_000, limitMs: ADAPTIVE_FIRST_BYTE_FLOOR_MS, promptChars: size(86) })],
      [call({ durationMs: 183_000, limitMs: ADAPTIVE_FIRST_BYTE_FLOOR_MS, promptChars: size(86) })],
      [call({ durationMs: 183_000, limitMs: ADAPTIVE_FIRST_BYTE_FLOOR_MS, promptChars: size(86) })],
    ];
    store.transaction(() => {
      attempts.forEach((attempt, i) =>
        store.artifact(run.runId, "usage", `attempts/${attempt.id}/usage.json`, canonical({ calls: recorded[i] })),
      );
    });
    const stops = (boundaries: ReturnType<typeof replayFirstBytes>) =>
      (boundaries.get(run.runId) ?? []).filter((b) => b.recorded === "stop").map((b) => b.replayed);
    const before = replayFirstBytes(store, [run.runId], providerFirstByteMs, (history, ceilingMs, model, c) =>
      adaptiveFirstByteMs(ceilingMs, history.healthy(model, c.stage, c.effort).map((sample) => sample.ms)),
    );
    expect(stops(before)).toEqual(["stop", "stop", "stop"]);
    expect(stops(replayFirstBytes(store, [run.runId]))).toEqual(["pass", "pass", "pass"]);
  }, 60_000);
});

// Bench round 69, skillplumb (#2193). The plan call (codex/gpt-6-astra, medium, 142,929
// characters, a 23-task graph) ran out the 180 s floor three times. Each retry attempt opened with
// a short call of the same shape that answered in about 8 s, which cleared the #2041 ceiling
// before the large call, so attempts 2 and 3 recorded `limitMs: 180000` again. The shape had
// answered at most 82 s for 181k characters; this call needed 205 s.
describe("scenario: skillplumb R69, a retry's short first call does not clear the ceiling (#2193)", () => {
  const ASTRA = "codex/gpt-6-astra";
  const PLAN = { stage: "plan", effort: "medium" } as const;
  const PLAN_CEILING = providerFirstByteMs("codex", PLAN);
  const LARGE = 142_929;
  const planned = () => {
    const history = new FirstByteHistory();
    for (const [chars, ms] of [[60_000, 31_000], [90_000, 44_000], [120_000, 58_000], [181_000, 82_000], [75_000, 36_000], [100_000, 47_000], [140_000, 66_000], [50_000, 25_000]] as const)
      history.record(ASTRA, { provider: "codex", ...PLAN, firstByteMs: ms, durationMs: ms + 5_000, promptChars: chars });
    return history;
  };
  const expire = (history: FirstByteHistory, promptChars?: number) =>
    history.record(ASTRA, { provider: "codex", ...PLAN, firstByteMs: null, durationMs: 186_000, limitMs: ADAPTIVE_FIRST_BYTE_FLOOR_MS, ...(promptChars ? { promptChars } : {}) });
  const answer = (history: FirstByteHistory, ms: number, promptChars?: number) =>
    history.record(ASTRA, { provider: "codex", ...PLAN, firstByteMs: ms, durationMs: ms + 2_000, ...(promptChars ? { promptChars } : {}) });

  test("the large plan call keeps the ceiling through the next attempt's short answers until it answers itself", () => {
    const history = planned();
    expect(history.deadline(PLAN_CEILING, ASTRA, { ...PLAN, promptChars: LARGE })).toBe(ADAPTIVE_FIRST_BYTE_FLOOR_MS);
    expire(history, LARGE);
    expect(history.deadline(PLAN_CEILING, ASTRA, { ...PLAN, promptChars: LARGE })).toBe(PLAN_CEILING);
    // Attempt 2: its first call answers in 7.6 s, a continuation in 3 ms.
    answer(history, 7_564, 12_000);
    answer(history, 3, 13_000);
    // Before #2193 the heavy call was back on the 180 s floor here.
    expect(history.deadline(PLAN_CEILING, ASTRA, { ...PLAN, promptChars: LARGE })).toBe(PLAN_CEILING);
    // The large call answers at 205 s: the shape adapts again, from a history that knows it.
    answer(history, 205_334, LARGE);
    const after = history.deadline(PLAN_CEILING, ASTRA, { ...PLAN, promptChars: LARGE });
    expect(after).toBeLessThan(PLAN_CEILING);
    expect(after).toBeGreaterThan(205_334);
  });

  test("a call without a recorded size neither clears a sized expiry nor keeps an unsized one", () => {
    const sized = planned();
    expire(sized, LARGE);
    answer(sized, 8_000);
    expect(sized.deadline(PLAN_CEILING, ASTRA, { ...PLAN, promptChars: LARGE })).toBe(PLAN_CEILING);
    // An expiry recorded without a size (before #2041) clears on any answer, as it did.
    const unsized = planned();
    expire(unsized);
    answer(unsized, 8_000);
    expect(unsized.deadline(PLAN_CEILING, ASTRA, PLAN)).not.toBe(PLAN_CEILING);
  });
});
