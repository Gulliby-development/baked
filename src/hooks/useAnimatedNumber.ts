import { useEffect, useRef, useState } from "react";

const ANIM_DURATION = 200; // ms
const ANIM_STEPS = 4;
const STEP_MS = ANIM_DURATION / ANIM_STEPS;

/** Smoothly animates from previous value to target over ~400ms with ease-out. */
export function useAnimatedNumber(target: number): number {
  const [display, setDisplay] = useState(target);
  const prevRef = useRef(target);

  useEffect(() => {
    const from = prevRef.current;
    const delta = target - from;
    if (delta === 0) return undefined;

    let step = 0;
    const timer = setInterval(() => {
      step++;
      if (step >= ANIM_STEPS) {
        setDisplay(target);
        prevRef.current = target;
        clearInterval(timer);
      } else {
        // ease-out: fast start, slow finish
        const t = step / ANIM_STEPS;
        const eased = 1 - (1 - t) * (1 - t);
        setDisplay(Math.round(from + delta * eased));
      }
    }, STEP_MS);

    return () => clearInterval(timer);
  }, [target]);

  return display;
}
