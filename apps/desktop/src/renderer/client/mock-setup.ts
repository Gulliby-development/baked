/**
 * Sample answers for project setup and the "All projects" settings, following the Gates,
 * Instructions and Routing mockups. State is kept per project key for the life of the page.
 */
import type { ApiResponse } from "../../shared/api.js";
import type { MockRequest, MockRoute } from "./mock-routes.js";
import type {
  Check,
  CheckList,
  CheckRunResult,
  CheckSuggestion,
  CommandEntry,
  ConfigFile,
  ConfigView,
  Effort,
  GateEntry,
  IndependentReview,
  InstructionFile,
  ModelRouting,
  ProjectSummary,
  ProviderStatus,
  Route,
  RouteDraft,
  RouteExplanation,
  RoutingOverview,
  RoutingRow,
  RoutingTarget,
  SkillEntry,
} from "./setup.js";

// Local rather than imported: mock-routes.ts imports this module.
function response(status: number, body: unknown): ApiResponse {
  return { status, body };
}

const NOW = Date.now();
const MIN = 60_000;

const AGENTS_MD = `# Working on BAKED

These instructions apply to every coding agent and every model provider that works in this repository.

## Task workflow

- Start every task on its own branch, created from an up-to-date main:
  - new feature: feature/<name>;
  - bug fix: bugfix/<name>.
- Before each intermediate commit, run at least bun run typecheck.

## Language

- Write everything in English: code, comments, identifiers, commit messages.

## Verification

bun run lint
bun run typecheck
bun test
bun run build
`;

const NOTES_MD = `# Agent notes

- The terminal UI and the headless CLI are front ends over the same core.
- Durable workflow events are authoritative; the UI only renders them.
`;

const STYLE_MD = `# Documentation style

Technical and short: setup, behavior, architecture, troubleshooting.
`;

const BAKED_MD = `Prefer small, reviewable changes. Explain trade-offs in one line.
`;

/** A stand-in for SHA-256 that is stable per content; the mock only compares hashes. */
function fakeHash(text: string): string {
  let out = "";
  let h = 2166136261;
  for (let round = 0; out.length < 64; round++) {
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i) ^ round, 16777619);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

function check(id: string, executable: string, args: string[], extra: Partial<Check> = {}): Check {
  return {
    id,
    executable,
    args,
    cwd: ".",
    timeoutMs: 300_000,
    required: true,
    scope: "feature",
    envNames: [],
    writes: [],
    ...extra,
  };
}

const POLICY_BASE = {
  maxConcurrentReadAgents: 3,
  maxConcurrentWriters: 1,
  maxAgentSteps: 40,
  maxAgentCalls: 200,
  maxTotalTokens: 800000,
  maxActiveMs: 7_200_000,
  maxCostUsd: null,
  checkpointTokens: null,
  scopeApproval: "required",
  network: "deny",
};

interface ProjectGate {
  entry: GateEntry;
}

interface SetupState {
  summary: ProjectSummary;
  instructions: InstructionFile[];
  project: ConfigFile;
  projectGates: ProjectGate[];
  /** The latest on-demand result of each check, as the backend keeps it until it stops. */
  results: Record<string, CheckRunResult>;
}

const TESTS_OUTPUT = `bun test v1.4.2

tests/usage.test.ts:
✓ usage summary > groups by stage and model [3.10ms]
✗ usage summary > counts host attempts as (host) [1.92ms]

  expect(received).toBe(expected)
  Expected: "(host)"
  Received: "host"

      at tests/usage.test.ts:88:31

 41 pass
 1 fail
Ran 42 tests across 9 files. [1.84s]`;

function result(checkId: string, minutesAgo: number, extra: Partial<CheckRunResult>) {
  return {
    checkId,
    at: NOW - minutesAgo * MIN,
    status: "passed",
    exitCode: 0,
    durationMs: 6000,
    outputTail: "",
    truncated: false,
    ...extra,
  } satisfies CheckRunResult;
}

function instruction(
  order: number,
  path: string,
  absolutePath: string,
  source: string,
  scope: "project" | "global",
  content: string,
): InstructionFile {
  return {
    order,
    path,
    absolutePath,
    source,
    scope,
    bytes: new TextEncoder().encode(content).length,
    hash: fakeHash(content),
    content,
  };
}

function initialState(key: string): SetupState {
  const root = key === "baked" ? "C:\\Project\\BAKED" : `C:\\Work\\${key}`;
  const files: [string, number][] = [
    ["AGENTS.md", 6250],
    ["docs/desktop/app.md", 9800],
    ["docs/desktop/api.md", 14_900],
    ["src/core/api/chat-routes.ts", 5200],
    ["src/core/api/route-context.ts", 820],
    ["src/core/api/schemas.ts", 3900],
    ["src/core/api/server.ts", 31_500],
    ["src/core/api/setup-routes.ts", 7900],
    ["src/core/projects/service.ts", 6100],
    ["src/core/projects/working-set.ts", 9600],
    ["src/core/instructions.ts", 7300],
  ];
  return {
    summary: {
      id: key,
      name: key === "baked" ? "BAKED" : key,
      root,
      roots: [root, "C:\\Project\\baked-docs"],
      workingSet: {
        entries: [
          "AGENTS.md",
          "docs/desktop/*.md",
          "src/core/api/*.ts",
          "src/core/projects/service.ts",
          "src/core/projects/working-set.ts",
          "src/core/instructions.ts",
          "docs/roadmap.md",
        ],
        files: files.map(([path, bytes]) => ({ path, bytes })),
        skipped: [{ path: "docs/roadmap.md", reason: "not found" }],
      },
      instructions: { files: ["docs/agent-notes.md", "../baked-docs/style.md"], skipped: [] },
    },
    instructions: [
      instruction(1, "AGENTS.md", `${root}\\AGENTS.md`, "codex", "project", AGENTS_MD),
      instruction(2, "baked.md", "C:\\Users\\you\\baked.md", "baked", "global", BAKED_MD),
      instruction(
        3,
        "docs/agent-notes.md",
        `${root}\\docs\\agent-notes.md`,
        "project",
        "project",
        NOTES_MD,
      ),
      instruction(
        4,
        "../baked-docs/style.md",
        "C:\\Project\\baked-docs\\style.md",
        "project",
        "project",
        STYLE_MD,
      ),
    ],
    project: {
      workflows: {
        enabled: true,
        defaultWorkflow: "sdd",
        policy: {
          ...POLICY_BASE,
          checks: [
            check("lint", "bun", ["run", "lint"], { timeoutMs: 120_000 }),
            check("tests", "bun", ["test"], { timeoutMs: 600_000 }),
            check("task-tests", "bun", ["test", "--changed"], { scope: "task" }),
          ],
        },
      },
      modelRouting: { workflows: { sdd: { stages: { plan: "$deep", analyze: "$deep" } } } },
    },
    projectGates: [
      {
        entry: {
          id: "typecheck",
          type: "command",
          required: true,
          scope: "feature",
          source: "project",
          path: `${root}\\baked\\gates\\typecheck.json`,
          hash: fakeHash("typecheck"),
          shadows: [],
          confirmed: true,
        },
      },
      {
        entry: {
          id: "security-review",
          type: "ai-review",
          required: false,
          scope: "feature",
          source: "project",
          path: `${root}\\baked\\gates\\security-review.json`,
          hash: fakeHash("security-review"),
          shadows: [{ source: "builtin", hash: fakeHash("builtin-security"), path: null }],
          confirmed: false,
        },
      },
      {
        entry: {
          id: "cli-walkthrough",
          type: "ai-acceptance",
          required: false,
          scope: "feature",
          source: "project",
          path: `${root}\\baked\\gates\\cli-walkthrough.json`,
          hash: fakeHash("cli-walkthrough"),
          shadows: [],
          confirmed: true,
        },
      },
    ],
    results: {
      lint: result("lint", 12, { outputTail: "Checked 412 files in 310ms. No fixes applied." }),
      tests: result("tests", 11, {
        status: "failed",
        exitCode: 1,
        durationMs: 112_000,
        outputTail: TESTS_OUTPUT,
        truncated: true,
      }),
    },
  };
}

/** Global config and provider keys belong to the user, so every project's backend shares them. */
let globalConfig: ConfigFile = {
  defaultModel: "anthropic/claude-sonnet-5-5",
  modelRouting: {
    classes: {
      fast: { model: "anthropic/claude-haiku-5-5", effort: "low" },
      deep: {
        model: "anthropic/claude-opus-5-5",
        effort: "high",
        fallback: ["openai/gpt-5.1"],
      },
      review: {
        model: "openai/gpt-5.1",
        effort: "medium",
        fallback: ["anthropic/claude-opus-5-5"],
      },
    },
    roles: {
      researcher: "$fast",
      reporter: "$fast",
      "spec-author": "$active",
      implementer: "$active",
      planner: "$deep",
      reviewer: "$review",
    },
    independentReview: "require",
  },
  telemetry: true,
};

const providers: ProviderStatus[] = [
  { id: "anthropic", name: "Anthropic", configured: true, acceptsKey: true, source: "env" },
  { id: "openai", name: "OpenAI", configured: true, acceptsKey: true, source: "app" },
  {
    id: "google",
    name: "Google Gemini",
    configured: false,
    acceptsKey: true,
    source: null,
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    configured: true,
    acceptsKey: false,
    source: null,
  },
  {
    id: "codex",
    name: "Codex",
    configured: false,
    acceptsKey: false,
    source: null,
    signIn: {
      installed: true,
      loggedIn: false,
      message: "Not logged in",
      command: "codex login",
      login: null,
    },
  },
  {
    id: "claude-code",
    name: "Claude Code",
    configured: true,
    acceptsKey: false,
    source: null,
    signIn: {
      installed: true,
      loggedIn: true,
      message: "Logged in with claude.ai",
      command: "claude auth login",
      login: null,
    },
  },
];

/** A sample sign-in finishes after a few polls, as if the user completed it in the browser. */
const LOGIN_POLLS = 3;
const loginPolls = new Map<string, number>();

function mockLogin(provider: ProviderStatus, method: string): ApiResponse {
  const signIn = provider.signIn;
  if (!signIn) return error(404, "NOT_FOUND", "This provider does not sign in through a CLI");
  if (method === "POST") {
    if (signIn.login?.state !== "running") {
      loginPolls.set(provider.id, 0);
      signIn.login = {
        provider: provider.id,
        state: "running",
        lines: ["Opening browser to sign in…", "Waiting for the sign-in to finish in the browser."],
        url: "https://example.com/sign-in",
        startedAt: new Date().toISOString(),
      };
    }
    return response(202, { login: signIn.login });
  }
  if (method === "DELETE" && signIn.login?.state === "running")
    Object.assign(signIn.login, { state: "cancelled", endedAt: new Date().toISOString() });
  if (method === "GET" && signIn.login?.state === "running") {
    const polls = (loginPolls.get(provider.id) ?? 0) + 1;
    loginPolls.set(provider.id, polls);
    if (polls >= LOGIN_POLLS) {
      signIn.login.lines.push("Signed in.");
      Object.assign(signIn.login, { state: "succeeded", endedAt: new Date().toISOString() });
      Object.assign(signIn, { loggedIn: true, message: "Logged in" });
      provider.configured = true;
    }
  }
  return response(200, { login: signIn.login ?? null });
}

const states = new Map<string, SetupState>();
function state(key: string): SetupState {
  let found = states.get(key);
  if (!found) {
    found = initialState(key);
    states.set(key, found);
  }
  return found;
}

function mergeRouting(base?: ModelRouting, layer?: ModelRouting): ModelRouting | undefined {
  if (!layer) return base;
  if (!base) return layer;
  const workflows: NonNullable<ModelRouting["workflows"]> = { ...base.workflows };
  for (const [id, entry] of Object.entries(layer.workflows ?? {}))
    workflows[id] = { stages: { ...workflows[id]?.stages, ...entry.stages } };
  const independentReview = layer.independentReview ?? base.independentReview;
  return {
    classes: { ...base.classes, ...layer.classes },
    roles: { ...base.roles, ...layer.roles },
    profiles: { ...base.profiles, ...layer.profiles },
    workflows,
    ...(independentReview ? { independentReview } : {}),
  };
}

function configView(s: SetupState): ConfigView {
  const modelRouting = mergeRouting(globalConfig.modelRouting, s.project.modelRouting);
  const workflows =
    globalConfig.workflows || s.project.workflows
      ? { ...globalConfig.workflows, ...s.project.workflows }
      : undefined;
  return {
    global: globalConfig,
    project: s.project,
    effective: {
      ...globalConfig,
      ...s.project,
      ...(modelRouting ? { modelRouting } : {}),
      ...(workflows ? { workflows } : {}),
    },
    paths: {
      global: "C:\\Users\\you\\.baked\\config.json",
      project: `${s.summary.root}\\.baked\\config.json`,
    },
  };
}

function gates(s: SetupState): { gates: GateEntry[]; problems: string[] } {
  const checks = configView(s).effective.workflows?.policy?.checks ?? [];
  const list: GateEntry[] = [
    {
      id: "correctness-review",
      type: "ai-review",
      required: true,
      scope: "feature",
      source: "builtin",
      path: null,
      hash: fakeHash("correctness-review"),
      shadows: [],
    },
    ...checks.map(
      (c): GateEntry => ({
        id: c.id,
        type: "command",
        required: c.required,
        scope: c.scope,
        source: "policy",
        path: null,
        hash: fakeHash(JSON.stringify(c)),
        shadows: [],
      }),
    ),
    ...s.projectGates.map((g) => g.entry),
  ];
  const order = ["typecheck", "lint", "tests", "task-tests", "correctness-review"];
  const rank = (id: string): number => {
    const at = order.indexOf(id);
    return at === -1 ? order.length : at;
  };
  list.sort((a, b) => rank(a.id) - rank(b.id));
  return { gates: list, problems: [] };
}

function checkList(s: SetupState): CheckList {
  const view = configView(s);
  const checks = view.effective.workflows?.policy?.checks ?? [];
  return {
    checks: checks.map((c) => {
      const last = s.results[c.id];
      return last ? { ...c, lastResult: last } : c;
    }),
    workflowsEnabled: view.effective.workflows?.enabled === true,
  };
}

/** What `PUT /v1/workflow/checks` refuses, roughly as the core's `CheckSchema` does. */
function invalidChecks(checks: Check[]): string | null {
  const ids = new Set<string>();
  for (const c of checks) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(c.id ?? "")) return `Invalid check ID ${c.id}`;
    if (ids.has(c.id)) return "Check IDs must be unique";
    ids.add(c.id);
    if (!c.executable) return `${c.id}: executable is required`;
    if (Object.keys(c).some((k) => !(k in check("x", "x", [])))) return `${c.id}: unknown field`;
  }
  return null;
}

/** A sample run of a check: `tests` fails, the rest pass. */
function runCheck(c: Check): CheckRunResult {
  const failed = c.id === "tests";
  return {
    checkId: c.id,
    at: Date.now(),
    status: failed ? "failed" : "passed",
    exitCode: failed ? 1 : 0,
    durationMs: 4000 + c.id.length * 900,
    outputTail: failed ? TESTS_OUTPUT : `$ ${[c.executable, ...c.args].join(" ")}\nDone.`,
    truncated: failed,
  };
}

const SUGGESTIONS: CheckSuggestion[] = [
  {
    check: check("typecheck", "bun", ["run", "typecheck"], { timeoutMs: 120_000 }),
    source: 'package.json script "typecheck"',
    reason: "bun run typecheck",
    preselected: true,
  },
  {
    check: check("build", "bun", ["run", "build"], { timeoutMs: 600_000, required: false }),
    source: 'package.json script "build"',
    reason: "bun run build",
    preselected: false,
  },
  {
    check: check("locales", "bun", ["scripts/validate-locales.ts"], { timeoutMs: 120_000 }),
    source: 'package.json script "locales"',
    reason: "bun scripts/validate-locales.ts",
    preselected: true,
  },
];

const COMMANDS: CommandEntry[] = [
  {
    name: "/explain",
    scope: "global",
    path: "C:\\Users\\you\\.baked\\commands\\explain.md",
    description: "Explain the selected code",
  },
  {
    name: "/fix-ci",
    scope: "project",
    path: "C:\\Project\\BAKED\\.baked\\commands\\fix-ci.md",
    description: "Read the failing CI job and fix it",
    argumentHint: "[job name]",
  },
  {
    name: "/release-notes",
    scope: "project",
    path: "C:\\Project\\BAKED\\.baked\\commands\\release-notes.md",
    description: "Draft release notes from merged pull requests",
    argumentHint: "<version>",
  },
  {
    name: "/standup",
    scope: "global",
    path: "C:\\Users\\you\\.baked\\commands\\standup.md",
    description: "Summarize yesterday's commits",
  },
  {
    name: "/triage",
    scope: "project",
    path: "C:\\Project\\BAKED\\.baked\\commands\\triage.md",
    description: "Label and summarize new issues",
  },
];

const SKILLS: SkillEntry[] = [
  ...["api-contract", "locales", "release", "workflow-debug"].map(
    (id): SkillEntry => ({
      id,
      scope: "project",
      path: `C:\\Project\\BAKED\\.baked\\skills\\${id}\\SKILL.md`,
      description: `How this repository handles ${id.replace("-", " ")}`,
    }),
  ),
  {
    id: "pdf",
    scope: "global",
    path: "C:\\Users\\you\\.claude\\skills\\pdf\\SKILL.md",
  },
];

const WORKFLOW_STAGES: Record<string, string[]> = {
  sdd: ["research", "specify", "plan", "analyze", "implement", "review", "converge"],
  quick: ["plan", "implement", "review"],
  standard: ["research", "plan", "implement", "review", "converge"],
};

function resolveRef(routing: ModelRouting | undefined, ref: string, runModel: string) {
  if (!ref.startsWith("$")) return { model: ref, effort: null, fallback: [] as string[] };
  const route: Route | undefined = routing?.classes?.[ref.slice(1)];
  if (!route) return { model: runModel, effort: null, fallback: [] as string[] };
  return typeof route === "string"
    ? { model: route, effort: null, fallback: [] as string[] }
    : { model: route.model, effort: route.effort ?? null, fallback: route.fallback ?? [] };
}

function explain(s: SetupState, workflowId: string): RouteExplanation {
  const view = configView(s);
  const routing = view.effective.modelRouting;
  const runModel = view.effective.defaultModel ?? "anthropic/claude-sonnet-5-5";
  const roleOf: Record<string, string> = {
    research: "researcher",
    plan: "planner",
    analyze: "planner",
    implement: "implementer",
    review: "reviewer",
    converge: "reviewer",
  };
  const stages = (WORKFLOW_STAGES[workflowId] ?? WORKFLOW_STAGES.sdd ?? []).map((stageId) => {
    const override = routing?.workflows?.[workflowId]?.stages?.[stageId];
    const role = roleOf[stageId];
    const roleRoute = role ? routing?.roles?.[role] : undefined;
    let ref: string | null = null;
    let source: string | null = null;
    if (override) {
      ref = typeof override === "string" ? override : override.model;
      source = `modelRouting.workflows.${workflowId}.stages.${stageId} → ${ref}`;
    } else if (roleRoute) {
      ref = typeof roleRoute === "string" ? roleRoute : roleRoute.model;
      source = `modelRouting.roles.${role} → ${ref}`;
    }
    const resolved = ref ? resolveRef(routing, ref, runModel) : null;
    return {
      stageId,
      kind: stageId === "implement" ? "tasks" : "agent",
      profileId: role ?? null,
      model: resolved?.model ?? (stageId === "specify" ? runModel : null),
      source: source ?? (stageId === "specify" ? "run model" : null),
      effort: resolved?.effort ?? null,
      fallback: resolved?.fallback ?? [],
    };
  });
  const implement = stages.find((st) => st.stageId === "implement")?.model ?? runModel;
  const warnings = stages
    .filter(
      (st) => (st.stageId === "review" || st.stageId === "converge") && st.model === implement,
    )
    .map((st) => `${st.stageId} uses ${implement}, the model of the implementation`);
  return { workflowId, runModel, stages, profiles: {}, warnings };
}

const MOCK_ROLES = [
  "researcher",
  "spec-author",
  "planner",
  "implementer",
  "reviewer",
  "spec-auditor",
  "reporter",
  "acceptance-walker",
  "acceptance-writer",
];
const MOCK_BUILTIN = ["active", "fast", "coding", "review"];

function routeAt(routing: ModelRouting | undefined, target: RoutingTarget): Route | undefined {
  if (target.kind === "class") return routing?.classes?.[target.name];
  if (target.kind === "role") return routing?.roles?.[target.role];
  if (target.kind === "profile") return routing?.profiles?.[target.id];
  return routing?.workflows?.[target.workflowId]?.stages?.[target.stageId];
}

const pathOf = (target: RoutingTarget): string =>
  target.kind === "class"
    ? `classes.${target.name}`
    : target.kind === "role"
      ? `roles.${target.role}`
      : target.kind === "profile"
        ? `profiles.${target.id}`
        : `workflows.${target.workflowId}.stages.${target.stageId}`;

/** A sample `GET /v1/workflow/routing` from the mock config; the real one is the backend's. */
function routingOverview(s: SetupState, workflow: string | null): RoutingOverview {
  const workflowId = workflow ?? "sdd";
  const route = explain(s, workflowId);
  const global = globalConfig.modelRouting;
  const project = s.project.modelRouting;
  const effective = mergeRouting(global, project);
  const row = (target: RoutingTarget, label: string, resolved: RoutingRow["resolved"]) => ({
    target,
    path: pathOf(target),
    label,
    global: routeAt(global, target) ?? null,
    project: routeAt(project, target) ?? null,
    resolved,
  });
  const resolve = (ref: Route | undefined, source: string) => {
    if (!ref) return null;
    const model = typeof ref === "string" ? ref : ref.model;
    const r = resolveRef(effective, model, route.runModel);
    const own: { effort?: Effort; fallback?: string[] } = typeof ref === "string" ? {} : ref;
    return {
      model: r.model,
      source,
      effort: own.effort ?? r.effort,
      fallback: own.fallback ?? r.fallback,
    };
  };
  const names = new Set([...MOCK_BUILTIN, ...Object.keys(effective?.classes ?? {}).sort()]);
  return {
    layers: { ...(global ? { global } : {}), ...(project ? { project } : {}) },
    workflows: Object.keys(WORKFLOW_STAGES),
    workflowId,
    runModel: route.runModel,
    classes: [...names].map((name) =>
      row(
        { kind: "class", name },
        `$${name}`,
        resolve(`$${name}`, effective?.classes?.[name] ? `classes.${name}` : "run model"),
      ),
    ),
    roles: MOCK_ROLES.map((role) =>
      row(
        { kind: "role", role },
        role,
        resolve(effective?.roles?.[role], `modelRouting.roles.${role}`),
      ),
    ),
    stages: route.stages.map((stage) =>
      row(
        { kind: "stage", workflowId, stageId: stage.stageId },
        stage.stageId,
        stage.model
          ? {
              model: stage.model,
              source: stage.source ?? "",
              effort: stage.effort,
              fallback: stage.fallback,
            }
          : null,
      ),
    ),
    profiles: [],
    independentReview: {
      global: global?.independentReview ?? null,
      project: project?.independentReview ?? null,
      effective: effective?.independentReview ?? (effective ? "warn" : "off"),
    },
    warnings: route.warnings,
    error: null,
  };
}

/** The refusals of `applyRoutingChange` in src/core/workflows/routing-edit.ts, for sample data. */
function routingProblems(
  layers: { global: ModelRouting | undefined; project: ModelRouting | undefined },
  target: RoutingTarget,
  draft: RouteDraft | null,
): string[] {
  const problems: string[] = [];
  if (draft) {
    const model = draft.model.trim();
    if (!model) problems.push("Name a model (provider/model) or a class ($name)");
    else if (model.startsWith("$") && target.kind === "class")
      problems.push("A class names a model, not another class");
    if (draft.fallback.length > 3) problems.push("At most three fallback models");
    if (draft.fallback.some((id) => id.startsWith("$")))
      problems.push("Fallbacks name models, not classes");
    if (draft.fallback.includes(model)) problems.push("A fallback repeats the primary model");
    if (problems.length) return problems;
  }
  const merged = mergeRouting(layers.global, layers.project) ?? {};
  const known = new Set([...MOCK_BUILTIN, ...Object.keys(merged.classes ?? {})]);
  const check = (route: Route, at: string) => {
    const model = typeof route === "string" ? route : route.model;
    if (model.startsWith("$") && !known.has(model.slice(1)))
      problems.push(`${at} uses ${model}, which no class defines`);
  };
  for (const [role, route] of Object.entries(merged.roles ?? {})) check(route, `roles.${role}`);
  for (const [id, route] of Object.entries(merged.profiles ?? {})) check(route, `profiles.${id}`);
  for (const [wf, entry] of Object.entries(merged.workflows ?? {}))
    for (const [stage, route] of Object.entries(entry.stages ?? {}))
      check(route, `workflows.${wf}.stages.${stage}`);
  return problems;
}

function setMockRoute(
  routing: ModelRouting | undefined,
  target: RoutingTarget,
  route: Route | null,
): ModelRouting {
  const next: ModelRouting = structuredClone(routing ?? {});
  const put = (record: Record<string, Route> | undefined): Record<string, Route> => {
    const out = { ...record };
    const key =
      target.kind === "class"
        ? target.name
        : target.kind === "role"
          ? target.role
          : target.kind === "profile"
            ? target.id
            : target.stageId;
    if (route === null) delete out[key];
    else out[key] = route;
    return out;
  };
  if (target.kind === "class") next.classes = put(next.classes);
  else if (target.kind === "role") next.roles = put(next.roles);
  else if (target.kind === "profile") next.profiles = put(next.profiles);
  else
    next.workflows = {
      ...next.workflows,
      [target.workflowId]: { stages: put(next.workflows?.[target.workflowId]?.stages) },
    };
  return next;
}

function body<T>(request: MockRequest): Partial<T> {
  return (request.body ?? {}) as Partial<T>;
}

const error = (status: number, code: string, message: string) =>
  response(status, { error: { code, message } });

export const setupRoutes: MockRoute = (request) => {
  const { key, method, path } = request;
  const s = state(key);
  switch (`${method} ${path}`) {
    case "GET /v1/projects/current":
      return response(200, s.summary);
    case "POST /v1/projects/current/working-set": {
      const change = body<{ add: string[]; remove: string[] }>(request);
      const ws = s.summary.workingSet;
      for (const entry of change.add ?? [])
        if (/^([a-zA-Z]:|[\\/])/.test(entry) || entry.startsWith(".."))
          return error(400, "INVALID_REQUEST", `${entry}: outside the project roots`);
      const drop = new Set(change.remove ?? []);
      ws.entries = ws.entries.filter((e) => !drop.has(e));
      ws.skipped = ws.skipped.filter((sk) => !drop.has(sk.path));
      ws.files = ws.files.filter((f) => !drop.has(f.path));
      for (const entry of change.add ?? []) {
        if (ws.entries.includes(entry)) continue;
        ws.entries.push(entry);
        if (/missing|old/.test(entry)) ws.skipped.push({ path: entry, reason: "not found" });
        else ws.files.push({ path: entry.replace(/\*+/g, "index"), bytes: 2400 });
      }
      return response(200, s.summary);
    }
    case "GET /v1/workflow/gates":
      return response(200, gates(s));
    case "POST /v1/workflow/gates/confirm": {
      const ids = body<{ ids: string[] }>(request).ids ?? [];
      for (const g of s.projectGates) if (ids.includes(g.entry.id)) g.entry.confirmed = true;
      return response(200, {
        confirmed: s.projectGates
          .filter((g) => ids.includes(g.entry.id))
          .map((g) => ({ id: g.entry.id, hash: g.entry.hash })),
      });
    }
    case "GET /v1/workflow/checks":
      return response(200, checkList(s));
    case "PUT /v1/workflow/checks": {
      const checks = body<{ checks: Check[] }>(request).checks ?? [];
      const invalid = invalidChecks(checks);
      if (invalid) return error(400, "INVALID_REQUEST", invalid);
      // Only the check list changes; a project without workflows gets the effective block.
      const workflows = s.project.workflows ??
        configView(s).effective.workflows ?? {
          enabled: false,
          policy: { ...POLICY_BASE, checks: [] },
        };
      s.project = {
        ...s.project,
        workflows: { ...workflows, policy: { ...POLICY_BASE, ...workflows.policy, checks } },
      };
      return response(200, checkList(s));
    }
    case "GET /v1/workflow/checks/suggestions": {
      const configured = new Set(checkList(s).checks.map((c) => c.id));
      return response(200, {
        suggestions: SUGGESTIONS.filter((sg) => !configured.has(sg.check.id)),
      });
    }
    case "GET /v1/projects/current/instructions":
      return response(200, {
        files: s.instructions,
        promptBytes: s.instructions.reduce((sum, f) => sum + f.bytes + 40, 60),
      });
    case "PUT /v1/projects/current/instructions": {
      const put = body<{ path: string; content: string; expectedHash: string }>(request);
      const at = s.instructions.findIndex((f) => f.path === put.path);
      const found = s.instructions[at];
      if (!found) return error(404, "NOT_FOUND", `${put.path} is not an instruction file`);
      if (found.hash !== put.expectedHash)
        return error(409, "INPUT_CHANGED", `${put.path} changed since it was read`);
      const updated = instruction(
        found.order,
        found.path,
        found.absolutePath,
        found.source,
        found.scope,
        put.content ?? "",
      );
      s.instructions[at] = updated;
      return response(200, updated);
    }
    case "GET /v1/commands":
      return response(200, { commands: COMMANDS });
    case "GET /v1/skills":
      return response(200, { skills: SKILLS });
    case "GET /v1/config":
      return response(200, configView(s));
    case "PATCH /v1/config": {
      const patch = body<{ scope: "global" | "project"; set: ConfigFile; remove: string[] }>(
        request,
      );
      const scope = patch.scope === "global" ? "global" : "project";
      const next: ConfigFile = {
        ...(scope === "global" ? globalConfig : s.project),
        ...(patch.set ?? {}),
      };
      for (const k of patch.remove ?? []) delete next[k];
      if (scope === "global") globalConfig = next;
      else s.project = next;
      return response(200, configView(s));
    }
    case "GET /v1/providers":
      return response(200, { providers: providers });
    case "GET /v1/workflow/definitions":
      return response(
        200,
        Object.entries(WORKFLOW_STAGES).map(([id, stages]) => ({ id, stages })),
      );
    case "GET /v1/workflow/route":
      return response(200, explain(s, request.query.get("workflow") ?? "sdd"));
    case "GET /v1/workflow/routing":
      return response(200, routingOverview(s, request.query.get("workflow")));
    case "PATCH /v1/workflow/routing": {
      const edit = body<
        { scope: "global" | "project"; workflow: string } & {
          target: RoutingTarget;
          route: RouteDraft | null;
          create: boolean;
          independentReview: IndependentReview | null;
        }
      >(request);
      const scope = edit.scope === "global" ? "global" : "project";
      const current = scope === "global" ? globalConfig.modelRouting : s.project.modelRouting;
      const other = scope === "global" ? s.project.modelRouting : globalConfig.modelRouting;
      let next: ModelRouting;
      if (edit.independentReview !== undefined) {
        const { independentReview: _previous, ...rest } = current ?? {};
        next = edit.independentReview
          ? { ...rest, independentReview: edit.independentReview }
          : rest;
      } else if (edit.target) {
        const draft = edit.route ?? null;
        const route: Route | null = draft
          ? draft.effort || draft.fallback.length
            ? {
                model: draft.model.trim(),
                ...(draft.effort ? { effort: draft.effort } : {}),
                ...(draft.fallback.length ? { fallback: draft.fallback } : {}),
              }
            : draft.model.trim()
          : null;
        next = setMockRoute(current, edit.target, route);
        const problems =
          edit.create &&
          edit.target.kind === "class" &&
          (MOCK_BUILTIN.includes(edit.target.name) ||
            mergeRouting(current, other)?.classes?.[edit.target.name])
            ? [`Class $${edit.target.name} already exists; select it to edit`]
            : routingProblems(
                scope === "global"
                  ? { global: next, project: other }
                  : { global: other, project: next },
                edit.target,
                draft,
              );
        if (problems.length)
          return response(422, {
            error: { code: "ROUTING_REFUSED", message: problems.join("; ") },
            problems,
          });
      } else return error(400, "INVALID_REQUEST", "Name a target or independentReview");
      if (scope === "global") globalConfig = { ...globalConfig, modelRouting: next };
      else s.project = { ...s.project, modelRouting: next };
      return response(200, routingOverview(s, edit.workflow ?? null));
    }
  }
  const providerSignIn = /^\/v1\/providers\/([a-z0-9-]+)\/(login|logout)$/.exec(path);
  if (providerSignIn) {
    const provider = providers.find((p) => p.id === providerSignIn[1]);
    if (!provider?.signIn)
      return error(404, "NOT_FOUND", "This provider does not sign in through a CLI");
    if (providerSignIn[2] === "login") return mockLogin(provider, method);
    if (method === "POST") {
      Object.assign(provider.signIn, { loggedIn: false, message: "Not logged in", login: null });
      provider.configured = false;
      return response(200, { ok: true, message: "Logged out." });
    }
  }
  const providerKey = /^\/v1\/providers\/([a-z0-9-]+)\/key$/.exec(path);
  if (providerKey) {
    const provider = providers.find((p) => p.id === providerKey[1]);
    if (!provider?.acceptsKey) return error(404, "NOT_FOUND", "This provider takes no API key");
    if (method === "PUT") {
      Object.assign(provider, { configured: true, source: "app" });
      return response(200, { configured: true, storage: "keychain" });
    }
    if (method === "DELETE") {
      Object.assign(provider, { configured: false, source: null });
      return response(204, null);
    }
  }
  const run = /^\/v1\/workflow\/checks\/([^/]+)\/run$/.exec(path);
  if (run?.[1] && method === "POST") {
    const id = decodeURIComponent(run[1]);
    const found = checkList(s).checks.find((c) => c.id === id);
    if (!found) return error(404, "NOT_FOUND", `No check ${id}`);
    // In the sample data a run of the docs project is driving and holds its workspace.
    if (key === "docs")
      return error(409, "WORKSPACE_BUSY", "A workflow run holds the workspace; try again later");
    const record = runCheck(found);
    s.results[id] = record;
    return response(200, record);
  }
  return undefined;
};
