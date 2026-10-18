/**
 * Cached auto-format for post-edit formatting.
 * Avoids re-detecting the project profile on every edit.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** Read the pre-image through the formatter without writing it over the edited file. */
export function formatProbeCommand(command: string, filePath: string): string | null {
  const file = shellQuote(realPath(filePath));
  if (/^(?:(?:uv|poetry|pipenv) run )?ruff format$/.test(command))
    return `${command} --stdin-filename ${file} -`;
  if (/^(?:(?:uv|poetry|pipenv) run )?black$/.test(command))
    return `${command} --quiet --stdin-filename ${file} -`;
  if (/^(?:bunx|npx) biome format --write$/.test(command))
    return `${command.replace(" --write", "")} --stdin-file-path ${file}`;
  if (/^(?:bunx|npx) prettier --write$/.test(command))
    return `${command.replace(" --write", "")} --stdin-filepath ${file}`;
  if (command === "gofmt -w") return "gofmt";
  if (command === "rustfmt") {
    let dir = dirname(realPath(filePath));
    let config = "";
    for (;;) {
      const found = [".rustfmt.toml", "rustfmt.toml"]
        .map((name) => join(dir, name))
        .find(existsSync);
      if (found) {
        config = ` --config-path ${shellQuote(found)}`;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return `rustfmt --emit stdout${config} --config skip_children=true`;
  }
  // Unknown formatters cannot establish a clean baseline safely. Explicit format requests
  // and workflow check fixers still run them normally.
  return null;
}

/** null means a new file; undefined means the caller has no pre-image. */
export async function canAutoFormat(
  filePath: string,
  before: string | null | undefined,
  cwd?: string,
): Promise<boolean> {
  if (before === null) return true;
  if (before === undefined) return false;
  try {
    const { formatRoot } = await import("./project.js");
    const effectiveCwd = cwd ?? formatRoot(filePath) ?? process.cwd();
    const command = await getFormatCommand(effectiveCwd);
    const probe = command ? formatProbeCommand(command, filePath) : null;
    if (!probe) return false;
    const result = await runBoundedShell(probe, {
      cwd: effectiveCwd,
      timeoutMs: FORMAT_TIMEOUT_MS,
      stdin: before,
    });
    return !result.timedOut && result.exitCode === 0 && result.stdout === before;
  } catch {
    return false;
  }
}

/**
 * Auto-format a file after edit. Returns true if formatted, false if skipped/failed.
 * Uses cached format command to avoid re-detecting project profile on every edit.
 */
export async function autoFormatAfterEdit(
  filePath: string,
  cwd?: string,
  before?: string | null,
): Promise<boolean> {
  if (!(await canAutoFormat(filePath, before, cwd))) return false;
  const { formatRoot } = await import("./project.js");
  const effectiveCwd = cwd ?? formatRoot(filePath) ?? process.cwd();
  const cmd = await getFormatCommand(effectiveCwd);
  if (!cmd) return false;

  // A real path, as in `formatFile`: the formatter sees its working directory as a real path.
  const singleFile = cmd === "rustfmt" ? `${cmd} --config skip_children=true` : cmd;
  const command = `${singleFile} ${shellQuote(realPath(filePath))}`;
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
