/**
 * Cached auto-format for post-edit formatting.
 * Avoids re-detecting the project profile on every edit.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { IS_WIN } from "../platform/index.js";
import { realPath } from "../projects/paths.js";
import { runBoundedShell } from "./bounded-process.js";
import { BUN_FMT } from "./bun-fmt.js";
import { captureEndings, restoreEndings } from "./line-endings.js";

// Format command per checkout root; `null` from setFormatCache disables formatting everywhere.
const formatCommands = new Map<string, string | null>();
let formatOverride: string | null | undefined;

/**
 * The deadline of a format command, after an edit and in `formatFile` alike. A formatter's first
 * start on Windows (`bunx` resolving it, the antivirus scanning the binary) took over 10 s on CI
 * runners; later runs take well under a second (#1177, #1429).
 */
export const FORMAT_TIMEOUT_MS = 30_000;
let timeoutOverride: number | undefined;

/** The format deadline in force: `FORMAT_TIMEOUT_MS`, or the one a test set with `setFormatCache`. */
export function formatTimeoutMs(): number {
  return timeoutOverride ?? FORMAT_TIMEOUT_MS;
}

/**
 * A formatter that ran out of time on one file. A timed-out format left the file unformatted
 * without a word to the model, and the next edit waited the whole deadline again (#2242).
 */
export interface FormatTimeout {
  /** The file's real path. */
  path: string;
  /** The formatter's program, as the note names it (`rustfmt`, `prettier`). */
  formatter: string;
  timeoutMs: number;
  /** Timed-out runs on this file in this process: the post-edit probe and the write alike. */
  count: number;
}

/**
 * After this many timeouts on one file, the post-edit format skips the file for the rest of the
 * process: each attempt costs the whole deadline and the file's content keeps it hanging (#2242).
 */
export const FORMAT_TIMEOUT_SKIP_AFTER = 2;

const formatTimeouts = new Map<string, FormatTimeout>();

/** The program a format command runs, past `bunx`, `npx` and `uv run`-style launchers. */
function formatterName(command: string): string {
  const words = command.trim().split(/\s+/);
  let i = 0;
  if (/^(?:uv|poetry|pipenv)$/.test(words[0] ?? "") && words[1] === "run") i = 2;
  else if (/^(?:bunx|npx)$/.test(words[0] ?? "")) i = 1;
  return (words[i] ?? command).replace(/^.*[\\/]/, "");
}

/** Records a format of `filePath` that did not finish within `timeoutMs`; returns the record. */
export function recordFormatTimeout(
  filePath: string,
  command: string,
  timeoutMs: number,
): FormatTimeout {
  const path = realPath(filePath);
  const known = formatTimeouts.get(path);
  const record = {
    path,
    formatter: formatterName(command),
    timeoutMs,
    count: (known?.count ?? 0) + 1,
  };
  formatTimeouts.set(path, record);
  return record;
}

/**
 * The recorded format timeouts of a file, or undefined: the host fact a later check timeout reads
 * to name the file the formatter hangs on without running it on each file again (#2242).
 */
export function formatTimeoutOf(filePath: string): FormatTimeout | undefined {
  return formatTimeouts.get(realPath(filePath));
}

/**
 * The recorded format timeouts of files under `dir`, by their path relative to it with forward
 * slashes: the checks stage reads those of a run's worktrees (#2242).
 */
export function formatTimeoutsUnder(dir: string): Map<string, FormatTimeout> {
  const root = realPath(dir);
  const found = new Map<string, FormatTimeout>();
  for (const [path, record] of formatTimeouts) {
    const rel = relative(root, path);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel))
      found.set(rel.split(sep).join("/"), record);
  }
  return found;
}

/** A format that finished drops the file's timeouts: its content no longer hangs the formatter. */
function clearFormatTimeout(filePath: string): void {
  formatTimeouts.delete(realPath(filePath));
}

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

/**
 * Override cached format command (e.g. set to null in tests to skip formatting), and optionally
 * the format deadline.
 */
export function setFormatCache(cmd: string | null, timeoutMs?: number): void {
  formatOverride = cmd;
  timeoutOverride = timeoutMs;
}

/**
 * Drops the override, the detected commands and the recorded timeouts, so the next edit detects
 * the formatter again.
 */
export function resetFormatCache(): void {
  formatOverride = undefined;
  timeoutOverride = undefined;
  formatCommands.clear();
  formatTimeouts.clear();
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
  // clang-format reads standard input and finds `.clang-format` from the path it is given (#1490).
  if (command === "clang-format -i") return `clang-format --assume-filename=${file}`;
  // Unknown formatters cannot establish a clean baseline safely. Explicit format requests
  // and workflow check fixers still run them normally.
  return null;
}

/**
 * What the post-edit format did: `formatted`, `skipped` (no formatter, no pre-image, an unclean
 * pre-image, or a failed run), `timed-out` with the record of this file's timeouts, or
 * `skipped-after-timeouts` once the file reached `FORMAT_TIMEOUT_SKIP_AFTER` (#2242).
 */
export type AutoFormatOutcome =
  | { kind: "formatted" | "skipped" | "skipped-after-timeouts" }
  | { kind: "timed-out"; timeout: FormatTimeout };

/** null means a new file; undefined means the caller has no pre-image. */
export async function canAutoFormat(
  filePath: string,
  before: string | null | undefined,
  cwd?: string,
): Promise<boolean> {
  return (await probeAutoFormat(filePath, before, cwd)).kind === "formatted";
}

/** The pre-image probe of `canAutoFormat`, with a timeout told apart from an unclean pre-image. */
async function probeAutoFormat(
  filePath: string,
  before: string | null | undefined,
  cwd?: string,
): Promise<AutoFormatOutcome> {
  if (before === null) return { kind: "formatted" };
  if (before === undefined) return { kind: "skipped" };
  try {
    const { formatRoot } = await import("./project.js");
    const effectiveCwd = cwd ?? formatRoot(filePath) ?? process.cwd();
    const command = await getFormatCommand(effectiveCwd);
    const probe = command ? formatProbeCommand(command, filePath) : null;
    if (!command || !probe) return { kind: "skipped" };
    const timeoutMs = formatTimeoutMs();
    const result = await runBoundedShell(probe, { cwd: effectiveCwd, timeoutMs, stdin: before });
    if (result.timedOut)
      return { kind: "timed-out", timeout: recordFormatTimeout(filePath, command, timeoutMs) };
    return result.exitCode === 0 && result.stdout === before
      ? { kind: "formatted" }
      : { kind: "skipped" };
  } catch {
    return { kind: "skipped" };
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
  return (await autoFormatOutcome(filePath, cwd, before)).kind === "formatted";
}

/** `autoFormatAfterEdit` with a timeout and the skip after repeated timeouts told apart (#2242). */
export async function autoFormatOutcome(
  filePath: string,
  cwd?: string,
  before?: string | null,
): Promise<AutoFormatOutcome> {
  if ((formatTimeoutOf(filePath)?.count ?? 0) >= FORMAT_TIMEOUT_SKIP_AFTER)
    return { kind: "skipped-after-timeouts" };
  const probe = await probeAutoFormat(filePath, before, cwd);
  if (probe.kind !== "formatted") return probe;
  const { formatRoot } = await import("./project.js");
  const effectiveCwd = cwd ?? formatRoot(filePath) ?? process.cwd();
  const cmd = await getFormatCommand(effectiveCwd);
  if (!cmd) return { kind: "skipped" };

  // A real path, as in `formatFile`: the formatter sees its working directory as a real path.
  const command = singleFileFormat(cmd, filePath);
  try {
    // A deadline that kills the whole tree: the formatter's own children must not hold the edit.
    // A formatter that writes text mode on Windows turns a LF file into CRLF (#2214).
    const endings = captureEndings([filePath]);
    const timeoutMs = formatTimeoutMs();
    const result = await runBoundedShell(command, { cwd: effectiveCwd, timeoutMs }).finally(() =>
      restoreEndings(endings),
    );
    if (result.timedOut)
      return { kind: "timed-out", timeout: recordFormatTimeout(filePath, cmd, timeoutMs) };
    if (result.exitCode !== 0) return { kind: "skipped" };
    clearFormatTimeout(filePath);
    return { kind: "formatted" };
  } catch {
    return { kind: "skipped" };
  }
}

/**
 * What the edit result says about a post-edit format that timed out, or null for any other
 * outcome. The second timeout on a file also says the edit tools stop formatting it (#2242).
 */
export function formatTimeoutNote(outcome: AutoFormatOutcome, shownPath: string): string | null {
  if (outcome.kind !== "timed-out") return null;
  const { formatter, timeoutMs, count } = outcome.timeout;
  const seconds = Math.round(timeoutMs / 1000);
  const note = `⚠ ${formatter} did not finish within ${String(seconds)} s on ${shownPath}, so the file was not formatted; a deeply nested literal or expression is the usual cause, and the project's format check will hang on it too. Build the nested value in steps or move it into a data file.`;
  return count >= FORMAT_TIMEOUT_SKIP_AFTER
    ? `${note} It timed out ${String(count)} times, so edits of this file are no longer formatted for the rest of the session.`
    : note;
}
