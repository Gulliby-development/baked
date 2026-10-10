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
import { clarificationTask } from "./requests.js";

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
    <section className="writer" aria-label={`Writer ${index + 1}`}>
      <div className="writer-head">
        <h3>Writer {index + 1}</h3>
        <span className={question ? "warn-text" : running ? "info-text" : "muted"}>
          {question ? "⚑ needs decision" : running ? "⟳ working" : "idle"}
        </span>
      </div>
      {current && (
        <span className="mono muted small">{writerWorktree(data.status.runId, current.id)}</span>
      )}
      {current && (
        <div className={`task-card current${question ? " asking" : ""}`}>
          <span className="task-name">
            {current.id} · {current.title}
          </span>
          {current.writes.length > 0 && (
            <span className="small sub-text">
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
        <div key={t.id} className="task-card muted">
          <span>
            {t.id} · {t.title}
          </span>
          <span className="small">waits for {current?.id}</span>
        </div>
      ))}
      {done.length > 0 && <span className="small muted">Finished here: {done.join(", ")}</span>}
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
    <div className="tasks-tab">
      <p className="lede">
        {writers.length > 1
          ? "Each writer works in its own git worktree. The integrator merges finished tasks back into the run branch in dependency order."
          : "Tasks run one at a time in the run's workspace, in dependency order."}
      </p>
      <div className="writers">
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
        <section className="writer integrator" aria-label="Integrator">
          <div className="writer-head">
            <h3>Integrator</h3>
            <span className="ok-text">✓ {trace.integrated.length} merged</span>
          </div>
          <span className="mono muted small">baked/wf/{data.status.runId}</span>
          {trace.integrated
            .slice(-4)
            .reverse()
            .map((id) => (
              <div key={id} className="task-card">
                <span className="ok-text">
                  ✓ {id} · {byId.get(id)?.title ?? ""}
                </span>
                <span className="small sub-text">{trace.tasks.get(id)?.status}</span>
              </div>
            ))}
          {next.length > 0 && (
            <div className="task-card muted">
              <span>
                Next: {next.slice(0, 2).join(", then ")}
                {next.length > 2 ? ` +${next.length - 2}` : ""}
              </span>
              <span className="small">order from the task graph</span>
            </div>
          )}
        </section>
      </div>

      <section className="card panel" aria-label="Task graph">
        <h3 className="label">Task graph</h3>
        <ol className="graph">
          {levels.map((level, depth) => (
            <li key={level.map((t) => t.id).join()} className="graph-level">
              {depth > 0 && (
                <span className="graph-arrow" aria-hidden="true">
                  →
                </span>
              )}
              <ul>
                {level.map((t) => {
                  const state = taskState(t, trace);
                  return (
                    <li
                      key={t.id}
                      className={`chip ${state}`}
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

      <div className="table-wrap">
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
                <td className={`state-${taskState(t, trace)}`}>
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
