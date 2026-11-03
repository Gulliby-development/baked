import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ToolResult } from "../../types";
import { getCwd } from "../cwd.js";
import { isForbidden } from "../security/forbidden.js";
import { getVendoredPath } from "../setup/install.js";

interface GlobArgs {
  pattern: string;
  path?: string;
}

const MAX_FILES = 100;
const NO_FILES = "No files found.";

/**
 * The pattern as a matcher of paths relative to the base directory. A pattern with a slash
 * (`src/**\/*.test.*`) is matched from the base, one without (`*.ts`) at any depth. The tool
 * used to hand the pattern to `fd --glob` and `find -name`, which match only the base name,
 * so every pattern with a slash, the documented `**\/*.ts` included, listed nothing (#2681).
 */
export function globMatcher(pattern: string): (relPath: string) => boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const glob = new Bun.Glob(normalized.includes("/") ? normalized : `**/${normalized}`);
  return (relPath) => glob.match(relPath.replaceAll("\\", "/"));
}

/**
 * Every file under `root` that ripgrep would search: hidden and gitignored files left out.
 * The pattern is not passed as `--glob`, which overrides those rules for the files it matches.
 * Null when ripgrep cannot run.
 */
function listFiles(root: string): Promise<string[] | null> {
  return new Promise((done) => {
    const rgBin = getVendoredPath("rg") ?? "rg";
    const proc = spawn(rgBin, ["--files", "--", "."], {
      cwd: root,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (data: Buffer) => chunks.push(data));
    proc.on("error", () => done(null));
    proc.on("close", (code: number | null) => {
      // 1: no file at all; anything else is an error.
      if (code !== 0 && code !== 1) return done(null);
      const text = Buffer.concat(chunks).toString("utf-8");
      done(
        text
          .split(/\r?\n/)
          .filter(Boolean)
          .map((p) => p.replace(/^\.[\\/]/, "")),
      );
    });
  });
}

const SKIP_PARTS = /(^|\/)(node_modules|\.[^/]*)(\/|$)/;

/** In-process listing when ripgrep is missing: hidden paths and node_modules left out. */
function scanFiles(root: string): string[] {
  try {
    return [...new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true, dot: false })].filter(
      (rel) => !SKIP_PARTS.test(rel.replaceAll("\\", "/")),
    );
  } catch {
    return [];
  }
}

export const globTool = {
  name: "glob",
  description:
    "[TIER-2] File pattern matching — use bake_find first for fuzzy search. " +
    "Glob patterns: '**/*.ts', 'src/**/*.test.*'. A pattern with a slash is matched from the base directory, one without ('*.ts') at any depth. " +
    "Returns paths sorted by modification time, newest first. " +
    "LIMITATIONS: Max 100 files. Hidden and gitignored files skipped.",
  execute: async (args: GlobArgs): Promise<ToolResult> => {
    const basePath = args.path ?? ".";
    const root = resolve(getCwd(), basePath);
    const matches = globMatcher(args.pattern);

    const files = (await listFiles(root)) ?? scanFiles(root);
    const found: Array<{ path: string; mtime: number }> = [];
    for (const rel of files) {
      if (!matches(rel)) continue;
      const abs = join(root, rel);
      if (isForbidden(abs) !== null) continue;
      let mtime = 0;
      try {
        mtime = statSync(abs).mtimeMs;
      } catch {}
      // Paths as the caller named the base: absolute for an absolute base, else relative to cwd.
      found.push({ path: isAbsolute(basePath) ? abs : relative(getCwd(), abs) || rel, mtime });
    }
    if (found.length === 0) return { success: true, output: NO_FILES };
    found.sort((a, b) => b.mtime - a.mtime);
    let output = found
      .slice(0, MAX_FILES)
      .map((f) => f.path)
      .join("\n");
    if (found.length > MAX_FILES) {
      output += `\n[${String(found.length - MAX_FILES)} more files not shown — narrow the pattern or path.]`;
    }
    return { success: true, output };
  },
};
