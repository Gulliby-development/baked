import { describe, expect, test } from "bun:test";
import { EXECUTION_GAP_MS, EXECUTION_SAMPLE_MS, ExecutionClock } from "../src/core/workflows/execution-clock.js";

// Hot module provider-timers (#3006): the weekly mutation run left the clock's sample arithmetic
// and its gap boundaries untested. A gap is a wall or monotonic step longer than
// EXECUTION_GAP_MS; a step of exactly that length is still execution time.
function clockAt(start = 1_000_000) {
  const time = { wall: start, mono: 0 };
  const clock = new ExecutionClock(() => time.wall, () => time.mono);
  const step = (wall: number, mono = wall) => {
    time.wall += wall;
    time.mono += mono;
    return clock.now();
  };
  return { clock, step, start };
}

describe("execution clock boundaries (#3006)", () => {
  test("samples longer than one sample but inside the gap are credited in full", () => {
    // M6: a wall delta of `wall + lastWall` reads every sample as a gap and credits 1 s each.
    const { clock, step, start } = clockAt();
    for (let i = 0; i < 3; i++) step(5_000);
    expect(clock.now()).toBe(15_000);
    expect(clock.since(start)).toBe(15_000);
    expect(5_000).toBeGreaterThan(EXECUTION_SAMPLE_MS);
  });

  test("a step of exactly the gap length is execution time, not a missed heartbeat", () => {
    // M14: `>=` instead of `>` would credit one sample (1 s) for it.
    const { step } = clockAt();
    expect(step(EXECUTION_GAP_MS)).toBe(EXECUTION_GAP_MS);
  });

  test("a wall step of exactly the gap length is not recorded as a gap", () => {
    // M18: with `>=`, a 15 s wall step while the monotonic clock moved 1 s became a 14 s gap,
    // and `since` left it out.
    const { clock, step, start } = clockAt();
    expect(step(EXECUTION_GAP_MS, EXECUTION_SAMPLE_MS)).toBe(EXECUTION_SAMPLE_MS);
    expect(clock.since(start)).toBe(EXECUTION_GAP_MS);
  });

  test("one millisecond past the gap is a gap on either clock", () => {
    const wallGap = clockAt();
    expect(wallGap.step(EXECUTION_GAP_MS + 1, EXECUTION_SAMPLE_MS)).toBe(EXECUTION_SAMPLE_MS);
    expect(wallGap.clock.since(wallGap.start)).toBe(EXECUTION_SAMPLE_MS);
    const monoGap = clockAt();
    expect(monoGap.step(EXECUTION_GAP_MS + 1)).toBe(EXECUTION_SAMPLE_MS);
  });
});
