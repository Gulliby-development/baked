// Finds stuck pull requests and open issues nobody has taken: `bun scripts/pr-shepherd.ts
// [--idle-hours N] [--publish] [--json]`. A pull request is stuck when it conflicts with main, has a
// failing or hung check, or sits ready without auto-merge or a merge queue entry; an issue is
// unclaimed when it has no assignee, no "claimed" comment and no open pull request naming it, and
// no label says it waits on the owner. The report goes to stdout and the job summary; `--publish`
// also rewrites the body of one tracking issue, which the project's shepherd loop reads every run
// to fix those pull requests or hand them and the issues to a line. It only reads and reports:
// a merge queue entry made with the workflow token would never get its checks run.
import { appendFileSync } from "node:fs";

export const REPO = process.env.GITHUB_REPOSITORY ?? "Gulliby-development/baked";
/** Hours without an update after which a ready pull request outside the queue counts as idle. */
export const DEFAULT_IDLE_HOURS = 3;
/** Hours a check may stay in progress before it counts as hung (#2856 held one for 4.5 h). */
export const HUNG_CHECK_HOURS = 2;
/** Labels of issues that wait on the owner or are not work items. */
export const SKIP_LABELS = new Set(["needs-gulliby", "deferred", "idea", "verification", "smoke", "question", "wontfix", "duplicate"]);
export const MARKER = "<!-- pr-shepherd-report -->";
export const TRACKING_TITLE = "PR shepherd: stuck pull requests and unclaimed issues";

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
}

export interface PullInfo {
  number: number;
  title: string;
  draft: boolean;
  branch: string;
  author: string;
  updatedAt: string;
  autoMerge: boolean;
  queued: boolean;
  /** GitHub's mergeable_state: clean, dirty, blocked, behind, unstable, unknown, draft. */
  mergeableState: string;
  checks: CheckRun[];
  body: string;
}

export interface IssueInfo {
  number: number;
  title: string;
  labels: string[];
  assignees: string[];
  comments: string[];
}

export type StuckReason = "conflicts" | "failing checks" | "hung checks" | "no auto-merge" | "idle";

export interface StuckPull {
  number: number;
  title: string;
  branch: string;
  reasons: StuckReason[];
  failing: string[];
  idleHours: number;
}

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const hoursSince = (iso: string, now: Date): number => (now.getTime() - new Date(iso).getTime()) / 3_600_000;

/** Why a pull request is stuck, or nothing when it is moving or is a draft. */
export function stuckReasons(pull: PullInfo, now: Date, idleHours = DEFAULT_IDLE_HOURS): StuckReason[] {
  if (pull.draft) return [];
  const reasons: StuckReason[] = [];
  if (pull.mergeableState === "dirty") reasons.push("conflicts");
  if (pull.checks.some((c) => c.status === "completed" && c.conclusion && FAILED.has(c.conclusion)))
    reasons.push("failing checks");
  if (pull.checks.some((c) => c.status !== "completed" && c.started_at && hoursSince(c.started_at, now) > HUNG_CHECK_HOURS))
    reasons.push("hung checks");
  if (!pull.autoMerge && !pull.queued) reasons.push("no auto-merge");
  if (!pull.queued && hoursSince(pull.updatedAt, now) > idleHours) reasons.push("idle");
  return reasons;
}

/** Latest run per check name: a rerun that passed replaces the failure it retried. */
export function latestChecks(runs: readonly CheckRun[]): CheckRun[] {
  const byName = new Map<string, CheckRun>();
  for (const run of runs) {
    const seen = byName.get(run.name);
    if (!seen || (run.started_at ?? "") > (seen.started_at ?? "")) byName.set(run.name, run);
  }
  return [...byName.values()];
}

export function stuckPulls(pulls: readonly PullInfo[], now: Date, idleHours = DEFAULT_IDLE_HOURS): StuckPull[] {
  return pulls
    .map((p) => ({
      number: p.number,
      title: p.title,
      branch: p.branch,
      reasons: stuckReasons(p, now, idleHours),
      failing: p.checks.filter((c) => c.status === "completed" && c.conclusion && FAILED.has(c.conclusion)).map((c) => c.name),
      idleHours: Math.round(hoursSince(p.updatedAt, now)),
    }))
    .filter((s) => s.reasons.length > 0)
    .sort((a, b) => b.reasons.length - a.reasons.length || b.idleHours - a.idleHours);
}

const CLAIM = /\bclaim(?:ed|ing)?\b|\bберу\b|\bвзял[аи]?\b/i;

/** Issue numbers an open pull request names in its title or body (Fixes #N, Refs #N, #N). */
export function referencedIssues(pulls: readonly Pick<PullInfo, "title" | "body">[]): Set<number> {
  const numbers = new Set<number>();
  for (const pull of pulls)
    for (const match of `${pull.title}\n${pull.body}`.matchAll(/#(\d+)\b/g)) numbers.add(Number(match[1]));
  return numbers;
}

const PRIORITY = ["Priority: P1", "Priority: P2", "Priority: P3"];
const rank = (issue: IssueInfo): number => {
  const p = PRIORITY.findIndex((label) => issue.labels.includes(label));
  const kind = issue.labels.includes("bug") ? 0 : issue.labels.includes("flaky-test") ? 1 : 2;
  return (p < 0 ? PRIORITY.length : p) * 10 + kind;
};

/** Open issues nobody has taken that a line can take without the owner, the most urgent first. */
export function unclaimedIssues(issues: readonly IssueInfo[], taken: ReadonlySet<number>): IssueInfo[] {
  return issues
    .filter((i) => !i.labels.some((l) => SKIP_LABELS.has(l)))
    .filter((i) => i.assignees.length === 0 && !taken.has(i.number) && !i.comments.some((c) => CLAIM.test(c)))
    .sort((a, b) => rank(a) - rank(b) || b.number - a.number);
}

export function report(stuck: readonly StuckPull[], unclaimed: readonly IssueInfo[], now: Date): string {
  const lines = [MARKER, `Updated ${now.toISOString().slice(0, 16).replace("T", " ")} UTC by \`scripts/pr-shepherd.ts\`.`, ""];
  lines.push(`## Stuck pull requests (${stuck.length})`, "");
  if (stuck.length === 0) lines.push("None.");
  else {
    lines.push("| PR | Why | Failing checks | Idle h | Branch |", "| --- | --- | --- | --- | --- |");
    for (const s of stuck)
      lines.push(`| #${s.number} ${s.title.replaceAll("|", "\\|")} | ${s.reasons.join(", ")} | ${s.failing.join(", ") || "-"} | ${s.idleHours} | \`${s.branch}\` |`);
  }
  lines.push("", `## Unclaimed issues (${unclaimed.length})`, "");
  if (unclaimed.length === 0) lines.push("None.");
  else for (const i of unclaimed) lines.push(`- #${i.number} ${i.title}${i.labels.length ? ` (${i.labels.join(", ")})` : ""}`);
  return `${lines.join("\n")}\n`;
}

async function gh<T>(path: string, ...args: string[]): Promise<T> {
  const proc = Bun.spawn(["gh", "api", ...args, path], { stdout: "pipe", stderr: "inherit" });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`gh api ${path} failed`);
  return JSON.parse(text) as T;
}

type Json = any;

async function fetchPulls(): Promise<PullInfo[]> {
  const list = await gh<Json[]>(`repos/${REPO}/pulls?state=open&per_page=100`);
  const queueRefs = await gh<Json[]>(`repos/${REPO}/git/matching-refs/heads/gh-readonly-queue`).catch(() => []);
  const queued = new Set(queueRefs.map((r) => Number(/\/pr-(\d+)-/.exec(r.ref)?.[1])));
  return Promise.all(
    list.map(async (p): Promise<PullInfo> => {
      const [detail, runs] = await Promise.all([
        gh<Json>(`repos/${REPO}/pulls/${p.number}`),
        gh<Json>(`repos/${REPO}/commits/${p.head.sha}/check-runs?per_page=100`),
      ]);
      return {
        number: p.number,
        title: p.title,
        draft: p.draft,
        branch: p.head.ref,
        author: p.user.login,
        updatedAt: p.updated_at,
        autoMerge: p.auto_merge != null,
        queued: queued.has(p.number),
        mergeableState: detail.mergeable_state ?? "unknown",
        checks: latestChecks(runs.check_runs ?? []),
        body: p.body ?? "",
      };
    }),
  );
}

async function fetchIssues(): Promise<IssueInfo[]> {
  const list = (await gh<Json[]>(`repos/${REPO}/issues?state=open&per_page=100`)).filter((i) => !i.pull_request);
  return Promise.all(
    list.map(async (i): Promise<IssueInfo> => ({
      number: i.number,
      title: i.title,
      labels: i.labels.map((l: Json) => l.name),
      assignees: i.assignees.map((a: Json) => a.login),
      comments: i.comments ? (await gh<Json[]>(`repos/${REPO}/issues/${i.number}/comments?per_page=100`)).map((c) => c.body ?? "") : [],
    })),
  );
}

async function publish(body: string): Promise<void> {
  const open = await gh<Json[]>(`repos/${REPO}/issues?state=open&per_page=100&creator=github-actions%5Bbot%5D`).catch(() => []);
  const existing = open.find((i) => (i.body ?? "").includes(MARKER));
  if (existing) await gh(`repos/${REPO}/issues/${existing.number}`, "-X", "PATCH", "-f", `body=${body}`);
  else await gh(`repos/${REPO}/issues`, "-X", "POST", "-f", `title=${TRACKING_TITLE}`, "-f", `body=${body}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const idleIndex = args.indexOf("--idle-hours");
  const idleHours = idleIndex >= 0 ? Number(args[idleIndex + 1]) : DEFAULT_IDLE_HOURS;
  const now = new Date();
  const [pulls, issues] = await Promise.all([fetchPulls(), fetchIssues()]);
  const stuck = stuckPulls(pulls, now, idleHours);
  const unclaimed = unclaimedIssues(issues, referencedIssues(pulls));
  if (args.includes("--json")) console.log(JSON.stringify({ stuck, unclaimed: unclaimed.map(({ comments: _, ...i }) => i) }, null, 2));
  else {
    const body = report(stuck, unclaimed, now);
    console.log(body);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
    if (args.includes("--publish")) await publish(body);
  }
}
