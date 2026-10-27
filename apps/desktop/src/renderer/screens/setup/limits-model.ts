import type { LimitWindow, ProviderLimits } from "../../client/setup.js";
import type { Tone } from "../../components/ui/tone.js";

/** How much of a window is left, 0-100; 100 for an unlimited quota, null when unknown. */
export function leftPercent(w: LimitWindow): number | null {
  if (w.unlimited) return 100;
  if (w.usedPercent === null) return null;
  return Math.min(100, Math.max(0, 100 - w.usedPercent));
}

export function windowTone(w: LimitWindow): Tone {
  if (w.unlimited) return "ok";
  if (w.usedPercent === null) return "plain";
  return w.status === "limited" ? "err" : w.status === "warning" ? "warn" : "ok";
}

/** A provider's colour: its tightest window, or plain while there is nothing to show. */
export function providerTone(p: ProviderLimits): Tone {
  if (p.state === "error") return "warn";
  if (p.state !== "ok" || p.windows.length === 0) return "plain";
  const tones = p.windows.map(windowTone);
  return tones.includes("err") ? "err" : tones.includes("warn") ? "warn" : "ok";
}

/** The window shown large on a provider's card: the one with the least left. */
export function headlineWindow(p: ProviderLimits): LimitWindow | null {
  let best: LimitWindow | null = null;
  for (const w of p.windows) {
    const left = leftPercent(w);
    if (left === null || w.unlimited) continue;
    if (!best || left < (leftPercent(best) ?? 101)) best = w;
  }
  return best;
}

/** `3 h 12 min`, `2 d 4 h`, `now`: the time until a reset. */
export function resetsIn(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "now";
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${String(min)} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${String(h)} h ${String(min % 60)} min`;
  return `${String(Math.floor(h / 24))} d ${String(h % 24)} h`;
}

/** How fresh the numbers are: `live` or `seen 42 min ago`. */
export function freshness(p: ProviderLimits, now: number): string | null {
  if (p.source === "live") return "live";
  if (p.source !== "last-seen" || !p.observedAt) return null;
  const min = Math.max(0, Math.round((now - Date.parse(p.observedAt)) / 60_000));
  if (!Number.isFinite(min)) return null;
  if (min < 1) return "seen just now";
  if (min < 60) return `seen ${String(min)} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `seen ${String(h)} h ago`;
  return `seen ${String(Math.floor(h / 24))} d ago`;
}

/** `pro` → `Pro`, `individual_pro` → `Individual pro`. */
export function planLabel(plan: string | null): string | null {
  if (!plan) return null;
  const words = plan.replace(/[_-]+/g, " ").trim();
  return words ? words[0]?.toUpperCase() + words.slice(1) : null;
}
