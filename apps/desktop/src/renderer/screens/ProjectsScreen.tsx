import { useState } from "react";
import type { AttentionItem, DesktopProject } from "../../shared/api.js";
import { attentionTitle } from "../../shared/attention.js";
import type { ProjectAction } from "../../shared/bridge.js";
import { bridge } from "../client/bridge.js";
import { ago, backendLabel, initial } from "../format.js";
import { href, projectHref } from "../router.js";
import { useDesktop } from "../store.js";
import "../styles/projects.css";

/** The state line in a card's corner: closed, starting, open, or how many items wait. */
export function projectState(
  project: DesktopProject,
  waiting: number,
): { text: string; tone: "ok" | "warn" | "err" | "muted" } {
  if (!project.exists) return { text: "folder missing", tone: "err" };
  if (!project.open) return { text: "closed", tone: "muted" };
  if (project.backend.kind === "failed") return { text: "open · backend stopped", tone: "err" };
  if (project.backend.kind !== "running")
    return { text: `open · ${backendLabel(project.backend).text}`, tone: "muted" };
  if (waiting > 0) return { text: `open · ${waiting} need you`, tone: "warn" };
  return { text: "open · in background", tone: "ok" };
}

export function matchesProject(project: DesktopProject, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [project.name, project.path, project.branch ?? ""].some((v) =>
    v.toLowerCase().includes(q),
  );
}

function Card({
  project,
  items,
  onAction,
  busy,
}: {
  project: DesktopProject;
  items: AttentionItem[];
  onAction: (action: ProjectAction) => void;
  busy: boolean;
}) {
  const { open, close, restart } = useDesktop();
  const [confirmForget, setConfirmForget] = useState(false);
  const { overview } = project;
  const waiting = project.open ? items.length : overview.attention;
  const state = projectState(project, waiting);
  return (
    <article className="card proj-card" data-open={project.open || undefined}>
      <div className="proj-head">
        <span className="avatar proj-avatar">{initial(project.name)}</span>
        <div className="stack">
          <h2>
            {project.open ? <a href={projectHref(project.key)}>{project.name}</a> : project.name}
          </h2>
          <span className="sub-line" title={project.path}>
            {project.path}
            {project.branch ? ` · ${project.branch}` : ""}
          </span>
        </div>
        <span className={`proj-state ${state.tone}`}>{state.text}</span>
      </div>
      <div className="proj-lines">
        <span>
          {overview.sessions} {overview.sessions === 1 ? "session" : "sessions"}
          {overview.lastSessionAt ? ` · last ${ago(overview.lastSessionAt)}` : ""}
        </span>
        {items.slice(0, 2).map((item) => (
          <span key={`${item.requestId}:${item.kind}`}>
            <span style={{ color: "var(--warn)" }} aria-hidden="true">
              ⚑{" "}
            </span>
            {attentionTitle(item)}
          </span>
        ))}
        <span>
          {overview.activeRuns > 0
            ? `${overview.activeRuns} active ${overview.activeRuns === 1 ? "run" : "runs"}`
            : "No active runs"}
        </span>
        {!project.open && project.exists && (
          <span className="muted">Opening starts its backend and language servers</span>
        )}
      </div>
      {project.backend.kind === "failed" && (
        <div className="banner error mono proj-log">
          {project.backend.stderr.slice(-5).join("\n") || project.backend.lastError}
        </div>
      )}
      {confirmForget ? (
        <fieldset className="proj-actions" aria-label={`Forget ${project.name}?`}>
          <span className="proj-confirm">
            Remove it from the list? Its sessions and runs stay in the folder.
          </span>
          <button type="button" className="btn" disabled={busy} onClick={() => onAction("forget")}>
            Forget
          </button>
          <button type="button" className="btn" onClick={() => setConfirmForget(false)}>
            Keep
          </button>
        </fieldset>
      ) : (
        <div className="proj-actions">
          {project.open ? (
            <>
              <a className="btn-primary" href={projectHref(project.key)}>
                Go to project
              </a>
              {items.length > 0 && (
                <a className="btn" href={href({ name: "attention" })}>
                  Answer
                </a>
              )}
              {project.backend.kind === "failed" && (
                <button type="button" className="btn" onClick={() => void restart(project.key)}>
                  Restart
                </button>
              )}
              <button type="button" className="btn" onClick={() => void close(project.key)}>
                Close
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn-primary"
                disabled={!project.exists}
                onClick={() =>
                  void open(project.key).then(() => {
                    window.location.hash = projectHref(project.key);
                  })
                }
              >
                Open
              </button>
              <button type="button" className="btn" onClick={() => setConfirmForget(true)}>
                Forget
              </button>
            </>
          )}
          <button
            type="button"
            className="btn proj-pin"
            aria-pressed={project.pinned}
            aria-label={project.pinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
            disabled={busy}
            onClick={() => onAction(project.pinned ? "unpin" : "pin")}
          >
            {project.pinned ? "★ Pinned" : "☆ Pin"}
          </button>
        </div>
      )}
    </article>
  );
}

export function ProjectsScreen() {
  const { projects, attention, addFolder, refresh } = useDesktop();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = projects.filter((p) => matchesProject(p, query));
  const act = async (key: string, action: ProjectAction): Promise<void> => {
    setBusy(key);
    setError(null);
    try {
      await bridge.manageProject(key, action);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="page">
      <header className="proj-header">
        <h1>Projects</h1>
        <label htmlFor="proj-search" className="sr-only">
          Find a project
        </label>
        <input
          id="proj-search"
          type="search"
          className="proj-search"
          placeholder="Find a project"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" className="btn" onClick={() => void refresh()}>
          Refresh
        </button>
        <button type="button" className="btn-primary" onClick={() => void addFolder()}>
          Open folder…
        </button>
      </header>
      <p className="lede">
        Every folder you open becomes a project with its own sessions, runs, memory and settings.
        Open projects keep working in the background, each with its own backend; a closed project
        pauses its runs until you open it again.
      </p>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {projects.length === 0 ? (
        <div className="empty">No projects yet. Open a folder to start.</div>
      ) : shown.length === 0 ? (
        <div className="empty">No project matches “{query}”.</div>
      ) : (
        <div className="proj-grid">
          {shown.map((project) => (
            <Card
              key={project.key}
              project={project}
              items={attention.filter((i) => i.projectKey === project.key && i.blocking)}
              busy={busy === project.key}
              onAction={(action) => void act(project.key, action)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
