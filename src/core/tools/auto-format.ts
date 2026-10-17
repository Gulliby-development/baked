/**
 * Cached auto-format for post-edit formatting.
 * Avoids re-detecting the project profile on every edit.
 */

import { IS_WIN } from "../platform/index.js";
import { realPath } from "../projects/paths.js";
import { runBoundedShell } from "./bounded-process.js";

// Format command per checkout root; `null` from setFormatCache disables formatting everywhere.
const formatCommands = new Map<string, string | null>();
let formatOverride: string | null | undefined;

/**
 * The deadline of a format command, after an edit and in `formatFile` alike. A formatter's first
 * start on Windows (`bunx` resolving it, the antivirus scanning the binary) took over 10 s on CI
 * runners; later runs take well under a second (#1177, #1429).
 */
export const FORMAT_TIMEOUT_MS = 30_000;

function shellQuote(s: string): string {
  // POSIX: single-quote wrap; Windows cmd.exe: double-quote wrap (no special chars allowed in path-only args).
  if (IS_WIN) return `"${s.replace(/"/g, '\\"')}"`;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function getFormatCommand(cwd: string): Promise<string | null> {
  if (formatOverride !== undefined) return formatOverride;
  const cached = formatCommands.get(cwd);
  if (cached !== undefined) return cached;
  const { detectProfile } = await import("./project.js");
  const profile = await detectProfile(cwd);
  formatCommands.set(cwd, profile.formatFile);
  return profile.formatFile;
}

/** Override cached format command (e.g. set to null in tests to skip formatting). */
export function setFormatCache(cmd: string | null): void {
  formatOverride = cmd;
}

/** Drops the override and the detected commands, so the next edit detects the formatter again. */
export function resetFormatCache(): void {
  formatOverride = undefined;
  formatCommands.clear();
}

/**
 * Auto-format a file after edit. Returns true if formatted, false if skipped/failed.
 * Uses cached format command to avoid re-detecting project profile on every edit.
 */
export async function autoFormatAfterEdit(filePath: string, cwd?: string): Promise<boolean> {
  const { formatRoot } = await import("./project.js");
  const effectiveCwd = cwd ?? formatRoot(filePath) ?? process.cwd();
  const cmd = await getFormatCommand(effectiveCwd);
  if (!cmd) return false;

  // A real path, as in `formatFile`: the formatter sees its working directory as a real path.
  const command = `${cmd} ${shellQuote(realPath(filePath))}`;
  try {
    // A deadline that kills the whole tree: the formatter's own children must not hold the edit.
    const result = await runBoundedShell(command, {
      cwd: effectiveCwd,
      timeoutMs: FORMAT_TIMEOUT_MS,
    });
    return !result.timedOut && result.exitCode === 0;
  } catch {
    return false;
  }
}
