import { describe, expect, test } from "bun:test";
import type { LedgerEntry } from "../scripts/flaky-ledger.ts";
import {
  aggregate,
  commentBody,
  freshOccurrences,
  issueBody,
  issueMarker,
  issueTitle,
  type Ledger,
  testKey,
} from "../scripts/flaky-issues.ts";

// #1724: the ledgers of recent OS tests runs become one Bug issue per flaky test.

const entry = (path: string[], verdict: LedgerEntry["verdict"], passes = 1, line = 4): LedgerEntry => ({
  file: "tests/workers.test.ts", line, path, reruns: verdict === "not rerun" ? 0 : 3, passes, verdict,
});
const ledger = (runId: string, os: string, at: string, tests: LedgerEntry[]): Ledger => ({
  schemaVersion: 1, commit: `c${runId}abcdefghij`, os, job: "test", runId, event: "merge_group", tests, at,
});

const listener = ["worker pool", "event listeners", "a throwing listener does not stop the others"];
const ledgers = [
  ledger("101", "win32", "2026-10-10T03:41:00Z", [entry(listener, "likely flaky", 2), entry(["other"], "real", 0)]),
  ledger("102", "darwin", "2026-10-12T03:41:00Z", [entry(listener, "likely flaky", 3, 9), entry(["once"], "likely flaky")]),
  ledger("103", "win32", "2026-10-15T03:41:00Z", [entry(listener, "real", 0), entry(["skipped"], "not rerun")]),
];

describe("flaky test issues", () => {
  test("a test is keyed by file and describe path, not by line, and counts only its flaky failures", () => {
    const [top, once] = aggregate(ledgers);
    expect(top).toMatchObject({ key: testKey({ file: "tests/workers.test.ts", path: listener }), real: 1 });
    expect(top?.flaky.map((o) => [o.runId, o.os, o.passes])).toEqual([["102", "darwin", 3], ["101", "win32", 2]]);
    expect(once?.flaky).toHaveLength(1);
    // A real-only test and one never rerun are not flaky.
    expect(aggregate(ledgers).map((t) => t.path[0])).toEqual(["worker pool", "once"]);
  });

  test("the issue names the test, its history and the marker that finds it again", () => {
    const [top] = aggregate(ledgers);
    if (!top) throw new Error("fixture has a flaky test");
    const body = issueBody("o/r", top, { days: 14, runs: 40 });
    expect(body.split("\n")[0]).toBe("Priority: P1");
    expect(body).toContain("failed in 2 `OS tests` runs of the last 14 days (40 runs in all)");
    expect(body).toContain("It also failed every rerun 1 times");
    expect(body).toContain("| [102](https://github.com/o/r/actions/runs/102) | darwin | merge_group | c102abcdef | 3/3 |");
    expect(body).toContain("Never skip, disable, quarantine or retry the test into green");
    expect(body).toEndWith(issueMarker(top.key));
    expect(issueTitle(top)).toBe(`Flaky test: ${listener.join(" > ")}`);
  });

  test("an issue gets only the failures it does not list, and a closed one only those after it closed", () => {
    const [top] = aggregate(ledgers);
    if (!top) throw new Error("fixture has a flaky test");
    const filed = issueBody("o/r", { ...top, flaky: top.flaky.slice(1) }, { days: 14, runs: 40 });
    expect(freshOccurrences(top, [filed], null).map((o) => o.runId)).toEqual(["102"]);
    expect(freshOccurrences(top, [filed, commentBody("o/r", top.flaky.slice(0, 1), false)], null)).toEqual([]);
    // Closed on 10-11: run 102 on 10-12 shows the fix did not hold; 101 predates it.
    expect(freshOccurrences(top, [], "2026-10-11T00:00:00Z").map((o) => o.runId)).toEqual(["102"]);
    expect(freshOccurrences(top, [], "2026-10-13T00:00:00Z")).toEqual([]);
    expect(commentBody("o/r", top.flaky.slice(0, 1), true)).toStartWith(
      "1 more likely flaky failure of this test, so the fix did not hold and the issue is reopened:",
    );
  });
});
