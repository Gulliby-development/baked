import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AGENT_STAGES,
  type AgentStage,
  convertAgents,
  listAgents,
  removeAgentFile,
} from "../core/workflows/agent-import.js";
import { WorkflowFault } from "../core/workflows/errors.js";
import {
  type RunPolicy,
  SafeId,
  validateWorkflow,
  WorkflowSchema,
} from "../core/workflows/schemas.js";
import { WorkflowV2Schema } from "../core/workflows/v2/definition.js";
import {
  asV2,
  listDefinitions,
  loadDefinition,
  validateDefinition,
} from "../core/workflows/v2/definitions.js";
import {
  copyAsCustom,
  removeDefinitionFile,
  writeDefinitionFile,
} from "../core/workflows/v2/editor.js";
import { confirmGates, loadGateLibrary, readConfirmations } from "../core/workflows/v2/library.js";
import type { WorkflowArgs } from "./workflow-parse.js";

export const DEFINITION_COMMANDS = [
  "definitions",
  "validate",
  "define",
  "remove",
  "gates",
  "agents",
] as const;

/** Problems of a v1 or v2 definition file, read without running anything. */
function validateFile(workspace: string, path: string, policy: RunPolicy) {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown; id?: unknown };
  const library = loadGateLibrary(workspace, policy);
  if (raw.schemaVersion === 2) {
    const parsed = WorkflowV2Schema.safeParse(raw);
    if (!parsed.success)
      return { id: raw.id ?? null, schemaVersion: 2, problems: [parsed.error.message] };
    return {
      id: parsed.data.id,
      schemaVersion: 2,
      problems: validateDefinition(parsed.data, library),
    };
  }
  const parsed = WorkflowSchema.safeParse(raw);
  if (!parsed.success)
    return { id: raw.id ?? null, schemaVersion: 1, problems: [parsed.error.message] };
  return {
    id: parsed.data.id,
    schemaVersion: 1,
    problems: [
      ...validateWorkflow(parsed.data),
      ...validateDefinition(
        asV2({ schemaVersion: 1, id: parsed.data.id, definition: parsed.data, path }, policy),
        library,
      ),
    ],
  };
}

/**
 * Commands on workflow definitions and the gate library. They read and write files under
 * `baked/` only; none of them starts a run, a command or a model.
 */
export function executeDefinitionCommand(
  args: WorkflowArgs,
  workspace: string,
  policy: RunPolicy,
): { result: unknown; exitCode: number } {
  switch (args.command) {
    case "definitions":
      return { result: listDefinitions(workspace, policy), exitCode: 0 };
    case "gates": {
      const library = loadGateLibrary(workspace, policy);
      if (args.positional[0] === "confirm") {
        const ids = args.flags.all
          ? [...library.entries.values()]
              .filter((e) => e.source === "project")
              .map((e) => e.gate.id)
          : args.positional.slice(1);
        if (!ids.length)
          throw new WorkflowFault("INVALID_DEFINITION", "Name the gates to confirm, or --all");
        return { result: { confirmed: confirmGates(workspace, library, ids) }, exitCode: 0 };
      }
      if (args.positional.length)
        throw new WorkflowFault("INVALID_DEFINITION", "gates takes no argument except confirm");
      const confirmed = readConfirmations(workspace);
      return {
        result: {
          gates: [...library.entries.values()].map((entry) => ({
            id: entry.gate.id,
            type: entry.gate.type,
            required: entry.gate.required,
            scope: entry.gate.scope,
            source: entry.source,
            path: entry.path,
            hash: entry.hash,
            shadows: entry.shadows,
            ...(entry.source === "project"
              ? { confirmed: confirmed[entry.gate.id] === entry.hash }
              : {}),
          })),
          problems: library.problems,
        },
        exitCode: 0,
      };
    }
    case "validate": {
      const report =
        typeof args.flags.file === "string"
          ? validateFile(workspace, resolve(workspace, args.flags.file), policy)
          : (() => {
              const loaded = loadDefinition(workspace, args.positional[0] ?? "", policy);
              const library = loadGateLibrary(workspace, policy);
              return {
                id: loaded.id,
                schemaVersion: loaded.schemaVersion,
                problems: [
                  ...(loaded.schemaVersion === 1 ? validateWorkflow(loaded.definition) : []),
                  ...validateDefinition(asV2(loaded, policy), library),
                ],
              };
            })();
      return {
        result: { ...report, valid: report.problems.length === 0 },
        exitCode: report.problems.length ? 1 : 0,
      };
    }
    case "define": {
      const id = SafeId.parse(args.positional[0]);
      const from = typeof args.flags.from === "string" ? args.flags.from : undefined;
      if (!from) throw new WorkflowFault("INVALID_DEFINITION", "--from is required");
      const target = join(workspace, "baked", "workflows", `${id}.json`);
      if (existsSync(target))
        throw new WorkflowFault("INVALID_DEFINITION", `${target} already exists`);
      const source = asV2(loadDefinition(workspace, from, policy), policy);
      // A copy never carries auto approval: turning it on is a separate, confirmed human act.
      const copy = WorkflowV2Schema.parse(copyAsCustom(source, id));
      const problems = validateDefinition(copy, loadGateLibrary(workspace, policy));
      if (problems.length)
        throw new WorkflowFault("INVALID_DEFINITION", problems.join("\n"), { problems });
      writeDefinitionFile(workspace, copy);
      return { result: { id, path: target, from }, exitCode: 0 };
    }
    case "remove":
      return { result: removeDefinitionFile(workspace, args.positional[0] ?? ""), exitCode: 0 };
    case "agents":
      return agentsCommand(args, workspace, policy);
    default:
      throw new WorkflowFault("INVALID_DEFINITION", `${args.command} is not a definition command`);
  }
}

/** `--stages NAME=STAGE,...`: the stage each named agent fills; the others keep their suggestion. */
function parseStages(value: string | true | undefined): Map<string, AgentStage> {
  const stages = new Map<string, AgentStage>();
  if (typeof value !== "string") return stages;
  for (const pair of value.split(",").filter(Boolean)) {
    const [name = "", stage = ""] = pair.split("=").map((s) => s.trim());
    if (!(AGENT_STAGES as readonly string[]).includes(stage))
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `${pair}: the stage is one of ${AGENT_STAGES.join(", ")}`,
      );
    stages.set(name, stage as AgentStage);
  }
  return stages;
}

/** `agents`, `agents convert ID` and `agents remove NAME` (#832). */
function agentsCommand(
  args: WorkflowArgs,
  workspace: string,
  policy: RunPolicy,
): { result: unknown; exitCode: number } {
  const [action = "list", target] = args.positional;
  const found = listAgents(workspace);
  const named = (name: string) =>
    found.agents.find((a) => a.name === name || a.key === name || a.path === name);
  if (action === "list")
    return {
      result: {
        agents: found.agents.map(({ content: _content, instructions: _text, ...agent }) => agent),
        problems: found.problems,
      },
      exitCode: 0,
    };
  if (action === "convert") {
    const stages = parseStages(args.flags.stages);
    for (const name of stages.keys())
      if (!named(name)) throw new WorkflowFault("NOT_FOUND", `No agent ${name} in this project`);
    const result = convertAgents(workspace, policy, {
      workflowId: SafeId.parse(target),
      ...(typeof args.flags.from === "string" ? { from: args.flags.from } : {}),
      agents: found.agents.map((a) => ({
        key: a.key,
        stage: stages.get(a.name) ?? stages.get(a.key) ?? stages.get(a.path) ?? a.stage,
      })),
      removeOriginals: args.flags.remove === true,
    });
    return { result, exitCode: 0 };
  }
  if (action === "remove" && target) {
    const agent = named(target);
    if (!agent) throw new WorkflowFault("NOT_FOUND", `No agent ${target} in this project`);
    const removed = removeAgentFile(workspace, agent.key, agent.hash);
    if (removed.status !== "written") throw new WorkflowFault("INPUT_CHANGED", removed.message);
    return { result: { removed: agent.key }, exitCode: 0 };
  }
  throw new WorkflowFault(
    "INVALID_DEFINITION",
    "Usage: agents | agents convert ID [--from PRESET] [--stages NAME=STAGE,...] [--remove] | agents remove NAME",
  );
}
