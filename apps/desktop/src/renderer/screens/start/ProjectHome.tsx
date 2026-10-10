import "../../styles/start.css";
import { useState } from "react";
import type { AttentionItem, RunSnapshot, RunState } from "../../../shared/api.js";
import { attentionHash, attentionId } from "../../../shared/attention.js";
import { ApiError, api } from "../../client/api.js";
import { type ProjectSummary, start } from "../../client/start.js";
import { ago, tokens, usd } from "../../format.js";
import { projectHref } from "../../router.js";
import { useDesktop } from "../../store.js";
import type { SectionProps } from "../sections.js";
import { type DraftTarget, putDraft } from "./drafts.js";
import { DoctorChecks, message, useLoad } from "./panels.js";

const RUN_GLYPH: Record<RunState, [string, string]> = {
  created: ["·", ""],
  running: ["⟳", "info"],
  waiting: ["⚑", "warn"],
  paused: ["‖", ""],
  blocked: ["!", "warn"],
  completed: ["✓", "ok"],
  failed: ["✗", "err"],
  cancelled: ["✗", ""],
};

const ATTENTION_TEXT: Record<string, [string, string]> = {
  approval: ["Approve the spec, plan and tasks", "Review"],
  clarification: ["Answer the run's questions", "Answer"],
  delivery: ["Deliver: commit, push and open a pull request", "Open plan"],
  acceptance: ["Acceptance check to confirm", "Open"],
};

const kb = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024).toLocaleString("en-US")} KB`;

const noProject = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404 && /No project here/.test(error.message);

function TaskBox({ projectKey }: { projectKey: string }) {
  const [text, setText] = useState("");
  const go = (target: DraftTarget): void => {
    putDraft(target, projectKey, text);
    window.location.hash =
      target === "chat"
        ? projectHref(projectKey, "chat", "new")
        : projectHref(projectKey, "runs", target === "quick" ? "new-quick" : "new");
  };
  return (
    <form
      className="card start-taskbox"
      onSubmit={(e) => {
        e.preventDefault();
        go("quick");
      }}
    >
      <label htmlFor="home-task" className="start-taskbox-label">
        What should change?
      </label>
      <textarea
        id="home-task"
        rows={2}
        value={text}
        placeholder="Fix the off-by-one in the usage table header"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            go("quick");
          }
        }}
      />
      <div className="start-inline">
        <button type="submit" className="btn-primary">
          Quick
        </button>
        <button type="button" className="btn" onClick={() => go("run")}>
          Full run
        </button>
        <button type="button" className="btn" onClick={() => go("chat")}>
          Ask in chat
        </button>
        <span className="start-hint start-taskbox-hint">
          Quick plans the change, waits for your approval, then implements, checks and reviews.
        </span>
      </div>
    </form>
  );
}

function NeedsYou({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="home-needs" className="start-section">
      <div className="start-section-head">
        <h2 id="home-needs" className="label">
          Needs you
        </h2>
        <a href="#/attention">All {items.length}</a>
      </div>
      {items.slice(0, 4).map((item) => {
        const [title, action] = ATTENTION_TEXT[item.kind] ?? [item.kind, "Open"];
        return (
          <div
            key={attentionId(item)}
            className={`card start-attention${item.blocking ? " blocking" : ""}`}
          >
            <span className="mono start-glyph warn" aria-hidden="true">
              {item.kind === "clarification" ? "?" : item.kind === "delivery" ? "↗" : "⚑"}
            </span>
            <span className="stack start-grow">
              <span>{title}</span>
              <span className="start-hint">
                {item.featureId ?? item.title ?? item.source} · {item.kind} · waiting{" "}
                {ago(item.createdAt).replace(" ago", "")}
              </span>
            </span>
            <a className={item.blocking ? "btn-primary" : "btn"} href={attentionHash(item)}>
              {action}
            </a>
          </div>
        );
      })}
    </section>
  );
}

function RunsCard({ projectKey }: { projectKey: string }) {
  const runs = useLoad(projectKey, (key) => api.runs(key, 8));
  return (
    <section aria-labelledby="home-runs" className="start-section">
      <div className="start-section-head">
        <h2 id="home-runs" className="label">
          Runs in this project
        </h2>
        <a href={projectHref(projectKey, "runs")}>All runs</a>
      </div>
      {runs.error ? (
        <div className="banner error">{message(runs.error)}</div>
      ) : !runs.value ? (
        <p className="start-hint">Loading runs…</p>
      ) : runs.value.items.length === 0 ? (
        <div className="empty">
          No workflow runs yet. Describe a change above and pick Quick or Full run.
        </div>
      ) : (
        <div className="card start-table-card">
          <table className="table start-table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                <th>Stage</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.value.items.map((run: RunSnapshot) => {
                const [glyph, tone] = RUN_GLYPH[run.status];
                return (
                  <tr key={run.runId}>
                    <td>
                      <a
                        className="start-run-link"
                        href={projectHref(projectKey, "runs", run.runId)}
                      >
                        <span className={`start-glyph ${tone}`} aria-hidden="true">
                          {glyph}
                        </span>{" "}
                        {run.featureId}
                      </a>
                    </td>
                    <td>{run.status}</td>
                    <td>{run.stageId ?? "–"}</td>
                    <td className="mono num">{tokens(run.tokenUsage)}</td>
                    <td className="mono num">{usd(run.estimatedCostUsd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SessionsCard({ projectKey, summary }: { projectKey: string; summary: ProjectSummary }) {
  return (
    <section aria-labelledby="home-sessions" className="start-section">
      <div className="start-section-head">
        <h2 id="home-sessions" className="label">
          Recent sessions
        </h2>
        <a href={projectHref(projectKey, "chat")}>Chat</a>
      </div>
      {summary.sessions.length === 0 ? (
        <div className="empty">No chat sessions in this project yet.</div>
      ) : (
        <ul className="card start-list">
          {summary.sessions.slice(0, 5).map((session) => (
            <li key={session.id}>
              <a className="start-list-row" href={projectHref(projectKey, "chat", session.id)}>
                <span className="start-grow start-ellipsis">{session.title || "Untitled"}</span>
                <span className="mono start-hint">
                  {session.messageCount} msg · {ago(session.updatedAt)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WorkingSetCard({ projectKey, summary }: { projectKey: string; summary: ProjectSummary }) {
  const { entries, files, skipped } = summary.workingSet;
  const total = files.reduce((n, f) => n + f.bytes, 0);
  return (
    <section aria-labelledby="home-ws" className="card start-panel">
      <div className="start-panel-head">
        <h2 id="home-ws" className="label">
          Working set
        </h2>
        <a className="btn start-small" href={projectHref(projectKey, "working-set")}>
          Edit
        </a>
      </div>
      <p className="start-note">
        Sent to every new chat and to the research stage, so the agent does not search for them
        again.
      </p>
      {entries.length === 0 ? (
        <p className="start-note">Nothing in the working set yet.</p>
      ) : (
        <>
          <ul className="start-files">
            {files.slice(0, 6).map((file) => (
              <li key={file.path}>
                <span className="mono start-ellipsis">{file.path}</span>
                <span className="mono start-hint">{kb(file.bytes)}</span>
              </li>
            ))}
            {skipped.map((entry) => (
              <li key={entry.path} className="skipped">
                <span className="mono start-ellipsis">{entry.path}</span>
                <span className="start-hint">skipped, {entry.reason}</span>
              </li>
            ))}
          </ul>
          <span className="start-hint">
            {entries.length} entr{entries.length === 1 ? "y" : "ies"}, {files.length} file
            {files.length === 1 ? "" : "s"}, {kb(total)}
            {files.length > 6 ? ` · ${files.length - 6} more files` : ""}
          </span>
        </>
      )}
    </section>
  );
}

function DoctorCard({ projectKey }: { projectKey: string }) {
  const doctor = useLoad(projectKey, (key) => start.doctor(key));
  const report = doctor.value;
  return (
    <section aria-labelledby="home-doctor" className="card start-panel">
      <div className="start-panel-head">
        <h2 id="home-doctor" className="label">
          Doctor
        </h2>
        {report && (
          <span className={`start-state ${report.ready ? "ok" : "err"}`}>
            {report.ready ? "ready" : "not ready"}
          </span>
        )}
      </div>
      {doctor.error ? (
        <p className="start-note err">{message(doctor.error)}</p>
      ) : report ? (
        <DoctorChecks checks={report.checks} limit={4} />
      ) : (
        <p className="start-note">Checking…</p>
      )}
      <a href={projectHref(projectKey, "runs", "new")}>Open full report</a>
    </section>
  );
}

/** The project home: a task box, what waits for the person, runs, sessions and project setup. */
export function ProjectHome({ project }: SectionProps) {
  const key = project.key;
  const { attention } = useDesktop();
  const summary = useLoad(key, start.summary);
  const waiting = attention.filter((item) => item.projectKey === key);
  const extraRoots = summary.value
    ? summary.value.roots.filter((root) => root !== summary.value?.root)
    : [];
  return (
    <div className="start-home">
      <div className="start-chips-line">
        {summary.value?.branch && (
          <span className="mono start-pill" title="Git branch">
            {summary.value.branch}
          </span>
        )}
        {summary.value && summary.value.id.toLowerCase() !== project.name.toLowerCase() && (
          <span className="mono start-pill" title="Project ID">
            {summary.value.id}
          </span>
        )}
        {extraRoots.map((root) => (
          <span key={root} className="mono start-pill muted-pill">
            + {root} as extra root
          </span>
        ))}
        <span className="start-hint">own sessions, runs, memory and settings</span>
        <a className="btn start-settings" href={projectHref(key, "gates")}>
          Project settings
        </a>
      </div>

      <TaskBox projectKey={key} />

      <div className="start-columns">
        <div className="start-main-col">
          <NeedsYou items={waiting} />
          <RunsCard projectKey={key} />
          {summary.value && <SessionsCard projectKey={key} summary={summary.value} />}
        </div>
        <aside className="start-side-col" aria-label="Project setup">
          {summary.error ? (
            <section className="card start-panel">
              <h2 className="label">Project</h2>
              <p className="start-note">
                {noProject(summary.error)
                  ? "This folder has no baked/project.json, so it has no working set or project sessions. Run baked project init in the folder to create one."
                  : message(summary.error)}
              </p>
            </section>
          ) : summary.value ? (
            <WorkingSetCard projectKey={key} summary={summary.value} />
          ) : (
            <p className="start-hint">Loading project…</p>
          )}
          <DoctorCard projectKey={key} />
        </aside>
      </div>
    </div>
  );
}
