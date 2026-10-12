import { useEffect, useState } from "react";

export const PROJECT_SECTIONS = [
  "overview",
  "chat",
  "runs",
  "initiatives",
  "usage",
  "graph",
  "git",
  "gates",
  "instructions",
  "working-set",
  "run-memory",
  "chat-memory",
  "skills",
  "hooks",
  "mcp",
  "diagnostics",
] as const;
export type ProjectSection = (typeof PROJECT_SECTIONS)[number];

/**
 * Settings pages: this app's own, the chat settings (one page per page of the backend's settings
 * schema, named by `page`), then one page per part of `~/.baked/config.json`.
 */
export const SETTINGS_SECTIONS = [
  "app",
  "chat",
  "providers",
  "routing",
  "commands",
  "notifications",
  "telemetry",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

function settingsSection(name: string | undefined): SettingsSection {
  // `global` was the single All projects page before it split into one page per part.
  if (name === "global") return "providers";
  return (SETTINGS_SECTIONS as readonly string[]).includes(name ?? "")
    ? (name as SettingsSection)
    : "app";
}

export type Route =
  | { name: "projects" }
  | { name: "attention"; key?: string; id?: string }
  | { name: "project"; key: string; section: ProjectSection; id: string | null }
  | { name: "settings"; section: SettingsSection; page?: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [head, a, b, c] = parts;
  if (head === "attention")
    return a && b ? { name: "attention", key: a, id: b } : { name: "attention" };
  if (head === "settings") {
    const section = settingsSection(a);
    return section === "chat" && b
      ? { name: "settings", section, page: b }
      : { name: "settings", section };
  }
  if (head === "p" && a) {
    // Acceptance was a sidebar section before it moved into the run screen and Needs you.
    if (b === "acceptance") return { name: "project", key: a, section: "runs", id: c ?? null };
    const section = (PROJECT_SECTIONS as readonly string[]).includes(b ?? "")
      ? (b as ProjectSection)
      : "overview";
    return { name: "project", key: a, section, id: c ?? null };
  }
  return { name: "projects" };
}

export function href(route: Route): string {
  switch (route.name) {
    case "projects":
      return "#/projects";
    case "attention":
      return route.key && route.id
        ? `#/attention/${encodeURIComponent(route.key)}/${encodeURIComponent(route.id)}`
        : "#/attention";
    case "settings":
      return `#/settings/${route.section}${route.page ? `/${encodeURIComponent(route.page)}` : ""}`;
    case "project":
      return `#/p/${encodeURIComponent(route.key)}/${route.section}${route.id ? `/${encodeURIComponent(route.id)}` : ""}`;
  }
}

export function projectHref(
  key: string,
  section: ProjectSection = "overview",
  id?: string,
): string {
  return href({ name: "project", key, section, id: id ?? null });
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const update = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}
