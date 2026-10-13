/**
 * Sample answers for project setup and the "All projects" settings, following the Gates,
 * Instructions and Routing mockups. State is kept per project key for the life of the page.
 */
import type { ApiResponse } from "../../shared/api.js";
import type { MockRequest, MockRoute } from "./mock-routes.js";
import type {
  CatalogSkill,
  ChatMemoryCleanupAction,
  ChatMemoryEdit,
  ChatMemoryEntry,
  ChatMemorySettings,
  ChatMemoryView,
  Check,
  CheckList,
  CheckRunResult,
  CheckSuggestion,
  CliLogin,
  CommandEntry,
  ConfigFile,
  ConfigView,
  CriticMode,
  Effort,
  GateDraft,
  GateDraftKind,
  GateEntry,
  HookCommand,
  HookDraft,
  HookEvent,
  HooksView,
  HookWriteScope,
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
  RunMemoryEdit,
  RunMemoryView,
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

const CLAUDE_MD = `See AGENTS.md. Run bun run typecheck before every commit.
`;

/** The instruction sources the backend knows (INSTRUCTION_SOURCES in src/core/instructions.ts). */
const SOURCES = [
  {
    id: "baked",
    label: "baked.md",
    files: ["baked.md", ".baked/baked.md", ".baked/instructions.md"],
    defaultEnabled: true,
  },
  {
    id: "claude",
    label: "CLAUDE.md",
    files: ["CLAUDE.md", ".claude/instructions.md"],
    defaultEnabled: false,
  },
  {
    id: "cursorrules",
    label: ".cursorrules",
    files: [".cursorrules", ".cursor/rules", ".cursor/rules.md"],
    defaultEnabled: false,
  },
  {
    id: "github-copilot",
    label: "Copilot Instructions",
    files: [".github/copilot-instructions.md"],
    defaultEnabled: false,
  },
  {
    id: "codex",
    label: "AGENTS.md",
    files: ["AGENTS.md", ".agents/instructions.md"],
    defaultEnabled: false,
  },
];

/** The instruction list as the backend answers it: files of switched-off sources unnumbered. */
function instructionList(s: SetupState) {
  const on = new Set(s.sourcesOn);
  let order = 0;
  const files = s.instructions.map((f) => {
    const enabled = f.source === "project" || on.has(f.source);
    return {
      ...f,
      order: enabled ? ++order : null,
      enabled,
      sourceLabel: SOURCES.find((src) => src.id === f.source)?.label ?? "baked/project.json",
    };
  });
  return {
    files,
    sources: SOURCES.map((src) => ({ ...src, enabled: on.has(src.id) })),
    sourcesScope: "project" as const,
    promptBytes: files.filter((f) => f.enabled).reduce((sum, f) => sum + f.bytes + 40, 60),
  };
}

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
  /** The instruction sources switched on (`instructionFiles`). */
  sourcesOn: string[];
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
    sourcesOn: ["baked", "codex"],
    // The "client" sample project has no instruction files, to show the empty state.
    instructions:
      key === "client"
        ? []
        : [
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
            instruction(0, "CLAUDE.md", `${root}\\CLAUDE.md`, "claude", "project", CLAUDE_MD),
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
    id: "copilot",
    name: "GitHub Copilot",
    configured: true,
    acceptsKey: true,
    source: "detected",
    detectedFrom: "Copilot IDE login",
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
  const reviewMinConfidence = layer.reviewMinConfidence ?? base.reviewMinConfidence;
  const critic = layer.critic ?? base.critic;
  return {
    classes: { ...base.classes, ...layer.classes },
    roles: { ...base.roles, ...layer.roles },
    profiles: { ...base.profiles, ...layer.profiles },
    workflows,
    ...(independentReview ? { independentReview } : {}),
    ...(reviewMinConfidence !== undefined ? { reviewMinConfidence } : {}),
    ...(critic ? { critic } : {}),
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

const CATALOG: CatalogSkill[] = [
  ["frontend-design", "anthropics/skills", 41200],
  ["pdf", "anthropics/skills", 28900],
  ["webapp-testing", "anthropics/skills", 17300],
  ["vercel-react-best-practices", "vercel-labs/agent-skills", 15800],
  ["supabase-postgres", "supabase/agent-skills", 6400],
  ["sqlite-tuning", "oven-sh/skills", 2100],
].map(([skillId, source, installs]) => ({
  id: `${source}/${skillId}`,
  skillId: String(skillId),
  name: String(skillId),
  source: String(source),
  installs: Number(installs),
}));

const skillPath = (scope: SkillEntry["scope"], id: string) =>
  scope === "project"
    ? `C:\\Project\\BAKED\\.agents\\skills\\${id}\\SKILL.md`
    : `C:\\Users\\you\\.agents\\skills\\${id}\\SKILL.md`;

function skillRoutes(request: MockRequest) {
  const { path, method, query } = request;
  if (path === "/v1/skills/catalog" && method === "GET") {
    const q = (query.get("q") ?? "").toLowerCase();
    return response(200, {
      skills: CATALOG.filter((c) => !q || c.skillId.includes(q) || c.source.includes(q)),
    });
  }
  if (path === "/v1/skills" && method === "POST") {
    const add = body<{ source: string; skillId: string; scope: SkillEntry["scope"] }>(request);
    if (!add.skillId || !add.scope) return error(400, "INVALID_REQUEST", "Name a skill and scope");
    if (add.skillId === "sqlite-tuning")
      return error(422, "INSTALL_FAILED", "Package resolved but no SKILL.md found in it.");
    const at = SKILLS.findIndex((s) => s.id === add.skillId && s.scope === add.scope);
    const skill: SkillEntry = {
      id: add.skillId,
      scope: add.scope,
      path: skillPath(add.scope, add.skillId),
      description: `Installed from ${add.source ?? "skills.sh"}`,
    };
    if (at >= 0) SKILLS[at] = skill;
    else SKILLS.push(skill);
    SKILLS.sort((a, b) => a.id.localeCompare(b.id));
    return response(200, { skill, skills: SKILLS });
  }
  const item = /^\/v1\/skills\/(project|global)\/([^/]+)$/.exec(path);
  if (!item) return undefined;
  const id = decodeURIComponent(item[2] ?? "");
  const at = SKILLS.findIndex((s) => s.id === id && s.scope === item[1]);
  const found = SKILLS[at];
  if (!found) return error(404, "NOT_FOUND", `No ${item[1]} skill named ${id} is installed`);
  if (method === "GET")
    return response(200, {
      ...found,
      content: `---\nname: ${id}\ndescription: ${found.description ?? ""}\n---\n\n# ${id}\n\nUse this skill when the task touches ${id.replace("-", " ")}.\n\n1. Read the relevant files first.\n2. Follow the steps below.\n`,
    });
  if (method === "DELETE") {
    SKILLS.splice(at, 1);
    return response(200, { skills: SKILLS });
  }
  return undefined;
}

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

function explain(s: SetupState, workflowId: string, model?: string | null): RouteExplanation {
  const view = configView(s);
  const routing = view.effective.modelRouting;
  const runModel = model || view.effective.defaultModel || "anthropic/claude-sonnet-5-5";
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
  // Profiles without a route of their own keep the run model.
  const profiles: RouteExplanation["profiles"] = Object.fromEntries(
    [...new Set(Object.values(roleOf))].map((id) => [id, { model: runModel, source: "run model" }]),
  );
  return { workflowId, runModel, stages, profiles, warnings };
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
    reviewMinConfidence: {
      global: global?.reviewMinConfidence ?? null,
      project: project?.reviewMinConfidence ?? null,
      effective: effective?.reviewMinConfidence ?? 0.8,
    },
    critic: {
      global: global?.critic ?? null,
      project: project?.critic ?? null,
      effective: effective?.critic ?? null,
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

const memories = new Map<string, RunMemoryView>();
function memoryState(key: string): RunMemoryView {
  let found = memories.get(key);
  if (!found) {
    found = {
      enabled: true,
      entries: [
        {
          id: "n-4f1c2a9b07",
          kind: "note",
          text: "Public APIs keep their names; add aliases instead of renaming.",
          hidden: false,
          sent: true,
        },
        {
          id: "a-91d0c3e2aa",
          kind: "answer",
          question: "Should usage totals include failed attempts?",
          text: "Yes, count them and mark them as failed.",
          runId: "run-usage-totals",
          hidden: false,
          sent: true,
        },
        {
          id: "s-0b7e55d1c4",
          kind: "assumption",
          text: "JSON output keeps the existing field order.",
          runId: "run-locale-validation",
          hidden: false,
          sent: true,
        },
        {
          id: "c-7a2210fe93",
          kind: "check",
          text: "bun run lint",
          runs: 3,
          runId: "run-locale-validation",
          hidden: false,
          sent: false,
        },
        {
          id: "c-5c9e01b2d8",
          kind: "check",
          text: "bun test tests/usage.test.ts",
          runs: 1,
          runId: "run-locale-validation",
          hidden: false,
          sent: true,
        },
        {
          id: "r-2b8f4c61d0",
          kind: "rule",
          text: "Validate the locale argument before formatting and return a 400 for unknown ones.",
          scope: "src/api/**",
          status: "proposed",
          runs: 2,
          runId: "run-locale-validation",
          findings: ["run-locale-validation/F2", "run-usage-totals/F1"],
          hidden: false,
          sent: false,
        },
      ],
      hidden: [
        {
          id: "s-e3a9d07c11",
          kind: "assumption",
          text: "Sorting is stable by run ID.",
          runId: "run-usage-totals",
          hidden: true,
        },
      ],
      rendered: null,
    };
    memories.set(key, found);
  }
  found.rendered = found.entries.length
    ? `Project memory from earlier workflow runs in this project, newest first.\n\n${found.entries
        .filter((e) => e.sent)
        .map((e) => `- ${e.question ? `Q: ${e.question}\n  A: ` : ""}${e.text}`)
        .join("\n")}`
    : null;
  return found;
}

function editMemory(key: string, edit: Partial<RunMemoryEdit & { id: string; text: string }>) {
  const m = memoryState(key);
  const text = (edit.text ?? "").trim();
  if (edit.action === "add") {
    if (!text) return error(400, "INVALID_REQUEST", "Memory text must not be empty");
    const id = `n-${Math.random().toString(16).slice(2, 12).padEnd(10, "0")}`;
    m.entries.unshift({ id, kind: "note", text, hidden: false, sent: true });
    return response(200, { id, ...memoryState(key) });
  }
  const at = m.entries.findIndex((e) => e.id === edit.id);
  const hiddenAt = m.hidden.findIndex((e) => e.id === edit.id);
  const entry = m.entries[at];
  if (edit.action === "restore" && hiddenAt >= 0) {
    const [back] = m.hidden.splice(hiddenAt, 1);
    if (back) m.entries.push({ ...back, hidden: false, sent: true });
  } else if (!entry) return error(404, "NOT_FOUND", `No project memory entry ${edit.id ?? ""}`);
  else if (edit.action === "accept") {
    if (entry.kind !== "rule")
      return error(400, "INVALID_DEFINITION", "Only a proposed rule can be accepted");
    m.entries[at] = { ...entry, status: "active", sent: true };
  } else if (edit.action === "forget") {
    m.entries.splice(at, 1);
    if (entry.kind !== "note") m.hidden.push({ ...entry, hidden: true });
  } else if (edit.action === "restore") {
    if (entry.recorded) m.entries[at] = { ...entry, text: entry.recorded, recorded: undefined };
  } else if (edit.action === "edit") {
    if (entry.kind === "check")
      return error(400, "INVALID_DEFINITION", "A check command cannot be reworded");
    if (!text) return error(400, "INVALID_REQUEST", "Memory text must not be empty");
    m.entries[at] = {
      ...entry,
      text,
      recorded: entry.kind === "note" ? undefined : (entry.recorded ?? entry.text),
      ...(entry.kind === "rule" ? { status: "active" as const, sent: true } : {}),
    };
  }
  return response(200, { id: edit.id, ...memoryState(key) });
}

const chatMemories = new Map<string, { settings: ChatMemorySettings; all: ChatMemoryEntry[] }>();
function chatMemoryState(key: string) {
  let found = chatMemories.get(key);
  if (!found) {
    const at = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const memory = (
      id: string,
      scope: ChatMemoryEntry["scope"],
      category: ChatMemoryEntry["category"],
      summary: string,
      extra: Partial<ChatMemoryEntry> = {},
    ): ChatMemoryEntry => ({
      id,
      scope,
      category,
      summary,
      details: "",
      topics: [],
      source: "agent",
      createdAt: at(40),
      lastUsedAt: at(2),
      useCount: 3,
      pinned: false,
      hidden: false,
      ...extra,
    });
    found = {
      settings: { writeScope: "project", readScope: "all", settingsScope: "project" },
      all: [
        memory(
          "6f2a9c41-0d1e-4b7a-9a55-1c2d3e4f5a60",
          "project",
          "pref",
          "Use bun for scripts and tests, never npm.",
          {
            source: "user",
            pinned: true,
            useCount: 14,
            topics: ["tooling"],
          },
        ),
        memory(
          "b81e0f3d-77aa-4c19-8e02-5d6c7b8a9f10",
          "project",
          "gotcha",
          "Desktop tests run outside a browser and get the mock bridge.",
          {
            details: "Set window = {} before importing the client so it picks the mock.",
            topics: ["desktop", "tests"],
          },
        ),
        memory(
          "0c4d5e6f-1a2b-4c3d-8e9f-a0b1c2d3e4f5",
          "global",
          "pref",
          "Keep commit subjects under 60 characters.",
          { useCount: 9 },
        ),
        memory(
          "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d",
          "project",
          "context",
          "The parser lived in src/old-parser.ts.",
          {
            lastUsedAt: at(120),
            useCount: 0,
          },
        ),
        memory(
          "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
          "global",
          "decision",
          "Answers stay short.",
          {
            hidden: true,
          },
        ),
      ],
    };
    chatMemories.set(key, found);
  }
  return found;
}
function chatMemoryView(key: string): ChatMemoryView {
  const m = chatMemoryState(key);
  return {
    settings: { ...m.settings },
    entries: m.all.filter((e) => !e.hidden),
    hidden: m.all.filter((e) => e.hidden),
    cleanupHint: null,
  };
}
function editChatMemory(key: string, edit: Partial<ChatMemoryEdit>) {
  const m = chatMemoryState(key);
  if (edit.action === "purge") {
    const before = m.all.length;
    m.all = m.all.filter((e) => edit.scope !== "all" && e.scope !== edit.scope);
    return response(200, { cleared: before - m.all.length, ...chatMemoryView(key) });
  }
  const target = edit as Partial<Extract<ChatMemoryEdit, { id: string }>>;
  const entry = m.all.find((e) => e.id === target.id && e.scope === target.scope);
  if (!entry) return error(404, "NOT_FOUND", `No ${target.scope ?? ""} memory ${target.id ?? ""}`);
  if (target.action === "pin") entry.pinned = true;
  else if (target.action === "unpin") entry.pinned = false;
  else if (target.action === "hide") entry.hidden = true;
  else if (target.action === "restore") entry.hidden = false;
  else if (target.action === "edit") {
    const summary = (target.summary ?? "").trim();
    if (!summary) return error(400, "INVALID_REQUEST", "summary: Too small");
    entry.summary = summary;
    if (target.details !== undefined) entry.details = target.details;
    if (target.category !== undefined) entry.category = target.category;
    entry.hidden = false;
  }
  return response(200, chatMemoryView(key));
}
function chatMemoryCleanup(key: string) {
  const stale = chatMemoryState(key).all.find((e) => !e.hidden && !e.pinned && e.useCount === 0);
  return response(200, {
    candidates: stale
      ? [
          {
            id: stale.id,
            scope: stale.scope,
            kind: "dead",
            summary: stale.summary,
            detail: "src/old-parser.ts",
          },
        ]
      : [],
  });
}
function applyChatMemoryCleanup(key: string, actions: ChatMemoryCleanupAction[]) {
  const m = chatMemoryState(key);
  const applied = { hidden: 0, pinned: 0 };
  for (const a of actions) {
    const entry = m.all.find((e) => e.id === a.id && e.scope === a.scope);
    if (!entry) continue;
    if (a.action === "hide") {
      entry.hidden = true;
      applied.hidden++;
    } else {
      entry.pinned = true;
      applied.pinned++;
    }
  }
  return response(200, { applied, ...chatMemoryView(key) });
}

/** Events switched off per project, as each backend process keeps them until it restarts. */
const hooksOff = new Map<string, Set<string>>();
const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Notification",
  "RunAttention",
];

interface MockHook {
  command: string;
  timeout?: number;
  async?: boolean;
  once?: boolean;
  if?: string;
}
interface MockRule {
  matcher?: string;
  hooks: MockHook[];
}
interface MockHookFile {
  path: string;
  scope: HookCommand["scope"];
  origin: HookCommand["origin"];
  exists: boolean;
  rules: Record<string, MockRule[]>;
}

/** The hooks files of each project, as the preview edits them. */
const hookFiles = new Map<string, MockHookFile[]>();

function mockHookFiles(key: string, root: string): MockHookFile[] {
  const known = hookFiles.get(key);
  if (known) return known;
  const home = "C:\\Users\\dev";
  const files: MockHookFile[] = [
    {
      path: `${home}\\.claude\\settings.json`,
      scope: "user",
      origin: "claude",
      exists: true,
      rules: {
        SessionStart: [
          {
            matcher: "^(startup|resume)$",
            hooks: [
              {
                command: "powershell -NoProfile -File .claude\\hooks\\agent-state.ps1",
                timeout: 10,
              },
            ],
          },
        ],
      },
    },
    {
      path: `${root}\\.claude\\settings.json`,
      scope: "project",
      origin: "claude",
      exists: true,
      rules: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ command: "./scripts/check-command.sh", if: "Bash(git push *)", timeout: 5 }],
          },
        ],
      },
    },
    {
      path: `${root}\\.claude\\settings.local.json`,
      scope: "local",
      origin: "claude",
      exists: false,
      rules: {},
    },
    {
      path: `${home}\\.baked\\config.json`,
      scope: "user",
      origin: "baked",
      exists: true,
      rules: {
        Stop: [{ hooks: [{ command: "notify-send BAKED 'The agent finished'", async: true }] }],
      },
    },
    {
      path: `${root}\\.baked\\config.json`,
      scope: "project",
      origin: "baked",
      exists: true,
      rules: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [{ command: "bunx biome format --write .", timeout: 60 }],
          },
        ],
        RunAttention: [
          {
            matcher: "approval",
            hooks: [{ command: "notify-send BAKED 'A run waits for approval'", async: true }],
          },
        ],
      },
    },
  ];
  hookFiles.set(key, files);
  return files;
}

const hookRev = (rule: MockRule, hook: MockHook) => JSON.stringify([rule.matcher ?? null, hook]);

function hooksView(key: string, root: string): HooksView {
  const off = hooksOff.get(key) ?? new Set<string>();
  const files = mockHookFiles(key, root);
  const byEvent = new Map<string, HookCommand[]>();
  for (const file of files) {
    const scope = file.origin === "baked" && file.scope !== "local" ? file.scope : null;
    for (const [event, rules] of Object.entries(file.rules)) {
      const list = byEvent.get(event) ?? [];
      rules.forEach((rule, r) => {
        rule.hooks.forEach((hook, h) => {
          list.push({
            source: file.path,
            scope: file.scope,
            origin: file.origin,
            id: scope ? `${scope}:${event}:${r}:${h}` : null,
            rev: scope ? hookRev(rule, hook) : null,
            redacted: false,
            matcher: rule.matcher ?? null,
            command: hook.command,
            async: hook.async === true,
            once: hook.once === true,
            timeout: hook.timeout ?? null,
            if: hook.if ?? null,
          });
        });
      });
      byEvent.set(event, list);
    }
  }
  const events: HookEvent[] = [...byEvent.entries()]
    .filter(([, hooks]) => hooks.length > 0)
    .sort(([a], [b]) => HOOK_EVENTS.indexOf(a) - HOOK_EVENTS.indexOf(b))
    .map(([event, hooks]) => ({
      event,
      known: HOOK_EVENTS.includes(event),
      disabled: off.has(event),
      blocking: hooks.some((h) => !h.async),
      hooks,
    }));
  const target = (scope: HookWriteScope) =>
    files.find((f) => f.origin === "baked" && f.scope === scope)?.path ?? "";
  return {
    disabledBy: null,
    sources: files.map((f) => ({
      path: f.path,
      scope: f.scope,
      origin: f.origin,
      exists: f.exists,
      hooks: Object.values(f.rules).reduce(
        (sum, rules) => sum + rules.reduce((n, rule) => n + rule.hooks.length, 0),
        0,
      ),
    })),
    targets: { project: target("project"), user: target("user") },
    events,
  };
}

function setHookEvent(key: string, root: string, change: { event?: string; enabled?: boolean }) {
  if (!change.event || !HOOK_EVENTS.includes(change.event) || typeof change.enabled !== "boolean")
    return error(400, "INVALID_REQUEST", "Send {event, enabled} with an event BAKED fires");
  const off = hooksOff.get(key) ?? new Set<string>();
  if (change.enabled) off.delete(change.event);
  else off.add(change.event);
  hooksOff.set(key, off);
  return response(200, hooksView(key, root));
}

type HookBody = Partial<HookDraft> & { id?: string; rev?: string };

/** Adds, changes or removes a hook in the preview's BAKED files, as `/v1/hooks` does. */
function editHook(key: string, root: string, method: string, change: HookBody) {
  const files = mockHookFiles(key, root);
  const fileOf = (scope: string | undefined) =>
    files.find((f) => f.origin === "baked" && f.scope === scope);
  const handler = (base: MockHook = { command: "" }): MockHook | string => {
    const command = (change.command ?? base.command).trim();
    if (!command) return "A hook needs a command";
    if (change.matcher && /[^\w|*]/.test(change.matcher)) {
      try {
        new RegExp(change.matcher);
      } catch {
        return `The matcher "${change.matcher}" is not a valid regular expression`;
      }
    }
    return {
      command,
      ...(change.timeout ? { timeout: change.timeout } : {}),
      ...(change.async ? { async: true } : {}),
      ...(change.once ? { once: true } : {}),
      ...(change.if?.trim() ? { if: change.if.trim() } : {}),
    };
  };
  const append = (file: MockHookFile, event: string, hook: MockHook) => {
    const matcher = change.matcher?.trim();
    file.rules[event] = [
      ...(file.rules[event] ?? []),
      { ...(matcher ? { matcher } : {}), hooks: [hook] },
    ];
    file.exists = true;
  };
  if (method === "POST") {
    const file = fileOf(change.scope);
    if (!file || !change.event || !HOOK_EVENTS.includes(change.event))
      return error(400, "INVALID_REQUEST", "Send a scope, an event BAKED fires and a command");
    const hook = handler();
    if (typeof hook === "string") return error(400, "INVALID_REQUEST", hook);
    append(file, change.event, hook);
    return response(200, hooksView(key, root));
  }
  const [scope, event, r, h] = (change.id ?? "").split(":");
  const file = fileOf(scope);
  const rules = file && event ? file.rules[event] : undefined;
  const rule = rules?.[Number(r)];
  const old = rule?.hooks[Number(h)];
  if (!file || !event || !rules || !rule || !old)
    return error(404, "NOT_FOUND", "The hook is no longer in its file");
  if (hookRev(rule, old) !== change.rev)
    return error(409, "CONFLICT", "The hook changed in its file since this view was loaded");
  let next: MockHook | string | null = null;
  if (method === "PUT") {
    if (!change.event || !HOOK_EVENTS.includes(change.event))
      return error(400, "INVALID_REQUEST", "Send an event BAKED fires");
    next = handler(old);
    if (typeof next === "string") return error(400, "INVALID_REQUEST", next);
    const target = fileOf(change.scope ?? scope);
    if (
      target === file &&
      change.event === event &&
      (change.matcher?.trim() || undefined) === rule.matcher
    ) {
      rule.hooks[Number(h)] = next;
      return response(200, hooksView(key, root));
    }
  }
  rule.hooks.splice(Number(h), 1);
  if (rule.hooks.length === 0) rules.splice(Number(r), 1);
  if (rules.length === 0) delete file.rules[event];
  if (next && change.event) append(fileOf(change.scope ?? scope) ?? file, change.event, next);
  return response(200, hooksView(key, root));
}

/** A believable draft for the preview, made without a model. */
function mockDraft(text: string, kind: GateDraftKind): GateDraft {
  const id =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .split("-")
      .filter(Boolean)
      .slice(0, 4)
      .join("-") || "gate";
  const base = { id, description: text, required: kind !== "ai-acceptance" };
  const drafts: Record<GateDraftKind, Pick<GateDraft, "gate" | "script" | "capabilities">> = {
    command: {
      gate: {
        ...base,
        type: "command",
        command: { executable: "bun", args: [`tests/gates/${id}.ts`], cwd: "." },
      },
      script: {
        path: `tests/gates/${id}.ts`,
        content: `const out = await new Response(Bun.spawn(["bun", "src/cli.ts", "sum", "50", "6"]).stdout).text();\nif (out.trim() !== "56") {\n  console.log(\`expected 56, got \${out}\`);\n  process.exit(1);\n}\n`,
      },
      capabilities: [
        `Runs bun tests/gates/${id}.ts in . without a shell; a non-zero exit blocks the workflow`,
        `Writes the test script tests/gates/${id}.ts when saved`,
      ],
    },
    "ai-acceptance": {
      gate: {
        ...base,
        type: "ai-acceptance",
        acceptance: {
          scenario: {
            title: text,
            steps: ["Start the CLI.", "Run sum 50 6.", "Run sum with a missing number."],
            expectations: [
              "sum 50 6 prints 56.",
              "A missing number gets a clear error, not a stack trace.",
            ],
          },
          start: { executable: "bun", args: ["src/cli.ts", "repl"], cwd: "." },
          commands: [{ executable: "bun", args: ["src/cli.ts", "sum", "50", "6"] }],
        },
      },
      script: null,
      capabilities: [
        "Starts bun src/cli.ts repl in . and drives its terminal",
        "Runs command 1: bun src/cli.ts sum 50 6",
        "The program may not listen on any port",
        "No network access and no file writes; advisory until a person accepts the test it writes",
      ],
    },
    human: {
      gate: { ...base, type: "human", human: { prompt: text } },
      script: null,
      capabilities: [
        `Stops the workflow until a person approves: ${text}`,
        "Runs nothing and reads nothing",
      ],
    },
    "ai-review": {
      gate: { ...base, type: "ai-review", review: { instructions: text } },
      script: null,
      capabilities: [
        "An AI reviewer (reviewer) reads the change with these instructions; critical and high findings block",
        "Read-only: the reviewer cannot change files or run commands",
      ],
    },
  };
  return { ...drafts[kind], summary: text, problems: [], path: `baked/gates/${id}.json` };
}

export const setupRoutes: MockRoute = (request) => {
  const { key, method, path } = request;
  const placement = /^\/v1\/workflow\/gates\/([^/]+)\/(places|bind)$/.exec(path);
  if (placement) {
    const workflow = request.query.get("workflow") ?? "sdd";
    if (placement[2] === "bind") {
      const { workflow: target = "sdd" } = body<{ workflow?: string }>(request);
      const custom = target === "sdd" || target === "quick-fix";
      return response(200, {
        workflowId: custom ? `${target}-custom` : target,
        path: `baked/workflows/${custom ? `${target}-custom` : target}.json`,
        copiedFrom: custom ? target : null,
      });
    }
    return response(200, {
      workflowId: workflow,
      copyTo: workflow === "sdd" || workflow === "quick-fix" ? `${workflow}-custom` : null,
      places: [
        {
          key: "stage:checks",
          label: "In the checks stage",
          bound: false,
          disabled: "a check stage runs command gates only",
        },
        {
          key: "transition:implemented",
          label: "After implement (pass), before checks starts",
          bound: false,
          disabled: null,
        },
        {
          key: "transition:reviewed",
          label: "After review (pass), before acceptance starts",
          bound: false,
          disabled: null,
        },
        {
          key: "transition:accepted",
          label: "After acceptance (pass), before the run finishes",
          bound: false,
          disabled: null,
        },
      ],
    });
  }
  const skill = skillRoutes(request);
  if (skill) return skill;
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
    case "GET /v1/hooks":
      return response(200, hooksView(key, s.summary.root));
    case "POST /v1/hooks":
    case "PUT /v1/hooks":
    case "DELETE /v1/hooks":
      return editHook(key, s.summary.root, request.method, body<HookBody>(request));
    case "POST /v1/hooks/session":
      return setHookEvent(
        key,
        s.summary.root,
        body<{ event?: string; enabled?: boolean }>(request),
      );
    case "GET /v1/workflow/critic":
      return response(200, {
        summary: { scored: 12 },
        calibration: {
          samples: 12,
          good: 9,
          bad: 3,
          auc: null,
          threshold: null,
          calibrated: false,
          reason: "12 of 20 labelled attempts",
        },
        criticOutcomes: [],
      });
    case "GET /v1/workflow/memory":
      return response(200, memoryState(key));
    case "POST /v1/workflow/memory":
      return editMemory(key, body<RunMemoryEdit & { id: string; text: string }>(request));
    case "GET /v1/memory":
      return response(200, chatMemoryView(key));
    case "POST /v1/memory":
      return editChatMemory(key, body<ChatMemoryEdit>(request));
    case "PUT /v1/memory/settings": {
      const m = chatMemoryState(key);
      const change = body<ChatMemorySettings>(request);
      if (!Object.keys(change).length)
        return error(400, "INVALID_REQUEST", "body: Name at least one setting");
      m.settings = { ...m.settings, ...change };
      return response(200, chatMemoryView(key));
    }
    case "GET /v1/memory/cleanup":
      return chatMemoryCleanup(key);
    case "POST /v1/memory/cleanup":
      return applyChatMemoryCleanup(
        key,
        body<{ actions: ChatMemoryCleanupAction[] }>(request).actions ?? [],
      );
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
    case "POST /v1/workflow/gates/draft": {
      const { text, kind } = body<{ text: string; kind: GateDraftKind }>(request);
      if (!text?.trim()) return error(400, "INVALID_REQUEST", "Describe the check");
      return response(200, mockDraft(text, kind ?? "command"));
    }
    case "POST /v1/workflow/gates": {
      const gate = body<{ gate?: GateDraft["gate"] }>(request).gate;
      if (!gate) return error(400, "INVALID_REQUEST", "Send the drafted gate");
      const id = gate.id;
      if (s.projectGates.some((g) => g.entry.id === id))
        return error(
          422,
          "INVALID_GATE",
          `baked/gates/${id}.json already exists; choose another ID`,
        );
      s.projectGates.push({
        entry: {
          id,
          type: gate.type,
          required: gate.required,
          scope: "feature",
          source: "project",
          path: `${s.summary.root}\\baked\\gates\\${id}.json`,
          hash: fakeHash(id),
          shadows: [],
          confirmed: true,
        },
      });
      return response(201, { id, path: `baked/gates/${id}.json`, script: null });
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
      return response(200, instructionList(s));
    case "PUT /v1/projects/current/instructions/sources": {
      const put = body<{ source: string; enabled: boolean }>(request);
      const id = put.source ?? "";
      if (!SOURCES.some((src) => src.id === id))
        return error(404, "NOT_FOUND", `${id} is not an instruction source`);
      s.sourcesOn = put.enabled
        ? [...new Set([...s.sourcesOn, id])]
        : s.sourcesOn.filter((on) => on !== id);
      return response(200, instructionList(s));
    }
    case "PUT /v1/projects/current/instructions": {
      const put = body<{ path: string; content: string; expectedHash: string | null }>(request);
      const path = put.path ?? "";
      const at = s.instructions.findIndex((f) => f.path === path);
      const found = s.instructions[at];
      if (put.expectedHash === null) {
        const source = SOURCES.find((src) => src.files.includes(path));
        if (!source) return error(404, "NOT_FOUND", `${path} is not an instruction file name`);
        if (found) return error(409, "INPUT_CHANGED", `${path} already exists`);
        s.instructions.unshift(
          instruction(
            0,
            path,
            `${s.summary.root}\\${path}`,
            source.id,
            "project",
            put.content ?? "",
          ),
        );
      } else {
        if (!found) return error(404, "NOT_FOUND", `${path} is not an instruction file`);
        if (found.hash !== put.expectedHash)
          return error(409, "INPUT_CHANGED", `${path} changed since it was read`);
        s.instructions[at] = instruction(
          0,
          found.path,
          found.absolutePath,
          found.source,
          found.scope,
          put.content ?? "",
        );
      }
      const saved = instructionList(s).files.find((f) => f.path === path);
      return response(200, saved);
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
      return response(
        200,
        explain(s, request.query.get("workflow") ?? "sdd", request.query.get("model")),
      );
    case "GET /v1/workflow/routing":
      return response(200, routingOverview(s, request.query.get("workflow")));
    case "PATCH /v1/workflow/routing": {
      const edit = body<
        { scope: "global" | "project"; workflow: string } & {
          target: RoutingTarget;
          route: RouteDraft | null;
          create: boolean;
          independentReview: IndependentReview | null;
          reviewMinConfidence: number | null;
          critic: CriticMode | null;
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
      } else if (edit.critic !== undefined) {
        const { critic: _previous, ...rest } = current ?? {};
        next = edit.critic === null ? rest : { ...rest, critic: edit.critic };
      } else if (edit.reviewMinConfidence !== undefined) {
        const { reviewMinConfidence: _previous, ...rest } = current ?? {};
        next =
          edit.reviewMinConfidence === null
            ? rest
            : { ...rest, reviewMinConfidence: edit.reviewMinConfidence };
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
      } else
        return error(
          400,
          "INVALID_REQUEST",
          "Name a target, independentReview or reviewMinConfidence",
        );
      if (scope === "global") globalConfig = { ...globalConfig, modelRouting: next };
      else s.project = { ...s.project, modelRouting: next };
      return response(200, routingOverview(s, edit.workflow ?? null));
    }
  }
  const providerSignIn = /^\/v1\/providers\/([a-z0-9-]+)\/(login|logout|switch)$/.exec(path);
  if (providerSignIn) {
    const provider = providers.find((p) => p.id === providerSignIn[1]);
    if (!provider?.signIn)
      return error(404, "NOT_FOUND", "This provider does not sign in through a CLI");
    if (providerSignIn[2] === "login") return mockLogin(provider, method);
    if (providerSignIn[2] === "switch") {
      if (method !== "POST") return error(405, "METHOD_NOT_ALLOWED", `Use POST for ${path}`);
      if (provider.signIn.login?.state !== "running") {
        Object.assign(provider.signIn, { loggedIn: false, message: "Not logged in", login: null });
        provider.configured = false;
      }
      const started = mockLogin(provider, "POST").body as { login: CliLogin };
      return response(202, { ok: true, message: "Logged out.", login: started.login });
    }
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
