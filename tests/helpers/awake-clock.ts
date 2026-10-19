import { spyOn } from "bun:test";
import { executionClock } from "../../src/core/workflows/execution-clock.js";

/** Deliver timers every simulated second, so an awake outage cannot look like host suspend. */
export function awakeClock() {
  const wall = Date.now.bind(Date);
  const mono = performance.now.bind(performance);
  const timeout = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const interval = globalThis.setInterval;
  const clearIntervalReal = globalThis.clearInterval;
  let elapsed = 0;
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; every?: number; fire: () => void }>();
  const date = spyOn(Date, "now").mockImplementation(() => wall() + elapsed);
  const performanceNow = spyOn(performance, "now").mockImplementation(() => mono() + elapsed);
  const timeouts = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, delay = 0, ...args: unknown[]) => {
    const id = timeout(fn, delay, ...args);
    // A deadline's final poll can be just below one second after real callback overhead.
    // Leaving that poll on real time lets a later simulated answer beat the deadline.
    if (delay > 0) timers.set(id, { at: elapsed + delay, fire: () => fn(...args) });
    return id;
  }) as typeof setTimeout);
  const intervals = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, delay = 0, ...args: unknown[]) => {
    const id = interval(fn, delay, ...args);
    if (delay >= 100) timers.set(id, { at: elapsed + delay, every: delay, fire: () => fn(...args) });
    return id;
  }) as typeof setInterval);
  const clears = spyOn(globalThis, "clearTimeout").mockImplementation((id) => {
    timers.delete(id as ReturnType<typeof setTimeout>);
    clear(id);
  });
  const clearIntervals = spyOn(globalThis, "clearInterval").mockImplementation((id) => {
    timers.delete(id as ReturnType<typeof setTimeout>);
    clearIntervalReal(id);
  });
  return {
    advance(ms: number) {
      for (let left = ms; left > 0; left -= 1000) {
        elapsed += Math.min(left, 1000);
        executionClock.now();
        for (const [id, timer] of [...timers]) {
          if (timer.at > elapsed || !timers.has(id)) continue;
          if (timer.every) timer.at = elapsed + timer.every;
          else { timers.delete(id); clear(id); }
          timer.fire();
        }
      }
    },
    restore() {
      timeouts.mockRestore(); intervals.mockRestore(); clears.mockRestore(); clearIntervals.mockRestore();
      date.mockRestore(); performanceNow.mockRestore(); executionClock.now();
    },
  };
}
