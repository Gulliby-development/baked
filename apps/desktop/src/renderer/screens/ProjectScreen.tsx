import type { DesktopProject } from "../../shared/api.js";
import { Alert } from "../components/ui/alert.js";
import { Busy } from "../components/ui/busy.js";
import { Button } from "../components/ui/button.js";
import { Dot } from "../components/ui/dot.js";
import { Empty } from "../components/ui/empty.js";
import { backendLabel } from "../format.js";
import { PAGE, SUB_LINE } from "../lib/styles.js";
import type { ProjectSection } from "../router.js";
import { useDesktop, useProject } from "../store.js";
import { SECTION_VIEWS } from "./sections.js";
import { START_ROUTES } from "./start/index.js";

const TITLES: Record<ProjectSection, string> = {
  overview: "Overview",
  chat: "Chat",
  coordinator: "Coordinator",
  runs: "Runs",
  initiatives: "Initiatives",
  usage: "Usage",
  graph: "Code graph",
  git: "Git",
  artifacts: "Artifacts",
  gates: "Gates and checks",
  workflows: "Workflows",
  context: "Agent context",
  "run-memory": "Run memory",
  "chat-memory": "Chat memory",
  skills: "Skills",
  packages: "Packages",
  hooks: "Hooks",
  mcp: "MCP servers",
  lsp: "Language servers",
  diagnostics: "Diagnostics",
};

function Closed({ project }: { project: DesktopProject }) {
  const { open, restart } = useDesktop();
  const failed = project.backend.kind === "failed";
  return (
    <Alert className="flex items-center gap-3">
      <span className="flex-1">
        {failed
          ? `The backend of ${project.name} stopped: ${project.backend.kind === "failed" ? project.backend.lastError : ""}`
          : project.exists
            ? `${project.name} is closed. Opening it starts its backend.`
            : `${project.path} no longer exists.`}
      </span>
      {project.exists && (
        <Button
          variant="primary"
          size="md"
          onClick={() => void (failed ? restart(project.key) : open(project.key))}
        >
          {failed ? "Restart" : "Open project"}
        </Button>
      )}
    </Alert>
  );
}

export function ProjectScreen({
  projectKey,
  section,
  id,
}: {
  projectKey: string;
  section: ProjectSection;
  id: string | null;
}) {
  const project = useProject(projectKey);
  const View = START_ROUTES[`${section}/${id}`] ?? SECTION_VIEWS[section];
  if (!project)
    return (
      <div className={PAGE}>
        <Empty>This project is not in the list.</Empty>
      </div>
    );
  const backend = backendLabel(project.backend);
  const starting = project.backend.kind === "starting" || project.backend.kind === "restarting";
  // Chat and the coordinator draw their own header and fill the window.
  if (
    (section === "chat" || section === "coordinator") &&
    View &&
    project.backend.kind === "running"
  )
    return <View project={project} id={id} />;
  return (
    <div className={PAGE}>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1>{section === "overview" ? project.name : TITLES[section]}</h1>
        <span className={SUB_LINE}>{project.path}</span>
        <span className="ml-auto flex items-center gap-2 text-[12px] text-dim-foreground">
          <Dot tone={backend.tone} />
          {backend.text}
        </span>
      </div>
      {starting ? (
        <Busy
          label={
            project.backend.kind === "restarting"
              ? "Restarting BAKED for this project…"
              : "Starting BAKED for this project…"
          }
          detail="Its backend opens the project; language servers and the code index follow in the background."
        />
      ) : project.backend.kind !== "running" ? (
        <Closed project={project} />
      ) : View ? (
        <View project={project} id={id} />
      ) : (
        <Empty>{TITLES[section]} comes in the next desktop pull requests.</Empty>
      )}
    </div>
  );
}
