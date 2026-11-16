import type { RunPolicy } from "./schemas.js";
import { stopMode } from "./stop-reasons.js";
import type { WorkflowStore } from "./store.js";

/**
 * When a provider's usage limit lifts, as a time (#3056). `usageLimitReset` (retry.ts) keeps the
 * provider's own words; this resolves them:
 * - an ISO time (Claude Code's epoch form, a long `retry-after`);
 * - a wall time, with an optional date and time zone: "9:10pm (Europe/Warsaw)", "3pm",
 *   "Nov 20, 10am", "Oct 22nd, 2026 10:55 AM", "2026-11-01 at 00:00 UTC". A wall time with no date
 *   is its next occurrence after `now`; a date with no year is this year's, or next year's when
 *   this year's passed more than a day ago. No zone is the host's own, the zone the provider's CLI
 *   printed in;
 * - a duration from `now`: "4 days 3 hours", "in 20 minutes".
 * Anything else is null: the run waits for a person, as before.
 */
export function resolveUsageLimitReset(
  words: string,
  now: Date = new Date(),
  hostZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): { at: Date; zone: string } | null {
  const text = words.trim();
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const at = Date.parse(text);
    return Number.isFinite(at) ? { at: new Date(at), zone: "UTC" } : null;
  }
  const duration = durationMs(text);
  if (duration !== null) return { at: new Date(now.getTime() + duration), zone: hostZone };
  const zoneMatch =
    /\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\)\s*$/.exec(text) ?? /\s(UTC|GMT)\s*$/.exec(text);
  const zone = zoneMatch?.[1] === "GMT" ? "UTC" : (zoneMatch?.[1] ?? hostZone);
  if (!validZone(zone)) return null;
  const body = zoneMatch ? text.slice(0, zoneMatch.index).trim() : text;
  const time = /(?:^|[\s,])(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(body);
  if (!time) return null;
  let hour = Number(time[1]);
  const minute = Number(time[2] ?? 0);
  const half = time[3]?.toLowerCase();
  if (!half && time[2] === undefined) return null;
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const datePart = body.slice(0, time.index).replace(/[\s,]+$/, "");
  const today = zonedParts(now.getTime(), zone);
  if (!datePart) {
    let at = zonedToUtc(today.year, today.month, today.day, hour, minute, zone);
    if (at <= now.getTime()) {
      const next = zonedParts(at + 24 * 3_600_000, zone);
      at = zonedToUtc(next.year, next.month, next.day, hour, minute, zone);
    }
    return { at: new Date(at), zone };
  }
  const date = parseDate(datePart);
  if (!date) return null;
  const year = date.year ?? today.year;
  let at = zonedToUtc(year, date.month, date.day, hour, minute, zone);
  if (date.year === undefined && at < now.getTime() - 24 * 3_600_000)
    at = zonedToUtc(year + 1, date.month, date.day, hour, minute, zone);
  return { at: new Date(at), zone };
}

const UNITS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1000,
};

function durationMs(text: string): number | null {
  const body = text.replace(/^in\s+/i, "");
  const part = /(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
  let total = 0;
  let rest = body;
  for (const match of body.matchAll(part)) {
    const unit = (match[2] as string).toLowerCase();
    const scale = UNITS[unit.startsWith("min") || unit === "m" ? "m" : (unit[0] as string)];
    if (!scale) return null;
    total += Number(match[1]) * scale;
    rest = rest.replace(match[0], "");
  }
  return total > 0 && /^[\s,and]*$/i.test(rest) ? total : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseDate(text: string): { year?: number; month: number; day: number } | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:\s+at)?$/i.exec(text);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  const named =
    /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?:\s+at)?$/i.exec(text);
  if (!named) return null;
  const month = MONTHS.indexOf((named[1] as string).toLowerCase()) + 1;
  if (month === 0) return null;
  return {
    ...(named[3] ? { year: Number(named[3]) } : {}),
    month,
    day: Number(named[2]),
  };
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function zonedParts(utcMs: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** The UTC time of a wall time in `zone`, through the zone's offset at that time. */
function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (utc: number) => {
    const p = zonedParts(utc, zone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utc;
  };
  const first = wall - offset(wall);
  return wall - offset(first);
}

/** The time after the stated reset before the host would resume: the reset is to the minute. */
export const USAGE_LIMIT_RESUME_MARGIN_MS = 5 * 60_000;

/**
 * Records `decision.would_resume` for a run that has just blocked `provider_account` on a usage
 * limit whose reset resolves to a time (`host-resume-on-usage-limit-reset`, shadow, #3056), once
 * per block (`stop-<diagnostic id>`). The inputs keep the provider's words, the zone they were
 * read in, the reset and the resume time, so a replay can check them against when the account
 * answered again. Never resumes. Returns whether it recorded.
 */
export function noteUsageLimitResume(
  store: WorkflowStore,
  runId: string,
  diagnosticId: string,
  words: string,
  at: "drive" | "provider-wait",
  now: Date = new Date(),
): boolean {
  const run = store.run(runId);
  if (run.status !== "blocked" || run.reason !== "provider_account") return false;
  const mode = stopMode(
    JSON.parse(run.policy_json) as RunPolicy,
    "host-resume-on-usage-limit-reset",
  );
  if (mode === "enforce") return false;
  const key = `stop-${diagnosticId}`;
  const seen = store
    .eventsOfType(runId, "decision.would_resume")
    .some(
      (e) =>
        e.type === "decision.would_resume" &&
        e.payload.reason === "host-resume-on-usage-limit-reset" &&
        e.payload.key === key,
    );
  if (seen) return false;
  const reset = resolveUsageLimitReset(words, now);
  if (!reset) return false;
  const resumeAt = new Date(
    Math.max(reset.at.getTime(), now.getTime()) + USAGE_LIMIT_RESUME_MARGIN_MS,
  );
  store.emit(runId, {
    type: "decision.would_resume",
    payload: {
      reason: "host-resume-on-usage-limit-reset",
      mode,
      key,
      summary:
        `The host would resume the run once at ${resumeAt.toISOString()}: the provider's usage limit resets ${words} (${reset.at.toISOString()}).`.slice(
          0,
          1000,
        ),
      inputs: {
        words,
        zone: reset.zone,
        resetAt: reset.at.toISOString(),
        resumeAt: resumeAt.toISOString(),
        marginMs: USAGE_LIMIT_RESUME_MARGIN_MS,
        observedAt: now.toISOString(),
        at,
        diagnosticId,
      },
    },
  });
  return true;
}
