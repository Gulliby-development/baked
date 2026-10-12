import { fg as fgStyle, StyledText, type TextRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { ContextManager } from "../../core/context/manager.js";
import { icon } from "../../core/icons.js";
import { getThemeTokens, useTheme } from "../../core/theme/index.js";
import { reducedMotion } from "../../core/utils/motion.js";
import { SPINNER_TICK_MS, spinnerGlyph } from "../../core/utils/spinner.js";
import { useStatusBarStore } from "../../stores/statusbar.js";
import { useWorkerStore, type WorkerStatus } from "../../stores/workers.js";

export const METER_WIDTH = 8;
/** Context use at or above this percentage paints the meter red. */
export const METER_DANGER_PCT = 85;
const CHARS_PER_TOKEN = 4;
const STEP_MS = 50;
const EASE = 0.35;
const MEMORY_HINT_INTERVAL_MS = 30_000;

function approach(current: number, target: number): number {
  if (current === target) return target;
  const next = current + (target - current) * EASE;
  return Math.abs(next - target) < 1 ? target : Math.round(next);
}

export function meterColor(pct: number): string {
  const tk = getThemeTokens();
  if (pct >= METER_DANGER_PCT) return tk.error;
  return pct < 50 ? tk.success : tk.warning;
}

function humanizeTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

interface BarTarget {
  pct: number;
  live: boolean;
  usedTokens: number;
  windowTokens: number;
}

interface WorkerIndicator {
  intel: WorkerStatus;
  io: WorkerStatus;
}

export interface ContextMeterState {
  pct: number;
  live: boolean;
  usedTokens: number;
  windowTokens: number;
  /** Spinner tick while compacting, null otherwise. */
  compactFrame?: number | null;
  workers?: WorkerIndicator;
  browsing?: boolean;
  memoryHint?: { stale: number } | null;
}

/** `████░░░░ 52% ~104k/200k`: a block meter, green, then amber, then red from 85%. */
export function buildContextMeter(state: ContextMeterState): StyledText {
  const { pct, live, usedTokens, windowTokens, workers, browsing, memoryHint } = state;
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * METER_WIDTH);
  const t = getThemeTokens();
  const color = browsing ? t.warning : meterColor(pct);
  const tokenLabel =
    usedTokens > 0 ? ` ~${humanizeTokens(usedTokens)}/${humanizeTokens(windowTokens)}` : "";
  const chunks = [
    ...(browsing ? [fgStyle(t.warning)("◄ ")] : []),
    fgStyle(color)("█".repeat(filled)),
    fgStyle(t.textFaint)("░".repeat(METER_WIDTH - filled)),
    fgStyle(color)(live && !browsing ? ` ${String(pct)}%` : ` ~${String(pct)}%`),
    fgStyle(t.textDim)(tokenLabel),
  ];
  if (browsing) return new StyledText(chunks);
  if (state.compactFrame != null) {
    chunks.push(fgStyle(t.info)(` ${spinnerGlyph(state.compactFrame)} compacting`));
  }
  if (workers) {
    const worst =
      workers.intel === "crashed" || workers.io === "crashed"
        ? "crashed"
        : workers.intel === "restarting" || workers.io === "restarting"
          ? "restarting"
          : null;
    if (worst) {
      const wColor = worst === "crashed" ? t.error : t.warning;
      const wGlyph = worst === "crashed" ? icon("worker_crash") : icon("worker_restart");
      chunks.push(fgStyle(wColor)(` ${wGlyph}`));
    }
  }
  if (memoryHint && memoryHint.stale > 0) {
    chunks.push(
      fgStyle(t.warning)(
        ` ${icon("cleanup")} ${String(memoryHint.stale)} stale memor${memoryHint.stale === 1 ? "y" : "ies"} — /memory cleanup`,
      ),
    );
  }
  return new StyledText(chunks);
}

interface Props {
  contextManager: ContextManager;
  modelId: string;
  suppressCompacting?: boolean;
}

/**
 * Context budget meter for the header. It repaints on store changes; a timer runs only while
 * the meter eases toward a new value or the compaction spinner turns, so an idle screen
 * schedules nothing.
 */
export function ContextBar({ contextManager, suppressCompacting }: Props) {
  const theme = useTheme();
  const textRef = useRef<TextRenderable>(null);
  const suppressRef = useRef(suppressCompacting);
  suppressRef.current = suppressCompacting;
  const renderedRef = useRef<StyledText | null>(null);
  const repaintRef = useRef<() => void>(() => {});

  useEffect(() => {
    let target: BarTarget = { pct: 0, live: false, usedTokens: 0, windowTokens: 200_000 };
    let currentPct = 0;
    let compactFrame = 0;
    let workers: WorkerIndicator = { intel: "idle", io: "idle" };
    let memoryHint: { stale: number } | null = null;
    let memoryCheckedAt = Number.NEGATIVE_INFINITY;
    let lastKey = "";
    let timer: ReturnType<typeof setInterval> | null = null;

    const computeTarget = () => {
      const state = useStatusBarStore.getState();
      const ctxWindow = state.contextWindow || 200_000;
      const isApi = state.contextTokens > 0;
      const breakdown = contextManager.getContextBreakdown();
      const systemChars = breakdown.reduce((sum, s) => sum + s.chars, 0);
      const charEstimate = (systemChars + state.chatChars + state.subagentChars) / CHARS_PER_TOKEN;
      const chatCharsDelta = Math.max(0, state.chatChars - state.chatCharsAtSnapshot);
      const totalTokens = isApi
        ? state.contextTokens + (chatCharsDelta + state.subagentChars) / CHARS_PER_TOKEN
        : charEstimate;
      const pct =
        totalTokens > 0
          ? Math.min(100, Math.max(1, Math.round((totalTokens / ctxWindow) * 100)))
          : 0;
      target = { pct, live: isApi, usedTokens: totalTokens, windowTokens: ctxWindow };
    };

    // Polled from store updates instead of a timer: stale memories only appear after work.
    const refreshMemoryHint = () => {
      const now = Date.now();
      if (now - memoryCheckedAt < MEMORY_HINT_INTERVAL_MS) return;
      memoryCheckedAt = now;
      try {
        const next = contextManager.getMemoryManager().cleanupHint();
        memoryHint = next ? { stale: next.stale } : null;
      } catch {}
    };

    const isCompacting = () => !suppressRef.current && useStatusBarStore.getState().compacting;

    const paint = () => {
      const compacting = isCompacting();
      const state: ContextMeterState = {
        ...target,
        pct: currentPct,
        compactFrame: compacting ? compactFrame : null,
        workers,
        browsing: useStatusBarStore.getState().browsingCheckpoint,
        memoryHint,
      };
      const key = JSON.stringify(state);
      if (key === lastKey) return;
      lastKey = key;
      try {
        const content = buildContextMeter(state);
        renderedRef.current = content;
        if (textRef.current) textRef.current.content = content;
      } catch {}
    };

    let timerMs = 0;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    const spinning = () => isCompacting() && !reducedMotion();

    const schedule = () => {
      const easing = currentPct !== target.pct;
      if (!easing && !spinning()) {
        stop();
        return;
      }
      const ms = easing ? STEP_MS : SPINNER_TICK_MS;
      if (timer && timerMs === ms) return;
      stop();
      timerMs = ms;
      timer = setInterval(step, ms);
    };

    function step() {
      if (spinning()) compactFrame++;
      currentPct = approach(currentPct, target.pct);
      paint();
      schedule();
    }

    const wake = () => {
      paint();
      schedule();
    };

    repaintRef.current = () => {
      lastKey = "";
      wake();
    };

    computeTarget();
    refreshMemoryHint();
    currentPct = target.pct;
    wake();

    const offStatus = useStatusBarStore.subscribe(() => {
      computeTarget();
      refreshMemoryHint();
      wake();
    });
    const offWorkers = useWorkerStore.subscribe((state) => {
      workers = { intel: state.intelligence.status, io: state.io.status };
      wake();
    });
    return () => {
      offStatus();
      offWorkers();
      stop();
      repaintRef.current = () => {};
    };
  }, [contextManager]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: theme and suppression only trigger a repaint
  useEffect(() => {
    repaintRef.current();
  }, [theme, suppressCompacting]);

  return <text ref={textRef} truncate content={renderedRef.current ?? ""} />;
}
