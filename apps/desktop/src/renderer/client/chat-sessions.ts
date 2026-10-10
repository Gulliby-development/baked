import { useEffect, useState, useSyncExternalStore } from "react";
import { chat, type SessionSummary } from "./chat.js";

/**
 * The recent chat sessions of a project for the sidebar. The project list's session count is read
 * from disk when the list refreshes, so it misses sessions created since; this asks the running
 * backend, which also knows sessions that are not saved yet, and asks again after a change.
 */

let version = 0;
const listeners = new Set<() => void>();

/** Tells every list to reload, e.g. after a session was created or finished a turn. */
export function chatSessionsChanged(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function useVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}

/** Null until loaded, and when the backend is not running or has no chat API. */
export function useChatSessions(
  key: string,
  running: boolean,
  limit: number,
): SessionSummary[] | null {
  const current = useVersion();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: current reloads after a change
  useEffect(() => {
    if (!running) {
      setSessions(null);
      return;
    }
    let live = true;
    chat.list(key, limit).then(
      (list) => live && setSessions(list.sessions),
      () => live && setSessions(null),
    );
    return () => {
      live = false;
    };
  }, [key, running, limit, current]);
  return sessions;
}
