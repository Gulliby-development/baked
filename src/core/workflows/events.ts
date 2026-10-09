import type { WorkflowEvent } from "./schemas.js";
import type { WorkflowStore } from "./store.js";

export async function* replayEvents(
  store: WorkflowStore,
  runId: string,
  afterSeq: number,
  signal: AbortSignal,
): AsyncIterable<WorkflowEvent> {
  let seq = afterSeq;
  while (!signal.aborted) {
    const page = store.events(runId, seq);
    for (const event of page) {
      seq = event.seq;
      yield event;
    }
    if (page.length === 0) {
      if (
        ["completed", "failed", "cancelled", "waiting", "paused", "blocked"].includes(
          store.run(runId).status,
        )
      )
        return;
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
