import { useEffect, useState } from "react";

export const PROJECT_SECTIONS = [
  "overview",
  "chat",
  "runs",
  "initiatives",
  "acceptance",
  "usage",
  "graph",
  "gates",
  "instructions",
  "working-set",
  "run-memory",
  "skills",
] as const;
export type ProjectSection = (typeof PROJECT_SECTIONS)[number];

export type SettingsSection = "app" | "global";

export type Route =
  | { name: "projects" }
  | { name: "attention"; key?: string; id?: string }
  | { name: "project"; key: string; section: ProjectSection; id: string | null }
  | { name: "settings"; section: SettingsSection };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [head, a, b, c] = parts;
  if (head === "attention")
    return a && b ? { name: "attention", key: a, id: b } : { name: "attention" };
  if (head === "settings") return { name: "settings", section: a === "global" ? "global" : "app" };
  if (head === "p" && a) {
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
      return `#/settings/${route.section}`;
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
