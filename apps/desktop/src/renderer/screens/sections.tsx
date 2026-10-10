import type { ComponentType } from "react";
import type { DesktopProject } from "../../shared/api.js";
import type { ProjectSection } from "../router.js";
import { InitiativesSection } from "./insights/InitiativesSection.js";
import { UsageSection } from "./insights/UsageSection.js";
import { RunsSection } from "./project/RunsSection.js";
import { ProjectHome } from "./start/index.js";

export interface SectionProps {
  project: DesktopProject;
  /** The route's item, e.g. a run or session ID; null on the section's own page. */
  id: string | null;
}

/** The view of each project section; a section without one shows a placeholder. */
export const SECTION_VIEWS: Partial<Record<ProjectSection, ComponentType<SectionProps>>> = {
  overview: ProjectHome,
  runs: RunsSection,
  initiatives: InitiativesSection,
  usage: UsageSection,
};
