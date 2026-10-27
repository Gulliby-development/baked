import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoFormatOutcome,
  FORMAT_TIMEOUT_SKIP_AFTER,
  formatTimeoutNote,
  formatTimeoutOf,
  formatTimeoutsUnder,
  recordFormatTimeout,
  resetFormatCache,
  setFormatCache,
} from "../src/core/tools/auto-format.js";
import { appendAutoFormatResult } from "../src/core/tools/post-edit-helpers.js";

// #2242 (R71 evalpin json): rustfmt never finished on a 20-deep literal in tests/json.rs, and each
// edit of the file waited the 30 s format deadline in silence; the checks stage learned nothing.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A formatter that marks each start, then never finishes within the test's deadline. */
function hangingFormatter(): { root: string; file: string; starts: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "baked-format-timeout-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "tests"));
  const file = join(root, "tests", "json.rs");
  writeFileSync(file, "fn main() {}\n");
  const starts = join(root, "starts.log");
  setFormatCache(
    `bun -e "require('fs').appendFileSync('${starts.replace(/\\/g, "/")}', 'x'); await Bun.sleep(5000)"`,
    500,
  );
  cleanups.push(resetFormatCache);
  return { root, file, starts };
}

describe("post-edit format timeouts (#2242)", () => {
  it("says the formatter timed out, then stops formatting the file after the second timeout", async () => {
    const { file, starts } = hangingFormatter();
    const first = await appendAutoFormatResult(file, "fn main() {}\n", "Edited tests/json.rs", undefined, null);
    expect(first).toContain("bun did not finish within 1 s on");
    expect(first).toContain("json.rs, so the file was not formatted");
    expect(first).not.toContain("no longer formatted");
    expect(formatTimeoutOf(file)?.count).toBe(1);

    const second = await appendAutoFormatResult(file, "fn main() {}\n", "Edited", undefined, null);
    expect(second).toContain("timed out 2 times, so edits of this file are no longer formatted");
    expect(formatTimeoutOf(file)?.count).toBe(FORMAT_TIMEOUT_SKIP_AFTER);

    // The third edit runs no formatter (a slow start on Windows may not reach the mark) and says nothing more.
    const started = () => (existsSync(starts) ? readFileSync(starts, "utf8") : "");
    const before = started();
    const third = await appendAutoFormatResult(file, "fn main() {}\n", "Edited", undefined, null);
    expect(third).toBe("Edited");
    expect(await autoFormatOutcome(file, undefined, null)).toEqual({ kind: "skipped-after-timeouts" });
    await Bun.sleep(300);
    expect(started()).toBe(before);
  }, 30000);

  it("names a timeout of the probe and the write alike, and only a timeout", () => {
    const timeout = recordFormatTimeout("/w/tests/json.rs", "uv run ruff format", 30_000);
    cleanups.push(resetFormatCache);
    expect(timeout.formatter).toBe("ruff");
    expect(formatTimeoutNote({ kind: "timed-out", timeout }, "tests/json.rs")).toStartWith(
      "⚠ ruff did not finish within 30 s on tests/json.rs, so the file was not formatted",
    );
    for (const kind of ["formatted", "skipped", "skipped-after-timeouts"] as const)
      expect(formatTimeoutNote({ kind }, "tests/json.rs")).toBeNull();
    expect(recordFormatTimeout("/w/a.ts", "bunx prettier --write", 30_000).formatter).toBe("prettier");
  });

  it("lists the recorded files under a directory by their relative path", () => {
    const { root, file } = hangingFormatter();
    recordFormatTimeout(file, "rustfmt", 30_000);
    recordFormatTimeout(join(tmpdir(), "elsewhere.rs"), "rustfmt", 30_000);
    expect([...formatTimeoutsUnder(root).keys()]).toEqual(["tests/json.rs"]);
  });
});
