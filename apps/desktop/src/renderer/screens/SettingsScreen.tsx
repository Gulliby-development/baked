import type { AppSettings } from "../../shared/api.js";
import { href, type SettingsSection } from "../router.js";
import { useDesktop } from "../store.js";

function Toggle({ label, field }: { label: string; field: keyof AppSettings }) {
  const { settings, updateSettings } = useDesktop();
  if (!settings) return null;
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={settings[field] === true}
        onChange={(e) => void updateSettings({ [field]: e.target.checked })}
      />
      {label}
    </label>
  );
}

function AppSection() {
  const { settings, updateSettings } = useDesktop();
  if (!settings) return null;
  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        <h1>Appearance and behavior</h1>
        <span className="lede">
          Stored by the desktop app on this computer. Agents and runs never read these.
        </span>
      </div>
      <section
        className="card"
        aria-label="Appearance"
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        <div className="field">
          <span>Theme</span>
          <fieldset className="seg-group" aria-label="Theme">
            {(["system", "dark", "light"] as const).map((theme) => (
              <button
                key={theme}
                type="button"
                className="seg"
                aria-pressed={settings.theme === theme}
                onClick={() => void updateSettings({ theme })}
              >
                {theme}
              </button>
            ))}
          </fieldset>
        </div>
        <div className="field">
          <span>Density</span>
          <fieldset className="seg-group" aria-label="Density">
            {(["comfortable", "compact"] as const).map((density) => (
              <button
                key={density}
                type="button"
                className="seg"
                aria-pressed={settings.density === density}
                onClick={() => void updateSettings({ density })}
              >
                {density}
              </button>
            ))}
          </fieldset>
        </div>
      </section>
      <section
        className="card"
        aria-label="Behavior"
        style={{ display: "flex", flexDirection: "column", gap: 4 }}
      >
        <Toggle field="openLastProjects" label="Open the last projects on start" />
        <Toggle
          field="keepRunningInTray"
          label="Keep runs going in the tray when the window closes"
        />
        <Toggle field="notifyBlocking" label="System notification when something needs me" />
        <Toggle field="notifyAdvisory" label="Also notify for advisory items" />
      </section>
      <section
        className="card"
        aria-label="Backend"
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        <div className="field">
          <label htmlFor="baked-path">BAKED executable</label>
          <input
            id="baked-path"
            type="text"
            placeholder="bundled"
            defaultValue={settings.bakedPath ?? ""}
            onBlur={(e) => void updateSettings({ bakedPath: e.target.value.trim() || null })}
            style={{ minWidth: 320 }}
          />
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          Each open project runs its own <span className="mono">baked serve</span> on 127.0.0.1.
          Leave empty to use the one bundled with the app; a change applies to projects opened
          afterwards.
        </span>
      </section>
    </>
  );
}

export function SettingsScreen({ section }: { section: SettingsSection }) {
  return (
    <div className="shell" style={{ height: "auto", minHeight: "100%" }}>
      <nav
        aria-label="Settings"
        style={{
          flex: "0 0 220px",
          borderRight: "1px solid var(--line)",
          padding: "22px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <p className="label" style={{ padding: "0 10px 2px" }}>
          This app
        </p>
        <span className="muted" style={{ padding: "0 10px 6px", fontSize: 12 }}>
          this computer only
        </span>
        <a
          className="nav"
          href={href({ name: "settings", section: "app" })}
          aria-current={section === "app" ? "page" : undefined}
        >
          Appearance and behavior
        </a>
        <p className="label" style={{ padding: "16px 10px 2px" }}>
          All projects
        </p>
        <span className="muted mono" style={{ padding: "0 10px 6px", fontSize: 12 }}>
          ~/.baked/config.json
        </span>
        <a
          className="nav"
          href={href({ name: "settings", section: "global" })}
          aria-current={section === "global" ? "page" : undefined}
        >
          Providers and model routing
        </a>
      </nav>
      <div className="page" style={{ flex: 1, maxWidth: 900 }}>
        {section === "app" ? (
          <AppSection />
        ) : (
          <>
            <h1>All projects</h1>
            <div className="empty">
              Providers, model routing, global commands and telemetry come in a later desktop pull
              request.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
