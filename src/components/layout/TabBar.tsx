import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../core/theme/index.js";
import { artPalette } from "../../core/utils/bake-art.js";
import { getModeLabel } from "../../hooks/useBakeMode.js";
import type { Tab, TabActivity } from "../../hooks/useTabs.js";
import { useTerminalDimensions } from "../../hooks/useTerminalEvents.js";
import type { BakeMode } from "../../types/index.js";
import { isCompactTerminal } from "./compact.js";
import { Spinner } from "./shared.js";

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string;
  onSwitch: (id: string) => void;
  getActivity: (id: string) => TabActivity;
  getMode: (id: string) => BakeMode;
  getModelLabel: (id: string) => string | null;
}

export function TabBar({
  tabs,
  activeTabId,
  onSwitch,
  getActivity,
  getMode,
  getModelLabel,
}: TabBarProps) {
  const t = useTheme();
  const { width, height } = useTerminalDimensions();
  if (isCompactTerminal(width, height)) {
    return (
      <CompactTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSwitch={onSwitch}
        getActivity={getActivity}
      />
    );
  }
  const tabWidth = Math.max(4, Math.floor((width - 2) / Math.max(1, tabs.length)));
  return (
    <box flexShrink={0} paddingX={1} height={2} flexDirection="row" backgroundColor={t.bgApp}>
      {tabs.map((tab, index) => {
        const active = tab.id === activeTabId;
        const activity = getActivity(tab.id);
        const busy = activity.isLoading || activity.isCompacting;
        const bg = active ? t.bgPopupHighlight : t.bgElevated;
        const status = tabStatus(activity);
        const statusColor = activity.needsAttention
          ? t.warning
          : activity.hasError
            ? t.error
            : t.brand;
        const label = /^(Tab \d+|TAB-\d+)$/.test(tab.label) ? "New tab" : tab.label;
        const model = getModelLabel(tab.id);
        const detail = active && tabWidth >= 35 ? (model ?? getModeLabel(getMode(tab.id))) : null;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes provide terminal mouse targets; keyboard navigation is owned by the parent.
          <box
            key={tab.id}
            id={`workspace-tab-${tab.id}`}
            width={tabWidth}
            flexShrink={0}
            flexDirection="column"
            backgroundColor={bg}
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              onSwitch(tab.id);
            }}
          >
            <box flexDirection="row" paddingX={1} height={1}>
              <text fg={active ? t.brand : t.textMuted} flexShrink={0}>
                {index + 1}{" "}
              </text>
              <text
                fg={active ? t.textPrimary : t.textSecondary}
                attributes={active ? 1 : undefined}
                flexGrow={1}
                minWidth={0}
                wrapMode="none"
                truncate
              >
                {label}
              </text>
              {detail && (
                <text
                  fg={t.textMuted}
                  width={Math.min(20, Math.floor(tabWidth / 3))}
                  wrapMode="none"
                  truncate
                >
                  {" "}
                  {detail}
                </text>
              )}
              {activity.editedFileCount > 0 && tabWidth >= 24 && (
                <text fg={t.success}> +{activity.editedFileCount}</text>
              )}
              {status ? (
                <text fg={statusColor}> {status}</text>
              ) : busy ? (
                <Spinner color={t.brand} />
              ) : null}
            </box>
            <text fg={active ? t.brand : t.border} height={1}>
              {"━".repeat(tabWidth - 1)}
            </text>
          </box>
        );
      })}
    </box>
  );
}

function tabStatus(activity: TabActivity): "?" | "!" | "●" | "" {
  if (activity.needsAttention) return "?";
  if (activity.hasError) return "!";
  return activity.hasUnread ? "●" : "";
}

/** Below 80x24: one row of numbered tabs, the active one as a filled chip. */
function CompactTabBar({
  tabs,
  activeTabId,
  onSwitch,
  getActivity,
}: Pick<TabBarProps, "tabs" | "activeTabId" | "onSwitch" | "getActivity">) {
  const t = useTheme();
  const palette = artPalette(t);
  return (
    <box flexShrink={0} paddingX={1} height={1} flexDirection="row" gap={1}>
      {tabs.map((tab, index) => {
        const active = tab.id === activeTabId;
        const activity = getActivity(tab.id);
        const busy = activity.isLoading || activity.isCompacting;
        const status = tabStatus(activity);
        const statusColor = activity.needsAttention
          ? t.warning
          : activity.hasError
            ? t.error
            : t.brand;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes provide terminal mouse targets; keyboard navigation is owned by the parent.
          <box
            key={tab.id}
            id={`workspace-tab-${tab.id}`}
            flexDirection="row"
            flexShrink={0}
            height={1}
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              onSwitch(tab.id);
            }}
          >
            <text
              wrapMode="none"
              fg={active ? palette.onFill : t.textSecondary}
              bg={active ? palette.fill : t.bgElevated}
              attributes={active ? TextAttributes.BOLD : undefined}
            >
              {` ${String(index + 1)} `}
            </text>
            {status ? (
              <text fg={statusColor}>{status}</text>
            ) : busy ? (
              <Spinner color={t.brand} />
            ) : null}
          </box>
        );
      })}
    </box>
  );
}
