import type { BackendState, DesktopProject } from "../shared/api.js";

export function ago(at: number | null, now = Date.now()): string {
  if (at === null) return "never";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(count);
}

export function usd(value: number | null): string {
  return value === null ? "–" : `$${value.toFixed(2)}`;
}

export function initial(name: string): string {
  return (name.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
}

/** One short line about a project for the sidebar and cards. */
export function projectLine(project: DesktopProject): string {
  const { overview } = project;
  if (!project.exists) return "folder missing";
  if (overview.attention > 0) return `${overview.attention} need you`;
  if (overview.activeRuns > 0)
    return `${overview.activeRuns} run${overview.activeRuns === 1 ? "" : "s"} active`;
  return `idle, ${ago(overview.lastSessionAt ?? project.lastOpenedAt)}`;
}

export function backendLabel(state: BackendState): {
  text: string;
  tone: "ok" | "warn" | "err" | "busy" | "";
} {
  switch (state.kind) {
    case "running":
      return { text: `running · ${state.version}`, tone: "ok" };
    case "starting":
      return { text: "starting", tone: "busy" };
    case "restarting":
      return { text: `restarting (try ${state.attempt})`, tone: "warn" };
    case "failed":
      return { text: "backend stopped", tone: "err" };
    case "stopped":
      return { text: "closed", tone: "" };
  }
}
