import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import { confirmGates, loadGateLibrary, readConfirmations } from "../core/workflows/v2/library.js";
import type { WorkflowArgs } from "./workflow-parse.js";

export const DEFINITION_COMMANDS = ["definitions", "validate", "define", "gates"] as const;

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
      const copy = WorkflowV2Schema.parse({
        ...source,
        id,
        version: "1.0.0",
        preset: "custom",
        autoApproval: null,
        stages: source.stages.map((s) => (s.type === "approval" ? { ...s, decision: "human" } : s)),
      });
      const problems = validateDefinition(copy, loadGateLibrary(workspace, policy));
      if (problems.length)
        throw new WorkflowFault("INVALID_DEFINITION", problems.join("\n"), { problems });
      mkdirSync(dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(copy, null, 2)}\n`);
      renameSync(temp, target);
      return { result: { id, path: target, from }, exitCode: 0 };
    }
    default:
      throw new WorkflowFault("INVALID_DEFINITION", `${args.command} is not a definition command`);
  }
}
