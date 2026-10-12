import type { ConfigScope } from "../../components/layout/shared.js";
import { loadConfig } from "../../config/index.js";
import { existingWorkflowSession, reloadWorkflowSession } from "../../hooks/useWorkflow.js";
import { useUIStore } from "../../stores/ui.js";
import type { AgentFeatures, AppConfig } from "../../types/index.js";
import { icon } from "../icons.js";
import {
  applyNotificationsChange,
  describeNotifications,
  type NotificationsChange,
  parseNotificationsArgs,
  parseOnOff,
} from "../notification-settings.js";
import {
  formatSandboxStatus,
  isSandboxMode,
  type SandboxMode,
  sandboxStatus,
} from "../security/sandbox.js";
import { SETTINGS } from "../settings/schema.js";
import { telemetryStatus } from "../telemetry.js";
import { applyTheme, getThemeTokens, listThemes, useThemeStore } from "../theme/index.js";
import { getMotion, type MotionMode, setMotion } from "../utils/motion.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

type ToggleConfig = {
  configKey: string;
  title: string;
  iconName: string;
  onValue: string;
  offValue: string;
  onLabel: string;
  offLabel: string;
  onDescription: string;
  offDescription: string;
  messageTemplate: (value: string, scope: string) => string;
};

function createTogglePicker(config: ToggleConfig): CommandHandler {
  return (_input: string, ctx: CommandContext) => {
    const currentVal = ctx[config.configKey as keyof CommandContext];
    const patch = (v: string) => ({ [config.configKey]: v === config.onValue });
    ctx.openCommandPicker({
      title: config.title,
      icon: icon(config.iconName),
      currentValue: currentVal ? config.onValue : config.offValue,
      scopeEnabled: true,
      initialScope: ctx.detectScope(config.configKey),
      options: [
        { value: config.onValue, label: config.onLabel, description: config.onDescription },
        { value: config.offValue, label: config.offLabel, description: config.offDescription },
      ],
      onSelect: (value, scope) => {
        ctx.saveToScope(patch(value), scope ?? "project");
        sysMsg(ctx, config.messageTemplate(value, scope ?? "project"));
      },
      onScopeMove: (value, from, to) => ctx.saveToScope(patch(value), to, from),
    });
  };
}

function handleChatStyle(input: string, ctx: CommandContext): void {
  const trimmed = input.trim();
  const arg = trimmed.slice(12).trim().toLowerCase();
  const patch = (v: string) => ({ chatStyle: v as "accent" | "bubble" });

  const applyChatStyle = (style: "accent" | "bubble", scope?: ConfigScope) => {
    ctx.setChatStyle(style);
    ctx.saveToScope(patch(style), scope ?? "project");
    sysMsg(ctx, `Chat style: ${style} (${scope ?? "project"})`);
  };

  if (arg === "accent" || arg === "bubble") {
    applyChatStyle(arg);
  } else {
    ctx.openCommandPicker({
      title: "Chat Style",
      icon: icon("chat_style"),
      currentValue: ctx.chatStyle,
      scopeEnabled: true,
      initialScope: ctx.detectScope("chatStyle"),
      options: [
        { value: "accent", label: "Accent", description: "colored left-border for messages" },
        { value: "bubble", label: "Bubble", description: "rounded bubble chat layout" },
      ],
      onSelect: (value, scope) => applyChatStyle(value as "accent" | "bubble", scope),
      onScopeMove: (value, from, to) => {
        ctx.setChatStyle(value as "accent" | "bubble");
        ctx.saveToScope(patch(value), to, from);
      },
    });
  }
}

function handleMode(input: string, ctx: CommandContext): void {
  const trimmed = input.trim();
  const modeName = trimmed.slice(5).trim().toLowerCase();
  const validModes = ["default", "architect", "plan", "auto"] as const;
  type Mode = (typeof validModes)[number];
  const patch = (v: string) => ({ defaultBakeMode: v as Mode });

  const applyMode = (mode: Mode, scope?: ConfigScope) => {
    ctx.setBakeMode(mode);
    ctx.saveToScope(patch(mode), scope ?? "project");
    sysMsg(ctx, `Baked mode set to: ${mode} (${scope ?? "project"})`);
  };

  const matched = validModes.find((m) => m === modeName);
  if (matched) {
    applyMode(matched);
  } else if (modeName && !matched) {
    sysMsg(ctx, `Unknown mode: ${modeName}. Available: default, architect, plan, auto`);
  } else {
    ctx.openCommandPicker({
      title: "Baked Mode",
      icon: icon("ai"),
      currentValue: ctx.currentMode,
      scopeEnabled: true,
      initialScope: ctx.detectScope("defaultBakeMode"),
      options: [
        {
          value: "default",
          label: "Default",
          description: "standard assistant — implements directly",
          color: getThemeTokens().textSecondary,
        },
        {
          value: "architect",
          label: "Architect",
          description: "design only — outlines, tradeoffs, no code",
          color: getThemeTokens().brand,
        },
        {
          value: "plan",
          label: "Plan",
          description: "research & plan only — no file edits or shell",
          color: getThemeTokens().info,
        },
        {
          value: "auto",
          label: "Auto",
          description: "autonomous execution — minimal questions, action over planning",
          color: getThemeTokens().success,
        },
      ],
      onSelect: (value, scope) => applyMode(value as Mode, scope),
      onScopeMove: (value, from, to) => {
        ctx.setBakeMode(value as Mode);
        ctx.saveToScope(patch(value), to, from);
      },
    });
  }
}

const handleVerbose = createTogglePicker({
  configKey: "verbose",
  title: "Verbose Mode",
  iconName: "verbose",
  onValue: "on",
  offValue: "off",
  onLabel: "On",
  offLabel: "Off",
  onDescription: "show full tool call output in chat",
  offDescription: "show compact tool call summaries",
  messageTemplate: (v, s) => `Verbose mode ${v === "on" ? "on" : "off"} (${s})`,
});

function handleTimeouts(_input: string, ctx: CommandContext): void {
  const cfg = loadConfig();
  const currentToolTimeout = cfg.toolTimeout ?? 2;
  const watchdogEnabled = cfg.watchdog ?? false;
  const wd = cfg.watchdogTimeouts ?? {};

  const currentTool = `tool:${currentToolTimeout}`;
  const wdFirstSec = (wd.firstChunkMs ?? 180_000) / 1000;
  const wdChunkSec = (wd.chunkMs ?? 120_000) / 1000;
  const wdToolSec = (wd.toolMaxMs ?? 900_000) / 1000;
  const wdForceSec = (wd.forceResolveMs ?? 5_000) / 1000;

  const wdFirst = `wd-first:${wdFirstSec}`;
  const wdChunk = `wd-chunk:${wdChunkSec}`;
  const wdTool = `wd-tool:${wdToolSec}`;
  const wdForce = `wd-force:${wdForceSec}`;

  // Lookup table: category → picker config
  const timeoutPickers: Record<string, CommandHandler> = {
    "tool-timeout": (_input: string, ctx: CommandContext) => {
      ctx.openCommandPicker({
        title: "Tool Timeout",
        icon: icon("clock"),
        currentValue: currentTool,
        scopeEnabled: false,
        options: [
          { value: "tool:1", label: "1 min" },
          { value: "tool:2", label: "2 min", description: "default" },
          { value: "tool:5", label: "5 min" },
          { value: "tool:10", label: "10 min" },
          { value: "tool:20", label: "20 min" },
          { value: "tool:0", label: "No timeout", description: "tools run until completion" },
        ],
        onSelect: (value) => {
          const timeout = Number(value.split(":")[1]);
          ctx.saveToScope({ toolTimeout: timeout }, "global");
          sysMsg(ctx, `Tool timeout → ${timeout === 0 ? "none" : `${timeout}m`} (global)`);
        },
      });
    },
    "watchdog-toggle": (_input: string, ctx: CommandContext) => {
      ctx.openCommandPicker({
        title: "Watchdog",
        icon: icon("clock"),
        currentValue: watchdogEnabled ? "watchdog:on" : "watchdog:off",
        scopeEnabled: false,
        options: [
          {
            value: "watchdog:on",
            label: "Watchdog: On",
            description: "enable auto-retry on stalls",
          },
          {
            value: "watchdog:off",
            label: "Watchdog: Off",
            description: "disable auto-retry on stalls",
          },
        ],
        onSelect: (value) => {
          const enabled = value === "watchdog:on";
          ctx.saveToScope({ watchdog: enabled }, "global");
          sysMsg(ctx, `Watchdog ${enabled ? "enabled" : "disabled"} (global)`);
        },
      });
    },
    "wd-first": (_input: string, ctx: CommandContext) => {
      ctx.openCommandPicker({
        title: "Watchdog — First Chunk Timeout",
        icon: icon("clock"),
        currentValue: wdFirst,
        scopeEnabled: false,
        options: [
          { value: "wd-first:5", label: "5s" },
          { value: "wd-first:15", label: "15s" },
          { value: "wd-first:30", label: "30s" },
          { value: "wd-first:60", label: "60s" },
          { value: "wd-first:120", label: "120s" },
          { value: "wd-first:180", label: "180s", description: "default" },
        ],
        onSelect: (value) => {
          const sec = Number(value.split(":")[1]);
          ctx.saveToScope({ watchdogTimeouts: { ...wd, firstChunkMs: sec * 1000 } }, "global");
          sysMsg(ctx, `Watchdog first-chunk timeout → ${sec}s (global)`);
        },
      });
    },
    "wd-chunk": (_input: string, ctx: CommandContext) => {
      ctx.openCommandPicker({
        title: "Watchdog — Chunk Timeout",
        icon: icon("clock"),
        currentValue: wdChunk,
        scopeEnabled: false,
        options: [
          { value: "wd-chunk:5", label: "5s" },
          { value: "wd-chunk:15", label: "15s" },
          { value: "wd-chunk:30", label: "30s" },
          { value: "wd-chunk:60", label: "60s" },
          { value: "wd-chunk:120", label: "120s", description: "default" },
          { value: "wd-chunk:180", label: "180s" },
        ],
        onSelect: (value) => {
          const sec = Number(value.split(":")[1]);
          ctx.saveToScope({ watchdogTimeouts: { ...wd, chunkMs: sec * 1000 } }, "global");
          sysMsg(ctx, `Watchdog chunk timeout → ${sec}s (global)`);
        },
      });
    },
    "wd-tool": (_input: string, ctx: CommandContext) => {
      ctx.openCommandPicker({
        title: "Watchdog — Tool Max Timeout",
        icon: icon("clock"),
        currentValue: wdTool,
        scopeEnabled: false,
        options: [
          { value: "wd-tool:60", label: "1 min" },
          { value: "wd-tool:300", label: "5 min" },
          { value: "wd-tool:600", label: "10 min" },
          { value: "wd-tool:900", label: "15 min", description: "default" },
          { value: "wd-tool:1800", label: "30 min" },
          { value: "wd-tool:3600", label: "60 min" },
        ],
        onSelect: (value) => {
          const sec = Number(value.split(":")[1]);
          ctx.saveToScope({ watchdogTimeouts: { ...wd, toolMaxMs: sec * 1000 } }, "global");
          sysMsg(ctx, `Watchdog tool-max timeout → ${sec}s (global)`);
        },
      });
    },
    "wd-force": (_input: string, ctx: CommandContext) => {
      ctx.openCommandPicker({
        title: "Watchdog — Force-Resolve Timeout",
        icon: icon("clock"),
        currentValue: wdForce,
        scopeEnabled: false,
        options: [
          { value: "wd-force:1", label: "1s" },
          { value: "wd-force:5", label: "5s", description: "default" },
          { value: "wd-force:10", label: "10s" },
          { value: "wd-force:30", label: "30s" },
        ],
        onSelect: (value) => {
          const sec = Number(value.split(":")[1]);
          ctx.saveToScope({ watchdogTimeouts: { ...wd, forceResolveMs: sec * 1000 } }, "global");
          sysMsg(ctx, `Watchdog force-resolve timeout → ${sec}s (global)`);
        },
      });
    },
  };

  // Top-level categories picker
  ctx.openCommandPicker({
    title: "Timeouts & Watchdog",
    icon: icon("clock"),
    currentValue: currentTool,
    scopeEnabled: false,
    options: [
      {
        value: "tool-timeout",
        label: "Tool Timeout",
        description: currentToolTimeout === 0 ? "none" : `${currentToolTimeout}m`,
      },
      { value: "watchdog-toggle", label: "Watchdog", description: watchdogEnabled ? "On" : "Off" },
      { value: "wd-first", label: "First Chunk Timeout", description: `${wdFirstSec}s` },
      { value: "wd-chunk", label: "Chunk Timeout", description: `${wdChunkSec}s` },
      { value: "wd-tool", label: "Tool Max Timeout", description: `${wdToolSec}s` },
      { value: "wd-force", label: "Force-Resolve Timeout", description: `${wdForceSec}s` },
    ],
    onSelect: (value) => {
      const handler = timeoutPickers[value];
      if (handler) {
        handler("", ctx);
      }
    },
  });
}

function handleVerboseTab(_input: string, ctx: CommandContext): void {
  const next = !ctx.tabVerbose;
  ctx.setTabVerbose(next);
  sysMsg(
    ctx,
    next
      ? "📜 Verbose on — raw stream of every text and tool segment"
      : "🔒 Verbose off — narration folds into the tool rail",
  );
}

function handleReasoning(_input: string, ctx: CommandContext): void {
  const patch = (v: string) => ({ showReasoning: v === "on" });
  ctx.openCommandPicker({
    title: "Reasoning Display",
    icon: icon("brain"),
    currentValue: ctx.showReasoning ? "on" : "off",
    scopeEnabled: true,
    initialScope: ctx.detectScope("showReasoning"),
    options: [
      { value: "on", label: "On", description: "show reasoning content in chat" },
      { value: "off", label: "Off", description: "show thinking status only" },
    ],
    onSelect: (value, scope) => {
      ctx.setShowReasoning(value === "on");
      ctx.saveToScope(patch(value), scope ?? "project");
      sysMsg(ctx, `Reasoning ${value === "on" ? "visible" : "hidden"} (${scope ?? "project"})`);
    },
    onScopeMove: (value, from, to) => {
      ctx.setShowReasoning(value === "on");
      ctx.saveToScope(patch(value), to, from);
    },
  });
}

function handleMotion(_input: string, ctx: CommandContext): void {
  const patch = (value: string) => ({ motion: value as MotionMode });
  ctx.openCommandPicker({
    title: "Motion",
    icon: icon("cog"),
    currentValue: getMotion(),
    scopeEnabled: true,
    initialScope: ctx.detectScope("motion"),
    options: [
      { value: "full", label: "Full", description: "animated bun, boot splash and busy meter" },
      {
        value: "reduced",
        label: "Reduced",
        description: "still frames, busy time updates once a second",
      },
    ],
    onSelect: (value, scope) => {
      setMotion(value as MotionMode);
      ctx.saveToScope(patch(value), scope ?? "global");
      sysMsg(ctx, `Motion ${value} (${scope ?? "global"})`);
    },
    onScopeMove: (value, from, to) => {
      setMotion(value as MotionMode);
      ctx.saveToScope(patch(value), to, from);
    },
  });
}

function handleCompaction(_input: string, ctx: CommandContext): void {
  type Strategy = import("../compaction/types.js").CompactionStrategy;
  let localStrategy = ctx.compactionStrategy as Strategy;

  const buildOptions = () => [
    {
      value: "v1",
      label: `V1 — LLM Summarization${localStrategy === "v1" ? " ●" : ""}`,
      description: "batch summarize with LLM when context is full",
    },
    {
      value: "v2",
      label: `V2 — Incremental Extraction${localStrategy === "v2" ? " ●" : ""}`,
      description: "extract structured state as-you-go, cheap gap-fill on compact (default)",
    },
    {
      value: "disabled",
      label: `Disabled${localStrategy === "disabled" ? " ●" : ""}`,
      description: "no auto-compaction — context will fill until the model's limit",
    },
  ];

  ctx.openCommandPicker({
    title: "Compaction",
    icon: icon("compact"),
    keepOpen: true,
    currentValue: localStrategy,
    scopeEnabled: true,
    initialScope: ctx.detectScope("compaction"),
    options: buildOptions(),
    onSelect: (value, scope) => {
      localStrategy = value as Strategy;
      ctx.saveToScope({ compaction: { strategy: localStrategy } }, scope ?? "project");
      sysMsg(ctx, `Compaction strategy: ${value} (${scope ?? "project"})`);
      useUIStore.getState().updatePickerOptions(buildOptions());
    },
    onScopeMove: (_value, from, to) => {
      ctx.saveToScope({ compaction: { strategy: localStrategy } }, to, from);
    },
  });
}

function handleAgentFeatures(_input: string, ctx: CommandContext): void {
  // Labels, help and defaults come from the shared settings schema, as on the desktop page.
  const features = SETTINGS.filter((setting) => setting.page === "agent-features").map(
    (setting) => ({
      key: setting.id.replace(/^agentFeatures\./, ""),
      label: setting.label,
      help: setting.help,
      defaultOn: setting.default === true,
    }),
  );
  const isOn = (key: string, state: Record<string, unknown>) =>
    features.find((feature) => feature.key === key)?.defaultOn
      ? state[key] !== false
      : state[key] === true;
  const localState = { ...ctx.agentFeatures };
  const buildOptions = () =>
    features.map(({ key, label, help }) => ({
      value: key,
      label: `${label}: ${isOn(key, localState as Record<string, unknown>) ? "on" : "off"}`,
      description: help,
    }));
  ctx.openCommandPicker({
    title: "Agent Features",
    icon: icon("system"),
    keepOpen: true,
    currentValue: "",
    options: buildOptions(),
    scopeEnabled: true,
    initialScope: ctx.detectScope("agentFeatures"),
    onSelect: (value, scope) => {
      const key = value as keyof AgentFeatures;
      const current = isOn(key, localState as Record<string, unknown>);
      (localState as Record<string, unknown>)[key] = !current;
      ctx.saveToScope({ agentFeatures: { [key]: !current } }, scope ?? "project");
      sysMsg(
        ctx,
        `Agent feature "${key}" ${!current ? "enabled" : "disabled"} (${scope ?? "project"})`,
      );
      useUIStore.getState().updatePickerOptions(buildOptions());
    },
    onScopeMove: (value, from, to) => {
      const key = value as keyof AgentFeatures;
      const current = isOn(key, localState as Record<string, unknown>);
      ctx.saveToScope({ agentFeatures: { [key]: current } }, to, from);
    },
  });
}

async function handleInstructions(input: string, ctx: CommandContext): Promise<void> {
  const [sub = "", ...rest] = input.trim().split(/\s+/).slice(1);
  const arg = rest.join(" ");
  if (sub === "files") return openInstructionFiles(ctx);
  if (sub === "show") return showInstructionFile(ctx, arg);
  if (sub === "edit") {
    if (arg) return editInstruction(ctx, arg);
    return openInstructionFiles(ctx);
  }
  if (sub) {
    sysMsg(ctx, "Usage: /instructions [files | show <path> | edit <path>]");
    return;
  }
  const { INSTRUCTION_SOURCES, loadInstructions, buildInstructionPrompt } = await import(
    "../instructions.js"
  );
  const currentEnabled = new Set<string>(
    ctx.instructionFiles ??
      INSTRUCTION_SOURCES.filter((s: { defaultEnabled: boolean }) => s.defaultEnabled).map(
        (s: { id: string }) => s.id,
      ),
  );
  const loaded = loadInstructions(ctx.cwd, [...currentEnabled]);
  const loadedIds = new Set(loaded.map((l: { source: string }) => l.source));
  const { listInstructionFiles } = await import("../instruction-files.js");
  const onDisk = () => listInstructionFiles(ctx.cwd, [...currentEnabled]);
  let found = onDisk();

  const buildOptions = () =>
    INSTRUCTION_SOURCES.map((s: { id: string; label: string; files: string[] }) => {
      const enabled = currentEnabled.has(s.id);
      const loadedHere = loadedIds.has(s.id);
      const files = found.filter((f) => f.source === s.id);
      const suffix = enabled ? (loadedHere ? "" : " (not found)") : "";
      return {
        value: s.id,
        icon: enabled ? "✓" : " ",
        color: enabled
          ? loadedHere
            ? getThemeTokens().success
            : getThemeTokens().warning
          : getThemeTokens().textMuted,
        label: `${s.label}${suffix}`,
        description: files.length
          ? files.map((f) => (f.scope === "global" ? `~/${f.path}` : f.path)).join(", ")
          : "no file",
      };
    });

  ctx.openCommandPicker({
    title: "Instruction Files",
    icon: icon("system"),
    keepOpen: true,
    currentValue: "",
    options: buildOptions(),
    scopeEnabled: true,
    initialScope: ctx.detectScope("instructionFiles"),
    onSelect: (value, scope) => {
      if (currentEnabled.has(value)) {
        currentEnabled.delete(value);
      } else {
        currentEnabled.add(value);
      }
      const ids = [...currentEnabled];
      ctx.saveToScope({ instructionFiles: ids }, scope ?? "project");

      const freshLoaded = loadInstructions(ctx.cwd, ids);
      loadedIds.clear();
      for (const l of freshLoaded) loadedIds.add(l.source);
      found = onDisk();

      ctx.contextManager.setProjectInstructions(buildInstructionPrompt(freshLoaded));

      sysMsg(
        ctx,
        `Instruction file "${value}" ${currentEnabled.has(value) ? "enabled" : "disabled"} (${scope ?? "project"}). /instructions files views and edits them.`,
      );
      useUIStore.getState().updatePickerOptions(buildOptions());
    },
    onScopeMove: (_value, from, to) => {
      ctx.saveToScope({ instructionFiles: [...currentEnabled] }, to, from);
    },
  });
}

/** The files on disk, in prompt order; Enter opens one in $EDITOR. */
async function openInstructionFiles(ctx: CommandContext): Promise<void> {
  const { listInstructionFiles } = await import("../instruction-files.js");
  const files = listInstructionFiles(ctx.cwd, ctx.instructionFiles);
  const t = getThemeTokens();
  const options = files.map((f) => ({
    value: f.absolutePath,
    icon: f.enabled ? String(f.order) : " ",
    color: f.enabled ? t.textPrimary : t.textMuted,
    label: f.scope === "global" ? `~/${f.path}` : f.path,
    description: `${f.sourceLabel} · ${f.scope === "global" ? "every project" : "this project"} · ${f.enabled ? "read by agents" : "off"} · ${f.bytes} B`,
  }));
  if (!options.length) {
    sysMsg(
      ctx,
      "No instruction files. /instructions edit baked.md (or AGENTS.md, CLAUDE.md, ...) creates one.",
    );
    return;
  }
  ctx.openCommandPicker({
    title: "Instruction Files: Enter edits in $EDITOR",
    icon: icon("system"),
    options,
    onSelect: (value) => {
      const file = files.find((f) => f.absolutePath === value);
      if (file) void editInstruction(ctx, file.path);
    },
  });
}

async function showInstructionFile(ctx: CommandContext, path: string): Promise<void> {
  const { findInstructionFile, listInstructionFiles } = await import("../instruction-files.js");
  const files = listInstructionFiles(ctx.cwd, ctx.instructionFiles);
  const file = path ? findInstructionFile(files, path) : files.find((f) => f.enabled);
  if (!file) {
    sysMsg(ctx, path ? `${path} is not an instruction file.` : "No instruction files.");
    return;
  }
  ctx.openInfoPopup({
    title: file.path,
    icon: icon("system"),
    width: 100,
    lines: [
      {
        type: "entry",
        label: "Read by agents",
        desc: file.enabled ? `yes, number ${file.order}` : `no (${file.sourceLabel} is off)`,
      },
      {
        type: "entry",
        label: "Scope",
        desc: file.scope === "global" ? "every project" : "this project",
      },
      { type: "entry", label: "Path", desc: file.absolutePath },
      { type: "separator" },
      ...file.content.split("\n").map((line) => ({ type: "text" as const, label: line || " " })),
    ],
  });
}

async function editInstruction(ctx: CommandContext, path: string): Promise<void> {
  const { editInstructionFile } = await import("../instruction-files.js");
  const { buildInstructionPrompt, loadInstructions } = await import("../instructions.js");
  const result = await editInstructionFile(ctx.cwd, ctx.instructionFiles, path);
  if (result.status === "saved") {
    ctx.contextManager.setProjectInstructions(
      buildInstructionPrompt(loadInstructions(ctx.cwd, ctx.instructionFiles)),
    );
    const runs = result.affectedRuns.length
      ? ` Active runs that froze the earlier version stop at their next step until their plan is revised: ${result.affectedRuns.join(", ")}.`
      : "";
    const off = result.enabled
      ? ""
      : " Its source is off, so agents do not read it; /instructions switches it on.";
    sysMsg(ctx, `${result.created ? "Created" : "Saved"} ${result.path}.${off}${runs}`);
  } else if (result.status === "unchanged") sysMsg(ctx, `${result.path} is unchanged.`);
  else if (result.status === "conflict")
    sysMsg(ctx, `${result.message}. Your edit was not saved; it is kept in ${result.keptAt}.`);
  else sysMsg(ctx, result.message);
}

function handleDiffStyle(_input: string, ctx: CommandContext): void {
  const patch = (v: string) => ({ diffStyle: v as "default" | "sidebyside" | "compact" });
  let collapse = ctx.collapseDiffs;
  ctx.openCommandPicker({
    title: "Diff Style",
    icon: icon("git"),
    scopeEnabled: true,
    initialScope: ctx.detectScope("diffStyle"),
    options: [
      {
        value: "default",
        label: "Default",
        description: "Full inline diff with syntax highlighting",
        icon: icon("file"),
      },
      {
        value: "sidebyside",
        label: "Side by Side",
        description: "Old and new shown in columns",
        icon: icon("panel"),
      },
      {
        value: "compact",
        label: "Compact",
        description: "File name + line count summary only",
        icon: icon("compact"),
      },
    ],
    currentValue: ctx.diffStyle,
    toggles: [
      {
        key: "tab",
        label: `Collapse diffs: ${collapse ? "on" : "off"}`,
        value: collapse,
        onToggle: () => {
          collapse = !collapse;
          ctx.saveToScope({ collapseDiffs: collapse }, ctx.detectScope("collapseDiffs"));
          return `Collapse diffs: ${collapse ? "on" : "off"}`;
        },
      },
    ],
    onSelect: (value, scope) => {
      ctx.saveToScope(patch(value), scope ?? "project");
      sysMsg(ctx, `Diff style: ${value} (${scope ?? "project"})`);
    },
    onScopeMove: (value, from, to) => ctx.saveToScope(patch(value), to, from),
  });
}

function handleModelScope(_input: string, ctx: CommandContext): void {
  ctx.openCommandPicker({
    title: "Model Scope",
    icon: icon("settings"),
    currentValue: ctx.detectScope("defaultModel"),
    options: [
      { value: "global", label: "Global", description: "model choice applies to all projects" },
      {
        value: "project",
        label: "Project",
        description: "model choice is specific to this project",
      },
    ],
    onSelect: (value, _scope) => {
      const current = ctx.chat.activeModel;
      if (current !== "none") {
        const from = ctx.detectScope("defaultModel");
        const to = value as ConfigScope;
        if (from !== to) {
          ctx.saveToScope({ defaultModel: current }, to, from);
        }
      }
      sysMsg(ctx, `Model scope: ${value}`);
    },
  });
}

const settingsHandlers: Record<string, (input: string, ctx: CommandContext) => void> = {
  mode: handleMode,
  "chat-style": handleChatStyle,
  verbose: handleVerbose as CommandHandler,
  reasoning: handleReasoning,
  "verbose-tab": handleVerboseTab,
  compaction: handleCompaction,
  "diff-style": handleDiffStyle,
  "agent-features": handleAgentFeatures,
  instructions: handleInstructions as CommandHandler,
  "model-scope": handleModelScope,
  timeouts: handleTimeouts,
  notifications: handleNotifications,
  telemetry: handleTelemetry,
};

function handleSettingsHub(_input: string, ctx: CommandContext): void {
  const mode = ctx.currentModeLabel ?? ctx.currentMode;
  const chatStyle = ctx.chatStyle ?? "accent";
  const verbose = ctx.verbose ? "on" : "off";
  const reasoning = ctx.showReasoning ? "on" : "off";
  const verboseStatus = ctx.tabVerbose ? "on" : "off";
  const compaction = ctx.compactionStrategy ?? "v2";
  const diffStyle = ctx.diffStyle ?? "default";

  ctx.openCommandPicker({
    title: "Settings",
    icon: icon("cog"),
    options: [
      { value: "mode", label: `${icon("ai")} Mode`, description: mode },
      { value: "chat-style", label: `${icon("chat_style")} Chat Style`, description: chatStyle },
      { value: "verbose", label: `${icon("verbose")} Verbose`, description: verbose },
      { value: "reasoning", label: `${icon("brain")} Reasoning`, description: reasoning },
      {
        value: "verbose-tab",
        label: `${icon("ghost")} Verbose render`,
        description: verboseStatus,
      },
      { value: "compaction", label: `${icon("compact")} Compaction`, description: compaction },
      { value: "diff-style", label: `${icon("git")} Diff Style`, description: diffStyle },
      { value: "agent-features", label: `${icon("system")} Agent Features`, description: "toggle" },
      {
        value: "instructions",
        label: `${icon("system")} Instructions`,
        description: "toggle files",
      },
      { value: "model-scope", label: `${icon("cog")} Model Scope`, description: "project/global" },
      {
        value: "timeouts",
        label: `${icon("clock")} Tool Timeout`,
        description: `${String(loadConfig().toolTimeout ?? 2)}m`,
      },
      { value: "notifications", label: `${icon("info")} Notifications`, description: "global" },
      {
        value: "telemetry",
        label: `${icon("info")} Telemetry`,
        description: loadConfig().telemetry === false ? "off" : "on",
      },
    ],
    onSelect: (value) => {
      const handler = settingsHandlers[value];
      if (handler) {
        handler(`/${value}`, ctx);
      }
    },
  });
}

const OPACITY_LEVELS = [0, 30, 70, 100] as const;
const OPACITY_OPTIONS = ["Clear", "Dim", "Subtle", "Solid"];

function opacityToIndex(opacity: number): number {
  const idx = OPACITY_LEVELS.indexOf(opacity as (typeof OPACITY_LEVELS)[number]);
  return idx >= 0 ? idx : OPACITY_LEVELS.length - 1;
}

type BorderStrengthOption = "default" | "strong" | "op";
const BORDER_STRENGTH_OPTIONS: BorderStrengthOption[] = ["default", "strong", "op"];
const BORDER_STRENGTH_LABELS = ["Default", "Strong", "OP"];

function themePatch(
  name: string,
  transparent: boolean,
  userMsgOp: number,
  diffOp: number,
  borderStr: BorderStrengthOption,
): Partial<AppConfig> {
  return {
    theme: {
      name,
      transparent,
      userMessageOpacity: userMsgOp,
      diffOpacity: diffOp,
      borderStrength: borderStr,
    },
  };
}

const handleTheme: CommandHandler = (input: string, ctx: CommandContext) => {
  const arg = input.replace(/^\/theme\s*/, "").trim();
  const current = useThemeStore.getState().name;
  const isTransparent = useThemeStore.getState().tokens.bgApp === "transparent";

  // Read saved settings from config
  const cfg = loadConfig();
  const savedMsgOpacity =
    typeof cfg.theme?.userMessageOpacity === "number" ? cfg.theme.userMessageOpacity : 100;
  const savedDiffOpacity = typeof cfg.theme?.diffOpacity === "number" ? cfg.theme.diffOpacity : 100;
  const savedBorderStr: BorderStrengthOption = cfg.theme?.borderStrength ?? "default";

  const applyAll = (
    name: string,
    tp: boolean,
    msgOp: number,
    diffOp: number,
    bdrStr: BorderStrengthOption,
  ) =>
    applyTheme(name, tp, {
      userMessageOpacity: msgOp,
      diffOpacity: diffOp,
      borderStrength: bdrStr,
    });

  if (!arg || arg === "list") {
    const themes = listThemes();
    const originalTheme = current;
    let transparent = isTransparent;
    let userMsgOpacity = savedMsgOpacity;
    let diffOpacity = savedDiffOpacity;
    let borderStr = savedBorderStr;

    ctx.openCommandPicker({
      title: "Theme",
      icon: icon("palette"),
      currentValue: current,
      searchable: true,
      maxWidth: 60,
      options: themes.map((th) => ({
        value: th.id,
        label: `${th.variant === "light" ? "☀" : "☾"} ${th.label}`,
        icon: "■■",
        color: th.brand,
      })),
      toggles: [
        {
          key: "tab",
          label: "Transparent",
          value: transparent,
          onToggle: () => {
            transparent = !transparent;
            const name = useThemeStore.getState().name;
            applyAll(name, transparent, userMsgOpacity, diffOpacity, borderStr);
            ctx.saveToScope(
              themePatch(name, transparent, userMsgOpacity, diffOpacity, borderStr),
              "global",
            );
          },
        },
      ],
      selectors: [
        {
          key: "m",
          label: "Message BG",
          options: OPACITY_OPTIONS,
          value: opacityToIndex(savedMsgOpacity),
          onChange: (idx) => {
            userMsgOpacity = OPACITY_LEVELS[idx] ?? 100;
            const name = useThemeStore.getState().name;
            applyAll(name, transparent, userMsgOpacity, diffOpacity, borderStr);
            ctx.saveToScope(
              themePatch(name, transparent, userMsgOpacity, diffOpacity, borderStr),
              "global",
            );
          },
        },
        {
          key: "d",
          label: "Diff BG",
          options: OPACITY_OPTIONS,
          value: opacityToIndex(savedDiffOpacity),
          onChange: (idx) => {
            diffOpacity = OPACITY_LEVELS[idx] ?? 100;
            const name = useThemeStore.getState().name;
            applyAll(name, transparent, userMsgOpacity, diffOpacity, borderStr);
            ctx.saveToScope(
              themePatch(name, transparent, userMsgOpacity, diffOpacity, borderStr),
              "global",
            );
          },
        },
        {
          key: "b",
          label: "Borders",
          options: BORDER_STRENGTH_LABELS,
          value: BORDER_STRENGTH_OPTIONS.indexOf(savedBorderStr),
          onChange: (idx) => {
            borderStr = BORDER_STRENGTH_OPTIONS[idx] ?? "default";
            const name = useThemeStore.getState().name;
            applyAll(name, transparent, userMsgOpacity, diffOpacity, borderStr);
            ctx.saveToScope(
              themePatch(name, transparent, userMsgOpacity, diffOpacity, borderStr),
              "global",
            );
          },
        },
      ],
      onCursorChange: (value) => {
        applyAll(value, transparent, userMsgOpacity, diffOpacity, borderStr);
      },
      onCancel: () => {
        // Revert theme name preview but keep any toggle/selector changes the user made
        applyAll(originalTheme, transparent, userMsgOpacity, diffOpacity, borderStr);
        ctx.saveToScope(
          themePatch(originalTheme, transparent, userMsgOpacity, diffOpacity, borderStr),
          "global",
        );
      },
      onSelect: (value) => {
        applyAll(value, transparent, userMsgOpacity, diffOpacity, borderStr);
        ctx.saveToScope(
          themePatch(value, transparent, userMsgOpacity, diffOpacity, borderStr),
          "global",
        );
        sysMsg(ctx, `Theme → ${value}`);
      },
    });
    return;
  }

  applyAll(arg, isTransparent, savedMsgOpacity, savedDiffOpacity, savedBorderStr);
  ctx.saveToScope(
    themePatch(arg, isTransparent, savedMsgOpacity, savedDiffOpacity, savedBorderStr),
    "global",
  );
  sysMsg(ctx, `Theme → ${arg}`);
};

/** `/telemetry [on|off]`: anonymous usage telemetry in the global config. */
function handleTelemetry(input: string, ctx: CommandContext): void {
  const arg = input.trim().split(/\s+/).slice(1).join(" ");
  const apply = (on: boolean) => {
    ctx.saveToScope({ telemetry: on }, "global");
    sysMsg(ctx, `Telemetry ${on ? "on" : "off"} (global). ${telemetryStatus(on)}`);
  };
  if (arg) {
    const on = parseOnOff(arg);
    if (on === null) sysMsg(ctx, "Usage: /telemetry [on|off]");
    else apply(on);
    return;
  }
  ctx.openCommandPicker({
    title: "Telemetry",
    icon: icon("info"),
    currentValue: loadConfig().telemetry === false ? "off" : "on",
    scopeEnabled: false,
    options: [
      {
        value: "on",
        label: "On",
        description: "record one anonymous event per session in a local log",
      },
      { value: "off", label: "Off", description: "record nothing" },
    ],
    onSelect: (value) => apply(value === "on"),
  });
}

/** `/sandbox [off|auto|required|status]`: the OS sandbox of shell, project and check commands. */
function handleSandbox(input: string, ctx: CommandContext): void {
  const arg = input.trim().split(/\s+/).slice(1).join(" ").toLowerCase();
  const status = () => sysMsg(ctx, formatSandboxStatus(sandboxStatus(ctx.cwd)).join("\n"));
  const apply = (mode: SandboxMode) => {
    ctx.saveToScope({ sandbox: mode }, "global");
    status();
  };
  if (arg === "status") {
    status();
    return;
  }
  if (arg) {
    if (isSandboxMode(arg)) apply(arg);
    else sysMsg(ctx, "Usage: /sandbox [off|auto|required|status]");
    return;
  }
  const current = sandboxStatus(ctx.cwd);
  ctx.openCommandPicker({
    title: "OS sandbox",
    icon: icon("lock"),
    currentValue: current.mode,
    scopeEnabled: false,
    options: [
      { value: "off", label: "Off", description: "commands run without OS sandbox" },
      {
        value: "auto",
        label: "Auto",
        description: current.available
          ? `sandbox with ${current.backend}`
          : "no backend here: run without it and warn once",
      },
      {
        value: "required",
        label: "Required",
        description: current.available
          ? `sandbox with ${current.backend}; refuse without it`
          : "no backend here: commands are refused",
      },
    ],
    onSelect: (value) => {
      if (isSandboxMode(value)) apply(value);
    },
  });
}

/** Saves a `notifications` change to the global config and restarts an idle workflow worker. */
function saveNotifications(ctx: CommandContext, change: NotificationsChange): void {
  const result = applyNotificationsChange(loadConfig().notifications, change);
  if (!result.ok) {
    sysMsg(ctx, result.error);
    return;
  }
  ctx.saveToScope({ notifications: result.value }, "global");
  // Announcements come from the workflow worker, which reads config when it starts.
  const driving = existingWorkflowSession(ctx.cwd)?.drivingRuns() ?? [];
  void reloadWorkflowSession(ctx.cwd, driving).then((reloaded) =>
    sysMsg(
      ctx,
      [
        "Notifications saved (global).",
        ...describeNotifications(result.value),
        ...(reloaded ? [] : ["A run is active: the change applies after BAKED restarts."]),
      ].join("\n"),
    ),
  );
}

/** `/notifications [system on|off | webhook URL|off | blocking-only on|off]`. */
function handleNotifications(input: string, ctx: CommandContext): void {
  const parsed = parseNotificationsArgs(input.trim().split(/\s+/).slice(1));
  if ("error" in parsed) {
    sysMsg(ctx, parsed.error);
    return;
  }
  if ("change" in parsed) {
    saveNotifications(ctx, parsed.change);
    return;
  }
  const current = loadConfig().notifications;
  const url = current?.webhook?.url;
  ctx.openCommandPicker({
    title: "Run Notifications",
    icon: icon("info"),
    scopeEnabled: false,
    options: [
      {
        value: "system",
        label: `System notifications: ${current?.system === false ? "off" : "on"}`,
        description: "desktop notifications from the terminal app and the CLI",
      },
      {
        value: "webhook",
        label: `Webhook: ${url ?? "none"}`,
        description: "set with /notifications webhook URL",
      },
      ...(url
        ? [
            {
              value: "blocking",
              label: `Blocking requests only: ${current?.webhook?.blockingOnly ? "on" : "off"}`,
              description: "skip advisory acceptance decisions",
            },
            { value: "remove", label: "Remove webhook", description: "nothing is sent" },
          ]
        : []),
    ],
    onSelect: (value) => {
      if (value === "system") saveNotifications(ctx, { system: current?.system === false });
      else if (value === "blocking")
        saveNotifications(ctx, { blockingOnly: current?.webhook?.blockingOnly !== true });
      else if (value === "remove") saveNotifications(ctx, { webhookUrl: null });
      else
        sysMsg(
          ctx,
          [
            ...describeNotifications(current),
            "Set the webhook with /notifications webhook URL; headers such as a token go in notifications.webhook.headers of the config file.",
          ].join("\n"),
        );
    },
  });
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/chat-style", handleChatStyle);
  map.set("/mode", handleMode);
  map.set("/verbose", handleVerbose);
  map.set("/reasoning", handleReasoning);
  map.set("/motion", handleMotion);
  map.set("/compact settings", handleCompaction);
  map.set("/compaction", handleCompaction); // legacy alias
  map.set("/agent-features", handleAgentFeatures);
  map.set("/instructions", handleInstructions);
  map.set("/diff-style", handleDiffStyle); // legacy alias
  map.set("/model-scope", handleModelScope);
  map.set("/settings", handleSettingsHub);
  map.set("/verbose-tab", handleVerboseTab);
  map.set("/theme", handleTheme);
  map.set("/timeouts", handleTimeouts);
  map.set("/watchdog", handleTimeouts); // alias for /timeouts
  map.set("/context-window", handleContextWindow);
  map.set("/ctxwin", handleContextWindow); // alias
  map.set("/telemetry", handleTelemetry);
  map.set("/sandbox", handleSandbox);
  map.set("/notifications", handleNotifications);
}

export function matchConfigPrefix(cmd: string): CommandHandler | null {
  if (cmd === "/chat-style" || cmd.startsWith("/chat-style ")) return handleChatStyle;
  if (cmd === "/mode" || cmd.startsWith("/mode ")) return handleMode;
  if (cmd === "/theme" || cmd.startsWith("/theme ")) return handleTheme;
  if (cmd.startsWith("/telemetry ")) return handleTelemetry;
  if (cmd.startsWith("/sandbox ")) return handleSandbox;
  if (cmd.startsWith("/notifications ")) return handleNotifications;
  if (
    cmd === "/context-window" ||
    cmd === "/ctxwin" ||
    cmd === "/ctx-window" ||
    cmd.startsWith("/context-window ") ||
    cmd.startsWith("/ctxwin ") ||
    cmd.startsWith("/ctx-window ")
  )
    return handleContextWindow;
  return null;
}
function handleContextWindow(input: string, ctx: CommandContext): void {
  const trimmed = input
    .trim()
    .replace(/^\/(context-window|ctxwin|ctx-window)\s*/, "")
    .trim();
  const cfg = loadConfig();
  const existing = cfg.contextWindowOverrides ?? {};

  if (!trimmed) {
    const lines = Object.entries(existing).map(([m, t]) => `  ${m} → ${t.toLocaleString()} tok`);
    sysMsg(
      ctx,
      lines.length
        ? `Context window overrides:\n${lines.join("\n")}\n\nSet: /context-window <model> <tokens>\nClear: /context-window <model> clear\nClear all: /context-window clear`
        : `No context window overrides set.\n\nSet: /context-window <model> <tokens>\nExample: /context-window openai/gpt-5.5 400000`,
    );
    return;
  }

  if (trimmed === "clear") {
    ctx.saveToScope({ contextWindowOverrides: undefined }, "global");
    sysMsg(ctx, "Cleared all context window overrides.");
    return;
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) {
    sysMsg(ctx, `Usage: /context-window <model-id> <tokens|clear>`);
    return;
  }

  const modelId = parts[0];
  const valueArg = parts[1];
  if (!modelId || !valueArg) {
    sysMsg(ctx, `Usage: /context-window <model-id> <tokens|clear>`);
    return;
  }
  const next = { ...existing };

  if (valueArg === "clear" || valueArg === "off" || valueArg === "none") {
    delete next[modelId];
    ctx.saveToScope({ contextWindowOverrides: next }, "global");
    sysMsg(ctx, `Cleared context window override for ${modelId}.`);
    return;
  }

  const tokens = Number(valueArg.replace(/[_,]/g, ""));
  if (!Number.isFinite(tokens) || tokens <= 0) {
    sysMsg(ctx, `Invalid token count: "${valueArg}". Must be a positive integer.`);
    return;
  }

  next[modelId] = Math.floor(tokens);
  ctx.saveToScope({ contextWindowOverrides: next }, "global");
  sysMsg(ctx, `Context window for ${modelId} → ${Math.floor(tokens).toLocaleString()} tokens.`);
}
