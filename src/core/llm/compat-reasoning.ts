/** Standalone OpenAI-compatible reasoning body builder.
 *  Lives in its own file (no provider-registry imports) to break the cycle:
 *    providers/<x>.ts → provider-options.ts → providers/index.ts → providers/<x>.ts
 *  Each provider's createModel imports from here directly. */

import type { AppConfig } from "../../types/index.js";

function parseProvider(modelId: string): { provider: string; model: string } {
  const slash = modelId.indexOf("/");
  if (slash === -1) return { provider: "", model: modelId };
  return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
}

function baseModel(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return (slash >= 0 ? modelId.slice(slash + 1) : modelId).toLowerCase();
}

const COMPAT_PROVIDERS = new Set(["copilot", "github-models"]);

export function getCompatReasoningBody(
  modelId: string,
  config: AppConfig,
): Record<string, unknown> {
  const { provider } = parseProvider(modelId);
  if (!COMPAT_PROVIDERS.has(provider)) return {};

  const base = baseModel(modelId);

  let effort: "low" | "medium" | "high" | "xhigh" | "max" | "off" | undefined =
    config.performance?.compatReasoningEffort;

  if (!effort || effort === "off") {
    const e = config.performance?.effort;
    if (e && e !== "off") {
      // DeepSeek understands "max" directly; other compat providers cap at "xhigh".
      effort = e === "max" ? "xhigh" : e;
    }
  }

  if (!effort || effort === "off") return {};

  const isClaude = base.startsWith("claude");

  // Other gateways routing Claude through OpenAI-compat: skip — the upstream
  // rejects reasoning_effort and we have no way to emit Anthropic shape.
  if (isClaude) {
    return {};
  }

  const isDashscope = /qwen|glm-|kimi-/.test(base);

  const body: Record<string, unknown> = {
    reasoning_effort: effort,
    reasoning: { effort },
  };
  if (isDashscope) body.enable_thinking = true;
  return body;
}
