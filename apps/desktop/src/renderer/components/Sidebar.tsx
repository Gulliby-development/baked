import { Fragment } from "react";
import type { DesktopProject } from "../../shared/api.js";
import type { SessionState } from "../client/chat.js";
import { useChatSessions } from "../client/chat-sessions.js";
import { backendLabel, initial, projectLine } from "../format.js";
import { cn } from "../lib/cn.js";
import { LABEL } from "../lib/styles.js";
import { href, type ProjectSection, projectHref, type Route } from "../router.js";
import { useDesktop } from "../store.js";
import { Icon, type IconName } from "./Icon.js";
import { Badge } from "./ui/badge.js";
import { buttonVariants } from "./ui/button.js";
import { Dot, type DotTone } from "./ui/dot.js";

/** How many projects the sidebar lists before "All projects" takes over. */
const SIDEBAR_PROJECTS = 8;
/** How many recent chats the selected project lists under Chat; the rest are in the chat's menu. */
const SIDEBAR_CHATS = 5;
/** How many sessions are asked for to count them. */
const COUNTED_CHATS = 200;

const WORK: [ProjectSection, string, IconName][] = [
  ["overview", "Overview", "overview"],
  ["initiatives", "Initiatives", "initiatives"],
  ["chat", "Chat", "chat"],
  ["runs", "Runs", "runs"],
  ["usage", "Usage", "usage"],
  ["graph", "Code graph", "graph"],
  ["git", "Git", "git"],
];

const SETUP: [ProjectSection, string, IconName][] = [
  ["gates", "Gates and checks", "gates"],
  ["instructions", "Instructions", "instructions"],
  ["working-set", "Working set", "working-set"],
  ["run-memory", "Run memory", "run-memory"],
  ["chat-memory", "Chat memory", "chat-memory"],
  ["skills", "Skills", "skills"],
  ["hooks", "Hooks", "hooks"],
  ["mcp", "MCP servers", "mcp"],
  ["lsp", "Language servers", "lsp"],
  ["diagnostics", "Diagnostics", "diagnostics"],
];

const STATE_TONE: Record<SessionState, DotTone> = { idle: "", working: "busy", waiting: "warn" };

function current(active: boolean): "page" | undefined {
  return active ? "page" : undefined;
}

/** A sidebar row: outlined on hover, a raised block with a hard shadow when it is the current page. */
const NAV =
  "flex min-h-(--row) w-full cursor-pointer [font-family:inherit] items-center gap-2.5 rounded-base border-2 border-transparent bg-transparent px-2.5 py-1.5 text-left text-sm text-soft-foreground no-underline hover:border-border hover:bg-hover hover:text-foreground aria-[current=page]:border-border aria-[current=page]:bg-selected aria-[current=page]:font-heading aria-[current=page]:text-foreground aria-[current=page]:shadow-sm-hard";

const AVATAR =
  "flex size-6 flex-none items-center justify-center rounded-[4px] border-2 border-border bg-fill-info font-mono text-xs font-heading text-main-foreground";

const SUB_LINE = "truncate font-mono text-xs text-dim-foreground";

const COUNT = "ml-auto font-mono text-xs text-dim-foreground";

/** The indented list under a section (chats under Chat, Acceptance under Runs). */
const NESTED = "ml-7 flex flex-col gap-0.5 border-l-2 border-border pl-1.5";

const NESTED_ROW = "min-h-7 py-1 text-[13px]";

const GROUP_LABEL = `${LABEL} px-2.5 pb-1.5`;

function ProjectEntry({ project, route }: { project: DesktopProject; route: Route }) {
  const selected = route.name === "project" && route.key === project.key;
  if (!selected)
    return (
      <a className={NAV} href={projectHref(project.key)}>
        <span className={AVATAR}>{initial(project.name)}</span>
        <span className="flex min-w-0 flex-col">
          <span>{project.name}</span>
          <span className={SUB_LINE}>{projectLine(project)}</span>
        </span>
        {project.overview.attention > 0 ? (
          <Badge tone="warn" className="ml-auto">
            {project.overview.attention}
          </Badge>
        ) : project.open ? (
          <Dot tone={backendLabel(project.backend).tone} className="ml-auto" />
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
    <div className="flex flex-col gap-0.5 rounded-base border-2 border-border bg-secondary-background p-1.5 shadow-shadow">
      <a className={cn(NAV, "bg-hover")} href={projectHref(project.key)}>
        <span className={cn(AVATAR, "bg-main")}>{initial(project.name)}</span>
        <span className="flex min-w-0 flex-col">
          <span className="font-heading text-foreground">{project.name}</span>
          <span className={SUB_LINE} title={project.path}>
            {project.path}
          </span>
        </span>
      </a>
      <div className="flex gap-2 px-1 pt-1 pb-2">
        <a
          className={cn(buttonVariants({ size: "sm" }), "flex-1 no-underline")}
          href={projectHref(project.key, "runs", "new-quick")}
        >
          Quick task
        </a>
        <a
          className={cn(buttonVariants({ variant: "neutral", size: "sm" }), "flex-1 no-underline")}
          href={projectHref(project.key, "runs", "new")}
        >
          New run
        </a>
      </div>
      {WORK.map(([id, label, icon]) => (
        <Fragment key={id}>
          <a
            className={cn(NAV, "pl-5")}
            href={projectHref(project.key, id)}
            aria-current={current(section === id && (id !== "chat" || chatId === null))}
          >
            <Icon name={icon} />
            {label}
            {id === "chat" && chatCount > 0 && (
              <span className={COUNT}>
                {chatCount >= COUNTED_CHATS ? `${COUNTED_CHATS}+` : chatCount}
              </span>
            )}
            {id === "runs" && project.overview.activeRuns > 0 && (
              <span className={COUNT}>{project.overview.activeRuns} active</span>
            )}
          </a>
          {id === "chat" && (
            <div className={NESTED}>
              <a
                className={cn(NAV, NESTED_ROW, "font-heading text-foreground")}
                href={projectHref(project.key, "chat", "new")}
                aria-current={current(chatId === "new")}
              >
                <Icon name="new" size={13} />
                New chat
              </a>
              {chats?.slice(0, SIDEBAR_CHATS).map((session) => (
                <a
                  key={session.id}
                  className={cn(NAV, NESTED_ROW)}
                  href={projectHref(project.key, "chat", session.id)}
                  aria-current={current(chatId === session.id)}
                  title={session.title}
                >
                  <Dot tone={STATE_TONE[session.state]} />
                  <span className="min-w-0 truncate">{session.title}</span>
                </a>
              ))}
            </div>
          )}
          {id === "runs" && (
            <div className={NESTED}>
              <a
                className={cn(NAV, NESTED_ROW)}
                href={projectHref(project.key, "acceptance")}
                aria-current={current(section === "acceptance")}
              >
                <Icon name="acceptance" size={13} />
                Acceptance
              </a>
            </div>
          )}
        </Fragment>
      ))}
      <p className={cn(LABEL, "pt-2 pr-2.5 pb-1 pl-5 text-[11px]")}>Setup</p>
      {SETUP.map(([id, label, icon]) => (
        <a
          key={id}
          className={cn(NAV, "pl-5")}
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
    <nav
      className="flex w-62 flex-none flex-col gap-4 overflow-y-auto border-r-[3px] border-border bg-sidebar px-3 py-3.5"
      aria-label="Main"
    >
      <div className="flex flex-col gap-0.5">
        <a
          className={NAV}
          href={href({ name: "attention" })}
          aria-current={current(route.name === "attention")}
        >
          <Icon name="attention" />
          Needs you
          {blocking > 0 && (
            <Badge tone="err" className="ml-auto">
              {blocking}
            </Badge>
          )}
        </a>
        <a
          className={NAV}
          href={href({ name: "projects" })}
          aria-current={current(route.name === "projects")}
        >
          <Icon name="projects" />
          All projects
        </a>
      </div>
      <div className="flex flex-col gap-0.5">
        <p className={GROUP_LABEL}>Projects</p>
        {shown.map((project) => (
          <ProjectEntry key={project.key} project={project} route={route} />
        ))}
        <button type="button" className={NAV} onClick={() => void addFolder()}>
          <Icon name="new" />
          Open folder…
        </button>
      </div>
      <div className="mt-auto flex flex-col gap-0.5 border-t-2 border-border pt-2.5">
        <a
          className={NAV}
          href={href({ name: "settings", section: "app" })}
          aria-current={current(route.name === "settings")}
        >
          <Icon name="settings" />
          Settings
        </a>
        <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-dim-foreground">
          <Dot tone={failed > 0 ? "err" : running > 0 ? "ok" : ""} />
          {failed > 0
            ? `${failed} project${failed === 1 ? "" : "s"} stopped`
            : `${running} project${running === 1 ? "" : "s"} running`}
        </div>
      </div>
    </nav>
  );
}
