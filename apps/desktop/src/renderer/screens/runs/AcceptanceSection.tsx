import { useEffect, useState } from "react";
import { errorText, type RunRow, runs } from "../../client/runs.js";
import { ago } from "../../format.js";
import { projectHref } from "../../router.js";
import { useDesktop } from "../../store.js";
import type { SectionProps } from "../sections.js";
import { GateView } from "./GateView.js";
import { useBriefs, useRun } from "./load.js";
import { StatusPill } from "./parts.js";
import { RUN_TITLE, RUN_TITLE_ROW } from "./RunScreen.js";

const ACCEPTANCE_KINDS = new Set(["manual_evidence", "acceptance"]);

function RunGate({ projectKey, runId }: { projectKey: string; runId: string }) {
  const { data, trace, error, refresh } = useRun(projectKey, runId);
  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <div className="muted">Loading acceptance…</div>;
  return (
    <div className="flex flex-col gap-4">
      <div className={RUN_TITLE_ROW}>
        <h2 className={RUN_TITLE}>
          Acceptance: {data.artifacts.spec?.title ?? data.status.featureId}
        </h2>
        <StatusPill status={data.status.status} />
        <a className="btn" href={projectHref(projectKey, "runs", runId)}>
          Open run
        </a>
      </div>
      <GateView projectKey={projectKey} data={data} trace={trace} onDone={refresh} />
    </div>
  );
}

export function AcceptanceSection({ project, id }: SectionProps) {
  const { attention } = useDesktop();
  const [list, setList] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const briefs = useBriefs(project.key, list);
  useEffect(() => {
    let live = true;
    runs.list(project.key, { limit: 30 }).then(
      (page) => live && setList(page.items),
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [project.key]);
  const waiting = new Set(
    attention
      .filter(
        (a) =>
          a.projectKey === project.key &&
          (ACCEPTANCE_KINDS.has(a.kind) || (a.kind === "approval" && !a.blocking)),
      )
      .map((a) => a.runId),
  );
  const shown = (list ?? []).filter(
    (r) => waiting.has(r.runId) || briefs.get(r.runId)?.hasAcceptance,
  );
  const checking = list !== null && briefs.size < list.length;
  return (
    <div className="flex flex-wrap items-start gap-5">
      <nav
        className="flex max-w-[300px] flex-[1_1_220px] flex-col gap-2"
        aria-label="Runs with acceptance results"
      >
        {error && <div className="banner error">{error}</div>}
        {!list && !error && <div className="muted">Loading runs…</div>}
        {shown.map((run) => {
          const brief = briefs.get(run.runId);
          return (
            <a
              key={run.runId}
              className="item no-underline aria-[current=page]:border-border aria-[current=page]:bg-hover aria-[current=page]:shadow-sm-hard"
              href={projectHref(project.key, "acceptance", run.runId)}
              aria-current={id === run.runId ? "page" : undefined}
            >
              <span className="stack">
                <span className="text-foreground">{brief?.title ?? run.featureId}</span>
                <span className="muted text-[12px]">
                  <span className="mono">{run.featureId}</span>
                  {waiting.has(run.runId) ? " · needs you" : ""}
                  {brief?.updatedAt ? ` · ${ago(Date.parse(brief.updatedAt))}` : ""}
                </span>
              </span>
            </a>
          );
        })}
        {checking && <div className="muted text-[12px]">Checking runs…</div>}
        {list && !checking && shown.length === 0 && (
          <div className="empty">No run has acceptance results yet.</div>
        )}
      </nav>
      <div className="min-w-0 flex-[999_1_520px]">
        {id ? (
          <RunGate key={id} projectKey={project.key} runId={id} />
        ) : (
          <div className="empty">Choose a run to see its criteria, verdicts and evidence.</div>
        )}
      </div>
    </div>
  );
}
