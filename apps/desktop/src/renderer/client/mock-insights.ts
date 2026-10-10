import type {
  AttemptUsageRow,
  FeatureState,
  InitiativeFeature,
  InitiativeStatus,
  InitiativeView,
  RunUsageReport,
  UsageGroup,
  UsageGroupBy,
  UsageSummary,
} from "./insights.js";
import { type MockRoute, response } from "./mock-routes.js";

function feature(
  id: string,
  title: string,
  state: FeatureState,
  extra: Partial<InitiativeFeature> = {},
): InitiativeFeature {
  const started = state !== "waiting" && state !== "proposed";
  return {
    id,
    title,
    mandatory: true,
    dependsOn: [],
    state,
    runId: started ? `run-${id}` : null,
    runStatus: started ? (state === "accepted" ? "completed" : "running") : null,
    blockers: [],
    pendingRequests: [],
    usage: { tokens: started ? 240_000 : 0, calls: started ? 12 : 0, activeMs: 0 },
    ...extra,
  };
}

function initiative(
  initiativeId: string,
  title: string,
  status: InitiativeStatus,
  goals: string[],
  features: InitiativeFeature[],
  next: string,
): InitiativeView {
  const used = features.reduce((sum, f) => sum + f.usage.tokens, 0);
  return {
    initiativeId,
    title,
    status,
    reason: "",
    revision: 7,
    planRevision: 2,
    goals,
    features,
    pendingDecisions:
      status === "awaiting_approval"
        ? [
            {
              scope: "initiative",
              featureId: null,
              runId: null,
              requestId: `${initiativeId}-split`,
              kind: "split_approval",
              digest: "0".repeat(64),
            },
          ]
        : features.flatMap((f) => f.pendingRequests),
    budget: {
      limits: { maxTotalTokens: 6_000_000, maxAgentCalls: 400, maxActiveMs: 8 * 3_600_000 },
      used: { tokens: used, calls: 0, activeMs: 0 },
    },
    next: { kind: "drive", featureId: null, runId: null, message: next },
  };
}

const INITIATIVES: Record<string, InitiativeView[]> = {
  baked: [
    initiative(
      "desktop-app",
      "Desktop app",
      "active",
      [
        "A desktop front end over the same core as the terminal UI: sessions, workflow runs, approvals and reports.",
      ],
      [
        feature("event-bridge", "Core event bridge for a second front end", "accepted"),
        feature("app-shell", "App shell and session list", "accepted", {
          dependsOn: ["event-bridge"],
        }),
        feature("chat-view", "Chat view with tool calls and diffs", "in_progress", {
          dependsOn: ["app-shell"],
          runStatus: "implement",
        }),
        feature("run-view", "Workflow run view and approvals", "needs_decision", {
          dependsOn: ["app-shell"],
          pendingRequests: [
            {
              scope: "feature",
              featureId: "run-view",
              runId: "run-run-view",
              requestId: "run-view-plan",
              kind: "approval",
              digest: "1".repeat(64),
            },
          ],
        }),
        feature("usage-reports", "Usage reports", "waiting", { dependsOn: ["run-view"] }),
        feature("installers", "Installers for Windows, macOS, Linux", "waiting", {
          dependsOn: ["app-shell"],
        }),
      ],
      "Waiting for a decision on run-view",
    ),
    initiative(
      "headless-automation",
      "Headless automation",
      "awaiting_approval",
      ["Every workflow command scriptable from CI with JSON output and stable exit codes."],
      [
        feature("json-output", "JSON output for every command", "proposed"),
        feature("exit-codes", "Stable exit codes", "proposed"),
        feature("ci-recipes", "CI recipes", "proposed", { dependsOn: ["json-output"] }),
        feature("non-interactive", "Non-interactive approvals", "proposed"),
      ],
      "Approve the split to start feature runs",
    ),
    initiative(
      "provider-router-v2",
      "Provider router v2",
      "decomposing",
      ["Route each stage to the model that fits it, with fallbacks."],
      [],
      "Splitting the request into features",
    ),
    initiative(
      "locale-coverage",
      "Locale coverage",
      "completed",
      ["Every user-facing string translated in every shipped locale."],
      [
        feature("extract-keys", "Extract keys from source", "accepted"),
        feature("validate-locales", "Validate locales in CI", "accepted"),
        feature("fill-gaps", "Fill missing translations", "accepted"),
      ],
      "Done",
    ),
  ],
};

function list(key: string): InitiativeView[] {
  INITIATIVES[key] ??= [];
  return INITIATIVES[key] ?? [];
}

const initiativeRoutes: MockRoute = ({ key, method, path }) => {
  if (method === "GET" && path === "/v1/initiatives")
    return response(200, {
      initiatives: list(key).map((view) => ({
        initiativeId: view.initiativeId,
        title: view.title,
        status: view.status,
        features: view.features.length,
        next: view.next,
      })),
    });
  const match = /^\/v1\/initiatives\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
  if (!match?.[1]) return undefined;
  const views = list(key);
  const index = views.findIndex((v) => v.initiativeId === decodeURIComponent(match[1] ?? ""));
  const view = views[index];
  if (!view) return response(404, { error: { code: "NOT_FOUND", message: "No such initiative" } });
  const action = match[2];
  if (method === "GET" && action === undefined) return response(200, view);
  if (method !== "POST") return undefined;
  const status: InitiativeStatus | undefined =
    action === "pause"
      ? "paused"
      : action === "resume" || action === "approve"
        ? "active"
        : undefined;
  if (!status) return undefined;
  const next: InitiativeView = {
    ...view,
    status,
    revision: view.revision + 1,
    pendingDecisions: action === "approve" ? [] : view.pendingDecisions,
    features:
      action === "approve"
        ? view.features.map((f) => (f.state === "proposed" ? { ...f, state: "waiting" } : f))
        : view.features,
  };
  views[index] = next;
  return response(200, next);
};

const STAGES: [string, number, string][] = [
  ["research", 198_000, "claude-haiku-5-5"],
  ["specify", 88_000, "claude-sonnet-5-5"],
  ["plan", 81_000, "claude-sonnet-5-5"],
  ["analyze", 45_000, "claude-sonnet-5-5"],
  ["task-T001", 412_000, "claude-sonnet-5-5"],
  ["task-T002", 290_000, "claude-sonnet-5-5"],
  ["checks", 0, ""],
  ["review", 183_000, "gpt-5.1"],
  ["converge", 83_000, "gpt-5.1"],
];

function attempts(runId: string, scale: number): AttemptUsageRow[] {
  return STAGES.map(([stage, tokens, model], i) => ({
    attemptId: `${runId}-a${i}`,
    stage,
    model: model || null,
    status: "succeeded",
    usedTokens: Math.round(tokens * scale),
    cacheReadTokens: Math.round(tokens * scale * (0.6 + (i % 3) * 0.05)),
  }));
}

const RUN_SCALE: Record<string, number> = {
  "run-usage-totals": 0.4,
  "run-headless-json": 0.1,
  "run-locale-validation": 0.6,
  "run-guide-refresh": 0.25,
  "run-pricing-table": 0.2,
};

function summary(days: number, groupBy: UsageGroupBy): UsageSummary {
  const scale = Math.min(days, 30) / 7;
  const rows = Object.keys(RUN_SCALE).flatMap((runId) =>
    attempts(runId, (RUN_SCALE[runId] ?? 0) * scale).map((a) => ({ ...a, runId })),
  );
  const groups = new Map<string, UsageGroup & { ids: Set<string> }>();
  for (const row of rows) {
    const key = groupBy === "model" ? (row.model ?? "(host)") : row.stage;
    const group = groups.get(key) ?? {
      key,
      runs: 0,
      attempts: 0,
      tokens: 0,
      cacheReadTokens: 0,
      ids: new Set<string>(),
    };
    group.ids.add(row.runId);
    group.attempts++;
    group.tokens += row.usedTokens ?? 0;
    group.cacheReadTokens += row.cacheReadTokens ?? 0;
    groups.set(key, group);
  }
  return {
    days,
    since: Date.now() - days * 86_400_000,
    groupBy,
    runs: Object.keys(RUN_SCALE).length,
    attempts: rows.length,
    totalTokens: rows.reduce((sum, r) => sum + (r.usedTokens ?? 0), 0),
    cacheReadTokens: rows.reduce((sum, r) => sum + (r.cacheReadTokens ?? 0), 0),
    groups: [...groups.values()]
      .map(({ ids, ...group }) => ({ ...group, runs: ids.size }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}

const usageRoutes: MockRoute = ({ method, path, query }) => {
  if (method !== "GET") return undefined;
  if (path === "/v1/usage") {
    const groupBy = (query.get("groupBy") ?? "model") as UsageGroupBy;
    return response(200, summary(Number(query.get("days") ?? 7), groupBy));
  }
  const match = /^\/v1\/workflow\/runs\/([^/]+)\/usage$/.exec(path);
  if (!match?.[1]) return undefined;
  const runId = decodeURIComponent(match[1]);
  const rows = attempts(runId, RUN_SCALE[runId] ?? 0.3);
  const report: RunUsageReport = {
    runId,
    totalTokens: rows.reduce((sum, r) => sum + (r.usedTokens ?? 0), 0),
    attempts: rows,
  };
  return response(200, report);
};

export const INSIGHTS_ROUTES: MockRoute[] = [initiativeRoutes, usageRoutes];
