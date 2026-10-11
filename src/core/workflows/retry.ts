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
  if (info?.statusCode === 402 || NO_CREDITS.test(text)) return "credits";
  if (info?.statusCode === 401 || (info?.statusCode === 403 && BAD_KEY.test(text))) return "key";
  return null;
}

/** A provider failure worth trying again: a timeout, rate limit, overload or network error. */
export function isTransient(error: unknown): boolean {
  if (error instanceof WorkflowFault || accountRefusal(error)) return false;
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
