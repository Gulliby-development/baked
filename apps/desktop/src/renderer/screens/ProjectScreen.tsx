import type { DesktopProject } from "../../shared/api.js";
import { Alert } from "../components/ui/alert.js";
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
  runs: "Runs",
  initiatives: "Initiatives",
  acceptance: "Acceptance",
  usage: "Usage",
  graph: "Code graph",
  gates: "Gates and checks",
  instructions: "Instructions",
  "working-set": "Working set",
  "run-memory": "Run memory",
  skills: "Skills",
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
  const live = ["running", "starting", "restarting"].includes(project.backend.kind);
  // Chat draws its own header and fills the window.
  if (section === "chat" && View && live) return <View project={project} id={id} />;
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
      {project.backend.kind !== "running" &&
      project.backend.kind !== "starting" &&
      project.backend.kind !== "restarting" ? (
        <Closed project={project} />
      ) : View ? (
        <View project={project} id={id} />
      ) : (
        <Empty>{TITLES[section]} comes in the next desktop pull requests.</Empty>
      )}
    </div>
  );
}
