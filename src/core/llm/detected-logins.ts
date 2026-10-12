import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { localAppData, xdgConfigHome } from "../platform/index.js";

/** A credential another tool already holds, read without changing that tool's files. */
export interface DetectedLogin {
  token: string;
  /** Where it came from, for display: "Copilot IDE login", "GITHUB_TOKEN", "gh CLI". */
  source: string;
}

/** Folder the Copilot IDE plugins (VS Code, JetBrains, Neovim) keep their GitHub login in. */
export function copilotConfigDir(): string {
  return join(localAppData() ?? xdgConfigHome(), "github-copilot");
}

/**
 * The GitHub OAuth token of a Copilot IDE login: `apps.json` (keys `github.com:<app id>`), then
 * the older `hosts.json` (key `github.com`). Read on every call, so signing out of the IDE makes
 * the provider unavailable at the next check.
 */
export function copilotIdeLogin(): DetectedLogin | null {
  for (const file of ["apps.json", "hosts.json"]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(copilotConfigDir(), file), "utf-8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    for (const [host, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (host !== "github.com" && !host.startsWith("github.com:")) continue;
      const token = (entry as { oauth_token?: unknown } | null)?.oauth_token;
      if (typeof token === "string" && token) return { token, source: "Copilot IDE login" };
    }
  }
  return null;
}

const GH_CACHE_MS = 30_000;
let ghCache: { at: number; login: DetectedLogin | null } | null = null;

/**
 * A GitHub token for GitHub Models: `GITHUB_TOKEN` or `GH_TOKEN`, then the GitHub CLI's
 * `gh auth token`. The CLI answer is cached briefly because model creation reads it synchronously.
 */
export function githubCliLogin(): DetectedLogin | null {
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    const value = process.env[name]?.trim();
    if (value) return { token: value, source: name };
  }
  if (ghCache && Date.now() - ghCache.at < GH_CACHE_MS) return ghCache.login;
  let login: DetectedLogin | null = null;
  try {
    const result = spawnSync("gh", ["auth", "token", "--hostname", "github.com"], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const token = result.status === 0 ? result.stdout.trim() : "";
    if (token) login = { token, source: "gh CLI" };
  } catch {}
  ghCache = { at: Date.now(), login };
  return login;
}

/** Forgets the cached `gh auth token` answer (tests, and after the user signs in or out). */
export function resetDetectedLoginCache(): void {
  ghCache = null;
}
