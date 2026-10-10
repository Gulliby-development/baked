import type { ComponentType } from "react";
import type { SectionProps } from "../sections.js";
import { NewRunScreen } from "./NewRunScreen.js";
import { QuickTaskScreen } from "./QuickTaskScreen.js";

export { NewRunScreen } from "./NewRunScreen.js";
export { ProjectHome } from "./ProjectHome.js";
export { QuickTaskScreen } from "./QuickTaskScreen.js";

/**
 * Views of `section/id` routes that the section's own view does not own: the run start forms
 * live under `runs/` next to the run screens. ProjectScreen looks here before SECTION_VIEWS.
 */
export const START_ROUTES: Record<string, ComponentType<SectionProps>> = {
  "runs/new": NewRunScreen,
  "runs/new-quick": QuickTaskScreen,
};
