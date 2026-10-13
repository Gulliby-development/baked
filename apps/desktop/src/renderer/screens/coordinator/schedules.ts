import type { Schedule } from "../../client/coordinator.js";

/** Ready-made `when` values the add form offers; any other `when` can be typed. */
export const WHEN_PRESETS: { label: string; when: string }[] = [
  { label: "Every hour", when: "@hourly" },
  { label: "Daily 09:00", when: "0 9 * * *" },
  { label: "Weekdays 09:00", when: "0 9 * * 1-5" },
  { label: "Nightly 02:00", when: "0 2 * * *" },
  { label: "Mondays 10:00", when: "0 10 * * 1" },
];

const UNITS: Record<string, string> = { m: "minute", h: "hour", d: "day" };
const ALIASES: Record<string, string> = {
  "@hourly": "every hour",
  "@daily": "every day at 00:00",
  "@weekly": "Sundays at 00:00",
  "@monthly": "the 1st of each month at 00:00",
};

/** A `when` in words where it is simple; a cron expression otherwise stays as written. */
export function describeWhen(when: string): string {
  const trimmed = when.trim().toLowerCase();
  const every = /^every\s+(\d+)\s*([mhd])$/.exec(trimmed);
  if (every) {
    const n = Number(every[1]);
    const unit = UNITS[every[2] ?? "m"] ?? "minute";
    return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
  }
  const alias = ALIASES[trimmed];
  if (alias) return alias;
  const preset = WHEN_PRESETS.find((p) => p.when === when.trim());
  return preset ? preset.label.toLowerCase() : when.trim();
}

/** When a schedule fires next: "today 09:00", "tomorrow 02:00" or "Mon 13 Oct 10:00". */
export function nextLabel(schedule: Pick<Schedule, "enabled" | "nextRunAt">, now = Date.now()) {
  if (!schedule.enabled) return "paused";
  const at = new Date(schedule.nextRunAt);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = new Date(now);
  if (at.toDateString() === day.toDateString()) return `today ${time}`;
  day.setDate(day.getDate() + 1);
  if (at.toDateString() === day.toDateString()) return `tomorrow ${time}`;
  const date = at.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  return `${date} ${time}`;
}
