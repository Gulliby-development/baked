import { useEffect, useState } from "react";
import type { RunState } from "../../../shared/api.js";
import { errorText, type RunRow, runs } from "../../client/runs.js";
import { ago, tokens, usd } from "../../format.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import { useBriefs } from "./load.js";
import { STATUS_TEXT, stageLabel } from "./model.js";
import { StatusPill } from "./parts.js";

const FILTERS: { label: string; status: RunState | null }[] = [
  { label: "All", status: null },
  { label: "Waiting", status: "waiting" },
  { label: "Running", status: "running" },
  { label: "Blocked", status: "blocked" },
  { label: "Paused", status: "paused" },
  { label: "Completed", status: "completed" },
  { label: "Failed", status: "failed" },
];
const PAGE = 30;

export function RunsList({ project }: Pick<SectionProps, "project">) {
  const [status, setStatus] = useState<RunState | null>(null);
  const [list, setList] = useState<RunRow[] | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const briefs = useBriefs(project.key, list);

  useEffect(() => {
    let live = true;
    setList(null);
    setError(null);
    runs.list(project.key, { limit: PAGE, ...(status ? { status } : {}) }).then(
      (page) => {
        if (!live) return;
        setList(page.items);
        setCursor(page.cursor);
      },
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [project.key, status]);

  const more = async (): Promise<void> => {
    if (!cursor) return;
    try {
      const page = await runs.list(project.key, {
        limit: PAGE,
        cursor,
        ...(status ? { status } : {}),
      });
      setList((l) => [...(l ?? []), ...page.items]);
      setCursor(page.cursor);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section aria-label="Workflow runs" className="flex flex-col gap-3">
      <fieldset className="seg-group" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            type="button"
            className="seg"
            aria-pressed={status === f.status}
            onClick={() => setStatus(f.status)}
          >
            {f.label}
          </button>
        ))}
      </fieldset>
      {error && <div className="banner error">{error}</div>}
      {!error && !list && <div className="muted">Loading runs…</div>}
      {list?.length === 0 && (
        <div className="empty">
          {status ? `No ${STATUS_TEXT[status]} runs.` : "No workflow runs in this project yet."}
        </div>
      )}
      {list && list.length > 0 && (
        <div className="overflow-x-auto">
          <table className="table runs-table">
            <thead>
              <tr>
                <th>Feature</th>
                <th>Title</th>
                <th>Status</th>
                <th>Stage</th>
                <th className="text-right">Tasks</th>
                <th className="text-right">Tokens</th>
                <th className="text-right">Cost</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {list.map((run) => {
                const brief = briefs.get(run.runId);
                return (
                  <tr key={run.runId}>
                    <td className="mono">
                      <a href={projectHref(project.key, "runs", run.runId)}>{run.featureId}</a>
                    </td>
                    <td className="max-w-[320px] overflow-hidden text-ellipsis">
                      {brief?.title ?? "–"}
                    </td>
                    <td>
                      <StatusPill status={run.status} />
                    </td>
                    <td>
                      {run.stageId ? stageLabel(run.stageId) : "–"}
                      {brief && brief.stage.total > 0 && (
                        <span className="muted mono">
                          {" "}
                          {brief.stage.index}/{brief.stage.total}
                        </span>
                      )}
                    </td>
                    <td className="mono text-right">
                      {brief && brief.tasks.total > 0
                        ? `${brief.tasks.done}/${brief.tasks.total}`
                        : "–"}
                    </td>
                    <td className="mono text-right">{tokens(run.tokenUsage)}</td>
                    <td className="mono text-right">{usd(run.estimatedCostUsd)}</td>
                    <td className="muted">
                      {brief?.updatedAt ? ago(Date.parse(brief.updatedAt)) : "–"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <button type="button" className="btn" onClick={() => void more()}>
          Show more runs
        </button>
      )}
    </section>
  );
}
