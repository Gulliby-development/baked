import { WorkflowFault } from "./errors.js";

interface ProviderError {
  name?: string;
  statusCode?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  message?: string;
}

const NO_CREDITS =
  /insufficient_quota|no credits|credit balance|exceeded your current quota|billing|payment required/i;
const BAD_KEY = /api[ _-]?key|unauthori[sz]ed|authentication|invalid x-api-key/i;

/**
 * A provider refusal that no retry or other model of the same account fixes: spent credits or
 * quota, or a rejected key. OpenAI reports spent credits as a 429, which is otherwise a rate
 * limit; run 8e117dfa retried it and then lost its task worker over it.
 */
export function accountRefusal(error: unknown): "credits" | "key" | null {
  if (error instanceof WorkflowFault) return null;
  const info = error as ProviderError | undefined;
  const text = `${info?.message ?? ""} ${info?.responseBody ?? ""}`;
  if (OAUTH_REFRESH_COLLISION.test(text)) return null;
  if (info?.statusCode === 402 || NO_CREDITS.test(text)) return "credits";
  if (info?.statusCode === 401 || (info?.statusCode === 403 && BAD_KEY.test(text))) return "key";
  return null;
}

const OAUTH_REFRESH_COLLISION =
  /another Claude Code process is (?:currently )?refreshing|refreshing the OAuth token/i;

/**
 * Two Claude Code processes sharing one login refresh its token at once and the second is told to
 * retry in a minute. It passes by itself, but not within the seconds of an ordinary retry.
 */
export function isOAuthRefreshCollision(error: unknown): boolean {
  if (error instanceof WorkflowFault) return false;
  const info = error as ProviderError | undefined;
  return OAUTH_REFRESH_COLLISION.test(`${info?.message ?? ""} ${info?.responseBody ?? ""}`);
}

/** Retries an OAuth refresh collision gets, at least; each waits 30 to 60 seconds. */
export const OAUTH_COLLISION_RETRIES = 3;

const CAPACITY =
  /(?:selected )?model is at capacity|at capacity|try a different model|capacity exceeded|no capacity/i;

/**
 * The provider has no room for the model right now ("Selected model is at capacity. Please try a
 * different model.", bench round 7 url-shortener A, a 4m40s call that ended in a blocked run). It
 * carries no status code a retry rule knows, and it clears in minutes, not seconds.
 */
export function isCapacityError(error: unknown): boolean {
  if (error instanceof WorkflowFault || accountRefusal(error)) return false;
  const info = error as ProviderError | undefined;
  return CAPACITY.test(`${info?.message ?? ""} ${info?.responseBody ?? ""}`);
}

/** Retries a capacity error gets, at least; the waits are 5, 15, 45 and 90 seconds. */
export const CAPACITY_RETRIES = 4;
const CAPACITY_WAITS_MS = [5_000, 15_000, 45_000, 90_000];

const INPUT_TOO_LARGE =
  /input_too_large|input exceeds the maximum length|prompt is too long|context_length_exceeded|maximum context length|request too large/i;

/**
 * The provider refused the request for its size: the codex app-server's `input_too_large`
 * ("Input exceeds the maximum length of 1048576 characters"), a context-length error, or a 413.
 * It is an error of the prompt, not of the provider: the same history fails the same way (#997).
 */
export function isInputTooLarge(error: unknown): boolean {
  if (error instanceof WorkflowFault) return false;
  const info = error as ProviderError | undefined;
  return (
    info?.statusCode === 413 ||
    INPUT_TOO_LARGE.test(`${info?.message ?? ""} ${info?.responseBody ?? ""}`)
  );
}

/** A provider failure worth trying again: a timeout, rate limit, overload or network error. */
export function isTransient(error: unknown): boolean {
  if (error instanceof WorkflowFault || accountRefusal(error)) return false;
  if (isOAuthRefreshCollision(error) || isCapacityError(error)) return true;
  const info = error as ProviderError | undefined;
  if (info?.name === "TimeoutError") return true;
  const status = info?.statusCode;
  if (status !== undefined) return [408, 429, 500, 502, 503, 504, 529].includes(status);
  return /overloaded|rate limit|429|503|529|ETIMEDOUT|ECONNRESET|fetch failed|network|socket hang up/i.test(
    info?.message ?? "",
  );
}

/** The wait a provider asked for with `retry-after`, in milliseconds, or 0. */
export function retryAfterMs(error: unknown): number {
  const header = (error as ProviderError | undefined)?.responseHeaders?.["retry-after"];
  if (!header) return 0;
  const requested = Number.isFinite(Number(header))
    ? Number(header) * 1000
    : Date.parse(header) - Date.now();
  return Number.isFinite(requested) ? Math.max(0, requested) : 0;
}

/** The delay before retry number `retry + 1`, or null once `maxRetries` are spent or the error is final. */
export function retryDelay(error: unknown, retry: number, maxRetries = 2): number | null {
  if (isOAuthRefreshCollision(error)) {
    if (retry >= Math.max(maxRetries, OAUTH_COLLISION_RETRIES)) return null;
    return 30_000 + Math.floor(Math.random() * 30_000);
  }
  if (isCapacityError(error)) {
    if (retry >= Math.max(maxRetries, CAPACITY_RETRIES)) return null;
    const wait = CAPACITY_WAITS_MS[Math.min(retry, CAPACITY_WAITS_MS.length - 1)] ?? 90_000;
    return Math.max(wait + Math.floor(Math.random() * 1000), retryAfterMs(error));
  }
  if (retry >= maxRetries || !isTransient(error)) return null;
  return Math.max(1000 * 2 ** retry + Math.floor(Math.random() * 200), retryAfterMs(error));
}
export async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

const TOOLS =
  "(?:edit_file|write_file|apply_patch|create_file|read_file|`?(?:read|glob|grep)`? tool|edit tool|write tool|editing tools?)";
const UNAVAILABLE =
  "(?:unavailable|not available|missing|not exposed|not provided|no access|not accessible)";
const LOST_TOOL = new RegExp(
  `${TOOLS}[^.\n]{0,80}${UNAVAILABLE}|${UNAVAILABLE}[^.\n]{0,40}${TOOLS}|no such tool`,
  "i",
);

/**
 * An implementation that ended blocked or failed because a session lost a tool it needs
 * (run fc9951d5: `edit_file` unavailable). The next session has the tool, so one restart helps.
 */
export function reportsLostTool(result: {
  outcome: string;
  summary: string;
  unresolved: string[];
}): boolean {
  if (!["blocked", "failed"].includes(result.outcome)) return false;
  return LOST_TOOL.test([result.summary, ...result.unresolved].join("\n"));
}

const EDIT_NOT_APPLIED =
  /\b(?:did ?n[o']t apply|was ?n[o']t applied|not applied|failed to apply|could ?n[o']t (?:be )?appl(?:y|ied)|cannot apply|edit (?:failed|was rejected)|old[_ ]string (?:was )?not found|no match(?:es)? for)\b/i;

/**
 * The files of a task's own write list that an `implemented` result leaves unresolved because an
 * edit did not apply (cfgtrace b8544e36, #1036: a `multi_edit` of a test file in the task's
 * scope did not apply, one line remained, and the run stopped at 13 of 14 tasks). That is not a
 * conflict or a missing prerequisite: a fresh attempt from the applied edits finishes it.
 */
export function failedOwnEdits(
  result: { outcome: string; unresolved: string[] },
  writes: { path: string; action: string }[],
): string[] {
  if (result.outcome !== "implemented") return [];
  const own = writes.filter((w) => w.action !== "delete").map((w) => w.path);
  const failed = result.unresolved.filter((item) => EDIT_NOT_APPLIED.test(item));
  return own.filter((path) => failed.some((item) => item.includes(path)));
}

/**
 * A model call that ended on text instead of a submission, after the continuation and the format
 * correction (R7: four of six interventions). The fault carries the text it ended with.
 */
export function endedOnProse(error: unknown): error is WorkflowFault {
  return error instanceof WorkflowFault && error.details.reason === "prose_end";
}
