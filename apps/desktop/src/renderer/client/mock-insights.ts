import type {
  AttemptUsageRow,
  FeatureState,
  InitiativeFeature,
  InitiativeStatus,
  InitiativeView,
  RunUsageReport,
  UsageDimension,
  UsageFigures,
  UsageGroup,
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
    approvedPlanRevision: status === "awaiting_approval" || status === "decomposing" ? null : 2,
    workflowId: "sdd",
    featureAutoApproval: null,
    model: null,
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
      remaining: { tokens: 6_000_000 - used, calls: 400, activeMs: 8 * 3_600_000 },
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

type Body = Record<string, unknown>;
const refuse = (message: string) => response(400, { error: { code: "INVALID_REQUEST", message } });
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && value > 0 ? value : undefined;

/** A started initiative: the mock splits at once into three proposed features. */
function started(body: Body): InitiativeView | string {
  const id = text(body.initiativeId);
  const prompt = text(body.prompt);
  if (!id || !prompt) return "initiativeId and prompt are required";
  const title = prompt.split(/[.\n]/)[0]?.slice(0, 60) || id;
  const view = initiative(
    id,
    title,
    "awaiting_approval",
    [prompt],
    [
      feature("core", "Core model and storage", "proposed"),
      feature("api", "Local API endpoints", "proposed", { dependsOn: ["core"] }),
      feature("ui", "Terminal and desktop screens", "proposed", { dependsOn: ["api"] }),
    ],
    "Approve the split to start feature runs",
  );
  const budget = body.budget as { tokens?: number; calls?: number; timeMs?: number } | undefined;
  const tiered = body.tieredApproval as { maxTasks: number; maxFiles: number } | undefined;
  return {
    ...view,
    revision: 1,
    planRevision: 1,
    model: text(body.model) ?? null,
    workflowId: text(body.workflow) ?? "sdd",
    featureAutoApproval: tiered ?? null,
    budget: budget
      ? {
          ...view.budget,
          limits: {
            maxTotalTokens: budget.tokens ?? 0,
            maxAgentCalls: budget.calls ?? 0,
            maxActiveMs: budget.timeMs ?? 0,
          },
        }
      : view.budget,
  };
}

/** Applies a split edit the way the core does, or says why it is refused. */
function edited(view: InitiativeView, action: string, body: Body): InitiativeFeature[] | string {
  const editable =
    view.status === "awaiting_approval" ||
    (view.status === "paused" && view.approvedPlanRevision != null);
  if (!editable) return "The split can be edited only before approval or while paused";
  const features = view.features;
  const find = (id: unknown) => features.find((f) => f.id === id);
  let next: InitiativeFeature[];
  if (action === "rename") {
    const target = find(body.feature);
    const title = text(body.title);
    if (!target || !title) return "Unknown feature or empty title";
    next = features.map((f) => (f === target ? { ...f, title } : f));
  } else if (action === "remove") {
    const target = find(body.feature);
    if (!target) return "Unknown feature";
    next = features
      .filter((f) => f !== target)
      .map((f) => ({ ...f, dependsOn: f.dependsOn.filter((d) => d !== target.id) }));
  } else if (action === "merge") {
    const ids = strings(body.features);
    const merged = features.filter((f) => ids.includes(f.id));
    if (merged.length < 2) return "Merge needs two different features";
    const id = text(body.id) ?? merged[0]?.id ?? "";
    const combined = feature(
      id,
      text(body.title) ?? merged.map((f) => f.title).join(" + "),
      "proposed",
    );
    const at = features.findIndex((f) => ids.includes(f.id));
    next = features.flatMap((f, i) =>
      i === at
        ? [combined]
        : ids.includes(f.id)
          ? []
          : [{ ...f, dependsOn: f.dependsOn.map((d) => (ids.includes(d) ? id : d)) }],
    );
  } else if (action === "split") {
    const target = find(body.feature);
    const parts = Array.isArray(body.parts) ? (body.parts as { id: string; title: string }[]) : [];
    if (!target || parts.length < 2) return "Split needs a feature and two or more parts";
    next = features.flatMap((f) =>
      f === target
        ? parts.map((p) => feature(p.id, p.title, "proposed", { dependsOn: target.dependsOn }))
        : [f],
    );
  } else return "Unknown edit";
  if (next.length < 3) return "An initiative needs at least 3 features";
  if (next.length > 12) return "An initiative holds at most 12 features";
  return next;
}

/** The answer to a POST that is not pause, resume, approve or reroute; undefined when none. */
function command(view: InitiativeView, action: string | undefined, body: Body) {
  const bump = { revision: view.revision + 1 };
  switch (action) {
    case "merge":
    case "split":
    case "remove":
    case "rename": {
      const features = edited(view, action, body);
      if (typeof features === "string") return features;
      return {
        ...view,
        ...bump,
        planRevision: view.planRevision + 1,
        features,
        // Each revision gets a new split approval request, also after a rejection.
        pendingDecisions: [
          ...view.pendingDecisions.filter((d) => d.scope !== "initiative"),
          ...(view.status === "awaiting_approval"
            ? [
                {
                  scope: "initiative" as const,
                  featureId: null,
                  runId: null,
                  requestId: `${view.initiativeId}-split-${view.planRevision + 1}`,
                  kind: "split_approval",
                  digest: `digest-${view.planRevision + 1}`,
                },
              ]
            : []),
        ],
      };
    }
    case "reject": {
      const reason = text(body.reason);
      if (!reason || view.status !== "awaiting_approval") return "No split approval is pending";
      // As in the core: the split stays waiting until it is edited into a new revision.
      return {
        ...view,
        ...bump,
        reason: `Split rejected: ${reason}. Edit the split to propose a new revision.`,
        pendingDecisions: view.pendingDecisions.filter((d) => d.scope !== "initiative"),
      };
    }
    case "replan": {
      const target = view.features.find((f) => f.id === body.feature);
      if (!target?.runId || target.runStatus === "running")
        return "This feature cannot be re-planned now";
      return {
        ...view,
        ...bump,
        features: view.features.map((f) =>
          f === target
            ? { ...f, state: "in_progress" as const, runId: `${f.runId}-r`, runStatus: "plan" }
            : f,
        ),
      };
    }
    case "extend": {
      const limits = view.budget.limits;
      const raised = {
        maxTotalTokens: count(body.tokens) ?? limits.maxTotalTokens,
        maxAgentCalls: count(body.calls) ?? limits.maxAgentCalls,
        maxActiveMs: count(body.timeMs) ?? limits.maxActiveMs,
      };
      if (
        raised.maxTotalTokens < limits.maxTotalTokens ||
        raised.maxAgentCalls < limits.maxAgentCalls ||
        raised.maxActiveMs < limits.maxActiveMs
      )
        return "Budget limits can only go up";
      return { ...view, ...bump, budget: { ...view.budget, limits: raised } };
    }
    default:
      return undefined;
  }
}

const initiativeRoutes: MockRoute = ({ key, method, path, body }) => {
  if (method === "POST" && path === "/v1/initiatives") {
    const view = started((body ?? {}) as Body);
    if (typeof view === "string") return refuse(view);
    if (list(key).some((v) => v.initiativeId === view.initiativeId))
      return response(409, {
        error: { code: "CONFLICT", message: `Initiative ${view.initiativeId} already exists` },
      });
    list(key).unshift(view);
    return response(202, view);
  }
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
  const answer = command(view, action, (body ?? {}) as Body);
  if (typeof answer === "string") return refuse(answer);
  if (answer) {
    views[index] = answer;
    return response(200, answer);
  }
  if (action === "reroute") {
    const model = (body as { model?: string } | undefined)?.model;
    if (!model) return undefined;
    const next: InitiativeView = {
      ...view,
      model,
      status: view.status === "paused" ? "active" : view.status,
      revision: view.revision + 1,
    };
    views[index] = next;
    return response(200, next);
  }
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
    ...(action === "approve" ? { approvedPlanRevision: view.planRevision } : {}),
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
  ["analyze", 45_000, "local/qwen3-coder"],
  ["task-T001", 412_000, "claude-sonnet-5-5"],
  ["task-T002", 290_000, "claude-sonnet-5-5"],
  ["checks", 0, ""],
  ["review", 183_000, "gpt-5.1"],
  ["converge", 83_000, "gpt-5.1"],
];

/** USD per million tokens: input, cache reads, output. The local model has no price. */
const PRICES: Record<string, [number, number, number]> = {
  "claude-haiku-5-5": [1, 0.1, 5],
  "claude-sonnet-5-5": [3, 0.3, 15],
  "gpt-5.1": [1.25, 0.125, 10],
};

function attempts(runId: string, scale: number): AttemptUsageRow[] {
  return STAGES.map(([stage, tokens, model], i) => {
    const used = Math.round(tokens * scale);
    const output = Math.round(used * 0.08);
    const input = used - output;
    const cacheRead = Math.round(input * (0.6 + (i % 3) * 0.05));
    const price = PRICES[model];
    const costUsd = !model
      ? 0
      : price
        ? ((input - cacheRead) * price[0] + cacheRead * price[1] + output * price[2]) / 1e6
        : null;
    return {
      attemptId: `${runId}-a${i}`,
      stage,
      model: model || null,
      status: "succeeded",
      usedTokens: used,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      costUsd,
    };
  });
}

const RUN_SCALE: Record<string, number> = {
  "run-usage-totals": 0.4,
  "run-headless-json": 0.1,
  "run-locale-validation": 0.6,
  "run-guide-refresh": 0.25,
  "run-pricing-table": 0.2,
};

type Figures = Omit<UsageFigures, "inputTokens" | "outputTokens" | "costUsd" | "unpricedTokens"> &
  Required<Pick<UsageFigures, "inputTokens" | "outputTokens" | "costUsd" | "unpricedTokens">>;

const emptyFigures = (): Figures => ({
  attempts: 0,
  tokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
  unpricedTokens: 0,
});

function addAttempt(into: Figures, row: AttemptUsageRow): void {
  into.attempts++;
  into.tokens += row.usedTokens ?? 0;
  into.inputTokens += row.inputTokens ?? 0;
  into.outputTokens += row.outputTokens ?? 0;
  into.cacheReadTokens += row.cacheReadTokens ?? 0;
  if (row.costUsd === null || row.costUsd === undefined) into.unpricedTokens += row.usedTokens ?? 0;
  else into.costUsd += row.costUsd;
}

const DIMENSIONS: readonly UsageDimension[] = ["model", "stage", "day"];

/** `GET /v1/usage` as a current backend answers it: one or two dimensions, optional filters. */
function summary(
  days: number,
  groupBy: UsageDimension[],
  filters: { model?: string; stage?: string },
): UsageSummary {
  const scale = Math.min(days, 30) / 7;
  const rows = Object.keys(RUN_SCALE)
    .flatMap((runId, r) =>
      attempts(runId, (RUN_SCALE[runId] ?? 0) * scale).map((a) => ({ ...a, runId, r })),
    )
    .filter(
      (row) =>
        (filters.model === undefined || (row.model ?? "(host)") === filters.model) &&
        (filters.stage === undefined || row.stage === filters.stage),
    );
  const groups = new Map<string, UsageGroup & Figures & { ids: Set<string> }>();
  const totals = emptyFigures();
  const runIds = new Set<string>();
  for (const row of rows) {
    const values: Record<UsageDimension, string> = {
      model: row.model ?? "(host)",
      stage: row.stage,
      day: new Date(Date.now() - row.r * 86_400_000).toISOString().slice(0, 10),
    };
    const keys: Partial<Record<UsageDimension, string>> = {};
    for (const dimension of groupBy) keys[dimension] = values[dimension];
    const key = groupBy.map((dimension) => values[dimension]).join(" / ");
    const group = groups.get(key) ?? { ...emptyFigures(), key, keys, runs: 0, ids: new Set() };
    group.ids.add(row.runId);
    addAttempt(group, row);
    groups.set(key, group);
    addAttempt(totals, row);
    runIds.add(row.runId);
  }
  return {
    days,
    since: Date.now() - days * 86_400_000,
    groupBy,
    filters,
    runs: runIds.size,
    ...totals,
    totalTokens: totals.tokens,
    groups: [...groups.values()]
      .map(({ ids, ...group }) => ({ ...group, runs: ids.size }))
      .sort((a, b) => (groupBy[0] === "day" ? a.key.localeCompare(b.key) : b.tokens - a.tokens)),
  };
}

/** A short stand-in for the Markdown `GET /v1/usage?format=md` renders in the core. */
function mockMarkdown(result: UsageSummary): string {
  const rows = result.groups.map(
    (g) => `| ${g.key} | ${g.tokens.toLocaleString("en-US")} | $${(g.costUsd ?? 0).toFixed(2)} |`,
  );
  return [
    "# BAKED usage",
    "",
    `- Window: last ${result.days} days`,
    "",
    "| Group | Tokens | USD (estimate) |",
    "| --- | ---: | ---: |",
    ...rows,
    "",
  ].join("\n");
}

const error = (message: string) => response(400, { error: { code: "INVALID_REQUEST", message } });

const usageRoutes: MockRoute = ({ method, path, query }) => {
  if (method !== "GET") return undefined;
  if (path === "/v1/usage") {
    const groupBy = (query.get("groupBy") ?? "model").split(",");
    if (
      groupBy.length > 2 ||
      new Set(groupBy).size !== groupBy.length ||
      !groupBy.every((d): d is UsageDimension => (DIMENSIONS as readonly string[]).includes(d))
    )
      return error("groupBy: one or two of model, stage, day");
    const model = query.get("model");
    const stage = query.get("stage");
    const result = summary(Number(query.get("days") ?? 7), groupBy, {
      ...(model !== null ? { model } : {}),
      ...(stage !== null ? { stage } : {}),
    });
    return response(
      200,
      query.get("format") === "md" ? { markdown: mockMarkdown(result) } : result,
    );
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
  if (query.get("format") === "md")
    return response(200, {
      runId,
      markdown: `# BAKED usage of run ${runId}\n\n- Tokens: ${report.totalTokens.toLocaleString("en-US")}\n`,
    });
  return response(200, report);
};

export const INSIGHTS_ROUTES: MockRoute[] = [initiativeRoutes, usageRoutes];
