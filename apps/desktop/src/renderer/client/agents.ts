/**
 * A project's custom agents from other tools over `/v1/agents*` (docs/desktop/api.md#project-agents):
 * listed and edited only while the project has them, and turned into a workflow. BAKED is
 * customized through workflows, so the desktop shows this section only for projects that brought
 * agents along. An older backend without the capability answers an empty list.
 */
import { call } from "./api.js";
import { PROJECT_AGENTS_CAPABILITY } from "./capabilities.js";
import { isMissingEndpoint, withCapability } from "./setup.js";

export type AgentStage = "research" | "specify" | "plan" | "implement" | "review" | "skip";
export type AgentSource = "claude" | "copilot" | "opencode" | "roo";

/** One agent (`FoundAgent` in src/core/workflows/agent-import.ts). */
export interface ProjectAgent {
  key: string;
  name: string;
  source: AgentSource;
  sourceLabel: string;
  path: string;
  description: string;
  instructions: string;
  tools: string[];
  model: string | null;
  stage: AgentStage;
  orchestrator: boolean;
  removable: boolean;
  content: string;
  hash: string;
}
export interface AgentList {
  agents: ProjectAgent[];
  problems: string[];
  stages: AgentStage[];
  /** The workflows a conversion can start from, `standard` first; empty without agents. */
  bases: string[];
}
export interface ConvertRequest {
  workflowId: string;
  from?: string;
  agents: { key: string; stage: AgentStage }[];
  removeOriginals?: boolean;
}
/** `ConvertResult` in src/core/workflows/agent-import.ts. */
export interface ConvertResult {
  workflowId: string;
  path: string;
  from: string;
  profiles: { id: string; path: string; stage: AgentStage; agent: string }[];
  gates: { id: string; path: string; agent: string }[];
  removed: string[];
  kept: { key: string; reason: string }[];
  notes: string[];
  problems: string[];
}

const EMPTY: AgentList = { agents: [], problems: [], stages: [], bases: [] };

export const projectAgents = {
  /** The project's agents; empty when the backend does not offer the capability. */
  list: (key: string): Promise<AgentList> =>
    withCapability(key, PROJECT_AGENTS_CAPABILITY, () =>
      call<AgentList>(key, "GET", "/v1/agents"),
    ).catch((error: unknown) => {
      if (isMissingEndpoint(error)) return EMPTY;
      throw error;
    }),
  save: (key: string, agent: ProjectAgent, content: string) =>
    call<{ agent: ProjectAgent | null }>(key, "PUT", "/v1/agents", {
      key: agent.key,
      content,
      expectedHash: agent.hash,
    }),
  remove: (key: string, agent: ProjectAgent) =>
    call<{ removed: string }>(
      key,
      "DELETE",
      `/v1/agents?key=${encodeURIComponent(agent.key)}&hash=${agent.hash}`,
    ),
  convert: (key: string, request: ConvertRequest) =>
    call<ConvertResult>(key, "POST", "/v1/agents/convert", request),
};
