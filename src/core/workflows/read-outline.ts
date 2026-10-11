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

async function outline(path: string, label = path): Promise<string | null> {
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
    const lines = tracked ? outlineLines(tracked.value) : [];
    if (lines.length === 0) return null;
    const size = statSync(path).size;
    const shown = lines.slice(0, MAX_OUTLINE_LINES);
    const more = lines.length - shown.length;
    return [
      `${label} is ${Math.round(size / 1024)} KB, so it is shown as an outline (line spans). Read only what the task needs: {path, ranges:[{start,end}]} for the spans above, or {path, target:"function", name}.`,
      ...shown,
      ...(more > 0 ? [`  ... ${more} more declarations`] : []),
    ].join("\n");
  } catch {
    return null;
  }
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
 * later step of the attempt resends one step less. Files that are missing, binary or without an
 * outline are left for the agent to read.
 */
export async function preloadTaskFiles(
  root: string,
  writes: readonly { path: string; action: string }[],
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
    const text = await outline(path, write.path);
    if (text) parts.push(`--- ${write.path}\n${text}`);
  }
  return parts.join("\n\n");
}
