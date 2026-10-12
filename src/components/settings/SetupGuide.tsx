import { useCallback, useState } from "react";
import { spawnShell } from "../../core/platform/index.js";
import {
  checkPrerequisites,
  getInstallCommands,
  type PrerequisiteStatus,
} from "../../core/setup/prerequisites.js";
import { spinnerGlyph } from "../../core/utils/spinner.js";
import { useKeyboard, useTerminalDimensions } from "../../hooks/useTerminalEvents.js";
import {
  buildGroupedRows,
  type GroupedItem,
  GroupedList,
  type GroupedListGroup,
  Hint,
  PremiumPopup,
  Section,
  VSpacer,
} from "../ui/index.js";
import { fitPopupWidth, popupContentWidth } from "../ui/popup-geometry.js";

const MAX_POPUP_WIDTH = 100;
const CHROME_ROWS = 10;

interface Props {
  visible: boolean;
  onClose: () => void;
  onSystemMessage: (msg: string) => void;
}

export function SetupGuide({ visible, onClose, onSystemMessage }: Props) {
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const containerRows = termRows - 2;
  const popupWidth = fitPopupWidth(
    Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.85)),
    termCols,
  );
  const contentW = popupContentWidth(popupWidth, 22);
  const maxVisible = Math.max(4, Math.floor(containerRows * 0.85) - CHROME_ROWS);
  const [statuses, setStatuses] = useState<PrerequisiteStatus[]>(() => checkPrerequisites());
  const [cursor, setCursor] = useState(0);
  const [installing, setInstalling] = useState<string | null>(null);

  const adjustScroll = (_next: number) => {};

  const refresh = useCallback(() => {
    setStatuses(checkPrerequisites());
  }, []);

  const installSelected = useCallback(() => {
    const item = statuses[cursor];
    if (!item || item.installed) return;

    const cmds = getInstallCommands(item.prerequisite.name);
    const cmd = cmds.find((c) => !c.startsWith("#") && c.trim().length > 0);
    if (!cmd) {
      onSystemMessage(
        `No auto-install command for ${item.prerequisite.name}. Manual steps:\n${cmds.join("\n")}`,
      );
      return;
    }

    setInstalling(item.prerequisite.name);
    onSystemMessage(`Installing ${item.prerequisite.name}...`);

    const proc = spawnShell(cmd, { stdio: "pipe" });
    const chunks: string[] = [];
    proc.stdout?.on("data", (d: Buffer) => chunks.push(d.toString()));
    proc.stderr?.on("data", (d: Buffer) => chunks.push(d.toString()));
    proc.on("close", (code) => {
      setInstalling(null);
      if (code === 0) {
        onSystemMessage(`${item.prerequisite.name} installed successfully.`);
      } else {
        onSystemMessage(
          `Failed to install ${item.prerequisite.name}:\n${chunks.join("").slice(0, 200)}`,
        );
      }
      refresh();
    });
    proc.on("error", () => {
      setInstalling(null);
      onSystemMessage(`Failed to run install command. Try manually:\n${cmd}`);
    });
  }, [statuses, cursor, onSystemMessage, refresh]);

  useKeyboard((evt) => {
    if (!visible) return;
    if (installing) {
      evt.preventDefault();
      return;
    }

    if (evt.name === "escape") {
      onClose();
      evt.preventDefault();
      return;
    }
    if (evt.name === "up" || evt.name === "k") {
      setCursor((p) => {
        const next = p > 0 ? p - 1 : statuses.length - 1;
        adjustScroll(next);
        return next;
      });
      return;
    }
    if (evt.name === "down" || evt.name === "j") {
      setCursor((p) => {
        const next = p < statuses.length - 1 ? p + 1 : 0;
        adjustScroll(next);
        return next;
      });
      return;
    }
    if (evt.name === "return" || evt.name === "i") {
      installSelected();
      return;
    }
    if (evt.name === "r") {
      refresh();
      return;
    }
    if (evt.name === "a") {
      const missing = statuses.filter((s) => !s.installed);
      if (missing.length === 0) return;
      const cmds: string[] = [];
      for (const s of missing) {
        const c = getInstallCommands(s.prerequisite.name).find(
          (l) => !l.startsWith("#") && l.trim().length > 0,
        );
        if (c) cmds.push(c);
      }
      if (cmds.length === 0) return;
      setInstalling("all");
      onSystemMessage(`Installing ${String(cmds.length)} prerequisites...`);
      const fullCmd = cmds.join(" && ");
      const proc = spawnShell(fullCmd, { stdio: "pipe" });
      proc.on("close", (code) => {
        setInstalling(null);
        onSystemMessage(
          code === 0
            ? "All prerequisites installed!"
            : "Some installs may have failed. Run /setup to check.",
        );
        refresh();
      });
      proc.on("error", () => {
        setInstalling(null);
        onSystemMessage("Failed to run install commands.");
      });
    }
  });

  if (!visible) return null;

  const allInstalled = statuses.every((s) => s.installed);
  const missingCount = statuses.filter((s) => !s.installed).length;

  const footerHints = [
    { key: "⏎", label: "install" },
    ...[{ key: "a", label: "install all" }],
    { key: "r", label: "refresh" },
    { key: "esc", label: "close" },
  ];

  return (
    <PremiumPopup
      visible={visible}
      width={popupWidth}
      height={Math.min(Math.max(18, Math.floor(termRows * 0.85)), termRows - 2)}
      title="baked Setup"
      titleIcon="ghost"
      footerHints={footerHints}
    >
      {
        <Section>
          <Hint kind={allInstalled ? "tip" : "warn"}>
            {allInstalled
              ? "All prerequisites are installed"
              : `${String(missingCount)} missing — select to install`}
          </Hint>
          <VSpacer />
          {(() => {
            const toolGroups: GroupedListGroup<GroupedItem>[] = [
              {
                id: "tools",
                label: "Tools",
                hideHeader: true,
                items: statuses.map((s) => ({
                  id: s.prerequisite.name,
                  label: s.prerequisite.name,
                  meta: s.installed
                    ? "installed"
                    : s.prerequisite.required
                      ? "required"
                      : "optional",
                  keyHint: s.installed ? "✓" : s.prerequisite.required ? "✗" : "○",
                  disabled: s.installed,
                })),
              },
            ];
            const rows = buildGroupedRows(toolGroups, new Set(["tools"]));
            const selIdx = rows.findIndex((r) => r.kind === "item" && r.itemIndex === cursor);
            return (
              <GroupedList
                groups={toolGroups}
                expanded={new Set(["tools"])}
                selectedIndex={selIdx}
                width={contentW}
                maxRows={maxVisible}
              />
            );
          })()}
        </Section>
      }

      {installing && (
        <Hint>
          {spinnerGlyph(0)} Installing {installing}...
        </Hint>
      )}
    </PremiumPopup>
  );
}
