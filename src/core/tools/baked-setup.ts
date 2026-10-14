/**
 * `baked_setup`: the chat's way to read and change how BAKED is set up for a project, the same
 * things the Setup screens edit: workflows, agent context (instruction files), chat memory,
 * skills, packages, hooks, MCP servers and language servers. Every area goes through the shared
 * core its screens use, so the chat, the coordinator, the terminal UI and the desktop app write
 * the same files the same way. Reading runs nothing; every change is shown to the person on an
 * approval card first and is refused without an approval callback.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import {
  loadConfig,
  loadEffectiveProjectConfig,
  mergeConfigs,
  mergeMCPServers,
} from "../../config/index.js";
import type { AppConfig } from "../../types/index.js";
import { addHook, HookEditError, removeHook } from "../hooks/edit.js";
import { hooksOverview } from "../hooks/overview.js";
import { HOOK_EVENTS } from "../hooks/types.js";
import {
  findInstructionFile,
  listInstructionFiles,
  sourceForNewFile,
  workspaceRunsFreezing,
  writeInstructionFile,
} from "../instruction-files.js";
import {
  installLspServer,
  type LspServiceOptions,
  lspStatus,
  setLspServerDisabled,
} from "../intelligence/lsp-service.js";
import {
  applyMCPChange,
  type MCPChange,
  type MCPConfigFiles,
  type MCPScope,
  mcpServerViews,
  readMCPLayers,
  writeMCPLayers,
} from "../mcp/config.js";
import { chatMemoryView, editChatMemory, setChatMemorySettings } from "../memory/browse.js";
import type { MemoryManager } from "../memory/manager.js";
import type { MemoryScope } from "../memory/types.js";
import { packPackage } from "../packages/pack.js";
import {
  describeInstall,
  describeInstalled,
  describePlan,
  describeRemoval,
  inspectPackage,
  installPackage,
  listPackages,
  removePackage,
} from "../packages/packages.js";
import { configDir, userHome } from "../platform/index.js";
import { listInstalledSkills, removeInstalledSkill } from "../skills/manager.js";
import { ensurebakedDir } from "../utils/ensure-baked-dir.js";
import { defaultWorkflowPolicy } from "../workflows/defaults.js";
import { PolicySchema, SafeId } from "../workflows/schemas.js";
import { Outcome } from "../workflows/v2/definition.js";
import { listDefinitions } from "../workflows/v2/definitions.js";
import {
  definitionPath,
  INSERTABLE_STAGES,
  removeDefinitionFile,
  writeDefinitionFile,
} from "../workflows/v2/editor.js";
import {
  applyEditorOp,
  type EditorOp,
  editorState,
  editorView,
  reviewEditor,
} from "../workflows/v2/editor-service.js";

export const SETUP_TOOL = "baked_setup";

export const SETUP_AREAS = [
  "workflow",
  "agent_context",
  "memory",
  "skill",
  "package",
  "hook",
  "mcp",
  "lsp",
] as const;
export type SetupArea = (typeof SETUP_AREAS)[number];

/** Actions that only read; restricted chat modes allow these and refuse the rest. */
export const SETUP_READ_ACTIONS = ["list", "show", "inspect"] as const;

/** The actions each area takes; anything else is refused with this list. */
const AREA_ACTIONS: Record<SetupArea, readonly string[]> = {
  workflow: ["list", "show", "create", "edit", "remove"],
  agent_context: ["list", "show", "write"],
  memory: ["list", "edit", "pin", "unpin", "hide", "restore", "share_with_runs"],
  skill: ["list", "show", "create", "remove"],
  package: ["list", "inspect", "install", "remove", "create"],
  hook: ["list", "add", "remove"],
  mcp: ["list", "add", "edit", "enable", "disable", "remove"],
  lsp: ["list", "install", "enable", "disable"],
};

// Gate bindings are left to the gate setup; these are the workflow editor's other operations.
const WorkflowOp = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("addStage"),
    stageType: z.enum(INSERTABLE_STAGES),
    transition: z.string().describe("ID of the transition the new stage is inserted into"),
  }),
  z.strictObject({ op: z.literal("removeStage"), stageId: z.string() }),
  z.strictObject({ op: z.literal("addWaitStage"), after: z.string() }),
  z.strictObject({ op: z.literal("removeWaitStage"), stageId: z.string() }),
  z.strictObject({
    op: z.literal("addTransition"),
    from: z.string(),
    to: z.string(),
    on: Outcome,
    loop: z.number().int().min(1).max(20).nullable().default(null),
  }),
  z.strictObject({ op: z.literal("removeTransition"), id: z.string() }),
  z.strictObject({
    op: z.literal("changeField"),
    stageId: z.string(),
    key: z.string().describe("A field key as `show` lists it: profile, decision, covers:ID, …"),
    delta: z.union([z.literal(1), z.literal(-1)]),
  }),
  z.strictObject({ op: z.literal("setLoop"), id: z.string(), rounds: z.number().int().min(1) }),
]);

const McpServerInput = z.strictObject({
  transport: z.enum(["stdio", "http", "sse"]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeout: z.number().int().optional(),
});

export const SetupInput = z.strictObject({
  area: z.enum(SETUP_AREAS),
  action: z
    .string()
    .describe(
      "workflow: list|show|create|edit|remove · agent_context: list|show|write · memory: list|edit|pin|unpin|hide|restore|share_with_runs · skill: list|show|create|remove · package: list|inspect|install|remove|create · hook: list|add|remove · mcp: list|add|edit|enable|disable|remove · lsp: list|install|enable|disable",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "What the action is about: a workflow ID, instruction file path, memory ID, skill, package, hook ID, MCP server or language server (or language)",
    ),
  scope: z
    .enum(["project", "global"])
    .optional()
    .describe("project (default) or global for every project"),
  from: z.string().optional().describe("workflow create: the workflow to start from"),
  description: z.string().optional().describe("workflow, skill or package description"),
  ops: z.array(WorkflowOp).max(40).optional().describe("workflow create/edit: editor operations"),
  content: z
    .string()
    .optional()
    .describe("agent_context write: the whole file · skill create: the SKILL.md body"),
  details: z.string().optional().describe("memory edit: new details"),
  enabled: z.boolean().optional().describe("memory share_with_runs: on or off"),
  path: z
    .string()
    .optional()
    .describe("package inspect/install/create: the package folder, relative to the project"),
  version: z.string().optional().describe("package create: the version"),
  overwrite: z
    .boolean()
    .optional()
    .describe("package install: replace project files the package also ships"),
  event: z.enum(HOOK_EVENTS).optional().describe("hook add: the event"),
  matcher: z.string().optional().describe("hook add: tool or kind matcher"),
  command: z.string().optional().describe("hook add: the shell command"),
  timeout: z.number().int().optional().describe("hook add: seconds"),
  async: z.boolean().optional().describe("hook add: do not wait for the command"),
  server: McpServerInput.optional().describe("mcp add/edit: the server"),
});
export type SetupArgs = z.infer<typeof SetupInput>;

export interface SetupToolOptions {
  cwd: string;
  /** Shows the change to the person and resolves true when they approve it. */
  approve?: (description: string) => Promise<boolean>;
  /** The chat memory; memory actions are refused without one. */
  memory?: () => MemoryManager | Promise<MemoryManager>;
  /** The effective config; defaults to the global config merged with the project's. */
  config?: () => AppConfig;
  homeDir?: string;
  /** The global config folder (`~/.baked`); tests point it elsewhere. */
  configDir?: string;
  lsp?: Pick<LspServiceOptions, "deps">;
  /**
   * Called after an MCP change with the effective servers; by default the shared MCP manager
   * follows them once it connected anything, as after a change on the MCP servers screen.
   */
  onMcpChange?: (servers: NonNullable<AppConfig["mcpServers"]>) => void;
}

interface Result {
  success: boolean;
  output: string;
  error?: string;
}

class SetupError extends Error {}

const ok = (output: string): Result => ({ success: true, output });
const fail = (error: string): Result => ({ success: false, output: error, error });
const need = <T>(value: T | undefined | null, what: string): T => {
  if (value === undefined || value === null || value === "") throw new SetupError(`Give ${what}`);
  return value;
};
const clip = (text: string, max = 6000): string =>
  text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;

/** The setup tool for one workspace. */
export function createSetupTool(options: SetupToolOptions) {
  const workspace = options.cwd;
  const home = options.homeDir ?? userHome();
  const globalDir = options.configDir ?? configDir();
  const config = (): AppConfig =>
    options.config?.() ?? mergeConfigs(loadConfig(), loadEffectiveProjectConfig(workspace));
  const policy = () => PolicySchema.parse(config().workflows?.policy ?? defaultWorkflowPolicy);

  /** Asks the person; throws when nobody can be asked or they decline. */
  const confirm = async (description: string): Promise<void> => {
    if (!options.approve)
      throw new SetupError(
        "Changing BAKED's setup needs a person to approve it, and this session cannot ask one",
      );
    if (!(await options.approve(description)))
      throw new SetupError("The person declined the change; nothing was written");
  };

  // ── Workflows ─────────────────────────────────────────────────────────────

  const workflowList = (): string => {
    const lines = listDefinitions(workspace, policy()).map(
      (d) =>
        `- ${d.id} (${d.source}${d.writes ? ", writes files" : ""}): ${d.description} — ${d.stages.join(" → ")}${d.problems.length ? ` [problems: ${d.problems.join("; ")}]` : ""}`,
    );
    return lines.length ? lines.join("\n") : "No workflows.";
  };

  const workflowShow = (id: string): string => {
    const state = editorState(workspace, policy(), { from: id });
    const view = editorView(state, { from: id }, null);
    const d = view.definition;
    return [
      `Workflow ${d.id}: ${d.description}`,
      view.readOnly
        ? `Read only (built-in or schema 1); change a copy: action create with from: "${id}".`
        : "",
      "Stages:",
      ...view.stages.map(
        (s) =>
          `- ${s.id} (${s.type})${s.fields.length ? `: ${s.fields.map((f) => `${f.key}=${f.value}`).join(", ")}` : ""}`,
      ),
      "Transitions:",
      ...d.transitions.map(
        (t) =>
          `- ${t.id}: ${t.from} → ${t.to} on ${t.on}${t.loop ? ` (loop up to ${t.loop.maxIterations})` : ""}`,
      ),
      view.problems.length
        ? `Problems: ${view.problems.map((p) => `${p.owner}: ${p.messages.join("; ")}`).join(" | ")}`
        : "",
      `Estimate: ${view.estimate}`,
    ]
      .filter(Boolean)
      .join("\n");
  };

  const applyOps = (
    initial: ReturnType<typeof editorState>,
    ops: readonly EditorOp[],
  ): ReturnType<typeof editorState> => {
    let state = initial;
    for (const op of ops) {
      const result = applyEditorOp(state, op);
      if (result.error) throw new SetupError(`${op.op}: ${result.error}`);
      state = result.state;
    }
    return state;
  };

  const saveWorkflow = async (
    state: ReturnType<typeof editorState>,
    verb: "Create" | "Change",
  ): Promise<string> => {
    const review = reviewEditor(state, workspace);
    if (review.kind === "read-only") throw new SetupError(review.message);
    if (review.kind === "unchanged") return `Workflow ${state.id} is unchanged.`;
    if (review.kind === "problems")
      throw new SetupError(
        `The workflow would not run: ${review.groups.map((g) => `${g.owner}: ${g.messages.join("; ")}`).join(" | ")}`,
      );
    if (review.autoApproval)
      throw new SetupError(
        "This change turns on auto approval, which needs a typed confirmation in the workflow editor",
      );
    await confirm(
      [
        `${verb} workflow ${state.id} (${review.path})`,
        `Gates: ${review.gates.length ? review.gates.join(", ") : "none"}`,
        clip(review.diff.join("\n")),
      ].join("\n\n"),
    );
    const current = existsSync(review.path) ? readFileSync(review.path, "utf8") : null;
    if (current !== state.savedText)
      throw new SetupError(`${review.path} changed while waiting for approval; show it again`);
    const path = writeDefinitionFile(workspace, state.definition);
    return `${verb === "Create" ? "Created" : "Saved"} workflow ${state.id} at ${path}.`;
  };

  const workflow = async (args: SetupArgs): Promise<string> => {
    switch (args.action) {
      case "list":
        return workflowList();
      case "show":
        return workflowShow(need(args.name, "the workflow ID as name"));
      case "create": {
        const from = args.from ?? config().workflows?.defaultWorkflow ?? "sdd";
        let state = editorState(workspace, policy(), { from, copy: true });
        if (args.name) {
          const id = SafeId.safeParse(args.name);
          if (!id.success)
            throw new SetupError("A workflow ID is letters, digits, - and _, up to 96 characters");
          if (state.takenIds.includes(id.data) || existsSync(definitionPath(workspace, id.data)))
            throw new SetupError(`A workflow named ${id.data} already exists`);
          state = { ...state, id: id.data, definition: { ...state.definition, id: id.data } };
        }
        if (args.description)
          state = { ...state, definition: { ...state.definition, description: args.description } };
        return saveWorkflow(applyOps(state, args.ops ?? []), "Create");
      }
      case "edit": {
        const id = need(args.name, "the workflow ID as name");
        let state = editorState(workspace, policy(), { from: id });
        if (state.readOnly)
          throw new SetupError(
            `${id} is read only (built-in or schema 1); change a copy: action create with from: "${id}".`,
          );
        if (args.description)
          state = { ...state, definition: { ...state.definition, description: args.description } };
        return saveWorkflow(
          applyOps(state, need(args.ops ?? (args.description ? [] : undefined), "ops")),
          "Change",
        );
      }
      case "remove": {
        const id = SafeId.parse(need(args.name, "the workflow ID as name"));
        const path = definitionPath(workspace, id);
        if (!existsSync(path))
          throw new SetupError(`${id} is not a project workflow; built-in workflows stay`);
        await confirm(`Delete workflow ${id} (${path})`);
        const removed = removeDefinitionFile(workspace, id);
        return removed.restores
          ? `Deleted workflow ${id}; new runs use the built-in ${id} again.`
          : `Deleted workflow ${id}.`;
      }
    }
    throw new SetupError("unreachable");
  };

  // ── Agent context (instruction files) ─────────────────────────────────────

  const agentContext = async (args: SetupArgs): Promise<string> => {
    const configured = config().instructionFiles;
    const files = () => listInstructionFiles(workspace, configured, { homeDir: home });
    switch (args.action) {
      case "list": {
        const list = files();
        if (!list.length)
          return "No instruction files. Write AGENTS.md (action write) to give every agent project instructions.";
        return list
          .map(
            (f) =>
              `- ${f.path} (${f.scope}, ${f.sourceLabel}, ${f.enabled ? `read as #${f.order}` : "off"}, ${f.bytes} bytes)`,
          )
          .join("\n");
      }
      case "show": {
        const path = need(args.name, "the file path as name");
        const entry = findInstructionFile(files(), path);
        if (!entry) throw new SetupError(`${path} is not an instruction file agents read`);
        return `${entry.path} (${entry.scope}, ${entry.enabled ? "read by agents" : "its source is off"}):\n\n${entry.content}`;
      }
      case "write": {
        const path = args.name ?? "AGENTS.md";
        const content = need(args.content, "the whole file as content");
        const entry = findInstructionFile(files(), path);
        if (!entry && !sourceForNewFile(path))
          throw new SetupError(`${path} is not a file name an instruction source reads`);
        const target = entry?.absolutePath ?? resolve(workspace, path);
        await confirm(
          [
            `${entry ? "Rewrite" : "Create"} the agent context file ${path} (${target}); every agent reads it.`,
            clip(content),
          ].join("\n\n"),
        );
        const text = content.endsWith("\n") ? content : `${content}\n`;
        const written = writeInstructionFile(workspace, files(), path, text, entry?.hash ?? null);
        if (written.status !== "saved") throw new SetupError(written.message);
        const runs = workspaceRunsFreezing(workspace, written.absolutePath);
        return `Saved ${path}.${runs.length ? ` Runs that froze the old file keep it: ${runs.join(", ")}.` : ""}`;
      }
    }
    throw new SetupError("unreachable");
  };

  // ── Chat memory ───────────────────────────────────────────────────────────

  const memory = async (args: SetupArgs): Promise<string> => {
    if (!options.memory) throw new SetupError("Chat memory is not available in this session");
    const manager = await options.memory();
    if (args.action === "list") {
      const view = chatMemoryView(manager);
      const entries = view.entries.map(
        (m) => `- ${m.id.slice(0, 8)} (${m.scope}${m.pinned ? ", pinned" : ""}) ${m.summary}`,
      );
      return [
        `Write scope ${view.settings.writeScope}, read scope ${view.settings.readScope}, shared with workflow runs: ${view.settings.shareWithRuns ? "yes" : "no"}.`,
        entries.length ? entries.join("\n") : "No memories.",
        view.hidden.length ? `${view.hidden.length} hidden (restore by ID).` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (args.action === "share_with_runs") {
      const enabled = need(args.enabled, "enabled");
      await confirm(
        enabled
          ? "Share chat memory with workflow runs: their agents will read it."
          : "Stop sharing chat memory with workflow runs.",
      );
      setChatMemorySettings(manager, { shareWithRuns: enabled });
      return `Chat memory is ${enabled ? "now" : "no longer"} shared with workflow runs.`;
    }
    const prefix = need(args.name, "the memory ID as name");
    const found = manager
      .list("all", { includeHidden: true })
      .filter((m) => m.id.startsWith(prefix) && (!args.scope || m.scope === args.scope));
    if (found.length !== 1)
      throw new SetupError(
        found.length
          ? `${prefix} matches ${found.length} memories; give more of the ID`
          : `No memory ${prefix}`,
      );
    const record = found[0] as (typeof found)[number];
    const scope: MemoryScope = record.scope;
    const action = args.action as "edit" | "pin" | "unpin" | "hide" | "restore";
    if (action === "edit") {
      const summary = need(args.content, "the new summary as content");
      await confirm(
        `Change memory ${record.id.slice(0, 8)}:\n\n- ${record.summary}\n+ ${summary}${args.details ? `\n\nDetails: ${args.details}` : ""}`,
      );
      editChatMemory(manager, {
        action,
        scope,
        id: record.id,
        summary,
        ...(args.details !== undefined ? { details: args.details } : {}),
      });
    } else {
      await confirm(`${action[0]?.toUpperCase()}${action.slice(1)} memory: ${record.summary}`);
      editChatMemory(manager, { action, scope, id: record.id });
    }
    return `Done: ${action} ${record.id.slice(0, 8)}.`;
  };

  // ── Skills ────────────────────────────────────────────────────────────────

  const skillDir = (scope: "project" | "global", name: string): string =>
    scope === "global"
      ? join(home, ".baked", "skills", name)
      : join(workspace, ".baked", "skills", name);

  const skill = async (args: SetupArgs): Promise<string> => {
    const installed = () => listInstalledSkills({ cwd: workspace, home });
    switch (args.action) {
      case "list": {
        const list = installed();
        return list.length
          ? list.map((s) => `- ${s.name} (${s.scope}) ${s.path}`).join("\n")
          : "No skills. Create one (action create) or search skills.sh with the skills tool.";
      }
      case "show": {
        const name = need(args.name, "the skill name");
        const found = installed().find((s) => s.name === name);
        if (!found) throw new SetupError(`No skill ${name}`);
        return readFileSync(found.path, "utf8");
      }
      case "create": {
        const name = need(args.name, "the skill name");
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
          throw new SetupError("A skill name is lowercase letters, digits and dashes");
        const description = need(args.description, "a one-line description");
        const body = need(args.content, "the skill's instructions as content");
        const scope = args.scope ?? "project";
        const file = join(skillDir(scope, name), "SKILL.md");
        if (existsSync(file)) throw new SetupError(`${file} already exists`);
        const text = `---\nname: ${name}\ndescription: ${description.replace(/\s+/g, " ").trim()}\n---\n\n${body.trimEnd()}\n`;
        await confirm(`Create the ${scope} skill ${name} (${file})\n\n${clip(text)}`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
        return `Created skill ${name} at ${file}. Load it with the skills tool to use it now.`;
      }
      case "remove": {
        const name = need(args.name, "the skill name");
        const found = installed().find(
          (s) => s.name === name && (!args.scope || s.scope === args.scope),
        );
        if (!found) throw new SetupError(`No skill ${name}`);
        await confirm(`Delete the ${found.scope} skill ${name} (${dirname(found.path)})`);
        if (!removeInstalledSkill(found)) throw new SetupError(`Could not remove ${found.path}`);
        return `Removed skill ${name}.`;
      }
    }
    throw new SetupError("unreachable");
  };

  // ── Packages ──────────────────────────────────────────────────────────────

  const pkg = async (args: SetupArgs): Promise<string> => {
    switch (args.action) {
      case "list": {
        const list = listPackages(workspace);
        return list.length ? list.map(describeInstalled).join("\n") : "No packages installed.";
      }
      case "inspect":
        return describePlan(
          inspectPackage(need(args.path, "the package folder as path"), workspace, {
            policy: policy(),
          }),
        ).join("\n");
      case "install": {
        const plan = inspectPackage(need(args.path, "the package folder as path"), workspace, {
          policy: policy(),
        });
        if (plan.problems.length)
          throw new SetupError(`The package cannot be installed: ${plan.problems.join("; ")}`);
        if (plan.overwrites && !args.overwrite)
          throw new SetupError(
            `${plan.overwrites} file(s) would replace different project files; ask the person, then pass overwrite: true`,
          );
        await confirm(
          `Install package ${plan.name}@${plan.version}\n\n${describePlan(plan).join("\n")}`,
        );
        const result = installPackage(plan, {
          approved: true,
          policy: policy(),
          ...(args.overwrite ? { overwrite: true } : {}),
        });
        return describeInstall(result).join("\n");
      }
      case "remove": {
        const name = need(args.name, "the package name");
        const entry = listPackages(workspace).find((p) => p.name === name);
        if (!entry) throw new SetupError(`No installed package ${name}`);
        await confirm(
          `Remove package ${name}@${entry.version} and its ${entry.files.length} file(s)`,
        );
        return describeRemoval(removePackage(workspace, name)).join("\n");
      }
      case "create": {
        const folder = resolve(workspace, need(args.path, "the package folder as path"));
        const packOptions = {
          ...(args.name ? { name: args.name } : {}),
          ...(args.version ? { version: args.version } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          policy: policy(),
        };
        const check = packPackage(folder, { ...packOptions, check: true });
        if (check.problems.length)
          throw new SetupError(`The package has problems: ${check.problems.join("; ")}`);
        await confirm(
          `Write the package manifest ${check.manifestPath} for ${check.name}@${check.version} (${check.files.length} file(s))`,
        );
        const result = packPackage(folder, packOptions);
        if (!result.written) throw new SetupError(result.problems.join("; ") || "Nothing written");
        return `Wrote ${result.manifestPath}. Install it in a project with package install.`;
      }
    }
    throw new SetupError("unreachable");
  };

  // ── Hooks ─────────────────────────────────────────────────────────────────

  const hook = async (args: SetupArgs): Promise<string> => {
    switch (args.action) {
      case "list": {
        const view = hooksOverview(workspace);
        const lines = view.events.flatMap((e) =>
          e.hooks.map(
            (h) =>
              `- ${h.id ?? "(imported, read only)"} ${e.event}${h.matcher ? ` [${h.matcher}]` : ""}: ${h.command}${h.async ? " (async)" : ""}`,
          ),
        );
        return [
          view.disabledBy ? `All hooks are off: ${view.disabledBy} sets disableAllHooks.` : "",
          lines.length ? lines.join("\n") : "No hooks.",
        ]
          .filter(Boolean)
          .join("\n");
      }
      case "add": {
        const event = need(args.event, "the event");
        const command = need(args.command, "the command");
        const scope = args.scope === "global" ? "user" : "project";
        await confirm(
          [
            `Add a ${args.scope ?? "project"} hook on ${event}${args.matcher ? ` for ${args.matcher}` : ""}; it runs this command${args.async ? " in the background" : ""}:`,
            command,
          ].join("\n\n"),
        );
        addHook(workspace, scope, {
          event,
          matcher: args.matcher ?? null,
          command,
          timeout: args.timeout ?? null,
          async: args.async === true,
        });
        return `Added the hook on ${event}.`;
      }
      case "remove": {
        const id = need(args.name, "the hook ID as name");
        const found = hooksOverview(workspace)
          .events.flatMap((e) => e.hooks)
          .find((h) => h.id === id);
        if (!found?.rev) throw new SetupError(`No BAKED hook ${id}; list the hooks again`);
        await confirm(`Remove the hook ${id}: ${found.command}`);
        removeHook(workspace, id, found.rev);
        return `Removed hook ${id}.`;
      }
    }
    throw new SetupError("unreachable");
  };

  // ── MCP servers ───────────────────────────────────────────────────────────

  const mcp = async (args: SetupArgs): Promise<string> => {
    const files: MCPConfigFiles = {
      global: join(globalDir, "config.json"),
      project: join(workspace, ".baked", "config.json"),
    };
    const layers = readMCPLayers(files);
    if (args.action === "list") {
      const views = mcpServerViews(layers, {});
      return views.length
        ? views
            .map(
              (s) =>
                `- ${s.name} (${s.scope}, ${s.transport}${s.config.disabled ? ", disabled" : ""}) ${s.transport === "stdio" ? [s.config.command, ...(s.config.args ?? [])].join(" ") : (s.config.url ?? "")}`,
            )
            .join("\n")
        : "No MCP servers.";
    }
    const name = need(args.name, "the server name");
    const defined = (scope: MCPScope) => layers[scope].some((s) => s.name === name);
    const scope: MCPScope =
      args.scope === "global"
        ? "global"
        : args.scope === "project" || args.action === "add" || defined("project")
          ? "project"
          : "global";
    let change: MCPChange;
    let card: string;
    switch (args.action) {
      case "add":
      case "edit": {
        const server = { ...need(args.server, "the server"), name };
        change =
          args.action === "add"
            ? { action: "add", scope, server }
            : { action: "edit", scope, name, server };
        const target =
          (server.transport ?? "stdio") === "stdio"
            ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
            : (server.url ?? "");
        card = `${args.action === "add" ? "Add" : "Change"} the ${scope} MCP server ${name}; BAKED connects to it and gives its tools to agents:\n\n${target}${server.env ? `\n\nEnvironment: ${Object.keys(server.env).join(", ")}` : ""}`;
        break;
      }
      case "enable":
      case "disable":
        change = { action: "set-disabled", scope, name, disabled: args.action === "disable" };
        card = `${args.action === "enable" ? "Turn on" : "Turn off"} the ${scope} MCP server ${name}`;
        break;
      case "remove":
        change = { action: "remove", scope, name };
        card = `Remove the ${scope} MCP server ${name} from ${files[scope]}`;
        break;
      default:
        throw new SetupError("unreachable");
    }
    // Validates before asking, so the person never approves a change that cannot be saved.
    applyMCPChange(layers, change);
    await confirm(card);
    const fresh = readMCPLayers(files);
    const lists = applyMCPChange(fresh, change);
    if (lists.project) ensurebakedDir(workspace);
    writeMCPLayers(files, lists);
    const next = { ...fresh, ...lists };
    const servers = mergeMCPServers(next.global, next.project) ?? [];
    if (options.onMcpChange) options.onMcpChange(servers);
    else {
      const { getMCPManager } = await import("../mcp/index.js");
      const manager = getMCPManager();
      if (manager.started) void manager.connectAll(servers).catch(() => {});
    }
    return `Saved: ${args.action} ${scope} MCP server ${name} (${files[scope]}).`;
  };

  // ── Language servers ──────────────────────────────────────────────────────

  const lsp = async (args: SetupArgs): Promise<string> => {
    const lspOptions: LspServiceOptions = {
      workspace,
      files: { global: join(globalDir, "config.json") },
      ...(options.lsp?.deps ? { deps: options.lsp.deps } : {}),
    };
    if (args.action === "list") {
      const status = await lspStatus(lspOptions);
      const shown = status.servers.filter((s) => s.detected || s.installed);
      return [
        `Languages here: ${status.languages.join(", ") || "none detected"}${status.uncovered.length ? `; without a server: ${status.uncovered.join(", ")}` : ""}.`,
        ...shown.map(
          (s) =>
            `- ${s.id} (${s.languages.join(", ")}): ${s.installed ? "installed" : s.installable ? "installable" : "not installed"}${s.disabled ? ", disabled" : ""}${s.running ? ", running" : ""}`,
        ),
      ].join("\n");
    }
    const id = need(args.name, "the server, Mason package or language as name");
    if (args.action === "install") {
      await confirm(`Install the language server ${id} into BAKED's own folder`);
      const result = await installLspServer(lspOptions, id);
      return `Installed ${result.server} (${result.package}).${result.warning ? ` ${result.warning}` : ""}`;
    }
    const disabled = args.action === "disable";
    const lspScope = args.scope === "global" ? "global" : args.scope ? "project" : undefined;
    await confirm(`${disabled ? "Turn off" : "Turn on"} the language server ${id}`);
    const result = await setLspServerDisabled(lspOptions, id, disabled, lspScope);
    return `${disabled ? "Disabled" : "Enabled"} ${id}.${result.restarted.length ? ` Restarted ${result.restarted.join(", ")}.` : ""}`;
  };

  const handlers: Record<SetupArea, (args: SetupArgs) => Promise<string>> = {
    workflow,
    agent_context: agentContext,
    memory,
    skill,
    package: pkg,
    hook,
    mcp,
    lsp,
  };

  return tool({
    description: [
      "Read and change how BAKED is set up for this project, the same settings as the Setup screens: workflows, agent_context (AGENTS.md and other instruction files every agent reads), memory (chat memory: pin, hide, edit, share with runs; write new memories with the memory tool), skill (create your own SKILL.md; install from skills.sh with the skills tool), package, hook, mcp (MCP servers) and lsp (language servers).",
      "Use it when the user asks you to set something up, and set up what a request needs before starting it. Look first (list/show), then fill in every value yourself from the project and the conversation and make the change; do not ask the user for the values first. The change is shown to the user on one approval card with everything filled in, and nothing is written until they approve it.",
      "Workflows are how this project customizes work: create one from an existing workflow (from) and adjust it with editor ops; never suggest a custom agent instead. Gate bindings are not edited here.",
    ].join(" "),
    inputSchema: SetupInput,
    execute: async (args: SetupArgs): Promise<Result> => {
      const allowed = AREA_ACTIONS[args.area];
      if (!allowed.includes(args.action))
        return fail(`${args.area} takes the actions ${allowed.join(", ")}`);
      try {
        return ok(await handlers[args.area](args));
      } catch (err) {
        if (err instanceof SetupError || err instanceof HookEditError) return fail(err.message);
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });
}
