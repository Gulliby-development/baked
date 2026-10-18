import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { getCwd } from "../cwd.js";
import {
  compareWithBaseline,
  type DiagnosticsBaseline,
  type DiagnosticsSource,
  formatPostEditResult,
  takeBaseline,
  totalNewErrors,
} from "../intelligence/post-edit.js";
import type { CodeAction } from "../intelligence/types.js";
import { atomicWriteFile } from "../platform/index.js";
import { displayPath } from "../utils/path-display.js";
import { autoFormatAfterEdit } from "./auto-format.js";
import { configuredDiagnosticsTimeoutMs, editDiagnosticsMode } from "./edit-diagnostics.js";
import { dropLastEdit, updateLastAfterHash } from "./edit-stack.js";
import { emitFileEdited } from "./file-events.js";
import { toolPhase } from "./tool-phase.js";

export interface DiagnosticsContext {
  source: DiagnosticsSource;
  baseline: DiagnosticsBaseline;
  timeoutMs: number;
}

/** Importers of an edited file whose diagnostics are compared too, by graph weight. */
const MAX_DEPENDENTS = 8;
const WORKTREE_PREFIX = /^\.baked\/worktrees\/[^/]+\/[^/]+\//;

/** Diagnostics and quick fixes from the language servers, through the worker when it runs. */
export function intelligenceSource(
  intel: typeof import("../intelligence/index.js"),
): DiagnosticsSource {
  const client = intel.getIntelligenceClient();
  const router = intel.getIntelligenceRouter(getCwd());
  return {
    diagnostics: async (file) => {
      if (client) return (await client.routerGetDiagnostics(file))?.value ?? null;
      return router.executeWithFallback(router.detectLanguage(file), "getDiagnostics", (b) =>
        b.getDiagnostics ? b.getDiagnostics(file) : Promise.resolve(null),
      );
    },
    fixes: async (file, diag) => {
      let actions: CodeAction[] | null;
      if (client) {
        actions = (await client.routerGetCodeActions(file, diag.line, diag.line))?.value ?? null;
      } else {
        actions = await router.executeWithFallback(
          router.detectLanguage(file),
          "getCodeActions",
          (b) => {
            if (!b.getCodeActions) return Promise.resolve(null);
            const codes = diag.code !== undefined ? [diag.code] : undefined;
            return b.getCodeActions(file, diag.line, diag.line, codes);
          },
        );
      }
      if (!actions) return [];
      return actions
        .filter((a) => a.kind === "quickfix" || a.isPreferred)
        .map((a) => a.title)
        .slice(0, 3);
    },
  };
}

/**
 * Files that import `filePath`, from the code graph. A file in a workflow worktree is looked up
 * by its path in the project, and its importers are returned inside the same worktree.
 */
async function importersOf(
  intel: typeof import("../intelligence/index.js"),
  filePath: string,
): Promise<string[]> {
  const client = intel.getIntelligenceClient();
  if (!client?.isReady) return [];
  const cwd = getCwd();
  let rel = relative(cwd, filePath).split(sep).join("/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return [];
  let base = cwd;
  const worktree = WORKTREE_PREFIX.exec(rel);
  if (worktree) {
    base = join(cwd, worktree[0]);
    rel = rel.slice(worktree[0].length);
  }
  const dependents = await client.getFileDependents(rel);
  return dependents
    .map((d) => join(base, d.path))
    .filter((path) => path !== filePath && existsSync(path))
    .slice(0, MAX_DEPENDENTS);
}

/**
 * Takes diagnostics of the file and of the files importing it before an edit. Await it before
 * writing: a baseline read after the write would hide the errors the edit adds. Bounded by
 * `diagnostics.timeoutMs`; skipped when intelligence has not started, so edit tools never
 * cold-start language servers.
 */
export async function startPreEditDiagnostics(
  filePath: string,
  options: { newFile?: boolean } = {},
): Promise<DiagnosticsContext | null> {
  try {
    const intel = await import("../intelligence/index.js");
    if (!intel.isIntelligenceReady()) return null;
    const timeoutMs = configuredDiagnosticsTimeoutMs();
    const source = intelligenceSource(intel);
    // A file being created has no errors yet and nothing imports it.
    if (options.newFile)
      return {
        source,
        baseline: { file: filePath, before: [], dependents: new Map(), missedDependents: 0 },
        timeoutMs,
      };
    const dependents = await Promise.race([
      importersOf(intel, filePath).catch((): string[] => []),
      new Promise<string[]>((r) => setTimeout(() => r([]), timeoutMs)),
    ]);
    const baseline = await takeBaseline(source, filePath, dependents, timeoutMs);
    return { source, baseline, timeoutMs };
  } catch {
    return null;
  }
}

/**
 * Auto-format after edit and append format status to output.
 * Returns the (possibly modified) output string.
 */
export async function appendAutoFormatResult(
  filePath: string,
  updatedContent: string,
  output: string,
  tabId?: string,
  before?: string | null,
): Promise<string> {
  let result = output;
  toolPhase("format");
  const formatted = await autoFormatAfterEdit(filePath, undefined, before);
  if (formatted) {
    const postFormatContent = await readFile(filePath, "utf-8");
    updateLastAfterHash(filePath, postFormatContent, tabId);
    const postLines = postFormatContent.split("\n").length;
    const preLines = updatedContent.split("\n").length;
    if (postLines !== preLines) {
      result += ` (formatted, line count changed ${String(preLines)}→${String(postLines)} — re-read affected range before next edit)`;
    } else {
      result += " (formatted)";
    }
  }
  return result;
}

/** What a rejected edit is undone to. */
export interface EditRevert {
  /** The file's text before the edit, written back when the edit is rejected. */
  before: string;
  /** The text the edit wrote; locates the changed lines shown with the rejection. */
  after: string;
  tabId?: string;
}

const MAX_ORIGINAL_LINES = 30;

/** The lines of `before` that the edit replaced, with a little context and line numbers. */
export function originalRegion(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - 2);
  const to = Math.min(a.length - 1, Math.max(endA, start) + 2, from + MAX_ORIGINAL_LINES - 1);
  return a
    .slice(from, to + 1)
    .map((line, i) => `${String(from + i + 1).padStart(4)} │ ${line}`)
    .join("\n");
}

/**
 * Post-edit diagnostics: compares the edited file and its importers with the baseline. In
 * `reject` mode (`editDiagnostics`, or the run policy in a workflow) an edit that introduces
 * errors is undone: the original text is written back and returned with the errors.
 */
export async function appendPostEditDiagnostics(
  diagCtx: DiagnosticsContext | null,
  filePath: string,
  output: string,
  revert?: EditRevert,
): Promise<{ output: string; rejected: boolean }> {
  if (!diagCtx) return { output, rejected: false };
  toolPhase("diagnostics");
  try {
    const result = await compareWithBaseline(diagCtx.source, diagCtx.baseline, diagCtx.timeoutMs);
    const cwd = getCwd();
    const show = (file: string) => {
      const rel = relative(cwd, file);
      // A file on another drive has no relative path: `relative` returns it absolute.
      return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : file;
    };
    const diffOutput = formatPostEditResult(result, show);
    if (revert && totalNewErrors(result) > 0 && editDiagnosticsMode() === "reject") {
      await atomicWriteFile(filePath, revert.before);
      dropLastEdit(filePath, revert.tabId);
      emitFileEdited(filePath, revert.before);
      const lines = [
        `❌ EDIT REJECTED — it introduced ${String(totalNewErrors(result))} error(s), so ${displayPath(filePath)} was restored (editDiagnostics: reject).`,
        diffOutput ?? "",
        "Original text, unchanged on disk:",
        originalRegion(revert.before, revert.after),
        "Change the edit so it introduces no errors, then apply it again.",
      ];
      return { output: lines.filter(Boolean).join("\n"), rejected: true };
    }
    return { output: diffOutput ? `${output}\n${diffOutput}` : output, rejected: false };
  } catch {
    return { output, rejected: false };
  }
}

/**
 * Query clone detection for the edited file and append hints about near-duplicate
 * functions that already exist elsewhere. Non-blocking — 500ms timeout, swallows errors.
 */
export async function appendCloneHints(filePath: string, output: string): Promise<string> {
  toolPhase("clone_hints");
  try {
    const { relative } = await import("node:path");
    const intel = await import("../intelligence/index.js");
    if (!intel.isIntelligenceReady()) return output;
    const client = intel.getIntelligenceClient();
    if (!client) return output;
    const relPath = relative(getCwd(), filePath);
    const dupes = await Promise.race([
      client.getFileDuplicates(relPath),
      new Promise<null>((r) => setTimeout(() => r(null), 500)),
    ]);
    if (!dupes || dupes.length === 0) return output;
    const hints: string[] = [];
    for (const d of dupes.slice(0, 3)) {
      const pct = `${String(Math.round(d.similarity * 100))}%`;
      const top = d.clones[0];
      if (!top) continue;
      const extra = d.clones.length > 1 ? ` (+${String(d.clones.length - 1)} more)` : "";
      hints.push(
        `  ${d.name} ~${pct} similar to ${top.name} at ${top.path}:${String(top.line)}${extra}`,
      );
    }
    if (hints.length > 0) {
      return `${output}\n⚠ Near-duplicate code detected — consider reusing:\n${hints.join("\n")}`;
    }
  } catch {}
  return output;
}

/**
 * Count occurrences of a substring without allocating split arrays.
 * O(n) scan using indexOf — cheaper than content.split(needle).length - 1
 * for large files with long needles.
 */
export function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = haystack.indexOf(needle, 0);
  while (pos !== -1) {
    count++;
    pos = haystack.indexOf(needle, pos + needle.length);
  }
  return count;
}
