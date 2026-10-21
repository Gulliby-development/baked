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


  test("a cache file a check writes after approval is not a change outside the run", async () => {
    // A task adds a module; the next pytest run writes its `.pyc` into an unignored __pycache__/.
    const result = await baselineCreatedFilesScenario(["src/__pycache__/app.cpython-312.pyc"], null, ["src/__pycache__/helper.cpython-312.pyc", ".pytest_cache/v/cache/lastfailed"]);
    expect(result.approval).toEqual({ status: "waiting", reason: "approval" });
    // Without the cache rule the check was inconclusive (`source_changed`) and the run blocked.
    expect(result.final.status).toBe("completed");
    expect(result.baseline?.createdByChecks).toBeUndefined();
  }, 60000);
});
