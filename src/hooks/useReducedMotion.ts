import { useSyncExternalStore } from "react";
import { reducedMotion, subscribeMotion } from "../core/utils/motion.js";

/** Whether brand animations should show still frames (the `motion` setting). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, reducedMotion, reducedMotion);
}
