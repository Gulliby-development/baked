import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Custom slash commands: Markdown prompt templates in `~/.baked/commands/`
 * and `<cwd>/.baked/commands/`. Kept free of terminal UI imports so every
 * front end (TUI, headless, desktop) expands them the same way.
 */

export type CustomCommandScope = "global" | "project";

export interface CustomCommand {
  /** Slash name, e.g. `/fix-ci` or `/frontend:component`. */
  name: string;
  description: string;
  argumentHint?: string;
  /** Template body without frontmatter. */
  body: string;
  path: string;
  scope: CustomCommandScope;
}

export interface CustomCommandOptions {
  /** Home directory for the global scope; defaults to `os.homedir()`. */
  home?: string;
}

const MAX_FILE_BYTES = 64 * 1024;
const MAX_DEPTH = 4;
const DESCRIPTION_MAX = 80;
const SEGMENT_RE = /^[a-z0-9_][a-z0-9_.-]*$/;

export function commandDirs(
  cwd: string,
  options: CustomCommandOptions = {},
): Array<{ path: string; scope: CustomCommandScope }> {
  return [
    { path: join(options.home ?? homedir(), ".baked", "commands"), scope: "global" },
    { path: join(cwd, ".baked", "commands"), scope: "project" },
  ];
}

/** Read all custom commands from disk. Project commands replace global ones with the same name. */
export function listCustomCommands(
  cwd: string,
  options: CustomCommandOptions = {},
): CustomCommand[] {
  const byName = new Map<string, CustomCommand>();
  for (const dir of commandDirs(cwd, options)) {
    scanDir(dir.path, [], dir.scope, byName, 0);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function scanDir(
  dir: string,
  prefix: string[],
  scope: CustomCommandScope,
  out: Map<string, CustomCommand>,
  depth: number,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const segment = entry.toLowerCase();
      if (depth < MAX_DEPTH && SEGMENT_RE.test(segment)) {
        scanDir(full, [...prefix, segment], scope, out, depth + 1);
      }
      continue;
    }
    if (!st.isFile() || !entry.toLowerCase().endsWith(".md") || st.size > MAX_FILE_BYTES) continue;
    const segment = entry.slice(0, -3).toLowerCase();
    if (!SEGMENT_RE.test(segment)) continue;
    let text: string;
    try {
      text = readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    const name = `/${[...prefix, segment].join(":")}`;
    out.set(name, parseCommandFile(name, text, full, scope));
  }
}

export function parseCommandFile(
  name: string,
  text: string,
  path: string,
  scope: CustomCommandScope,
): CustomCommand {
  const { meta, body } = splitFrontmatter(text.replace(/^﻿/, ""));
  const description = meta.description || firstLine(body) || "Custom command";
  return {
    name,
    description: truncate(description, DESCRIPTION_MAX),
    argumentHint: meta["argument-hint"] || undefined,
    body,
    path,
    scope,
  };
}

function splitFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv?.[1]) continue;
    meta[kv[1].toLowerCase()] = unquote((kv[2] ?? "").trim());
  }
  return { meta, body: text.slice(match[0].length).trim() };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q)) return value.slice(1, -1);
  }
  return value;
}

function firstLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t) return t;
  }
  return "";
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Split arguments on whitespace; double-quoted text is one argument. */
export function splitArguments(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(args); m; m = re.exec(args)) {
    out.push(m[1] ?? m[2] ?? "");
  }
  return out;
}

/** Substitute `$ARGUMENTS` and `$1`–`$9`; append arguments when the body has no placeholder. */
export function expandCustomCommand(command: CustomCommand, args: string): string {
  const trimmed = args.trim();
  const positional = splitArguments(trimmed);
  const hasPlaceholder = /\$ARGUMENTS|\$[1-9]/.test(command.body);
  // One pass, so argument text that contains `$1` is not substituted again.
  const expanded = command.body.replace(/\$ARGUMENTS|\$([1-9])/g, (_m, d: string | undefined) =>
    d ? (positional[Number(d) - 1] ?? "") : trimmed,
  );
  if (!hasPlaceholder && trimmed) return `${expanded}\n\nARGUMENTS: ${trimmed}`;
  return expanded;
}

/** Split `/name rest` into the lowercased name and the raw argument text. */
export function parseSlashInput(input: string): { name: string; args: string } | null {
  const m = /^\s*(\/\S+)(?:\s+([\s\S]*))?$/.exec(input);
  if (!m?.[1]) return null;
  return { name: m[1].toLowerCase(), args: m[2] ?? "" };
}

export function findCustomCommand(
  name: string,
  cwd: string,
  options: CustomCommandOptions = {},
): CustomCommand | null {
  const needle = name.toLowerCase();
  return listCustomCommands(cwd, options).find((c) => c.name === needle) ?? null;
}

/**
 * Expand `input` when it invokes a runnable custom command, reading the file
 * fresh. Returns null for plain prompts, unknown names and reserved names.
 */
export function expandCustomCommandInput(
  input: string,
  cwd: string,
  isReserved?: (name: string) => boolean,
  options: CustomCommandOptions = {},
): { command: CustomCommand; prompt: string } | null {
  const parsed = parseSlashInput(input);
  if (!parsed || isReserved?.(parsed.name)) return null;
  const command = findCustomCommand(parsed.name, cwd, options);
  if (!command) return null;
  return { command, prompt: expandCustomCommand(command, parsed.args) };
}

const CACHE_TTL_MS = 2000;
let cache: { key: string; at: number; commands: CustomCommand[] } | null = null;

/** `listCustomCommands` with a short cache for per-keystroke callers (palette, autocomplete). */
export function getCachedCustomCommands(
  cwd: string,
  options: CustomCommandOptions = {},
): CustomCommand[] {
  const key = `${cwd}\0${options.home ?? ""}`;
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < CACHE_TTL_MS) return cache.commands;
  const commands = listCustomCommands(cwd, options);
  cache = { key, at: now, commands };
  return commands;
}
