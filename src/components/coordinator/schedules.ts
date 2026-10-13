/** Lines of the terminal coordinator view's schedule block, kept free of React for tests. */
import { describeWhen, type Schedule } from "../../core/chat/coordinator-schedules.js";
import type { ViewLine } from "./model.js";

/** When a schedule fires next, in words: today's times as `HH:MM`, later ones with the date. */
export function nextLabel(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (new Date(now).toDateString() === date.toDateString()) return time;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${time}`;
}

/** One line per schedule: whether it runs, its name, when, and when it fires next. */
export function scheduleLines(schedules: Schedule[], width: number, now = Date.now()): ViewLine[] {
  return schedules.map((s) => {
    const next = s.enabled ? `next ${nextLabel(s.nextRunAt, now)}` : "paused";
    const text = `${s.enabled ? "◷" : "‖"} ${s.name} · ${describeWhen(s.when)} · ${next}`;
    return {
      text: text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text,
      tone: s.enabled ? ("accent" as const) : ("muted" as const),
    };
  });
}
