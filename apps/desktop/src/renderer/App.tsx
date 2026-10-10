import { isMock } from "./client/bridge.js";
import { Rail } from "./components/Rail.js";
import { useSidebarExpanded } from "./components/rail-state.js";
import { Sidebar } from "./components/Sidebar.js";
import { useRoute } from "./router.js";
import { AttentionScreen } from "./screens/AttentionScreen.js";
import { ProjectScreen } from "./screens/ProjectScreen.js";
import { ProjectsScreen } from "./screens/ProjectsScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";
import { useDesktop } from "./store.js";

export function App() {
  const route = useRoute();
  const { error } = useDesktop();
  const expanded = useSidebarExpanded();
  return (
    <div className="shell">
      {route.name === "project" && route.section === "chat" && !expanded ? (
        <Rail route={route} />
      ) : (
        <Sidebar route={route} />
      )}
      <main className="main">
        {isMock && (
          <div className="banner" style={{ borderRadius: 0, borderWidth: "0 0 1px" }}>
            Preview with sample data: no BAKED backend is connected.
          </div>
        )}
        {error && (
          <div className="banner error" role="alert" style={{ margin: "12px 28px 0" }}>
            {error}
          </div>
        )}
        {route.name === "projects" && <ProjectsScreen />}
        {route.name === "attention" && <AttentionScreen />}
        {route.name === "project" && (
          <ProjectScreen projectKey={route.key} section={route.section} id={route.id} />
        )}
        {route.name === "settings" && <SettingsScreen section={route.section} />}
      </main>
    </div>
  );
}
