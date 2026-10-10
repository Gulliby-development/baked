import type { ComponentType } from "react";
import type { DesktopProject } from "../../shared/api.js";
import type { ProjectSection } from "../router.js";
import { InitiativesSection } from "./insights/InitiativesSection.js";
import { UsageSection } from "./insights/UsageSection.js";
import { RunsSection } from "./project/RunsSection.js";
import { GatesSection } from "./setup/GatesSection.js";
import { InstructionsSection } from "./setup/InstructionsSection.js";
import { WorkingSetSection } from "./setup/WorkingSetSection.js";

export interface SectionProps {
  project: DesktopProject;
  /** The route's item, e.g. a run or session ID; null on the section's own page. */
  id: string | null;
}

/** The view of each project section; a section without one shows a placeholder. */
export const SECTION_VIEWS: Partial<Record<ProjectSection, ComponentType<SectionProps>>> = {
  overview: RunsSection,
  runs: RunsSection,
  gates: GatesSection,
  instructions: InstructionsSection,
  "working-set": WorkingSetSection,
  initiatives: InitiativesSection,
  usage: UsageSection,
};
