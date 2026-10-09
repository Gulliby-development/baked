import type { AgentProfile, RunPolicy } from "./schemas.js";
export function reserveTokens(prompt: string, profile: AgentProfile, policy: RunPolicy): number {
  // Each tool-loop step can replay the growing context and generate another completion.
  // Native execution also enforces the total run limit between calls.
  return (
    Math.ceil(Buffer.byteLength(prompt) / 3) +
    Math.min(profile.maxOutputTokens, policy.maxTotalTokens)
  );
}
