import { basename } from "node:path";
import { loadConfig, loadProjectConfig, mergeConfigs } from "../../config/index.js";
import { useUIStore } from "../../stores/ui.js";
import { useWorkflowStore } from "../../stores/workflow.js";
import { currentTerminalHandoff, editTextInEditor } from "../chat/external-editor.js";
import {
  AGENT_STAGES,
  type AgentStage,
  agentOrigins,
  conversionBases,
  convertAgents,
  describeConversion,
  type FoundAgent,
  forgetAgentPresence,
  freeWorkflowId,
  listAgents,
  removeAgentFile,
  STAGE_LABELS,
  writeAgentFile,
} from "../workflows/agent-import.js";
import { defaultWorkflowPolicy } from "../workflows/defaults.js";
import { WorkflowFault } from "../workflows/errors.js";
import { PolicySchema, type RunPolicy, SafeId } from "../workflows/schemas.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

/**
 * `/agents`: custom agents the project brought from other tools (#832). BAKED is customized
 * through workflows, so this command exists for projects that already have such agents: it lists
 * them, edits one in `$EDITOR`, and turns them into a workflow, after which their files can go.
 * The palette shows it only in such projects. The work is done by src/core/workflows/agent-import.ts.
 */

const usage = "Usage: /agents | /agents convert [WORKFLOW_ID] | /agents edit NAME";

/** Up to nine agents get a stage selector, on the keys 1 to 9. */
const SELECTOR_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

const policyOf = (cwd: string): RunPolicy =>
  PolicySchema.parse(
    mergeConfigs(loadConfig(), loadProjectConfig(cwd)).workflows?.policy ?? defaultWorkflowPolicy,
  );

const byName = (agents: FoundAgent[], name: string): FoundAgent | undefined =>
  agents.find((a) => a.name === name || a.key === name || basename(a.path) === name);

function noAgents(ctx: CommandContext): void {
  sysMsg(
    ctx,
    "This project has no custom agents. BAKED is customized through workflows: /workflow edit ID opens one in the editor.",
  );
}

/** The conversion picker: a stage per agent (keys 1-9), the base workflow (b) and removal (r). */
function convert(ctx: CommandContext, agents: FoundAgent[], requestedId?: string): void {
  const stages = new Map<string, AgentStage>(agents.map((a) => [a.key, a.stage]));
  const bases = conversionBases(ctx.cwd, policyOf(ctx.cwd));
  let base = bases[0] ?? "standard";
  let removeOriginals = true;
  const workflowId = requestedId ?? freeWorkflowId(ctx.cwd);
  const shown = agents.slice(0, SELECTOR_KEYS.length);
  const summary = () =>
    agents
      .filter((a) => stages.get(a.key) !== "skip")
      .map((a) => `${STAGE_LABELS[stages.get(a.key) ?? "skip"]} ← ${a.name}`)
      .join(" · ") || "no agent chosen";
  ctx.openCommandPicker({
    title: `Turn ${agents.length} agent${agents.length === 1 ? "" : "s"} into workflow ${workflowId}`,
    icon: "✦",
    maxWidth: 96,
    options: [
      {
        value: "convert",
        label: `Make workflow ${workflowId}`,
        description: "Each agent becomes a step of the workflow; the editor opens next",
        icon: "✓",
      },
      { value: "cancel", label: "Not now", icon: "✕" },
    ],
    selectors: [
      ...shown.map((a, i) => ({
        key: SELECTOR_KEYS[i] ?? String(i + 1),
        label: `${a.name} (${a.sourceLabel})`,
        options: AGENT_STAGES.map((s) => STAGE_LABELS[s]),
        value: AGENT_STAGES.indexOf(a.stage),
        onChange: (index: number) => stages.set(a.key, AGENT_STAGES[index] ?? "skip"),
      })),
      ...(bases.length > 1
        ? [
            {
              key: "b",
              label: "Based on",
              options: bases,
              value: 0,
              onChange: (index: number) => {
                base = bases[index] ?? base;
              },
            },
          ]
        : []),
    ],
    toggles: [
      {
        key: "r",
        label: "Remove the agent files afterwards",
        value: true,
        onToggle: () => {
          removeOriginals = !removeOriginals;
          return undefined;
        },
      },
    ],
    onSelect: (value) => {
      if (value !== "convert") {
        sysMsg(ctx, `Nothing changed. Planned: ${summary()}.`);
        return;
      }
      try {
        const result = convertAgents(ctx.cwd, policyOf(ctx.cwd), {
          workflowId,
          from: base,
          agents: agents.map((a) => ({ key: a.key, stage: stages.get(a.key) ?? "skip" })),
          removeOriginals,
        });
        forgetAgentPresence(ctx.cwd);
        sysMsg(
          ctx,
          [
            ...describeConversion(result),
            `Run it with /workflow new, pick ${result.workflowId}. The editor is open on it now.`,
          ].join("\n"),
        );
        useWorkflowStore.getState().showEditor(result.workflowId);
        useUIStore.getState().openModal("workflow");
      } catch (error) {
        if (error instanceof WorkflowFault || error instanceof Error)
          sysMsg(ctx, `Not converted: ${error.message}`);
        else throw error;
      }
    },
  });
  if (agents.length > shown.length)
    sysMsg(
      ctx,
      `Only the first ${shown.length} agents have a stage selector here; the others keep their suggested stage. /agents edit NAME changes an agent first.`,
    );
}

async function edit(ctx: CommandContext, found: FoundAgent): Promise<void> {
  const handoff = currentTerminalHandoff();
  const result = await editTextInEditor(found.content, {
    ...(handoff ? { suspend: handoff.suspend, resume: handoff.resume } : {}),
    fileName: basename(found.path),
  });
  if (result.status !== "saved") {
    sysMsg(
      ctx,
      result.status === "error" ? result.message : `${found.path} was not saved: ${result.reason}`,
    );
    return;
  }
  const text = found.content.endsWith("\n") ? `${result.text}\n` : result.text;
  if (text === found.content) {
    sysMsg(ctx, `${found.path} is unchanged.`);
    return;
  }
  const written = writeAgentFile(ctx.cwd, found.key, text, found.hash);
  sysMsg(ctx, written.status === "written" ? `Saved ${found.path}.` : written.message);
}

function remove(ctx: CommandContext, found: FoundAgent): void {
  ctx.openCommandPicker({
    title: `Remove ${found.path}?`,
    icon: "⚠",
    options: [
      { value: "remove", label: "Remove the file", icon: "✓" },
      { value: "cancel", label: "Keep it", icon: "✕" },
    ],
    onSelect: (value) => {
      if (value !== "remove") return;
      const removed = removeAgentFile(ctx.cwd, found.key, found.hash);
      sysMsg(ctx, removed.status === "written" ? `Removed ${found.path}.` : removed.message);
    },
  });
}

/** One agent: edit it, remove its file, or go back to the list. */
function agentMenu(ctx: CommandContext, found: FoundAgent, agents: FoundAgent[]): void {
  ctx.openCommandPicker({
    title: `${found.name} · ${found.sourceLabel} · ${found.path}`,
    icon: "◆",
    maxWidth: 96,
    options: [
      { value: "edit", label: "Edit in $EDITOR", icon: "✎" },
      ...(found.removable
        ? [{ value: "remove", label: "Remove the file", icon: "✕" }]
        : [
            {
              value: "roo",
              label: `Edit ${found.path} to remove this mode`,
              icon: "·",
              disabled: true,
            },
          ]),
      { value: "back", label: "Back", icon: "←" },
    ],
    onSelect: (value) => {
      if (value === "edit") void edit(ctx, found);
      else if (value === "remove") remove(ctx, found);
      else if (value === "back") list(ctx, agents);
    },
  });
}

/** The agents with a nudge to make them a workflow first. */
function list(ctx: CommandContext, agents: FoundAgent[]): void {
  ctx.openCommandPicker({
    title: `${agents.length} agent${agents.length === 1 ? "" : "s"} from ${agentOrigins(agents)}`,
    icon: "◆",
    maxWidth: 96,
    options: [
      {
        value: "convert",
        label: "Turn them into a workflow",
        description: "BAKED runs agents as steps of a workflow, with its checks and reviews",
        icon: "✦",
      },
      { value: "sep", label: "", kind: "separator" },
      ...agents.map((a) => ({
        value: `agent:${a.key}`,
        label: a.name,
        description: `${STAGE_LABELS[a.stage]} · ${a.path}${a.description ? ` · ${a.description}` : ""}`,
        icon: a.orchestrator ? "⇄" : "◇",
      })),
    ],
    onSelect: (value) => {
      if (value === "convert") convert(ctx, agents);
      const found = agents.find((a) => `agent:${a.key}` === value);
      if (found) agentMenu(ctx, found, agents);
    },
  });
}

export async function handleAgents(input: string, ctx: CommandContext): Promise<void> {
  const [sub = "", ...words] = input
    .trim()
    .replace(/^\/agents\b\s*/, "")
    .split(/\s+/)
    .filter(Boolean);
  const { agents, problems } = listAgents(ctx.cwd);
  for (const problem of problems) sysMsg(ctx, `Could not read ${problem}`);
  if (!agents.length) {
    if (!problems.length) noAgents(ctx);
    return;
  }
  if (sub === "") return list(ctx, agents);
  if (sub === "convert" && words.length <= 1) {
    const id = words[0];
    if (id && !SafeId.safeParse(id).success) {
      sysMsg(ctx, `${id} is not a workflow ID: letters, digits, - and _.`);
      return;
    }
    return convert(ctx, agents, id);
  }
  if (sub === "edit" && words.length === 1) {
    const found = byName(agents, words[0] ?? "");
    if (found) return edit(ctx, found);
    sysMsg(ctx, `No agent ${words[0]}. /agents lists them.`);
    return;
  }
  sysMsg(ctx, usage);
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/agents", (input, ctx) => handleAgents(input, ctx));
}
