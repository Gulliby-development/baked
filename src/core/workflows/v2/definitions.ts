import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sddWorkflow } from "../builtin/sdd.js";
import { DECOMPOSE_WORKFLOW_ID, decomposeWorkflow } from "../initiatives/decompose.js";
import { type RunPolicy, SafeId, type WorkflowDefinition, WorkflowSchema } from "../schemas.js";
import {
  type GateBinding,
  PRESETS,
  validateWorkflowV2,
  type WorkflowV2,
  WorkflowV2Schema,
  worktreeRefusal,
} from "./definition.js";
import { type GateLibrary, loadGateLibrary } from "./library.js";
import fixCi from "./presets/fix-ci.json" with { type: "json" };
import full from "./presets/full.json" with { type: "json" };
import quick from "./presets/quick.json" with { type: "json" };
import quickFix from "./presets/quick-fix.json" with { type: "json" };
import reviewOnly from "./presets/review-only.json" with { type: "json" };
import spike from "./presets/spike.json" with { type: "json" };
import standard from "./presets/standard.json" with { type: "json" };
import { upgradeWorkflowV1 } from "./upgrade.js";

/** The presets shipped with BAKED, read only. "Duplicate as custom" copies one into baked/workflows. */
export const builtinPresets: ReadonlyMap<string, WorkflowV2> = new Map(
  [quick, quickFix, standard, full, spike, reviewOnly, fixCi].map((raw) => {
    const preset = WorkflowV2Schema.parse(raw);
    return [preset.id, preset] as const;
  }),
);

/** The preset `baked quick` runs unless `workflows.quickWorkflow` names another definition. */
export const QUICK_WORKFLOW_ID = "quick";

/**
 * A shipped preset bound to a project's checks. The presets name example command gates; the
 * project's own checks replace them: every check stage runs the policy's feature checks, and the
 * transition leaving a tasks stage runs its task checks. A project without feature checks gets a
 * check stage with no gates, which validation reports.
 */
export function instantiatePreset(preset: WorkflowV2, policy: RunPolicy): WorkflowV2 {
  const feature: GateBinding[] = policy.checks
    .filter((c) => c.scope === "feature")
    .map((c) => ({ gateId: c.id }));
  const task: GateBinding[] = policy.checks
    .filter((c) => c.scope === "task")
    .map((c) => ({ gateId: c.id }));
  const writers = new Set(preset.stages.filter((s) => s.type === "tasks").map((s) => s.id));
  return {
    ...preset,
    stages: preset.stages.map((s) => (s.type === "check" ? { ...s, gates: feature } : s)),
    transitions: preset.transitions.map((t) => (writers.has(t.from) ? { ...t, gates: task } : t)),
  };
}

export type LoadedDefinition =
  | { schemaVersion: 1; id: string; definition: WorkflowDefinition; path: string | null }
  | { schemaVersion: 2; id: string; definition: WorkflowV2; path: string | null };

export interface DefinitionSummary {
  id: string;
  schemaVersion: 1 | 2;
  source: "builtin" | "project";
  preset: string | null;
  description: string;
  stages: string[];
  writes: boolean;
  problems: string[];
  /** The execution mode the definition asks for; null leaves it to the policy. */
  execution: "inline" | "worktree" | null;
  /** Why a run of this definition refuses worktree execution, or null. */
  worktreeRefusal: string | null;
}

const definitionPath = (workspace: string, id: string): string =>
  join(workspace, "baked", "workflows", `${id}.json`);

/**
 * Reads a workflow definition by ID: a project file in `baked/workflows/ID.json` (schema 1 or 2)
 * first, then the built-in `sdd` and the shipped presets. Presets come back instantiated with the
 * policy's checks. Throws when the ID is unknown or the file does not parse.
 */
export function loadDefinition(workspace: string, id: string, policy: RunPolicy): LoadedDefinition {
  SafeId.parse(id);
  // The initiative's decompose step is part of the runtime contract; a project file cannot replace it.
  if (id === DECOMPOSE_WORKFLOW_ID)
    return { schemaVersion: 2, id, definition: decomposeWorkflow, path: null };
  const path = definitionPath(workspace, id);
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown };
    if (raw.schemaVersion === 2)
      return { schemaVersion: 2, id, definition: WorkflowV2Schema.parse(raw), path };
    return { schemaVersion: 1, id, definition: WorkflowSchema.parse(raw), path };
  }
  if (id === "sdd") return { schemaVersion: 1, id, definition: sddWorkflow, path: null };
  const preset = builtinPresets.get(id);
  if (preset)
    return { schemaVersion: 2, id, definition: instantiatePreset(preset, policy), path: null };
  throw new Error(`Unknown workflow ${id}`);
}

/** The v2 form of any loaded definition: v1 definitions are read through the migration. */
export function asV2(loaded: LoadedDefinition, policy: RunPolicy): WorkflowV2 {
  return loaded.schemaVersion === 2
    ? loaded.definition
    : upgradeWorkflowV1(loaded.definition, policy);
}

/** Validation of a v2 definition against the workspace's gate library. */
export function validateDefinition(definition: WorkflowV2, library: GateLibrary): string[] {
  return validateWorkflowV2(definition, library.gates);
}

/** Every definition a run can start from, with its validation problems. Reading runs nothing. */
export function listDefinitions(workspace: string, policy: RunPolicy): DefinitionSummary[] {
  const library = loadGateLibrary(workspace, policy);
  const summaries = new Map<string, DefinitionSummary>();
  const summarize = (
    loaded: LoadedDefinition,
    source: DefinitionSummary["source"],
  ): DefinitionSummary => {
    const v2 = asV2(loaded, policy);
    return {
      id: loaded.id,
      schemaVersion: loaded.schemaVersion,
      source,
      preset: loaded.schemaVersion === 2 ? loaded.definition.preset : null,
      description: v2.description,
      stages: v2.stages.map((s) => s.id),
      writes: v2.stages.some((s) => s.effects === "workspace-write"),
      problems: validateDefinition(v2, library),
      execution: v2.execution ?? null,
      worktreeRefusal: loaded.schemaVersion === 2 ? worktreeRefusal(loaded.definition) : null,
    };
  };
  summaries.set("sdd", summarize(loadDefinition(workspace, "sdd", policy), "builtin"));
  for (const id of PRESETS)
    summaries.set(id, summarize(loadDefinition(workspace, id, policy), "builtin"));
  const directory = join(workspace, "baked", "workflows");
  if (existsSync(directory))
    for (const name of readdirSync(directory).sort()) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      try {
        summaries.set(id, summarize(loadDefinition(workspace, id, policy), "project"));
      } catch (error) {
        summaries.set(id, {
          id,
          schemaVersion: 2,
          source: "project",
          preset: null,
          description: "",
          stages: [],
          writes: false,
          problems: [error instanceof Error ? error.message : String(error)],
          execution: null,
          worktreeRefusal: null,
        });
      }
    }
  return [...summaries.values()];
}
