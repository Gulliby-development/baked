import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { hashBytes } from "../../specs/hash.js";
import { WorkflowFault } from "../errors.js";
import { InitiativePlanSchema } from "../initiatives/plan.js";
import type { InitiativeService, InitiativeView } from "../initiatives/service.js";
import { BudgetLimitsSchema } from "../initiatives/store.js";
import {
  type RunPolicy,
  type RunSnapshot,
  SafeId,
  SpecSchema,
  TaskGraphSchema,
} from "../schemas.js";
import { SDD_EXPORT_FORMAT_VERSION, type SddExportManifest, type SddPackage } from "./package.js";
import type { StartSeed } from "./seed.js";
import { unzipFiles } from "./zip.js";

/** Limits of a package read back: far above any export, low enough to refuse a zip bomb. */
const LIMITS = { maxFiles: 5000, maxBytes: 64 * 1024 * 1024 };

/** `details.reason` of a package that is not a BAKED export or was changed after it was written. */
export const BAD_PACKAGE = "bad_package";

const refuse = (message: string): WorkflowFault =>
  new WorkflowFault("INVALID_DEFINITION", message, { reason: BAD_PACKAGE });

function readFolder(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  let total = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw refuse(`The package holds a link: ${relative(root, path)}`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const name = relative(root, path).split(/[\\/]/).join("/");
        total += statSync(path).size;
        if (Object.keys(files).length >= LIMITS.maxFiles || total > LIMITS.maxBytes)
          throw refuse("The package is larger than an export can be");
        files[name] = readFileSync(path, "utf8");
      }
    }
  };
  walk(root);
  return files;
}

/**
 * Reads an exported package back from its folder or zip archive (#2208) and checks it is what the
 * exporter wrote: a known `formatVersion`, every file listed in `manifest.json` with its sha256,
 * and no file the manifest does not list.
 */
export function readSddPackage(path: string): SddPackage {
  if (!existsSync(path)) throw new WorkflowFault("NOT_FOUND", `No package at ${path}`);
  let files: Record<string, string>;
  try {
    files = statSync(path).isDirectory()
      ? readFolder(path)
      : unzipFiles(new Uint8Array(readFileSync(path)), LIMITS);
  } catch (error) {
    if (error instanceof WorkflowFault) throw error;
    throw refuse(
      `${path} is not a readable package: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const name of Object.keys(files))
    if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes(".."))
      throw refuse(`The package names a file outside itself: ${name}`);
  const raw = files["manifest.json"];
  if (raw === undefined) throw refuse(`${path} has no manifest.json; it is not a BAKED export`);
  let manifest: SddExportManifest;
  try {
    manifest = JSON.parse(raw) as SddExportManifest;
  } catch {
    throw refuse("manifest.json is not JSON");
  }
  if (manifest.formatVersion !== SDD_EXPORT_FORMAT_VERSION)
    throw refuse(
      `The package has format version ${String(manifest.formatVersion)}; this BAKED reads version ${SDD_EXPORT_FORMAT_VERSION}`,
    );
  if (manifest.kind !== "run" && manifest.kind !== "initiative")
    throw refuse("manifest.json names no kind (run or initiative)");
  const listed = manifest.files ?? {};
  const changed = Object.entries(listed)
    .filter(([name, hash]) => files[name] === undefined || hashBytes(files[name]) !== hash)
    .map(([name]) => name);
  const extra = Object.keys(files).filter((name) => name !== "manifest.json" && !(name in listed));
  if (changed.length || extra.length)
    throw refuse(
      `The package changed after it was exported: ${[
        ...changed.map((n) => `${n} (missing or edited)`),
        ...extra.map((n) => `${n} (not in the manifest)`),
      ].join(", ")}`,
    );
  return { manifest, files };
}

/** The accepted documents of each feature of a package that has a folder, by feature ID. */
export function packageSeeds(pkg: SddPackage, manifestHash: string): Record<string, StartSeed> {
  const seeds: Record<string, StartSeed> = {};
  for (const feature of pkg.manifest.features) {
    if (!feature.dir) continue;
    const read = (name: string): string => {
      const content = pkg.files[`${feature.dir}/${name}`];
      if (content === undefined) throw refuse(`${feature.dir}/${name} is missing`);
      return content;
    };
    const spec = SpecSchema.safeParse(JSON.parse(read("spec.json")));
    const graph = TaskGraphSchema.safeParse(JSON.parse(read("tasks.json")));
    if (!spec.success || !graph.success)
      throw refuse(`${feature.dir} does not hold a spec and tasks this BAKED reads`);
    seeds[feature.id] = {
      spec: spec.data,
      plan: read("plan.md"),
      graph: graph.data,
      source: {
        kind: pkg.manifest.kind,
        id: pkg.manifest.id,
        manifestHash,
        gitHead: pkg.manifest.gitHead,
      },
    };
  }
  return seeds;
}

export interface ImportedPackage {
  kind: "run" | "initiative";
  /** The new initiative's ID, or the run's feature ID. */
  id: string;
  /** The features whose first run starts at analysis with the imported spec, plan and tasks. */
  seeded: string[];
  /** Features without accepted documents in the package; they specify and plan as usual. */
  unseeded: string[];
  initiative?: InitiativeView;
  run?: RunSnapshot;
}

/**
 * Recreates the work of a package in this checkout (#2208). An initiative starts awaiting the
 * approval of its split, a `user` revision of the exported plan; once approved, each feature with
 * accepted documents starts at analysis with them. A run is created at its analysis stage and is
 * not driven. Nothing calls a model before a person decides.
 */
export async function importSddPackage(
  initiatives: InitiativeService,
  pkg: SddPackage,
  options: {
    commandId: string;
    policy: RunPolicy;
    workflowId: string;
    ownerLabel: string;
    /** The new initiative's ID or the run's feature ID; the package's by default. */
    id?: string;
    model?: string;
  },
): Promise<ImportedPackage> {
  const manifestHash = hashBytes(pkg.files["manifest.json"] ?? "");
  const seeds = packageSeeds(pkg, manifestHash);
  const seeded = Object.keys(seeds);
  const unseeded = pkg.manifest.features.filter((f) => !f.dir).map((f) => f.id);
  if (pkg.manifest.kind === "initiative") {
    const raw = pkg.files["initiative.json"];
    if (raw === undefined) throw refuse("The initiative package has no initiative.json");
    const data = JSON.parse(raw) as {
      prompt?: unknown;
      plan?: unknown;
      budget?: unknown;
      costBudget?: unknown;
    };
    const plan = InitiativePlanSchema.safeParse(data.plan);
    if (!plan.success || typeof data.prompt !== "string")
      throw refuse("initiative.json does not hold a request and a plan this BAKED reads");
    const budget = BudgetLimitsSchema.safeParse(data.budget);
    const cost = data.costBudget as { maxCostUsd?: unknown } | null | undefined;
    const id = options.id ?? pkg.manifest.id;
    const view = await initiatives.start({
      commandId: options.commandId,
      initiativeId: id,
      prompt: data.prompt,
      plan: plan.data,
      policy: options.policy,
      workflowId: options.workflowId,
      budget: budget.success ? budget.data : null,
      costBudget:
        cost && typeof cost.maxCostUsd === "number"
          ? (cost as { maxCostUsd: number; costTolerance?: number | "auto" | "off" })
          : null,
      ownerLabel: options.ownerLabel,
      ...(options.model ? { model: options.model } : {}),
      ...(seeded.length ? { seeds } : {}),
    });
    return { kind: "initiative", id, seeded, unseeded, initiative: view };
  }
  const [feature] = pkg.manifest.features;
  const seed = feature ? seeds[feature.id] : undefined;
  if (!seed) throw refuse("The run package has no accepted spec, plan and tasks");
  const featureId = SafeId.parse(options.id ?? seed.spec.featureId);
  const run = await initiatives.workflows.start({
    commandId: options.commandId,
    workflowId: options.workflowId,
    featureId,
    prompt: [seed.spec.title, "", seed.spec.problem, "", seed.spec.outcome].join("\n"),
    policy: options.policy,
    ownerLabel: options.ownerLabel,
    ...(options.model ? { model: options.model } : {}),
    seed,
  });
  return { kind: "run", id: featureId, seeded: [featureId], unseeded: [], run };
}
