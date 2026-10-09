import { WorkflowFault } from "./errors.js";

export function retryDelay(error: unknown, retry: number): number | null {
  if (error instanceof WorkflowFault || retry >= 2) return null;
  const info = error as {
    statusCode?: number;
    responseHeaders?: Record<string, string>;
    message?: string;
  };
  const status = info?.statusCode;
  if (status !== undefined && ![408, 429, 500, 502, 503, 504, 529].includes(status)) return null;
  if (
    status === undefined &&
    !/overloaded|rate limit|429|503|529|ETIMEDOUT|ECONNRESET|fetch failed|network|socket hang up/i.test(
      info?.message ?? "",
    )
  )
    return null;
  const header = info.responseHeaders?.["retry-after"];
  const requested = header
    ? Number.isFinite(Number(header))
      ? Number(header) * 1000
      : Date.parse(header) - Date.now()
    : 0;
  return Math.max(1000 * 2 ** retry + Math.floor(Math.random() * 200), requested || 0);
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
