import type { ComponentType } from "react";
import type { DesktopProject } from "../../shared/api.js";
import type { ProjectSection } from "../router.js";
import { ChatSection } from "./chat/ChatSection.js";
import { CoordinatorSection } from "./coordinator/CoordinatorSection.js";
import { GitSection } from "./git/GitSection.js";
import { GraphSection } from "./graph/GraphSection.js";
import { InitiativesSection } from "./insights/InitiativesSection.js";
import { UsageSection } from "./insights/UsageSection.js";
import { RunsView } from "./runs/RunsView.js";
import { ArtifactsSection } from "./setup/ArtifactsSection.js";
import { ChatMemorySection } from "./setup/ChatMemorySection.js";
import { DiagnosticsSection } from "./setup/DiagnosticsSection.js";
import { GatesSection } from "./setup/GatesSection.js";
import { HooksSection } from "./setup/HooksSection.js";
import { InstructionsSection } from "./setup/InstructionsSection.js";
import { LspSection } from "./setup/LspSection.js";
import { McpSection } from "./setup/McpSection.js";
import { PackagesSection } from "./setup/PackagesSection.js";
import { RunMemorySection } from "./setup/RunMemorySection.js";
import { SkillsSection } from "./setup/SkillsSection.js";
import { WorkflowsSection } from "./setup/WorkflowsSection.js";
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
  coordinator: CoordinatorSection,
  runs: RunsView,
  gates: GatesSection,
  workflows: WorkflowsSection,
  instructions: InstructionsSection,
  "working-set": WorkingSetSection,
  "run-memory": RunMemorySection,
  "chat-memory": ChatMemorySection,
  skills: SkillsSection,
  packages: PackagesSection,
  hooks: HooksSection,
  mcp: McpSection,
  lsp: LspSection,
  initiatives: InitiativesSection,
  usage: UsageSection,
  graph: GraphSection,
  git: GitSection,
  artifacts: ArtifactsSection,
  diagnostics: DiagnosticsSection,
};
