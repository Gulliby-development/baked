import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import {
  getGitLog,
  gitPull,
  gitPush,
  gitResetHard,
  gitStash,
  gitStashPop,
} from "../../core/git/status.js";
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

  const run = async (action: string) => {
    switch (action) {
      case "commit":
        onClose();
        onCommit();
        return;
      case "push": {
        onClose();
        onSystemMessage("Pushing...");
        const r = await gitPush(cwd);
        onSystemMessage(r.ok ? "Push complete." : `Push failed: ${r.output}`);
        onRefresh();
        return;
      }
      case "pull": {
        onClose();
        onSystemMessage("Pulling...");
        const r = await gitPull(cwd);
        onSystemMessage(r.ok ? "Pull complete." : `Pull failed: ${r.output}`);
        onRefresh();
        return;
      }
      case "stash": {
        onClose();
        const r = await gitStash(cwd);
        onSystemMessage(r.ok ? "Changes stashed." : `Stash failed: ${r.output}`);
        onRefresh();
        return;
      }
      case "stash-pop": {
        onClose();
        const r = await gitStashPop(cwd);
        onSystemMessage(r.ok ? "Stash popped." : `Stash pop failed: ${r.output}`);
        onRefresh();
        return;
      }
      case "log": {
        onClose();
        const entries = await getGitLog(cwd, 20);
        if (entries.length === 0) onSystemMessage("No commits found.");
        else {
          onSystemMessage(entries.map((e) => `${e.hash} ${e.subject} (${e.date})`).join("\n"));
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
        onClose();
        onSystemMessage("Force-pushing (with lease)…");
        const r = await gitPush(cwd, ["--force-with-lease"]);
        onSystemMessage(r.ok ? "Force push complete." : `Force push failed: ${r.output}`);
        onRefresh();
        return;
      }
      case "reset-hard": {
        const ok = await confirm({
          title: "Reset working tree?",
          message:
            "git reset --hard HEAD will discard all uncommitted changes. Untracked files are kept.",
          danger: true,
        });
        if (!ok) return;
        onClose();
        onSystemMessage("Resetting working tree…");
        const r = await gitResetHard(cwd);
        onSystemMessage(r.ok ? "Reset complete." : `Reset failed: ${r.output}`);
        onRefresh();
        return;
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
