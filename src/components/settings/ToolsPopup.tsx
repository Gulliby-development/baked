import { useEffect, useMemo, useState } from "react";
import { getToolCatalog } from "../../core/tools/constants.js";
import { useKeyboard, useTerminalDimensions } from "../../hooks/useTerminalEvents.js";
import {
  buildGroupedRows,
  type GroupedItem,
  GroupedList,
  type GroupedListGroup,
  handleCursorNavKey,
  PremiumPopup,
  Section,
} from "../ui/index.js";
import { fitPopupHeight, fitPopupWidth } from "../ui/popup-geometry.js";

interface ToolItem extends GroupedItem {
  toolName: string;
}

interface Props {
  visible: boolean;
  disabledTools: Set<string>;
  onToggleTool: (name: string) => void;
  onClose: () => void;
}

export function ToolsPopup({ visible, disabledTools, onToggleTool, onClose }: Props) {
  const { width: tw, height: th } = useTerminalDimensions();
  const [cursor, setCursor] = useState(0);

  // Re-evaluated each render so installing/removing an addon updates the popup without restart.
  const catalog = useMemo(() => getToolCatalog(), []);

  useEffect(() => {
    if (visible) setCursor(0);
  }, [visible]);

  const popupW = fitPopupWidth(Math.min(110, Math.max(72, tw - 4)), tw);
  const popupH = fitPopupHeight(Math.min(32, Math.max(16, th - 4)), th);
  const contentW = Math.max(1, popupW - 6);

  const groups = useMemo<GroupedListGroup<ToolItem>[]>(() => {
    return [
      {
        id: "tools",
        label: "Tools",
        hideHeader: true,
        items: Object.entries(catalog).map(([name, desc]) => ({
          id: name,
          toolName: name,
          label: name,
          meta: desc,
          active: !disabledTools.has(name),
        })),
      },
    ];
  }, [disabledTools, catalog]);

  const rows = useMemo(() => buildGroupedRows(groups, new Set(["tools"])), [groups]);

  useKeyboard((evt) => {
    if (!visible) return;
    if (evt.name === "escape" || evt.name === "q") {
      onClose();
      evt.preventDefault();
      return;
    }
    if (evt.name === "return" || evt.name === "space") {
      const r = rows[cursor];
      if (r?.kind === "item" && r.item) {
        onToggleTool((r.item as ToolItem).toolName);
      }
      evt.preventDefault();
      return;
    }
    handleCursorNavKey(evt, setCursor, rows.length);
    evt.preventDefault();
  });

  if (!visible) return null;

  const enabled = Object.keys(catalog).filter((n) => !disabledTools.has(n)).length;
  const total = Object.keys(catalog).length;

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title="Tools"
      titleIcon="tools"
      blurb={`${enabled} / ${total} enabled`}
      footerHints={[
        { key: "↑↓", label: "nav" },
        { key: "Space", label: "toggle" },
        { key: "Esc", label: "close" },
      ]}
    >
      <Section>
        <GroupedList
          groups={groups}
          expanded={new Set(["tools"])}
          selectedIndex={cursor}
          width={contentW}
          maxRows={Math.max(6, popupH - 9)}
        />
      </Section>
    </PremiumPopup>
  );
}
