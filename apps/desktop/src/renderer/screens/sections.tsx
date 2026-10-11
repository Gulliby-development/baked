import type { ComponentType } from "react";
import type { DesktopProject } from "../../shared/api.js";
import type { ProjectSection } from "../router.js";
import { ChatSection } from "./chat/ChatSection.js";
import { GraphSection } from "./graph/GraphSection.js";
import { InitiativesSection } from "./insights/InitiativesSection.js";
import { UsageSection } from "./insights/UsageSection.js";
import { AcceptanceSection } from "./runs/AcceptanceSection.js";
import { RunsView } from "./runs/RunsView.js";
import { GatesSection } from "./setup/GatesSection.js";
import { InstructionsSection } from "./setup/InstructionsSection.js";
import { McpSection } from "./setup/McpSection.js";
import { RunMemorySection } from "./setup/RunMemorySection.js";
import { SkillsSection } from "./setup/SkillsSection.js";
import { WorkingSetSection } from "./setup/WorkingSetSection.js";
import { ProjectHome } from "./start/index.js";

export interface SectionProps {
  project: DesktopProject;
  /** The route's item, e.g. a run or session ID; null on the section's own page. */
  id: string | null;
}

/** The view of each project section; a section without one shows a placeholder. */
export const SECTION_VIEWS: Partial<Record<ProjectSection, ComponentType<SectionProps>>> = {
  overview: ProjectHome,
  chat: ChatSection,
  runs: RunsView,
  gates: GatesSection,
  instructions: InstructionsSection,
  "working-set": WorkingSetSection,
  "run-memory": RunMemorySection,
  skills: SkillsSection,
  mcp: McpSection,
  initiatives: InitiativesSection,
  acceptance: AcceptanceSection,
  usage: UsageSection,
  graph: GraphSection,
};
