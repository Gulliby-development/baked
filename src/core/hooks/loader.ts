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
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HookEventName, HookRule, HooksConfig } from "./types.js";

let homeDirOverride: string | undefined;

/**
 * Replace the home directory used for user-level hook sources, or restore the
 * real one with `undefined`. Tests use it to stay independent of the machine's
 * own `~/.claude` and `~/.baked` hooks: `os.homedir()` ignores runtime changes
 * to HOME/USERPROFILE, so redirecting the environment is not enough.
 */
export function setHooksHomeDir(dir: string | undefined): void {
  homeDirOverride = dir;
  invalidateHooksCache();
}

function getHookPaths(cwd: string): string[] {
  const home = homeDirOverride ?? homedir();
  const paths = [
    join(home, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
    join(home, ".baked", "config.json"),
    join(cwd, ".baked", "config.json"),
  ];
  // When cwd is the home directory, the user-level and project-level paths
  // name the same file; read it once so its hooks do not run twice.
  const seen = new Set<string>();
  return paths.filter((path) => {
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
  const paths = getHookPaths(cwd);
  const merged: Record<string, HookRule[]> = {};

  for (const path of paths) {
    const settings = readSettingsFile(path);
    if (!settings) continue;

    // disableAllHooks in any config file kills all hooks globally
    if (settings.disableAllHooks === true) return {};

    const hooks = settings.hooks;
    if (!hooks || typeof hooks !== "object") continue;

    for (const [event, rules] of Object.entries(hooks)) {
      if (!Array.isArray(rules)) continue;
      if (!merged[event]) merged[event] = [];
      for (const rule of rules) {
        if (rule && typeof rule === "object" && Array.isArray(rule.hooks)) {
          merged[event].push(rule);
        }
      }
    }
  }

  return merged as HooksConfig;
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
  const entry = _cache.get(effectiveCwd);
  if (entry && Date.now() < entry.expiresAt) return entry.hooks;

  const hooks = loadHooks(effectiveCwd);
  _cache.set(effectiveCwd, { hooks, expiresAt: Date.now() + CACHE_TTL_MS });
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
