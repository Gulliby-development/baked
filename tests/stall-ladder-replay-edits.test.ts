import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openTrace, replayStallLadder } from "../src/core/workflows/trace.js";

// Bench round 69, md-site (#2196). The implement attempt of T007 edited three files, then its last
// call got no first response. The scheduler keeps the provider wait for an attempt that changed
// something (#1877), so the run took no rung; the replay walked the ladder anyway, because the
// effects table is not in a trace, and counted a fresh-session recovery the run never took.

const TRACE = join(import.meta.dir, "fixtures", "bench-traces", "R69", "md-site.sqlite.gz");
const RUN = "8f48cb88-3124-445d-affa-44f9fd6bd075";
const STALLED = "cb06fd41-108d-4d17-a661-2a429c5e0985";

describe("scenario: R69 md-site, a stall after file edits (#2196)", () => {
  test("the replay keeps the provider wait for an attempt with a pre-image, as the scheduler does", () => {
    const { store, dispose } = openTrace(TRACE);
    try {
      const edited = store
        .events(RUN, 0, 1_000_000)
        .filter((e) => e.type === "tool.phase" && e.payload.attemptId === STALLED && e.payload.phase === "pre_image");
      expect(edited.length).toBeGreaterThan(0);
      const boundary = replayStallLadder(store, RUN).find((b) => b.attemptId === STALLED);
      expect(boundary).toMatchObject({ stage: expect.any(String), recorded: "none", replayed: "none" });
    } finally {
      dispose();
    }
  }, 60_000);
});
