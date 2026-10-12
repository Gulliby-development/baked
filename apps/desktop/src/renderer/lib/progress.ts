import { useEffect, useState } from "react";
import { ApiError } from "../client/api.js";
import { type ProgressItem, type ProgressTask, progressApi } from "../client/progress.js";

const POLL_MS = 500;

/**
 * The backend's work of the given tasks, polled while `active` (a screen that is waiting). An
 * older backend without the endpoint answers 404 and the list stays empty.
 */
export function useProgress(
  key: string,
  tasks: readonly ProgressTask[],
  active = true,
): ProgressItem[] {
  const [items, setItems] = useState<ProgressItem[]>([]);
  const wanted = tasks.join(",");
  useEffect(() => {
    if (!active) {
      setItems([]);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (): void => {
      progressApi.list(key).then(
        ({ items: all }) => {
          if (!live) return;
          setItems(all.filter((item) => wanted.split(",").includes(item.task)));
          timer = setTimeout(poll, POLL_MS);
        },
        (error: unknown) => {
          if (!live || (error instanceof ApiError && error.status === 404)) return;
          timer = setTimeout(poll, POLL_MS * 4);
        },
      );
    };
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, wanted, active]);
  return items;
}
