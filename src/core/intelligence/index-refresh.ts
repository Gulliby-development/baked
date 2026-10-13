import { existsSync, type FSWatcher, statSync, watch } from "node:fs";
import { join } from "node:path";
import { FileWatcher } from "../watch/watcher.js";

/** The part of a project root the refresher drives. */
export interface RefreshableIndex {
  updateRepoMapInBackground(): Promise<void>;
}

export interface IndexRefresherOptions {
  workspace: string;
  /** The project root; called lazily, so the first call may open the project. */
  root(): Promise<RefreshableIndex>;
  /** Wait after `start` before opening the root, so startup work goes first. 0 opens at once. */
  startDelayMs?: number;
  /** Quiet time after the last change before an update. */
  debounceMs?: number;
  /** Shortest time between the starts of two updates. */
  minIntervalMs?: number;
  /** Watch the project's files and git HEAD. Off leaves only explicit `request` calls. */
  watch?: boolean;
  onError?(error: unknown): void;
}

/** Git files that change on checkout, pull, merge, reset and commit. */
const GIT_FILES = new Set(["HEAD", "ORIG_HEAD"]);

/**
 * Keeps the repository index current in the background so the code graph and the Baked map
 * are ready when opened. Updates are incremental (unchanged files are skipped), run in the
 * intelligence worker, coalesce while one is running and are throttled, so they never wait on
 * or hold up chats and runs.
 */
export class IndexRefresher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private wanted = false;
  private lastStart = Number.NEGATIVE_INFINITY;
  private stopped = false;
  private opened = false;
  private files: FileWatcher | null = null;
  private git: FSWatcher[] = [];
  private readonly debounceMs: number;
  private readonly minIntervalMs: number;

  constructor(private readonly options: IndexRefresherOptions) {
    this.debounceMs = options.debounceMs ?? 1500;
    this.minIntervalMs = options.minIntervalMs ?? 10_000;
  }

  /** Opens the root after the start delay and starts watching. */
  start(): void {
    const open = (): void => {
      if (this.stopped) return;
      this.opened = true;
      // Opening the root runs its first incremental scan.
      this.options.root().then(
        () => {
          if (this.wanted) this.schedule();
        },
        (error: unknown) => this.options.onError?.(error),
      );
      if (this.options.watch !== false) this.watch();
    };
    const delay = this.options.startDelayMs ?? 0;
    if (delay <= 0) open();
    else this.arm(open, delay);
  }

  /** Asks for an update, for example after a chat turn or a run that may have edited files. */
  request(): void {
    if (this.stopped) return;
    this.wanted = true;
    if (this.opened) this.schedule();
  }

  /** True while an update requested here runs. */
  get busy(): boolean {
    return this.running !== null;
  }

  /** Stops watching; resolves once an update in flight has ended. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.files?.stop();
    this.files = null;
    for (const w of this.git) w.close();
    this.git = [];
    await this.running?.catch(() => {});
  }

  private arm(run: () => void, ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      run();
    }, ms);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private schedule(): void {
    if (this.stopped || this.timer || this.running || !this.wanted) return;
    const wait = Math.max(this.debounceMs, this.lastStart + this.minIntervalMs - Date.now());
    this.arm(() => this.run(), wait);
  }

  private run(): void {
    if (this.stopped || !this.wanted) return;
    this.wanted = false;
    this.lastStart = Date.now();
    this.running = this.options
      .root()
      .then((root) => root.updateRepoMapInBackground())
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => {
        this.running = null;
        this.schedule();
      });
  }

  private watch(): void {
    const { workspace } = this.options;
    const files = new FileWatcher({
      root: workspace,
      ignore: [],
      debounceMs: this.debounceMs,
      poll: false,
      onBatch: () => this.request(),
      onError: (error) => this.options.onError?.(error),
    });
    // Polling walks the whole tree; in the background that costs more than it saves, so a
    // folder the platform cannot watch keeps only the turn, run and git triggers.
    if (files.start() === "poll") files.stop();
    else this.files = files;
    const gitDir = join(workspace, ".git");
    for (const [dir, names] of [
      [gitDir, GIT_FILES],
      [join(gitDir, "logs"), new Set(["HEAD"])],
    ] as const) {
      try {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
        const w = watch(dir, (_event, name) => {
          if (name && names.has(String(name))) this.request();
        });
        w.on("error", (error) => this.options.onError?.(error));
        this.git.push(w);
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }
}
