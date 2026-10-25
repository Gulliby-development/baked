/**
 * Cached auto-format for post-edit formatting.
 * Avoids re-detecting the project profile on every edit.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { IS_WIN } from "../platform/index.js";
import { realPath } from "../projects/paths.js";
import { runBoundedShell } from "./bounded-process.js";
import { BUN_FMT } from "./bun-fmt.js";

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
 * The Rust edition of the crate a file belongs to: `package.edition` of the nearest Cargo.toml,
 * or `workspace.package.edition` of the workspace above it for `edition.workspace = true`; null
 * when no Cargo.toml names one. Bare rustfmt parses as Rust 2015 unless told otherwise (`cargo
 * fmt` passes the edition), so an `async fn` failed to parse and no file of a 2018+ crate was
 * formatted after an edit (#1681).
 */
export function cargoEdition(filePath: string): string | null {
  let inherited = false;
  for (let dir = dirname(realPath(filePath)); ; ) {
    const manifest = cargoManifest(join(dir, "Cargo.toml"));
    if (manifest) {
      const edition = manifest.package?.edition;
      if (!inherited && typeof edition === "string") return edition;
      if (!inherited && typeof edition === "object" && edition?.workspace === true)
        inherited = true;
      const shared = manifest.workspace?.package?.edition;
      if (inherited && typeof shared === "string") return shared;
      if (!inherited && manifest.package) return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface CargoManifest {
  package?: { edition?: string | { workspace?: boolean } };
  workspace?: { package?: { edition?: string } };
}

function cargoManifest(path: string): CargoManifest | null {
  try {
    return existsSync(path) ? (Bun.TOML.parse(readFileSync(path, "utf8")) as CargoManifest) : null;
  } catch {
    return null;
  }
}

/**
 * rustfmt for one file: the crate's edition, the project's rustfmt configuration, and
 * `skip_children` so formatting `lib.rs` does not rewrite every module it declares (#1681).
 */
export function rustfmtCommand(filePath: string): string {
  let config = "";
  for (let dir = dirname(realPath(filePath)); ; ) {
    const found = [".rustfmt.toml", "rustfmt.toml"].map((name) => join(dir, name)).find(existsSync);
    if (found) {
      config = ` --config-path ${shellQuote(found)}`;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const edition = cargoEdition(filePath);
  return `rustfmt${edition ? ` --edition ${edition}` : ""}${config} --config skip_children=true`;
}

/** The command that formats only `filePath` with a profile's single-file formatter. */
export function singleFileFormat(command: string, filePath: string): string {
  const formatter = command === "rustfmt" ? rustfmtCommand(filePath) : command;
  return `${formatter} ${shellQuote(realPath(filePath))}`;
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
  // `bun fmt` prints the formatted standard input for the file's language and configuration.
  if (command === BUN_FMT) return `${command} --stdin-filepath ${file}`;
  if (command === "gofmt -w") return "gofmt";
  if (command === "rustfmt")
    return rustfmtCommand(filePath).replace(/^rustfmt/, "rustfmt --emit stdout");
  // dprint reads the file text from stdin and takes the path for its configuration and plugin.
  if (/^(?:bunx |npx )?dprint fmt$/.test(command)) return `${command} --stdin ${file}`;
  if (command === "deno fmt") return `deno fmt --ext ${extname(filePath).slice(1) || "ts"} -`;
  // StyLua reads `stylua.toml` and its ignore file for the path it is given (#1495).
  if (command === "stylua") return `stylua --stdin-filepath ${file} -`;
  // shfmt reads standard input and takes the path for `.editorconfig` (#1497).
  if (command === "shfmt -w") return `shfmt --filename ${file}`;
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
  const command = singleFileFormat(cmd, filePath);
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
