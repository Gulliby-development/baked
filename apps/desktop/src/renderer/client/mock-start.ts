import type { RunSnapshot } from "../../shared/api.js";
import { type MockRoute, response } from "./mock-response.js";
import { addStartedRun } from "./mock-runs.js";
import type {
  DefinitionSummary,
  DoctorCheck,
  DoctorReport,
  LineGate,
  LineLoop,
  LineStage,
  PreRunEstimate,
  ProjectSummary,
  RoutedProfile,
  RunPolicy,
  TokenRange,
  WorkflowLine,
  WorkflowProposal,
} from "./start.js";

/** Sample answers for the project home, the new run form and the quick task form. */

const HOUR = 3_600_000;
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const HAIKU = "anthropic/claude-haiku-5-5";
const GPT = "openai/gpt-5.1";

/** Each sample stage's role and contracts, as the core's `workflowLine` reports them. */
const LINE_STAGES: Record<string, [LineStage["type"], string[], string]> = {
  research: ["agent", ["request"], "research"],
  specify: ["agent", ["request", "research"], "spec"],
  plan: ["agent", ["request", "spec"], "plan"],
  analyze: ["agent", ["spec", "plan"], "analysis"],
  approve: ["approval", ["spec", "plan", "analysis"], "decision"],
  implement: ["tasks", ["spec", "plan", "decision"], "implementation"],
  reproduce: ["check", ["request"], "gates"],
  checks: ["check", ["implementation"], "gates"],
  verify: ["check", ["implementation"], "gates"],
  review: ["review", ["spec", "implementation", "gates"], "review"],
  converge: ["reflection", ["spec", "review"], "convergence"],
  learn: ["learn", ["review", "convergence"], "report"],
  report: ["agent", ["research"], "report"],
};

const command = (id: string, args: string): LineGate => ({
  id,
  type: "command",
  mode: "required",
  does: `Runs bun ${args}`,
  transition: null,
});
/** Sample gates per stage, as the core's `workflowLine` resolves them from the library. */
function mockGates(id: string, next: string | undefined): LineGate[] {
  if (id === "checks" || id === "verify")
    return [
      command("typecheck", "run typecheck"),
      command("lint", "run lint"),
      command("tests", "test"),
    ];
  if (id === "review")
    return [
      {
        id: "correctness-review",
        type: "ai-review",
        mode: "required",
        does: "AI correctness review",
        transition: null,
      },
      ...(next
        ? [
            {
              id: "settings-ui",
              type: "ai-acceptance" as const,
              mode: "advisory" as const,
              does: "AI walk-through of bun run dev: the settings screen switches to dark mode",
              transition: { id: `review-${next}`, to: next, on: "passed" },
            },
          ]
        : []),
    ];
  return [];
}

export function mockLine(stages: string[]): WorkflowLine {
  const made = new Set(["request"]);
  const line = stages.map((id, i) => {
    const [type, consumes, produces] = LINE_STAGES[id] ?? ["agent", ["request"], id];
    const stage = {
      id,
      type,
      consumes: consumes.filter((c) => made.has(c)),
      produces,
      human: type === "approval",
      gates: mockGates(id, stages[i + 1]),
    };
    made.add(produces);
    return stage;
  });
  const write = stages.indexOf("implement");
  const loops: LineLoop[] = [];
  for (const [from, on, carries] of [
    ["checks", "failed", "gates"],
    ["verify", "failed", "gates"],
    ["review", "changes_requested", "review"],
  ] as const)
    if (write >= 0 && stages.indexOf(from) > write)
      loops.push({ from, to: "implement", on, carries });
  return { stages: line, loops };
}

function definition(
  id: string,
  description: string,
  stages: string[],
  extra: Partial<DefinitionSummary> = {},
): DefinitionSummary {
  return {
    id,
    source: "builtin",
    preset: id === "sdd" ? null : id,
    description,
    stages,
    line: mockLine(stages),
    writes: !["spike", "review-only"].includes(id),
    problems: [],
    execution: null,
    worktreeRefusal: null,
    ...extra,
  };
}

const DEFINITIONS: DefinitionSummary[] = [
  definition("sdd", "Research, specify, plan, implement, review and learn", [
    "research",
    "specify",
    "plan",
    "analyze",
    "approve",
    "implement",
    "checks",
    "review",
    "converge",
    "learn",
  ]),
  definition("quick", "A small, located change: plan, approve, implement, check, review", [
    "plan",
    "approve",
    "implement",
    "checks",
    "review",
  ]),
  definition("quick-fix", "A located fix without a separate plan approval", [
    "implement",
    "checks",
    "review",
  ]),
  definition("standard", "Specify, plan, implement and review", [
    "specify",
    "plan",
    "approve",
    "implement",
    "checks",
    "review",
  ]),
  definition("full", "Every stage, with analysis and convergence", [
    "research",
    "specify",
    "plan",
    "analyze",
    "approve",
    "implement",
    "checks",
    "review",
    "converge",
  ]),
  definition(
    "best-of-n",
    "Standard, with each planned task implemented three times in separate worktrees and the best candidate kept.",
    ["research", "specify", "plan", "analyze", "approve", "implement", "checks", "review"],
    { execution: "worktree" },
  ),
  definition("spike", "Research and a written answer, no changes", ["research", "report"], {
    worktreeRefusal: "A spike writes nothing, so it runs in place.",
  }),
  definition("review-only", "Review the current changes", ["review"], {
    worktreeRefusal: "A review reads the working copy, so it runs in place.",
  }),
  definition("fix-ci", "Reproduce failing checks, research, plan, fix and rerun them", [
    "reproduce",
    "research",
    "plan",
    "approve",
    "implement",
    "verify",
  ]),
];

/** Stage samples per workflow: tokens in thousands and the routed model ("" runs on the host). */
const STAGE_SAMPLES: Record<string, [number, number, string]> = {
  research: [60, 140, HAIKU],
  specify: [20, 40, SONNET],
  plan: [25, 50, OPUS],
  analyze: [15, 40, OPUS],
  approve: [0, 0, ""],
  implement: [240, 460, SONNET],
  checks: [0, 0, ""],
  reproduce: [0, 0, ""],
  verify: [0, 0, ""],
  review: [45, 90, GPT],
  converge: [30, 70, GPT],
  learn: [10, 20, HAIKU],
  report: [15, 30, SONNET],
};
const PRICE_PER_MTOK: Record<string, number> = { [SONNET]: 3, [OPUS]: 9, [HAIKU]: 0.8, [GPT]: 1.6 };

const POLICY: RunPolicy = {
  maxConcurrentReadAgents: 3,
  maxConcurrentWriters: 1,
  maxAgentSteps: 40,
  maxAgentCalls: 200,
  maxTotalTokens: 800_000,
  maxActiveMs: 2 * HOUR,
  maxCostUsd: null,
  checkpointTokens: null,
  checks: [],
};

const sum = (ranges: TokenRange[]): TokenRange => ({
  low: ranges.reduce((n, r) => n + r.low, 0),
  high: ranges.reduce((n, r) => n + r.high, 0),
});

export function mockEstimate(
  workflowId: string,
  model: string | null,
  writers: number,
  history: number,
): PreRunEstimate {
  const found = DEFINITIONS.find((d) => d.id === workflowId) ?? DEFINITIONS[0];
  const stages = (found?.stages ?? []).map((stageId) => {
    const [low, high, routed] = STAGE_SAMPLES[stageId] ?? [10, 30, SONNET];
    const runModel = routed && stageId === "implement" && model ? model : routed;
    // Parallel writers re-read shared context, so the implement stage costs a little more.
    const small = workflowId.startsWith("quick") ? 0.3 : 1;
    const scale = stageId === "implement" ? small * (1 + (writers - 1) * 0.08) : 1;
    const tokens = { low: Math.round(low * 1000 * scale), high: Math.round(high * 1000 * scale) };
    const price = runModel ? (PRICE_PER_MTOK[runModel] ?? 2) : 0;
    return {
      stageId,
      type: stageId === "checks" ? "checks" : stageId === "approve" ? "approval" : "agent",
      models: runModel ? [runModel] : [],
      tokens,
      costUsd: {
        low: (tokens.low / 1_000_000) * price,
        high: (tokens.high / 1_000_000) * price,
      },
    };
  });
  const tokens = sum(stages.map((s) => s.tokens));
  const costUsd = sum(stages.map((s) => s.costUsd));
  return {
    workflowId: found?.id ?? workflowId,
    tokens,
    costUsd,
    costComplete: true,
    basis: history > 0 ? "workflow-history" : "defaults",
    samples: history,
    notes: [
      "Cost prices a fixed token mix; cache writes are not counted, so Anthropic costs read low.",
    ],
    stages,
    budget: {
      maxTotalTokens: POLICY.maxTotalTokens,
      fits:
        tokens.high <= POLICY.maxTotalTokens
          ? "yes"
          : tokens.low > POLICY.maxTotalTokens
            ? "no"
            : "maybe",
    },
    label: "",
  };
}

function mockDoctor(workflowId: string, model: string | null, worktree: boolean): DoctorReport {
  const estimate = mockEstimate(workflowId, model, 1, 4);
  const checks: DoctorCheck[] = [
    { id: "config.enabled", status: "ok", title: "Workflows are enabled" },
    { id: "start", status: "ok", title: `Workflow ${workflowId} would start` },
    {
      id: "models.key",
      status: "ok",
      title: "Provider keys for 4 models",
      detail: "anthropic and openai keys found",
    },
    {
      id: "commands.executable",
      status: "ok",
      title: "Check commands resolve",
      detail: "bun run typecheck, bun run lint, bun test",
    },
    {
      id: "git.clean",
      status: "warn",
      title: "2 uncommitted changes",
      detail: worktree
        ? "README.md, locales/ru.json. The worktree starts from HEAD without them."
        : "README.md, locales/ru.json. Tasks that edit these files work on top of your changes.",
      fix: "Commit or stash them before the run",
    },
    {
      id: "lsp.missing",
      status: "warn",
      title: "No language server for python",
      detail: "Code navigation and diagnostics fall back to tree-sitter for these files.",
      fix: "baked lsp install pyright-langserver, or Install on the desktop app's Language servers page",
      subject: "python",
    },
    { id: "workspace.busy", status: "ok", title: "No run is executing" },
  ];
  if (estimate.budget.fits !== "yes")
    checks.push({
      id: "budget",
      status: "warn",
      title: "The run may exceed its token budget",
      fix: "Raise maxTotalTokens in the policy, or extend the run when it stops",
    });
  return {
    workflowId,
    runModel: model ?? SONNET,
    ready: true,
    checks,
    estimate,
  };
}

function summary(key: string, runs: RunSnapshot[]): ProjectSummary | null {
  const now = Date.now();
  if (key === "client") return null;
  return {
    id: key === "baked" ? "baked" : key,
    name: key,
    root: key === "baked" ? "C:\\Project\\BAKED" : `C:\\Work\\${key}`,
    roots: key === "baked" ? ["C:\\Project\\BAKED", "C:\\Project\\baked-docs"] : [],
    ignoredRoots: [],
    branch: key === "baked" ? "main" : "develop",
    workingSet:
      key === "baked"
        ? {
            entries: [
              "src/core/workflows/usage.ts",
              "src/headless/**/*.ts",
              "docs/projects.md",
              ".env",
            ],
            files: [
              { path: "src/core/workflows/usage.ts", bytes: 9_200 },
              { path: "src/headless/workflow.ts", bytes: 21_400 },
              { path: "src/headless/workflow-parse.ts", bytes: 6_100 },
              { path: "docs/projects.md", bytes: 12_300 },
              { path: "../baked-docs/guide.md", bytes: 6_000 },
            ],
            skipped: [{ path: ".env", reason: "forbidden" }],
          }
        : { entries: [], files: [], skipped: [] },
    instructions: { files: ["AGENTS.md"], skipped: [] },
    sessions:
      key === "baked"
        ? [
            {
              id: "s-usage-table",
              title: "Why does the usage table skip the last column?",
              messageCount: 14,
              startedAt: now - 5 * HOUR,
              updatedAt: now - HOUR,
            },
            {
              id: "s-locales",
              title: "Locale validation in CI",
              messageCount: 8,
              startedAt: now - 30 * HOUR,
              updatedAt: now - 26 * HOUR,
            },
            {
              id: "s-headless",
              title: "Headless --json output",
              messageCount: 21,
              startedAt: now - 74 * HOUR,
              updatedAt: now - 70 * HOUR,
            },
          ]
        : [],
    runs,
  };
}

const created: RunSnapshot[] = [];
const byCommand = new Map<string, RunSnapshot>();

const PROFILES: RoutedProfile[] = [
  { profile: { id: "planner" }, route: { model: OPUS } },
  { profile: { id: "implementer" }, route: { model: SONNET } },
  { profile: { id: "researcher" }, route: { model: HAIKU } },
  { profile: { id: "reviewer" }, route: { model: GPT } },
];

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;

function startRun(key: string, body: unknown): ReturnType<typeof response> {
  const input = (body ?? {}) as Record<string, unknown>;
  const { commandId, prompt, workflow, issue } = input;
  const fromIssue = typeof issue === "string" && issue.trim() !== "";
  const number = fromIssue ? /(\d+)\/?$/.exec(issue.trim())?.[1] : undefined;
  const feature = input.feature ?? (fromIssue ? `issue-${number ?? "1"}` : undefined);
  if (typeof commandId !== "string" || !SAFE_ID.test(commandId))
    return response(400, { error: { code: "INVALID_REQUEST", message: "commandId: invalid id" } });
  if (typeof feature !== "string" || !SAFE_ID.test(feature))
    return response(400, { error: { code: "INVALID_REQUEST", message: "feature: invalid id" } });
  if (!fromIssue && (typeof prompt !== "string" || !prompt))
    return response(400, { error: { code: "INVALID_REQUEST", message: "prompt: required" } });
  if (input.writers !== undefined && Number(input.writers) > 1 && input.worktree !== true)
    return response(400, {
      error: {
        code: "INVALID_REQUEST",
        message: "More than one writer needs worktree execution",
      },
    });
  const known = byCommand.get(commandId);
  if (known) return response(202, known);
  const run: RunSnapshot = {
    runId: `run-${feature}-${commandId.slice(0, 8)}`,
    featureId: feature,
    status: "running",
    revision: 1,
    eventSeq: 1,
    stageId: workflow === "quick" ? "plan" : "research",
    tokenUsage: 0,
    activeMs: 0,
    estimatedCostUsd: 0,
    pendingRequestIds: [],
  };
  created.unshift(run);
  byCommand.set(commandId, run);
  addStartedRun(key, run.runId, feature, run.stageId ?? "research");
  return response(202, run);
}

/** A few of the core's rules (`src/core/workflows/preset-router.ts`), enough to show the hint. */
export function mockProposal(prompt: string): WorkflowProposal {
  const text = prompt.toLowerCase();
  if (/\b(readme|docs?|typo|changelog)\b/.test(text))
    return {
      workflowId: "quick",
      budget: "quick",
      kind: "docs",
      confidence: "high",
      reason: "a docs-only change: the quick preset",
      signals: [],
    };
  if (/\b(ci|tests?|build)\b/.test(text) && /\b(fail\w*|red|broken)\b/.test(text))
    return {
      workflowId: "fix-ci",
      budget: "standard",
      kind: "ci-fix",
      confidence: "high",
      reason: "a failing check: reproduce it, fix and rerun the same checks",
      signals: [],
    };
  return {
    workflowId: "sdd",
    budget: "standard",
    kind: "default",
    confidence: "low",
    reason: "no strong signal: the project default",
    signals: [],
  };
}

export const startRoutes: MockRoute = async ({ key, method, path, query, body }) => {
  if (method === "GET" && path === "/v1/workflow/definitions") return response(200, DEFINITIONS);
  if (method === "POST" && path === "/v1/workflow/propose")
    return response(200, mockProposal(String((body as { prompt?: string } | null)?.prompt ?? "")));
  if (method === "GET" && path === "/v1/workflow/profiles") return response(200, PROFILES);
  if (method === "GET" && (path === "/v1/workflow/estimate" || path === "/v1/workflow/doctor")) {
    const workflow = query.get("workflow") ?? "sdd";
    const model = query.get("model");
    const worktree = query.get("worktree") === "true";
    const writers = Number(query.get("writers") ?? "1");
    if (writers > 1 && !worktree)
      return response(400, {
        error: {
          code: "INVALID_REQUEST",
          message: "More than one writer needs worktree execution",
        },
      });
    return response(
      200,
      path.endsWith("estimate")
        ? mockEstimate(workflow, model, writers, workflow === "sdd" ? 5 : 4)
        : mockDoctor(workflow, model, worktree),
    );
  }
  if (method === "GET" && path === "/v1/projects/current") {
    const found = summary(key, created);
    return found
      ? response(200, found)
      : response(404, {
          error: {
            code: "NOT_FOUND",
            message: "No project here; run baked project init in the workspace",
          },
        });
  }
  if (method === "POST" && path === "/v1/workflow/runs") return startRun(key, body);
  return undefined;
};
