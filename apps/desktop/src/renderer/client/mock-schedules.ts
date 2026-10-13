import type { Schedule, ScheduleInput } from "./coordinator.js";
import { type MockRoute, response } from "./mock-routes.js";

/** Each project's coordinator schedules in the mock; `when` is checked only roughly. */
const schedules = new Map<string, Schedule[]>();

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

function nextAfter(when: string, now: number): number | null {
  const every = /^every\s+(\d+)\s*([mhd])$/i.exec(when.trim());
  if (every) {
    const ms = Number(every[1]) * (UNIT_MS[(every[2] ?? "m").toLowerCase()] ?? 60_000);
    return ms >= 5 * 60_000 ? now + ms : null;
  }
  if (/^@(hourly|daily|weekly|monthly)$/i.test(when.trim())) return now + 3_600_000;
  return when.trim().split(/\s+/).length === 5 ? now + 6 * 3_600_000 : null;
}

const invalid = (message: string) => response(400, { error: { code: "INVALID_REQUEST", message } });

export const scheduleRoutes: MockRoute = ({ key, method, path, body }) => {
  if (!path.startsWith("/v1/coordinator/schedules")) return undefined;
  const list = schedules.get(key) ?? [];
  if (path === "/v1/coordinator/schedules") {
    if (method === "GET") return response(200, { schedules: list });
    if (method !== "POST") return undefined;
    const input = (body ?? {}) as ScheduleInput;
    if (!input.name?.trim() || !input.prompt?.trim()) return invalid("Give a name and a prompt");
    const now = Date.now();
    const next = nextAfter(input.when ?? "", now);
    if (next === null)
      return invalid(
        `"${input.when}" is not a schedule, or it fires more often than every 5 minutes`,
      );
    const base = input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    let id = base || "schedule";
    for (let n = 2; list.some((s) => s.id === id); n++) id = `${base}-${n}`;
    const schedule: Schedule = {
      id,
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      when: input.when.trim(),
      enabled: true,
      createdAt: now,
      lastRunAt: null,
      nextRunAt: next,
    };
    schedules.set(key, [...list, schedule]);
    return response(201, schedule);
  }
  const id = decodeURIComponent(path.slice("/v1/coordinator/schedules/".length));
  const current = list.find((s) => s.id === id);
  if (!current)
    return response(404, { error: { code: "NOT_FOUND", message: `No schedule ${id}` } });
  if (method === "DELETE") {
    schedules.set(
      key,
      list.filter((s) => s.id !== id),
    );
    return response(204, null);
  }
  if (method !== "PATCH") return undefined;
  const { enabled } = (body ?? {}) as { enabled: boolean };
  const changed = {
    ...current,
    enabled,
    nextRunAt:
      enabled && !current.enabled
        ? (nextAfter(current.when, Date.now()) ?? current.nextRunAt)
        : current.nextRunAt,
  };
  schedules.set(
    key,
    list.map((s) => (s.id === id ? changed : s)),
  );
  return response(200, changed);
};
