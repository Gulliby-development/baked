import { readFileSync, statSync } from "node:fs";
import { getCwd } from "../cwd.js";
import { getIntelligenceRouter } from "../intelligence/index.js";
import type { SymbolInfo } from "../intelligence/types.js";
import { workspacePath } from "../specs/validate.js";
import { contentHash } from "../tools/tool-utils.js";

/**
 * A whole-file read above this size gets the file's outline instead of its content. Every later
 * step of the attempt resends what a read returned, so one 60 KB file read whole costs about
 * 20k input tokens per step; most tasks need a few of its symbols.
 */
export const LARGE_READ_BYTES = 20_000;
/**
 * A file the task writes is read whole up to this size: the edit needs its exact text. Above it
 * the outline and range reads cost less, since range reads stay in the history (run 8 read a
 * 60 KB written file whole on every attempt, at 45-49k input tokens per step).
 */
export const WRITTEN_READ_BYTES = 24_000;
/**
 * Whole files placed in an implementer's first prompt, in total. Each later step resends them,
 * as it would resend the same files read in the first step; files past the total are outlined.
 */
export const PRELOAD_TOTAL_BYTES = 64_000;
/**
 * Spans of an outlined written file whose symbol the task names, preloaded under its outline, per
 * file. A task that names the function it changes then edits it on its first step instead of
 * spending a step on a range read of it. The spans count toward the preload total.
 */
export const NAMED_SPANS_BYTES = 16_000;
/** Shorter identifiers in a task's text are too often plain words to pick a symbol by. */
const MIN_NAMED_LENGTH = 4;
const MAX_OUTLINE_LINES = 200;
const STRUCTURE = new Set(["class", "interface", "type", "enum", "function", "method"]);

type ReadSpec = string | { path?: unknown; ranges?: unknown; target?: unknown };

/** The absolute path of a whole-file read of a file larger than the limit, else null. */
function largeWholeRead(spec: ReadSpec, written: ReadonlySet<string>): string | null {
  const path = typeof spec === "string" ? spec : spec.path;
  if (typeof path !== "string") return null;
  if (isTargetedRead(spec)) return null;
  try {
    const limit = written.has(path) ? WRITTEN_READ_BYTES : LARGE_READ_BYTES;
    return statSync(path).size > limit ? path : null;
  } catch {
    return null;
  }
}

/** A read spec of line ranges or a symbol. */
export function isTargetedRead(spec: unknown): boolean {
  if (!spec || typeof spec !== "object") return false;
  const { ranges, target } = spec as { ranges?: unknown; target?: unknown };
  return !!target || (Array.isArray(ranges) && ranges.length > 0);
}

/** Declarations with their line spans; variables only outside a function or method. */
function outlineLines(symbols: SymbolInfo[]): string[] {
  const bodies = symbols.filter((s) => s.kind === "function" || s.kind === "method");
  const inBody = (s: SymbolInfo) =>
    bodies.some(
      (b) =>
        b !== s &&
        b.location.line < s.location.line &&
        (b.location.endLine ?? 0) >= s.location.line,
    );
  return symbols
    .filter((s) => STRUCTURE.has(s.kind) || (s.kind === "variable" && !inBody(s)))
    .sort((a, b) => a.location.line - b.location.line)
    .map((s) => {
      const end =
        s.location.endLine && s.location.endLine > s.location.line ? `-${s.location.endLine}` : "";
      return `  ${s.location.line}${end} ${s.kind} ${s.name}`;
    });
}

async function fileSymbols(path: string): Promise<SymbolInfo[] | null> {
  try {
    // The router is a process-wide singleton bound to the first cwd it is created with.
    const router = getIntelligenceRouter(getCwd());
    const language = router.detectLanguage(path);
    // tree-sitter lists class members with their spans; other backends may list top-level only.
    const tracked =
      (await router.executeWithFallbackTracked(language, "findSymbols", (b) =>
        b.name === "tree-sitter" && b.findSymbols ? b.findSymbols(path) : Promise.resolve(null),
      )) ??
      (await router.executeWithFallbackTracked(language, "findSymbols", (b) =>
        b.findSymbols ? b.findSymbols(path) : Promise.resolve(null),
      ));
    return tracked?.value ?? null;
  } catch {
    return null;
  }
}

function outlineText(path: string, label: string, symbols: SymbolInfo[]): string | null {
  const lines = outlineLines(symbols);
  if (lines.length === 0) return null;
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  const shown = lines.slice(0, MAX_OUTLINE_LINES);
  const more = lines.length - shown.length;
  return [
    `${label} is ${Math.round(size / 1024)} KB, so it is shown as an outline (line spans). Read only what the task needs: {path, ranges:[{start,end}]} for the spans above, or {path, target:"function", name}.`,
    ...shown,
    ...(more > 0 ? [`  ... ${more} more declarations`] : []),
  ].join("\n");
}

async function outline(path: string, label = path): Promise<string | null> {
  const symbols = await fileSymbols(path);
  return symbols ? outlineText(path, label, symbols) : null;
}

/**
 * Line spans (1-based, inclusive) of the outlined symbols whose names appear as identifiers in
 * `hint`, merged where they overlap and kept in file order while they fit in `budget` bytes. A
 * span larger than the budget, or a class whose named members are shown, is left to the outline.
 */
export function namedSymbolSpans(
  symbols: SymbolInfo[],
  lines: readonly string[],
  hint: string,
  budget: number,
): { start: number; end: number }[] {
  const named = new Set(
    (hint.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((word) => word.length >= MIN_NAMED_LENGTH),
  );
  if (named.size === 0) return [];
  const listed = new Set(outlineLines(symbols).map((line) => line.trim()));
  const spans = symbols
    .filter((s) => named.has(s.name))
    .map((s) => ({ symbol: s, start: s.location.line, end: s.location.endLine ?? s.location.line }))
    // Only declarations the outline shows: a local that shares a name with the task's words is
    // not what the task changes.
    .filter(({ symbol, start, end }) =>
      listed.has(`${start}${end > start ? `-${end}` : ""} ${symbol.kind} ${symbol.name}`),
    )
    .filter(
      ({ start, end }) => Buffer.byteLength(lines.slice(start - 1, end).join("\n")) <= budget,
    );
  // A class whose members the task also names is shown by those members: the task changes them,
  // not the whole class.
  const innermost = spans
    .filter(
      (outer) =>
        !spans.some(
          (inner) =>
            inner !== outer &&
            inner.start >= outer.start &&
            inner.end <= outer.end &&
            (inner.start > outer.start || inner.end < outer.end),
        ),
    )
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: { start: number; end: number }[] = [];
  for (const span of innermost) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ start: span.start, end: span.end });
  }
  const kept: { start: number; end: number }[] = [];
  let used = 0;
  for (const span of merged) {
    const bytes = Buffer.byteLength(lines.slice(span.start - 1, span.end).join("\n"));
    if (used + bytes > budget) continue;
    used += bytes;
    kept.push(span);
  }
  return kept;
}

/**
 * Splits a `read` call's files into the ones read as asked and outlines of large whole-file reads.
 * A file without an outline (an unsupported language, a parse failure) is read as asked.
 */
export async function outlineLargeReads(
  files: unknown[],
  written: readonly string[] = [],
): Promise<{ files: unknown[]; outlines: string[] }> {
  const writes = new Set(written);
  const kept: unknown[] = [];
  const outlines: string[] = [];
  for (const spec of files) {
    const path =
      spec && (typeof spec === "string" || typeof spec === "object")
        ? largeWholeRead(spec as ReadSpec, writes)
        : null;
    const text = path ? await outline(path) : null;
    if (text) outlines.push(text);
    else kept.push(spec);
  }
  return { files: kept, outlines };
}

/**
 * The files a task modifies, as the read tool would show them: whole with line numbers up to the
 * written-file limit, outlines above it or past the preload total. An implementer that gets them
 * in its first prompt edits on its first step instead of spending a step reading them, and every
 * later step of the attempt resends one step less. An outlined file also carries the spans of the
 * symbols `hint` (the task's title and description) names. Files that are missing, binary or
 * without an outline are left for the agent to read.
 */
export async function preloadTaskFiles(
  root: string,
  writes: readonly { path: string; action: string }[],
  hint = "",
): Promise<string> {
  const parts: string[] = [];
  let total = 0;
  for (const write of writes) {
    if (write.action !== "modify") continue;
    let path: string;
    let bytes: Buffer;
    try {
      path = workspacePath(root, write.path);
      bytes = readFileSync(path);
    } catch {
      continue;
    }
    if (bytes.includes(0)) continue;
    if (bytes.length <= WRITTEN_READ_BYTES && total + bytes.length <= PRELOAD_TOTAL_BYTES) {
      total += bytes.length;
      const content = bytes.toString("utf8");
      const numbered = content
        .split("\n")
        .map((line, i) => `${String(i + 1).padStart(4)}  ${line}`)
        .join("\n");
      parts.push(`--- ${write.path}\n${numbered}\nhash:${contentHash(content)}`);
      continue;
    }
    const symbols = await fileSymbols(path);
    const text = symbols ? outlineText(path, write.path, symbols) : null;
    if (!symbols || !text) continue;
    const content = bytes.toString("utf8");
    const lines = content.split("\n");
    const spans = namedSymbolSpans(
      symbols,
      lines,
      hint,
      Math.min(NAMED_SPANS_BYTES, PRELOAD_TOTAL_BYTES - total),
    );
    if (spans.length === 0) {
      parts.push(`--- ${write.path}\n${text}`);
      continue;
    }
    const shown = spans.map((span) =>
      lines
        .slice(span.start - 1, span.end)
        .map((line, i) => `${String(span.start + i).padStart(4)}  ${line}`)
        .join("\n"),
    );
    total += shown.reduce((sum, part) => sum + Buffer.byteLength(part), 0);
    parts.push(
      `--- ${write.path}\n${text}\nThe spans the task names, as a range read shows them:\n${shown.join("\n  ...\n")}\nhash:${contentHash(content)}`,
    );
  }
  return parts.join("\n\n");
}
