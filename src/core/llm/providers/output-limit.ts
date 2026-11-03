/**
 * How each provider adapter bounds one model call's output at the agent profile's
 * `maxOutputTokens` (#2547). `request`: the AI SDK sends it as the request's `max_tokens`
 * (`max_output_tokens`); `env`: the adapter sets the named variable on the process that makes
 * the call; `none`: why the provider offers no way to bound it. `tests/provider-output-limit.test.ts`
 * requires one entry for every adapter in `getAllProviders()`, so no adapter drops the limit
 * without saying so.
 */
export const OUTPUT_LIMITS: Readonly<
  Record<string, "request" | { env: string } | { none: string }>
> = {
  anthropic: "request",
  openai: "request",
  copilot: "request",
  "github-models": "request",
  // Claude Code reads it for every API request a `claude -p` turn makes (a turn that reaches it
  // ends "Claude's response exceeded the N output token maximum", which `isOutputLimit` reads).
  "claude-code": { env: "CLAUDE_CODE_MAX_OUTPUT_TOKENS" },
  // The Responses request Codex builds (`ResponsesApiRequest` in codex-rs/codex-api) has no
  // `max_output_tokens` field and no config key sets one, on the app-server or on `codex exec`.
  codex: {
    none: "Codex sends no output limit with its Responses requests and has no setting for one",
  },
};

/** The output limit variable the Claude Code CLI reads. */
export const CLAUDE_CODE_OUTPUT_LIMIT_ENV = "CLAUDE_CODE_MAX_OUTPUT_TOKENS";

/**
 * The environment of a `claude -p` process whose calls stop at `maxOutputTokens`. A lower limit
 * the person already set in the environment stays.
 */
export function claudeCodeEnv(
  maxOutputTokens: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (maxOutputTokens === undefined || !Number.isFinite(maxOutputTokens) || maxOutputTokens < 1)
    return env;
  const limit = Math.floor(maxOutputTokens);
  const own = Number(env[CLAUDE_CODE_OUTPUT_LIMIT_ENV]);
  if (Number.isFinite(own) && own >= 1 && own <= limit) return env;
  return { ...env, [CLAUDE_CODE_OUTPUT_LIMIT_ENV]: String(limit) };
}
