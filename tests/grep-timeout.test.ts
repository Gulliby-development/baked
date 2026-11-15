import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getVendoredPath } from "../src/core/setup/install.js";
import { bakeGrepTool } from "../src/core/tools/bake-grep.js";
import { grepTool, searchLimits, searchOutcome, timedOutResult } from "../src/core/tools/grep.js";

// A search its timeout stopped answered "No matches found." for a directory that held matches: on
// a loaded Windows runner ripgrep took 11.6 s, was killed at 10 s and fell back to grep, which
// Windows lacks (#3037). A stopped search now says so, with the hits it printed before.
describe("a search stopped by its timeout (#3037)", () => {
  it("is told apart from an answer and from a failed search", () => {
    expect(searchOutcome(0, null)).toBe("answered");
    expect(searchOutcome(1, null)).toBe("answered");
    expect(searchOutcome(null, "SIGTERM")).toBe("timed-out");
    expect(searchOutcome(2, null)).toBe("failed");
  });

  it("never answers no matches, and keeps the hits it found", () => {
    const empty = timedOutResult("No matches found.");
    expect(empty.success).toBe(false);
    expect(empty.output).not.toContain("No matches found");
    expect(empty.output).toContain("Search stopped after");
    const partial = timedOutResult("src/a.ts:3:API_KEY");
    expect(partial.success).toBe(false);
    expect(partial.output).toContain("src/a.ts:3:API_KEY");
  });

  // A named pipe that no one writes keeps ripgrep (or grep) reading until its timeout stops it.
  // Windows has no mkfifo; the decision tests above cover it there.
  describe.skipIf(process.platform === "win32")("a search that cannot finish", () => {
    const TMP = join(tmpdir(), `grep-timeout-${String(process.pid)}-${String(Date.now())}`);
    const fifo = join(TMP, "never-written");
    const saved = searchLimits.timeoutMs;
    beforeAll(() => {
      mkdirSync(TMP, { recursive: true });
      writeFileSync(join(TMP, "a.txt"), "API_KEY here\n");
      const made = Bun.spawnSync(["mkfifo", fifo]);
      expect(made.exitCode).toBe(0);
      searchLimits.timeoutMs = 300;
    });
    afterAll(() => {
      searchLimits.timeoutMs = saved;
      rmSync(TMP, { recursive: true, force: true });
    });

    it("grep reports that it stopped, not that nothing matched", async () => {
      const result = await grepTool.execute({ pattern: "API_KEY", path: fifo });
      expect(result.success).toBe(false);
      expect(result.output).toContain("Search stopped after");
      expect(result.output).not.toContain("No matches found");
    });

    // bake_grep runs ripgrep alone: where it is missing (the macOS runner) the search cannot start,
    // which it says too, instead of "No matches found.".
    it("bake_grep reports that it stopped, or that it could not run, not that nothing matched", async () => {
      const result = await bakeGrepTool.createExecute()({ pattern: "API_KEY", path: fifo });
      expect(result.success).toBe(false);
      expect(result.output).not.toContain("No matches found");
      const hasRipgrep = getVendoredPath("rg") !== null || Bun.which("rg") !== null;
      expect(result.output).toContain(hasRipgrep ? "Search stopped after" : "Search could not run");
    });
  });
});
