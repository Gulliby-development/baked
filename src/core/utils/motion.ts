/**
 * Motion preference for the terminal UI. `reduced` shows still frames instead of brand
 * animations and slows status updates to once a second. `BAKED_REDUCED_MOTION=1` forces it.
 */
export type MotionMode = "full" | "reduced";

export function envReducedMotion(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.BAKED_REDUCED_MOTION ?? "").trim().toLowerCase();
  return value !== "" && value !== "0" && value !== "false" && value !== "no";
}

let mode: MotionMode = envReducedMotion() ? "reduced" : "full";
const listeners = new Set<() => void>();

/** Applies the configured mode; the environment variable still wins. */
export function setMotion(next: MotionMode | undefined): void {
  const resolved: MotionMode = envReducedMotion() || next === "reduced" ? "reduced" : "full";
  if (resolved === mode) return;
  mode = resolved;
  for (const listener of listeners) listener();
}

export function getMotion(): MotionMode {
  return mode;
}

export function reducedMotion(): boolean {
  return mode === "reduced";
}

export function subscribeMotion(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
