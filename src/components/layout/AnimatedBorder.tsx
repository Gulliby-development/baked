import type { BoxRenderable } from "@opentui/core";
import { memo, useEffect, useRef } from "react";
import { useTheme } from "../../core/theme/index.js";

interface AnimatedBorderProps {
  active: boolean;
  children: React.ReactNode;
  idleColor?: string;
}

// Smooth border color transition over ~300ms using lerp steps
const FADE_STEPS = 6;
const FADE_INTERVAL = 50;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16) || 0,
    parseInt(h.substring(2, 4), 16) || 0,
    parseInt(h.substring(4, 6), 16) || 0,
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function lerpHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(
    Math.round(ar + (br - ar) * t),
    Math.round(ag + (bg - ag) * t),
    Math.round(ab + (bb - ab) * t),
  );
}

export const AnimatedBorder = memo(function AnimatedBorder({
  active,
  children,
  idleColor,
}: AnimatedBorderProps) {
  const t = useTheme();
  const boxRef = useRef<BoxRenderable>(null);
  const prevActive = useRef(active);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activeColor = t.brandSecondary;
  const restColor = idleColor ?? t.textSubtle;

  useEffect(() => {
    if (prevActive.current === active) return;
    prevActive.current = active;

    // Clear any in-progress fade
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    const from = active ? restColor : activeColor;
    const to = active ? activeColor : restColor;
    let step = 0;

    timerRef.current = setInterval(() => {
      step++;
      const progress = Math.min(1, step / FADE_STEPS);
      const color = lerpHex(from, to, progress);
      try {
        if (boxRef.current) boxRef.current.borderColor = color;
      } catch {}
      if (progress >= 1 && timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }, FADE_INTERVAL);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [active, activeColor, restColor]);

  return (
    <box
      ref={boxRef}
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      border
      borderStyle="rounded"
      borderColor={active ? activeColor : restColor}
    >
      {children}
    </box>
  );
});
