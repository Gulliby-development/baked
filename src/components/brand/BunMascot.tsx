import type { TextRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { type ThemeTokens, useTheme } from "../../core/theme/index.js";
import {
  artPalette,
  BAKE_ART_TICK_MS,
  type BunPose,
  bunRows,
  busyPose,
  idlePose,
} from "../../core/utils/bake-art.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { artText } from "./artText.js";

export type BunMood = "idle" | "busy" | "sleep";

/** Pose of the bun for a mood at a moment; reduced motion freezes it at the first frame. */
export function bunPose(mood: BunMood, elapsedMs: number, reduced: boolean): BunPose {
  if (mood === "sleep") return { bake: 1, rise: 1, face: "sleep", steam: null };
  const pose =
    mood === "busy" ? busyPose(reduced ? 600 : elapsedMs) : idlePose(reduced ? 600 : elapsedMs);
  return reduced ? { ...pose, steam: null } : pose;
}

export function bunFrame(mood: BunMood, elapsedMs: number, theme: ThemeTokens, reduced = false) {
  return artText(bunRows(bunPose(mood, elapsedMs, reduced), artPalette(theme)));
}

/** The BAKED bun mascot, animated at five frames a second unless motion is reduced. */
export function BunMascot({ mood = "idle" }: { mood?: BunMood }) {
  const textRef = useRef<TextRenderable>(null);
  const theme = useTheme();
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced || mood === "sleep") return;
    const startedAt = performance.now();
    const timer = setInterval(() => {
      if (textRef.current) {
        textRef.current.content = bunFrame(mood, performance.now() - startedAt, theme);
      }
    }, BAKE_ART_TICK_MS);
    return () => clearInterval(timer);
  }, [mood, theme, reduced]);

  return <text ref={textRef} wrapMode="none" content={bunFrame(mood, 0, theme, reduced)} />;
}
