import { useEffect, useState } from "react";
import type { DesktopProject, RunSnapshot } from "../../shared/api.js";
import { api } from "../client/api.js";
import { backendLabel, tokens, usd } from "../format.js";
import type { ProjectSection } from "../router.js";
import { useDesktop, useProject } from "../store.js";

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

function RunsTable({ project }: { project: DesktopProject }) {
  const [runs, setRuns] = useState<RunSnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = project.backend.kind === "running";
  useEffect(() => {
    if (!running) return;
    let live = true;
    api.runs(project.key).then(
      (list) => live && setRuns(list.items),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [project.key, running]);
  if (error) return <div className="banner error">{error}</div>;
  if (!runs) return <div className="muted">Loading runs…</div>;
  if (runs.length === 0) return <div className="empty">No workflow runs in this project yet.</div>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Feature</th>
          <th>Status</th>
          <th>Stage</th>
          <th>Tokens</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.runId}>
            <td className="mono">{run.featureId}</td>
            <td style={{ color: run.status === "waiting" ? "var(--warn)" : undefined }}>
              {run.status}
            </td>
            <td>{run.stageId ?? "–"}</td>
            <td className="mono">{tokens(run.tokenUsage)}</td>
            <td className="mono">{usd(run.estimatedCostUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ProjectScreen({
  projectKey,
  section,
}: {
  projectKey: string;
  section: ProjectSection;
}) {
  const project = useProject(projectKey);
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
      ) : section === "overview" || section === "runs" ? (
        <section
          aria-label="Workflow runs"
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
          <p className="label">Workflow runs</p>
          <RunsTable project={project} />
        </section>
      ) : (
        <div className="empty">{TITLES[section]} comes in the next desktop pull requests.</div>
      )}
    </div>
  );
}
