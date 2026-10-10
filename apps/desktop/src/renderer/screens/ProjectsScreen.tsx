import { backendLabel, initial, projectLine } from "../format.js";
import { projectHref } from "../router.js";
import { useDesktop } from "../store.js";

export function ProjectsScreen() {
  const { projects, open, close, restart, addFolder, refresh } = useDesktop();
  return (
    <div className="page">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <h1>All projects</h1>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button type="button" className="btn" onClick={() => void refresh()}>
            Refresh
          </button>
          <button type="button" className="btn-primary" onClick={() => void addFolder()}>
            Open folder…
          </button>
        </div>
      </div>
      <p className="lede">
        Every folder BAKED was opened in. Each project keeps its own sessions, runs, memory and
        settings; open projects run their own backend and keep working in the background.
      </p>
      {projects.length === 0 ? (
        <div className="empty">No projects yet. Open a folder to start.</div>
      ) : (
        <div className="grid-cards">
          {projects.map((project) => {
            const backend = backendLabel(project.backend);
            return (
              <section
                key={project.key}
                className="card"
                aria-label={project.name}
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="avatar" style={{ width: 28, height: 28 }}>
                    {initial(project.name)}
                  </span>
                  <span className="stack">
                    <a
                      href={projectHref(project.key)}
                      style={{ color: "var(--text)", fontWeight: 600, textDecoration: "none" }}
                    >
                      {project.name}
                    </a>
                    <span className="sub-line" title={project.path}>
                      {project.path}
                    </span>
                  </span>
                  {project.pinned && (
                    <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
                      pinned
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 14, fontSize: 13, color: "var(--text-3)" }}>
                  <span>
                    {project.overview.sessions}{" "}
                    {project.overview.sessions === 1 ? "session" : "sessions"}
                  </span>
                  <span>
                    {project.overview.activeRuns} active{" "}
                    {project.overview.activeRuns === 1 ? "run" : "runs"}
                  </span>
                  <span style={{ color: project.overview.attention ? "var(--warn)" : undefined }}>
                    {project.overview.attention} waiting
                  </span>
                </div>
                <div className="status-line" style={{ padding: 0 }}>
                  <span className={`dot ${backend.tone}`} />
                  {project.open ? backend.text : projectLine(project)}
                </div>
                {project.backend.kind === "failed" && (
                  <div
                    className="banner error mono"
                    style={{ fontSize: 12, whiteSpace: "pre-wrap" }}
                  >
                    {project.backend.stderr.slice(-5).join("\n") || project.backend.lastError}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
                  {project.open ? (
                    <>
                      <a className="btn-primary" href={projectHref(project.key)}>
                        Go to project
                      </a>
                      {project.backend.kind === "failed" && (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void restart(project.key)}
                        >
                          Restart
                        </button>
                      )}
                      <button type="button" className="btn" onClick={() => void close(project.key)}>
                        Close
                      </button>
                    </>
                  ) : (
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
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
