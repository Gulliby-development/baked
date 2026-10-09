import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Landing ↔ Chat animated transition (bidirectional).
 *
 * Phases:
 *   "landing"       – full landing page, centered narrow input
 *   "transitioning" – animating between landing and chat
 *   "chat"          – normal chat layout
 *
 * Forward: hasContent flips true → landing fades out, chat fades in
 * Reverse: hasContent flips false (/clear) → chat fades out, landing fades in
 */

export type TransitionPhase = "landing" | "transitioning" | "chat";

const TRANSITION_MS = 600;
const REVERSE_MS = 400; // reverse is snappier
const TICK_MS = 16;

function outQuad(t: number): number {
  return t * (2 - t);
}

export interface LandingTransition {
  phase: TransitionPhase;
  /** 0 → 1: how far through the transition (0 = landing, 1 = chat) */
  progress: number;
  /** Landing page opacity: 1 → 0 */
  landingOpacity: number;
  /** Chat area opacity: 0 → 1 */
  chatOpacity: number;
  /** Input width percentage: 60 → 100 */
  inputWidthPct: number;
  /** Trigger the forward transition */
  trigger: () => void;
}

export function useLandingTransition(hasContent: boolean): LandingTransition {
  const mountedWithContent = useRef(hasContent);
  const [phase, setPhase] = useState<TransitionPhase>(
    mountedWithContent.current ? "chat" : "landing",
  );
  const [progress, setProgress] = useState(mountedWithContent.current ? 1 : 0);
  const triggered = useRef(false);
  const startTime = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const directionRef = useRef<"forward" | "reverse">("forward");

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const animate = useCallback(
    (direction: "forward" | "reverse") => {
      cleanup();
      directionRef.current = direction;
      setPhase("transitioning");
      startTime.current = Date.now();
      const duration = direction === "forward" ? TRANSITION_MS : REVERSE_MS;

      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - startTime.current;
        const raw = Math.min(1, elapsed / duration);
        const eased = outQuad(raw);
        const p = direction === "forward" ? eased : 1 - eased;
        setProgress(p);

        if (raw >= 1) {
          cleanup();
          if (direction === "forward") {
            setPhase("chat");
            setProgress(1);
          } else {
            setPhase("landing");
            setProgress(0);
            triggered.current = false;
          }
        }
      }, TICK_MS);
    },
    [cleanup],
  );

  const trigger = useCallback(() => {
    if (triggered.current || phase === "chat") return;
    triggered.current = true;
    animate("forward");
  }, [phase, animate]);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  // Auto-trigger forward when hasContent becomes true
  useEffect(() => {
    if (hasContent && phase === "landing") {
      trigger();
    }
  }, [hasContent, phase, trigger]);

  // Animate reverse when content is cleared (/clear)
  useEffect(() => {
    if (!hasContent && phase === "chat") {
      animate("reverse");
    }
  }, [hasContent, phase, animate]);

  // Derived values from progress
  const landingOpacity = Math.max(0, 1 - progress * 2);
  const chatOpacity = Math.max(0, Math.min(1, (progress - 0.25) / 0.75));
  const inputWidthPct = 60 + progress * 40;

  return {
    phase,
    progress,
    landingOpacity,
    chatOpacity,
    inputWidthPct,
    trigger,
  };
}
