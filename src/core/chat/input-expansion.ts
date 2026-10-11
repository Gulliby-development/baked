import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isBinaryFileSync } from "isbinaryfile";
import type { BakeMode, InputContextItem } from "../../types/index.js";
import { IGNORED_DIRS } from "../context/file-tree.js";
import { hasToolHooks, runHooks } from "../hooks/index.js";
import { builtinForbidden, isForbidden } from "../security/forbidden.js";
import { classifyPath } from "../security/outside-cwd.js";
import { emitCacheReset } from "../tools/file-events.js";
import { runGatedShell } from "../tools/index.js";
import type { IntelligenceClient } from "../workers/intelligence-client.js";

/**
 * `@path`, `@Symbol` and `!command` in a chat message. The parser and the expansion are shared by
 * the terminal UI, the headless CLI and the chat API, so each front end only renders the result.
 */

/** One `@` mention in a message. `lines` is the `#10-40` suffix of a file mention. */
export interface InputMention {
  target: string;
  lines?: { start: number; end: number };
  /** Offsets of the whole mention, `@` included, in the prompt text. */
  start: number;
  end: number;
}

export interface ParsedChatInput {
  /** The command of a message that starts with `!`, without the `!`. */
  command: string | null;
  /** The text sent to the model: the whole message, or the lines after the `!` command. */
  prompt: string;
  mentions: InputMention[];
}

export type { InputContextItem };

export interface ExpandedChatInput {
  /** The message for the model, with the attached context after the user's text. */
  text: string;
  items: InputContextItem[];
  /** Absolute paths of the mentioned files and symbol definitions. */
  files: string[];
  /** False when the message was only a `!` command that did not run: no turn should start. */
  send: boolean;
}

export interface InputExpansionOptions {
  cwd: string;
  mode: BakeMode;
  repoMap?: IntelligenceClient;
  /** Asked before a destructive command; without it, destructive commands are denied unless the mode is auto. */
  onApproveDestructive?: (description: string) => Promise<boolean>;
  tabId?: string;
  tabLabel?: string;
  abortSignal?: AbortSignal;
}

const MAX_FILE_LINES = 2000;
const MAX_FILE_BYTES = 100_000;
const MAX_DIR_ENTRIES = 200;
const MAX_SYMBOL_LINES = 400;
const MAX_DEFINITIONS = 2;
const MAX_REFERENCES = 15;
const MAX_COMMAND_CHARS = 20_000;
const OUTPUT_PREVIEW_LINES = 12;
const NOT_FOUND = "not found";
/** Modes in which the agent's shell tool is disabled; `!` follows the same rule. */
const SHELL_DISABLED_MODES = new Set<BakeMode>(["plan", "architect"]);

const MENTION_RE = /(^|[\s([{,;])@(?:"([^"\n]+)"|([^\s"'`()<>[\]{},;]+))/g;
const LINES_RE = /#L?(\d+)(?:-L?(\d+))?$/;
const SYMBOL_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** Offsets covered by fenced code blocks and inline code, where `@` is literal. */
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const re = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

export function parseMentions(text: string): InputMention[] {
  const code = codeRanges(text);
  const mentions: InputMention[] = [];
  for (let m = MENTION_RE.exec(text); m !== null; m = MENTION_RE.exec(text)) {
    const start = m.index + (m[1]?.length ?? 0);
    if (code.some(([a, b]) => start >= a && start < b)) continue;
    const quoted = m[2] !== undefined;
    let target = quoted ? (m[2] ?? "") : (m[3] ?? "").replace(/[.,:;!?]+$/, "");
    if (!target) continue;
    const end = quoted ? m.index + m[0].length : start + 1 + target.length;
    let lines: InputMention["lines"];
    const range = LINES_RE.exec(target);
    if (range) {
      const first = Number(range[1]);
      const last = range[2] ? Number(range[2]) : first;
      if (first >= 1 && last >= first) lines = { start: first, end: last };
      target = target.slice(0, range.index);
    }
    if (!target) continue;
    mentions.push({ target, ...(lines ? { lines } : {}), start, end });
  }
  return mentions;
}

export function parseChatInput(input: string): ParsedChatInput {
  const trimmed = input.trimStart();
  const commandMatch = /^!([^\n]*)/.exec(trimmed);
  const command = commandMatch?.[1]?.trim() || null;
  const prompt = command ? trimmed.slice(commandMatch?.[0].length ?? 0).trim() : input;
  return { command, prompt, mentions: parseMentions(prompt) };
}

/** True when the input has anything `expandChatInput` would act on. */
export function hasInputReferences(input: string): boolean {
  const parsed = parseChatInput(input);
  return parsed.command !== null || parsed.mentions.length > 0;
}

function attr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? "" : "s"}`;
}

function toRel(cwd: string, abs: string): string {
  return relative(cwd, abs).replaceAll("\\", "/") || ".";
}

function denyReason(abs: string, cwd: string, tabId?: string): string | null {
  if (classifyPath(abs, cwd) !== null) return "outside the workspace";
  const pattern = isForbidden(abs, tabId) ?? builtinForbidden(abs);
  return pattern ? `forbidden by "${pattern}"` : null;
}

interface Attached {
  item: InputContextItem;
  block?: string;
  file?: string;
}

function attachFile(abs: string, mention: InputMention, cwd: string): Attached {
  const rel = toRel(cwd, abs);
  const fail = (summary: string): Attached => ({
    item: { kind: "file", ref: mention.target, ok: false, summary },
  });
  if (isBinaryFileSync(abs)) return fail("binary file");
  const all = readFileSync(abs, "utf-8").split("\n");
  if (all.at(-1) === "") all.pop();
  const first = mention.lines ? Math.min(mention.lines.start, all.length + 1) : 1;
  const last = mention.lines ? Math.min(mention.lines.end, all.length) : all.length;
  let lines = all.slice(first - 1, last);
  let truncated = false;
  if (lines.length > MAX_FILE_LINES) {
    lines = lines.slice(0, MAX_FILE_LINES);
    truncated = true;
  }
  let body = lines.join("\n");
  if (body.length > MAX_FILE_BYTES) {
    body = body.slice(0, MAX_FILE_BYTES);
    truncated = true;
  }
  const shownLast = first + body.split("\n").length - 1;
  const span = `${String(first)}-${String(Math.max(first, shownLast))}`;
  const note = truncated ? ` truncated="true" total-lines="${String(all.length)}"` : "";
  return {
    item: {
      kind: "file",
      ref: mention.target,
      ok: true,
      summary: mention.lines
        ? `lines ${span}`
        : `${plural(all.length, "line")}${truncated ? `, first ${String(lines.length)} attached` : ""}`,
    },
    block: `<file path="${attr(rel)}" lines="${span}"${note}>\n${body}\n</file>`,
    file: abs,
  };
}

function attachDirectory(abs: string, mention: InputMention, cwd: string): Attached {
  const rel = toRel(cwd, abs);
  const entries = readdirSync(abs, { withFileTypes: true })
    .filter((e) => !(e.isDirectory() && IGNORED_DIRS.has(e.name)))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => a.localeCompare(b));
  const shown = entries.slice(0, MAX_DIR_ENTRIES);
  const more =
    entries.length > shown.length ? `\n… ${String(entries.length - shown.length)} more` : "";
  return {
    item: {
      kind: "directory",
      ref: mention.target,
      ok: true,
      summary: `${String(entries.length)} ${entries.length === 1 ? "entry" : "entries"}`,
    },
    block: `<directory path="${attr(rel)}">\n${shown.join("\n")}${more}\n</directory>`,
  };
}

async function attachSymbol(
  mention: InputMention,
  cwd: string,
  repoMap: IntelligenceClient | undefined,
): Promise<Attached> {
  const fail = (summary: string): Attached => ({
    item: { kind: "symbol", ref: mention.target, ok: false, summary },
  });
  if (!repoMap?.isReady) return fail("repository graph is not ready");
  const defs = await repoMap.findSymbolDefinitions(mention.target, MAX_DEFINITIONS);
  if (defs.length === 0) return fail(NOT_FOUND);
  const blocks: string[] = [];
  let refCount = 0;
  for (const def of defs) {
    const abs = join(cwd, def.path);
    let code = "";
    try {
      const lines = readFileSync(abs, "utf-8").split("\n");
      const end = Math.min(def.endLine || def.line, def.line + MAX_SYMBOL_LINES - 1);
      code = lines.slice(def.line - 1, end).join("\n");
    } catch {
      continue;
    }
    const refs = await repoMap.getSymbolReferences(def.name, def.path, MAX_REFERENCES);
    refCount += refs.calls.length + refs.importers.length;
    const refLines = [
      ...refs.calls.map((c) => `${c.path}:${String(c.line)} in ${c.caller}`),
      ...(refs.importers.length > 0 ? [`imported by: ${refs.importers.join(", ")}`] : []),
    ];
    const references =
      refLines.length > 0 ? `\nReferences:\n${refLines.join("\n")}` : "\nReferences: none indexed";
    const name = def.qualifiedName ?? def.name;
    blocks.push(
      `<symbol name="${attr(name)}" kind="${def.kind}" path="${attr(def.path)}" lines="${String(def.line)}-${String(def.endLine || def.line)}">\n${code}\n${references}\n</symbol>`,
    );
  }
  if (blocks.length === 0) return fail(NOT_FOUND);
  const where = defs[0] ? `${defs[0].path}:${String(defs[0].line)}` : "";
  return {
    item: {
      kind: "symbol",
      ref: mention.target,
      ok: true,
      summary: `${where}, ${plural(refCount, "reference")}${defs.length > 1 ? `, ${String(defs.length)} definitions` : ""}`,
    },
    block: blocks.join("\n"),
    ...(defs[0] ? { file: join(cwd, defs[0].path) } : {}),
  };
}

async function attachMention(
  mention: InputMention,
  opts: InputExpansionOptions,
): Promise<Attached> {
  const { cwd } = opts;
  const abs = isAbsolute(mention.target) ? mention.target : resolve(cwd, mention.target);
  let stat: ReturnType<typeof statSync> | undefined;
  try {
    stat = statSync(abs);
  } catch {
    stat = undefined;
  }
  if (stat) {
    const kind = stat.isDirectory() ? "directory" : "file";
    const denied = denyReason(abs, cwd, opts.tabId);
    if (denied) return { item: { kind, ref: mention.target, ok: false, summary: denied } };
    try {
      return kind === "directory"
        ? attachDirectory(abs, mention, cwd)
        : attachFile(abs, mention, cwd);
    } catch (err) {
      const summary = err instanceof Error ? err.message : String(err);
      return { item: { kind, ref: mention.target, ok: false, summary } };
    }
  }
  if (SYMBOL_RE.test(mention.target)) return attachSymbol(mention, cwd, opts.repoMap);
  return { item: { kind: "file", ref: mention.target, ok: false, summary: NOT_FOUND } };
}

/**
 * Runs a `!` command through the rules of the agent's shell tool: disabled in plan and architect
 * modes, PreToolUse/PostToolUse hooks, forbidden paths, and approval of destructive commands
 * (asked in default mode, granted in auto mode).
 */
async function runCommand(command: string, opts: InputExpansionOptions): Promise<Attached> {
  const fail = (summary: string): Attached => ({
    item: { kind: "command", ref: command, ok: false, summary },
  });
  if (SHELL_DISABLED_MODES.has(opts.mode)) return fail(`shell is disabled in ${opts.mode} mode`);
  let args = { command, cwd: opts.cwd };
  const hooks = hasToolHooks(opts.cwd);
  if (hooks) {
    const pre = await runHooks({
      event: "PreToolUse",
      toolName: "shell",
      toolInput: args,
      cwd: opts.cwd,
    });
    if (pre.blocked) return fail(`blocked by hook: ${pre.reason ?? "no reason given"}`);
    if (pre.updatedInput) args = { ...args, ...(pre.updatedInput as Partial<typeof args>) };
  }
  const deny = async (): Promise<boolean> => false;
  const onApproveDestructive =
    opts.mode === "auto" ? undefined : (opts.onApproveDestructive ?? deny);
  const result = await runGatedShell(
    args,
    {
      ...(onApproveDestructive ? { onApproveDestructive } : {}),
      ...(opts.tabId ? { tabId: opts.tabId } : {}),
      ...(opts.tabLabel ? { tabLabel: opts.tabLabel } : {}),
      ...(opts.repoMap ? { repoMap: opts.repoMap } : {}),
    },
    opts.abortSignal,
  );
  if (hooks) {
    await runHooks({
      event: "PostToolUse",
      toolName: "shell",
      toolInput: args,
      toolResponse: result,
      cwd: opts.cwd,
    }).catch(() => {});
  }
  // The command may have changed files the agent has already read.
  emitCacheReset();
  const notRun = /^(Denied:|Access denied:|BLOCKED:)/.test(result.output);
  if (notRun) return fail(result.error ?? result.output);
  let output = result.output;
  const truncated = output.length > MAX_COMMAND_CHARS;
  if (truncated) output = `${output.slice(0, MAX_COMMAND_CHARS)}\n… output truncated`;
  const status = result.success ? "ok" : "failed";
  const preview = output.split("\n").slice(0, OUTPUT_PREVIEW_LINES).join("\n");
  return {
    item: {
      kind: "command",
      ref: command,
      ok: result.success,
      summary: result.success ? "ran" : `failed${result.error ? `: ${result.error}` : ""}`,
      output: preview,
    },
    block: `<command cmd="${attr(args.command)}" status="${status}">\n${output}\n</command>`,
  };
}

/**
 * Expands a chat message: runs its `!` command and attaches the files, directories and symbols
 * its `@` mentions name. Mentions that resolve to nothing stay plain text. The user's text is
 * kept as typed; the context follows it in an `<attached-context>` block.
 */
export async function expandChatInput(
  input: string,
  opts: InputExpansionOptions,
): Promise<ExpandedChatInput> {
  const parsed = parseChatInput(input);
  if (parsed.command === null && parsed.mentions.length === 0) {
    return { text: input, items: [], files: [], send: true };
  }
  const attached: Attached[] = [];
  if (parsed.command !== null) attached.push(await runCommand(parsed.command, opts));
  const seen = new Set<string>();
  for (const mention of parsed.mentions) {
    const key = `${mention.target}#${String(mention.lines?.start ?? "")}-${String(mention.lines?.end ?? "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    attached.push(await attachMention(mention, opts));
  }
  const commandRan = parsed.command === null || attached[0]?.block !== undefined;
  const blocks = attached.flatMap((a) => (a.block ? [a.block] : []));
  const prompt =
    parsed.prompt ||
    (parsed.command !== null ? "I ran this command in the workspace. Here is its output." : "");
  // A mention that names nothing is ordinary text (an e-mail handle, a package scope).
  const failed = attached
    .filter((a) => !a.block && a.item.summary !== NOT_FOUND)
    .map((a) => a.item);
  const notes =
    failed.length > 0
      ? `\n${failed.map((i) => `Not attached: ${i.kind === "command" ? "!" : "@"}${i.ref} (${i.summary})`).join("\n")}`
      : "";
  const text =
    blocks.length > 0 || notes
      ? `${prompt}\n\n<attached-context>\n${blocks.join("\n")}${notes}\n</attached-context>`
      : prompt;
  return {
    text,
    items: attached.map((a) => a.item),
    files: attached.flatMap((a) => (a.file ? [a.file] : [])),
    send: commandRan || parsed.prompt.length > 0,
  };
}
