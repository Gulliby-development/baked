import { describe, expect, test } from "bun:test";
import { baselineCreatedFilesScenario } from "./helpers/baseline-created-files-scenario.js";

// Cloud smoke 2026-10-21 (#1815): hexview, a `cargo init` crate with no Cargo.lock. The baseline
// `cargo clippy`/`cargo test` before approval created Cargo.lock after the baseline snapshot, and
// the run stopped `input_changed` ("Files changed outside the run: Cargo.lock") before any person
// saw the plan; only `resume --accept-workspace` continued it.

describe("a file a baseline check creates is part of the base (#1815)", () => {
  test("out.lock: the run reaches approval, the baseline lists the file, and the run completes", async () => {
    const result = await baselineCreatedFilesScenario(["out.lock"]);
    expect(result.approval).toEqual({ status: "waiting", reason: "approval" });
    expect(result.baseline?.createdByChecks).toEqual(["out.lock"]);
    expect(result.baselineIsSnapshot).toBe(true);
    expect(result.final.status).toBe("completed");
  }, 60000);

});
