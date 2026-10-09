/**
 * Lightweight event emitter for tool execution progress.
 * Tools emit progress updates (e.g. download %, conversion stage)
 * and the UI subscribes to display live status text.
 */

export interface ToolProgressEvent {
  toolCallId: string;
  /** Short status text shown next to the spinner, e.g. "[YT-DL] Summoning the pixels… 42%" */
  text: string;
}

type ProgressListener = (event: ToolProgressEvent) => void;

const listeners = new Set<ProgressListener>();

export function emitToolProgress(event: ToolProgressEvent): void {
  for (const fn of listeners) fn(event);
}

export function onToolProgress(fn: ProgressListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
