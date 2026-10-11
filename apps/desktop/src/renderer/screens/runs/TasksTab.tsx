import type { RunRequest } from "../../client/runs.js";
import { Questions } from "./Decision.js";
import type { RunData } from "./load.js";
import {
  nextTasks,
  type RunTrace,
  type Task,
  type TaskState,
  taskLevels,
  taskState,
} from "./model.js";
import { STATE_TEXT as STATE_TONE } from "./RunTabs.js";
import { clarificationTask } from "./requests.js";

const WRITER =
  "flex min-w-0 flex-col gap-[10px] rounded-base border-2 border-border bg-background p-[14px] shadow-shadow";
const INTEGRATOR =
  "flex min-w-0 flex-col gap-[10px] rounded-base border-2 border-dashed border-border bg-[var(--bg-sunken)] p-[14px]";
const WRITER_HEAD =
  "flex items-center justify-between gap-2 text-[12px] [&_h3]:m-0 [&_h3]:text-[14px]";
const TASK = "flex flex-col gap-[6px] rounded-base border-2 p-[10px] [overflow-wrap:anywhere]";
const SUB = "text-[12px] text-muted-foreground";
const LIST = "m-0 list-none p-0";
const CHIP =
  "inline-flex min-h-[30px] cursor-pointer items-center gap-[6px] whitespace-nowrap rounded-[6px] border-2 border-border px-[10px] py-[6px] text-[13px] font-semibold no-underline hover:shadow-sm-hard";
/** Task graph chips by state; a state with its own colours keeps them on hover. */
const CHIP_STATE: Record<TaskState, string> = {
  done: `${CHIP} bg-[color-mix(in_srgb,var(--ok)_14%,var(--bg))] text-[var(--ok)]`,
  running: `${CHIP} bg-selected text-foreground`,
  ready: `${CHIP} bg-raised text-soft-foreground hover:bg-hover`,
  waiting: `${CHIP} bg-raised text-dim-foreground hover:bg-hover hover:text-foreground`,
  failed: `${CHIP} bg-[color-mix(in_srgb,var(--warn)_16%,var(--bg))] text-[var(--warn)]`,
  blocked: `${CHIP} bg-[color-mix(in_srgb,var(--warn)_16%,var(--bg))] text-[var(--warn)]`,
};

const STATE_TEXT: Record<TaskState, string> = {
  done: "integrated",
  running: "running",
  ready: "ready",
  waiting: "waiting",
  failed: "failed",
  blocked: "blocked",
};

const writerWorktree = (runId: string, taskId: string): string =>
  `.baked/worktrees/${runId}/${taskId}`;

function WriterColumn({
  index,
  current,
  done,
  data,
  trace,
  question,
  projectKey,
  onDone,
}: {
  index: number;
  current: Task | null;
  done: string[];
  data: RunData;
  trace: RunTrace;
  question: RunRequest | null;
  projectKey: string;
  onDone: () => Promise<void>;
}) {
  const running = current !== null;
  const graph = data.artifacts.graph;
  const followers = current
    ? (graph?.tasks.filter(
        (t) =>
          taskState(t, trace) === "waiting" &&
          t.dependsOn.find((d) => trace.tasks.get(d)?.status === "running") === current.id,
      ) ?? [])
    : [];
  return (
    <section className={WRITER} aria-label={`Writer ${index + 1}`}>
      <div className={WRITER_HEAD}>
        <h3>Writer {index + 1}</h3>
        <span
          className={question ? "text-[var(--warn)]" : running ? "text-[var(--info)]" : "muted"}
        >
          {question ? "⚑ needs decision" : running ? "⟳ working" : "idle"}
        </span>
      </div>
      {current && (
        <span className="mono muted text-[12px]">
          {writerWorktree(data.status.runId, current.id)}
        </span>
      )}
      {current && (
        <div
          className={`${TASK} shadow-sm-hard ${question ? "border-[color:var(--warn)] bg-[color-mix(in_srgb,var(--warn)_7%,var(--bg-panel))]" : "border-border bg-raised"}`}
        >
          <span className="font-medium">
            {current.id} · {current.title}
          </span>
          {current.writes.length > 0 && (
            <span className={SUB}>
              {current.writes
                .slice(0, 3)
                .map((w) => w.path)
                .join(", ")}
              {current.writes.length > 3 ? ` +${current.writes.length - 3}` : ""}
            </span>
          )}
          {question && (
            <Questions
              projectKey={projectKey}
              run={data.status}
              request={question}
              onDone={onDone}
              compact
            />
          )}
        </div>
      )}
      {followers.map((t) => (
        <div key={t.id} className={`${TASK} muted border-border`}>
          <span>
            {t.id} · {t.title}
          </span>
          <span className="text-[12px]">waits for {current?.id}</span>
        </div>
      ))}
      {done.length > 0 && (
        <span className="muted text-[12px]">Finished here: {done.join(", ")}</span>
      )}
    </section>
  );
}

export function TasksTab({
  projectKey,
  data,
  trace,
  onDone,
}: {
  projectKey: string;
  data: RunData;
  trace: RunTrace;
  onDone: () => Promise<void>;
}) {
  const graph = data.artifacts.graph;
  if (!graph) return <div className="empty">This run has no task graph yet. Plan creates it.</div>;
  const byId = new Map(graph.tasks.map((t) => [t.id, t]));
  const questions = data.status.requests.filter(
    (r) => r.status === "pending" && clarificationTask(r) !== null,
  );
  const writers = trace.writers;
  const next = nextTasks(graph, trace);
  const levels = taskLevels(graph);
  return (
    <div className="flex flex-col gap-5">
      <p className="lede">
        {writers.length > 1
          ? "Each writer works in its own git worktree. The integrator merges finished tasks back into the run branch in dependency order."
          : "Tasks run one at a time in the run's workspace, in dependency order."}
      </p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-[14px]">
        {writers.map((w) => {
          const current = w.current ? (byId.get(w.current) ?? null) : null;
          return (
            <WriterColumn
              key={w.index}
              index={w.index}
              current={current}
              done={w.done}
              data={data}
              trace={trace}
              question={questions.find((q) => clarificationTask(q) === w.current) ?? null}
              projectKey={projectKey}
              onDone={onDone}
            />
          );
        })}
        <section className={INTEGRATOR} aria-label="Integrator">
          <div className={WRITER_HEAD}>
            <h3>Integrator</h3>
            <span className="text-[var(--ok)]">✓ {trace.integrated.length} merged</span>
          </div>
          <span className="mono muted text-[12px]">baked/wf/{data.status.runId}</span>
          {trace.integrated
            .slice(-4)
            .reverse()
            .map((id) => (
              <div key={id} className={`${TASK} border-border`}>
                <span className="text-[var(--ok)]">
                  ✓ {id} · {byId.get(id)?.title ?? ""}
                </span>
                <span className={SUB}>{trace.tasks.get(id)?.status}</span>
              </div>
            ))}
          {next.length > 0 && (
            <div className={`${TASK} muted border-border`}>
              <span>
                Next: {next.slice(0, 2).join(", then ")}
                {next.length > 2 ? ` +${next.length - 2}` : ""}
              </span>
              <span className="text-[12px]">order from the task graph</span>
            </div>
          )}
        </section>
      </div>

      <section className="card flex flex-col gap-[10px]" aria-label="Task graph">
        <h3 className="label">Task graph</h3>
        <ol className={`${LIST} flex flex-wrap items-start gap-[10px]`}>
          {levels.map((level, depth) => (
            <li key={level.map((t) => t.id).join()} className="flex items-start gap-[10px]">
              {depth > 0 && (
                <span className="pt-[6px] text-[var(--line-strong)]" aria-hidden="true">
                  →
                </span>
              )}
              <ul className={`${LIST} flex flex-col gap-[6px]`}>
                {level.map((t) => {
                  const state = taskState(t, trace);
                  return (
                    <li
                      key={t.id}
                      className={CHIP_STATE[state]}
                      title={t.dependsOn.length ? `after ${t.dependsOn.join(", ")}` : undefined}
                    >
                      <span className="mono">{t.id}</span> {t.title}
                      <span className="sr-only">, {STATE_TEXT[state]}</span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      </section>

      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Title</th>
              <th>State</th>
              <th>After</th>
              <th>Writes</th>
            </tr>
          </thead>
          <tbody>
            {graph.tasks.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.id}</td>
                <td>{t.title}</td>
                <td className={STATE_TONE[taskState(t, trace)]}>
                  {STATE_TEXT[taskState(t, trace)]}
                </td>
                <td className="mono muted">{t.dependsOn.join(", ") || "–"}</td>
                <td className="mono muted">{t.writes.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
