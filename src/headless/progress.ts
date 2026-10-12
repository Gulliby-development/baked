import {
  type ProgressItem,
  type ProgressTracker,
  progress,
  progressLine,
} from "../core/progress.js";

/** Counts repeat at most this often per item, so a log gets a line every few seconds. */
const COUNT_INTERVAL_MS = 2000;

/**
 * Writes long-running work (indexing, opening the project, starting a run) as one line per
 * change: a new label at once, a new count of the same label at most every two seconds.
 * Returns the function that stops following.
 */
export function followProgress(
  write: (line: string) => void,
  tracker: ProgressTracker = progress,
  now: () => number = Date.now,
): () => void {
  const printed = new Map<string, { label: string; line: string; at: number }>();
  const print = (item: ProgressItem): void => {
    const line = progressLine(item);
    const last = printed.get(item.id);
    if (last?.line === line) return;
    if (last && last.label === item.label && now() - last.at < COUNT_INTERVAL_MS) return;
    printed.set(item.id, { label: item.label, line, at: now() });
    write(line);
  };
  const unsubscribe = tracker.subscribe((items) => {
    const live = new Set(items.map((item) => item.id));
    for (const id of printed.keys()) if (!live.has(id)) printed.delete(id);
    for (const item of items) print(item);
  });
  for (const item of tracker.list()) print(item);
  return unsubscribe;
}
