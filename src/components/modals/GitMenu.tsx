import { useEffect, useRef, useState } from "react";
import { graphText, readGitGraph } from "../../core/git/graph.js";
import { type GitMenuAction, runGitMenuAction } from "../../core/git/menu.js";
import { getGitLog } from "../../core/git/status.js";
import { useKeyboard, useTerminalDimensions } from "../../hooks/useTerminalEvents.js";
import { selectHasDialog, useDialogStore } from "../../stores/dialog.js";
import { confirm } from "../ui/dialogs/index.js";
import {
  buildGroupedRows,
  type GroupedItem,
  GroupedList,
  type GroupedListGroup,
  PremiumPopup,
  Section,
} from "../ui/index.js";
import { fitPopupWidth } from "../ui/popup-geometry.js";

interface MenuItem extends GroupedItem {
  action: string;
}

const MENU_ITEMS: MenuItem[] = [
  { id: "commit", keyHint: "c", label: "Commit", meta: "open commit form", action: "commit" },
  { id: "push", keyHint: "p", label: "Push", meta: "git push", action: "push" },
  { id: "pull", keyHint: "u", label: "Pull", meta: "git pull", action: "pull" },
  { id: "stash", keyHint: "s", label: "Stash", meta: "stash uncommitted changes", action: "stash" },
  {
    id: "pop",
    keyHint: "o",
    label: "Stash Pop",
    meta: "restore latest stash",
    action: "stash-pop",
  },
  { id: "log", keyHint: "l", label: "Log", meta: "show recent commits", action: "log" },
  { id: "graph", keyHint: "g", label: "Graph", meta: "branches and merges", action: "graph" },
  {
    id: "force-push",
    keyHint: "f",
    label: "Force Push",
    meta: "git push --force-with-lease (confirms)",
    action: "force-push",
  },
  {
    id: "reset-hard",
    keyHint: "r",
    label: "Reset Hard",
    meta: "discard uncommitted changes (confirms)",
    action: "reset-hard",
  },
];

const GROUPS: GroupedListGroup<MenuItem>[] = [
  { id: "actions", label: "Actions", hideHeader: true, items: MENU_ITEMS },
];

interface Props {
  visible: boolean;
  cwd: string;
  onClose: () => void;
  onCommit: () => void;
  onSystemMessage: (msg: string) => void;
  onRefresh: () => void;
}

export function GitMenu({ visible, cwd, onClose, onCommit, onSystemMessage, onRefresh }: Props) {
  const { width: tw } = useTerminalDimensions();
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const cursorRef = useRef(0);
  cursorRef.current = cursor;
  const busyRef = useRef(false);
  busyRef.current = busy;

  useEffect(() => {
    if (visible) setCursor(0);
  }, [visible]);

  const rows = buildGroupedRows(GROUPS, new Set(["actions"]));

  const report = async (action: GitMenuAction, pending?: string): Promise<void> => {
    onClose();
    if (pending) onSystemMessage(pending);
    const r = await runGitMenuAction(cwd, action);
    onSystemMessage(r.message);
    onRefresh();
  };

  const run = async (action: string) => {
    switch (action) {
      case "commit":
        onClose();
        onCommit();
        return;
      case "push":
        return report({ action: "push" }, "Pushing...");
      case "pull":
        return report({ action: "pull" }, "Pulling...");
      case "stash":
        return report({ action: "stash" });
      case "stash-pop":
        return report({ action: "stash-pop" });
      case "log": {
        onClose();
        const entries = await getGitLog(cwd, 20);
        if (entries.length === 0) onSystemMessage("No commits found.");
        else {
          onSystemMessage(entries.map((e) => `${e.hash} ${e.subject} (${e.date})`).join("\n"));
        }
        return;
      }
      case "graph": {
        onClose();
        const graph = await readGitGraph(cwd, 40);
        if (graph.commits.length === 0) onSystemMessage("No commits found.");
        else {
          onSystemMessage(
            graph.commits
              .map((c) => {
                const refs = c.refs.filter((r) => r.kind !== "head").map((r) => `[${r.name}]`);
                return `${graphText(c, graph.lanes)}  ${c.short} ${[...refs, c.subject].join(" ")}`;
              })
              .join("\n"),
          );
        }
        return;
      }
      case "force-push": {
        const ok = await confirm({
          title: "Force-push to remote?",
          message:
            "git push --force-with-lease will overwrite the remote branch. Other contributors' commits may be discarded.",
          danger: true,
        });
        if (!ok) return;
        return report({ action: "force-push" }, "Force-pushing (with lease)…");
      }
      case "reset-hard": {
        const ok = await confirm({
          title: "Reset working tree?",
          message:
            "git reset --hard HEAD will discard all uncommitted changes. Untracked files are kept.",
          danger: true,
        });
        if (!ok) return;
        return report({ action: "reset-hard" }, "Resetting working tree…");
      }
    }
  };

  const hasDialog = useDialogStore(selectHasDialog);

  useKeyboard((evt) => {
    if (!visible || busyRef.current) return;
    // A confirm/alert/select sits on top — it owns the keyboard.
    if (hasDialog) return;

    if (evt.name === "escape") {
      onClose();
      evt.preventDefault();
      return;
    }
    if (evt.name === "return") {
      const r = rows[cursorRef.current];
      if (r?.kind === "item" && r.item) {
        setBusy(true);
        void run((r.item as MenuItem).action).finally(() => setBusy(false));
      }
      evt.preventDefault();
      return;
    }
    if (evt.name === "up" || evt.name === "k") {
      setCursor((c) => (c > 0 ? c - 1 : MENU_ITEMS.length - 1));
      evt.preventDefault();
      return;
    }
    if (evt.name === "down" || evt.name === "j") {
      setCursor((c) => (c < MENU_ITEMS.length - 1 ? c + 1 : 0));
      evt.preventDefault();
      return;
    }
    // Mnemonic direct-invoke
    const hit = MENU_ITEMS.findIndex((m) => m.keyHint === evt.name);
    if (hit >= 0) {
      setCursor(hit);
      setBusy(true);
      const item = MENU_ITEMS[hit];
      if (item) void run(item.action).finally(() => setBusy(false));
      evt.preventDefault();
      return;
    }
    evt.preventDefault();
  });

  if (!visible) return null;

  const popupW = fitPopupWidth(Math.min(60, Math.max(48, Math.floor(tw * 0.5))), tw);

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={16}
      title="Git"
      titleIcon="git"
      blurb={busy ? "Running…" : "Common git actions"}
      footerHints={[
        { key: "↑↓", label: "nav" },
        { key: "Enter", label: "run" },
        { key: "c/p/u/s/o/l/g/f/r", label: "direct" },
        { key: "Esc", label: "close" },
      ]}
    >
      <Section>
        <GroupedList
          groups={GROUPS}
          expanded={new Set(["actions"])}
          selectedIndex={cursor}
          width={popupW - 4}
        />
      </Section>
    </PremiumPopup>
  );
}
