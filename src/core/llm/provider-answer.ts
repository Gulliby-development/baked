/** What a provider stream carried before its turn ended with no usable answer. */
export interface AnswerEvidence {
  /** Event and item types the stream carried, in order of first appearance. */
  seen?: string[];
  /** Lines and bytes read from the provider's output. */
  lines?: number;
  bytes?: number;
  /** Output lines that did not parse, with up to three samples (200 characters each). */
  unparsed?: number;
  samples?: string[];
}

/** The tokens a provider reported for a turn whose answer was lost. */
export interface AnswerUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * A provider turn that finished, and was billed, without an answer BAKED could use (#1957): no
 * final message, a `tool-calls` finish with no tool call, a protocol reply missing what the call
 * needs. It is neither an outage nor a stall: the provider answered, and the reader or the answer
 * failed. The scheduler climbs the recovery ladder on it (`recoverableCall`), the executor
 * charges its `usage`, and its time stays off the active deadline. Bench round 62 (stepvet
 * tagexpr analyze): six exec attempts ended "Codex exec returned no final agent message" and were
 * filed as `provider_unavailable`, at 0 tokens, for 71 minutes.
 */
export class ProviderAnswerError extends Error {
  readonly usage: AnswerUsage | undefined;
  readonly evidence: AnswerEvidence | undefined;

  constructor(message: string, options: { usage?: AnswerUsage; evidence?: AnswerEvidence } = {}) {
    super(message);
    this.name = "ProviderAnswerError";
    this.usage = options.usage;
    this.evidence = options.evidence;
  }

  /** The same failure with the usage its caller read from the turn. */
  withUsage(usage: AnswerUsage | undefined): ProviderAnswerError {
    if (this.usage || !usage) return this;
    const error = new ProviderAnswerError(this.message, {
      usage,
      ...(this.evidence ? { evidence: this.evidence } : {}),
    });
    error.stack = this.stack;
    return error;
  }
}

/** The lost-answer failure in `error` or its causes, or null. */
export function lostAnswer(error: unknown): ProviderAnswerError | null {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (current instanceof ProviderAnswerError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** A turn's usage as an adapter reports it (flat, or the v3 `{ total }` shape), or undefined. */
export function answerUsage(usage: unknown): AnswerUsage | undefined {
  const tokens = (value: unknown) =>
    typeof value === "number"
      ? value
      : typeof (value as { total?: unknown } | undefined)?.total === "number"
        ? (value as { total: number }).total
        : undefined;
  const info = usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
  const inputTokens = tokens(info?.inputTokens);
  const outputTokens = tokens(info?.outputTokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

const INVISIBLE: Record<string, string> = {
  "\u0085": "U+0085",
  " ": "U+00A0",
  "​": "U+200B",
  "‌": "U+200C",
  "‍": "U+200D",
  "‎": "U+200E",
  "‏": "U+200F",
  " ": "U+2028",
  " ": "U+2029",
  "‪": "U+202A",
  "‫": "U+202B",
  "‬": "U+202C",
  "‭": "U+202D",
  "‮": "U+202E",
  "⁦": "U+2066",
  "⁧": "U+2067",
  "⁨": "U+2068",
  "⁩": "U+2069",
  "﻿": "U+FEFF",
};
const INVISIBLE_PATTERN = new RegExp(`[${Object.keys(INVISIBLE).join("")}]`, "g");

/**
 * The invisible and line-separator characters a prompt holds, with their counts ("U+2028 x3"), for
 * the stop text of an input that kept losing its answer: in R62 the stage input held U+2028.
 */
export function invisibleCharacters(text: string): string[] {
  const counts = new Map<string, number>();
  for (const [char] of text.matchAll(INVISIBLE_PATTERN))
    counts.set(char, (counts.get(char) ?? 0) + 1);
  return [...counts].map(([char, count]) => `${INVISIBLE[char]} x${count}`);
}
