import { spyOn } from "bun:test";
import { executionClock } from "../../src/core/workflows/execution-clock.js";

/** Advance both clocks and deliver overdue callbacks, as the event loop does on wake. */
export function suspendClock() {
  const wall = Date.now.bind(Date);
  const mono = performance.now.bind(performance);
  let gap = 0;
  const date = spyOn(Date, "now").mockImplementation(() => wall() + gap);
  const performanceNow = spyOn(performance, "now").mockImplementation(() => mono() + gap);
  const timeouts = spyOn(globalThis, "setTimeout");
  const intervals = spyOn(globalThis, "setInterval");
  executionClock.now();
  return {
    jump(ms = 2 * 60 * 60_000, deadlineFirst = true) {
      gap += ms;
      const deadlines = timeouts.mock.calls.slice();
      const heartbeats = intervals.mock.calls.slice();
      // Leave unrelated short I/O timers to the real event loop.
      const dueDeadlines = () => {
        for (const [index, [callback, delay, ...args]] of deadlines.entries())
          if (typeof callback === "function" && Number(delay) >= 1000 && Number(delay) <= ms) {
            clearTimeout(timeouts.mock.results[index]?.value);
            callback(...args);
          }
      };
      const dueHeartbeats = () => {
        for (const [callback, delay, ...args] of heartbeats)
          if (typeof callback === "function" && Number(delay) >= 100 && Number(delay) <= ms)
            callback(...args);
      };
      if (deadlineFirst) { dueDeadlines(); dueHeartbeats(); }
      else { dueHeartbeats(); dueDeadlines(); }
    },
    restore() {
      timeouts.mockRestore();
      intervals.mockRestore();
      date.mockRestore();
      performanceNow.mockRestore();
      executionClock.now();
    },
  };
}
