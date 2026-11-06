import { afterEach, describe, expect, test } from "bun:test";
import { wholeUnitCascade } from "./helpers/whole-unit-cascade-scenario.js";

// Scenario of R101 turntrim c1633b0b (#2948, part 1): `lintr` was red on R/input.R, a file an
// earlier task wrote, and every later task's task-end check failed on it. Each failure opened a
// corrective of its own: 16 lintr correctives wrote the same edit set to R/input.R (3.79M tokens).
// One defect gets one corrective while its fix holds; when the fix does not hold, the second
// identical failure records the `repeated_failure` would-stop
// (`tests/workflow-scenario-repeated-failure.test.ts`).

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("scenario: R101 turntrim, a whole-unit check red on an earlier task's file (#2948)", () => {
  test("three later tasks of T001's R/input.R open one corrective, which runs before them", async () => {
    const run = await wholeUnitCascade({ chained: false, holds: true });
    cleanups.push(run.dispose);
    expect(run.done.status).toBe("completed");
    expect(run.correctives).toHaveLength(1);
    const [corrective] = run.correctives;
    expect(corrective?.writes.map((w) => w.path)).toContain("R/input.R");
    expect(run.sessions).toEqual(["T001", "T002", corrective?.id ?? "", "T003", "T004"]);
    expect(run.wouldStops).toEqual([]);
  }, 90000);

  test("a chain of later tasks whose corrective's fix holds records no repeat", async () => {
    const run = await wholeUnitCascade({ chained: true, holds: true });
    cleanups.push(run.dispose);
    expect(run.done.status).toBe("completed");
    expect(run.correctives).toHaveLength(1);
    expect(run.wouldStops).toEqual([]);
  }, 90000);
});
