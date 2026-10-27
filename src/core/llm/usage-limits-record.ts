import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "../platform/index.js";

/**
 * The shapes, parsers and last-seen store of subscription usage limits; the readers live in
 * `usage-limits.ts`. This module imports no provider, so a provider's turn can record a report.
 *
 * How much of each subscription's usage limit is left (#2300). Every provider is read in the way
 * it offers: Codex answers `account/rateLimits/read` on its app-server, Claude Code reports
 * `rate_limit_event` during the turns BAKED runs (and has no read-only query), Copilot answers
 * `copilot_internal/user` with the GitHub token BAKED already uses. BAKED never reads a CLI's own
 * tokens. Pay-per-token API keys have no limit to show and are not listed.
 */

export type LimitProvider = "codex" | "claude-code" | "copilot";
export type LimitStatus = "ok" | "warning" | "limited";

export interface LimitWindow {
  /** Stable id within the provider: `primary`, `five_hour`, `premium_interactions`, ... */
  id: string;
  label: string;
  /** 0-100 (can pass 100 when usage ran past the cap); null when unknown. */
  usedPercent: number | null;
  /** ISO time the window resets; null when unknown. */
  resetsAt: string | null;
  /** Length of a rolling window in minutes, when the provider says. */
  windowMinutes: number | null;
  status: LimitStatus;
  /** `remaining of entitlement` for counted quotas (Copilot premium requests). */
  remaining?: number | null;
  entitlement?: number | null;
  unlimited?: boolean;
  detail?: string;
}

export interface ProviderLimits {
  provider: LimitProvider;
  name: string;
  /** `ok`: windows are shown; `no-data`: signed in but nothing reported yet; `not-signed-in`; `error`. */
  state: "ok" | "no-data" | "not-signed-in" | "error";
  /** `live`: asked just now; `last-seen`: the last report BAKED recorded, as of `observedAt`. */
  source: "live" | "last-seen" | null;
  observedAt: string | null;
  plan: string | null;
  windows: LimitWindow[];
  credits: { balance: string | null; unlimited: boolean } | null;
  /** One sentence for the person: where the numbers come from, or why there are none. */
  message: string;
}

const WARN_PERCENT = 80;

export function limitsStoreFile(): string {
  return join(dataDir(), "usage-limits.json");
}

type Store = Partial<Record<LimitProvider, ProviderLimits>>;

function readStore(file: string): Store {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

/** Saves a provider's latest report; a failed write only loses the cache. */
export function saveLimits(limits: ProviderLimits, file: string = limitsStoreFile()): void {
  try {
    const store = readStore(file);
    store[limits.provider] = limits;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
    renameSync(tmp, file);
  } catch {}
}

export function loadLimits(
  provider: LimitProvider,
  file: string = limitsStoreFile(),
): ProviderLimits | null {
  return readStore(file)[provider] ?? null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Unix seconds, unix milliseconds or an ISO string, as an ISO string. */
export function resetTime(value: unknown): string | null {
  const n = num(value);
  if (n !== null && n > 0) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

function statusOf(usedPercent: number | null, reported?: unknown): LimitStatus {
  if (reported === "rejected") return "limited";
  if (usedPercent !== null && usedPercent >= 100) return "limited";
  if (reported === "allowed_warning") return "warning";
  if (usedPercent !== null && usedPercent >= WARN_PERCENT) return "warning";
  return "ok";
}

/** `5-hour`, `Weekly`, `30-day`, from a rolling window's length. */
export function windowLabel(minutes: number | null, fallback: string): string {
  if (!minutes || minutes <= 0) return fallback;
  if (minutes === 10_080) return "Weekly";
  if (minutes % 1440 === 0) return `${String(minutes / 1440)}-day`;
  if (minutes % 60 === 0) return `${String(minutes / 60)}-hour`;
  return `${String(minutes)}-minute`;
}

/**
 * A window whose reset has passed since the report: its usage started again from zero, so the
 * old percentage would mislead. Shown as reset, with no percentage.
 */
export function ageWindows(limits: ProviderLimits, now: Date = new Date()): ProviderLimits {
  const windows = limits.windows.map((w) =>
    w.resetsAt && Date.parse(w.resetsAt) <= now.getTime()
      ? {
          ...w,
          usedPercent: null,
          resetsAt: null,
          status: "ok" as const,
          detail: "Reset since this was reported",
        }
      : w,
  );
  return { ...limits, windows };
}

// ── Codex ────────────────────────────────────────────────────────────────────

function codexWindows(snapshot: Record<string, unknown>, prefix: string): LimitWindow[] {
  const windows: LimitWindow[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const w = record(snapshot[key]);
    if (!w) continue;
    const minutes = num(w.windowDurationMins);
    const used = num(w.usedPercent);
    const base = windowLabel(minutes, key === "primary" ? "Short window" : "Long window");
    windows.push({
      id: prefix ? `${prefix}:${key}` : key,
      label: prefix ? `${prefix} · ${base}` : base,
      usedPercent: used,
      resetsAt: resetTime(w.resetsAt),
      windowMinutes: minutes,
      status: statusOf(used),
    });
  }
  return windows;
}

/** The answer of `account/rateLimits/read` (or the params of `account/rateLimits/updated`). */
export function parseCodexRateLimits(
  result: unknown,
  observedAt: Date = new Date(),
): ProviderLimits | null {
  const root = record(result);
  const main = record(root?.rateLimits);
  if (!root || !main) return null;
  const windows = codexWindows(main, "");
  const mainId = typeof main.limitId === "string" ? main.limitId : null;
  const byId = record(root.rateLimitsByLimitId);
  for (const [id, raw] of Object.entries(byId ?? {})) {
    const other = record(raw);
    if (!other || id === mainId || (mainId === null && id === "codex")) continue;
    const name = typeof other.limitName === "string" && other.limitName ? other.limitName : id;
    windows.push(...codexWindows(other, name));
  }
  const credits = record(main.credits);
  const plan = typeof main.planType === "string" ? main.planType : null;
  return {
    provider: "codex",
    name: "Codex",
    state: windows.length ? "ok" : "no-data",
    source: "live",
    observedAt: observedAt.toISOString(),
    plan,
    windows,
    credits:
      credits && credits.hasCredits === true
        ? {
            balance: typeof credits.balance === "string" ? credits.balance : null,
            unlimited: credits.unlimited === true,
          }
        : null,
    message: windows.length
      ? "Read from Codex just now."
      : "Codex reported no usage windows for this account.",
  };
}

/** Records what Codex sent in `account/rateLimits/updated` during a turn. */
export function recordCodexRateLimits(params: unknown, file?: string): void {
  const limits = parseCodexRateLimits(params);
  if (limits?.windows.length) saveLimits({ ...limits, source: "last-seen" }, file);
}

// ── Claude Code ──────────────────────────────────────────────────────────────

const CLAUDE_WINDOWS: Record<string, string> = {
  five_hour: "5-hour session",
  seven_day: "Weekly",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  seven_day_overage_included: "Weekly · with extra usage",
};
const CLAUDE_MINUTES: Record<string, number> = { five_hour: 300 };

function claudeWindow(id: string, w: Record<string, unknown>): LimitWindow {
  const utilization = num(w.utilization);
  const used = utilization === null ? null : Math.round(utilization * 1000) / 10;
  return {
    id,
    label: CLAUDE_WINDOWS[id] ?? id,
    usedPercent: used,
    resetsAt: resetTime(w.resetsAt),
    windowMinutes: CLAUDE_MINUTES[id] ?? (id.startsWith("seven_day") ? 10_080 : null),
    status: statusOf(used, w.status),
  };
}

/**
 * The `rate_limit_info` of a Claude Code `rate_limit_event`, merged into the windows an earlier
 * event reported: an event may name only the window that limits now.
 */
export function parseClaudeRateLimit(
  info: unknown,
  previous: ProviderLimits | null,
  observedAt: Date = new Date(),
): ProviderLimits | null {
  const root = record(info);
  if (!root) return null;
  const windows = new Map<string, LimitWindow>();
  for (const w of previous?.windows ?? []) windows.set(w.id, w);
  const unified = record(root.unifiedWindows);
  let found = false;
  for (const [id, raw] of Object.entries(unified ?? {})) {
    const w = record(raw);
    if (!w) continue;
    windows.set(id, claudeWindow(id, w));
    found = true;
  }
  const type = typeof root.rateLimitType === "string" ? root.rateLimitType : null;
  if (type && type !== "overage" && (!found || !windows.has(type)) && root.utilization != null) {
    windows.set(type, claudeWindow(type, root));
    found = true;
  }
  if (!found && !previous) return null;
  const overage = root.isUsingOverage === true || root.overageInUse === true;
  const order = Object.keys(CLAUDE_WINDOWS);
  const list = [...windows.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  if (root.status === "rejected" && type) {
    const limited = list.find((w) => w.id === type);
    if (limited) limited.status = "limited";
  }
  return {
    provider: "claude-code",
    name: "Claude Code",
    state: list.length ? "ok" : "no-data",
    source: "last-seen",
    observedAt: observedAt.toISOString(),
    plan: null,
    windows: list,
    credits: null,
    message: overage
      ? "Reported by Claude Code during BAKED's last turn; extra usage is paying for the overflow."
      : "Reported by Claude Code during BAKED's last turn on it.",
  };
}

/** Records a `rate_limit_event` from a Claude Code turn. */
export function recordClaudeRateLimit(info: unknown, file: string = limitsStoreFile()): void {
  const limits = parseClaudeRateLimit(info, loadLimits("claude-code", file));
  if (limits) saveLimits(limits, file);
}

// ── GitHub Copilot ───────────────────────────────────────────────────────────

const COPILOT_QUOTAS: Record<string, string> = {
  premium_interactions: "Premium requests",
  chat: "Chat",
  completions: "Code completions",
};

/** The answer of `GET copilot_internal/user`. */
export function parseCopilotUser(
  body: unknown,
  observedAt: Date = new Date(),
): ProviderLimits | null {
  const root = record(body);
  if (!root) return null;
  const snapshots = record(root.quota_snapshots);
  const resetsAt = resetTime(root.quota_reset_date_utc ?? root.quota_reset_date);
  const windows: LimitWindow[] = [];
  for (const [id, label] of Object.entries(COPILOT_QUOTAS)) {
    const q = record(snapshots?.[id]);
    if (!q) continue;
    const unlimited = q.unlimited === true;
    const left = num(q.percent_remaining);
    const used = unlimited ? 0 : left === null ? null : Math.round((100 - left) * 10) / 10;
    windows.push({
      id,
      label,
      usedPercent: used,
      resetsAt: unlimited ? null : resetsAt,
      windowMinutes: null,
      status: unlimited ? "ok" : statusOf(used),
      remaining: num(q.remaining),
      entitlement: num(q.entitlement),
      unlimited,
      ...(q.overage_permitted === true && !unlimited
        ? { detail: "Paid overage allowed past the limit" }
        : {}),
    });
  }
  const plan =
    typeof root.copilot_plan === "string"
      ? root.copilot_plan
      : typeof root.access_type_sku === "string"
        ? root.access_type_sku
        : null;
  return {
    provider: "copilot",
    name: "GitHub Copilot",
    state: windows.length ? "ok" : "no-data",
    source: "live",
    observedAt: observedAt.toISOString(),
    plan,
    windows,
    credits: null,
    message: windows.length
      ? "Read from GitHub just now."
      : "GitHub reported no quotas for this Copilot plan.",
  };
}

/** `in 3 h 12 min`, `in 2 d 4 h`, `now`: time left until a reset. */
export function resetsIn(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now.getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "now";
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `in ${String(min)} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `in ${String(h)} h ${String(min % 60)} min`;
  return `in ${String(Math.floor(h / 24))} d ${String(h % 24)} h`;
}
