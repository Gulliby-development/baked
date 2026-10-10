import { fg as fgStyle } from "@opentui/core";
import { memo, useEffect, useRef } from "react";
import { useTheme } from "../../core/theme/index.js";

/**
 * baked branded spinner — oscillating rune wheel.
 *
 * A wheel of Elder Futhark runes that spins forward then
 * reverses back — like an engraved drum oscillating.
 *
 * Forward:  ᛁ → ᚲ → ᚠ → ᛊ → ᛏ → ᛉ → ᛞ  (intensity rises)
 * Reverse:  ᛞ → ᛉ → ᛏ → ᛊ → ᚠ → ᚲ → ᛁ  (intensity fades)
 *
 * Color follows the rotation — brighter as it spins forward, dimmer
 * as it returns. Feels like a pendulum or breathing oven.
 *
 * Single character wide. Unicode Runic block (U+16A0–U+16FF).
 */

// ── Rune wheel ──────────────────────────────────────────────────────

type Intensity = 0 | 1 | 2 | 3 | 4;

// Runes that tell a baking story — all full-height glyphs
const WHEEL: string[] = [
  "ᛁ", // Isa — stillness/ice (seed)
  "ᚲ", // Kenaz — torch kindles
  "ᚠ", // Fehu — fire catches
  "ᛊ", // Sowilo — sun rises
  "ᛏ", // Tiwaz — power ascending
  "ᛉ", // Algiz — reaching upward
  "ᛞ", // Dagaz — DAWN (peak)
];

// Intensity curve: maps wheel position → color intensity
const INTENSITY_CURVE: Intensity[] = [0, 0, 1, 2, 2, 3, 4];

// Build the full oscillation: forward + hold peak + reverse + hold rest
type Frame = { glyph: string; intensity: Intensity };

function buildFrames(): Frame[] {
  const frames: Frame[] = [];

  // Forward spin
  for (let i = 0; i < WHEEL.length; i++) {
    frames.push({ glyph: WHEEL[i] as string, intensity: INTENSITY_CURVE[i] as Intensity });
  }
  // Hold peak (spark lingers)
  frames.push({ glyph: "ᛞ", intensity: 3 });

  // Reverse spin (skip the peak — already held)
  for (let i = WHEEL.length - 2; i >= 0; i--) {
    frames.push({ glyph: WHEEL[i] as string, intensity: INTENSITY_CURVE[i] as Intensity });
  }
  // Hold rest (seed lingers before next forward)
  frames.push({ glyph: "ᛁ", intensity: 0 });

  return frames;
}

const FRAMES = buildFrames();
const FRAME_COUNT = FRAMES.length;
const TICK_MS = 150; // ~2.25s full oscillation

// ── Color mapping ───────────────────────────────────────────────────

function intensityColor(
  intensity: Intensity,
  brand: string,
  muted: string,
  faint: string,
  spark: string,
): string {
  switch (intensity) {
    case 0:
      return faint;
    case 1:
      return muted;
    case 2:
      return brand;
    case 3:
      return brand;
    case 4:
      return spark;
  }
}

// ── Global tick (shared across all instances) ───────────────────────

let globalFrame = 0;
let refCount = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;
const frameListeners = new Set<(frame: number) => void>();

function ensureTick() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    globalFrame = (globalFrame + 1) % FRAME_COUNT;
    for (const fn of frameListeners) fn(globalFrame);
  }, TICK_MS);
}

// ── React component ─────────────────────────────────────────────────

export const BakeSpinner = memo(function BakeSpinner({ color }: { color?: string } = {}) {
  const t = useTheme();
  // biome-ignore lint/suspicious/noExplicitAny: ref shared across text/span renderables with imperative updates
  const textRef = useRef<any>(null);

  const brand = color ?? t.brand;
  const colorsRef = useRef({ brand, muted: t.textMuted, faint: t.textFaint, spark: t.warning });
  colorsRef.current = { brand, muted: t.textMuted, faint: t.textFaint, spark: t.warning };

  useEffect(() => {
    const listener = (f: number) => {
      const { glyph, intensity } = FRAMES[f % FRAME_COUNT] as Frame;
      const c = colorsRef.current;
      try {
        if (textRef.current) {
          textRef.current.content = glyph;
          textRef.current.fg = intensityColor(intensity, c.brand, c.muted, c.faint, c.spark);
        }
      } catch {}
    };
    frameListeners.add(listener);
    refCount++;
    ensureTick();
    return () => {
      frameListeners.delete(listener);
      refCount--;
      if (refCount <= 0) {
        refCount = 0;
        if (tickTimer) {
          clearInterval(tickTimer);
          tickTimer = null;
        }
      }
    };
  }, []);

  const { glyph, intensity } = FRAMES[globalFrame % FRAME_COUNT] as Frame;
  const fg = intensityColor(
    intensity,
    colorsRef.current.brand,
    colorsRef.current.muted,
    colorsRef.current.faint,
    colorsRef.current.spark,
  );

  return (
    <text ref={textRef} fg={fg}>
      {glyph}
    </text>
  );
});

// ── Imperative API (for StyledText / status bar) ────────────────────

/** Build styled TextChunk[] for the current rune spinner frame. */
export function bakeSpinnerChunks(
  frame: number,
  brand: string,
  muted: string,
  faint: string,
  spark: string,
) {
  const { glyph, intensity } = FRAMES[frame % FRAME_COUNT] as Frame;
  const fg = intensityColor(intensity, brand, muted, faint, spark);
  return [fgStyle(fg)(glyph)];
}

export { TICK_MS as BAKE_TICK_MS };
