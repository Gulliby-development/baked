import { basename } from "node:path";
import type { Diagnostic } from "./types.js";

export interface NewDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: Diagnostic["severity"];
  message: string;
  code?: string | number;
  fixes: string[];
}

export interface PostEditResult {
  newErrors: NewDiagnostic[];
  newWarnings: NewDiagnostic[];
  resolved: number;
  /** New errors in files that import the edited one. */
  crossFileErrors: NewDiagnostic[];
  /** Why the check of the edited file did not run, e.g. a timeout; null when it ran. */
  skipped: string | null;
  /** Importers that had a baseline but no result in time. */
  uncheckedDependents: number;
}

/** Where diagnostics come from; the tools use the language servers, tests a fake. */
export interface DiagnosticsSource {
  diagnostics(file: string): Promise<Diagnostic[] | null>;
  fixes?(file: string, diag: Diagnostic): Promise<string[]>;
}

/** Diagnostics of the edited file and its importers taken before an edit. */
export interface DiagnosticsBaseline {
  file: string;
  /** Null when the edited file had no result in time. */
  before: Diagnostic[] | null;
  dependents: Map<string, Diagnostic[]>;
  /** Importers the graph named but that had no baseline in time. */
  missedDependents: number;
}

const key = (d: Diagnostic): string =>
  `${d.severity}\u0000${String(d.code ?? "")}\u0000${d.message}`;

/**
 * Diagnostics in `after` that `before` does not have, and the count of errors `before` had that
 * are gone. Matched by severity, code and message, not by line: an edit moves the lines below it.
 */
export function diffDiagnostics(
  before: Diagnostic[],
  after: Diagnostic[],
): { added: Diagnostic[]; resolved: number } {
  const remaining = new Map<string, number>();
  for (const d of before) remaining.set(key(d), (remaining.get(key(d)) ?? 0) + 1);
  const added: Diagnostic[] = [];
  for (const d of after) {
    const left = remaining.get(key(d)) ?? 0;
    if (left > 0) remaining.set(key(d), left - 1);
    else added.push(d);
  }
  let resolved = 0;
  for (const d of before)
    if (d.severity === "error" && (remaining.get(key(d)) ?? 0) > 0) {
      resolved++;
      remaining.set(key(d), (remaining.get(key(d)) ?? 0) - 1);
    }
  return { added, resolved };
}

const within = <T>(promise: Promise<T>, deadline: number): Promise<T | undefined> =>
  Promise.race([
    promise,
    new Promise<undefined>((r) => setTimeout(r, Math.max(0, deadline - Date.now()))),
  ]);

/** Takes the baseline of the edited file and its importers, each bounded by `timeoutMs`. */
export async function takeBaseline(
  source: DiagnosticsSource,
  file: string,
  dependents: string[],
  timeoutMs: number,
): Promise<DiagnosticsBaseline> {
  const deadline = Date.now() + timeoutMs;
  const safe = (path: string) => source.diagnostics(path).catch((): null => null);
  const [before, ...deps] = await Promise.all([
    within(safe(file), deadline),
    ...dependents.map((path) => within(safe(path), deadline)),
  ]);
  const baseline: DiagnosticsBaseline = {
    file,
    before: before === undefined ? null : (before ?? []),
    dependents: new Map(),
    missedDependents: 0,
  };
  dependents.forEach((path, i) => {
    const diags = deps[i];
    if (diags === undefined) baseline.missedDependents++;
    else baseline.dependents.set(path, diags ?? []);
  });
  return baseline;
}

const MAX_FIX_LOOKUPS = 3;

/**
 * Compares diagnostics after an edit with the baseline: the edited file first, since querying it
 * sends the change to the language server, then its importers. Bounded by `timeoutMs`; what does
 * not answer in time is reported as skipped or unchecked rather than left out silently.
 */
export async function compareWithBaseline(
  source: DiagnosticsSource,
  baseline: DiagnosticsBaseline,
  timeoutMs: number,
): Promise<PostEditResult> {
  const result: PostEditResult = {
    newErrors: [],
    newWarnings: [],
    resolved: 0,
    crossFileErrors: [],
    skipped: null,
    uncheckedDependents: baseline.missedDependents,
  };
  if (!baseline.before) {
    result.skipped = `no diagnostics before the edit within ${String(timeoutMs)} ms`;
    result.uncheckedDependents += baseline.dependents.size;
    return result;
  }
  const deadline = Date.now() + timeoutMs;
  const safe = (path: string) => source.diagnostics(path).catch((): null => null);
  const after = await within(safe(baseline.file), deadline);
  if (after === undefined) {
    result.skipped = `no diagnostics within ${String(timeoutMs)} ms`;
    result.uncheckedDependents += baseline.dependents.size;
    return result;
  }
  let lookups = 0;
  const entry = async (diag: Diagnostic, file: string): Promise<NewDiagnostic> => {
    let fixes: string[] = [];
    if (source.fixes && lookups < MAX_FIX_LOOKUPS && Date.now() < deadline) {
      lookups++;
      fixes =
        (await within(
          source.fixes(file, diag).catch(() => []),
          deadline,
        )) ?? [];
    }
    return {
      file,
      line: diag.line,
      column: diag.column,
      severity: diag.severity,
      message: diag.message,
      code: diag.code,
      fixes,
    };
  };
  const own = diffDiagnostics(baseline.before, after ?? []);
  result.resolved = own.resolved;
  for (const diag of own.added) {
    if (diag.severity === "error") result.newErrors.push(await entry(diag, baseline.file));
    else if (diag.severity === "warning") result.newWarnings.push(await entry(diag, baseline.file));
  }
  const paths = [...baseline.dependents.keys()];
  const answers = await Promise.all(paths.map((path) => within(safe(path), deadline)));
  for (const [i, path] of paths.entries()) {
    const now = answers[i];
    if (now === undefined) {
      result.uncheckedDependents++;
      continue;
    }
    const { added } = diffDiagnostics(baseline.dependents.get(path) ?? [], now ?? []);
    for (const diag of added)
      if (diag.severity === "error") result.crossFileErrors.push(await entry(diag, path));
  }
  return result;
}

export const totalNewErrors = (result: PostEditResult): number =>
  result.newErrors.length + result.crossFileErrors.length;

export function formatPostEditResult(
  result: PostEditResult,
  displayFile: (file: string) => string = basename,
): string | null {
  const parts: string[] = [];

  if (result.resolved > 0) {
    parts.push(`✓ ${String(result.resolved)} error(s) resolved`);
  }

  const totalErrors = totalNewErrors(result);

  if (result.newErrors.length > 0) {
    parts.push(`❌ ERRORS INTRODUCED — ${String(result.newErrors.length)} new error(s):`);
    for (const e of result.newErrors.slice(0, 5)) {
      const code = e.code ? ` [${String(e.code)}]` : "";
      parts.push(`  L${String(e.line)}${code}: ${e.message}`);
      if (e.fixes.length > 0) {
        parts.push(`    fix: ${e.fixes[0]}`);
      }
    }
    if (result.newErrors.length > 5) {
      parts.push(`  ...and ${String(result.newErrors.length - 5)} more`);
    }
  }

  if (result.crossFileErrors.length > 0) {
    parts.push(
      `❌ CROSS-FILE ERRORS — ${String(result.crossFileErrors.length)} new error(s) in files that import this one:`,
    );
    for (const e of result.crossFileErrors.slice(0, 5)) {
      const code = e.code ? ` [${String(e.code)}]` : "";
      parts.push(`  ${displayFile(e.file)}:${String(e.line)}${code}: ${e.message}`);
      if (e.fixes.length > 0) {
        parts.push(`    fix: ${e.fixes[0]}`);
      }
    }
    if (result.crossFileErrors.length > 5) {
      parts.push(`  ...and ${String(result.crossFileErrors.length - 5)} more`);
    }
  }

  if (totalErrors > 0) {
    parts.push("⛔ FIX THESE ERRORS before continuing with other work.");
  }

  if (result.newWarnings.length > 0 && totalErrors === 0) {
    parts.push(`△ ${String(result.newWarnings.length)} new warning(s)`);
  }

  if (result.skipped) {
    parts.push(`△ Diagnostics not checked: ${result.skipped} (diagnostics.timeoutMs).`);
  } else if (result.uncheckedDependents > 0) {
    parts.push(
      `△ ${String(result.uncheckedDependents)} importing file(s) not checked: no diagnostics in time.`,
    );
  }

  return parts.length > 0 ? parts.join("\n") : null;
}
