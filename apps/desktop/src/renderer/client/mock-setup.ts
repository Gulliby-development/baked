/**
 * Sample answers for project setup and the "All projects" settings, following the Gates,
 * Instructions and Routing mockups. State is kept per project key for the life of the page.
 */
import type { ApiResponse } from "../../shared/api.js";
import type { MockRequest, MockRoute } from "./mock-routes.js";
import type {
  Check,
  CommandEntry,
  ConfigFile,
  ConfigView,
  GateEntry,
  GateResult,
  GateSuggestion,
  InstructionFile,
  ModelRouting,
  ProjectSummary,
  ProviderStatus,
  Route,
  RouteExplanation,
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
  maxTotalTokens: 800000,
  scopeApproval: "required",
  network: "deny",
};

interface ProjectGate {
  entry: Omit<GateEntry, "lastResult">;
}

interface SetupState {
  summary: ProjectSummary;
  instructions: InstructionFile[];
  project: ConfigFile;
  projectGates: ProjectGate[];
  results: Record<string, GateResult>;
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
    ["design/desktop-app.md", 9800],
    ["design/desktop-api.md", 14_900],
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
          "design/desktop-*.md",
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
      typecheck: { outcome: "passed", at: NOW - 12 * MIN, durationMs: 14_000, exitCode: 0 },
      lint: { outcome: "passed", at: NOW - 12 * MIN, durationMs: 6_000, exitCode: 0 },
      tests: { outcome: "failed", at: NOW - 11 * MIN, durationMs: 112_000, exitCode: 1 },
      "cli-walkthrough": { outcome: "passed", at: NOW - 3 * 60 * MIN, durationMs: 240_000 },
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
  { id: "codex", name: "Codex", configured: false, acceptsKey: false, source: null },
];

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
  return {
    gates: list.map((g) => ({ ...g, lastResult: s.results[g.id] ?? null })),
    problems: [],
  };
}

const SUGGESTIONS: GateSuggestion[] = [
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
    name: "fix-ci",
    scope: "project",
    path: ".baked/commands/fix-ci.md",
    description: "Read the failing CI job and fix it",
  },
  { name: "release-notes", scope: "project", path: ".baked/commands/release-notes.md" },
  { name: "triage", scope: "project", path: ".baked/commands/triage.md" },
  {
    name: "standup",
    scope: "global",
    path: "~/.baked/commands/standup.md",
    description: "Summarize yesterday's commits",
  },
  {
    name: "explain",
    scope: "global",
    path: "~/.baked/commands/explain.md",
    description: "Explain the selected code",
  },
];

const SKILLS: SkillEntry[] = ["api-contract", "locales", "release", "workflow-debug"].map((id) => ({
  id,
  scope: "project",
  path: `baked/skills/${id}/SKILL.md`,
}));

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
    case "GET /v1/workflow/gates/suggestions":
      return response(200, { suggestions: SUGGESTIONS });
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
  const run = /^\/v1\/workflow\/gates\/([^/]+)\/run$/.exec(path);
  if (run?.[1] && method === "POST") {
    const id = decodeURIComponent(run[1]);
    const result: GateResult = {
      outcome: id === "tests" ? "failed" : "passed",
      at: Date.now(),
      durationMs: 4000 + id.length * 900,
      exitCode: id === "tests" ? 1 : 0,
    };
    s.results[id] = result;
    return response(200, result);
  }
  return undefined;
};
