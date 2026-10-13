/**
 * Hook loader — reads hooks config from Claude Code and baked config files.
 *
 * Load order (all sources are **merged**, not overridden — all matching hooks fire):
 * 1. `~/.claude/settings.json`          (user-level Claude Code)
 * 2. `.claude/settings.json`            (project-level Claude Code)
 * 3. `.claude/settings.local.json`      (project-level local Claude Code)
 * 4. `~/.baked/config.json`         (user-level baked)
 * 5. `.baked/config.json`           (project-level baked)
 *
 * Caching: per-cwd with a 5s TTL. No file watchers — hooks config rarely changes
 * mid-session, and the TTL keeps it fresh enough without polling overhead.
 * Multi-tab safe: each cwd gets its own cache entry.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { userHome } from "../platform/index.js";
import type { HookEventName, HookRule, HooksConfig } from "./types.js";

/** Who a hooks file belongs to: the user (home), the project, or the project's local overrides. */
export type HookSourceScope = "user" | "project" | "local";

/** Which tool's config format a hooks file belongs to; BAKED writes only its own files. */
export type HookSourceOrigin = "claude" | "baked";

/** A file hooks are read from. */
export interface HookSourcePath {
  path: string;
  scope: HookSourceScope;
  origin: HookSourceOrigin;
}

/** The BAKED config file that hooks of `scope` are saved to. */
export function bakedHooksPath(cwd: string, scope: "project" | "user"): string {
  return scope === "user"
    ? join(userHome(), ".baked", "config.json")
    : join(cwd, ".baked", "config.json");
}

/** The files hooks are read from for `cwd`, in load order. */
export function getHookSourcePaths(cwd: string): HookSourcePath[] {
  const home = userHome();
  const paths: HookSourcePath[] = [
    { path: join(home, ".claude", "settings.json"), scope: "user", origin: "claude" },
    { path: join(cwd, ".claude", "settings.json"), scope: "project", origin: "claude" },
    { path: join(cwd, ".claude", "settings.local.json"), scope: "local", origin: "claude" },
    { path: bakedHooksPath(cwd, "user"), scope: "user", origin: "baked" },
    { path: bakedHooksPath(cwd, "project"), scope: "project", origin: "baked" },
  ];
  // In the home directory the user and project paths name the same file; read it once so
  // its hooks do not run twice.
  const seen = new Set<string>();
  return paths.filter(({ path }) => {
    const key = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface SettingsFile {
  hooks?: HooksConfig;
  disableAllHooks?: boolean;
}

function readSettingsFile(filePath: string): SettingsFile | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as SettingsFile;
    return null;
  } catch {
    return null;
  }
}

/**
 * Load and merge hooks from all config sources.
 * Returns a merged HooksConfig where each event has all rules from all sources.
 * Returns empty config if any source sets `disableAllHooks: true`.
 */
export function loadHooks(cwd: string): HooksConfig {
  const merged: Record<string, HookRule[]> = {};

  for (const source of readHookSources(cwd)) {
    // disableAllHooks in any config file kills all hooks globally
    if (source.disablesAll) return {};
    for (const [event, rules] of Object.entries(source.hooks)) {
      if (!merged[event]) merged[event] = [];
      merged[event].push(...rules);
    }
  }

  return merged as HooksConfig;
}

/** The hooks of one source file; `disablesAll` when it sets `disableAllHooks: true`. */
export interface HookSource extends HookSourcePath {
  exists: boolean;
  disablesAll: boolean;
  /** The well-formed rules per event name, as the file lists them. */
  hooks: Record<string, HookRule[]>;
}

/** Reads every hooks file for `cwd`, in load order. */
export function readHookSources(cwd: string): HookSource[] {
  return getHookSourcePaths(cwd).map((source) => {
    const settings = readSettingsFile(source.path);
    const hooks: Record<string, HookRule[]> = {};
    const raw = settings?.hooks;
    if (raw && typeof raw === "object") {
      for (const [event, rules] of Object.entries(raw)) {
        if (!Array.isArray(rules)) continue;
        hooks[event] = rules.filter(
          (rule): rule is HookRule =>
            Boolean(rule) && typeof rule === "object" && Array.isArray(rule.hooks),
        );
      }
    }
    return {
      ...source,
      exists: settings !== null,
      disablesAll: settings?.disableAllHooks === true,
      hooks,
    };
  });
}

// ── Per-cwd cache with TTL ───────────────────────────────────────────

interface CacheEntry {
  hooks: HooksConfig;
  expiresAt: number;
}

const CACHE_TTL_MS = 5_000;
const _cache = new Map<string, CacheEntry>();

/** Get hooks config (cached per-cwd with 5s TTL). Multi-tab safe. */
export function getHooks(cwd?: string): HooksConfig {
  const effectiveCwd = cwd ?? process.cwd();
  const key = `${userHome()}\0${effectiveCwd}`;
  const entry = _cache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.hooks;

  const hooks = loadHooks(effectiveCwd);
  _cache.set(key, { hooks, expiresAt: Date.now() + CACHE_TTL_MS });
  return hooks;
}

/** Invalidate the hooks cache — forces reload on next getHooks() call. */
export function invalidateHooksCache(): void {
  _cache.clear();
}

/** Check if any hooks are configured for a given event. */
export function hasHooksForEvent(event: HookEventName, cwd?: string): boolean {
  const hooks = getHooks(cwd);
  const rules = hooks[event];
  return Array.isArray(rules) && rules.length > 0;
}
