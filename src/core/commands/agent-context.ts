import { agentContextPreview } from "../agent-context.js";
import { icon } from "../icons.js";
import { ProjectService } from "../projects/service.js";
import { DEFAULT_WORKING_SET_MAX_BYTES } from "../projects/working-set.js";
import { getThemeTokens } from "../theme/index.js";
import { editInstruction, handleInstructions } from "./config.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

const USAGE = "Usage: /agent-context [preview | add <path|glob>... | remove <entry>...]";

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** The project context every agent's prompt carries, as one popup. */
function showPreview(ctx: CommandContext): void {
  const preview = agentContextPreview(ctx.cwd, ctx.instructionFiles);
  const block = (text: string) =>
    (text || "(nothing)")
      .split("\n")
      .map((line) => ({ type: "text" as const, label: line || " " }));
  ctx.openInfoPopup({
    title: `What an agent receives: ${kb(preview.bytes)}`,
    icon: icon("context"),
    width: 100,
    lines: [
      { type: "entry", label: "Rules", desc: kb(preview.instructions.bytes) },
      { type: "separator" },
      ...block(preview.instructions.text),
      { type: "separator" },
      { type: "entry", label: "Files", desc: kb(preview.workingSet?.bytes ?? 0) },
      { type: "separator" },
      ...block(preview.workingSet?.text ?? ""),
    ],
  });
}

function changeWorkingSet(ctx: CommandContext, verb: "add" | "remove", entries: string[]): void {
  if (entries.length === 0) {
    sysMsg(ctx, USAGE);
    return;
  }
  try {
    const service = new ProjectService(ctx.cwd);
    const project =
      verb === "add" ? service.addToWorkingSet(entries) : service.removeFromWorkingSet(entries);
    // The chat captures the working set again for its next prompt.
    ctx.contextManager.refreshWorkingSet();
    sysMsg(ctx, `Working set: ${project.manifest.workingSet.join(", ") || "(empty)"}`);
  } catch (error) {
    sysMsg(ctx, error instanceof Error ? error.message : String(error));
  }
}

/**
 * One screen for what agents get from this project: Rules (instruction files, Enter edits one)
 * and Files (the working set), with the prompt budget both take and a preview.
 */
async function handleAgentContext(input: string, ctx: CommandContext): Promise<void> {
  const [sub = "", ...rest] = input.trim().split(/\s+/).slice(1);
  if (sub === "preview") return showPreview(ctx);
  if (sub === "add" || sub === "remove") return changeWorkingSet(ctx, sub, rest);
  if (sub) {
    sysMsg(ctx, USAGE);
    return;
  }

  const { listInstructionFiles } = await import("../instruction-files.js");
  const t = getThemeTokens();
  const rules = listInstructionFiles(ctx.cwd, ctx.instructionFiles);
  const service = new ProjectService(ctx.cwd);
  const project = service.current();
  const set = project ? service.summary(1).workingSet : null;
  const preview = agentContextPreview(ctx.cwd, ctx.instructionFiles);
  const sent = preview.workingSet?.bytes ?? 0;

  const options = [
    {
      value: "preview",
      icon: icon("context"),
      label: `Preview what an agent receives: ${kb(preview.bytes)}`,
      description: `rules ${kb(preview.instructions.bytes)} + files ${kb(sent)} (files budget ${kb(DEFAULT_WORKING_SET_MAX_BYTES)})`,
    },
    {
      value: "sep:rules",
      label: `Rules · ${rules.filter((f) => f.enabled).length} read`,
      kind: "separator" as const,
    },
    ...rules.map((f) => ({
      value: `rule:${f.path}`,
      icon: f.enabled ? String(f.order) : " ",
      color: f.enabled ? t.textPrimary : t.textMuted,
      label: f.scope === "global" ? `~/${f.path}` : f.path,
      description: `${f.sourceLabel} · ${f.enabled ? "read by agents" : "off"} · ${kb(f.bytes)} · Enter edits`,
    })),
    {
      value: "sources",
      label: "Switch rule sources…",
      description: "Which kinds of instruction files agents read (/instructions)",
    },
    {
      value: "sep:files",
      label: set ? `Files · ${set.files.length} in the working set` : "Files",
      kind: "separator" as const,
    },
    ...(set
      ? [
          ...set.entries.map((entry) => ({
            value: `entry:${entry}`,
            label: entry,
            description: `/agent-context remove ${entry} drops it`,
            disabled: true,
          })),
          ...set.skipped.map((s) => ({
            value: `skip:${s.path}`,
            color: t.warning,
            label: s.path,
            description: `left out: ${s.reason}`,
            disabled: true,
          })),
          {
            value: "add",
            label: "Add to the working set…",
            description: "/agent-context add <path|glob>",
          },
        ]
      : [
          {
            value: "no-project",
            label: "No baked/project.json",
            description: "baked project init creates one; the working set lives there",
            disabled: true,
          },
        ]),
  ];

  ctx.openCommandPicker({
    title: "Agent Context",
    icon: icon("context"),
    options,
    onSelect: (value) => {
      if (value === "preview") showPreview(ctx);
      else if (value === "sources") void handleInstructions("/instructions", ctx);
      else if (value === "add") sysMsg(ctx, "Type /agent-context add <path|glob> to add files.");
      else if (value.startsWith("rule:")) void editInstruction(ctx, value.slice(5));
    },
  });
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/agent-context", handleAgentContext as CommandHandler);
}
