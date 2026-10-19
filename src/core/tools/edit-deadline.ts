import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<AbortSignal>();

/** A tool abandoned by the host must not write when its pending reads finally return. */
export const withEditDeadline = <T>(signal: AbortSignal, action: () => T): T =>
  scope.run(signal, action);

export function assertEditActive(): void {
  scope.getStore()?.throwIfAborted();
}

/** Bounds advisory worker work, including discovery, without leaving a live timeout behind. */
export async function boundedEditWork<T>(
  action: () => Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  const signal = scope.getStore();
  assertEditActive();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
        abort = () => reject(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    assertEditActive();
  }
}
