import type { AgentList, AgentStage, ConvertResult, ProjectAgent } from "./agents.js";
import { type MockRoute, response } from "./mock-response.js";

/** The project that brought agents along in the mock; every other project has none. */
export const MOCK_AGENTS_PROJECT = "baked";

const STAGES: AgentStage[] = ["research", "specify", "plan", "implement", "review", "skip"];
const hash = (n: number): string => n.toString(16).padStart(64, "0");

function agent(
  n: number,
  name: string,
  source: ProjectAgent["source"],
  path: string,
  description: string,
  stage: AgentStage,
  extra: Partial<ProjectAgent> = {},
): ProjectAgent {
  const instructions = `You are ${name}. ${description}.`;
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n${instructions}\n`;
  return {
    key: path,
    name,
    source,
    sourceLabel: {
      claude: "Claude Code",
      copilot: "GitHub Copilot",
      opencode: "OpenCode",
      roo: "Roo Code",
    }[source],
    path,
    description,
    instructions,
    tools: [],
    model: null,
    stage,
    orchestrator: false,
    removable: true,
    content,
    hash: hash(n),
    ...extra,
  };
}

function sample(): ProjectAgent[] {
  return [
    agent(
      1,
      "architect",
      "claude",
      ".claude/agents/architect.md",
      "Plans the change before any code is written",
      "plan",
      { tools: ["Read", "Grep"] },
    ),
    agent(
      2,
      "frontend-dev",
      "claude",
      ".claude/agents/frontend-dev.md",
      "Builds React components with hooks and tests",
      "implement",
      { model: "sonnet" },
    ),
    agent(
      3,
      "security-auditor",
      "claude",
      ".claude/agents/security-auditor.md",
      "Reviews changes for injection and leaked secrets",
      "review",
      { tools: ["Read", "Grep", "Glob"] },
    ),
    agent(
      4,
      "conductor",
      "copilot",
      ".github/agents/conductor.agent.md",
      "Hands the work from planning to building to review",
      "skip",
      { orchestrator: true },
    ),
  ];
}

const state = new Map<string, ProjectAgent[]>();
const workflows = new Set<string>();
const agentsOf = (key: string): ProjectAgent[] => {
  if (!state.has(key)) state.set(key, key === MOCK_AGENTS_PROJECT ? sample() : []);
  return state.get(key) ?? [];
};

function list(key: string): AgentList {
  const agents = agentsOf(key);
  return {
    agents,
    problems: [],
    stages: STAGES,
    bases: agents.length ? ["standard", "quick", "full", "tdd"] : [],
  };
}

const fail = (status: number, code: string, message: string) =>
  response(status, { error: { code, message } });

export const agentRoutes: MockRoute = ({ key, method, path, query, body }) => {
  if (path === "/v1/agents" && method === "GET") return response(200, list(key));
  if (path === "/v1/agents" && method === "PUT") {
    const request = body as { key: string; content: string; expectedHash: string };
    const agents = agentsOf(key);
    const found = agents.find((a) => a.key === request.key);
    if (!found) return fail(404, "NOT_FOUND", `No agent ${request.key}`);
    if (found.hash !== request.expectedHash)
      return fail(409, "INPUT_CHANGED", `${found.path} changed on disk; reload and edit again`);
    const next = { ...found, content: request.content, hash: hash(Date.now()) };
    state.set(
      key,
      agents.map((a) => (a.key === found.key ? next : a)),
    );
    return response(200, { agent: next });
  }
  if (path === "/v1/agents" && method === "DELETE") {
    const target = query.get("key");
    const agents = agentsOf(key);
    if (!agents.some((a) => a.key === target)) return fail(404, "NOT_FOUND", `No agent ${target}`);
    state.set(
      key,
      agents.filter((a) => a.key !== target),
    );
    return response(200, { removed: target });
  }
  if (path === "/v1/agents/convert" && method === "POST") {
    const request = body as {
      workflowId: string;
      from?: string;
      agents: { key: string; stage: AgentStage }[];
      removeOriginals?: boolean;
    };
    if (workflows.has(`${key}/${request.workflowId}`))
      return fail(400, "INVALID_DEFINITION", `Workflow ${request.workflowId} already exists`);
    const agents = agentsOf(key);
    const used = request.agents.filter((a) => a.stage !== "skip");
    if (!used.length)
      return fail(400, "INVALID_DEFINITION", "Choose at least one agent and its stage");
    workflows.add(`${key}/${request.workflowId}`);
    const result: ConvertResult = {
      workflowId: request.workflowId,
      path: `baked/workflows/${request.workflowId}.json`,
      from: request.from ?? "standard",
      profiles: used
        .filter((a) => a.stage !== "review")
        .map((a) => {
          const id = agents.find((x) => x.key === a.key)?.name ?? a.key;
          return { id, path: `baked/agents/${id}.json`, stage: a.stage, agent: a.key };
        }),
      gates: used
        .filter((a) => a.stage === "review")
        .map((a) => {
          const id = `${agents.find((x) => x.key === a.key)?.name ?? "agent"}-review`;
          return { id, path: `baked/gates/${id}.json`, agent: a.key };
        }),
      removed: request.removeOriginals ? used.map((a) => a.key) : [],
      kept: [],
      notes: agents
        .filter((a) => a.model && used.some((u) => u.key === a.key))
        .map(
          (a) => `${a.name} asked for model ${a.model}; workflow models come from model routing`,
        ),
      problems: [],
    };
    if (request.removeOriginals)
      state.set(
        key,
        agents.filter((a) => !result.removed.includes(a.key)),
      );
    return response(200, result);
  }
  return undefined;
};
