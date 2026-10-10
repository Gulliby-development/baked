import { Fragment } from "react";
import type { DesktopProject } from "../../shared/api.js";
import type { SessionState } from "../client/chat.js";
import { useChatSessions } from "../client/chat-sessions.js";
import { backendLabel, initial, projectLine } from "../format.js";
import { href, type ProjectSection, projectHref, type Route } from "../router.js";
import { useDesktop } from "../store.js";
import { Icon, type IconName } from "./Icon.js";

/** How many projects the sidebar lists before "All projects" takes over. */
const SIDEBAR_PROJECTS = 8;
/** How many recent chats the selected project lists under Chat; the rest are in the chat's menu. */
const SIDEBAR_CHATS = 5;
/** How many sessions are asked for to count them. */
const COUNTED_CHATS = 200;

const WORK: [ProjectSection, string, IconName][] = [
  ["overview", "Overview", "home"],
  ["chat", "Chat", "chat"],
  ["runs", "Runs", "runs"],
  ["initiatives", "Initiatives", "flag"],
  ["acceptance", "Acceptance", "shield"],
  ["usage", "Usage", "bars"],
];

const SETUP: [ProjectSection, string, IconName][] = [
  ["gates", "Gates and checks", "gate"],
  ["instructions", "Instructions", "file"],
  ["working-set", "Working set", "folder"],
];

const STATE_TONE: Record<SessionState, string> = { idle: "", working: "busy", waiting: "warn" };

function current(active: boolean): "page" | undefined {
  return active ? "page" : undefined;
}

function ProjectEntry({ project, route }: { project: DesktopProject; route: Route }) {
  const selected = route.name === "project" && route.key === project.key;
  if (!selected)
    return (
      <a className="nav" href={projectHref(project.key)}>
        <span className="avatar">{initial(project.name)}</span>
        <span className="stack">
          <span>{project.name}</span>
          <span className="sub-line">{projectLine(project)}</span>
        </span>
        {project.overview.attention > 0 ? (
          <span className="badge">{project.overview.attention}</span>
        ) : project.open ? (
          <span
            className={`dot ${backendLabel(project.backend).tone}`}
            style={{ marginLeft: "auto" }}
          />
        ) : null}
      </a>
    );
  return <SelectedProject project={project} section={route.section} id={route.id} />;
}

/** The selected project with its sections, New chat and its recent chats. */
function SelectedProject({
  project,
  section,
  id: routeId,
}: {
  project: DesktopProject;
  section: ProjectSection;
  id: string | null;
}) {
  const chats = useChatSessions(project.key, project.backend.kind === "running", COUNTED_CHATS);
  const chatCount = chats ? chats.length : project.overview.sessions;
  const chatId = section === "chat" ? routeId : null;
  return (
    <div className="project-box">
      <a className="nav" href={projectHref(project.key)} style={{ background: "var(--bg-hover)" }}>
        <span className="avatar current">{initial(project.name)}</span>
        <span className="stack">
          <span style={{ fontWeight: 600, color: "var(--text)" }}>{project.name}</span>
          <span className="sub-line" title={project.path}>
            {project.path}
          </span>
        </span>
      </a>
      <div className="project-actions">
        <a className="btn-primary" href={projectHref(project.key, "runs", "new-quick")}>
          Quick task
        </a>
        <a className="btn" href={projectHref(project.key, "runs", "new")}>
          New run
        </a>
      </div>
      {WORK.map(([id, label, icon]) => (
        <Fragment key={id}>
          <a
            className="nav sub"
            href={projectHref(project.key, id)}
            aria-current={current(section === id && (id !== "chat" || chatId === null))}
          >
            <Icon name={icon} />
            {label}
            {id === "chat" && chatCount > 0 && (
              <span className="count">
                {chatCount >= COUNTED_CHATS ? `${COUNTED_CHATS}+` : chatCount}
              </span>
            )}
            {id === "runs" && project.overview.activeRuns > 0 && (
              <span className="count">{project.overview.activeRuns} active</span>
            )}
          </a>
          {id === "chat" && (
            <div className="chat-links">
              <a
                className="nav chat-link new"
                href={projectHref(project.key, "chat", "new")}
                aria-current={current(chatId === "new")}
              >
                <Icon name="plus" size={13} />
                New chat
              </a>
              {chats?.slice(0, SIDEBAR_CHATS).map((session) => (
                <a
                  key={session.id}
                  className="nav chat-link"
                  href={projectHref(project.key, "chat", session.id)}
                  aria-current={current(chatId === session.id)}
                  title={session.title}
                >
                  <span className={`dot ${STATE_TONE[session.state]}`} />
                  <span className="chat-link-title">{session.title}</span>
                </a>
              ))}
            </div>
          )}
        </Fragment>
      ))}
      <p className="label" style={{ padding: "8px 10px 4px 22px", fontSize: 11 }}>
        Setup
      </p>
      {SETUP.map(([id, label, icon]) => (
        <a
          key={id}
          className="nav sub"
          href={projectHref(project.key, id)}
          aria-current={current(section === id)}
        >
          <Icon name={icon} />
          {label}
        </a>
      ))}
    </div>
  );
}

export function Sidebar({ route }: { route: Route }) {
  const { projects, attention, addFolder } = useDesktop();
  const blocking = attention.filter((item) => item.blocking).length;
  const running = projects.filter((p) => p.backend.kind === "running").length;
  const failed = projects.filter((p) => p.backend.kind === "failed").length;
  const shown = projects.slice(0, SIDEBAR_PROJECTS);
  // The selected project stays listed even when it is not among the first ones.
  if (route.name === "project" && !shown.some((p) => p.key === route.key)) {
    const selected = projects.find((p) => p.key === route.key);
    if (selected) shown.unshift(selected);
  }
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="nav-group">
        <a
          className="nav"
          href={href({ name: "attention" })}
          aria-current={current(route.name === "attention")}
        >
          <Icon name="bell" />
          Needs you
          {blocking > 0 && <span className="badge">{blocking}</span>}
        </a>
        <a
          className="nav"
          href={href({ name: "projects" })}
          aria-current={current(route.name === "projects")}
        >
          <Icon name="grid" />
          All projects
        </a>
      </div>
      <div className="nav-group">
        <p className="label" style={{ padding: "0 10px 6px" }}>
          Projects
        </p>
        {shown.map((project) => (
          <ProjectEntry key={project.key} project={project} route={route} />
        ))}
        <button type="button" className="nav" onClick={() => void addFolder()}>
          <Icon name="plus" />
          Open folder…
        </button>
      </div>
      <div className="sidebar-foot">
        <a
          className="nav"
          href={href({ name: "settings", section: "app" })}
          aria-current={current(route.name === "settings")}
        >
          <Icon name="gear" />
          Settings
        </a>
        <div className="status-line">
          <span className={`dot ${failed > 0 ? "err" : running > 0 ? "ok" : ""}`} />
          {failed > 0
            ? `${failed} project${failed === 1 ? "" : "s"} stopped`
            : `${running} project${running === 1 ? "" : "s"} running`}
        </div>
      </div>
    </nav>
  );
}
