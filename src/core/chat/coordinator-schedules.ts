/**
 * Schedules of the project coordinator: prompts that start a coordinator turn on their own, such
 * as a nightly check or a morning summary. They live in `.baked/sessions/ID/schedules.json` next
 * to the brief, so they survive restarts, and fire only while a host of the coordinator runs
 * (`baked serve` or the terminal UI's coordinator). A schedule whose time passed while nothing ran
 * fires once when a host starts, then goes on from that moment.
 *
 * A schedule's `when` is `every N` with a unit (`every 30m`, `every 6h`, `every 1d`), a five-field
 * cron expression in local time (`0 9 * * 1-5`) or one of `@hourly`, `@daily`, `@weekly`,
 * `@monthly`. Two hosts of the same project may run at once; a lock file lets only one of them
 * claim each firing.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { writeViaTemp } from "../workflows/atomic-write.js";

export const SCHEDULE_TOOL = "coordinator_schedule";
export const MAX_SCHEDULES = 20;
/** The shortest time between two firings of one schedule. */
export const MIN_GAP_MS = 5 * 60_000;
/** How often a host checks for due schedules. */
export const SCHEDULE_TICK_MS = 30_000;
/** A lock older than this was left by a host that died and is taken over. */
const STALE_LOCK_MS = 30_000;

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

export const ScheduleInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(4000),
  when: z.string().trim().min(1).max(100),
});
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;

export const ScheduleSchema = ScheduleInputSchema.extend({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  enabled: z.boolean(),
  createdAt: z.number(),
  lastRunAt: z.number().nullable(),
  nextRunAt: z.number(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export class ScheduleError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "NOT_FOUND" | "LIMIT",
    message: string,
  ) {
    super(message);
  }
}

/** One cron field as the set of values it allows; null for `*`. */
type Field = Set<number> | null;
interface Cron {
  minute: Field;
  hour: Field;
  day: Field;
  month: Field;
  weekday: Field;
}
type When = { kind: "every"; ms: number } | { kind: "cron"; cron: Cron };

const RANGES: [keyof Cron, number, number][] = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day", 1, 31],
  ["month", 1, 12],
  ["weekday", 0, 7],
];

function parseField(text: string, name: string, min: number, max: number): Field {
  if (text === "*") return null;
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match)
      throw new ScheduleError("INVALID_REQUEST", `Cannot read the ${name} field "${text}"`);
    const [, range, from, to, step] = match;
    const start = range === "*" ? min : Number(from);
    const end = range === "*" ? max : to !== undefined ? Number(to) : step ? max : start;
    const by = step ? Number(step) : 1;
    if (start < min || end > max || start > end || by < 1)
      throw new ScheduleError(
        "INVALID_REQUEST",
        `The ${name} field "${text}" must stay within ${min}-${max}`,
      );
    for (let v = start; v <= end; v += by) values.add(name === "weekday" && v === 7 ? 0 : v);
  }
  return values;
}

/** Reads a schedule's `when`; throws ScheduleError when it cannot. */
export function parseWhen(text: string): When {
  const when = text.trim().toLowerCase();
  const every = /^every\s+(\d+)\s*([mhd])$/.exec(when);
  if (every)
    return { kind: "every", ms: Number(every[1]) * UNIT_MS[every[2] as keyof typeof UNIT_MS] };
  const fields = (ALIASES[when] ?? when).split(/\s+/);
  if (fields.length !== 5)
    throw new ScheduleError(
      "INVALID_REQUEST",
      `"${text}" is not a schedule: use "every 30m", "every 6h", "every 1d", a five-field cron expression such as "0 9 * * 1-5", or @hourly, @daily, @weekly, @monthly`,
    );
  const cron = {} as Cron;
  for (const [i, [name, min, max]] of RANGES.entries())
    cron[name] = parseField(fields[i] ?? "", name, min, max);
  return { kind: "cron", cron };
}

const has = (field: Field, value: number): boolean => field === null || field.has(value);

function cronDay(cron: Cron, date: Date): boolean {
  // As in cron: with both day fields restricted, either one matching is enough.
  const day = has(cron.day, date.getDate());
  const weekday = has(cron.weekday, date.getDay());
  return cron.day !== null && cron.weekday !== null ? day || weekday : day && weekday;
}

/** The first minute after `after` that the cron expression names, in local time. */
function nextCron(cron: Cron, after: number): number {
  const date = new Date(after);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = after + 5 * 366 * UNIT_MS.d;
  while (date.getTime() <= limit) {
    if (!has(cron.month, date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1);
      date.setHours(0, 0);
    } else if (!cronDay(cron, date)) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0);
    } else if (!has(cron.hour, date.getHours())) {
      date.setHours(date.getHours() + 1, 0);
    } else if (!has(cron.minute, date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1);
    } else return date.getTime();
  }
  throw new ScheduleError("INVALID_REQUEST", "This schedule never fires");
}

/** When a schedule fires next after `after`. */
export function nextRun(when: string, after: number): number {
  const parsed = parseWhen(when);
  return parsed.kind === "every" ? after + parsed.ms : nextCron(parsed.cron, after);
}

/** Checks a `when` for a new schedule: readable, and firing at most every five minutes. */
export function checkWhen(when: string, now: number): void {
  const parsed = parseWhen(when);
  if (parsed.kind === "every") {
    if (parsed.ms < MIN_GAP_MS)
      throw new ScheduleError("INVALID_REQUEST", "A schedule fires at most every 5 minutes");
    return;
  }
  let at = nextCron(parsed.cron, now);
  for (let i = 0; i < 4; i++) {
    const following = nextCron(parsed.cron, at);
    if (following - at < MIN_GAP_MS)
      throw new ScheduleError("INVALID_REQUEST", "A schedule fires at most every 5 minutes");
    at = following;
  }
}

/** A `when` in words, for lists and the turn a schedule starts. */
export function describeWhen(when: string): string {
  const every = /^every\s+(\d+)\s*([mhd])$/i.exec(when.trim());
  if (!every) return when.trim();
  const n = Number(every[1]);
  const unit = { m: "minute", h: "hour", d: "day" }[(every[2] ?? "m").toLowerCase()] ?? "minute";
  return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
}

/** The message a schedule starts its coordinator turn with. */
export function scheduledTurnText(schedule: Pick<Schedule, "name" | "when" | "prompt">): string {
  return [
    `[Scheduled task "${schedule.name}" (${describeWhen(schedule.when)}). No person sent this message and nobody may be watching: do what it asks, keep the brief current, and leave every decision to the user.]`,
    "",
    schedule.prompt,
  ].join("\n");
}

/** A short id from the name, unique among `taken`. */
function scheduleId(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "schedule";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Reads and writes one coordinator's schedules. */
export class ScheduleStore {
  readonly path: string;
  private readonly lockPath: string;

  constructor(workspace: string, sessionId: string) {
    this.path = join(workspace, ".baked", "sessions", sessionId, "schedules.json");
    this.lockPath = `${this.path}.lock`;
  }

  list(): Schedule[] {
    if (!existsSync(this.path)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8")) as { schedules?: unknown };
      return z.array(ScheduleSchema).parse(raw.schedules ?? []);
    } catch {
      // A damaged file must not stop the coordinator; the next change replaces it.
      return [];
    }
  }

  get(id: string): Schedule {
    const schedule = this.list().find((s) => s.id === id);
    if (!schedule) throw new ScheduleError("NOT_FOUND", `No schedule ${id}`);
    return schedule;
  }

  add(input: ScheduleInput, now = Date.now()): Schedule {
    const parsed = ScheduleInputSchema.safeParse(input);
    if (!parsed.success)
      throw new ScheduleError(
        "INVALID_REQUEST",
        parsed.error.issues[0]?.message ?? "Invalid schedule",
      );
    checkWhen(parsed.data.when, now);
    return this.change((schedules) => {
      if (schedules.length >= MAX_SCHEDULES)
        throw new ScheduleError(
          "LIMIT",
          `A project has at most ${MAX_SCHEDULES} schedules; remove one first`,
        );
      const schedule: Schedule = {
        id: scheduleId(parsed.data.name, new Set(schedules.map((s) => s.id))),
        ...parsed.data,
        enabled: true,
        createdAt: now,
        lastRunAt: null,
        nextRunAt: nextRun(parsed.data.when, now),
      };
      return { schedules: [...schedules, schedule], result: schedule };
    });
  }

  /** Pauses or resumes a schedule; a resumed one goes on from now without catching up. */
  setEnabled(id: string, enabled: boolean, now = Date.now()): Schedule {
    return this.change((schedules) => {
      const current = schedules.find((s) => s.id === id);
      if (!current) throw new ScheduleError("NOT_FOUND", `No schedule ${id}`);
      const next: Schedule = {
        ...current,
        enabled,
        ...(enabled && !current.enabled ? { nextRunAt: nextRun(current.when, now) } : {}),
      };
      return { schedules: schedules.map((s) => (s.id === id ? next : s)), result: next };
    });
  }

  remove(id: string): void {
    this.change((schedules) => {
      if (!schedules.some((s) => s.id === id))
        throw new ScheduleError("NOT_FOUND", `No schedule ${id}`);
      return { schedules: schedules.filter((s) => s.id !== id), result: undefined };
    });
  }

  /**
   * Takes the schedules due at `now` and moves each to its next time after `now`, so a run that
   * was missed fires once, not once per missed time. Returns them as they were claimed.
   */
  claimDue(now = Date.now()): Schedule[] {
    if (!existsSync(this.path)) return [];
    return this.change((schedules) => {
      const due: Schedule[] = [];
      const next = schedules.map((s) => {
        if (!s.enabled || s.nextRunAt > now) return s;
        const fired = { ...s, lastRunAt: now, nextRunAt: nextRun(s.when, now) };
        due.push(fired);
        return fired;
      });
      return { schedules: due.length ? next : null, result: due };
    });
  }

  /** Reads, changes and writes the schedules while holding the lock; `null` writes nothing. */
  private change<T>(
    edit: (schedules: Schedule[]) => { schedules: Schedule[] | null; result: T },
  ): T {
    mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
    this.lock();
    try {
      const { schedules, result } = edit(this.list());
      if (schedules)
        writeViaTemp(this.path, `${JSON.stringify({ schedules }, null, 2)}\n`, {
          flag: "w",
          flush: true,
          mode: 0o600,
        });
      return result;
    } finally {
      rmSync(this.lockPath, { force: true });
    }
  }

  private lock(): void {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        writeFileSync(this.lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > STALE_LOCK_MS)
            rmSync(this.lockPath, { force: true });
        } catch {
          // Released meanwhile; try again.
        }
        Bun.sleepSync(10);
      }
    }
    throw new Error("The schedules are locked by another BAKED process; try again");
  }
}

/** The coordinator's part of the system prompt about schedules. */
export function scheduleInstructions(store: ScheduleStore): string {
  const schedules = store.list();
  return [
    "### Schedules",
    `With the ${SCHEDULE_TOOL} tool you add, list, pause, resume and remove schedules: prompts that start a coordinator turn on their own (every 30m/6h/1d, a cron expression in local time, or @daily and the like) while BAKED runs. Add one only when the user asks for recurring work; the user confirms each new schedule.`,
    schedules.length
      ? schedules
          .map(
            (s) =>
              `- ${s.id} "${s.name}" ${describeWhen(s.when)}${s.enabled ? "" : " (paused)"}: ${s.prompt.replace(/\s+/g, " ").slice(0, 200)}`,
          )
          .join("\n")
      : "(no schedules)",
  ].join("\n");
}

/** One line per schedule, for the tool's output and the CLI. */
export function scheduleLine(s: Schedule): string {
  const next = s.enabled ? `next ${new Date(s.nextRunAt).toLocaleString()}` : "paused";
  return `${s.id}  ${describeWhen(s.when)}  ${next}  ${s.name}`;
}

const ScheduleToolInput = z.strictObject({
  action: z.enum(["list", "add", "pause", "resume", "remove"]),
  id: z.string().optional().describe("The schedule to pause, resume or remove"),
  name: z.string().optional().describe("For add: a short name"),
  prompt: z.string().optional().describe("For add: what the coordinator does when it fires"),
  when: z
    .string()
    .optional()
    .describe('For add: "every 30m", "every 6h", "every 1d", "0 9 * * 1-5" or @daily'),
});

/** The tool the coordinator manages its schedules with; adding one asks the person first. */
export function scheduleTool(store: ScheduleStore, confirm: (text: string) => Promise<boolean>) {
  const failed = (error: string) => ({ success: false, output: "", error });
  return tool({
    description:
      "Manage the project's schedules: prompts that start a coordinator turn on their own at set times while BAKED runs. add asks the user to confirm.",
    inputSchema: ScheduleToolInput,
    execute: async (args: z.infer<typeof ScheduleToolInput>) => {
      try {
        if (args.action === "list") {
          const schedules = store.list();
          return {
            success: true,
            output: schedules.length
              ? schedules.map((s) => `${scheduleLine(s)}: ${s.prompt}`).join("\n")
              : "No schedules.",
          };
        }
        if (args.action === "add") {
          const input = ScheduleInputSchema.safeParse({
            name: args.name ?? "",
            prompt: args.prompt ?? "",
            when: args.when ?? "",
          });
          if (!input.success) return failed("add needs name, prompt and when");
          checkWhen(input.data.when, Date.now());
          if (
            !(await confirm(
              `Add the schedule "${input.data.name}" (${describeWhen(input.data.when)}): ${input.data.prompt}`,
            ))
          )
            return failed("The user declined the schedule");
          const added = store.add(input.data);
          return { success: true, output: `Added: ${scheduleLine(added)}` };
        }
        if (!args.id) return failed(`${args.action} needs the schedule's id`);
        if (args.action === "remove") {
          store.remove(args.id);
          return { success: true, output: `Removed schedule ${args.id}.` };
        }
        const changed = store.setEnabled(args.id, args.action === "resume");
        return { success: true, output: scheduleLine(changed) };
      } catch (err) {
        return failed(err instanceof Error ? err.message : String(err));
      }
    },
  });
}
