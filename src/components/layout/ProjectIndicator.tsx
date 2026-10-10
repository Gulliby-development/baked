import { useEffect } from "react";
import { icon } from "../../core/icons.js";
import { projectName, waitingBadgeText, waitingElsewhere } from "../../core/projects/switcher.js";
import { useTheme } from "../../core/theme/index.js";
import { useStatusBarStore } from "../../stores/statusbar.js";

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** How often the header re-reads what waits in other projects. */
const REFRESH_MS = 60_000;

/** Reads the project name and the waiting count of other projects off the render path. */
function useProjectStatus(cwd: string): void {
  useEffect(() => {
    let disposed = false;
    let busy = false;
    const refresh = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const name = projectName(cwd);
        const waiting = await waitingElsewhere(cwd);
        if (!disposed) useStatusBarStore.getState().setProject(name, waiting);
      } catch {
        // The header shows what it already has.
      } finally {
        busy = false;
      }
    };
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      disposed = true;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [cwd]);
}

/** Header segment: the project name, and a badge when something waits in another project. */
export function ProjectIndicator({ cwd, compact }: { cwd: string; compact: boolean }) {
  const t = useTheme();
  useProjectStatus(cwd);
  const name = useStatusBarStore((s) => s.projectName);
  const waiting = useStatusBarStore((s) => s.waitingElsewhere);
  if (!name) return null;
  const badge = waitingBadgeText(waiting);
  return (
    <>
      <text fg={t.textFaint}>│</text>
      <text truncate>
        <span fg={t.textSecondary}>{`${icon("folder")} ${truncate(name, compact ? 16 : 28)}`}</span>
        {badge ? (
          <span fg={t.warning}>{compact ? ` ⚑ ${waiting.waiting}` : ` ⚑ ${badge}`}</span>
        ) : null}
      </text>
    </>
  );
}
