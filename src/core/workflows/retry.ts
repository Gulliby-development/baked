import { WorkflowFault } from "./errors.js";

interface ProviderError {
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

/** A provider failure worth trying again: a timeout, rate limit, overload or network error. */
export function isTransient(error: unknown): boolean {
  if (error instanceof WorkflowFault || accountRefusal(error)) return false;
  if (isOAuthRefreshCollision(error)) return true;
  const info = error as ProviderError | undefined;
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

/**
 * A model call that ended on text instead of a submission, after the continuation and the format
 * correction (R7: four of six interventions). The fault carries the text it ended with.
 */
export function endedOnProse(error: unknown): error is WorkflowFault {
  return error instanceof WorkflowFault && error.details.reason === "prose_end";
}
