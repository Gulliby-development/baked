import type { WorkflowEvent } from "./schemas.js";
import type { WorkflowStore } from "./store.js";
import { transientSqliteError } from "./transient-sqlite.js";

export async function* replayEvents(
  store: WorkflowStore,
  runId: string,
  afterSeq: number,
  signal: AbortSignal,
): AsyncIterable<WorkflowEvent> {
  let seq = afterSeq;
  while (!signal.aborted) {
    let page: WorkflowEvent[] = [];
    let ended = false;
    try {
      page = store.events(runId, seq);
      ended =
        page.length === 0 &&
        ["completed", "failed", "cancelled", "waiting", "paused", "blocked"].includes(
          store.run(runId).status,
        );
    } catch (error) {
      // After the host slept the first read may fail; the next poll reads again (#1410).
      if (!transientSqliteError(error)) throw error;
    }
    for (const event of page) {
      seq = event.seq;
      yield event;
    }
    if (page.length === 0) {
      if (ended) return;
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 100);
        signal.addEventListener("abort", finish, { once: true });
      });
    }
  }
}
