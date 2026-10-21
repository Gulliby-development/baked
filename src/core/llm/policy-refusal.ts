/**
 * A provider's refusal of a model's input or output under its usage policy (#1895): a classifier
 * that flagged the prompt, or a response the provider withheld. It is neither an outage nor a lost
 * worker, and no retry on the same model is sure to pass it.
 *
 * One entry per provider adapter, in the provider's own words (`tests/policy-refusal.test.ts`
 * requires one for every adapter in `getAllProviders()`); `none` says why an adapter has no shape
 * of its own. A response a provider ends with the `content-filter` finish reason (OpenAI's
 * `content_filter`, Anthropic's `stop_reason: refusal`) is a refusal on every provider.
 */
export const POLICY_REFUSALS: Readonly<Record<string, RegExp | { none: string }>> = {
  // Codex exec and app-server pass the Responses API error on: "Invalid prompt: your prompt was
  // flagged as potentially violating our usage policy. Please try again with a different prompt".
  codex: /flagged as potentially violating our usage policy/i,
  // The Responses and Chat Completions APIs: the same text, with the code `invalid_prompt`.
  openai: /flagged as potentially violating our usage policy|"code"\s*:\s*"invalid_prompt"/i,
  // Claude Code: "API Error: Claude Code is unable to respond to this request, which appears to
  // violate our Usage Policy (https://www.anthropic.com/legal/aup)".
  "claude-code": /appears to violate our Usage Policy|anthropic\.com\/legal\/aup/i,
  // The Messages API reports a refusal as `stop_reason: refusal` (a `content-filter` finish).
  anthropic: /appears to violate our Usage Policy|anthropic\.com\/legal\/aup/i,
  // Copilot: "Sorry, the response was filtered by the Responsible AI Service" or a
  // `content_filter` code from its Azure-hosted models.
  copilot: /filtered by (?:the )?Responsible AI Service|"code"\s*:\s*"content_filter"/i,
  // GitHub Models (Azure AI): "The response was filtered due to the prompt triggering Azure
  // OpenAI's content management policy", code `content_filter`.
  "github-models": /content management policy|"code"\s*:\s*"content_filter"/i,
};

/** Where a workflow run records each refused attempt, as `<dir><attemptId>.json`. */
export const POLICY_REFUSALS_DIR = "provider/policy-refusals/";
/** The artifact kind of those records, kept in bench traces so the decision replays. */
export const POLICY_REFUSAL_KIND = "policy-refusal";

/**
 * What a run does with a refused attempt, from the refusals already recorded for the same task or
 * stage profile on the same model: the first runs the step once more, the next one stops the run
 * for a reroute. `replayPolicyRefusals` (`workflows/trace.ts`) asks the same function.
 */
export function policyRefusalDecision(prior: number): "retry" | "stop" {
  return prior === 0 ? "retry" : "stop";
}

interface RefusalError {
  name?: string;
  reason?: string;
  message?: string;
  responseBody?: string;
}

/**
 * The provider whose usage policy refused the call (its adapter id, or `content-filter` for a
 * finish reason), or null for any other error. The model's own provider is tried first, then the
 * others, since one adapter can carry another's errors (Copilot serves OpenAI models).
 */
export function policyRefusal(error: unknown, model = ""): string | null {
  const info = error as RefusalError | null | undefined;
  if (!info || typeof info !== "object") return null;
  if (info.name === "AbnormalFinishError" && info.reason === "content-filter")
    return "content-filter";
  const text = `${info.message ?? ""} ${info.responseBody ?? ""}`;
  const own = model.split("/")[0] ?? "";
  const ids = [own, ...Object.keys(POLICY_REFUSALS).filter((id) => id !== own)];
  for (const id of ids) {
    const shape = POLICY_REFUSALS[id];
    if (shape instanceof RegExp && shape.test(text)) return id;
  }
  return null;
}
