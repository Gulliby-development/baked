import { describe, expect, test } from "bun:test";
import {
  type CheckRun,
  type IssueInfo,
  latestChecks,
  MARKER,
  type PullInfo,
  referencedIssues,
  report,
  stuckPulls,
  stuckReasons,
  unclaimedIssues,
} from "../scripts/pr-shepherd.ts";

const now = new Date("2026-11-06T14:00:00Z");
const check = (name: string, conclusion: string | null, started = "2026-11-06T13:00:00Z", status = "completed"): CheckRun => ({
  name, status, conclusion, started_at: started,
});
const pull = (over: Partial<PullInfo>): PullInfo => ({
  number: 1, title: "t", draft: false, branch: "feature/x", author: "a", updatedAt: "2026-11-06T13:30:00Z",
  autoMerge: true, queued: false, mergeableState: "blocked", checks: [check("check", "success")], body: "", ...over,
});
const issue = (number: number, over: Partial<IssueInfo> = {}): IssueInfo => ({
  number, title: `issue ${number}`, labels: [], assignees: [], comments: [], ...over,
});

describe("pr shepherd", () => {
  test("a moving pull request with auto-merge, a queued one and a draft are not stuck", () => {
    expect(stuckReasons(pull({}), now)).toEqual([]);
    expect(stuckReasons(pull({ autoMerge: false, queued: true, updatedAt: "2026-11-05T00:00:00Z" }), now)).toEqual([]);
    expect(stuckReasons(pull({ draft: true, mergeableState: "dirty" }), now)).toEqual([]);
  });

  test("conflicts, failing and hung checks, missing auto-merge and idleness are each named", () => {
    const stuck = pull({
      mergeableState: "dirty", autoMerge: false, updatedAt: "2026-11-06T08:00:00Z",
      checks: [check("lint", "failure"), check("Builds", null, "2026-11-06T09:00:00Z", "in_progress")],
    });
    expect(stuckReasons(stuck, now)).toEqual(["conflicts", "failing checks", "hung checks", "no auto-merge", "idle"]);
    expect(stuckPulls([pull({ number: 2 }), { ...stuck, number: 3 }], now)).toMatchObject([{ number: 3, failing: ["lint"], idleHours: 6 }]);
  });

  test("a rerun that passed replaces the failure it retried", () => {
    const runs = latestChecks([check("test", "failure", "2026-11-06T12:00:00Z"), check("test", "success", "2026-11-06T13:00:00Z")]);
    expect(runs).toEqual([check("test", "success", "2026-11-06T13:00:00Z")]);
  });

  test("an issue is taken by an assignee, a claim comment or an open pull request naming it", () => {
    const taken = referencedIssues([{ title: "Fix it", body: "Fixes #5, refs #6" }]);
    const issues = [
      issue(4, { assignees: ["Gulliby"] }),
      issue(5),
      issue(7, { comments: ["Claimed by the CI/infra line."] }),
      issue(8, { labels: ["needs-gulliby"] }),
      issue(9, { labels: ["deferred"] }),
      issue(10, { labels: ["flaky-test"] }),
      issue(11, { labels: ["bug", "Priority: P1"] }),
      issue(12, { comments: ["Root cause still unknown."] }),
    ];
    expect(unclaimedIssues(issues, taken).map((i) => i.number)).toEqual([11, 10, 12]);
  });

  test("the report carries the marker the tracking issue is found by", () => {
    const text = report([], [issue(3, { labels: ["bug"] })], now);
    expect(text.startsWith(MARKER)).toBe(true);
    expect(text).toContain("## Stuck pull requests (0)");
    expect(text).toContain("- #3 issue 3 (bug)");
  });
});
