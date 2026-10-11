import { useEffect, useMemo, useState } from "react";
import { editedFiles, type SessionDiffStats, sessionDiffStats } from "../core/chat/diff-stats.js";
import type { ChatMessage } from "../types/index.js";

/**
 * Lines the files a tab's session edited add and remove against HEAD. Measured when a turn ends,
 * when the set of edited files changes and when the tab becomes visible again (the user may have
 * committed meanwhile), never while the agent is still writing.
 */
export function useSessionDiffStats(
  messages: ChatMessage[],
  cwd: string,
  isLoading: boolean,
  visible: boolean,
): SessionDiffStats | null {
  const files = useMemo(() => editedFiles(messages), [messages]);
  const key = files.join("\0");
  const [stats, setStats] = useState<SessionDiffStats | null>(null);

  useEffect(() => {
    if (isLoading || !visible) return;
    const paths = key ? key.split("\0") : [];
    if (paths.length === 0) {
      setStats(null);
      return;
    }
    let cancelled = false;
    sessionDiffStats(cwd, paths)
      .then((next) => {
        if (!cancelled) setStats(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key, cwd, isLoading, visible]);

  return stats;
}
