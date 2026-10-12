import { type FSWatcher, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { join, relative, sep } from "node:path";
import { buildIgnoreMatcher, type IgnoreMatcher } from "../intelligence/ignore.js";

/** Folders never watched, whatever the ignore files say. */
const SKIPPED_DIRS = new Set([
  ".git",
  ".baked",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
]);

const POLL_FILE_LIMIT = 20_000;

export interface FileWatcherOptions {
  root: string;
  /** Extra gitignore-style patterns. */
  ignore: readonly string[];
  debounceMs: number;
  poll: boolean;
  /** Changed project-relative paths (`/` separators), once saves have settled. */
  onBatch(paths: string[]): void;
  onError?(error: Error): void;
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The project's ignore rules: `.gitignore`, `.bakedignore` and the configured patterns. */
export function watchIgnore(root: string, extra: readonly string[]): IgnoreMatcher {
  return buildIgnoreMatcher(
    readOptional(join(root, ".gitignore")),
    readOptional(join(root, ".bakedignore")),
    extra.join("\n"),
  );
}

export function isWatchedPath(rel: string, matcher: IgnoreMatcher): boolean {
  if (!rel || rel.startsWith("..")) return false;
  const parts = rel.split("/");
  if (parts.some((p) => SKIPPED_DIRS.has(p))) return false;
  for (let i = 1; i < parts.length; i++)
    if (matcher.ignores(parts.slice(0, i).join("/"), true)) return false;
  return !matcher.ignores(rel, false);
}

/**
 * Watches a project folder recursively and reports changed files in debounced batches. Uses the
 * platform's recursive file events, or polls file times when asked to or when the platform cannot
 * watch recursively (some network drives and WSL mounts).
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private changed = new Set<string>();
  private matcher: IgnoreMatcher;
  private stamps = new Map<string, string>();

  constructor(private readonly options: FileWatcherOptions) {
    this.matcher = watchIgnore(options.root, options.ignore);
  }

  /** Starts watching; returns how. */
  start(): "native" | "poll" {
    if (!this.options.poll) {
      try {
        this.watcher = watch(this.options.root, { recursive: true }, (_event, name) => {
          if (name) this.note(String(name).split(sep).join("/"));
        });
        this.watcher.on("error", (error) => this.fail(error));
        return "native";
      } catch {
        // Fall through to polling.
      }
    }
    this.stamps = this.scan();
    this.pollTimer = setInterval(
      () => {
        const next = this.scan();
        for (const [path, stamp] of next) if (this.stamps.get(path) !== stamp) this.note(path);
        for (const path of this.stamps.keys()) if (!next.has(path)) this.note(path);
        this.stamps = next;
      },
      Math.max(1000, this.options.debounceMs),
    );
    return "poll";
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.changed.clear();
  }

  private fail(error: Error): void {
    this.options.onError?.(error);
  }

  private note(rel: string): void {
    if (rel === ".gitignore" || rel === ".bakedignore")
      this.matcher = watchIgnore(this.options.root, this.options.ignore);
    if (!isWatchedPath(rel, this.matcher)) return;
    this.changed.add(rel);
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      const batch = [...this.changed].sort();
      this.changed.clear();
      if (batch.length > 0) this.options.onBatch(batch);
    }, this.options.debounceMs);
  }

  /** File stamps (mtime and size) of the watched files, for polling. */
  private scan(): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string): void => {
      if (out.size >= POLL_FILE_LIMIT) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        const rel = relative(this.options.root, abs).split(sep).join("/");
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRS.has(entry.name) && !this.matcher.ignores(rel, true)) walk(abs);
        } else if (entry.isFile() && isWatchedPath(rel, this.matcher)) {
          try {
            const st = statSync(abs);
            out.set(rel, `${st.mtimeMs}:${st.size}`);
          } catch {
            // Removed while scanning.
          }
          if (out.size >= POLL_FILE_LIMIT) return;
        }
      }
    };
    walk(this.options.root);
    return out;
  }
}
