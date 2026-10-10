import { initial, projectLine } from "../format.js";
import { href, type ProjectSection, projectHref, type Route } from "../router.js";
import { useDesktop } from "../store.js";
import { Icon, type IconName } from "./Icon.js";
import { setSidebarExpanded } from "./rail-state.js";

/** How many other projects the rail shows as tiles. */
const RAIL_PROJECTS = 5;

const SECTIONS: [ProjectSection, string, IconName][] = [
  ["chat", "Chat", "chat"],
  ["runs", "Runs", "runs"],
  ["gates", "Gates and checks", "gate"],
  ["instructions", "Instructions", "file"],
];

/** The narrow sidebar of the chat screen: project tiles, Needs you and the project's sections. */
export function Rail({ route }: { route: Extract<Route, { name: "project" }> }) {
  const { projects, attention } = useDesktop();
  const current = projects.find((p) => p.key === route.key);
  const others = projects
    .filter((p) => p.key !== route.key && (p.open || p.pinned))
    .slice(0, RAIL_PROJECTS);
  const blocking = attention.filter((item) => item.blocking).length;
  return (
    <nav className="rail" aria-label="Main">
      {current && (
        <a
          className="rail-item"
          href={projectHref(current.key)}
          aria-label={`${current.name} overview`}
          title={`${current.name} overview`}
        >
          <span className="rail-tile current">{initial(current.name)}</span>
        </a>
      )}
      {others.map((project) => {
        const label = `Switch to ${project.name}, ${projectLine(project)}`;
        return (
          <a
            key={project.key}
            className="rail-item"
            href={projectHref(project.key, "chat")}
            aria-label={label}
            title={label}
          >
            <span className="rail-tile">{initial(project.name)}</span>
            {project.overview.attention > 0 && <span className="rail-dot" />}
          </a>
        );
      })}
      <a
        className="rail-item"
        href={href({ name: "projects" })}
        aria-label="All projects"
        title="All projects"
      >
        <Icon name="grid" size={16} />
      </a>
      <span className="rail-rule" />
      <a
        className="rail-item"
        href={href({ name: "attention" })}
        aria-label={blocking > 0 ? `Needs you, ${blocking} items` : "Needs you"}
        title="Needs you"
      >
        <Icon name="bell" size={18} />
        {blocking > 0 && <span className="rail-dot" />}
      </a>
      {SECTIONS.map(([section, label, icon]) => (
        <a
          key={section}
          className="rail-item"
          href={projectHref(route.key, section)}
          aria-label={label}
          title={label}
          aria-current={route.section === section ? "page" : undefined}
        >
          <Icon name={icon} size={18} />
        </a>
      ))}
      <button
        type="button"
        className="rail-item"
        style={{ marginTop: "auto" }}
        aria-label="Expand the sidebar"
        title="Expand the sidebar"
        onClick={() => setSidebarExpanded(true)}
      >
        <Icon name="panel" size={18} />
      </button>
      <a
        className="rail-item"
        href={href({ name: "settings", section: "app" })}
        aria-label="Settings"
        title="Settings"
      >
        <Icon name="gear" size={18} />
      </a>
    </nav>
  );
}
