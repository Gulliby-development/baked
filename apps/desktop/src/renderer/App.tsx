import { isMock } from "./client/bridge.js";
import { Sidebar } from "./components/Sidebar.js";
import { TitleBar } from "./components/TitleBar.js";
import { Alert } from "./components/ui/alert.js";
import { TitleTooltips } from "./components/ui/title-tooltips.js";
import { useRoute } from "./router.js";
import { AttentionScreen } from "./screens/AttentionScreen.js";
import { ProjectScreen } from "./screens/ProjectScreen.js";
import { ProjectsScreen } from "./screens/ProjectsScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";
import { useDesktop } from "./store.js";

export function App() {
  const route = useRoute();
  const { error } = useDesktop();
  return (
    <div className="m-0 flex h-full flex-col overflow-hidden rounded-[var(--radius-lg)] border-2 border-border bg-background shadow-shadow">
      <TitleBar />
      <div className="flex min-h-0 min-w-0 flex-1">
        <Sidebar route={route} />
        <main className="relative min-w-0 flex-1 overflow-auto [&:has(>[data-chat])]:flex [&:has(>[data-chat])]:flex-col [&:has(>[data-chat])]:overflow-hidden">
          {isMock && (
            <Alert className="rounded-none border-0 border-b">
              Preview with sample data: no BAKED backend is connected.
            </Alert>
          )}
          {error && (
            <Alert tone="error" role="alert" className="mx-7 mt-3">
              {error}
            </Alert>
          )}
          {route.name === "projects" && <ProjectsScreen />}
          {route.name === "attention" && (
            <AttentionScreen projectKey={route.key} itemId={route.id} />
          )}
          {route.name === "project" && (
            <ProjectScreen projectKey={route.key} section={route.section} id={route.id} />
          )}
          {route.name === "settings" && (
            <SettingsScreen section={route.section} page={route.page ?? null} />
          )}
        </main>
      </div>
      <TitleTooltips />
    </div>
  );
}
