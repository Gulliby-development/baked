import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isBinaryFileSync } from "isbinaryfile";
import { onFileEdited } from "../tools/file-events.js";
import type { WatchOptions } from "./config.js";
import type { MarkerKind } from "./markers.js";
import { buildWatchPrompt, triggerLabel } from "./prompt.js";
import { type FileMarker, kindOf, MarkerTracker } from "./trigger.js";
import { FileWatcher } from "./watcher.js";

const MAX_FILE_BYTES = 1024 * 1024;

export interface WatchTurn {
  /** The user turn to send. */
  prompt: string;
  /** "src/x.ts:42 (baked!)", for showing where the turn came from. */
  label: string;
  kind: Extract<MarkerKind, "act" | "ask">;
  requests: FileMarker[];
}

export type WatchEvent =
  | { type: "started"; root: string; method: "native" | "poll" }
  | { type: "stopped"; reason: string }
  | { type: "triggered"; label: string; kind: "act" | "ask"; files: string[] }
  | { type: "error"; message: string };

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A file's text when it is a readable text file of reasonable size; null otherwise. */
export function readWatchedFile(abs: string): string | null {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const data = readFileSync(abs);
    if (isBinaryFileSync(data)) return null;
    return data.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Watch mode: watches the project, and when a save adds a `baked!` or `baked?` comment, hands a
 * user turn to `send`. The caller sends it through its normal chat path, which queues it behind a
 * running turn, so approvals, checkpoints and undo apply unchanged. Files BAKED itself writes never
 * trigger a turn: their content hash is recorded when the edit tools report the write.
 */
export class WatchController {
  private watcher: FileWatcher | null = null;
  private tracker: MarkerTracker;
  private selfWrites = new Map<string, string>();
  private offEdits: (() => void) | null = null;
  private readonly root: string;

  constructor(
    root: string,
    private readonly options: WatchOptions,
    private readonly handlers: {
      send(turn: WatchTurn): void;
      onEvent?(event: WatchEvent): void;
    },
  ) {
    this.root = resolve(root);
    this.tracker = new MarkerTracker(options.marker);
  }

  get running(): boolean {
    return this.watcher !== null;
  }

  start(): void {
    if (this.watcher) return;
    this.offEdits = onFileEdited((abs, content) => {
      const rel = this.relative(abs);
      if (rel) this.selfWrites.set(rel, hash(content));
    });
    this.watcher = new FileWatcher({
      root: this.root,
      ignore: this.options.ignore,
      debounceMs: this.options.debounceMs,
      poll: this.options.poll,
      onBatch: (paths) => this.batch(paths),
      onError: (error) => this.emit({ type: "error", message: error.message }),
    });
    const method = this.watcher.start();
    this.emit({ type: "started", root: this.root, method });
  }

  stop(reason = "stopped"): void {
    if (!this.watcher) return;
    this.watcher.stop();
    this.watcher = null;
    this.offEdits?.();
    this.offEdits = null;
    this.selfWrites.clear();
    this.emit({ type: "stopped", reason });
  }

  /** Handles one debounced batch of changed files; public for tests. */
  batch(paths: readonly string[]): void {
    const files: { path: string; text: string | null }[] = [];
    for (const path of paths) {
      const text = readWatchedFile(join(this.root, path));
      const own = this.selfWrites.get(path);
      if (own !== undefined && text !== null && own === hash(text)) {
        this.selfWrites.delete(path);
        this.tracker.remember(path, text);
        continue;
      }
      files.push({ path, text });
    }
    const trigger = this.tracker.update(files);
    if (!trigger) return;
    const texts = new Map(files.map((f) => [f.path, f.text]));
    const prompt = buildWatchPrompt(
      trigger,
      (path) => texts.get(path) ?? readWatchedFile(join(this.root, path)),
      { marker: this.options.marker, removeAnswered: this.options.removeAnswered },
    );
    const kind = kindOf(trigger) === "act" ? "act" : "ask";
    const label = triggerLabel(trigger, this.options.marker);
    this.emit({
      type: "triggered",
      label,
      kind,
      files: [...new Set(trigger.requests.map((r) => r.path))],
    });
    this.handlers.send({ prompt, label, kind, requests: trigger.requests });
  }

  private relative(abs: string): string | null {
    const rel = relative(this.root, resolve(abs));
    if (!rel || rel.startsWith("..")) return null;
    return rel.split(sep).join("/");
  }

  private emit(event: WatchEvent): void {
    this.handlers.onEvent?.(event);
  }
}
