import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { configDir } from "./platform/index.js";

export type TelemetrySurface = "tui" | "headless";

// Events are recorded locally. Nothing leaves the machine unless
// BAKED_TELEMETRY_URL or config `telemetryUrl` names a receiver (see telemetry-worker/).
const LOG_DIR = "telemetry";
const LOG_FILE = "events.jsonl";
const MAX_LOG_BYTES = 1024 * 1024;

// Stable, install-scoped random id. Identifies an INSTALL, not a person —
// no PII, no machine fingerprint. Stable so distinct-id counts give exact
// DAU / MAU / unique-install / retention metrics.
const ID_FILE = "anon-id.json";

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/** Returns true when the user has opted out by any mechanism. */
export function telemetryDisabled(configEnabled?: boolean): boolean {
  if (truthy(process.env.DO_NOT_TRACK)) return true;
  if (process.env.BAKED_TELEMETRY !== undefined) {
    // Explicit env wins over config: "0"/"false" disables.
    if (!truthy(process.env.BAKED_TELEMETRY)) return true;
  }
  if (configEnabled === false) return true;
  return false;
}

/** Path of the local event log: one JSON object per line. */
export function telemetryLogPath(): string {
  return join(configDir(), LOG_DIR, LOG_FILE);
}

function appendLocal(event: Record<string, string>): void {
  const file = telemetryLogPath();
  mkdirSync(join(configDir(), LOG_DIR), { recursive: true, mode: 0o700 });
  // Keep one previous file so the log stays bounded.
  if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
  appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, {
    mode: 0o600,
  });
}

/**
 * Read or lazily create the stable anonymous install id — a random UUID
 * persisted at ~/.baked/anon-id.json. Stable across runs so distinct-id
 * counts measure unique installs / DAU / MAU exactly. Returns a fresh
 * ephemeral id (never persisted) if the dir is unwritable.
 */
function anonId(): string {
  try {
    const dir = configDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, ID_FILE);
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf-8")) as { id?: string };
      if (data.id) return data.id;
    }
    const id = randomUUID();
    writeFileSync(file, JSON.stringify({ id, ts: Date.now() }), { mode: 0o600 });
    return id;
  } catch {
    return randomUUID();
  }
}

/**
 * One-time, non-blocking notice telling the user telemetry is on and how to
 * disable it. Prints to stderr once (gated on config.telemetryNoticeShown),
 * then persists the flag. No-op when opted out or already shown.
 */
export function maybeShowTelemetryNotice(
  config: { telemetry?: boolean; telemetryNoticeShown?: boolean },
  markShown: () => void,
): void {
  if (telemetryDisabled(config.telemetry)) return;
  if (config.telemetryNoticeShown) return;
  try {
    process.stderr.write(
      `\x1b[2mbaked records anonymous usage stats locally in ${telemetryLogPath()} (version, OS, surface — no prompts, paths, or keys). Nothing is sent.\n` +
        "View them with `baked telemetry`. Opt out: `baked telemetry off`, /telemetry off, or DO_NOT_TRACK=1.\x1b[0m\n",
    );
    markShown();
  } catch {}
}

function normArch(): string {
  const a = process.arch;
  if (a === "arm64") return "arm64";
  if (a === "x64") return "x64";
  return "other";
}

export interface BeaconFields {
  surface: TelemetrySurface;
  version: string;
  /** Install method (npm/brew/binary/…). Optional. */
  install?: string;
  /** Model FAMILY only (claude/openai/…). Never the model id or key. */
  family?: string;

  provider?: string;
  /** Public base model name (claude-sonnet-4-5/…) or "other". Never custom names. */
  model?: string;
  /** Agent mode (default/architect/plan/auto). Optional. */
  mode?: string;
  /** Coarse terminal bucket (kitty/ghostty/iterm/vscode/other). Optional. */
  terminal?: string;
  /** JS runtime + major version (bun-1/node-22). Optional. */
  runtime?: string;
  /** Whether the repo-map scan was skipped this session ("on"|"skipped"). Optional. */
  repomap?: string;
  event?: "session_start" | "session_end";
}

/** Coarse, non-identifying terminal bucket from env. No PII, no fingerprint. */
export function detectTerminalBucket(): string {
  const term = process.env.TERM_PROGRAM?.toLowerCase() ?? "";
  if (process.env.KITTY_WINDOW_ID || term === "kitty") return "kitty";
  if (term === "ghostty") return "ghostty";
  if (process.env.ITERM_SESSION_ID || term === "iterm.app" || term === "iterm2") return "iterm";
  if (term === "vscode") return "vscode";
  if (process.env.WEZTERM_PANE !== undefined || term === "wezterm") return "wezterm";
  if (term === "warp") return "warp";
  if (process.env.TMUX) return "tmux";
  return "other";
}

/** JS runtime + MAJOR version only (bun-1 / node-22). No build/patch detail. */
export function detectRuntime(): string {
  const bun = process.versions.bun;
  if (bun) return `bun-${bun.split(".")[0]}`;
  const node = process.versions.node;
  if (node) return `node-${node.split(".")[0]}`;
  return "other";
}

/**
 * Record a usage event in the local log. When a receiver is configured
 * (BAKED_TELEMETRY_URL or config `telemetryUrl`) the same fields also go to it in the background, abandoned after
 * 1.5s. Any failure is swallowed.
 */
export function sendBeacon(
  fields: BeaconFields,
  configEnabled?: boolean,
  configUrl?: string,
): void {
  if (telemetryDisabled(configEnabled)) return;

  try {
    const params = new URLSearchParams({
      e: fields.event ?? "session_start",
      sf: fields.surface,
      v: fields.version.slice(0, 24),
      os: process.platform,
      ar: normArch(),
      id: anonId(),
    });
    if (fields.install) params.set("im", fields.install.slice(0, 16));
    if (fields.family) params.set("mf", fields.family.slice(0, 20));
    if (fields.provider) params.set("pv", fields.provider.slice(0, 24));
    if (fields.model) params.set("md", fields.model.slice(0, 40));
    if (fields.mode) params.set("mo", fields.mode.slice(0, 16));
    if (fields.terminal) params.set("tm", fields.terminal.slice(0, 16));
    if (fields.runtime) params.set("rt", fields.runtime.slice(0, 16));
    if (fields.repomap) params.set("rm", fields.repomap.slice(0, 8));

    try {
      appendLocal(Object.fromEntries(params));
    } catch {}

    const endpoint = process.env.BAKED_TELEMETRY_URL || configUrl;
    if (!endpoint) return;
    // Don't await — fire and forget. Abort quickly so it never lingers.
    // The "baked/<version>" UA is the marker the beacon's gate checks to
    // drop drive-by/browser noise — not a secret, just a cheap filter.
    void fetch(`${endpoint}?${params.toString()}`, {
      method: "GET",
      headers: { "user-agent": `baked/${fields.version.slice(0, 24)}` },
      signal: AbortSignal.timeout(1500),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Never let telemetry affect the app.
  }
}

export interface TelemetrySummary {
  path: string;
  events: number;
  /** Events per day (YYYY-MM-DD), oldest first. */
  days: Array<{ day: string; events: number }>;
  /** Event counts by key: surface, version, provider, model. */
  by: Record<"sf" | "v" | "pv" | "md", Record<string, number>>;
}

/** Summarise the local event log, including the rotated previous file. */
export function summarizeTelemetry(): TelemetrySummary {
  const path = telemetryLogPath();
  const summary: TelemetrySummary = {
    path,
    events: 0,
    days: [],
    by: { sf: {}, v: {}, pv: {}, md: {} },
  };
  const days = new Map<string, number>();
  for (const file of [`${path}.1`, path]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let event: Record<string, string>;
      try {
        event = JSON.parse(line) as Record<string, string>;
      } catch {
        continue;
      }
      summary.events++;
      const day = String(event.ts ?? "").slice(0, 10);
      if (day) days.set(day, (days.get(day) ?? 0) + 1);
      for (const key of ["sf", "v", "pv", "md"] as const) {
        const value = event[key];
        if (value) summary.by[key][value] = (summary.by[key][value] ?? 0) + 1;
      }
    }
  }
  summary.days = [...days]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, events]) => ({ day, events }));
  return summary;
}

/** `baked telemetry [--json]`: print the local usage summary. */
/** Whether events are recorded, and why not, for the config value `telemetry`. */
export function telemetryStatus(configEnabled?: boolean): string {
  if (telemetryDisabled()) return "Recording is off: DO_NOT_TRACK or BAKED_TELEMETRY disables it.";
  if (configEnabled === false) return "Recording is off (config telemetry: false).";
  return "Recording is on.";
}

/** `baked telemetry [on|off] [--json]`: switches recording in the global config, or summarizes the log. */
export async function runTelemetryCli(args: string[]): Promise<number> {
  const { loadConfig, saveGlobalConfig } = await import("../config/index.js");
  const word = args.find((a) => !a.startsWith("-"));
  if (word !== undefined) {
    if (word !== "on" && word !== "off") {
      process.stderr.write("Usage: baked telemetry [on|off] [--json]\n");
      return 2;
    }
    saveGlobalConfig({ telemetry: word === "on" });
    process.stdout.write(`Telemetry ${word} (global config). ${telemetryStatus(word === "on")}\n`);
    return 0;
  }
  const summary = summarizeTelemetry();
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }
  const lines = [
    `Local usage log: ${summary.path}`,
    `Events: ${String(summary.events)}`,
    telemetryStatus(loadConfig().telemetry),
  ];
  const top = (counts: Record<string, number>) =>
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, n]) => `${name} (${String(n)})`)
      .join(", ") || "-";
  if (summary.events > 0) {
    lines.push(
      `Last 7 days: ${summary.days
        .slice(-7)
        .map((d) => `${d.day} ${String(d.events)}`)
        .join(", ")}`,
      `Surfaces: ${top(summary.by.sf)}`,
      `Versions: ${top(summary.by.v)}`,
      `Providers: ${top(summary.by.pv)}`,
      `Models: ${top(summary.by.md)}`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
