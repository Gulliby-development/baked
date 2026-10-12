/**
 * Long-running work in this process that a person waits on: opening the project, indexing the
 * code graph, starting a workflow run. Producers report into the process-wide `progress`
 * tracker; front ends read it (`GET /v1/progress` in `baked serve`, stderr lines in headless
 * runs). `done` and `total` are set only while the work has a countable unit, such as files.
 */

export type ProgressTask = "open" | "index" | "run-start";

export interface ProgressItem {
  /** Stable while the work lasts; equals `task` for work that runs once per process. */
  id: string;
  task: ProgressTask;
  label: string;
  done: number | null;
  total: number | null;
  /** ISO time the work began. */
  startedAt: string;
}

type Listener = (items: ProgressItem[]) => void;

export class ProgressTracker {
  private readonly items = new Map<string, ProgressItem>();
  private readonly listeners = new Set<Listener>();

  /** Starts or updates an item; counts are cleared unless given. */
  set(
    task: ProgressTask,
    label: string,
    counts: { done: number; total: number } | null = null,
    id: string = task,
  ): void {
    const previous = this.items.get(id);
    const next: ProgressItem = {
      id,
      task,
      label,
      done: counts?.done ?? null,
      total: counts?.total ?? null,
      startedAt: previous?.startedAt ?? new Date().toISOString(),
    };
    if (
      previous &&
      previous.label === next.label &&
      previous.done === next.done &&
      previous.total === next.total
    )
      return;
    this.items.set(id, next);
    this.emit();
  }

  end(id: string): void {
    if (this.items.delete(id)) this.emit();
  }

  /** Runs `work` as one item that ends when it settles. */
  async track<T>(task: ProgressTask, label: string, work: () => Promise<T>, id?: string) {
    const key = id ?? `${task}-${crypto.randomUUID()}`;
    this.set(task, label, null, key);
    try {
      return await work();
    } finally {
      this.end(key);
    }
  }

  list(): ProgressItem[] {
    return [...this.items.values()];
  }

  /** Calls `listener` with the whole list after every change; returns the unsubscribe. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const items = this.list();
    for (const listener of this.listeners) {
      try {
        listener(items);
      } catch {
        // A failing reader must not break the work that reports.
      }
    }
  }
}

export const progress = new ProgressTracker();

const INDEX_PHASES: Record<number, string> = {
  [-1]: "Resolving references",
  [-2]: "Building the call graph",
  [-3]: "Building edges",
  [-4]: "Linking tests",
  [-5]: "Analyzing git history",
};

/**
 * Translates `RepoMap.onProgress(indexed, total)`: a count while files are parsed, and negative
 * sentinels for the phases after it, which have no count.
 */
export function indexProgress(
  indexed: number,
  total: number,
): { label: string; counts: { done: number; total: number } | null } {
  if (indexed < 0) return { label: INDEX_PHASES[indexed] ?? "Indexing the project", counts: null };
  return { label: "Indexing files", counts: { done: indexed, total } };
}

/** One line for a terminal: `Indexing files 412/1,380`. */
export function progressLine(item: ProgressItem): string {
  if (item.done === null || item.total === null) return item.label;
  return `${item.label} ${item.done.toLocaleString("en-US")}/${item.total.toLocaleString("en-US")}`;
}
