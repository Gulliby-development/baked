import type { StyledText, TextRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { getThemeTokens } from "../../core/theme/index.js";
import {
  type ArtCell,
  artPalette,
  BAKE_ART_TICK_MS,
  chipCells,
  textCells,
} from "../../core/utils/bake-art.js";
import { reducedMotion } from "../../core/utils/motion.js";
import { formatElapsed } from "../../hooks/useElapsed.js";
import { useStatusBarStore } from "../../stores/statusbar.js";
import { artText } from "../brand/artText.js";

/** Plain-language steps with a bakery touch; one is picked per turn. */
const BAKE_STATUSES = [
  "Working on it",
  "Kneading the plan",
  "Thinking it through",
  "Mixing in context",
  "Proofing the idea",
  "Checking the oven",
];

const METER_WIDTH = 8;
const METER_BLOCK = 3;

/** A block of filled cells that slides back and forth across a light track. */
export function meterCells(tick: number, fill: string, track: string): ArtCell[] {
  const span = METER_WIDTH - METER_BLOCK;
  const step = tick % (span * 2);
  const left = step <= span ? step : span * 2 - step;
  return Array.from({ length: METER_WIDTH }, (_, index) =>
    index >= left && index < left + METER_BLOCK ? { ch: "█", fg: fill } : { ch: "░", fg: track },
  );
}

/** The busy bar: `[ BAKING ]▌ ███░░░░░  Kneading the plan  12s      [ ^X STOP ]` */
export function busyLine(
  tick: number,
  isCompacting: boolean,
  status: string,
  elapsedSec: number,
  width: number,
): StyledText {
  const tk = getThemeTokens();
  const palette = artPalette(tk);
  const fill = isCompacting ? tk.info : palette.fill;
  const left: ArtCell[] = [
    { ch: " " },
    ...chipCells(isCompacting ? "COMPACTING" : "BAKING", fill, palette.onFill, palette.shadow),
    { ch: " " },
    ...meterCells(tick, fill, tk.textFaint),
    ...textCells(`  ${isCompacting ? "Compacting context" : status}`, tk.textSecondary),
  ];
  if (elapsedSec > 0) left.push(...textCells(`  ${formatElapsed(elapsedSec)}`, tk.textMuted));
  const stop = chipCells("^X STOP", tk.error, palette.onFill);
  const gap = width - left.length - stop.length - 1;
  const row = gap >= 2 ? [...left, ...textCells(" ".repeat(gap)), ...stop] : left;
  return artText([row]);
}

interface LoadingStatusProps {
  isLoading: boolean;
  isCompacting: boolean;
  loadingStartedAt?: number;
  width?: number;
}

export function LoadingStatus({
  isLoading,
  isCompacting,
  loadingStartedAt,
  width = 80,
}: LoadingStatusProps) {
  const textRef = useRef<TextRenderable>(null);
  const statusRef = useRef("");
  const wasLoadingRef = useRef(false);
  const loadingStartRef = useRef(0);
  const elapsedSecRef = useRef(0);
  const tickRef = useRef(0);
  const propsRef = useRef({ isLoading, isCompacting, width });
  propsRef.current = { isLoading, isCompacting, width };

  const showBusy = isLoading || isCompacting;

  if (isLoading && !wasLoadingRef.current) {
    statusRef.current = BAKE_STATUSES[Math.floor(Math.random() * BAKE_STATUSES.length)] as string;
    loadingStartRef.current = loadingStartedAt || Date.now();
    elapsedSecRef.current = 0;
  }

  wasLoadingRef.current = isLoading;

  useEffect(() => {
    if (!showBusy) return;
    // Reduced motion keeps the meter still and only refreshes the elapsed time.
    const reduced = reducedMotion();
    const timer = setInterval(
      () => {
        if (!reduced) tickRef.current++;
        const { isLoading: ld, isCompacting: cp, width: w } = propsRef.current;
        const elapsed = cp
          ? useStatusBarStore.getState().compactElapsed
          : ld
            ? Math.floor((Date.now() - loadingStartRef.current) / 1000)
            : 0;
        elapsedSecRef.current = elapsed;
        try {
          if (textRef.current) {
            textRef.current.content = busyLine(tickRef.current, cp, statusRef.current, elapsed, w);
          }
        } catch {}
      },
      reduced ? 1000 : BAKE_ART_TICK_MS,
    );
    return () => clearInterval(timer);
  }, [showBusy]);

  if (!showBusy) return null;

  return (
    <box height={1} flexShrink={0}>
      <text
        ref={textRef}
        wrapMode="none"
        content={busyLine(
          tickRef.current,
          isCompacting,
          statusRef.current,
          elapsedSecRef.current,
          width,
        )}
      />
    </box>
  );
}
