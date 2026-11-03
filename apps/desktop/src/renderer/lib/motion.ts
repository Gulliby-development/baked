/**
 * Reduced motion for animations the renderer drives from script (d3 transitions, smooth scrolling,
 * timers). CSS animations pair with Tailwind's `motion-reduce:` variants instead; a JS one asks
 * here, so every animation stops when the system asks for reduced motion (#2685).
 */

/** True when the system asks for reduced motion. False without a `window` (tests, SSR). */
export function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** `ms`, or 0 under reduced motion: the length of a scripted transition. */
export function motionMs(ms: number): number {
  return reducedMotion() ? 0 : ms;
}

/** The `behavior` for `scrollIntoView` and `scrollTo`: smooth, or instant under reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return reducedMotion() ? "auto" : "smooth";
}
