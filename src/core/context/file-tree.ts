import { readdirSync } from "node:fs";
import { join } from "node:path";

export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "target",
  "__pycache__",
  ".cache",
  ".baked",
  "coverage",
]);

export function walkDir(dir: string, prefix: string, depth: number, lines: string[]): void {
  if (depth <= 0) return;

  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => !IGNORED_DIRS.has(e.name) && !e.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of entries) {
      const isLast = entry === entries[entries.length - 1];
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      lines.push(`${prefix}${connector}${entry.name}${entry.isDirectory() ? "/" : ""}`);

      if (entry.isDirectory()) {
        walkDir(join(dir, entry.name), prefix + childPrefix, depth - 1, lines);
      }
    }
  } catch {
    // Skip unreadable directories
  }
}
