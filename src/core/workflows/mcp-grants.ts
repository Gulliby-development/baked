import type { MCPServerConfig } from "../../types/index.js";

/**
 * MCP tools in workflow profiles (#133). A grant names one tool as the chat agent sees it,
 * `mcp__SERVER__TOOL`, or every tool of one server, `mcp__SERVER__*`. An MCP tool is offered to a
 * workflow agent only when both its profile and the run policy grant it; nothing is granted by
 * default, so built-in profiles and the default policy offer no MCP tool.
 */
const GRANT = /^mcp__[A-Za-z0-9_-]+__(?:[A-Za-z0-9_-]+|\*)$/;

export const isMcpToolName = (name: string): boolean => name.startsWith("mcp__");

export const isMcpGrant = (name: string): boolean => GRANT.test(name);

function grants(list: readonly string[], name: string): boolean {
  if (list.includes(name)) return true;
  return list.some((grant) => grant.endsWith("__*") && name.startsWith(grant.slice(0, -1)));
}

/** Whether a tool list allows `name`: built-in tools by exact name, MCP tools also by server grant. */
export function toolListAllows(list: readonly string[], name: string): boolean {
  return isMcpToolName(name) ? isMcpGrant(name) && grants(list, name) : list.includes(name);
}

/** Matches the tool-name sanitizing of the MCP manager, so grants name servers as tools do. */
export const sanitizeServerName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * The configured servers whose tools both lists may grant. A server listed in only one of them
 * is never connected for a workflow.
 */
export function grantedMcpServers(
  servers: readonly MCPServerConfig[],
  profileTools: readonly string[],
  policyTools: readonly string[],
): MCPServerConfig[] {
  const names = (list: readonly string[], prefix: string) =>
    list.some((grant) => isMcpGrant(grant) && grant.startsWith(prefix));
  return servers.filter((server) => {
    const prefix = `mcp__${sanitizeServerName(server.name)}__`;
    return !server.disabled && names(profileTools, prefix) && names(policyTools, prefix);
  });
}

/**
 * The MCP grants of profiles that no configured, enabled server can satisfy, for `workflow
 * doctor`. Such a tool is never offered to the agent.
 */
export function unmatchedMcpGrants(
  servers: readonly MCPServerConfig[],
  profiles: readonly { id: string; allowedTools: readonly string[] }[],
): { profileId: string; grant: string }[] {
  const prefixes = servers
    .filter((server) => !server.disabled)
    .map((server) => `mcp__${sanitizeServerName(server.name)}__`);
  return profiles.flatMap((profile) =>
    profile.allowedTools
      .filter((grant) => isMcpGrant(grant) && !prefixes.some((prefix) => grant.startsWith(prefix)))
      .map((grant) => ({ profileId: profile.id, grant })),
  );
}
