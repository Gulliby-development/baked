import { statSync } from "node:fs";
import { getCwd } from "../cwd.js";
import { getIntelligenceRouter } from "../intelligence/index.js";
import type { SymbolInfo } from "../intelligence/types.js";

/**
 * A whole-file read above this size gets the file's outline instead of its content. Every later
 * step of the attempt resends what a read returned, so one 60 KB file read whole costs about
 * 20k input tokens per step; most tasks need a few of its symbols.
 */
export const LARGE_READ_BYTES = 20_000;
/**
 * A file the task writes is read whole up to this size: the edit needs its exact text, and an
 * outline of it turned into many range reads that cost more than the file.
 */
export const WRITTEN_READ_BYTES = 64_000;
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

async function outline(path: string): Promise<string | null> {
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
      `${path} is ${Math.round(size / 1024)} KB, so it is shown as an outline (line spans). Read only what the task needs: {path, ranges:[{start,end}]} for the spans above, or {path, target:"function", name}.`,
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
