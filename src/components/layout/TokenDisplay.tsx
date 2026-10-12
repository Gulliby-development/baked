import { fg as fgStyle, StyledText, type TextRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { getThemeTokens, useTheme } from "../../core/theme/index.js";
import {
  computeTotalCostFromBreakdown,
  isModelFree,
  useStatusBarStore,
} from "../../stores/statusbar.js";

const STEP_MS = 50;
const EASE = 0.35;

function approach(current: number, target: number): number {
  if (current === target) return target;
  const next = current + (target - current) * EASE;
  return Math.abs(next - target) < 1 ? target : Math.round(next);
}

function fmtCost(usd: number): string {
  if (!Number.isFinite(usd)) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function buildContent(costCents: number, cacheHitPct: number, free: boolean): StyledText {
  const tk = getThemeTokens();
  if (free) return new StyledText([fgStyle(tk.success)("FREE")]);
  const cost = costCents / 100;
  if (cost <= 0) return new StyledText([fgStyle(tk.textFaint)("$0")]);
  const color = cacheHitPct > 50 ? tk.success : tk.textSecondary;
  return new StyledText([fgStyle(color)(fmtCost(cost))]);
}

/** Session cost for the header. The count eases toward a new total, and its timer stops once settled. */
export function TokenDisplay() {
  const theme = useTheme();
  const textRef = useRef<TextRenderable>(null);
  const currentCostRef = useRef(0);
  const cacheHitRef = useRef(0);
  const freeRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the theme only triggers a repaint
  useEffect(() => {
    let target = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    const paint = () => {
      try {
        if (textRef.current)
          textRef.current.content = buildContent(
            currentCostRef.current,
            cacheHitRef.current,
            freeRef.current,
          );
      } catch {}
    };
    const step = () => {
      currentCostRef.current = approach(currentCostRef.current, target);
      paint();
      if (currentCostRef.current === target && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const read = (state: ReturnType<typeof useStatusBarStore.getState>) => {
      const usage = state.tokenUsage;
      const breakdown = usage.modelBreakdown;
      // Free only when every model in the breakdown is local or free.
      const modelIds = Object.keys(breakdown);
      freeRef.current = modelIds.length > 0 && modelIds.every((mid) => isModelFree(mid));
      const rawCost =
        breakdown && modelIds.length > 0 ? computeTotalCostFromBreakdown(breakdown) : 0;
      target = Number.isFinite(rawCost) ? Math.round(rawCost * 100) : 0;
      const totalInput = usage.prompt + usage.subagentInput + usage.cacheRead + usage.cacheWrite;
      cacheHitRef.current = totalInput > 0 ? Math.round((usage.cacheRead / totalInput) * 100) : 0;
    };
    read(useStatusBarStore.getState());
    currentCostRef.current = target;
    paint();
    const off = useStatusBarStore.subscribe((state) => {
      read(state);
      if (currentCostRef.current === target) paint();
      else if (!timer) timer = setInterval(step, STEP_MS);
    });
    return () => {
      off();
      if (timer) clearInterval(timer);
    };
  }, [theme]);

  return (
    <text
      ref={textRef}
      truncate
      content={buildContent(currentCostRef.current, cacheHitRef.current, freeRef.current)}
    />
  );
}
