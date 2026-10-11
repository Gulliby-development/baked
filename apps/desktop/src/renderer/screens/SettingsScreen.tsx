import { SETTING_PAGES } from "../../../../../src/core/settings/schema.js";
import type { AppSettings } from "../../shared/api.js";
import { Segment, SegmentGroup } from "../components/ui/segmented.js";
import { cn } from "../lib/cn.js";
import { CHECK, FIELD, LABEL, LEDE, PAGE, PANEL, STACK } from "../lib/styles.js";
import { href, type SettingsSection } from "../router.js";
import { useDesktop } from "../store.js";
import { ChatSettings } from "./setup/ChatSettings.js";
import { GlobalSettings } from "./setup/GlobalSettings.js";

/** A section link of the settings menu; the current one is raised with an ink outline. */
const NAV =
  "flex min-h-(--row) w-full cursor-pointer items-center gap-[10px] rounded-[6px] border-0 bg-transparent px-[10px] py-[6px] text-left text-[14px] text-soft-foreground no-underline hover:bg-hover hover:text-foreground aria-[current=page]:bg-selected aria-[current=page]:font-semibold aria-[current=page]:text-foreground aria-[current=page]:shadow-[inset_0_0_0_var(--border-w)_var(--ink),var(--shadow-sm)]";

/** The All projects pages, one per part of `~/.baked/config.json`. */
const GLOBAL_PAGES: [Exclude<SettingsSection, "app" | "chat">, string][] = [
  ["providers", "Providers and keys"],
  ["routing", "Model routing"],
  ["commands", "Global commands"],
  ["notifications", "Run notifications"],
  ["telemetry", "Telemetry"],
];

function Toggle({ label, field }: { label: string; field: keyof AppSettings }) {
  const { settings, updateSettings } = useDesktop();
  if (!settings) return null;
  return (
    <label className={CHECK}>
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
      <div className={cn(STACK, "gap-1")}>
        <h1>Appearance and behavior</h1>
        <span className={LEDE}>
          Stored by the desktop app on this computer. Agents and runs never read these.
        </span>
      </div>
      <section className={cn(PANEL, "flex flex-col gap-[10px]")} aria-label="Appearance">
        <div className={FIELD}>
          <span>Theme</span>
          <SegmentGroup aria-label="Theme">
            {(["system", "dark", "light"] as const).map((theme) => (
              <Segment
                key={theme}
                aria-pressed={settings.theme === theme}
                onClick={() => void updateSettings({ theme })}
              >
                {theme}
              </Segment>
            ))}
          </SegmentGroup>
        </div>
        <div className={FIELD}>
          <span>Density</span>
          <SegmentGroup aria-label="Density">
            {(["comfortable", "compact"] as const).map((density) => (
              <Segment
                key={density}
                aria-pressed={settings.density === density}
                onClick={() => void updateSettings({ density })}
              >
                {density}
              </Segment>
            ))}
          </SegmentGroup>
        </div>
      </section>
      <section className={cn(PANEL, "flex flex-col gap-1")} aria-label="Behavior">
        <Toggle field="openLastProjects" label="Open the last projects on start" />
        <Toggle
          field="keepRunningInTray"
          label="Keep runs going in the tray when the window closes"
        />
        <Toggle field="notifyBlocking" label="System notification when something needs me" />
        <Toggle field="notifyAdvisory" label="Also notify for advisory items" />
      </section>
      <section className={cn(PANEL, "flex flex-col gap-2")} aria-label="Backend">
        <div className={FIELD}>
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
        <span className="text-[12px] text-dim-foreground">
          Each open project runs its own <span className="font-mono">baked serve</span> on
          127.0.0.1. Leave empty to use the one bundled with the app; a change applies to projects
          opened afterwards.
        </span>
      </section>
    </>
  );
}

export function SettingsScreen({
  section,
  page,
}: {
  section: SettingsSection;
  /** The chat settings page, when `section` is `chat`. */
  page: string | null;
}) {
  const chatPage = section === "chat" ? (page ?? SETTING_PAGES[0]?.id ?? null) : null;
  return (
    <div className="flex min-h-full min-w-0 flex-1">
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
        <p className={cn(LABEL, "px-[10px] pt-0 pb-[2px]")}>This app</p>
        <span className="px-[10px] pt-0 pb-[6px] text-[12px] text-dim-foreground">
          this computer only
        </span>
        <a
          className={NAV}
          href={href({ name: "settings", section: "app" })}
          aria-current={section === "app" ? "page" : undefined}
        >
          Appearance and behavior
        </a>
        <p className={cn(LABEL, "px-[10px] pt-4 pb-[2px]")}>Chat</p>
        <span className="px-[10px] pt-0 pb-[6px] text-[12px] text-dim-foreground">
          all projects or one project
        </span>
        {SETTING_PAGES.map((chatSettings) => (
          <a
            key={chatSettings.id}
            className={NAV}
            href={href({ name: "settings", section: "chat", page: chatSettings.id })}
            aria-current={chatPage === chatSettings.id ? "page" : undefined}
          >
            {chatSettings.title}
          </a>
        ))}
        <p className={cn(LABEL, "px-[10px] pt-4 pb-[2px]")}>All projects</p>
        <span className="px-[10px] pt-0 pb-[6px] font-mono text-[12px] text-dim-foreground">
          ~/.baked/config.json
        </span>
        {GLOBAL_PAGES.map(([page, label]) => (
          <a
            key={page}
            className={NAV}
            href={href({ name: "settings", section: page })}
            aria-current={section === page ? "page" : undefined}
          >
            {label}
          </a>
        ))}
      </nav>
      <div className={cn(PAGE, "max-w-[900px] flex-1")}>
        {section === "app" ? (
          <AppSection />
        ) : section === "chat" ? (
          <ChatSettings page={chatPage} />
        ) : (
          <GlobalSettings section={section} />
        )}
      </div>
    </div>
  );
}
