import type { CommandPickerOption } from "../../components/modals/CommandPicker.js";
import { confirm, openSelect } from "../../components/ui/dialogs/index.js";
import { useUIStore } from "../../stores/ui.js";
import { requestInputEditor } from "../chat/external-editor.js";
import { getCwd } from "../cwd.js";
import { emitDraftRestore, getStashDB } from "../history/index.js";
import { icon } from "../icons.js";
import { getThemeTokens } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

function handleHelp(_input: string, _ctx: CommandContext): void {
  useUIStore.getState().openModal("commandPalette");
}

function handleRouter(_input: string, ctx: CommandContext): void {
  ctx.openRouterSettings();
}

function handleProviderSettings(_input: string, ctx: CommandContext): void {
  ctx.openProviderSettings();
}

function handleModels(_input: string, _ctx: CommandContext): void {
  useUIStore.getState().openModal("llmSelector");
}

function handleWebSearch(_input: string, ctx: CommandContext): void {
  ctx.openWebSearchSettings();
}

function handleApiKeys(_input: string, ctx: CommandContext): void {
  ctx.openApiKeySettings();
}

function handleChanges(_input: string, ctx: CommandContext): void {
  ctx.toggleChanges();
}

function handleErrors(_input: string, ctx: CommandContext): void {
  ctx.openErrorLog();
}

function handleCompactionLogs(_input: string, ctx: CommandContext): void {
  ctx.openCompactionLog();
}

function handleSkills(_input: string, ctx: CommandContext): void {
  ctx.openSkills();
}

function handleTabs(_input: string, ctx: CommandContext): void {
  const tabOptions: CommandPickerOption[] = ctx.tabMgr.tabs.map((tab, i) => ({
    value: tab.id,
    label: `${String(i + 1)}. ${tab.label}`,
    icon: tab.id === ctx.tabMgr.activeTabId ? "▸" : " ",
    color: tab.id === ctx.tabMgr.activeTabId ? getThemeTokens().brand : undefined,
  }));
  ctx.openCommandPicker({
    title: "Switch Tab",
    icon: icon("tabs"),
    options: tabOptions,
    currentValue: ctx.tabMgr.activeTabId,
    onSelect: (tabId) => ctx.tabMgr.switchTab(tabId),
  });
}

function handleNewTab(_input: string, ctx: CommandContext): void {
  if (!ctx.tabMgr.canCreateTab) return;
  useUIStore.getState().openModal("tabNamePopup");
}

function handleCloseTab(_input: string, ctx: CommandContext): void {
  if (ctx.tabMgr.tabCount <= 1) {
    sysMsg(ctx, "Can't close the last tab.");
    return;
  }
  if (ctx.tabMgr.isTabLoading(ctx.tabMgr.activeTabId)) {
    const closingId = ctx.tabMgr.activeTabId;
    ctx.openCommandPicker({
      title: "Tab is busy — close anyway?",
      icon: "⚠",
      options: [
        { value: "yes", label: "Yes, close it", icon: "✓" },
        { value: "no", label: "Cancel", icon: "✕" },
      ],
      onSelect: (val) => {
        if (val === "yes") ctx.tabMgr.closeTab(closingId);
      },
    });
  } else {
    ctx.tabMgr.closeTab(ctx.tabMgr.activeTabId);
  }
}

function handleRename(input: string, ctx: CommandContext): void {
  const newName = input
    .trim()
    .replace(/^\/(tab\s+rename|rename)\s*/i, "")
    .trim();
  if (newName) {
    ctx.tabMgr.renameTab(ctx.tabMgr.activeTabId, newName);
    sysMsg(ctx, `Tab renamed to: ${newName}`);
  } else {
    sysMsg(ctx, "Usage: /tab rename <name>");
  }
}

function handleQuit(_input: string, ctx: CommandContext): void {
  ctx.exit();
}

function handleRestart(_input: string, ctx: CommandContext): void {
  ctx.chat.abort();
  import("../../index.js").then(({ restart }) => restart());
}

function handleWizard(_input: string, _ctx: CommandContext): void {
  useUIStore.getState().openModal("firstRunWizard");
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/quit", handleQuit);
  map.set("/exit", handleQuit);
  map.set("/restart", handleRestart);
  map.set("/help", handleHelp); // legacy alias

  map.set("/router", handleRouter);
  map.set("/mcp", (_input: string) => {
    useUIStore.getState().openModal("mcpSettings");
  });
  map.set("/provider-settings", handleProviderSettings);
  map.set("/perf", handleProviderSettings);
  map.set("/providers", handleModels);
  map.set("/provider", handleModels);
  map.set("/models", handleModels);
  map.set("/model", handleModels);
  map.set("/web-search", handleWebSearch);
  map.set("/keys", handleApiKeys);
  map.set("/api-keys", handleApiKeys);
  map.set("/changes", handleChanges);
  map.set("/files", handleChanges);
  map.set("/errors", handleErrors);
  map.set("/compact logs", handleCompactionLogs);
  map.set("/compact-v2-logs", handleCompactionLogs); // legacy alias
  map.set("/skills", handleSkills);
  map.set("/tab", handleTabs);
  map.set("/tab new", handleNewTab);
  map.set("/tab close", handleCloseTab);
  map.set("/tab rename", handleRename);
  map.set("/wizard", handleWizard);
  map.set("/stash", handleStash);
  map.set("/editor", () => requestInputEditor({ fresh: true }));
  map.set("/drafts", handleStash);
}

export function matchNavPrefix(cmd: string): CommandHandler | null {
  if (cmd.startsWith("/tab rename ")) return handleRename;
  return null;
}
async function handleStash(_input: string, ctx: CommandContext): Promise<void> {
  const cwd = getCwd();
  let entries = getStashDB().list(cwd);
  if (entries.length === 0) {
    sysMsg(ctx, "No stashed drafts. Press Alt+S in the input to stash one.");
    return;
  }

  const fmtCreated = (iso: string): string => {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const diff = Date.now() - t;
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${String(s)}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${String(m)}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${String(h)}h ago`;
    return `${String(Math.floor(h / 24))}d ago`;
  };

  const buildOptions = () =>
    entries.map((e) => {
      const firstLine = (e.content.split("\n")[0] ?? "").trim();
      const preview = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
      const lineCount = e.content.split("\n").length;
      return {
        value: e.id,
        label: preview || "(empty)",
        description: lineCount > 1 ? `${String(lineCount)} lines` : undefined,
        meta: fmtCreated(e.createdAt),
      };
    });

  const opts = buildOptions().map((o) => ({
    value: o.value,
    label: o.label,
    description: o.description,
    meta: o.meta,
  }));
  const picked = await openSelect<number>({
    title: "Stashed Drafts",
    titleIcon: "archive",
    placeholder: `${String(entries.length)} drafts · fuzzy filter…`,
    options: opts,
    actions: [
      {
        key: "d",
        label: "delete",
        side: "right",
        onTrigger: (opt) => {
          if (!opt) return;
          try {
            getStashDB().remove(opt.value as number);
          } catch {}
          entries = entries.filter((e) => e.id !== (opt.value as number));
          sysMsg(ctx, `Removed stash entry #${String(opt.value)}.`);
        },
      },
      {
        key: "X",
        label: "clear all",
        side: "right",
        onTrigger: async () => {
          const ok = await confirm({
            title: "Clear all stashed drafts?",
            message: `${String(entries.length)} drafts will be deleted from this project.`,
            danger: true,
          });
          if (!ok) return;
          try {
            getStashDB().clear(cwd);
          } catch {}
          entries = [];
          sysMsg(ctx, "All drafts cleared.");
        },
      },
    ],
    footerHints: [
      { key: "Enter", label: "restore" },
      { key: "d", label: "delete" },
      { key: "X", label: "clear all" },
    ],
  });
  if (picked) {
    const entry = entries.find((e) => e.id === (picked.value as number));
    if (entry) {
      try {
        getStashDB().remove(entry.id);
      } catch {}
      emitDraftRestore(entry.content);
      sysMsg(ctx, "Draft restored to input.");
    }
  }
}
