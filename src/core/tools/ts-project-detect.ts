import { access } from "node:fs/promises";
import { join } from "node:path";

const TS_JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

let _cachedIsTsJs: boolean | null = null;
let _nudgedThisSession = false;

export function hasTsJsExtension(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return TS_JS_EXTS.has(path.slice(dot));
}

export async function isTsJsProject(cwd: string = process.cwd()): Promise<boolean> {
  if (_cachedIsTsJs !== null) return _cachedIsTsJs;
  const check = async (f: string): Promise<boolean> => {
    try {
      await access(join(cwd, f));
      return true;
    } catch {
      return false;
    }
  };
  _cachedIsTsJs =
    (await check("package.json")) ||
    (await check("tsconfig.json")) ||
    (await check("bun.lock")) ||
    (await check("bun.lockb")) ||
    (await check("deno.json"));
  return _cachedIsTsJs;
}

/**
 * One-shot nudge: returns the reminder string the first time it's called
 * for a TS/JS file in a TS/JS project, then null forever after.
 */
export async function consumeAstEditNudge(filePath: string): Promise<string | null> {
  if (_nudgedThisSession) return null;
  if (!hasTsJsExtension(filePath)) return null;
  if (!(await isTsJsProject())) return null;
  _nudgedThisSession = true;
  return "<system-reminder>TS/JS project — prefer ast_edit for .ts/.tsx/.js/.jsx files (ts-morph, no line drift). edit_file/multi_edit is for JSON/YAML/MD/raw text.</system-reminder>";
}

/** @internal — test hook */
export function __resetNudgeState(): void {
  _cachedIsTsJs = null;
  _nudgedThisSession = false;
}
