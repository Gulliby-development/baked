/**
 * How each provider adapter bounds one model call's output at the agent profile's
 * `maxOutputTokens` (#2547). `request`: the AI SDK sends it as the request's `max_tokens`
 * (`max_output_tokens`); `env`: the adapter sets the named variable on the process that makes
 * the call; `stream`: the provider takes no limit, so the adapter watches the streamed output and
 * the stream guard (`streamOutputDecision`, stop reason `stream_output_limit`, #2660) ends the
 * call past `STREAM_OUTPUT_FACTOR` times the limit, the string saying why and on which transport;
 * `none`: why the provider offers no way to bound it. `tests/provider-output-limit.test.ts`
 * requires one entry for every adapter in `getAllProviders()`, so no adapter drops the limit
 * without saying so.
 */
export const OUTPUT_LIMITS: Readonly<
  Record<string, "request" | { env: string } | { stream: string } | { none: string }>
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
  // The app-server streams agent message and reasoning deltas, which the guard counts; `codex
  // exec --json` reports each item only once it completed, so an exec call is not guarded.
  codex: {
    stream:
      "Codex sends no output limit with its Responses requests and has no setting for one; the app-server's streamed deltas are guarded, `codex exec` streams none",
  },
};

/**
 * The stream guard ends a call whose streamed output passes this many times the call's
 * `maxOutputTokens` (#2660): a slack over the limit, since the estimate counts characters and a
 * provider that bounds its own requests (Claude Code) may still answer a little past it.
 */
export const STREAM_OUTPUT_FACTOR = 2;
/** Characters per output token in the stream guard's estimate (BAKED's usual 4 bytes a token). */
export const STREAM_CHARS_PER_TOKEN = 4;

/** How the stream guard acts: the mode of its stop reason, `stream_output_limit`. */
export type StreamGuardMode = "shadow" | "advisory" | "enforce";

/**
 * What the stream guard saw on one step, in the step's provider metadata (`codex.outputGuard`)
 * and its record in the attempt's `usage.json`, so the trace replay decides it again (#2660).
 * `streamedChars` is the text and reasoning the step streamed, up to where an enforced guard
 * ended it. `decision`: `pass`, `would_stop` (past the limit in shadow or advisory, the stream
 * went on) or `stopped` (enforced: the turn was interrupted and the step ended `length`).
 */
export interface StreamOutputGuard {
  mode: StreamGuardMode;
  maxOutputTokens: number;
  factor: number;
  limitTokens: number;
  streamedChars: number;
  streamedTokens: number;
  decision: "pass" | "would_stop" | "stopped";
}

/** The stream guard's rule: whether a step's streamed output is past its limit. */
export function streamOutputDecision(input: {
  maxOutputTokens: number;
  streamedChars: number;
  factor?: number;
}): { limitTokens: number; streamedTokens: number; over: boolean } {
  const limitTokens = Math.ceil(input.maxOutputTokens * (input.factor ?? STREAM_OUTPUT_FACTOR));
  const streamedTokens = Math.ceil(input.streamedChars / STREAM_CHARS_PER_TOKEN);
  return { limitTokens, streamedTokens, over: streamedTokens > limitTokens };
}

/** The stream guard's mode a call asks for (`providerOptions.<provider>.outputGuard`). */
export function streamGuardMode(
  providerOptions: Record<string, Record<string, unknown> | undefined> | undefined,
  provider: string,
): StreamGuardMode {
  const mode = providerOptions?.[provider]?.outputGuard;
  return mode === "enforce" || mode === "advisory" ? mode : "shadow";
}

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
