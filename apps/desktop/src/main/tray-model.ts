import type { AttentionItem, DesktopProject } from "../shared/api.js";
import { blockingCount } from "../shared/attention.js";

/**
 * What closing the window does: with "keep running in tray" on and a run still working in an
 * open project, the window hides and the app stays in the tray; otherwise it closes as usual.
 */
export function closeAction(options: {
  quitting: boolean;
  keepRunningInTray: boolean;
  projects: DesktopProject[];
}): "hide" | "close" {
  if (options.quitting || !options.keepRunningInTray) return "close";
  return options.projects.some((p) => p.open && p.overview.activeRuns > 0) ? "hide" : "close";
}

export interface TrayModel {
  tooltip: string;
  /** The "N need you" menu entry; null when nothing blocks. */
  needYou: string | null;
  /** The dock or taskbar badge: the number of blocking items. */
  badge: number;
}

export function trayModel(items: AttentionItem[]): TrayModel {
  const blocking = blockingCount(items);
  return {
    tooltip: blocking ? `BAKED: ${blocking} need you` : "BAKED",
    needYou: blocking ? `${blocking} need you` : null,
    badge: blocking,
  };
}
