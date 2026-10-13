import { useEffect, useState } from "react";
import type { RunState } from "../../../shared/api.js";
import { errorText, RUN_COMPARE_CAPABILITY, type RunRow, runs } from "../../client/runs.js";
import { BlockIcon, Icon } from "../../components/Icon.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Empty } from "../../components/ui/empty.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { ago, tokens, usd } from "../../format.js";
import { TABLE } from "../../lib/styles.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import { CompareView } from "./CompareView.js";
import { togglePick } from "./compare-model.js";
import { stageIconOf } from "./line-model.js";
import { useBriefs } from "./load.js";
import { RunsMaintenance } from "./Maintenance.js";
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
  const [reloads, setReloads] = useState(0);
  const briefs = useBriefs(project.key, list);
  const [canCompare, setCanCompare] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [comparing, setComparing] = useState<[string, string] | null>(null);

  useEffect(() => {
    let live = true;
    runs.capabilities(project.key).then(
      (caps) => live && setCanCompare(caps.includes(RUN_COMPARE_CAPABILITY)),
      () => live && setCanCompare(false),
    );
    return () => {
      live = false;
    };
  }, [project.key]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloads` only triggers a reload after a cleanup
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
  }, [project.key, status, reloads]);

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
      <div className="flex flex-wrap items-center gap-2">
        <SegmentGroup aria-label="Filter by status">
          {FILTERS.map((f) => (
            <Segment
              key={f.label}
              aria-pressed={status === f.status}
              onClick={() => setStatus(f.status)}
            >
              {f.label}
            </Segment>
          ))}
        </SegmentGroup>
        <RunsMaintenance projectKey={project.key} onChanged={() => setReloads((n) => n + 1)} />
        {canCompare && (
          <Button
            variant="secondary"
            size="md"
            disabled={picked.length !== 2}
            title="Tick two runs, for example one feature run with two routing maps"
            onClick={() => setComparing([picked[0] as string, picked[1] as string])}
          >
            Compare {picked.length}/2
          </Button>
        )}
      </div>
      {comparing && (
        <CompareView
          projectKey={project.key}
          a={comparing[0]}
          b={comparing[1]}
          onClose={() => setComparing(null)}
        />
      )}
      {error && <Alert tone="error">{error}</Alert>}
      {!error && !list && <Skeleton label="Loading runs" />}
      {list?.length === 0 && (
        <Empty className="flex flex-col items-center gap-3">
          {!status && <BlockIcon name="runs" />}
          {status ? `No ${STATUS_TEXT[status]} runs.` : "No workflow runs in this project yet."}
        </Empty>
      )}
      {list && list.length > 0 && (
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr>
                {canCompare && <th aria-label="Compare" />}
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
                    {canCompare && (
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Compare ${run.featureId} (${run.runId})`}
                          checked={picked.includes(run.runId)}
                          onChange={() => setPicked((p) => togglePick(p, run.runId))}
                        />
                      </td>
                    )}
                    <td className="font-mono">
                      <a href={projectHref(project.key, "runs", run.runId)}>{run.featureId}</a>
                    </td>
                    <td className="max-w-[320px] overflow-hidden text-ellipsis">
                      {brief?.title ?? "–"}
                    </td>
                    <td>
                      <StatusPill status={run.status} />
                    </td>
                    <td>
                      {run.stageId ? (
                        <span className="inline-flex items-center gap-[6px]">
                          <Icon name={stageIconOf(run.stageId)} size={13} />
                          {stageLabel(run.stageId)}
                        </span>
                      ) : (
                        "–"
                      )}
                      {brief && brief.stage.total > 0 && (
                        <span className="font-mono text-dim-foreground">
                          {" "}
                          {brief.stage.index}/{brief.stage.total}
                        </span>
                      )}
                    </td>
                    <td className="text-right font-mono">
                      {brief && brief.tasks.total > 0
                        ? `${brief.tasks.done}/${brief.tasks.total}`
                        : "–"}
                    </td>
                    <td className="text-right font-mono">{tokens(run.tokenUsage)}</td>
                    <td className="text-right font-mono">{usd(run.estimatedCostUsd)}</td>
                    <td className="text-dim-foreground">
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
        <Button variant="secondary" size="md" onClick={() => void more()}>
          Show more runs
        </Button>
      )}
    </section>
  );
}
