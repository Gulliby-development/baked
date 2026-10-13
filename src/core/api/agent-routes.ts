/**
 * A project's custom agents from other tools over the local API (`project-agents` capability, #832):
 * list and edit them, and convert them into a workflow. Core logic is in
 * src/core/workflows/agent-import.ts; `baked workflow agents` is the same in a shell.
 */
import { z } from "zod";
import type { AppConfig } from "../../types/index.js";
import {
  AGENT_STAGES,
  conversionBases,
  convertAgents,
  listAgents,
  removeAgentFile,
  writeAgentFile,
} from "../workflows/agent-import.js";
import { defaultWorkflowPolicy } from "../workflows/defaults.js";
import { PolicySchema, SafeId } from "../workflows/schemas.js";
import type { RouteContext } from "./route-context.js";

export interface AgentRouteContext extends RouteContext {
  workspace: string;
  config: AppConfig;
}

const Key = z.string().min(1).max(512);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const WriteBody = z.strictObject({
  key: Key,
  content: z.string().max(64 * 1024),
  expectedHash: Hash,
});
const RemoveQuery = z.strictObject({ key: Key, hash: Hash.optional() });
const ConvertBody = z.strictObject({
  workflowId: SafeId,
  from: SafeId.optional(),
  agents: z
    .array(z.strictObject({ key: Key, stage: z.enum(AGENT_STAGES) }))
    .min(1)
    .max(50),
  removeOriginals: z.boolean().optional(),
});

/** Answers a project-agents request, or returns null when the path is not one. */
export async function agentRoute(ctx: AgentRouteContext): Promise<Response | null> {
  const policy = () => PolicySchema.parse(ctx.config.workflows?.policy ?? defaultWorkflowPolicy);
  if (ctx.path === "/v1/agents") {
    ctx.only("GET", "PUT", "DELETE");
    if (ctx.method === "GET") {
      const list = listAgents(ctx.workspace);
      return ctx.json(200, {
        ...list,
        stages: AGENT_STAGES,
        bases: list.agents.length ? conversionBases(ctx.workspace, policy()) : [],
      });
    }
    if (ctx.method === "PUT") {
      const body = WriteBody.parse(await ctx.readJson());
      const written = writeAgentFile(ctx.workspace, body.key, body.content, body.expectedHash);
      if (written.status === "unknown") ctx.fail(404, "NOT_FOUND", written.message);
      if (written.status === "changed") ctx.fail(409, "INPUT_CHANGED", written.message);
      return ctx.json(200, { agent: written.status === "written" ? written.agent : null });
    }
    const query = ctx.query(RemoveQuery);
    const removed = removeAgentFile(ctx.workspace, query.key, query.hash);
    if (removed.status === "unknown") ctx.fail(404, "NOT_FOUND", removed.message);
    if (removed.status === "changed") ctx.fail(409, "INPUT_CHANGED", removed.message);
    return ctx.json(200, { removed: query.key });
  }
  if (ctx.path === "/v1/agents/convert") {
    ctx.only("POST");
    const body = ConvertBody.parse(await ctx.readJson());
    return ctx.json(
      200,
      convertAgents(ctx.workspace, policy(), {
        workflowId: body.workflowId,
        agents: body.agents,
        ...(body.from ? { from: body.from } : {}),
        ...(body.removeOriginals ? { removeOriginals: true } : {}),
      }),
    );
  }
  return null;
}
