import { useEffect, useState } from "react";
import type { RunSnapshot } from "../../../shared/api.js";
import { api } from "../../client/api.js";
import { tokens, usd } from "../../format.js";
import type { SectionProps } from "../sections.js";

function RunsTable({ project }: Pick<SectionProps, "project">) {
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

export function RunsSection({ project }: SectionProps) {
  return (
    <section
      aria-label="Workflow runs"
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      <p className="label">Workflow runs</p>
      <RunsTable project={project} />
    </section>
  );
}
