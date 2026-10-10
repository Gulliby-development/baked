import type { DesktopProject } from "../../shared/api.js";
import { backendLabel } from "../format.js";
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
  gates: "Gates and checks",
  instructions: "Instructions",
  "working-set": "Working set",
};

function Closed({ project }: { project: DesktopProject }) {
  const { open, restart } = useDesktop();
  const failed = project.backend.kind === "failed";
  return (
    <div className="banner" style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{ flex: 1 }}>
        {failed
          ? `The backend of ${project.name} stopped: ${project.backend.kind === "failed" ? project.backend.lastError : ""}`
          : project.exists
            ? `${project.name} is closed. Opening it starts its backend.`
            : `${project.path} no longer exists.`}
      </span>
      {project.exists && (
        <button
          type="button"
          className="btn-primary"
          onClick={() => void (failed ? restart(project.key) : open(project.key))}
        >
          {failed ? "Restart" : "Open project"}
        </button>
      )}
    </div>
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
      <div className="page">
        <div className="empty">This project is not in the list.</div>
      </div>
    );
  const backend = backendLabel(project.backend);
  return (
    <div className="page">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12 }}>
        <h1>{section === "overview" ? project.name : TITLES[section]}</h1>
        <span className="sub-line">{project.path}</span>
        <span className="status-line" style={{ marginLeft: "auto", padding: 0 }}>
          <span className={`dot ${backend.tone}`} />
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
        <div className="empty">{TITLES[section]} comes in the next desktop pull requests.</div>
      )}
    </div>
  );
}
