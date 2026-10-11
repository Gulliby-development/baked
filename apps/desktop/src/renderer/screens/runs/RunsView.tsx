import type { SectionProps } from "../sections.js";
import { RunScreen } from "./RunScreen.js";
import { RunsList } from "./RunsList.js";

/** Route IDs under `runs` that other screens own (new run, quick task). */
const OTHER_SCREENS = new Set(["new", "new-quick"]);

/** `#/p/KEY/runs` lists runs; `#/p/KEY/runs/RUN_ID` shows one. */
export function RunsView({ project, id }: SectionProps) {
  if (id === null) return <RunsList project={project} />;
  if (OTHER_SCREENS.has(id)) return null;
  return <RunScreen projectKey={project.key} runId={id} />;
}
